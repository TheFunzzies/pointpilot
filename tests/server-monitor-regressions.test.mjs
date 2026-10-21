import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-monitor-regression-'));
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable';
const { startServer } = await import('../server.mjs');
const { dataFile } = await import('../lib/paths.mjs');
const { writeJson } = await import('../lib/store.mjs');
const { updateSettings, saveUser, exampleUser } = await import('../lib/settings.mjs');
const { createAlert, listAlerts, runMonitor, setNotifier, matchSignature } = await import('../lib/monitor.mjs');
const { saveAwards, normalizeHotelAward, normalizeFlightAward } = await import('../lib/awards.mjs');
const nativeFetch = globalThis.fetch;
const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
const base = `http://127.0.0.1:${server.address().port}`;
const date = '2027-08-05';
test.after(() => { globalThis.fetch = nativeFetch; server.close(); });
test.beforeEach(async () => {
  globalThis.fetch = nativeFetch;
  await writeJson(dataFile('alerts.json'), []);
  await writeJson(dataFile('award-cache.json'), []);
  await updateSettings({ seatsAeroApiKey: '', travelpayoutsToken: '', serpApiKey: '', webhookUrl: '', desktopNotifications: true });
  await saveUser(exampleUser());
  setNotifier(null);
});
test.afterEach(() => { globalThis.fetch = nativeFetch; setNotifier(null); });
const post = (p, data) => nativeFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

test('malformed request URLs return 400 and leave the server alive', async () => {
  for (const requestPath of ['/%ZZ', '/api/health?bad=%ZZ', '/%E0%A4%A']) {
    const status = await new Promise((resolve, reject) => { http.get(base + requestPath, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
    assert.equal(status, 400);
  }
  const health = await (await nativeFetch(base + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
});

test('server imports load a local .env using the Node built-in loader', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'pp-env-regression-'));
  writeFileSync(path.join(cwd, '.env'), 'POINTPILOT_ENV_REGRESSION=loaded\n');
  const moduleUrl = new URL('../server.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(moduleUrl) + '); process.stdout.write(process.env.POINTPILOT_ENV_REGRESSION || "missing");'], { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'loaded');
});

test('expand constraints and planner validation errors pass through HTTP routes', async () => {
  assert.equal((await post('/api/award/expand', { awards: [], directOnly: 'yes' })).status, 400);
  const direct = await (await post('/api/award/expand', { awards: [{ id: 'connecting', direct: false }], directOnly: true })).json();
  assert.deepEqual(direct.options, []);
  const outbound = { program: 'aeroplan', origin: 'JFK', destination: 'BKK', date, mileageCost: 1000 };
  const ret = { ...outbound, origin: 'BKK', destination: 'JFK', date: '2027-08-01' };
  const put = (p, data) => nativeFetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const invalid = await put('/api/trip-plan/flights', { outbound, return: ret });
  assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /Return/);
  assert.equal((await put('/api/trip-plan/positioning/outbound', { option: { kind: 'cash', price: 100 } })).status, 400);
});

test('manual entries reject impossible dates, unknown programs, wrong program kinds and nonfinite prices', async () => {
  const flight = { program: 'aeroplan', origin: 'JFK', destination: 'BKK', date, mileageCost: 10000 };
  for (const patch of [{ date: '2027-02-30' }, { date: date + 'garbage' }, { program: 'unknown' }, { program: 'hyatt' }, { mileageCost: '1e999' }]) {
    const r = await post('/api/manual-award', { ...flight, ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch)); assert.ok((await r.json()).error);
  }
  for (const patch of [{ program: 'united' }, { checkIn: '2027-02-30' }]) assert.equal((await post('/api/manual-hotel', { program: 'hyatt', name: 'Test hotel', checkIn: date, nightlyPoints: 1000, ...patch })).status, 400);
  assert.equal((await post('/api/manual-award', flight)).status, 201);
});

test('wallet preferences and balances have a finite typed schema', async () => {
  for (const preferences of [{ preferNonstop: 'false' }, { maxTransfers: '1e999' }, { defaultCpp: -1 }, { surprise: true }, []]) {
    await assert.rejects(saveUser({ balances: [], preferences }), e => e.status === 400);
  }
  await assert.rejects(saveUser({ balances: [{ program: 'chase', balance: '1e999' }] }), e => e.status === 400);
  const user = await saveUser({ balances: [], preferences: { maxTransfers: '3', preferNonstop: false, defaultCpp: '1.5' } });
  assert.equal(user.preferences.maxTransfers, 3);
});

function fakeCash(price = 500, webhookStatus = 200, fail = false) {
  let webhookCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://hooks.example/')) { webhookCalls++; return { ok: webhookStatus === 200, status: webhookStatus }; }
    if (fail) throw new Error('upstream offline');
    return { ok: true, status: 200, json: async () => ({ data: [{ origin_airport: 'JFK', destination_airport: 'BKK', price, departure_at: `${date}T10:00:00Z`, transfers: 0 }], currency: 'usd' }) };
  };
  return () => webhookCalls;
}
async function cashAlert() {
  await updateSettings({ travelpayoutsToken: 'test-token' });
  return createAlert({ kind: 'cash', origins: 'JFK', destination: 'BKK', departDate: date, targetPrice: 700, verifyWithGoogle: false });
}

test('failed monitor checks persist status and attempt while preserving the last successful result', async () => {
  const alert = await cashAlert(); fakeCash(); await runMonitor();
  const previous = (await listAlerts())[0];
  fakeCash(500, 200, true);
  const result = (await runMonitor({ force: true })).results[0];
  assert.equal(result.id, alert.id); assert.equal(result.status, 'error'); assert.match(result.error, /offline/);
  const persisted = (await listAlerts())[0];
  assert.equal(persisted.lastStatus, 'error'); assert.match(persisted.lastError, /offline/);
  assert.ok(Number.isFinite(Date.parse(persisted.lastAttemptAt)));
  assert.equal(persisted.lastCheckedAt, previous.lastCheckedAt); assert.deepEqual(persisted.lastResult, previous.lastResult);
  fakeCash(); await runMonitor(); assert.equal((await listAlerts())[0].lastError, null);
});

test('a failed webhook retries with capped backoff without resending the successful desktop channel', async () => {
  await cashAlert(); await updateSettings({ webhookUrl: 'https://hooks.example/notify' });
  const notes = []; setNotifier(n => notes.push(n));
  let count = fakeCash(500, 503);
  await runMonitor();
  let persisted = (await listAlerts())[0];
  assert.equal(count(), 1); assert.equal(notes.length, 1);
  assert.equal(persisted.lastNotifiedPrice, null); assert.equal(persisted.deliveryState.webhook.status, 'error');
  assert.equal(persisted.deliveryState.desktop.status, 'ok'); assert.ok(persisted.pendingDelivery);
  const delay = Date.parse(persisted.deliveryState.webhook.nextAttemptAt) - Date.now(); assert.ok(delay > 0 && delay <= 3600000);
  await runMonitor(); assert.equal(count(), 1); assert.equal(notes.length, 1);
  count = fakeCash(500, 200); await runMonitor({ force: true });
  persisted = (await listAlerts())[0]; assert.equal(count(), 1); assert.equal(notes.length, 1);
  assert.equal(persisted.lastNotifiedPrice, 500); assert.equal(persisted.pendingDelivery, null); assert.equal(persisted.deliveryState.webhook.status, 'ok');
  await runMonitor(); assert.equal(count(), 1);
});

test('stable award and hotel IDs include normalized prices and notify on a price drop', async () => {
  assert.equal(matchSignature([{ id: 'x', nightlyPoints: '1000' }]), matchSignature([{ id: 'x', nightlyPoints: 1000 }]));
  assert.notEqual(matchSignature([{ id: 'x', nightlyPoints: 1000 }]), matchSignature([{ id: 'x', nightlyPoints: 900 }]));
  const notes = []; setNotifier(n => notes.push(n));
  const hotel = price => normalizeHotelAward({ id: 'stable-hotel', program: 'hyatt', name: 'Test hotel', location: 'Tokyo', checkIn: date, nightlyPoints: price, cashValue: 300 });
  const award = price => normalizeFlightAward({ id: 'stable-flight', program: 'aeroplan', origin: 'JFK', destination: 'BKK', date, cabin: 'business', mileageCost: price, totalTaxes: 50 });
  await createAlert({ kind: 'hotel', destination: 'Tokyo', checkIn: date });
  await createAlert({ origins: 'JFK', destination: 'BKK', departDate: date, cabin: 'business' });
  await saveAwards([hotel(5000), award(10000)]);
  let r = await runMonitor(); assert.ok(r.results.every(x => x.isNew));
  r = await runMonitor(); assert.ok(r.results.every(x => !x.isNew));
  await saveAwards([hotel(4000), award(9000)]);
  r = await runMonitor(); assert.ok(r.results.every(x => x.isNew), JSON.stringify(r));
  assert.ok(r.results.every(x => x.notificationReason === 'lower-price'), JSON.stringify(r));
  assert.ok(notes.slice(-2).every(x => x.title.startsWith('Lower price')));
});


test('failed seats refresh with usable cached awards succeeds with a stale warning', async () => {
  await updateSettings({ seatsAeroApiKey: 'offline-key' });
  await saveAwards([normalizeFlightAward({ program: 'aeroplan', origin: 'JFK', destination: 'BKK', date, cabin: 'business', mileageCost: 10000, totalTaxes: 50 })]);
  await createAlert({ origins: 'JFK', destination: 'BKK', departDate: date, cabin: 'business', maxPointsPerTraveler: 1 });
  globalThis.fetch = async () => { throw new Error('seats offline'); };
  const result = (await runMonitor()).results[0];
  assert.equal(result.status, 'ok');
  assert.equal(result.matches, 0); // Usable inventory remains a successful check even below the alert threshold.
  const persisted = (await listAlerts())[0];
  assert.equal(persisted.lastStatus, 'ok');
  assert.equal(persisted.lastError, null);
  assert.ok(persisted.lastAttemptAt && persisted.lastCheckedAt);
  assert.match(persisted.lastWarnings.join(' '), /stale/);
});
