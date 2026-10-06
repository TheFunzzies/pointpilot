import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-server-'));
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
const { startServer } = await import('../server.mjs');

const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const json = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('cross-site requests are refused', async () => {
  const r1 = await json('PUT', '/api/user', { balances: [] }, { origin: 'https://evil.example' });
  assert.equal(r1.status, 403);
  const r2 = await fetch(base + '/api/manual-award', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r2.status, 403);
  const r3 = await fetch(base + '/api/health');
  assert.equal(r3.status, 200);
});

test('new users start with an empty wallet; example balances are opt-in and saveable', async () => {
  const fresh = await (await fetch(base + '/api/user')).json();
  assert.equal(fresh.balances.length, 0);
  const example = await (await fetch(base + '/api/user/example')).json();
  assert.ok(example.balances.some(b => b.type === 'bank') && example.balances.some(b => b.type === 'airline') && example.balances.some(b => b.type === 'hotel'));
  const saved = await (await json('PUT', '/api/user', example)).json();
  assert.equal(saved.balances.length, example.balances.length);
  const bad = await json('PUT', '/api/user', { balances: [{ program: 'Not A Real Program', balance: 5 }] });
  assert.equal(bad.status, 400);
});

test('manual awards flow through search and the optimizer end to end', async () => {
  const out = inDays(120), back = inDays(132);
  for (const a of [
    { program: 'Aeroplan', origin: 'JFK', destination: 'BKK', date: out, cabin: 'business', mileageCost: 87500, totalTaxes: 56, cashValue: 4200 },
    { program: 'flying blue', origin: 'BKK', destination: 'EWR', date: back, cabin: 'business', mileageCost: 90000, totalTaxes: 210, cashValue: 4000 }
  ]) assert.equal((await json('POST', '/api/manual-award', a)).status, 201);

  const r = await (await json('POST', '/api/search/trip', { origins: 'JFK,EWR', destination: 'Thailand', departDate: out, returnDate: back, flexDays: 3, cabin: 'business', travelers: 2 })).json();
  assert.equal(r.mode, 'results', JSON.stringify(r));
  const best = r.trips[0];
  assert.equal(best.totalTargetPoints, (87500 + 90000) * 2);
  assert.equal(best.taxesUsd, (56 + 210) * 2);
  assert.deepEqual(best.legs.map(l => l.program), ['aeroplan', 'flyingblue']);
});

test('unknown destinations return a clear 400', async () => {
  const r = await json('POST', '/api/search/trip', { origins: 'JFK', destination: 'Atlantis', departDate: inDays(30) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Atlantis/);
});

test('alerts can be created and listed', async () => {
  const created = await (await json('POST', '/api/alerts', { origins: 'JFK', destination: 'Tokyo', departDate: inDays(60), travelers: 2 })).json();
  const list = await (await fetch(base + '/api/alerts')).json();
  assert.ok(list.some(a => a.id === created.id && a.query.destination === 'Tokyo'));
});
