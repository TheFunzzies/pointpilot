import { readFileSync } from 'node:fs';
import { dataFile, referenceFile } from './paths.mjs';
import { readJson, updateJson, writeJson } from './store.mjs';
import { programId, programName, programKind } from './programs.mjs';

export const DEFAULT_SETTINGS = {
  seatsAeroApiKey: '',
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

/** Settings safe to send to the UI (API key masked). */
export async function publicSettings() {
  const s = await getSettings();
  const { seatsAeroApiKey, ...rest } = s;
  return { ...rest, hasSeatsAeroKey: Boolean(seatsAeroApiKey), seatsAeroKeyHint: seatsAeroApiKey ? `…${seatsAeroApiKey.slice(-4)}` : '' };
}

export async function updateSettings(patch = {}) {
  const clean = {};
  if (typeof patch.seatsAeroApiKey === 'string') clean.seatsAeroApiKey = patch.seatsAeroApiKey.trim();
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

// --- API usage: seats.aero (flights) and rooms.aero (hotels) each allow ~1,000 calls per UTC day ---
export async function recordApiCalls(n, service = 'seats') {
  const day = new Date().toISOString().slice(0, 10);
  const key = service === 'rooms' ? 'roomsCalls' : 'calls';
  return updateJson(dataFile('api-usage.json'), {}, u => {
    const today = u.day === day ? u : { day, calls: 0, roomsCalls: 0 };
    return { ...today, [key]: (today[key] || 0) + n };
  });
}
export async function apiUsage() {
  const day = new Date().toISOString().slice(0, 10);
  const u = await readJson(dataFile('api-usage.json'), {});
  return u.day === day ? { day, calls: u.calls || 0, roomsCalls: u.roomsCalls || 0 } : { day, calls: 0, roomsCalls: 0 };
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
    const code = programId(b.code) || programId(b.program);
    if (!code) throw Object.assign(new Error(`Unknown program "${b.program || b.code}"`), { status: 400 });
    const kind = programKind(code);
    return {
      program: programName(code), code, type: kind,
      balance: Math.max(0, Math.round(Number(b.balance) || 0)),
      cpp: Math.max(0, Number(b.cpp) || 0),
      transferable: kind === 'bank'
    };
  });
  const user = { balances, preferences: { ...(body.preferences || {}) } };
  await writeJson(dataFile('user.json'), user);
  return user;
}
