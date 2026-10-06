import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-v014-'));
const { setFlights, updateTripSettings, searchPositioning } = await import('../lib/tripplan.mjs');
const { saveUser, exampleUser, updateSettings } = await import('../lib/settings.mjs');
const { mapLimit } = await import('../lib/util.mjs');
const { routeHistoryStats } = await import('../lib/history.mjs');
const { estimateTaxes } = await import('../lib/taxes.mjs');
const { listPrograms } = await import('../lib/programs.mjs');
await saveUser(exampleUser());

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D = inDays(60), R = inDays(66);
const flight = (o, d, dep, arr, date) => ({ origin: o, destination: d, departUtc: dep, arriveUtc: arr, depart: { date, time: '15:55' }, arrive: { date, time: '20:45' }, flightNumbers: ['KL618'], totalDurationMin: 600, stops: 1, layovers: [] });

test('trip builder explains when no connecting flight is needed (award departs from home)', async () => {
  const out = { id: 'o', leg: 'Outbound', program: 'flyingblue', mileageCost: 115000, totalTaxes: 701, cabin: 'business', origin: 'BOS', destination: 'NRT', date: D, flight: flight('BOS', 'NRT', `${D}T20:55:00Z`, `${inDays(62)}T11:45:00Z`, D) };
  const back = { id: 'b', leg: 'Return', program: 'qatar', mileageCost: 200000, totalTaxes: null, taxesMissing: true, cabin: 'business', origin: 'NRT', destination: 'JFK', date: R, flight: flight('NRT', 'JFK', `${R}T21:55:00Z`, `${inDays(67)}T15:00:00Z`, R) };
  await setFlights({ outbound: out, return: back, travelers: 2 });
  const plan = await updateTripSettings({ home: { origin: 'BOS', returnTo: 'BOS' } });
  assert.equal(plan.needs.outbound, null);
  assert.equal(plan.connections.outbound, 'home');           // shown as "✓ no connection needed"
  assert.equal(plan.connections.return, 'needed');
  assert.equal(plan.needs.return.from, 'JFK');
  assert.equal(plan.flights.return.taxesMissing, true);       // carried into the builder
});

test('connecting flights: fitting first, then cheapest, then closest to the award', async () => {
  await updateSettings({ serpApiKey: 'serp', travelpayoutsToken: '', seatsAeroApiKey: '' });
  const real = globalThis.fetch;
  const it = (dep, arr, price) => ({ price, total_duration: 80, flights: [{ departure_airport: { id: 'JFK', time: `${inDays(67)} ${dep}` }, arrival_airport: { id: 'BOS', time: `${inDays(67)} ${arr}` }, airline: 'JetBlue', flight_number: 'B6 1' }] });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ best_flights: [it('09:00', '10:20', 99), it('18:30', '19:50', 144), it('13:15', '14:35', 144), it('21:00', '22:20', 120)] }) });
  try {
    const s = await searchPositioning({ direction: 'return' });
    // Award lands 15:00Z (11:00 EDT) + 2h buffer → leave after ~13:00 local.
    assert.deepEqual(s.cash.map(f => [f.fits, f.price, f.departTime.slice(-5)]), [[true, 120, '21:00'], [true, 144, '13:15'], [true, 144, '18:30'], [false, 99, '09:00']]);
    assert.deepEqual(s.counts, { cash: 4, fitting: 3 });
  } finally { globalThis.fetch = real; }
});

test('mapLimit keeps order and caps concurrency', async () => {
  let active = 0, peak = 0;
  const r = await mapLimit([5, 1, 3, 2, 4, 0], 3, async x => { active++; peak = Math.max(peak, active); await new Promise(res => setTimeout(res, x)); active--; return x * 10; });
  assert.deepEqual(r, [50, 10, 30, 20, 40, 0]);
  assert.ok(peak <= 3);
});

test('history lookups are indexed (fast on a large history)', () => {
  const big = [];
  for (let i = 0; i < 50000; i++) big.push({ program: i % 2 ? 'aeroplan' : 'united', origin: `A${i % 200}`, destination: 'BKK', cabin: 'business', pointsCommon: 80000 + (i % 7) * 1000, taxes: 50 + (i % 5) });
  const t0 = performance.now();
  for (let i = 0; i < 400; i++) { routeHistoryStats(big, { program: 'aeroplan', origin: `A${i % 200}`, destination: 'BKK', cabin: 'business' }); estimateTaxes({ program: 'aeroplan', origin: 'X', destination: 'Y', cabin: 'business' }, big); }
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `took ${ms}ms`);
  assert.equal(routeHistoryStats(big, { program: 'aeroplan', origin: 'A1', destination: 'BKK', cabin: 'business' }).count, 250);
});

test('every airline program has a booking link', () => {
  const missing = listPrograms('airline').filter(p => !p.bookingUrl).map(p => p.id);
  assert.deepEqual(missing, []);
});
