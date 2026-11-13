import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-finder-advanced-'));
process.env.POINTPILOT_DATA_DIR = dir;
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
process.env.POINTPILOT_CABINS_URL = 'http://127.0.0.1:9/unreachable.json';
const { saveUser, validateAlertDefinitions } = await import('../lib/settings.mjs');
const { normalizeFlightAward, saveAwards } = await import('../lib/awards.mjs');
const { findTrip } = await import('../lib/finder.mjs');
const { findStopoverTrips } = await import('../lib/stopover.mjs');
const { createAlert, runMonitor, setNotifier, listAlerts } = await import('../lib/monitor.mjs');
test.after(() => rm(dir, { recursive: true, force: true }));

const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const earliest = day(60), latest = day(90);
const award = (id, program, origin, destination, date, mileageCost, totalTaxes = 30) => normalizeFlightAward({ id, program, origin, destination, date, cabin: 'economy', mileageCost, totalTaxes, direct: true });

await saveUser({ balances: [{ code: 'united', balance: 200000, cpp: 1.2 }, { code: 'ba', balance: 200000, cpp: 1.2 }, { code: 'aeroplan', balance: 200000, cpp: 1.2 }] });
await saveAwards([
  // London: Avios are cheaper in points but carry heavy surcharges; United costs a little more with low fees.
  award('ba-out', 'ba', 'JFK', 'LHR', day(65), 20000, 350), award('ba-back', 'ba', 'LHR', 'JFK', day(72), 20000, 350),
  award('ua-out', 'united', 'JFK', 'LHR', day(65), 45000, 30), award('ua-back', 'united', 'LHR', 'JFK', day(72), 45000, 120),
  // Rome via Lisbon, all Aeroplan on the way out.
  award('jfk-lis', 'aeroplan', 'JFK', 'LIS', day(62), 30000), award('lis-fco', 'aeroplan', 'LIS', 'FCO', day(65), 8000), award('fco-jfk', 'united', 'FCO', 'JFK', day(72), 35000),
  award('jfk-fco', 'united', 'JFK', 'FCO', day(65), 35000),
  award('jfk-kef', 'united', 'JFK', 'KEF', day(62), 90000) // Reykjavik has no onward seat
]);

test('surcharge dodge: a lower-fee program is offered beside the cheapest points option', async () => {
  const r = await findTrip({ origins: 'JFK', destination: 'LHR', earliest, latest, nights: 7 }, { allowApi: false, allowGoogle: false });
  assert.deepEqual([r.best.type, r.best.variant || null, r.best.points, r.best.outOfPocketUsd], ['points', null, 65000, 380]); // the optimizer already mixes programs per direction
  const low = r.options.find(o => o.variant === 'lowfee');
  assert.deepEqual([low.points, low.outOfPocketUsd, low.feesSavedUsd], [90000, 150, 230]);
  assert.ok(r.insights.some(i => /cuts fees by about \$230/.test(i.text)));
});

test('stopover builder: three funded awards, compared with going direct', async () => {
  const r = await findStopoverTrips({ origins: 'JFK', destination: 'FCO', earliest, latest, nights: 7, stopNights: 3, cabin: 'economy' }, { allowApi: false });
  assert.deepEqual(r.results.map(x => x.city), ['Lisbon']);
  const x = r.results[0];
  assert.deepEqual([x.depart, x.onward, x.return, x.stopNights, x.stayNights], [day(62), day(65), day(72), 3, 7]);
  assert.deepEqual([x.points, x.feesUsd, r.direct.points, x.extraPoints], [73000, 90, 70000, 3000]);
  assert.deepEqual(x.legs.map(l => l.dir), ['Outbound', 'Onward', 'Return']);
  assert.match(x.singleAward, /Aeroplan.*stopover/);
  const named = await findStopoverTrips({ origins: 'JFK', destination: 'FCO', earliest, latest, nights: 7, stopover: 'Reykjavik' }, { allowApi: false });
  assert.equal(named.results.length, 0);
  await assert.rejects(() => findStopoverTrips({ origins: 'JFK', destination: 'FCO', earliest, latest: day(66), nights: 5, nightsFlex: 0, stopNights: 3 }, { allowApi: false }), /too short/);
});

test('booked-award watch: notifies when the same flight day gets cheaper, once', async () => {
  const notes = [];
  setNotifier(n => notes.push(n));
  const paidMore = await createAlert({ kind: 'rebook', program: 'united', origin: 'JFK', destination: 'LHR', date: day(65), cabin: 'economy', travelers: 1, paidPoints: 60000 });
  const paidSame = await createAlert({ kind: 'rebook', program: 'united', origin: 'JFK', destination: 'LHR', date: day(65), cabin: 'economy', travelers: 1, paidPoints: 45000 });
  assert.deepEqual([paidMore.kind, paidMore.query.departDate, paidMore.program], ['rebook', day(65), 'united']);
  const first = await runMonitor({ force: true, alertId: paidMore.id });
  assert.equal(first.results[0].isNew, true);
  assert.match(first.results[0].best, /United MileagePlus now 45,000 pts \(you paid 60,000\): save 15,000 per person\. This program redeposits miles free/);
  assert.equal(notes.length, 1);
  assert.equal((await runMonitor({ force: true, alertId: paidMore.id })).results[0].isNew, false);
  // Paid the current price: the cheaper Avios fare is flagged as a switch, United itself is not.
  const same = await runMonitor({ force: true, alertId: paidSame.id });
  assert.equal(same.results[0].matches, 1);
  assert.match(same.results[0].best, /British Airways.*20,000 pts/);
  await assert.rejects(() => createAlert({ kind: 'rebook', program: 'hyatt', origin: 'JFK', destination: 'LHR', date: day(65), paidPoints: 1000 }), /airline program/);
  // Definitions survive a backup round trip.
  const restored = validateAlertDefinitions((await listAlerts()).filter(a => a.kind === 'rebook'));
  assert.deepEqual([restored[0].kind, restored[0].program, restored[0].paidPoints > 0], ['rebook', 'united', true]);
});
