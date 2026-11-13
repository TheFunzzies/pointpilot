import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-finder-'));
process.env.POINTPILOT_DATA_DIR = dir;
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
process.env.POINTPILOT_CABINS_URL = 'http://127.0.0.1:9/unreachable.json';
const { startServer } = await import('../server.mjs');
const { saveUser } = await import('../lib/settings.mjs');
const { normalizeFlightAward, saveAwards } = await import('../lib/awards.mjs');
const { findTrip, normalizeFinderQuery } = await import('../lib/finder.mjs');
const { adviceFor, regionsFor, reachablePrograms } = await import('../lib/playbook.mjs');
const { transferData } = await import('../lib/reference.mjs');
const { listAlerts, runMonitor, setNotifier } = await import('../lib/monitor.mjs');

const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const earliest = day(60), latest = day(90);
const award = (id, origin, destination, date, mileageCost) => normalizeFlightAward({ id, program: 'united', origin, destination, date, cabin: 'business', mileageCost, totalTaxes: 50, direct: true });

await saveUser({ balances: [{ code: 'united', balance: 200000 }, { code: 'chase', balance: 50000 }] });
await saveAwards([
  award('out-a', 'JFK', 'LHR', day(62), 60000), award('out-b', 'JFK', 'LHR', day(70), 40000),
  award('back-a', 'LHR', 'JFK', day(69), 45000), award('back-b', 'LHR', 'JFK', day(77), 40000), award('back-far', 'LHR', 'JFK', day(89), 10000),
  award('ow-only', 'JFK', 'CDG', day(65), 30000)
]);

const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('finder input: window, trip length and origin are validated', () => {
  const ok = normalizeFinderQuery({ origins: 'JFK', destination: 'London', earliest, latest, nights: 7, cabin: 'business' });
  assert.deepEqual([ok.minNights, ok.maxNights, ok.tripType, ok.cabin], [5, 9, 'round-trip', 'business']);
  assert.equal(normalizeFinderQuery({ destination: 'London', earliest, latest }, { homeAirports: 'BOS' }).origins[0], 'BOS');
  assert.throws(() => normalizeFinderQuery({ destination: 'London', earliest, latest }), /flying from/);
  assert.throws(() => normalizeFinderQuery({ origins: 'JFK', destination: 'London', earliest, latest: day(200) }), /two months/);
  assert.throws(() => normalizeFinderQuery({ origins: 'JFK', destination: 'London', earliest: day(-20), latest: day(-10) }), /past/);
  assert.throws(() => normalizeFinderQuery({ origins: 'JFK', destination: 'London', earliest, latest: day(62), nights: 14, nightsFlex: 0 }), /shorter/);
});

test('finder picks the cheapest fundable pair whose length fits the trip', async () => {
  const r = await findTrip({ origins: 'JFK', destination: 'London', earliest, latest, nights: 7, nightsFlex: 2, cabin: 'business', travelers: 2 }, { allowApi: false, allowGoogle: false });
  assert.equal(r.best.type, 'points');
  // out-b + back-b (7 nights, 80k per person); the 10k return is 19 nights away and must not be paired.
  assert.deepEqual([r.best.depart, r.best.return, r.best.points, r.best.outOfPocketUsd], [day(70), day(77), 160000, 200]);
  assert.equal(r.best.plan[0].direct, true);
  assert.equal(r.goalMet, true);
  assert.equal(r.watch.suggested, false);
  assert.ok(r.alternatives.every(a => a.depart !== r.best.depart || a.return !== r.best.return));
  assert.match(r.summary.headline, /^Use points: 160,000 points/);
  assert.ok(r.advice.regions.includes('europe') && r.advice.tips.length > 0);
});

test('finder suggests a watch when a round trip has award space one way only and no cash price', async () => {
  const r = await findTrip({ origins: 'JFK', destination: 'Paris', earliest, latest, nights: 7, cabin: 'business' }, { allowApi: false, allowGoogle: false });
  assert.equal(r.best, null);
  assert.equal(r.counts.outbound, 1);
  assert.equal(r.watch.suggested, true);
  const oneWay = await findTrip({ origins: 'JFK', destination: 'Paris', earliest, latest, tripType: 'one-way', cabin: 'business' }, { allowApi: false, allowGoogle: false });
  assert.deepEqual([oneWay.best.type, oneWay.best.points, oneWay.best.return], ['points', 30000, null]);
});

test('POST /api/finder/search answers and rejects bad input', async () => {
  const ok = await post('/api/finder/search', { origins: 'JFK', destination: 'London', earliest, latest, nights: 7, cabin: 'business' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).best.type, 'points');
  const bad = await post('/api/finder/search', { origins: 'JFK', destination: 'Nowhereville', earliest, latest });
  assert.equal(bad.status, 400);
});

test('trip watch: created from a window, notifies once, then stays quiet until something changes', async () => {
  const notes = [];
  setNotifier(n => notes.push(n));
  const created = await post('/api/alerts', { kind: 'plan', origins: 'JFK', destination: 'London', earliest, latest, nights: 7, cabin: 'business', travelers: 1, targetCashUsd: 500 });
  assert.equal(created.status, 201);
  const alert = await created.json();
  assert.deepEqual([alert.kind, alert.query.tripType, alert.query.nights, alert.targetCashUsd], ['plan', 'round-trip', 7, 500]);
  const first = await runMonitor({ force: true, alertId: alert.id });
  assert.deepEqual([first.results[0].status, first.results[0].isNew, first.results[0].matches], ['ok', true, 1]);
  assert.match(first.results[0].best, /^Points: 80,000 pts/);
  assert.equal(notes.length, 1);
  const second = await runMonitor({ force: true, alertId: alert.id });
  assert.equal(second.results[0].isNew, false);
  assert.equal(notes.length, 1);
  // Not forced: a trip watch is checked about once a day.
  const third = await runMonitor({ alertId: alert.id });
  assert.equal(third.results[0].skipped, true);
  assert.equal((await listAlerts()).find(a => a.id === alert.id).lastResult.matches, 1);
  assert.equal((await post('/api/alerts', { kind: 'plan', origins: 'JFK', destination: 'London', earliest, latest: day(300) })).status, 400);
});

test('playbook: tips match the region and cabin, and only programs the wallet can reach', () => {
  assert.deepEqual(regionsFor(['BOS'], ['NRT']), ['japan']);
  assert.deepEqual(regionsFor(['BOS'], ['HNL']), ['hawaii']);
  assert.deepEqual(regionsFor(['BOS'], ['LAX']), ['domestic']);
  const transfers = transferData();
  const reach = reachablePrograms([{ code: 'chase', balance: 1000 }], transfers);
  assert.ok(reach.has('hyatt') && reach.has('chase') && !reach.has('ana'));
  const chaseOnly = adviceFor({ origins: ['BOS'], destinations: ['NRT'], cabin: 'business', balances: [{ code: 'chase', balance: 1000 }], transfers, limit: 20 });
  assert.ok(chaseOnly.tips.length > 0);
  assert.ok(chaseOnly.tips.every(t => !t.programs.length || t.programs.some(p => p.reachable)));
  const empty = adviceFor({ origins: ['BOS'], destinations: ['NRT'], cabin: 'business', balances: [], transfers, limit: 20 });
  assert.ok(empty.tips.length >= chaseOnly.tips.length);
  assert.equal(adviceFor({ origins: ['BOS'], destinations: ['NRT'], cabin: 'business', transfers, seenPrograms: ['american'] }).tips[0].live, true);
});
