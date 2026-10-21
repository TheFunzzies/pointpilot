import { parseFiniteNumber, isCalendarDate } from './validate.mjs';
import { readFileSync } from 'node:fs';
import { dataFile, referenceFile } from './paths.mjs';
import { readJson, updateJson, writeJson } from './store.mjs';
import { programId, programName, programKind } from './programs.mjs';

const SECRET_KEYS = ['seatsAeroApiKey', 'travelpayoutsToken', 'serpApiKey'];

export const DEFAULT_SETTINGS = {
  seatsAeroApiKey: '',
  travelpayoutsToken: '',     // free Travelpayouts partner token (cash fares + deals)
  serpApiKey: '',             // optional SerpApi key (live Google Flights checks)
  homeAirports: '',           // used by the cash deals feed
  webhookUrl: '',
  monitorIntervalMinutes: 60,
  apiRefreshMinutes: 60,      // re-use a seats.aero result for the same query for this long
  desktopNotifications: true,
  closeToTray: true,
  launchAtLogin: false
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson(dataFile('settings.json'), {})) };
}

/** Settings safe to send to the UI (secrets masked to their last 4 characters). */
export async function publicSettings() {
  const s = await getSettings();
  const out = { ...s };
  for (const k of SECRET_KEYS) {
    delete out[k];
    out[`${k}Set`] = Boolean(s[k]);
    out[`${k}Hint`] = s[k] ? `…${s[k].slice(-4)}` : '';
  }
  // Back-compat names used by older UI code.
  out.hasSeatsAeroKey = out.seatsAeroApiKeySet;
  out.seatsAeroKeyHint = out.seatsAeroApiKeyHint;
  return out;
}

export async function updateSettings(patch = {}) {
  const clean = {};
  for (const k of SECRET_KEYS) if (typeof patch[k] === 'string') clean[k] = patch[k].trim();
  if (typeof patch.homeAirports === 'string') clean.homeAirports = patch.homeAirports.toUpperCase().replace(/[^A-Z,\s]/g, '').trim();
  if (typeof patch.webhookUrl === 'string') {
    const url = patch.webhookUrl.trim();
    if (url && !/^https:\/\//i.test(url)) throw Object.assign(new Error('Webhook URL must start with https://'), { status: 400 });
    clean.webhookUrl = url;
  }
  for (const k of ['monitorIntervalMinutes', 'apiRefreshMinutes']) {
    if (patch[k] != null) clean[k] = Math.min(24 * 60, Math.max(k === 'monitorIntervalMinutes' ? 15 : 5, Math.round(Number(patch[k]) || DEFAULT_SETTINGS[k])));
  }
  for (const k of ['desktopNotifications', 'closeToTray', 'launchAtLogin']) if (typeof patch[k] === 'boolean') clean[k] = patch[k];
  await updateJson(dataFile('settings.json'), {}, s => ({ ...s, ...clean }));
  return publicSettings();
}

// --- API usage ---
// seats.aero (flights) and rooms.aero (hotels): ~1,000 calls per UTC day each.
// Travelpayouts: counted per day. SerpApi: the free plan is 250 searches per calendar month.
const DAILY_KEYS = { seats: 'calls', rooms: 'roomsCalls', travelpayouts: 'tpCalls' };
export async function recordApiCalls(n, service = 'seats') {
  if (!n) return;
  n = parseFiniteNumber(n, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, name: 'API call count' });
  const now = new Date().toISOString();
  const day = now.slice(0, 10), month = now.slice(0, 7);
  return updateJson(dataFile('api-usage.json'), {}, u => {
    const next = u.day === day ? { ...u } : { day, calls: 0, roomsCalls: 0, tpCalls: 0, serpMonth: u.serpMonth, serpCalls: u.serpCalls };
    if (service === 'serp') {
      if (next.serpMonth !== month) { next.serpMonth = month; next.serpCalls = 0; }
      next.serpCalls = (next.serpCalls || 0) + n;
    } else {
      const key = DAILY_KEYS[service] || 'calls';
      next[key] = (next[key] || 0) + n;
    }
    return next;
  });
}
export async function apiUsage() {
  const now = new Date().toISOString();
  const day = now.slice(0, 10), month = now.slice(0, 7);
  const u = await readJson(dataFile('api-usage.json'), {});
  const today = u.day === day;
  return {
    day,
    calls: today ? u.calls || 0 : 0,
    roomsCalls: today ? u.roomsCalls || 0 : 0,
    tpCalls: today ? u.tpCalls || 0 : 0,
    serpCalls: u.serpMonth === month ? u.serpCalls || 0 : 0
  };
}

// --- Wallet ---
const SAMPLE_USER = JSON.parse(readFileSync(referenceFile('sample-user.json'), 'utf8'));

/** A new user starts with an empty wallet (the example balances are opt-in). */
export async function loadUser() {
  const u = await readJson(dataFile('user.json'), null);
  return u || { balances: [], preferences: structuredClone(SAMPLE_USER.preferences), isNew: true };
}

export function exampleUser() { return structuredClone(SAMPLE_USER); }

export async function saveUser(body) {
  if (!body || !Array.isArray(body.balances)) throw Object.assign(new Error('balances must be an array'), { status: 400 });
  const balances = body.balances.map(b => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw Object.assign(new Error('Each balance must be an object'), { status: 400 });
    const code = programId(b.code) || programId(b.program);
    if (!code) throw Object.assign(new Error(`Unknown program "${b.program || b.code}"`), { status: 400 });
    const kind = programKind(code);
    return {
      program: programName(code), code, type: kind,
      balance: parseFiniteNumber(b.balance ?? 0, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, name: 'balance' }),
      cpp: parseFiniteNumber(b.cpp ?? 0, { min: 0, max: 10000, name: 'cpp' }),
      transferable: kind === 'bank'
    };
  });
  const input = body.preferences ?? {};
  const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('preferences must be an object');
  const preferences = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'defaultCpp') preferences[key] = parseFiniteNumber(value, { min: 0, max: 10000, name: key });
    else if (key === 'maxTransfers') preferences[key] = parseFiniteNumber(value, { min: 0, max: 20, integer: true, name: key });
    else if (['preferNonstop', 'preserveFlexiblePoints'].includes(key)) {
      if (typeof value !== 'boolean') bad(key + ' must be a boolean');
      preferences[key] = value;
    } else bad('Unknown wallet preference: ' + key);
  }
  const user = { balances, preferences };
  await writeJson(dataFile('user.json'), user);
  return user;
}

const invalidRestore = message => { throw Object.assign(new TypeError(message), { status:400, code:'INVALID_RESTORE_DATA' }); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** Pure restore validator for the wallet document. No store reads or writes. */
export function validateUser(value) {
  if (!isObject(value) || !Array.isArray(value.balances) || value.balances.length > 500) invalidRestore('Invalid user document');
  for (const key of Object.keys(value)) if (!['balances','preferences'].includes(key)) invalidRestore(`Unknown user field: ${key}`);
  const balances = value.balances.map(b => {
    if (!isObject(b)) invalidRestore('Invalid balance');
    for (const key of Object.keys(b)) if (!['code','program','balance','cpp','type','transferable'].includes(key)) invalidRestore(`Unknown balance field: ${key}`);
    const code = programId(b.code) || programId(b.program);
    if (!code) invalidRestore('Unknown balance program');
    const kind = programKind(code);
    try { return { program:programName(code), code, type:kind, balance:parseFiniteNumber(b.balance ?? 0,{min:0,max:Number.MAX_SAFE_INTEGER,integer:true,name:'balance'}), cpp:parseFiniteNumber(b.cpp ?? 0,{min:0,max:10000,name:'cpp'}), transferable:kind==='bank' }; }
    catch { return invalidRestore('Invalid balance values'); }
  });
  const p = value.preferences ?? {};
  if (!isObject(p)) invalidRestore('Invalid user preferences');
  const preferences = {};
  for (const [k,v] of Object.entries(p)) {
    try {
      if(k==='defaultCpp') preferences[k]=parseFiniteNumber(v,{min:0,max:10000,name:k});
      else if(k==='maxTransfers') preferences[k]=parseFiniteNumber(v,{min:0,max:20,integer:true,name:k});
      else if(['preferNonstop','preserveFlexiblePoints'].includes(k) && typeof v==='boolean') preferences[k]=v;
      else invalidRestore(`Invalid user preference: ${k}`);
    } catch { invalidRestore(`Invalid user preference: ${k}`); }
  }
  return { balances, preferences };
}

/** Pure allowlist projection for settings; secrets and local delivery endpoints are excluded. */
export function validateSettings(value, { allowSecrets = false } = {}) {
  if (!isObject(value)) invalidRestore('Invalid settings document');
  const out = {};
  for (const [k,v] of Object.entries(value)) {
    if (SECRET_KEYS.includes(k) || k === 'webhookUrl') {
      if (!allowSecrets) continue;
      if (typeof v !== 'string' || v.length > 4096) invalidRestore(`Invalid ${k}`);
      if (k === 'webhookUrl' && v && (!/^https:\/\//i.test(v) || (()=>{try{const u=new URL(v);return Boolean(u.username||u.password);}catch{return true;}})())) invalidRestore('Invalid webhook URL');
      out[k] = v;
      continue;
    }
    if (k === 'homeAirports') {
      if (typeof v !== 'string' || v.length > 100) invalidRestore('Invalid home airports');
      out[k] = v.toUpperCase().replace(/[^A-Z,\s]/g,'').trim();
    } else if (['monitorIntervalMinutes','apiRefreshMinutes'].includes(k)) {
      const n=Number(v); if(!Number.isFinite(n)) invalidRestore(`Invalid ${k}`);
      out[k]=Math.min(1440,Math.max(k==='monitorIntervalMinutes'?15:5,Math.round(n)));
    } else if (['desktopNotifications','closeToTray','launchAtLogin'].includes(k)) {
      if(typeof v!=='boolean') invalidRestore(`Invalid ${k}`); out[k]=v;
    } else invalidRestore(`Unknown setting: ${k}`);
  }
  return { ...DEFAULT_SETTINGS, ...out, ...(!allowSecrets ? { seatsAeroApiKey:'', travelpayoutsToken:'', serpApiKey:'', webhookUrl:'' } : {}) };
}

/** Validate alert definitions for restore and force them inactive; runtime history is stripped. */
export function validateAlertDefinitions(value) {
  if (!Array.isArray(value) || value.length > 500) invalidRestore('Invalid alert definitions');
  const kinds = new Set(['award','hotel','cash','deals']);
  return value.map(a => {
    if (!isObject(a) || !kinds.has(a.kind) || typeof a.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(a.id)) invalidRestore('Invalid alert definition');
    const allowed = new Set(['id','kind','title','active','createdAt','query','maxPointsPerTraveler','maxPointsPerNight','minCpp','targetPrice','dealPct','verifyWithGoogle','minDropPct','track','notifiedKeys','lastNotifiedPrice','lastGoogleDay','lastMatchPrices','lastResult','lastSignature','lastAttemptAt','lastStatus','lastError','lastCheckedAt','lastWarnings','deliveryState','pendingDelivery','lastTracked']);
    for (const key of Object.keys(a)) if (!allowed.has(key)) invalidRestore(`Unknown alert field: ${key}`);
    if (!isObject(a.query)) invalidRestore('Invalid alert query');
    const queryKeys = new Set(['origins','destination','departDate','returnDate','flexDays','cabin','travelers','nonstopOnly','checkIn','checkOut','roomType','airports','maxPointsPerNight','product','maxPrice']);
    for (const key of Object.keys(a.query)) if (!queryKeys.has(key)) invalidRestore(`Unknown alert query field: ${key}`);
    const title = typeof a.title==='string' ? a.title.slice(0,120) : '';
    if (Object.hasOwn(a,'createdAt') && (typeof a.createdAt!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(a.createdAt) || !Number.isFinite(Date.parse(a.createdAt)))) invalidRestore('Invalid alert createdAt');
    const q = {};
    for (const key of ['origins','destination','departDate','returnDate','flexDays','cabin','travelers','nonstopOnly','checkIn','checkOut','roomType','airports','maxPointsPerNight','product','maxPrice']) if (Object.hasOwn(a.query,key)) {
      const v=a.query[key];
      if (v===null && ['returnDate','checkOut'].includes(key)) { q[key]=null; continue; }
      if(['departDate','returnDate','checkIn','checkOut'].includes(key)) { if(typeof v!=='string'||!isCalendarDate(v)) invalidRestore(`Invalid alert date: ${key}`); q[key]=v; }
      else if(key==='travelers') { if(!Number.isSafeInteger(v)||v<1||v>9) invalidRestore('Invalid alert travelers'); q[key]=v; }
      else if(key==='flexDays') { if(!Number.isSafeInteger(v)||v<0||v>30) invalidRestore('Invalid alert date flexibility'); q[key]=v; }
      else if(key==='cabin') { if(!['economy','premium','business','first'].includes(v)) invalidRestore('Invalid alert cabin'); q[key]=v; }
      else if(typeof v==='string' && v.length<=160) q[key]=v;
      else if(typeof v==='number' && Number.isFinite(v) && v>=0) q[key]=v;
      else if(typeof v==='boolean' && key==='nonstopOnly') q[key]=v;
      else invalidRestore('Invalid alert query field');
    }
    const clean={id:a.id,kind:a.kind,title,query:q,active:false,...(a.createdAt?{createdAt:a.createdAt}:{})};
    if (a.track != null) {
      if (!isObject(a.track) || !['product','exact','similar'].includes(a.track.mode)) invalidRestore('Invalid alert tracking definition');
      const trackKeys=new Set(['mode','product','productLabel','legs']);
      for(const key of Object.keys(a.track)) if(!trackKeys.has(key)) invalidRestore(`Unknown alert tracking field: ${key}`);
      if(!Array.isArray(a.track.legs)||a.track.legs.length>2) invalidRestore('Invalid tracked flights');
      if(a.track.mode==='product') {
        if(typeof a.track.product!=='string'||a.track.product.length>100) invalidRestore('Invalid tracked product');
        if(a.track.productLabel!=null&&(typeof a.track.productLabel!=='string'||a.track.productLabel.length>160)) invalidRestore('Invalid tracked product label');
        clean.track={mode:'product',product:a.track.product,...(Object.hasOwn(a.track,'productLabel')?{productLabel:a.track.productLabel}:{}),legs:a.track.legs.map(validateTrackedFlight)};
      } else {
        if(a.track.legs.length<1) invalidRestore('Invalid tracked flights');
        clean.track={mode:a.track.mode,legs:a.track.legs.map(validateTrackedFlight)};
      }
    }
    for (const k of ['maxPointsPerTraveler','maxPointsPerNight','minCpp','targetPrice','dealPct','minDropPct']) if(a[k]!=null) { const n=Number(a[k]); if(!Number.isFinite(n)||n<0) invalidRestore(`Invalid alert ${k}`); clean[k]=n; }
    if(Object.hasOwn(a,'verifyWithGoogle')) { if(typeof a.verifyWithGoogle!=='boolean') invalidRestore('Invalid verifyWithGoogle'); clean.verifyWithGoogle=a.verifyWithGoogle; }
    return clean;
  });
}

function validateTrackedFlight(l) {
  const legKeys=new Set(['leg','date','flightNumbers','program','programName','mileageCost','seatScore','product']);
  if(!isObject(l)||Object.keys(l).some(k=>!legKeys.has(k))||!['Outbound','Return'].includes(l.leg)||typeof l.date!=='string'||!isCalendarDate(l.date)||!Array.isArray(l.flightNumbers)||l.flightNumbers.length>6||l.flightNumbers.some(x=>typeof x!=='string'||x.length>20)||!(l.program===null||(typeof l.program==='string'&&l.program.length<=40))||!(l.programName===null||(typeof l.programName==='string'&&l.programName.length<=80))||!Number.isFinite(l.mileageCost)||l.mileageCost<0||l.mileageCost>Number.MAX_SAFE_INTEGER||!(l.seatScore===null||(Number.isFinite(l.seatScore)&&l.seatScore>=0&&l.seatScore<=5))||!(l.product===null||(typeof l.product==='string'&&l.product.length<=100))) invalidRestore('Invalid tracked flight');
  return {leg:l.leg,date:l.date,flightNumbers:[...l.flightNumbers],program:l.program,programName:l.programName,mileageCost:l.mileageCost,seatScore:l.seatScore,product:l.product};
}
