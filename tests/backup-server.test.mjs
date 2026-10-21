import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-backup-server-'));
process.env.POINTPILOT_DATA_DIR = dir;
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
const { startServer } = await import('../server.mjs');
const { writeJson, readJson, documentPath, clearStoreCache } = await import('../lib/store.mjs');
const { decryptBackup } = await import('../lib/backup.mjs');
const { createBackupService, PREVIEW_TTL_MS } = await import('../lib/backup-routes.mjs');
const { TransactionError, snapshotDocuments } = await import('../lib/store-transaction.mjs');

const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const PASSWORD = 'a long synthetic backup password';
const CANARY = { seats: 'CANARY-seats-key-9001', tp: 'CANARY-tp-token-9002', serp: 'CANARY-serp-key-9003', hook: 'https://hooks.example.test/services/CANARY-webhook-9004' };
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const json = async (p, body) => { const r = await post(p, body); return { status: r.status, body: await r.json() }; };
const ALL = ['wallet', 'preferences', 'settings', 'plans', 'alerts'];

const wallet = [
  { program: 'Chase Ultimate Rewards', code: 'chase', type: 'bank', balance: 120000, cpp: 1.7, transferable: true },
  { program: 'World of Hyatt', code: 'hyatt', type: 'hotel', balance: 30000, cpp: 1.8, transferable: false }
];
const alertDoc = id => ({
  id, kind: 'award', active: true, createdAt: '2026-10-01T00:00:00.000Z', title: `Alert ${id}`,
  query: { origins: 'JFK', destination: 'Tokyo', departDate: '2027-05-01', returnDate: null, flexDays: 3, cabin: 'business', travelers: 2, nonstopOnly: false },
  maxPointsPerTraveler: 90000, minCpp: 1.5, track: null, lastStatus: 'ok', lastResult: { matches: [{ title: 'RUNTIME-STATE' }] }, deliveryState: { webhook: { target: CANARY.hook } }
});

async function seed({ walletRows = wallet, alerts = [alertDoc('al1')], settings = { seatsAeroApiKey: CANARY.seats, travelpayoutsToken: CANARY.tp, serpApiKey: CANARY.serp, webhookUrl: CANARY.hook, monitorIntervalMinutes: 45, homeAirports: 'BOS' }, stays = [{ id: 'stay1', name: 'Park Hyatt', program: 'hyatt', checkIn: '2027-06-05', checkOut: '2027-06-08', nightlyPoints: 25000 }] } = {}) {
  await writeJson(documentPath('user'), { balances: walletRows, preferences: { defaultCpp: 1.5 } });
  await writeJson(documentPath('settings'), settings);
  await writeJson(documentPath('alerts'), alerts);
  await writeJson(documentPath('stayPlan'), { stays });
}
const current = async () => (await snapshotDocuments()).documents;

test('export refuses foreign origins, non-JSON, unknown fields and weak passwords', async () => {
  await seed();
  assert.equal((await post('/api/backup/export', { password: PASSWORD, categories: ALL }, { origin: 'https://evil.example' })).status, 403);
  const text = await fetch(base + '/api/backup/export', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(text.status, 403);
  assert.equal((await json('/api/backup/export', { password: PASSWORD, categories: ALL, path: 'C:/x' })).status, 400, 'no path argument exists');
  const weak = await json('/api/backup/export', { password: 'short', categories: ALL });
  assert.equal(weak.status, 400); assert.equal(weak.body.code, 'PASSWORD_INVALID');
  assert.equal((await json('/api/backup/export', { password: PASSWORD, categories: [] })).status, 400);
  assert.equal((await json('/api/backup/export', { password: PASSWORD, categories: ALL, includeSecrets: 'yes' })).status, 400);
  assert.equal((await json('/api/backup/export', [1, 2])).status, 400);
});

test('default export is encrypted, excludes secrets, and the response carries no plaintext', async () => {
  await seed();
  const { status, body } = await json('/api/backup/export', { password: PASSWORD, categories: ALL });
  assert.equal(status, 200);
  assert.match(body.filename, /^pointpilot-backup-\d{4}-\d{2}-\d{2}\.ppbackup$/);
  assert.equal(body.includesSecrets, false);
  assert.deepEqual(body.counts.wallet, 2);
  const text = JSON.stringify(body);
  for (const needle of [...Object.values(CANARY), 'chase', 'Tokyo', 'RUNTIME-STATE']) assert.ok(!text.includes(needle), `${needle} appeared in the export response`);
  const payload = await decryptBackup(body.envelope, PASSWORD);
  assert.equal(payload.includesSecrets, false);
  assert.ok(!JSON.stringify(payload).includes('CANARY'));
  assert.ok(!JSON.stringify(payload).includes('RUNTIME-STATE'));
});

test('secrets are exported only with the opt-in', async () => {
  await seed();
  const { body } = await json('/api/backup/export', { password: PASSWORD, categories: ALL, includeSecrets: true });
  assert.equal(body.includesSecrets, true);
  const payload = await decryptBackup(body.envelope, PASSWORD);
  assert.equal(payload.documents.settings.secrets.seatsAeroApiKey, CANARY.seats);
  assert.equal(payload.documents.settings.secrets.webhookUrl, CANARY.hook);
  assert.ok(!JSON.stringify(body.envelope).includes('CANARY'));
});

test('summary returns counts only', async () => {
  await seed();
  const r = await (await fetch(base + '/api/backup/summary')).json();
  assert.equal(r.counts.wallet, 2); assert.equal(r.counts.alerts, 1); assert.equal(r.counts.savedStays, 1);
  assert.equal(r.secretsPresent, true);
  assert.ok(!JSON.stringify(r).includes('CANARY'));
});

async function exportEnvelope(opts = {}) {
  const { body } = await json('/api/backup/export', { password: PASSWORD, categories: ALL, ...opts });
  return body.envelope;
}

test('preview writes nothing, echoes no secrets, and reports wrong password and tampering identically', async () => {
  await seed();
  const envelope = await exportEnvelope({ includeSecrets: true });
  await seed({ walletRows: [wallet[0]], alerts: [], settings: { seatsAeroApiKey: 'LOCAL-key-77' } });
  const before = JSON.stringify(await current());
  const ok = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'merge', categories: ALL });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.containsSecrets, true);
  assert.equal(ok.body.counts.wallet.add, 1);
  assert.ok(ok.body.previewId.length >= 43, '256-bit id');
  const text = JSON.stringify(ok.body);
  for (const secret of [...Object.values(CANARY), 'LOCAL-key-77']) assert.ok(!text.includes(secret), 'preview must not echo secrets');
  assert.equal(JSON.stringify(await current()), before, 'preview must not write');
  assert.equal(existsSync(path.join(dir, 'restore-journal.json')), false);

  const wrong = await json('/api/backup/preview', { password: 'not the right password!!', envelope, mode: 'merge', categories: ALL });
  assert.equal(wrong.status, 400); assert.equal(wrong.body.code, 'BACKUP_DECRYPT_FAILED');
  const tampered = structuredClone(envelope); tampered.ciphertext = Buffer.from(tampered.ciphertext, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b)).toString('base64');
  const t = await json('/api/backup/preview', { password: PASSWORD, envelope: tampered, mode: 'merge', categories: ALL });
  assert.equal(t.status, 400); assert.equal(t.body.error, wrong.body.error);
  for (const r of [wrong, t]) assert.ok(!JSON.stringify(r.body).includes(PASSWORD));
  const future = await json('/api/backup/preview', { password: PASSWORD, envelope: { ...envelope, version: 7 }, mode: 'merge', categories: ALL });
  assert.equal(future.body.code, 'BACKUP_UNSUPPORTED_VERSION');
  const garbage = await json('/api/backup/preview', { password: PASSWORD, envelope: { hello: 1 }, mode: 'merge', categories: ALL });
  assert.equal(garbage.body.code, 'BACKUP_INVALID');
  assert.equal((await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'sideways', categories: ALL })).status, 400);
  assert.equal((await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'merge', categories: ALL, choices: { x: 'maybe' } })).status, 400);
  assert.equal((await json('/api/backup/preview', { envelope, mode: 'merge', categories: ALL })).status, 400, 'password required');
});

test('merge restore: keeps existing, adds missing, imported alerts inactive, secrets ignored without opt-in', async () => {
  await seed();
  const envelope = await exportEnvelope({ includeSecrets: true });
  await seed({ walletRows: [{ ...wallet[0], balance: 5 }], alerts: [], settings: { seatsAeroApiKey: 'LOCAL-key-77', monitorIntervalMinutes: 30 }, stays: [] });
  const prev = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'merge', categories: ALL });
  assert.ok(prev.body.conflicts.some(c => c.id === 'wallet:chase' && c.resolution === 'keep'));
  const done = await json('/api/backup/restore', { previewId: prev.body.previewId, restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ok, true);
  assert.ok(done.body.appliedCounts.wallet >= 1);
  const docs = await current();
  assert.equal(docs.user.balances.find(b => b.code === 'chase').balance, 5, 'existing value kept, not summed');
  assert.ok(docs.user.balances.some(b => b.code === 'hyatt'));
  assert.equal(docs.alerts.length, 1);
  assert.equal(docs.alerts[0].active, false);
  assert.equal(docs.alerts[0].lastResult, null);
  assert.equal(docs.settings.seatsAeroApiKey, 'LOCAL-key-77', 'local credentials survive');
  assert.equal(docs.settings.webhookUrl, undefined);
  assert.equal(docs.settings.monitorIntervalMinutes, 30, 'merge keeps the existing setting');
  assert.equal(docs.stayPlan.stays.length, 1);
  assert.equal(existsSync(path.join(dir, 'restore-journal.json')), false);
  // The restored data is what the rest of the API now serves.
  const user = await (await fetch(base + '/api/user')).json();
  assert.equal(user.balances.length, 2);
  const settings = await (await fetch(base + '/api/settings')).json();
  assert.equal(settings.seatsAeroApiKeySet, true);
  // A preview id works once.
  const replay = await json('/api/backup/restore', { previewId: prev.body.previewId, restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false });
  assert.equal(replay.status, 409); assert.equal(replay.body.code, 'PREVIEW_EXPIRED');
});

test('replace restore with explicit opt-ins overwrites only the selected categories', async () => {
  await seed();
  const envelope = await exportEnvelope({ includeSecrets: true });
  await seed({ walletRows: [{ program: 'American AAdvantage', code: 'american', type: 'airline', balance: 5, cpp: 1.5, transferable: false }], alerts: [alertDoc('keepme')], settings: { seatsAeroApiKey: 'LOCAL-key-77', monitorIntervalMinutes: 30 } });
  const options = { restoreSecrets: true, activateImportedAlerts: false, enableLaunchAtLogin: false };
  const prev = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'replace', categories: ['wallet', 'settings'], options });
  assert.ok(prev.body.effects.some(e => e.sensitive), 'secret overwrites are named');
  assert.equal(prev.body.counts.wallet.remove, 1);
  // Flags must match the review.
  const mismatch = await json('/api/backup/restore', { previewId: prev.body.previewId, restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'PREVIEW_OPTIONS_CHANGED');
  const prev2 = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'replace', categories: ['wallet', 'settings'], options });
  const done = await json('/api/backup/restore', { previewId: prev2.body.previewId, ...options });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const docs = await current();
  assert.deepEqual(docs.user.balances.map(b => b.code).sort(), ['chase', 'hyatt']);
  assert.equal(docs.settings.seatsAeroApiKey, CANARY.seats);
  assert.equal(docs.settings.webhookUrl, CANARY.hook);
  assert.deepEqual(docs.alerts.map(a => a.id), ['keepme'], 'alerts were not selected');
});

test('re-previewing from a staged preview needs no password and retires the old id', async () => {
  await seed();
  const envelope = await exportEnvelope();
  await seed({ walletRows: [{ ...wallet[0], balance: 5 }] });
  const first = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'merge', categories: ['wallet'] });
  const second = await json('/api/backup/preview', { previewId: first.body.previewId, mode: 'merge', categories: ['wallet'], choices: { 'wallet:chase': 'incoming' } });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.previewId, first.body.previewId);
  assert.equal((await json('/api/backup/restore', { previewId: first.body.previewId })).status, 409, 'the earlier id is invalidated');
  assert.equal((await json('/api/backup/preview', { previewId: first.body.previewId, mode: 'merge', categories: ['wallet'] })).body.code, 'PREVIEW_EXPIRED');
  const done = await json('/api/backup/restore', { previewId: second.body.previewId });
  assert.equal(done.status, 200);
  assert.equal((await current()).user.balances.find(b => b.code === 'chase').balance, 120000, 'the incoming choice was applied');
  assert.equal((await json('/api/backup/preview', { previewId: 'x'.repeat(43), password: PASSWORD, mode: 'merge', categories: ['wallet'] })).status, 400);
});

test('a change to participating data after the preview makes the restore fail with 409 and write nothing', async () => {
  await seed();
  const envelope = await exportEnvelope();
  await seed({ walletRows: [wallet[0]], alerts: [] });
  const prev = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'merge', categories: ALL });
  await fetch(base + '/api/user', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ balances: [{ program: 'Citi ThankYou', balance: 9 }], preferences: {} }) });
  const before = JSON.stringify(await current());
  const done = await json('/api/backup/restore', { previewId: prev.body.previewId });
  assert.equal(done.status, 409); assert.equal(done.body.code, 'PREVIEW_STALE');
  assert.equal(JSON.stringify(await current()), before);
});

test('unrelated activity does not make a wallet-only preview stale', async () => {
  await seed();
  const envelope = await exportEnvelope();
  await seed({ walletRows: [], alerts: [] });
  const prev = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'merge', categories: ['wallet'] });
  await writeJson(documentPath('alerts'), [alertDoc('monitor-touched')]); // e.g. a monitor run updating alerts.json
  const done = await json('/api/backup/restore', { previewId: prev.body.previewId });
  assert.equal(done.status, 200);
});

test('route-specific size limits answer 413 before parsing', async () => {
  const big = 'x'.repeat(1.2 * 1024 * 1024);
  const r = await post('/api/backup/export', { password: PASSWORD, categories: ALL, pad: big });
  assert.equal(r.status, 413);
  const huge = await fetch(base + '/api/backup/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(20 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
});

test('unknown backup routes are 404 and GET on a POST route is not served', async () => {
  assert.equal((await fetch(base + '/api/backup/nope')).status, 404);
  assert.equal((await fetch(base + '/api/backup/export')).status, 404);
});

// ---------- service-level: clock, limits, monitor quiescence, failures ----------
function fixtureService(over = {}) {
  let t = 1_000_000;
  const calls = [];
  const service = createBackupService({
    now: () => t, appVersion: 'test',
    withMonitorPaused: async fn => { calls.push('pause'); try { return await fn(); } finally { calls.push('resume'); } },
    ...over
  });
  return { service, calls, advance: ms => { t += ms; } };
}

test('previews expire after five minutes, are limited to two, and restore pauses the monitor', async () => {
  await seed();
  const envelope = await exportEnvelope();
  const { service, calls, advance } = fixtureService();
  const body = { password: PASSWORD, envelope, mode: 'merge', categories: ['wallet'] };
  const a = await service.preview(body), b = await service.preview(body), c = await service.preview(body);
  await assert.rejects(service.restore({ previewId: a.previewId }), e => e.code === 'PREVIEW_EXPIRED', 'the oldest preview was evicted (max two)');
  advance(PREVIEW_TTL_MS + 1);
  await assert.rejects(service.restore({ previewId: b.previewId }), e => e.code === 'PREVIEW_EXPIRED');
  await assert.rejects(service.restore({ previewId: c.previewId }), e => e.code === 'PREVIEW_EXPIRED');
  const d = await service.preview(body);
  assert.equal(Date.parse(d.expiresAt) - 1_000_000 - PREVIEW_TTL_MS - 1, PREVIEW_TTL_MS);
  await service.restore({ previewId: d.previewId });
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('a failed multi-file restore is a safe 500 and leaves the prior data usable', async () => {
  await seed({ walletRows: [], alerts: [] });
  const envelope = await exportEnvelope();
  await seed({ walletRows: [], alerts: [] });
  const before = JSON.stringify(await current());
  const { service } = fixtureService({ replaceDocumentsAtomic: async () => { throw new TransactionError('Restore failed; your previous data was put back.', 'COMMIT_FAILED', { recovery: 'rolled-back', cause: new Error(`disk said ${CANARY.seats}`) }); } });
  const prev = await service.preview({ password: PASSWORD, envelope, mode: 'replace', categories: ALL });
  const e = await service.restore({ previewId: prev.previewId }).then(() => null, err => err);
  assert.equal(e.status, 500); assert.equal(e.code, 'BACKUP_RESTORE_FAILED');
  assert.ok(!e.message.includes('CANARY') && !('cause' in e));
  assert.equal(JSON.stringify(await current()), before);
});

test('restore is refused while the crypto slot is busy, with 429', async () => {
  await seed();
  const { service } = fixtureService();
  const slow = service.exportBackup({ password: PASSWORD, categories: ALL });
  const e = await service.exportBackup({ password: PASSWORD, categories: ALL }).then(() => null, err => err);
  assert.equal(e.code, 'BACKUP_BUSY'); assert.equal(e.status, 429);
  await slow;
});

test('startup recovery rolls back an interrupted restore before the first request', async () => {
  await seed({ walletRows: [wallet[0]], alerts: [] });
  const { writeFileSync } = await import('node:fs');
  // Simulate a crash mid-restore: user.json already holds new data, the journal holds the before-image.
  writeFileSync(path.join(dir, 'restore-journal.json'), JSON.stringify({ version: 1, state: 'pending', files: { user: { before: { balances: [wallet[0]], preferences: { defaultCpp: 1.5 } } } } }));
  writeFileSync(documentPath('user'), JSON.stringify({ balances: [], preferences: {} }));
  clearStoreCache();
  const s2 = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
  try {
    const user = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/user`)).json();
    assert.equal(user.balances.length, 1, 'the interrupted restore was undone');
    assert.equal(existsSync(path.join(dir, 'restore-journal.json')), false);
    assert.ok(readdirSync(dir).every(f => !f.endsWith('.tmp')));
  } finally { s2.close(); }
  assert.deepEqual(JSON.parse(readFileSync(documentPath('user'), 'utf8')).balances.length, 1);
});

test('read-after-restore: documents seen through the store match disk', async () => {
  await seed();
  const envelope = await exportEnvelope();
  await seed({ walletRows: [], alerts: [] });
  const prev = await json('/api/backup/preview', { password: PASSWORD, envelope, mode: 'replace', categories: ['wallet'] });
  await json('/api/backup/restore', { previewId: prev.body.previewId });
  const cached = await readJson(documentPath('user'), null);
  clearStoreCache();
  assert.deepEqual(await readJson(documentPath('user'), null), cached);
});

test('#1 a failed startup recovery locks data reads and writes (503) until recovery succeeds', async () => {
  const { mkdirSync, rmSync: rm, writeFileSync } = await import('node:fs');
  const serverModule = await import('../server.mjs');
  const settingsPath = documentPath('settings');
  const journal = path.join(dir, 'restore-journal.json');
  // A crash left a pending journal; rolling it back cannot replace settings.json because it is blocked by a directory.
  rm(settingsPath, { force: true, recursive: true });
  mkdirSync(settingsPath);
  const partial = { balances: [], preferences: {} };
  writeFileSync(documentPath('user'), JSON.stringify(partial));
  writeFileSync(journal, JSON.stringify({ version: 1, state: 'pending', files: { settings: { before: { monitorIntervalMinutes: 30 } }, user: { before: { balances: [wallet[0]], preferences: {} } } } }));
  clearStoreCache();
  const s2 = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const call = (method, p, body) => fetch(b2 + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    for (const [method, p, body] of [['GET', '/api/user'], ['PUT', '/api/user', { balances: [], preferences: {} }], ['GET', '/api/settings'], ['GET', '/api/alerts'], ['POST', '/api/backup/export', { password: PASSWORD, categories: ALL }], ['GET', '/api/health'], ['POST', '/api/monitor/run', {}]]) {
      const r = await call(method, p, body);
      assert.equal(r.status, 503, `${method} ${p}`);
      const payload = await r.json();
      assert.equal(payload.code, 'RECOVERY_FAILED');
      assert.ok(!JSON.stringify(payload).includes(dir), 'no path in the message');
    }
    assert.equal((await fetch(`${b2}/`)).status, 200, 'the app shell itself still loads so the error can be shown');
    assert.deepEqual(JSON.parse(readFileSync(documentPath('user'), 'utf8')), partial, 'nothing was read into or written over the half-restored wallet');
    await assert.rejects(serverModule.runMonitor(), e => e.code === 'RECOVERY_FAILED', 'the desktop tray monitor entry point is locked too');
    await assert.rejects(serverModule.getSettings(), e => e.code === 'RECOVERY_FAILED');
    // Unblock the file; the next request retries recovery and succeeds.
    rm(settingsPath, { recursive: true, force: true });
    const ok = await call('GET', '/api/user');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).balances.length, 1, 'the interrupted restore was rolled back');
    assert.equal(existsSync(journal), false);
    assert.equal((await call('PUT', '/api/user', { balances: [], preferences: {} })).status, 200, 'writes work again');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { monitorIntervalMinutes: 30 });
  } finally { s2.close(); }
});
