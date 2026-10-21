import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-cash-regression-'));
const { routeFares, mapFare } = await import('../lib/travelpayouts.mjs');
const { googleFlights } = await import('../lib/serpapi.mjs');
const { searchCash, cashForItinerary, fareCompatibility } = await import('../lib/cash.mjs');
const { updateSettings, apiUsage } = await import('../lib/settings.mjs');
const date = '2027-08-05', back = '2027-08-12';
const nativeFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = nativeFetch; });
const raw = (price, over = {}) => ({ origin: 'NYC', destination: 'TYO', origin_airport: 'JFK', destination_airport: 'HND', departure_at: `${date}T09:00:00Z`, return_at: `${back}T10:00:00Z`, transfers: 0, return_transfers: 0, price, ...over });
const response = data => ({ ok: true, status: 200, json: async () => ({ data, currency: 'usd' }) });

test('fare compatibility requires actual airports, dates, trip type and both directions nonstop', () => {
  const query = { origins: ['JFK'], destinations: ['HND'], departDate: date, returnDate: back, nonstopOnly: true };
  assert.equal(fareCompatibility(mapFare(raw(500)), query).compatible, true);
  for (const patch of [{ origin_airport: 'EWR' }, { destination_airport: 'NRT' }, { departure_at: '2027-08-06T09:00:00Z' }, { return_at: null }, { return_transfers: 1 }, { return_transfers: null }]) assert.equal(fareCompatibility(mapFare(raw(100, patch)), query).compatible, false, JSON.stringify(patch));
});

test('itinerary benchmarks exclude cheaper date and airport alternatives and label them', async () => {
  await updateSettings({ travelpayoutsToken: 'comparison', serpApiKey: '' });
  globalThis.fetch = async () => response([raw(50, { origin_airport: 'EWR' }), raw(60, { return_at: '2027-08-13T10:00:00Z' }), raw(700)]);
  const r = await cashForItinerary({ origin: 'JFK', destination: 'HND', departDate: date, returnDate: back });
  assert.equal(r.perTraveler, 700); assert.equal(r.alternatives.length, 2); assert.ok(r.alternatives.every(f => /^Alternative:/.test(f.label)));
  const searched = await searchCash({ origins: 'JFK', destination: 'HND', departDate: date, returnDate: back });
  assert.deepEqual(searched.fares.map(f => f.price), [700]); assert.equal(searched.alternatives.length, 2);
});

test('cash searches reject impossible dates and nonfinite traveler values', async () => {
  for (const patch of [{ departDate: '2027-02-30' }, { returnDate: '2027-06-31' }, { travelers: '1e999' }]) {
    const params = { origins: 'JFK', origin: 'JFK', destination: 'HND', departDate: date, ...patch };
    await assert.rejects(searchCash(params), e => e.status === 400);
    await assert.rejects(cashForItinerary(params), e => e.status === 400);
  }
});

test('Travelpayouts coalesces concurrent and repeat calls and returns independent cached objects', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return response([raw(700)]); };
  const params = { token: 'cache', origin: 'JFK', destination: 'HND', departAt: date, returnAt: back, fetchImpl };
  const before = (await apiUsage()).tpCalls;
  const [a, b] = await Promise.all([routeFares(params), routeFares(params)]);
  a.fares[0].price = 1; assert.equal(b.fares[0].price, 700);
  const c = await routeFares(params); assert.equal(c.fares[0].price, 700); assert.equal(c.calls, 0);
  assert.equal(calls, 1); assert.equal((await apiUsage()).tpCalls - before, 1);
});

test('Travelpayouts records both attempted fallback requests when the second one fails', async () => {
  let calls = 0;
  const before = (await apiUsage()).tpCalls;
  const fetchImpl = async () => { if (++calls === 1) return response([]); throw new Error('offline'); };
  await assert.rejects(routeFares({ token: 'failure', origin: 'JFK', destination: 'HND', departAt: date, fetchImpl }), /offline/);
  assert.equal(calls, 2); assert.equal((await apiUsage()).tpCalls - before, 2);
});

test('SerpApi coalesces lookups, records failures, and retries failures without a cache hit', async () => {
  let calls = 0; const before = (await apiUsage()).serpCalls;
  const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { ok: true, status: 200, json: async () => ({ best_flights: [] }) }; };
  const params = { apiKey: 'cache-serp', origins: ['JFK'], destinations: ['HND'], departDate: date, fetchImpl };
  await Promise.all([googleFlights(params), googleFlights(params)]); await googleFlights(params);
  assert.equal(calls, 1); assert.equal((await apiUsage()).serpCalls - before, 1);
  const fail = async () => { throw new Error('offline'); };
  for (let i = 0; i < 2; i++) await assert.rejects(googleFlights({ ...params, fetchImpl: fail }), /offline/);
  assert.equal((await apiUsage()).serpCalls - before, 3);
});

test('Google Hotels coalesces concurrent enrichment and counts failed requests at the boundary', async () => {
  const { enrichHotels } = await import('../lib/hotelinfo.mjs');
  await updateSettings({ serpApiKey: 'hotel-cache' });
  let calls = 0; const before = (await apiUsage()).serpCalls;
  globalThis.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { ok: true, status: 200, json: async () => ({ properties: [] }) }; };
  const params = { hotels: [{ name: 'Regression Test Hotel', city: 'Tokyo', program: 'hyatt' }], city: 'Tokyo', checkIn: date, checkOut: back, mode: 'single' };
  await Promise.all([enrichHotels(params), enrichHotels(params)]);
  assert.equal(calls, 1); assert.equal((await apiUsage()).serpCalls - before, 1);
  globalThis.fetch = async () => { throw new Error('hotel provider offline'); };
  await assert.rejects(enrichHotels(params), /offline/);
  assert.equal((await apiUsage()).serpCalls - before, 2);
});
