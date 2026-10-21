import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-search-reg-'));
const { searchTrip, searchHotels, bestPerFlight, flightOptions, expandAwards } = await import('../lib/search.mjs');
const { normalizeFlightAward, saveAwards } = await import('../lib/awards.mjs');
const { searchSeatsAero, mapAvailability } = await import('../lib/seatsaero.mjs');
const { saveUser, updateSettings } = await import('../lib/settings.mjs');
const { clearPlan, addStay } = await import('../lib/stayplan.mjs');
const { getTripsCached } = await import('../lib/flights.mjs');
const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D = day(80);
const base = { program: 'united', origin: 'JFK', destination: 'LHR', date: D, cabin: 'business', mileageCost: 10000, totalTaxes: 0, direct: false };
const response = body => ({ ok: true, status: 200, json: async () => body });
const seg = (id, stops = false) => ({ ID: id, Cabin: 'business', MileageCost: 20000, RemainingSeats: 2, AvailabilitySegments: stops ? [
  { FlightNumber: 'UA1', OriginAirport: 'JFK', DestinationAirport: 'BOS', DepartsAt: `${D}T10:00:00Z`, ArrivesAt: `${D}T11:00:00Z` },
  { FlightNumber: 'UA2', OriginAirport: 'BOS', DestinationAirport: 'LHR', DepartsAt: `${D}T12:00:00Z`, ArrivesAt: `${D}T20:00:00Z` }
] : [{ FlightNumber: 'UA3', OriginAirport: 'JFK', DestinationAirport: 'LHR', DepartsAt: `${D}T10:00:00Z`, ArrivesAt: `${D}T18:00:00Z` }] });

test('BUG-2: distinct prices/availability/cabins survive; compatible flight lists merge', () => {
  const rows = [normalizeFlightAward(base), normalizeFlightAward({ ...base, mileageCost: 20000, direct: true }),
    normalizeFlightAward({ ...base, availabilityId: 'a' }), normalizeFlightAward({ ...base, availabilityId: 'b' }),
    normalizeFlightAward({ ...base, cabin: 'economy' })];
  assert.equal(bestPerFlight(rows).length, 5);
  const merged = bestPerFlight([{ ...rows[0], flights: [{ id: '1' }] }, { ...rows[0], flights: [{ id: '2' }] }]);
  assert.deepEqual(merged[0].flights.map(f => f.id), ['1', '2']);
});

test('BUG-3: funded awards beyond cheap unfunded rows are recommended; full options survive', async () => {
  await updateSettings({ seatsAeroApiKey: '' });
  await saveUser({ balances: [{ code: 'united', balance: 50000 }] });
  await saveAwards([...Array.from({ length: 160 }, (_, i) => normalizeFlightAward({ ...base, id: `unfunded-${i}`, program: 'delta', mileageCost: i + 1 })), normalizeFlightAward({ ...base, id: 'funded', mileageCost: 20000, direct: true })]);
  const result = await searchTrip({ origins: 'JFK', destination: 'LHR', departDate: D }, { allowApi: false });
  assert.equal(result.recommended.ids[0], 'funded');
  assert.equal(result.outbound.length, 161);
  assert.equal(result.truncated, true);
  const mapped = mapAvailability({ ID: 'many', Date: D, Source: 'united', Route: { OriginAirport: 'JFK', DestinationAirport: 'LHR' }, JAvailable: true, JMileageCost: 20000, AvailabilityTrips: Array.from({ length: 12 }, (_, i) => seg(`f${i}`)) }, 'business');
  assert.equal(mapped.flights.length, 12);
  assert.equal(flightOptions([mapped], 'Outbound').length, 12);
});

test('BUG-3: page caps report truncation', async () => {
  const r = await searchSeatsAero({ apiKey: 'test', origins: ['JFK'], destinations: ['LHR'], start: D, end: D, cabin: 'business', fetchImpl: async () => response({ data: [{ ID: 'none' }], hasMore: true, cursor: 'next' }) });
  assert.equal(r.calls, 3);
  assert.equal(r.truncated, true);
});

test('BUG-4: expanding a nonstop search filters connecting flights on the server', async () => {
  await updateSettings({ seatsAeroApiKey: 'expand-regression' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => response({ data: [seg('direct'), seg('connecting', true)] });
  try {
    const r = await expandAwards({ awards: [{ ...base, id: 'expand', availabilityId: 'expand-regression' }], directOnly: true });
    assert.equal(r.options.length, 1);
    assert.equal(r.options[0].flight.stops, 0);
    assert.equal((await expandAwards({ awards: [{ ...base, flight: { stops: 1 } }], directOnly: true })).options.length, 0);
  } finally { globalThis.fetch = real; }
});

test('PERF-2: identical simultaneous award searches and details share one request', async () => {
  await updateSettings({ seatsAeroApiKey: 'coalesce-regression' });
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 25)); return response({ data: [] }); };
  try {
    const query = { origins: 'BOS', destination: 'CDG', departDate: day(95) };
    await Promise.all([searchTrip(query), searchTrip(query)]);
    assert.equal(calls, 1);
    calls = 0;
    let recorded = 0;
    const args = { apiKey: 'detail-regression', availabilityId: 'detail-regression', cabin: 'business' };
    await Promise.all([getTripsCached(args, async n => { recorded += n; }), getTripsCached(args, async n => { recorded += n; })]);
    assert.equal(calls, 1);
    assert.equal(recorded, 1);
  } finally { globalThis.fetch = real; }
});

test('DOM-8 / DOM-6: hotel cache derives exact/estimated totals per query and funds plan plus candidate', async () => {
  await clearPlan();
  await saveUser({ balances: [{ code: 'chase', balance: 6000 }] });
  await addStay({ name: 'Prior stay', program: 'hyatt', checkIn: day(40), checkOut: day(41), nightlyPoints: 5500 });
  await updateSettings({ seatsAeroApiKey: 'hotel-cache-regression' });
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ data: [{ hotel: { id: 'odd-total', name: 'Test Hotel', source: 'hyatt', city: 'Tokyo' }, lowest_award_standard: 501, standard_nights: 5, standard_date: D, lowest_cash_standard: 10000, currency_code: 'USD' }] }); };
  try {
    const long = await searchHotels({ destination: 'Tokyo', checkIn: D, checkOut: day(86) });
    const exact = await searchHotels({ destination: 'Tokyo', checkIn: D, checkOut: day(85) });
    assert.equal(calls, 1);
    assert.equal(long.rows[0].estimated, true);
    assert.equal(exact.rows[0].estimated, false);
    assert.equal(exact.rows[0].totalPoints, 501);
    assert.equal(exact.rows[0].cashUsd, 100);
    // Exactly 500 remaining points fit when the full existing plan is funded with the candidate.
    await clearPlan();
    await addStay({ name: 'Prior stay', program: 'hyatt', checkIn: day(40), checkOut: day(41), nightlyPoints: 5499 });
    const combined = await searchHotels({ destination: 'Tokyo', checkIn: D, checkOut: day(85) }, { allowApi: false });
    assert.equal(combined.rows[0].affordable, true);
    assert.equal(combined.unfunded, false);
  } finally { globalThis.fetch = real; await clearPlan(); }
});

test('BUG-9: searches reject impossible dates and nonfinite travelers', async () => {
  await assert.rejects(searchTrip({ origins: 'JFK', destination: 'LHR', departDate: '2027-02-30' }), { status: 400 });
  await assert.rejects(searchTrip({ origins: 'JFK', destination: 'LHR', departDate: D, travelers: 'Infinity' }), { status: 400 });
  await assert.rejects(searchHotels({ destination: 'Tokyo', checkIn: '2027-02-30' }), { status: 400 });
});


test('round-trip search pairs same-metro airports and honors searched airport sets', async () => {
  await updateSettings({ seatsAeroApiKey: '' });
  await saveUser({ balances: [{ code: 'united', balance: 100000 }] });
  const { writeJson } = await import('../lib/store.mjs');
  const { dataFile } = await import('../lib/paths.mjs');
  await writeJson(dataFile('award-cache.json'), []);
  const retDate = day(90);
  const outbound = { ...base, id: 'metro-out', direct: true };
  const ret = { ...base, id: 'metro-back', origin: 'LGW', destination: 'EWR', date: retDate, direct: true };
  await saveAwards([outbound, ret].map(normalizeFlightAward));
  const query = { origins: 'JFK,EWR', destination: 'LHR,LGW', departDate: D, returnDate: retDate };
  assert.equal((await searchTrip(query, { allowApi: false })).trips.length, 1);
  await saveAwards([outbound, { ...ret, destination: 'BOS' }].map(normalizeFlightAward));
  assert.equal((await searchTrip({ ...query, origins: 'JFK,BOS' }, { allowApi: false })).trips.length, 1);
  await saveAwards([outbound, { ...ret, date: day(70) }].map(normalizeFlightAward));
  await assert.rejects(searchTrip({ ...query, returnDate: day(70) }, { allowApi: false }), { status: 400 });
});
