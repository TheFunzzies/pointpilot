import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-v012-'));
const { estimateTaxes, applyTaxes } = await import('../lib/taxes.mjs');
const { evaluateSelection } = await import('../lib/search.mjs');
const { saveUser, exampleUser, updateSettings } = await import('../lib/settings.mjs');
const { matchesTracked, createAlert, runMonitor, setNotifier } = await import('../lib/monitor.mjs');
const { saveAwards, normalizeFlightAward } = await import('../lib/awards.mjs');
const { addStay, balancesAfterPlan, clearPlan } = await import('../lib/stayplan.mjs');
const { awardsFor, parseProperty, matchProperty, enrichHotels, hotelKey } = await import('../lib/hotelinfo.mjs');
const { parseMichelinKeys } = await import('../scripts/build-hotel-awards.mjs');
await saveUser(exampleUser());

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('missing taxes are estimated from history (route first, then program)', () => {
  const history = [
    { program: 'flyingblue', origin: 'JFK', destination: 'HND', cabin: 'business', taxes: 210 },
    { program: 'flyingblue', origin: 'JFK', destination: 'HND', cabin: 'business', taxes: 230 },
    { program: 'flyingblue', origin: 'BOS', destination: 'CDG', cabin: 'business', taxes: 180 },
    { program: 'ethiopian', origin: 'EWR', destination: 'NRT', cabin: 'business', taxes: 0 }
  ];
  assert.deepEqual(estimateTaxes({ program: 'flyingblue', origin: 'JFK', destination: 'HND', cabin: 'business' }, history), { value: 230, basis: 'route', count: 2 });
  assert.equal(estimateTaxes({ program: 'flyingblue', origin: 'EWR', destination: 'KIX', cabin: 'business' }, history).basis, 'program');
  assert.equal(estimateTaxes({ program: 'ethiopian', origin: 'EWR', destination: 'NRT', cabin: 'business' }, history), null);
  const o = applyTaxes({ program: 'ethiopian', origin: 'EWR', destination: 'NRT', cabin: 'business', totalTaxes: 0 }, history);
  assert.equal(o.taxesMissing, true);
  assert.equal(o.totalTaxes, null);
  assert.equal(applyTaxes({ program: 'aeroplan', totalTaxes: 56 }, history).taxesMissing, false);
});

test('trips with unreported taxes carry a warning', async () => {
  const leg = { id: 'x', leg: 'Outbound', program: 'ethiopian', programName: 'Ethiopian ShebaMiles', mileageCost: 50000, totalTaxes: null, taxesMissing: true, taxesEstimate: null, cabin: 'business', origin: 'EWR', destination: 'NRT', date: inDays(80) };
  const r = await evaluateSelection({ legs: [{ ...leg, program: 'aeroplan', programName: 'Aeroplan' }], travelers: 1 });
  assert.ok(r.trip.taxesEstimated);
  assert.ok(r.trip.warnings.some(w => /didn't report taxes/.test(w)));
});

const flight = (nums, date, score) => ({ flightNumbers: nums, depart: { date, time: '10:00' }, product: { score } });
test('tracked flights: exact vs similar matching', () => {
  const t = { date: '2027-03-05', flightNumbers: ['NH9'], mileageCost: 87500, seatScore: 5 };
  const same = { date: '2027-03-05', mileageCost: 90000, seatScore: 5, flight: flight(['NH9'], '2027-03-05') };
  const alt = { date: '2027-03-05', mileageCost: 92000, seatScore: 5, flight: flight(['NH1009'], '2027-03-05') };
  const worseSeat = { ...alt, seatScore: 3 };
  const pricey = { ...alt, mileageCost: 120000 };
  assert.equal(matchesTracked(same, t, 'exact'), true);
  assert.equal(matchesTracked(alt, t, 'exact'), false);
  assert.equal(matchesTracked(alt, t, 'similar'), true);
  assert.equal(matchesTracked(worseSeat, t, 'similar'), false);
  assert.equal(matchesTracked(pricey, t, 'similar'), false);
});

test('flight alert fires when the tracked flight is bookable, and not again for the same price', async () => {
  const date = inDays(120);
  const trip = { id: 'T1', origin: 'JFK', destination: 'HND', departUtc: `${date}T15:00:00Z`, arriveUtc: `${inDays(121)}T05:00:00Z`, depart: { date, time: '10:00' }, arrive: { date: inDays(121), time: '14:00' }, arriveDayOffset: 1, flightNumbers: ['NH9'], airlines: ['ANA'], stops: 0, layovers: [], totalDurationMin: 840, mileageCost: 87500, taxes: 56, product: { type: 'THE Room', score: 5 }, segments: [] };
  await saveAwards([normalizeFlightAward({ dataSource: 'seats.aero', program: 'aeroplan', origin: 'JFK', destination: 'HND', date, cabin: 'business', mileageCost: 87500, totalTaxes: 56, flights: [trip] })]);
  const notes = [];
  setNotifier(n => notes.push(n));
  await createAlert({ origins: 'JFK', destination: 'HND', departDate: date, cabin: 'business', travelers: 2, track: { mode: 'exact', legs: [{ leg: 'Outbound', date, flightNumbers: ['NH9'], mileageCost: 87500, seatScore: 5 }] } });
  let r = await runMonitor();
  const res = r.results.find(x => x.kind === 'award');
  assert.equal(res.isNew, true, JSON.stringify(res));
  assert.match(notes.at(-1).body, /NH9/);
  r = await runMonitor();
  assert.equal(r.results.find(x => x.kind === 'award').isNew, false);
});

test('hotel cards are funded from what is left after the stay plan', async () => {
  await clearPlan();
  const user = exampleUser();
  const before = await balancesAfterPlan(user);
  assert.equal(before.stays, 0);
  await addStay({ name: 'Park Hyatt Kyoto', program: 'hyatt', city: 'Kyoto', checkIn: inDays(60), checkOut: inDays(62), nightlyPoints: 45000 });
  const after = await balancesAfterPlan(user);
  assert.equal(after.stays, 1);
  assert.equal(after.balances.find(b => b.code === 'hyatt').balance, 0);   // the 30k Hyatt points are committed
  assert.ok(after.committed.some(c => c.from === 'hyatt' && c.points === 30000));
});

test('MICHELIN Keys: parse the published list and match hotels by name + city', () => {
  const html = '<h4>Thailand (2 Two-Key Hotels)</h4><ul><li>Park Hyatt Bangkok - Bangkok</li><li>The Siam - Bangkok</li></ul><h4>Japan (1 One-Key Hotels)</h4><ul><li>The Ritz-Carlton, Kyoto - Kyoto</li></ul><h4>Thailand (2 Two-Key Hotels)</h4><ul><li>Park Hyatt Bangkok - Bangkok</li></ul>';
  const list = parseMichelinKeys(html);
  assert.equal(list.length, 3);                                    // duplicate section removed
  assert.deepEqual(list[0], { name: 'Park Hyatt Bangkok', city: 'Bangkok', country: 'Thailand', award: 'michelin-keys', keys: 2 });
  assert.equal(awardsFor({ name: 'Park Hyatt Bangkok', location: 'Bangkok, Thailand' })[0].keys, 2);   // bundled data
  assert.equal(awardsFor({ name: 'Hyatt Regency Bangkok Sukhumvit', location: 'Bangkok, Thailand' }).length, 0);
});

test('Google Hotels: star class and rating are parsed, matched by location, and cached', async () => {
  const p = parseProperty({ name: 'Park Hyatt Tokyo', hotel_class: '5-star hotel', overall_rating: 4.6, reviews: 3120, gps_coordinates: { latitude: 35.6857, longitude: 139.6908 } });
  assert.equal(p.stars, 5);
  const ours = [{ name: 'Park Hyatt Tokyo', city: 'Tokyo', latitude: 35.6856, longitude: 139.6907 }, { name: 'Hyatt Regency Tokyo', city: 'Tokyo', latitude: 35.6926, longitude: 139.6930 }];
  assert.equal(matchProperty(p, ours).name, 'Park Hyatt Tokyo');
  await updateSettings({ serpApiKey: 'serp' });
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => { calls++; assert.match(String(url), /engine=google_hotels/); assert.equal(new URL(String(url)).searchParams.get('q'), 'Hyatt hotels in Tokyo'); return { ok: true, status: 200, json: async () => ({ properties: [
    { type: 'hotel', name: 'Park Hyatt Tokyo', extracted_hotel_class: 5, overall_rating: 4.6, reviews: 3120, gps_coordinates: { latitude: 35.6857, longitude: 139.6908 } },
    { type: 'hotel', name: 'Hyatt Regency Tokyo', hotel_class: '4-star hotel', overall_rating: 4.3, reviews: 5000, gps_coordinates: { latitude: 35.6927, longitude: 139.6931 } }] }) }; };
  try {
    const hotels = ours.map(h => ({ ...h, program: 'hyatt' }));
    const r = await enrichHotels({ hotels, city: 'Tokyo', checkIn: inDays(60), checkOut: inDays(62) });
    assert.equal(r.calls, 1);
    assert.equal(r.info[hotelKey('Park Hyatt Tokyo', 'Tokyo')].stars, 5);
    assert.equal(r.info[hotelKey('Hyatt Regency Tokyo', 'Tokyo')].stars, 4);
    const again = await enrichHotels({ hotels, city: 'Tokyo', checkIn: inDays(60), checkOut: inDays(62) });
    assert.equal(again.calls, 0);                                   // served from the 60-day cache
    assert.equal(calls, 1);
  } finally { globalThis.fetch = real; }
});
