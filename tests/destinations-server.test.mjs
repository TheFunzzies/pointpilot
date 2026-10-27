import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-destinations-server-'));
process.env.POINTPILOT_DATA_DIR = dir;
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
process.env.POINTPILOT_CABINS_URL = 'http://127.0.0.1:9/unreachable.json';
const { startServer } = await import('../server.mjs');
const { saveUser } = await import('../lib/settings.mjs');
const { normalizeFlightAward, saveAwards } = await import('../lib/awards.mjs');

const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const departDate = day(60), returnDate = day(67);
await saveUser({ balances: [{ code: 'united', balance: 100000 }] });
await saveAwards(['LHR', 'CDG'].flatMap(destination => [
  { id: `out-${destination}`, program: 'united', origin: 'JFK', destination, date: departDate, cabin: 'business', mileageCost: 10000, totalTaxes: 50, direct: true },
  { id: `back-${destination}`, program: 'united', origin: destination, destination: 'JFK', date: returnDate, cabin: 'business', mileageCost: 10000, totalTaxes: 50, direct: true }
]).map(normalizeFlightAward));

const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});
const post = body => fetch(`${base}/api/search/destinations`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('POST /api/search/destinations returns independent wallet-funded alternatives from local fixtures', async () => {
  const response = await post({ origins: 'JFK', destinations: ['London', 'Paris'], departDate, returnDate, cabin: 'business', travelers: 2 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.results.map(entry => entry.destination), ['London', 'Paris']);
  assert.ok(body.results.every(entry => entry.error === null && entry.result.mode === 'results'));
  assert.deepEqual(body.results.map(entry => entry.result.recommended.trip.totalTargetPoints), [40000, 40000]);
  assert.deepEqual(body.results.map(entry => entry.result.query.destinations), [['LHR', 'LGW', 'LCY', 'STN'], ['CDG', 'ORY']]);
  assert.equal(body.limits.maxProviderCallsTotal, 12);
});

test('POST /api/search/destinations enforces request bounds', async () => {
  const response = await post({ origins: 'JFK', destinations: Array(9).fill('LHR'), departDate });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Choose one to eight destinations.', code: 'INVALID_INPUT' });
});
