import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-backup-'));
const crypto = await import('../lib/backup.mjs');
const schema = await import('../lib/backup-schema.mjs');
const { normalizeTripPlan, normalizeStayPlan } = await import('../lib/itinerary.mjs');

const PASSWORD = 'correct horse battery staple';
// Synthetic canaries: never real credentials.
const CANARY = { seats: 'CANARY-seats-key-0001', tp: 'CANARY-tp-token-0002', serp: 'CANARY-serp-key-0003', hook: 'https://hooks.example.test/services/CANARY-webhook-0004' };

const wallet = [
  { program: 'Chase Ultimate Rewards', code: 'chase', type: 'bank', balance: 120000, cpp: 1.7, transferable: true },
  { program: 'World of Hyatt', code: 'hyatt', type: 'hotel', balance: 30000, cpp: 1.8, transferable: false }
];
const storedSettings = { seatsAeroApiKey: CANARY.seats, travelpayoutsToken: CANARY.tp, serpApiKey: CANARY.serp, webhookUrl: CANARY.hook, monitorIntervalMinutes: 45, desktopNotifications: false, closeToTray: true, launchAtLogin: true, homeAirports: 'BOS,JFK' };
const storedAlert = {
  id: 'al1', kind: 'award', active: true, createdAt: '2026-10-01T00:00:00.000Z', title: 'Tokyo business',
  query: { origins: 'JFK', destination: 'Tokyo', departDate: '2027-05-01', returnDate: null, flexDays: 3, cabin: 'business', travelers: 2, nonstopOnly: false },
  maxPointsPerTraveler: 90000, minCpp: 1.5, track: null,
  lastAttemptAt: '2026-10-02T00:00:00.000Z', lastStatus: 'ok', lastError: null, lastCheckedAt: '2026-10-02T00:00:00.000Z', lastResult: { matches: [{ title: 'SECRET-RESULT' }] }, lastSignature: 'sig', deliveryState: { webhook: { target: CANARY.hook, key: 'k' } }, pendingDelivery: { x: 1 }
};
const storedStay = { id: 'stay1', name: 'Park Hyatt', program: 'hyatt', checkIn: '2027-06-05', checkOut: '2027-06-08', nightlyPoints: 25000 };
const legacyTrip = { home: { origin: 'BOS', returnTo: 'BOS' }, travelers: 2, flights: { outbound: { program: 'aeroplan', origin: 'JFK', destination: 'LHR', date: '2027-06-05', cabin: 'business', mileageCost: 60000, totalTaxes: 100, id: 'x1' } } };

const documents = () => ({
  user: { balances: structuredClone(wallet), preferences: { defaultCpp: 1.5, maxTransfers: 2, preferNonstop: false } },
  settings: structuredClone(storedSettings), tripPlan: structuredClone(legacyTrip), stayPlan: { stays: [structuredClone(storedStay)] }, alerts: [structuredClone(storedAlert)]
});
const ALL = schema.CATEGORIES;
const build = (over = {}) => schema.buildPayload({ documents: documents(), categories: ALL, now: () => Date.UTC(2026, 9, 20), appVersion: '0.14.0', ...over });
const stage = payload => schema.normalizeIncoming(JSON.parse(JSON.stringify(payload)));
const plan = (staged, over = {}) => schema.planRestore({ current: documents(), staged, mode: 'merge', categories: ALL, now: Date.UTC(2026, 9, 21), ...over });

// ---------- crypto ----------
test('encrypt/decrypt round trip with the versioned envelope and no plaintext leakage', async () => {
  const payload = build().payload;
  const envelope = await crypto.encryptBackup(payload, PASSWORD);
  assert.deepEqual(Object.keys(envelope), ['format', 'version', 'kdf', 'cipher', 'ciphertext']);
  assert.equal(envelope.format, 'pointpilot-backup');
  assert.equal(envelope.version, 1);
  assert.deepEqual({ ...envelope.kdf, salt: undefined }, { name: 'scrypt', N: 131072, r: 8, p: 1, salt: undefined });
  assert.equal(Buffer.from(envelope.kdf.salt, 'base64').length, 16);
  assert.equal(Buffer.from(envelope.cipher.iv, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.cipher.tag, 'base64').length, 16);
  const text = JSON.stringify(envelope);
  for (const needle of ['chase', '120000', 'Tokyo', 'BOS']) assert.ok(!text.includes(needle), `${needle} must be inside the ciphertext`);
  assert.deepEqual(await crypto.decryptBackup(envelope, PASSWORD), payload);
});

test('every export uses a fresh salt and IV', async () => {
  const payload = build().payload;
  const a = await crypto.encryptBackup(payload, PASSWORD), b = await crypto.encryptBackup(payload, PASSWORD);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('wrong password and tampering fail with the same error', async () => {
  const envelope = await crypto.encryptBackup({ schemaVersion: 1, hello: 'world' }, PASSWORD);
  const flip = b64 => { const buf = Buffer.from(b64, 'base64'); buf[0] ^= 1; return buf.toString('base64'); };
  const variants = {
    'wrong password': [envelope, 'a completely different password'],
    'salt (header)': [{ ...envelope, kdf: { ...envelope.kdf, salt: flip(envelope.kdf.salt) } }, PASSWORD],
    'iv (header)': [{ ...envelope, cipher: { ...envelope.cipher, iv: flip(envelope.cipher.iv) } }, PASSWORD],
    tag: [{ ...envelope, cipher: { ...envelope.cipher, tag: flip(envelope.cipher.tag) } }, PASSWORD],
    ciphertext: [{ ...envelope, ciphertext: flip(envelope.ciphertext) }, PASSWORD]
  };
  const errors = [];
  for (const [name, [env, pw]] of Object.entries(variants)) {
    const e = await crypto.decryptBackup(env, pw).then(() => null, err => err);
    assert.equal(e?.code, 'BACKUP_DECRYPT_FAILED', name);
    assert.equal(e.status, 400);
    errors.push(e.message);
  }
  assert.equal(new Set(errors).size, 1, 'one message for wrong password and tampering');
  assert.ok(!/password.*wrong$/i.test('') && !errors[0].includes(PASSWORD));
});

test('hostile or malformed envelopes are rejected before any key derivation', async () => {
  const good = await crypto.encryptBackup({ schemaVersion: 1 }, PASSWORD);
  const clone = () => structuredClone(good);
  const cases = {
    'huge N': Object.assign(clone(), { kdf: { ...good.kdf, N: 2 ** 24 } }),
    'zero N': Object.assign(clone(), { kdf: { ...good.kdf, N: 0 } }),
    'big r': Object.assign(clone(), { kdf: { ...good.kdf, r: 64 } }),
    'big p': Object.assign(clone(), { kdf: { ...good.kdf, p: 16 } }),
    'other kdf': Object.assign(clone(), { kdf: { ...good.kdf, name: 'pbkdf2' } }),
    'other cipher': Object.assign(clone(), { cipher: { ...good.cipher, name: 'aes-128-gcm' } }),
    'extra top-level field': { ...clone(), extra: 1 },
    'extra kdf field': Object.assign(clone(), { kdf: { ...good.kdf, maxmem: 1 } }),
    'missing tag': Object.assign(clone(), { cipher: { name: good.cipher.name, iv: good.cipher.iv } }),
    'truncated base64': { ...clone(), ciphertext: good.ciphertext.slice(0, -2) },
    'noncanonical base64 padding': { ...clone(), ciphertext: `${good.ciphertext.slice(0, -2)}A=` === good.ciphertext ? 'AAAA' : good.ciphertext.replace(/=*$/, '') + (good.ciphertext.endsWith('=') ? '' : '=') },
    'urlsafe base64': { ...clone(), ciphertext: 'ab-_' },
    'short salt': Object.assign(clone(), { kdf: { ...good.kdf, salt: Buffer.alloc(8).toString('base64') } }),
    'long iv': Object.assign(clone(), { cipher: { ...good.cipher, iv: Buffer.alloc(16).toString('base64') } }),
    'short tag': Object.assign(clone(), { cipher: { ...good.cipher, tag: Buffer.alloc(8).toString('base64') } }),
    'empty ciphertext': { ...clone(), ciphertext: '' },
    'oversized ciphertext': { ...clone(), ciphertext: Buffer.alloc(crypto.MAX_PLAINTEXT_BYTES + 3).toString('base64') },
    'wrong format': { ...clone(), format: 'something-else' },
    array: [],
    null: null,
    string: 'nope'
  };
  for (const [name, env] of Object.entries(cases)) {
    const started = Date.now();
    const e = await crypto.decryptBackup(env, PASSWORD).then(() => null, err => err);
    assert.ok(e, `${name} must be rejected`);
    assert.equal(e.code, 'BACKUP_INVALID', name);
    assert.ok(Date.now() - started < 150, `${name} must fail before scrypt runs (took ${Date.now() - started}ms)`);
  }
});

test('future or unknown versions are an unsupported-version error', async () => {
  const good = await crypto.encryptBackup({ schemaVersion: 1 }, PASSWORD);
  for (const version of [2, 99]) {
    const e = await crypto.decryptBackup({ ...good, version }, PASSWORD).then(() => null, err => err);
    assert.equal(e.code, 'BACKUP_UNSUPPORTED_VERSION');
  }
  for (const version of [0, -1, 1.5, '1', null]) {
    const e = await crypto.decryptBackup({ ...good, version }, PASSWORD).then(() => null, err => err);
    assert.equal(e.code, 'BACKUP_INVALID', String(version));
  }
});

test('password rules: at least 12 characters, at most 1024 bytes', async () => {
  for (const pw of ['', 'short', '12345678901', undefined, null, 42]) {
    await assert.rejects(crypto.encryptBackup({}, pw), e => e.code === 'PASSWORD_INVALID', String(pw));
  }
  await assert.rejects(crypto.encryptBackup({}, 'x'.repeat(1025)), e => e.code === 'PASSWORD_INVALID');
  await assert.rejects(crypto.encryptBackup({}, 'é'.repeat(600)), e => e.code === 'PASSWORD_INVALID', 'bytes, not characters, are bounded');
  assert.equal(crypto.passwordBuffer('x'.repeat(12)).length, 12);
  assert.equal(crypto.passwordBuffer('🙂'.repeat(12)).length, 48, 'twelve characters, not twelve bytes');
  await assert.rejects(crypto.encryptBackup({}, '🙂'.repeat(11)), e => e.code === 'PASSWORD_INVALID');
});

test('an oversized payload is refused before any key derivation', async () => {
  const started = Date.now();
  await assert.rejects(crypto.encryptBackup({ blob: 'x'.repeat(crypto.MAX_PLAINTEXT_BYTES) }, PASSWORD), e => e.code === 'BACKUP_TOO_LARGE' && e.status === 413);
  assert.ok(Date.now() - started < 500);
});

test('a second concurrent crypto job gets 429 instead of queueing', async () => {
  const first = crypto.encryptBackup({ a: 1 }, PASSWORD);
  const second = await crypto.encryptBackup({ b: 1 }, PASSWORD).then(() => null, e => e);
  assert.equal(second.code, 'BACKUP_BUSY');
  assert.equal(second.status, 429);
  await first; // the first job is unaffected, and the slot is free again
  await crypto.encryptBackup({ c: 1 }, PASSWORD);
});

// ---------- payload: what is exported ----------
test('default export excludes every secret and every runtime field', () => {
  const { payload } = build();
  const text = JSON.stringify(payload);
  for (const canary of Object.values(CANARY)) assert.ok(!text.includes(canary), `${canary} leaked`);
  for (const field of ['seatsAeroApiKey', 'travelpayoutsToken', 'serpApiKey', 'webhookUrl', 'secrets', 'deliveryState', 'pendingDelivery', 'lastResult', 'lastSignature', 'SECRET-RESULT', 'Hint']) assert.ok(!text.includes(field), `${field} must not be exported`);
  assert.equal(payload.includesSecrets, false);
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(payload.categories, ALL);
  assert.equal(payload.documents.user.balances.length, 2);
  assert.equal(payload.documents.alerts[0].active, true, 'the exported flag records what was on');
});

test('secrets are embedded only with the explicit opt-in, and the webhook counts as a secret', () => {
  const { payload } = build({ includeSecrets: true });
  assert.equal(payload.includesSecrets, true);
  assert.deepEqual(payload.documents.settings.secrets, { seatsAeroApiKey: CANARY.seats, travelpayoutsToken: CANARY.tp, serpApiKey: CANARY.serp, webhookUrl: CANARY.hook });
  const only = build({ includeSecrets: true, categories: ['wallet'] });
  assert.ok(!JSON.stringify(only.payload).includes('CANARY'), 'secrets need the settings category');
  assert.equal(only.payload.includesSecrets, false);
  const none = build({ includeSecrets: true, documents: { ...documents(), settings: { monitorIntervalMinutes: 30 } } });
  assert.equal(none.payload.includesSecrets, false, 'nothing to include, nothing claimed');
});

test('categories select what is exported; an empty wallet is exportable', () => {
  const { payload } = build({ categories: ['preferences', 'alerts'] });
  assert.deepEqual(Object.keys(payload.documents).sort(), ['alerts', 'user']);
  assert.deepEqual(Object.keys(payload.documents.user), ['preferences']);
  const empty = schema.buildPayload({ documents: { user: null, settings: null, tripPlan: null, stayPlan: null, alerts: null }, categories: ALL });
  assert.deepEqual(empty.payload.documents.user.balances, []);
  assert.deepEqual(empty.payload.documents.alerts, []);
  assert.equal(empty.payload.documents.tripPlan, undefined, 'an absent plan stays absent');
  assert.throws(() => schema.parseCategories([]), /category/);
  assert.throws(() => schema.parseCategories(['wallet', 'wallet']));
  assert.throws(() => schema.parseCategories(['wallet', 'bogus']));
});

test('export applies the row caps with a clear error', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ program: 'x', code: i % 2 ? 'chase' : 'hyatt', type: 'bank', balance: 1, cpp: 1, transferable: true }));
  assert.throws(() => schema.buildPayload({ documents: { ...documents(), user: { balances: many, preferences: {} } }, categories: ['wallet'] }), e => e.status === 413);
});

// ---------- import validation ----------
test('a good payload round-trips through normalizeIncoming', () => {
  const staged = stage(build({ includeSecrets: true }).payload);
  assert.equal(staged.wallet.length, 2);
  assert.equal(staged.alerts[0].def.active, false, 'imported definitions are inactive');
  assert.equal(staged.alerts[0].wasActive, true);
  assert.equal(staged.secrets.webhookUrl, CANARY.hook);
  assert.equal(staged.tripPlan.schemaVersion, 2, 'legacy plans are migrated, not mutated');
  assert.equal(staged.tripPlan.segments[0].id, 'outbound');
  assert.equal(staged.stayPlan.stays[0].nights, 3);
});

test('future payload/document versions, unknown fields and bad values are rejected with safe messages', () => {
  const base = () => JSON.parse(JSON.stringify(build({ includeSecrets: true }).payload));
  const bad = (mutate, code = 'BACKUP_INVALID') => {
    const p = base(); mutate(p);
    const e = (() => { try { schema.normalizeIncoming(p); return null; } catch (err) { return err; } })();
    assert.ok(e, 'should reject'); assert.equal(e.code, code);
    for (const canary of Object.values(CANARY)) assert.ok(!e.message.includes(canary), 'error text must not echo data');
  };
  bad(p => { p.schemaVersion = 2; }, 'BACKUP_UNSUPPORTED_VERSION');
  bad(p => { p.schemaVersion = 'x'; });
  bad(p => { p.extra = 1; });
  bad(p => { p.documents.extra = 1; });
  bad(p => { p.categories = ['bogus']; });
  bad(p => { p.documents.user.balances[0].code = 'not-a-program'; p.documents.user.balances[0].program = 'Not A Program'; });
  bad(p => { p.documents.user.balances[0].balance = -5; });
  bad(p => { p.documents.user.preferences.mystery = 1; });
  bad(p => { p.documents.settings.values.surprise = 1; });
  bad(p => { p.documents.settings.values.monitorIntervalMinutes = 'soon'; });
  bad(p => { p.documents.settings.secrets.webhookUrl = 'http://insecure.example.test/hook'; });
  bad(p => { p.documents.settings.secrets.unknownSecret = 'x'; });
  bad(p => { p.includesSecrets = false; });
  bad(p => { p.documents.tripPlan.schemaVersion = 3; });
  bad(p => { p.documents.stayPlan.stays[0].bookingUrl = 'http://not-https.example.test'; });
  bad(p => { p.documents.alerts[0].kind = 'mystery'; });
  bad(p => { p.documents.alerts.push({ ...p.documents.alerts[0] }); });
  bad(p => { p.documents.alerts = 'nope'; });
});

test('row caps are enforced on import (200 wallet rows, 500 alerts, 20 stays, 6 legs)', () => {
  const base = () => JSON.parse(JSON.stringify(build().payload));
  let p = base(); p.documents.user.balances = Array.from({ length: 201 }, () => structuredClone(wallet[0]));
  assert.throws(() => schema.normalizeIncoming(p), e => e.status === 413);
  p = base(); p.documents.alerts = Array.from({ length: 501 }, (_, i) => ({ ...storedAlert, id: `a${i}` }));
  assert.throws(() => schema.normalizeIncoming(p), e => e.status === 413);
  p = base(); p.documents.stayPlan.stays = Array.from({ length: 21 }, (_, i) => ({ ...storedStay, id: `s${i}` }));
  assert.throws(() => schema.normalizeIncoming(p), e => e.code === 'BACKUP_INVALID' || e.status === 413);
});

test('duplicate balances are summed with checked addition; conflicting valuations and overflow are rejected', () => {
  const p = JSON.parse(JSON.stringify(build().payload));
  p.documents.user.balances = [{ ...wallet[0], balance: 100 }, { ...wallet[0], balance: 250 }];
  assert.deepEqual(schema.normalizeIncoming(p).wallet.map(r => [r.code, r.balance]), [['chase', 350]]);
  p.documents.user.balances = [{ ...wallet[0], balance: 100 }, { ...wallet[0], balance: 100, cpp: 2.5 }];
  assert.throws(() => schema.normalizeIncoming(p), /different values per point/);
  p.documents.user.balances = [{ ...wallet[0], balance: Number.MAX_SAFE_INTEGER }, { ...wallet[0], balance: 1 }];
  assert.throws(() => schema.normalizeIncoming(p), /too large/);
});

// ---------- merge / replace planning ----------
test('merge keeps existing values by default, never sums, and is idempotent', () => {
  const incoming = build().payload;
  incoming.documents.user.balances[0].balance = 5; // differs from the wallet on this installation
  const staged = stage(incoming);
  const first = plan(staged);
  assert.equal(first.conflicts.find(c => c.id === 'wallet:chase').resolution, 'keep');
  assert.equal(first.after.user, undefined, 'keeping everything changes nothing');
  assert.ok(!first.after.user?.balances?.some(b => b.balance === 120005));

  const chosen = plan(staged, { choices: { 'wallet:chase': 'incoming' } });
  assert.equal(chosen.after.user.balances.find(b => b.code === 'chase').balance, 5, 'replaced, not 120000 + 5');
  // Apply the result, then merge the same backup again: nothing left to do for that row.
  const afterDocs = { ...documents(), user: chosen.after.user };
  const again = schema.planRestore({ current: afterDocs, staged, mode: 'merge', categories: ['wallet'], choices: {}, now: 1 });
  assert.equal(again.conflicts.length, 0);
  assert.deepEqual(again.after, {});
});

test('merging a backup into the installation it came from changes nothing', () => {
  const staged = stage(build({ includeSecrets: true }).payload);
  const result = plan(staged, { options: { restoreSecrets: true } });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.after, {}, JSON.stringify(result.effects));
  assert.match(result.effects.at(-1).text, /Nothing would change/);
});

test('merge adds only what is missing and reports concrete effects', () => {
  const staged = stage(build().payload);
  const current = { ...documents(), user: { balances: [wallet[0]], preferences: {} }, alerts: [], stayPlan: null, tripPlan: null, settings: {} };
  const r = plan(staged, { current });
  assert.equal(r.after.user.balances.length, 2);
  assert.deepEqual(r.after.user.preferences, { defaultCpp: 1.5, maxTransfers: 2, preferNonstop: false });
  assert.equal(r.after.alerts.length, 1);
  assert.equal(r.after.alerts[0].active, false, 'imported alerts start inactive');
  assert.equal(r.after.alerts[0].lastResult, null);
  assert.equal(r.after.alerts[0].deliveryState, undefined);
  assert.equal(r.after.tripPlan.revision, 1);
  assert.equal(r.after.stayPlan.stays.length, 1);
  assert.ok(r.after.settings.monitorIntervalMinutes === 45);
  assert.ok(!('seatsAeroApiKey' in r.after.settings), 'no secrets without the opt-in');
  assert.ok(r.effects.length >= 4 && r.effects.every(e => typeof e.text === 'string' && e.category));
  assert.equal(r.counts.wallet.add, 1);
});

test('launchAtLogin is only enabled with its explicit flag', () => {
  const staged = stage(build().payload);
  const current = { ...documents(), settings: { launchAtLogin: false, monitorIntervalMinutes: 45, desktopNotifications: false, closeToTray: true, homeAirports: 'BOS,JFK', apiRefreshMinutes: 60 } };
  const off = plan(staged, { current, categories: ['settings'] });
  assert.equal(off.after.settings, undefined);
  assert.ok(off.effects.some(e => /Start with Windows stays/.test(e.text)));
  const on = plan(staged, { current, categories: ['settings'], choices: { 'settings:launchAtLogin': 'incoming' }, options: { enableLaunchAtLogin: true } });
  assert.equal(on.after.settings.launchAtLogin, true);
  assert.equal(on.sensitive.launchAtLoginEnabled, true);
});

test('secrets are ignored without the restore opt-in and never overwrite silently', () => {
  const staged = stage(build({ includeSecrets: true }).payload);
  const current = { ...documents(), settings: { seatsAeroApiKey: 'LOCAL-key-1', webhookUrl: 'https://local.example.test/h', monitorIntervalMinutes: 45 } };
  const without = plan(staged, { current, categories: ['settings'], mode: 'replace' });
  assert.ok(without.warnings.some(w => /will not be restored/.test(w)));
  assert.equal(without.after.settings.seatsAeroApiKey, 'LOCAL-key-1', 'replace still preserves local credentials');
  assert.equal(without.after.settings.webhookUrl, 'https://local.example.test/h');
  const withOpt = plan(staged, { current, categories: ['settings'], options: { restoreSecrets: true } });
  const secretConflict = withOpt.conflicts.find(c => c.id === 'settings:seatsAeroApiKey');
  assert.ok(secretConflict && secretConflict.sensitive);
  assert.ok(!JSON.stringify(withOpt.conflicts).includes('LOCAL-key-1') && !JSON.stringify(withOpt.conflicts).includes(CANARY.seats), 'conflicts never carry key material');
  assert.equal(withOpt.after.settings?.seatsAeroApiKey ?? 'LOCAL-key-1', 'LOCAL-key-1', 'default choice keeps the local key');
  assert.equal(withOpt.after.settings.travelpayoutsToken, CANARY.tp, 'a missing local key is filled in');
  const replaced = plan(staged, { current, categories: ['settings'], mode: 'replace', options: { restoreSecrets: true } });
  assert.equal(replaced.after.settings.seatsAeroApiKey, CANARY.seats);
  assert.equal(replaced.sensitive.webhookChanged, true);
  assert.ok(replaced.effects.some(e => e.sensitive && /webhook/.test(e.text)));
  assert.ok(!JSON.stringify(replaced.effects).includes('CANARY'), 'effects name the setting, never its value');
});

test('replace only touches the selected categories', () => {
  const staged = stage(build().payload);
  const current = { ...documents(), user: { balances: [{ program: 'American AAdvantage', code: 'american', type: 'airline', balance: 5000, cpp: 1.5, transferable: false }], preferences: { defaultCpp: 9 } }, alerts: [{ ...storedAlert, id: 'keepme' }] };
  const r = plan(staged, { current, mode: 'replace', categories: ['wallet'] });
  assert.deepEqual(Object.keys(r.after), ['user']);
  assert.deepEqual(r.after.user.balances.map(b => b.code).sort(), ['chase', 'hyatt']);
  assert.deepEqual(r.after.user.preferences, { defaultCpp: 9 }, 'preferences were not selected');
  assert.equal(r.counts.wallet.remove, 1);
  assert.ok(r.effects.some(e => /removed/.test(e.text)), 'replace names what disappears');
  const alerts = plan(staged, { current, mode: 'replace', categories: ['alerts'] });
  assert.deepEqual(alerts.after.alerts.map(a => a.id), ['al1']);
  assert.ok(alerts.effects.some(e => /Replace your 1 alert/.test(e.text)));
});

test('a category the file does not contain is skipped with a warning', () => {
  const staged = stage(build({ categories: ['wallet'] }).payload);
  const r = plan(staged, { categories: ['wallet', 'alerts'] });
  assert.ok(r.warnings.some(w => /does not include alerts/.test(w)));
});

test('imported alerts only turn on when explicitly requested', () => {
  const staged = stage(build().payload);
  const current = { ...documents(), alerts: [] };
  assert.equal(plan(staged, { current, categories: ['alerts'] }).after.alerts[0].active, false);
  const on = plan(staged, { current, categories: ['alerts'], options: { activateImportedAlerts: true } });
  assert.equal(on.after.alerts[0].active, true);
  assert.equal(on.sensitive.alertsActivated, 1);
  assert.ok(on.effects.some(e => e.sensitive && /turned on/.test(e.text)));
});

test('alert conflicts offer keep/incoming/both and "both" generates a local id', () => {
  const incoming = build().payload;
  incoming.documents.alerts[0].maxPointsPerTraveler = 50000;
  const staged = stage(incoming);
  const r = plan(staged, { categories: ['alerts'] });
  const c = r.conflicts.find(x => x.id === 'alerts:al1');
  assert.deepEqual(c.actionOptions, ['keep', 'incoming', 'both']);
  const both = plan(staged, { categories: ['alerts'], choices: { 'alerts:al1': 'both' }, newId: () => 'fresh1' });
  assert.deepEqual(both.after.alerts.map(a => a.id), ['al1', 'fresh1']);
  const differing = build().payload; differing.documents.user.balances[0].balance = 7;
  assert.throws(() => plan(stage(differing), { categories: ['wallet'], choices: { 'wallet:chase': 'both' } }), /choice/, 'both is only for alerts');
  assert.throws(() => plan(staged, { categories: ['wallet'], choices: { 'wallet:nonexistent': 'keep' } }), /does not match any conflict/);
  // A duplicate under a different id is recognized by content and skipped.
  const dup = build().payload; dup.documents.alerts[0].id = 'other-id';
  const r2 = plan(stage(dup), { categories: ['alerts'] });
  assert.deepEqual(r2.after, {});
});

test('stays merge by id and fingerprint with the 20-stay cap; the single trip is keep-or-replace', () => {
  const incoming = build().payload;
  incoming.documents.stayPlan.stays.push({ ...storedStay, id: 'stay2', name: 'Another', checkIn: '2027-07-01', checkOut: '2027-07-03' });
  const staged = stage(incoming);
  const r = plan(staged, { categories: ['plans'] });
  assert.equal(r.after.stayPlan.stays.length, 2, 'the duplicate is a no-op, the new stay is added');
  assert.equal(r.after.tripPlan, undefined, 'identical trips are not rewritten');
  // Same id, different content -> conflict.
  const changed = build().payload; changed.documents.stayPlan.stays[0].nightlyPoints = 30000;
  const c = plan(stage(changed), { categories: ['plans'] });
  assert.ok(c.conflicts.some(x => x.id === 'plans:stay:stay1'));
  // Cap.
  const full = { ...documents(), stayPlan: { stays: Array.from({ length: 20 }, (_, i) => ({ ...storedStay, id: `f${i}`, checkIn: '2028-01-01', checkOut: '2028-01-02', nightlyPoints: 1000 + i })) } };
  const capped = plan(staged, { current: full, categories: ['plans'] });
  assert.equal(capped.after.stayPlan, undefined);
  assert.ok(capped.warnings.some(w => /at most 20/.test(w)));
  // Trip conflict.
  const otherTrip = build().payload;
  otherTrip.documents.tripPlan = normalizeTripPlan({ ...legacyTrip, travelers: 4 });
  const t = plan(stage(otherTrip), { categories: ['plans'] });
  assert.ok(t.conflicts.some(x => x.id === 'plans:tripPlan'));
  const takeIncoming = plan(stage(otherTrip), { categories: ['plans'], choices: { 'plans:tripPlan': 'incoming' } });
  assert.equal(takeIncoming.after.tripPlan.travelers, 4);
  assert.equal(takeIncoming.after.tripPlan.revision, 1);
});

test('imported plans are normalized by the owner modules, not copied verbatim', () => {
  const staged = stage(build().payload);
  assert.deepEqual(normalizeTripPlan(staged.tripPlan), staged.tripPlan, 'normalization is idempotent');
  assert.deepEqual(normalizeStayPlan(staged.stayPlan), staged.stayPlan);
});

test('planning never mutates its inputs (preview must not write)', () => {
  const current = documents(); const before = JSON.stringify(current);
  const staged = stage(build({ includeSecrets: true }).payload); const stagedBefore = JSON.stringify(staged);
  plan(staged, { current, mode: 'replace', options: { restoreSecrets: true, activateImportedAlerts: true, enableLaunchAtLogin: true } });
  plan(staged, { current });
  assert.equal(JSON.stringify(current), before);
  assert.equal(JSON.stringify(staged), stagedBefore);
});

test('O2 stay occupancy fields travel through backup; room allocation does not change stay identity', () => {
  const extras = s => Object.fromEntries(['occupancySchemaVersion', 'rooms', 'inventoryStatus', 'occupancyStatus', 'programEvidence'].filter(k => s[k] !== undefined).map(k => [k, structuredClone(s[k])]));
  // Stand-in for the owner's v2 normalizer: the real v1 rules plus the new fields passed through untouched.
  const v2 = {
    ...schema.defaultValidators,
    normalizeStayPlan: (doc, options) => {
      const core = normalizeStayPlan({ ...doc, schemaVersion: undefined, stays: doc.stays.map(s => { const c = { ...s }; for (const k of Object.keys(extras(s))) delete c[k]; return c; }) }, options);
      return { ...core, schemaVersion: 2, stays: core.stays.map((s, i) => ({ ...s, ...extras(doc.stays[i]) })) };
    }
  };
  const evidence = { taxes: { amount: 35, source: 'agent chat', date: '2026-10-21', currency: 'USD' }, cancellation: { text: 'Free until <b>June 1</b>', source: 'hotel page', date: '2026-10-21', currency: null } };
  const rooms = [{ adults: 2, childrenAges: [7], roomType: 'standard' }, { adults: 1, childrenAges: [], roomType: 'suite' }];
  const withRooms = { ...storedStay, totalPoints: 150000, estimated: true, occupancySchemaVersion: 1, rooms, inventoryStatus: 'unknown', occupancyStatus: 'unverified', programEvidence: evidence };
  const docs = { ...documents(), stayPlan: { schemaVersion: 2, revision: 3, stays: [withRooms] }, alerts: [], tripPlan: null };
  const { payload } = schema.buildPayload({ documents: docs, categories: ['plans'], validators: v2 });
  assert.deepEqual(payload.documents.stayPlan.stays[0].rooms, rooms);
  assert.deepEqual(payload.documents.stayPlan.stays[0].programEvidence, evidence);
  const staged = schema.normalizeIncoming(JSON.parse(JSON.stringify(payload)), { validators: v2 });
  assert.equal(staged.stayPlan.schemaVersion, 2);
  assert.deepEqual(staged.stayPlan.stays[0].rooms, rooms);

  const empty = { ...documents(), stayPlan: null, tripPlan: null, alerts: [] };
  const merged = schema.planRestore({ current: empty, staged, mode: 'merge', categories: ['plans'], validators: v2 });
  assert.equal(merged.after.stayPlan.schemaVersion, 2, 'a restored v2 plan is not saved as v1');
  assert.deepEqual(merged.after.stayPlan.stays[0].programEvidence, evidence);

  // Same stay identity but a different room allocation (or different user-entered details): a conflict the user decides, never "unchanged".
  const reallocated = { ...docs, stayPlan: { schemaVersion: 2, revision: 3, stays: [{ ...withRooms, rooms: [rooms[0]] }] } };
  const again = schema.planRestore({ current: reallocated, staged, mode: 'merge', categories: ['plans'], validators: v2 });
  assert.deepEqual(again.conflicts.map(c => c.id), [`plans:stay:${storedStay.id}`], '#9 a changed allocation is a conflict');
  assert.match(again.conflicts[0].existing, /1 room/);
  assert.match(again.conflicts[0].incoming, /2 rooms/);
  assert.deepEqual(again.after, {}, 'keep-mine is the default: nothing changes until the user picks');
  const taken = schema.planRestore({ current: reallocated, staged, mode: 'merge', categories: ['plans'], choices: { [`plans:stay:${storedStay.id}`]: 'incoming' }, validators: v2 });
  assert.deepEqual(taken.after.stayPlan.stays[0].rooms, rooms);
  // Different user-entered details alone are a conflict too.
  const noEvidence = { ...docs, stayPlan: { schemaVersion: 2, revision: 3, stays: [{ ...withRooms, programEvidence: null }] } };
  assert.equal(schema.planRestore({ current: noEvidence, staged, mode: 'merge', categories: ['plans'], validators: v2 }).conflicts.length, 1);
  // A v1 current plan receiving v2 stays is upgraded, never downgraded.
  const v1Current = { ...empty, stayPlan: { schemaVersion: 1, revision: 1, stays: [] } };
  assert.equal(schema.planRestore({ current: v1Current, staged, mode: 'merge', categories: ['plans'], validators: v2 }).after.stayPlan.schemaVersion, 2);
});

test('O2 stay schema v2 (real normalizer): rooms and user-entered evidence survive export, restore and self-merge', async () => {
  const { addStay, getPlan } = await import('../lib/stayplan.mjs');
  const rooms = [{ adults: 2, childrenAges: [7], roomType: 'standard' }, { adults: 1, childrenAges: [], roomType: 'suite' }];
  const programEvidence = { taxes: { amount: 35, source: 'agent chat', date: '2026-10-21', currency: 'USD' }, cancellation: { text: 'Free until <b>June 1</b>', source: 'hotel page', date: '2026-10-21', currency: null } };
  await addStay({ name: 'Park Hyatt', hotelId: 'h1', program: 'hyatt', checkIn: '2027-06-05', checkOut: '2027-06-08', nightlyPoints: 25000, totalPoints: 150000, estimated: true, rooms, occupancySchemaVersion: 1, inventoryStatus: 'unknown', occupancyStatus: 'unverified', programEvidence });
  const plan = await getPlan();
  const docs = { user: null, settings: null, tripPlan: null, alerts: [], stayPlan: { schemaVersion: plan.schemaVersion, revision: plan.revision, stays: plan.stays } };
  assert.equal(plan.schemaVersion, 2);
  const { payload } = schema.buildPayload({ documents: docs, categories: ['plans'] });
  assert.deepEqual(payload.documents.stayPlan.stays[0].rooms, rooms);
  assert.deepEqual(payload.documents.stayPlan.stays[0].programEvidence, programEvidence);
  const staged = schema.normalizeIncoming(JSON.parse(JSON.stringify(payload)));
  const restored = schema.planRestore({ current: { ...docs, stayPlan: null }, staged, mode: 'merge', categories: ['plans'] });
  assert.equal(restored.after.stayPlan.schemaVersion, 2);
  assert.deepEqual(restored.after.stayPlan.stays[0].rooms, rooms);
  const again = schema.planRestore({ current: docs, staged, mode: 'merge', categories: ['plans'] });
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(again.after, {}, 'restoring a backup into the installation it came from changes nothing');
  // A backup made before occupancy existed still restores, and gains the one-room default.
  const legacy = { schemaVersion: 1, revision: 0, stays: [{ id: 'old1', name: 'Old Stay', program: 'hyatt', checkIn: '2027-07-01', checkOut: '2027-07-03', nightlyPoints: 20000 }] };
  const legacyPayload = schema.buildPayload({ documents: { ...docs, stayPlan: legacy }, categories: ['plans'] }).payload;
  const old = schema.normalizeIncoming(JSON.parse(JSON.stringify(legacyPayload)));
  assert.deepEqual(old.stayPlan.stays[0].rooms, [{ adults: 2, childrenAges: [], roomType: 'standard' }]);
  // Bad occupancy in a backup file is rejected with a safe message.
  const bad = JSON.parse(JSON.stringify(payload));
  bad.documents.stayPlan.stays[0].rooms = Array.from({ length: 5 }, () => rooms[0]);
  assert.throws(() => schema.normalizeIncoming(bad), e => e.code === 'BACKUP_INVALID' && !/Hyatt/.test(e.message));
});

test('hotel alerts keep their bounded room allocation through backup and restore', () => {
  const rooms = [{ adults: 2, childrenAges: [7], roomType: 'standard' }, { adults: 1, childrenAges: [], roomType: 'suite' }];
  const hotelAlert = { id: 'h1', kind: 'hotel', active: true, createdAt: '2026-10-01T00:00:00.000Z', title: 'Bangkok hotel', query: { destination: 'Bangkok', checkIn: '2027-06-05', checkOut: null, flexDays: 0, roomType: 'suite', maxPointsPerNight: 40000, rooms }, maxPointsPerNight: 40000, minCpp: 0 };
  const docs = { ...documents(), alerts: [hotelAlert] };
  const { payload } = schema.buildPayload({ documents: docs, categories: ['alerts'] });
  assert.deepEqual(payload.documents.alerts[0].query.rooms, rooms);
  const staged = schema.normalizeIncoming(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(staged.alerts[0].def.query.rooms, rooms);
  const restored = schema.planRestore({ current: { ...docs, alerts: [] }, staged, mode: 'merge', categories: ['alerts'] });
  assert.deepEqual(restored.after.alerts[0].query.rooms, rooms);
  assert.equal(restored.after.alerts[0].active, false);
  assert.deepEqual(schema.planRestore({ current: docs, staged, mode: 'merge', categories: ['alerts'] }).conflicts, [], 'self-merge is unchanged');
  // Same alert id, different allocation: a conflict.
  const changed = JSON.parse(JSON.stringify(payload));
  changed.documents.alerts[0].query.rooms = [rooms[0]];
  assert.equal(schema.planRestore({ current: docs, staged: schema.normalizeIncoming(changed), mode: 'merge', categories: ['alerts'] }).conflicts.length, 1);
  // Out-of-bounds allocations in a file are refused.
  for (const bad of [[], Array.from({ length: 5 }, () => rooms[0]), [{ adults: 9, childrenAges: [], roomType: 'any' }], [{ adults: 2, childrenAges: [18], roomType: 'any' }], [{ adults: 2, childrenAges: [1, 1, 1, 1, 1, 1, 1], roomType: 'any' }], [{ adults: 2, childrenAges: [], roomType: 'penthouse' }], [{ adults: 2, childrenAges: [], roomType: 'any', extra: 1 }], 'two rooms']) {
    const p = JSON.parse(JSON.stringify(payload));
    p.documents.alerts[0].query.rooms = bad;
    assert.throws(() => schema.normalizeIncoming(p), e => e.code === 'BACKUP_INVALID', JSON.stringify(bad));
  }
});
