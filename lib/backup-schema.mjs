// Backup payload: what an export contains, how an import is validated and normalized, and the pure
// merge/replace planner behind the restore preview. Nothing here reads or writes the store: callers hand
// in snapshots and get back the documents that *would* be written. Domain validators belong to the
// owning packages (A plans, C wallet/settings/alerts) and are injected so tests can use fixtures.
import { backupInvalid, BackupError } from './backup.mjs';
import { canonicalJson } from './store-transaction.mjs';
import { normalizeTripPlan, normalizeStayPlan } from './itinerary.mjs';
import { DEFAULT_SETTINGS, validateUser, validateSettings, validateAlertDefinitions } from './settings.mjs';

export const PAYLOAD_SCHEMA_VERSION = 1;
export const CATEGORIES = Object.freeze(['wallet', 'preferences', 'settings', 'plans', 'alerts']);
export const LIMITS = Object.freeze({ balances: 200, alerts: 500, segments: 6, stays: 20 });
export const SECRET_SETTING_KEYS = Object.freeze(['seatsAeroApiKey', 'travelpayoutsToken', 'serpApiKey', 'webhookUrl']);
export const SETTING_KEYS = Object.freeze(['homeAirports', 'monitorIntervalMinutes', 'apiRefreshMinutes', 'desktopNotifications', 'closeToTray', 'launchAtLogin', 'buyPointsOffers']);
const SECRET_LABELS = { seatsAeroApiKey: 'seats.aero API key', travelpayoutsToken: 'Travelpayouts token', serpApiKey: 'SerpApi key', webhookUrl: 'webhook destination' };
const SETTING_LABELS = { homeAirports: 'Home airports', monitorIntervalMinutes: 'Alert check interval', apiRefreshMinutes: 'Search reuse window', desktopNotifications: 'Desktop notifications', closeToTray: 'Close to tray', launchAtLogin: 'Start with Windows', buyPointsOffers: 'Buy-points offers' };
const ALERT_DEFINITION_FIELDS = ['id', 'kind', 'title', 'active', 'createdAt', 'query', 'maxPointsPerTraveler', 'maxPointsPerNight', 'minCpp', 'targetPrice', 'dealPct', 'minDropPct', 'verifyWithGoogle', 'track'];
const DEFINITION_IDENTITY_EXCLUDED = new Set(['id', 'title', 'active', 'createdAt']);

export const defaultValidators = Object.freeze({ validateUser, validateSettings, validateAlertDefinitions, normalizeTripPlan, normalizeStayPlan, defaultSettings: DEFAULT_SETTINGS });

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => canonicalJson(a) === canonicalJson(b);
const tooLarge = message => new BackupError(message, 413, 'BACKUP_TOO_LARGE');

/** Run a foreign validator; whatever it throws becomes a safe message that never echoes the data. */
function guard(label, fn) {
  try { return fn(); }
  catch { throw backupInvalid(`The ${label} in this backup is not valid.`); }
}

export function parseCategories(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > CATEGORIES.length) throw new BackupError('Choose at least one category.', 400, 'BACKUP_INVALID');
  const seen = new Set();
  for (const c of value) {
    if (!CATEGORIES.includes(c) || seen.has(c)) throw new BackupError('Unknown or repeated backup category.', 400, 'BACKUP_INVALID');
    seen.add(c);
  }
  return CATEGORIES.filter(c => seen.has(c));
}

// ---------- export ----------
/**
 * Hotel alerts carry their room allocation in query.rooms. The shared alert validator drops query keys it does not know,
 * so the allocation is validated and re-attached here: 1-4 rooms, 1-8 adults, up to 6 child ages (0-17), a known room type.
 */
export function boundedRooms(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const out = [];
  for (const room of value) {
    if (!isObject(room) || Object.keys(room).some(k => !['adults', 'childrenAges', 'roomType'].includes(k))) return null;
    const ages = room.childrenAges ?? [];
    if (!Number.isInteger(room.adults) || room.adults < 1 || room.adults > 8 || !Array.isArray(ages) || ages.length > 6 || !ages.every(a => Number.isInteger(a) && a >= 0 && a <= 17) || !['standard', 'suite', 'any'].includes(room.roomType)) return null;
    out.push({ adults: room.adults, childrenAges: [...ages], roomType: room.roomType });
  }
  return out;
}
// The shared validator rejects query keys it does not know, so rooms are taken out before it runs and put back after.
const withoutRooms = raw => {
  if (!raw || !isObject(raw.query) || raw.query.rooms === undefined) return raw;
  const { rooms: _rooms, ...query } = raw.query;
  return { ...raw, query };
};
const withRooms = (clean, raw) => {
  const rooms = raw && isObject(raw.query) && raw.query.rooms !== undefined ? boundedRooms(raw.query.rooms) : undefined;
  if (rooms === null) throw backupInvalid('The alerts in this backup are not valid.');
  return rooms ? { ...clean, query: { ...clean.query, rooms } } : clean;
};

const definitionOf = (raw, validators) => {
  const picked = Object.fromEntries(ALERT_DEFINITION_FIELDS.filter(k => raw[k] !== undefined).map(k => [k, raw[k]]));
  const [clean] = validators.validateAlertDefinitions([withoutRooms(picked)]);
  return { ...withRooms(clean, raw), active: raw.active === true };
};

/**
 * Build the encrypted payload from a store snapshot. Secrets (API keys, webhook destination) are only
 * embedded with includeSecrets. Runtime state (alert history, delivery, caches, readiness) never is.
 */
export function buildPayload({ documents, categories, includeSecrets = false, appVersion = 'unknown', now = () => Date.now(), validators = defaultValidators }) {
  const cats = parseCategories(categories);
  const warnings = [];
  const out = {};
  const user = documents.user ?? { balances: [], preferences: {} };

  if (cats.includes('wallet') || cats.includes('preferences')) {
    const normalized = guard('wallet', () => validators.validateUser({ balances: user.balances ?? [], preferences: user.preferences ?? {} }));
    out.user = {};
    if (cats.includes('wallet')) {
      if (normalized.balances.length > LIMITS.balances) throw tooLarge(`Your wallet has more than ${LIMITS.balances} program rows, which a backup cannot hold.`);
      out.user.balances = normalized.balances;
    }
    if (cats.includes('preferences')) out.user.preferences = normalized.preferences;
  }

  let includesSecrets = false;
  if (cats.includes('settings')) {
    const stored = isObject(documents.settings) ? documents.settings : {};
    const effective = { ...validators.defaultSettings, ...stored };
    const picked = Object.fromEntries(SETTING_KEYS.filter(k => effective[k] !== undefined).map(k => [k, effective[k]]));
    const normalized = guard('settings', () => validators.validateSettings(picked));
    out.settings = { values: Object.fromEntries(SETTING_KEYS.map(k => [k, normalized[k]])) };
    if (includeSecrets) {
      const secrets = Object.fromEntries(SECRET_SETTING_KEYS.filter(k => typeof stored[k] === 'string' && stored[k].trim()).map(k => [k, stored[k].trim()]));
      if (Object.keys(secrets).length) { out.settings.secrets = secrets; includesSecrets = true; }
    }
  }

  if (cats.includes('plans')) {
    if (documents.tripPlan) {
      try { out.tripPlan = validators.normalizeTripPlan(documents.tripPlan, { strict: true }); }
      catch { warnings.push('The saved trip plan could not be included because it holds an incomplete older draft.'); }
    }
    if (documents.stayPlan) {
      try { out.stayPlan = validators.normalizeStayPlan(documents.stayPlan, { strict: true }); }
      catch { warnings.push('The saved stay plan could not be included because it holds an older or oversized plan.'); }
    }
  }

  if (cats.includes('alerts')) {
    const list = Array.isArray(documents.alerts) ? documents.alerts : [];
    const alerts = [];
    let skipped = 0;
    for (const raw of list) {
      if (!isObject(raw) || !isObject(raw.query)) { skipped += 1; continue; }
      try { alerts.push(definitionOf(raw, validators)); } catch { skipped += 1; }
    }
    if (alerts.length > LIMITS.alerts) throw tooLarge(`You have more than ${LIMITS.alerts} alerts, which a backup cannot hold.`);
    if (skipped) warnings.push(`${skipped} alert${skipped === 1 ? '' : 's'} could not be included because ${skipped === 1 ? 'its' : 'their'} definition is not readable.`);
    out.alerts = alerts;
  }

  return {
    payload: { schemaVersion: PAYLOAD_SCHEMA_VERSION, createdAt: new Date(now()).toISOString(), appVersion: String(appVersion).slice(0, 40), includesSecrets, categories: cats, documents: out },
    warnings
  };
}

// ---------- import ----------
const hasOnly = (obj, keys) => isObject(obj) && Object.keys(obj).every(k => keys.includes(k));

function canonicalWallet(balances) {
  const byCode = new Map();
  for (const row of balances) {
    const existing = byCode.get(row.code);
    if (!existing) { byCode.set(row.code, { ...row }); continue; }
    if (existing.cpp !== row.cpp) throw backupInvalid('The wallet in this backup lists the same program twice with different values per point.');
    const sum = existing.balance + row.balance;
    if (!Number.isSafeInteger(sum)) throw backupInvalid('The wallet in this backup has a balance that is too large.');
    existing.balance = sum;
  }
  return [...byCode.values()];
}

function normalizeSecrets(secrets) {
  if (!hasOnly(secrets, SECRET_SETTING_KEYS)) throw backupInvalid('The settings in this backup are not valid.');
  const out = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v !== 'string' || !v.trim() || v.length > 2048 || /[\r\n\0]/.test(v)) throw backupInvalid('The settings in this backup are not valid.');
    if (k === 'webhookUrl' && !/^https:\/\//i.test(v.trim())) throw backupInvalid('The settings in this backup are not valid.');
    out[k] = v.trim();
  }
  return out;
}

/** Validate and normalize a decrypted payload. Returns staged data; throws safe BackupErrors. */
export function normalizeIncoming(payload, { validators = defaultValidators } = {}) {
  if (!isObject(payload)) throw backupInvalid();
  if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 1) throw backupInvalid();
  if (payload.schemaVersion !== PAYLOAD_SCHEMA_VERSION) throw new BackupError('This backup was made by a different version of PointPilot and cannot be read.', 400, 'BACKUP_UNSUPPORTED_VERSION');
  if (!hasOnly(payload, ['schemaVersion', 'createdAt', 'appVersion', 'includesSecrets', 'categories', 'documents'])) throw backupInvalid();
  if (typeof payload.createdAt !== 'string' || Number.isNaN(Date.parse(payload.createdAt))) throw backupInvalid();
  if (typeof payload.appVersion !== 'string' || payload.appVersion.length > 40) throw backupInvalid();
  if (typeof payload.includesSecrets !== 'boolean') throw backupInvalid();
  const categories = parseCategories(payload.categories, { allowEmpty: true });
  const docs = payload.documents;
  if (!hasOnly(docs, ['user', 'settings', 'tripPlan', 'stayPlan', 'alerts'])) throw backupInvalid();

  const staged = { createdAt: payload.createdAt, appVersion: payload.appVersion, includesSecrets: payload.includesSecrets, categories, wallet: undefined, preferences: undefined, settings: undefined, secrets: {}, tripPlan: undefined, stayPlan: undefined, alerts: undefined };

  if (docs.user !== undefined) {
    if (!hasOnly(docs.user, ['balances', 'preferences'])) throw backupInvalid();
    if (Array.isArray(docs.user.balances) && docs.user.balances.length > LIMITS.balances) throw tooLarge(`This backup has more than ${LIMITS.balances} wallet rows.`);
    const normalized = guard('wallet', () => validators.validateUser({ balances: docs.user.balances ?? [], preferences: docs.user.preferences ?? {} }));
    if (docs.user.balances !== undefined) staged.wallet = canonicalWallet(normalized.balances);
    if (docs.user.preferences !== undefined) staged.preferences = normalized.preferences;
  }
  if (docs.settings !== undefined) {
    if (!hasOnly(docs.settings, ['values', 'secrets']) || !isObject(docs.settings.values) || !hasOnly(docs.settings.values, SETTING_KEYS)) throw backupInvalid('The settings in this backup are not valid.');
    const normalized = guard('settings', () => validators.validateSettings(docs.settings.values));
    staged.settings = Object.fromEntries(Object.keys(docs.settings.values).map(k => [k, normalized[k]]));
    if (docs.settings.secrets !== undefined) {
      if (!payload.includesSecrets) throw backupInvalid('The settings in this backup are not valid.');
      staged.secrets = normalizeSecrets(docs.settings.secrets);
    }
  }
  if (docs.tripPlan !== undefined) {
    const plan = guard('trip plan', () => validators.normalizeTripPlan(docs.tripPlan, { strict: true }));
    if ((plan.segments || []).length > LIMITS.segments) throw tooLarge('This backup has more trip legs than PointPilot supports.');
    staged.tripPlan = plan;
  }
  if (docs.stayPlan !== undefined) {
    const plan = guard('stay plan', () => validators.normalizeStayPlan(docs.stayPlan, { strict: true }));
    if ((plan.stays || []).length > LIMITS.stays) throw tooLarge('This backup has more stays than PointPilot supports.');
    staged.stayPlan = plan;
  }
  if (docs.alerts !== undefined) {
    if (!Array.isArray(docs.alerts)) throw backupInvalid();
    if (docs.alerts.length > LIMITS.alerts) throw tooLarge(`This backup has more than ${LIMITS.alerts} alerts.`);
    const wasActive = new Map(docs.alerts.map(a => [a?.id, a?.active === true]));
    const defs = guard('alerts', () => validators.validateAlertDefinitions(docs.alerts.map(a => {
      if (!isObject(a)) throw new Error('bad');
      return withoutRooms(Object.fromEntries(Object.entries(a).filter(([k]) => ALERT_DEFINITION_FIELDS.includes(k))));
    })));
    if (new Set(defs.map(d => d.id)).size !== defs.length) throw backupInvalid('The alerts in this backup have duplicate ids.');
    const rawById = new Map(docs.alerts.map(a => [a.id, a]));
    staged.alerts = defs.map(def => ({ def: withRooms(def, rawById.get(def.id)), wasActive: wasActive.get(def.id) === true }));
  }
  return staged;
}

// ---------- planning (merge / replace) ----------
const stayFingerprint = s => canonicalJson([s.program, s.hotelId || s.name, s.roomType, s.checkIn, s.checkOut, s.nightlyPoints, s.totalPoints]);
const alertFingerprint = def => canonicalJson(Object.fromEntries(Object.entries(def).filter(([k]) => !DEFINITION_IDENTITY_EXCLUDED.has(k)).sort(([a], [b]) => (a < b ? -1 : 1))));
const planIsEmpty = plan => !plan || !(plan.segments?.length || Object.values(plan.flights || {}).some(Boolean));
const withoutRevision = plan => { const { revision: _r, migrationWarnings: _m, ...rest } = plan; return rest; };
const stayLabel = s => `${s.name || 'Stay'} (${s.checkIn} to ${s.checkOut})`;
// Identity (above) says which stay this is. Equality also covers what the user chose for it: the room allocation and anything
// they entered from the program. Two copies of the same stay that differ there are a conflict, not "unchanged".
const stayEquality = s => canonicalJson([stayFingerprint(s), s.rooms ?? null, s.programEvidence ?? null]);
const stayDetail = s => `${stayLabel(s)} · ${plural((s.rooms || []).length || 1, 'room')}${s.programEvidence ? ' · user-entered program details' : ''}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function runtimeDefaults(def, { active, now, idOverride }) {
  const record = {
    ...structuredClone(def), id: idOverride || def.id, active, createdAt: def.createdAt || new Date(now).toISOString(),
    lastAttemptAt: null, lastStatus: null, lastError: null, lastCheckedAt: null, lastResult: null, lastSignature: null
  };
  if (def.kind === 'cash') { record.lastNotifiedPrice = null; record.lastGoogleDay = null; }
  if (def.kind === 'deals') record.notifiedKeys = [];
  return record;
}

/**
 * Compute the restore. `current` is a snapshot ({user, settings, tripPlan, stayPlan, alerts}, absent = null).
 * Pure: returns the documents to write plus everything the review screen shows. `choices` maps conflict ids
 * to keep/incoming (alerts also accept both); anything not chosen keeps the current data.
 */
export function planRestore({ current, staged, mode, categories, choices = {}, options = {}, now = Date.now(), newId = () => `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, validators = defaultValidators }) {
  if (!['merge', 'replace'].includes(mode)) throw new BackupError('Choose merge or replace.', 400, 'BACKUP_INVALID');
  const requested = parseCategories(categories);
  const opts = { restoreSecrets: options.restoreSecrets === true, activateImportedAlerts: options.activateImportedAlerts === true, enableLaunchAtLogin: options.enableLaunchAtLogin === true };
  const replace = mode === 'replace';
  const warnings = [];
  const effects = [];
  const conflicts = [];
  const counts = {};
  const after = {};
  const sensitive = { secretsRestored: [], webhookChanged: false, alertsActivated: 0, launchAtLoginEnabled: false };

  const available = new Set(staged.categories);
  const selected = requested.filter(c => available.has(c));
  for (const c of requested) if (!available.has(c)) warnings.push(`This backup does not include ${c === 'plans' ? 'saved plans' : c}, so it will be left as is.`);

  const conflict = (id, category, label, actionOptions, detail = {}) => {
    const chosen = choices[id];
    if (chosen !== undefined && !actionOptions.includes(chosen)) throw new BackupError('That choice is not available for this conflict.', 400, 'BACKUP_INVALID');
    const resolution = chosen ?? 'keep';
    conflicts.push({ id, category, label, actionOptions, defaultAction: 'keep', resolution, explicit: chosen !== undefined, ...detail });
    return resolution;
  };
  const tally = (category, patch) => { counts[category] = { incoming: 0, add: 0, update: 0, remove: 0, unchanged: 0, skipped: 0, ...counts[category], ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, (counts[category]?.[k] || 0) + v])) }; };
  const note = (category, action, count, text) => { if (count) effects.push({ category, action, count, text }); };

  // ----- wallet and preferences (one document: user.json)
  const curUser = isObject(current.user) ? current.user : { balances: [], preferences: {} };
  let balances = structuredClone(curUser.balances ?? []);
  let preferences = structuredClone(curUser.preferences ?? {});
  let userTouched = false;

  if (selected.includes('wallet') && staged.wallet) {
    userTouched = true;
    tally('wallet', { incoming: staged.wallet.length });
    if (replace) {
      const incomingCodes = new Set(staged.wallet.map(r => r.code));
      const removed = balances.filter(r => !incomingCodes.has(r.code)).length;
      const byCode = new Map(balances.map(r => [r.code, r]));
      let same = 0, updated = 0, added = 0;
      for (const r of staged.wallet) { const e = byCode.get(r.code); if (!e) added += 1; else if (e.balance === r.balance && e.cpp === r.cpp) same += 1; else updated += 1; }
      balances = structuredClone(staged.wallet);
      tally('wallet', { add: added, update: updated, remove: removed, unchanged: same });
      note('wallet', 'replace', balances.length, `Replace your wallet with the ${plural(balances.length, 'program')} in the backup${removed ? `; ${plural(removed, 'current program')} not in the backup will be removed` : ''}.`);
    } else {
      let added = 0, updated = 0, same = 0, kept = 0;
      for (const r of staged.wallet) {
        const idx = balances.findIndex(e => e.code === r.code);
        if (idx < 0) { balances.push(structuredClone(r)); added += 1; continue; }
        const e = balances[idx];
        if (e.balance === r.balance && e.cpp === r.cpp) { same += 1; continue; }
        const resolution = conflict(`wallet:${r.code}`, 'wallet', `${r.program}`, ['keep', 'incoming'], { existing: `${e.balance.toLocaleString('en-US')} points at ${e.cpp}¢`, incoming: `${r.balance.toLocaleString('en-US')} points at ${r.cpp}¢` });
        if (resolution === 'incoming') { balances[idx] = structuredClone(r); updated += 1; } else kept += 1;
      }
      tally('wallet', { add: added, update: updated, unchanged: same, skipped: kept });
      note('wallet', 'add', added, `Add ${plural(added, 'program')} to your wallet.`);
      note('wallet', 'update', updated, `Use the backup's values for ${plural(updated, 'program')}. Balances are replaced, never added together.`);
      note('wallet', 'keep', kept, `Keep your current values for ${plural(kept, 'program')} that differ.`);
    }
    if (balances.length > LIMITS.balances) throw new BackupError(`Restoring would leave more than ${LIMITS.balances} wallet rows. Choose Replace or remove some programs first.`, 400, 'BACKUP_INVALID');
  }

  if (selected.includes('preferences') && staged.preferences) {
    userTouched = true;
    const keys = Object.keys(staged.preferences);
    tally('preferences', { incoming: keys.length });
    if (replace) {
      const removed = Object.keys(preferences).filter(k => !(k in staged.preferences)).length;
      const changed = keys.filter(k => !sameJson(preferences[k], staged.preferences[k])).length;
      preferences = structuredClone(staged.preferences);
      tally('preferences', { update: changed, remove: removed, unchanged: keys.length - changed });
      note('preferences', 'replace', keys.length, `Replace your optimizer preferences with the backup's ${plural(keys.length, 'value')}.`);
    } else {
      let added = 0, updated = 0, same = 0, kept = 0;
      for (const k of keys) {
        if (!(k in preferences)) { preferences[k] = staged.preferences[k]; added += 1; }
        else if (sameJson(preferences[k], staged.preferences[k])) same += 1;
        else {
          const resolution = conflict(`preferences:${k}`, 'preferences', k, ['keep', 'incoming'], { existing: String(preferences[k]), incoming: String(staged.preferences[k]) });
          if (resolution === 'incoming') { preferences[k] = staged.preferences[k]; updated += 1; } else kept += 1;
        }
      }
      tally('preferences', { add: added, update: updated, unchanged: same, skipped: kept });
      note('preferences', 'add', added + updated, `Apply ${plural(added + updated, 'optimizer preference')} from the backup.`);
      note('preferences', 'keep', kept, `Keep your current value for ${plural(kept, 'preference')} that differ.`);
    }
  }
  if (userTouched) {
    const nextUser = { ...structuredClone(curUser), balances, preferences };
    if (!isObject(current.user) || !sameJson(nextUser, current.user)) after.user = nextUser;
  }

  // ----- settings (settings.json): nonsecret values, optionally secrets
  if (selected.includes('settings') && staged.settings) {
    const stored = isObject(current.settings) ? current.settings : {};
    const next = structuredClone(stored);
    const changes = [];
    let kept = 0, same = 0;
    const apply = (key, label, value, { secret = false } = {}) => {
      const have = stored[key];
      const present = have !== undefined && !(secret && !have);
      if (present && sameJson(have, value)) { same += 1; return; }
      if (!present && !secret && sameJson(validators.defaultSettings[key], value)) { same += 1; return; } // an untouched default
      if (present && !replace) {
        const resolution = conflict(`settings:${key}`, 'settings', label, ['keep', 'incoming'], secret ? { existing: 'a saved value', incoming: 'a different value from the backup', sensitive: true } : { existing: String(have), incoming: String(value) });
        if (resolution !== 'incoming') { kept += 1; return; }
      }
      next[key] = value; changes.push(label);
      if (secret) { sensitive.secretsRestored.push(label); if (key === 'webhookUrl') sensitive.webhookChanged = true; }
    };
    tally('settings', { incoming: Object.keys(staged.settings).length });
    for (const key of Object.keys(staged.settings)) {
      if (key === 'launchAtLogin' && staged.settings[key] === true && stored.launchAtLogin !== true && !opts.enableLaunchAtLogin) {
        tally('settings', { skipped: 1 });
        effects.push({ category: 'settings', action: 'skip', count: 1, text: 'Start with Windows stays as it is now. Turn on "Enable Start with Windows" in this review to apply the backup\'s setting.' });
        continue;
      }
      apply(key, SETTING_LABELS[key], staged.settings[key]);
      if (key === 'launchAtLogin' && next.launchAtLogin === true && stored.launchAtLogin !== true) sensitive.launchAtLoginEnabled = true;
    }
    if (staged.includesSecrets && Object.keys(staged.secrets).length) {
      if (opts.restoreSecrets) {
        for (const key of SECRET_SETTING_KEYS) if (staged.secrets[key] !== undefined) apply(key, SECRET_LABELS[key], staged.secrets[key], { secret: true });
      } else {
        warnings.push('This backup contains API keys and a webhook destination. They will not be restored unless you turn on "Restore API keys and webhook" in this review.');
      }
    }
    tally('settings', { update: changes.length, unchanged: same, skipped: kept });
    const plain = changes.filter(l => !Object.values(SECRET_LABELS).includes(l));
    note('settings', 'update', plain.length, `Change ${plural(plain.length, 'setting')}: ${plain.join(', ')}.`);
    for (const label of sensitive.secretsRestored) effects.push({ category: 'settings', action: 'update', count: 1, sensitive: true, text: `Overwrite your ${label} with the one from the backup.` });
    note('settings', 'keep', kept, `Keep your current value for ${plural(kept, 'setting')} that differ.`);
    if (changes.length) after.settings = next;
  }

  // ----- plans (trip-plan.json, stay-plan.json)
  if (selected.includes('plans')) {
    tally('plans', { incoming: (staged.tripPlan ? 1 : 0) + (staged.stayPlan?.stays.length || 0) });
    if (!staged.tripPlan && !staged.stayPlan) effects.push({ category: 'plans', action: 'keep', count: 0, text: 'The backup has no saved plans, so yours are left as they are.' });
    if (staged.tripPlan) {
      const cur = current.tripPlan;
      const revision = Number.isSafeInteger(cur?.revision) ? cur.revision + 1 : 1;
      const take = () => { after.tripPlan = { ...structuredClone(staged.tripPlan), revision }; };
      if (planIsEmpty(staged.tripPlan)) { effects.push({ category: 'plans', action: 'keep', count: 0, text: 'The backup\'s trip plan is empty, so your trip plan is left as it is.' }); tally('plans', { skipped: 1 }); }
      else if (replace) { take(); tally('plans', { update: 1 }); note('plans', 'replace', 1, planIsEmpty(cur) ? 'Use the backup\'s saved trip.' : 'Replace your saved trip with the one in the backup.'); }
      else if (planIsEmpty(cur)) { take(); tally('plans', { add: 1 }); note('plans', 'add', 1, 'Use the backup\'s saved trip (you have none).'); }
      else {
        let curNormalized = null;
        try { curNormalized = validators.normalizeTripPlan(cur, { strict: false }); } catch { /* treated as different */ }
        if (curNormalized && sameJson(withoutRevision(curNormalized), withoutRevision(staged.tripPlan))) tally('plans', { unchanged: 1 });
        else {
          const resolution = conflict('plans:tripPlan', 'plans', 'Saved trip', ['keep', 'incoming'], { existing: 'your current saved trip', incoming: 'the saved trip in the backup' });
          if (resolution === 'incoming') { take(); tally('plans', { update: 1 }); note('plans', 'replace', 1, 'Replace your saved trip with the one in the backup.'); }
          else { tally('plans', { skipped: 1 }); note('plans', 'keep', 1, 'Keep your current saved trip.'); }
        }
      }
    }
    if (staged.stayPlan) {
      const cur = current.stayPlan;
      let curStays = structuredClone(cur?.stays ?? []);
      // Compare against the owner's normalized form: older stored stays can lack fields the backup carries.
      try { if (cur) curStays = validators.normalizeStayPlan(cur, { strict: false, allowOversizedLegacy: true }).stays; } catch { /* fall back to the stored rows */ }
      const revision = Number.isSafeInteger(cur?.revision) ? cur.revision + 1 : 1;
      const originalStays = structuredClone(curStays);
      let stays;
      if (replace) {
        stays = structuredClone(staged.stayPlan.stays);
        tally('plans', { update: stays.length, remove: curStays.length });
        note('plans', 'replace', stays.length, `Replace your ${plural(curStays.length, 'saved stay')} with the ${plural(stays.length, 'stay')} in the backup.`);
      } else {
        stays = curStays;
        let added = 0, same = 0, updated = 0, kept = 0, capped = 0;
        for (const s of staged.stayPlan.stays) {
          const sameId = stays.findIndex(e => e.id === s.id);
          if (sameId >= 0) {
            if (stayEquality(stays[sameId]) === stayEquality(s)) { same += 1; continue; }
            const resolution = conflict(`plans:stay:${s.id}`, 'plans', stayLabel(s), ['keep', 'incoming'], { existing: stayDetail(stays[sameId]), incoming: stayDetail(s) });
            if (resolution === 'incoming') { stays[sameId] = structuredClone(s); updated += 1; } else kept += 1;
          } else if (stays.some(e => stayFingerprint(e) === stayFingerprint(s))) same += 1;
          else if (stays.length >= LIMITS.stays) capped += 1;
          else { stays.push(structuredClone(s)); added += 1; }
        }
        tally('plans', { add: added, update: updated, unchanged: same, skipped: kept + capped });
        note('plans', 'add', added, `Add ${plural(added, 'stay')} to your saved stays.`);
        note('plans', 'update', updated, `Use the backup's version of ${plural(updated, 'stay')}.`);
        note('plans', 'keep', kept, `Keep your version of ${plural(kept, 'stay')} that differ.`);
        if (capped) warnings.push(`${plural(capped, 'stay')} from the backup ${capped === 1 ? 'was' : 'were'} not added because PointPilot holds at most ${LIMITS.stays} stays.`);
      }
      // Keep the newer document version: stays carrying occupancy fields are schema 2 and must not be saved as 1.
      const schemaVersion = Math.max(Number(cur?.schemaVersion) || 1, Number(staged.stayPlan.schemaVersion) || 1);
      const nextPlan = { schemaVersion, revision, stays };
      if (!cur || !sameJson(stays, originalStays)) {
        guard('stay plan', () => validators.normalizeStayPlan(nextPlan, { strict: true }));
        after.stayPlan = nextPlan;
      }
    }
  }

  // ----- alerts (alerts.json)
  if (selected.includes('alerts') && staged.alerts) {
    const curAlerts = Array.isArray(current.alerts) ? structuredClone(current.alerts) : [];
    const originalAlerts = structuredClone(curAlerts);
    tally('alerts', { incoming: staged.alerts.length });
    // Stored alerts carry runtime state; compare them through the same validator that normalized the backup.
    const comparable = stored => {
      try { const raw = Object.fromEntries(ALERT_DEFINITION_FIELDS.filter(k => stored[k] !== undefined).map(k => [k, stored[k]])); return withRooms(validators.validateAlertDefinitions([withoutRooms(raw)])[0], raw); }
      catch { return definitionProjection(stored); }
    };
    const activeFor = item => opts.activateImportedAlerts && item.wasActive;
    let list;
    let activated = 0;
    if (replace) {
      list = staged.alerts.map(item => { const active = activeFor(item); if (active) activated += 1; return runtimeDefaults(item.def, { active, now }); });
      tally('alerts', { add: list.length, remove: curAlerts.length });
      note('alerts', 'replace', list.length, `Replace your ${plural(curAlerts.length, 'alert')} with the ${plural(list.length, 'alert')} in the backup.${list.length && !activated ? ' Imported alerts start turned off.' : ''}`);
    } else {
      list = curAlerts;
      let added = 0, same = 0, updated = 0, kept = 0, both = 0;
      for (const item of staged.alerts) {
        const def = item.def;
        const sameId = list.findIndex(e => e.id === def.id);
        if (sameId >= 0) {
          if (alertFingerprint(comparable(list[sameId])) === alertFingerprint(def)) { same += 1; continue; }
          const resolution = conflict(`alerts:${def.id}`, 'alerts', def.title || def.id, ['keep', 'incoming', 'both'], { existing: 'your alert', incoming: 'the alert in the backup' });
          if (resolution === 'incoming') { const active = activeFor(item); if (active) activated += 1; list[sameId] = runtimeDefaults(def, { active, now }); updated += 1; }
          else if (resolution === 'both') { const active = activeFor(item); if (active) activated += 1; list.push(runtimeDefaults(def, { active, now, idOverride: newId() })); both += 1; }
          else kept += 1;
        } else if (list.some(e => alertFingerprint(comparable(e)) === alertFingerprint(def))) same += 1;
        else { const active = activeFor(item); if (active) activated += 1; list.push(runtimeDefaults(def, { active, now })); added += 1; }
      }
      tally('alerts', { add: added + both, update: updated, unchanged: same, skipped: kept });
      note('alerts', 'add', added + both, `Add ${plural(added + both, 'alert')}. ${opts.activateImportedAlerts ? 'Alerts that were on in the backup will be turned on.' : 'Imported alerts start turned off.'}`);
      note('alerts', 'update', updated, `Use the backup's version of ${plural(updated, 'alert')}.`);
      note('alerts', 'keep', kept, `Keep your version of ${plural(kept, 'alert')} that differ.`);
    }
    if (list.length > LIMITS.alerts) throw new BackupError(`Restoring would leave more than ${LIMITS.alerts} alerts.`, 400, 'BACKUP_INVALID');
    sensitive.alertsActivated = activated;
    if (activated) effects.push({ category: 'alerts', action: 'activate', count: activated, sensitive: true, text: `${plural(activated, 'alert')} will be turned on and start checking (and may send notifications) after the restore.` });
    if (!sameJson(list, originalAlerts) || !current.alerts) after.alerts = list;
  }

  const issued = new Set(conflicts.map(c => c.id));
  if (Object.keys(choices).some(id => !issued.has(id))) throw new BackupError('A choice does not match any conflict in this review. Preview again.', 400, 'BACKUP_INVALID');

  if (sensitive.webhookChanged) effects.push({ category: 'settings', action: 'update', count: 1, sensitive: true, text: 'Alert notifications will be sent to the webhook destination from the backup.' });
  if (sensitive.launchAtLoginEnabled) effects.push({ category: 'settings', action: 'update', count: 1, sensitive: true, text: 'PointPilot will start with Windows.' });
  if (!Object.keys(after).length) effects.push({ category: 'all', action: 'none', count: 0, text: 'Nothing would change: your data already matches the backup, or you chose to keep everything.' });

  return { after, counts, conflicts, effects, warnings, sensitive, options: opts, selected };
}

/** Fields that identify an alert's definition, taken from a stored alert (which also carries runtime state). */
function definitionProjection(stored) {
  return Object.fromEntries(Object.entries(stored).filter(([k]) => ALERT_DEFINITION_FIELDS.includes(k) && !DEFINITION_IDENTITY_EXCLUDED.has(k)));
}
