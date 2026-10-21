import { parseFiniteNumber } from './validate.mjs';
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
