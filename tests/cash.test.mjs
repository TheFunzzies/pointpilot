import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-cash-'));
const { mapFare, routeFares } = await import('../lib/travelpayouts.mjs');
const { googleFlights } = await import('../lib/serpapi.mjs');
const { searchCash, recordFares, dealsFromAirports, cashForItinerary } = await import('../lib/cash.mjs');
const { updateSettings, apiUsage } = await import('../lib/settings.mjs');
const { createAlert, runMonitor, setNotifier } = await import('../lib/monitor.mjs');

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const DEP = inDays(60), RET = inDays(70);

// Shapes follow the Aviasales v3 prices_for_dates / v2 prices/latest and SerpApi google_flights docs.
const tpFare = (price, over = {}) => ({ origin: 'NYC', destination: 'BKK', origin_airport: 'JFK', destination_airport: 'BKK', price, airline: 'TG', flight_number: '691', departure_at: `${DEP}T10:00:00-04:00`, return_at: `${RET}T08:00:00+07:00`, transfers: 1, return_transfers: 1, duration: 1300, link: '/search/NYC0101BKK1', ...over });
let tpPrice = 900;
let googleCalls = 0;
function installFakeApis() {
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    if (u.hostname === 'api.travelpayouts.com' && u.pathname === '/aviasales/v3/prices_for_dates') {
      return { ok: true, status: 200, json: async () => ({ success: true, currency: 'usd', data: [tpFare(tpPrice), tpFare(tpPrice + 150, { return_at: `${inDays(90)}T08:00:00+07:00` })] }) };
    }
    if (u.hostname === 'api.travelpayouts.com' && u.pathname === '/v2/prices/latest') {
      return { ok: true, status: 200, json: async () => ({ success: true, data: [
        { origin: 'NYC', destination: 'LIS', depart_date: inDays(40), return_date: inDays(47), value: 290, number_of_changes: 0 },
        { origin: 'NYC', destination: 'CDG', depart_date: inDays(41), return_date: inDays(48), value: 640, number_of_changes: 0 }
      ] }) };
    }
    if (u.hostname === 'serpapi.com') {
      googleCalls++;
      return { ok: true, status: 200, json: async () => ({
        best_flights: [{ flights: [{ departure_airport: { id: 'JFK', time: `${DEP} 10:00` }, arrival_airport: { id: 'NRT' }, airline: 'ANA', flight_number: 'NH 9' }, { departure_airport: { id: 'NRT' }, arrival_airport: { id: 'BKK', time: `${DEP} 23:00` }, airline: 'ANA', flight_number: 'NH 805' }], total_duration: 1250, price: u.searchParams.get('travel_class') === '3' ? 5200 : 870 }],
        other_flights: [],
        price_insights: { lowest_price: 870, price_level: 'low', typical_price_range: [950, 1300] },
        search_metadata: { google_flights_url: 'https://www.google.com/travel/flights?tfs=abc' }
      }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

test('Travelpayouts fares map to USD per-person fares with airport codes and links', () => {
  const f = mapFare(tpFare(812));
  assert.equal(f.origin, 'JFK');
  assert.equal(f.price, 812);
  assert.equal(f.departDate, DEP);
  assert.equal(f.stops, 1);
  assert.equal(f.link, 'https://www.aviasales.com/search/NYC0101BKK1');
  assert.equal(mapFare(tpFare(812), 'rub'), null);
});

test('route search falls back to metro codes (JFK -> NYC) when airports return nothing', async () => {
  const seen = [];
  const fake = async url => { const o = new URL(url).searchParams.get('origin'); seen.push(o); return { ok: true, status: 200, json: async () => ({ success: true, currency: 'usd', data: o === 'NYC' ? [tpFare(700)] : [] }) }; };
  const r = await routeFares({ token: 't', origin: 'JFK', destination: 'BKK', departAt: DEP, fetchImpl: fake });
  assert.deepEqual(seen, ['JFK', 'NYC']);
  assert.equal(r.fares[0].price, 700);
});

test('Google Flights results include price level and typical range', async () => {
  installFakeApis();
  const g = await googleFlights({ apiKey: 'k', origins: ['JFK'], destinations: ['BKK'], departDate: DEP, returnDate: RET });
  assert.equal(g.fares[0].price, 870);
  assert.equal(g.fares[0].stops, 1);
  assert.equal(g.fares[0].airlines, 'ANA');
  assert.deepEqual(g.insights, { lowestPrice: 870, level: 'low', typicalRange: [950, 1300] });
});

test('cash search: date-window filtering, travelers, "usual price" from history, Google check', async () => {
  installFakeApis();
  await updateSettings({ travelpayoutsToken: 'tp_test', serpApiKey: 'serp_test' });
  // Price history from previous days: usual cheapest ≈ $1,200.
  for (const [ago, price] of [[5, 1180], [4, 1220], [3, 1200]]) await recordFares([{ source: 'travelpayouts', origin: 'JFK', destination: 'BKK', departDate: DEP, returnDate: RET, price }], daysAgo(ago));
  const r = await searchCash({ origins: 'JFK', destination: 'BKK', departDate: DEP, returnDate: RET, flexDays: 0, travelers: 2, useGoogle: true });
  assert.equal(r.fares.length, 2);                          // the fare returning 90 days out is outside the window
  const cheapest = r.fares[0];
  assert.equal(cheapest.price, 870);                         // Google live fare beats the cached $900
  assert.equal(cheapest.total, 1740);
  const tp = r.fares.find(f => f.source === 'travelpayouts');
  assert.equal(tp.usualPrice, 1200);
  assert.equal(tp.label, 'Lowest seen · 25% below usual');
  assert.equal(r.google.insights.level, 'low');
  assert.equal((await apiUsage()).serpCalls, 1);
});

test('points vs cash uses a cabin-aware Google price for business class', async () => {
  installFakeApis();
  const r = await cashForItinerary({ origin: 'JFK', destination: 'BKK', departDate: DEP, returnDate: RET, cabin: 'business', travelers: 2 });
  assert.equal(r.source, 'google');
  assert.equal(r.perTraveler, 5200);
  assert.equal(r.total, 10400);
});

test('cash price alert notifies once, then again only when the price drops further', async () => {
  installFakeApis();
  const notes = [];
  setNotifier(n => notes.push(n));
  await createAlert({ kind: 'cash', origins: 'JFK', destination: 'BKK', departDate: DEP, returnDate: RET, targetPrice: 1000, dealPct: 0 });
  tpPrice = 950;
  googleCalls = 0;
  let r = await runMonitor();
  assert.equal(r.results.find(x => x.kind === 'cash').isNew, true);
  assert.match(notes.at(-1).body, /\$950 JFK→BKK/);
  assert.match(notes.at(-1).body, /Google now: \$870 \(low/);
  assert.equal(googleCalls, 1);
  r = await runMonitor();
  assert.equal(r.results.find(x => x.kind === 'cash').isNew, false);   // same price: no repeat
  tpPrice = 899;
  r = await runMonitor();
  assert.equal(r.results.find(x => x.kind === 'cash').isNew, true);    // dropped further
  assert.equal(googleCalls, 1);                                         // Google verified at most once a day
});

test('airport deal watch flags fares well below their usual price, once each', async () => {
  installFakeApis();
  for (const [ago, price] of [[6, 520], [5, 560], [4, 540]]) await recordFares([{ source: 'travelpayouts', origin: 'NYC', destination: 'LIS', departDate: inDays(40), returnDate: inDays(47), price }], daysAgo(ago));
  const d = await dealsFromAirports({ airports: 'JFK' });
  const lis = d.deals.find(x => x.destination === 'LIS');
  assert.equal(lis.destinationName, 'Lisbon');
  assert.equal(lis.usualPrice, 540);
  assert.ok(lis.pctBelow > 45);
  assert.equal(d.deals[0].destination, 'LIS');                // biggest drop ranks first
  const notes = [];
  setNotifier(n => notes.push(n));
  await createAlert({ kind: 'deals', airports: 'JFK', minDropPct: 25 });
  let r = await runMonitor();
  assert.equal(r.results.find(x => x.kind === 'deals').isNew, true);
  assert.match(notes.at(-1).body, /Lisbon/);
  r = await runMonitor({ force: true });
  assert.equal(r.results.find(x => x.kind === 'deals').isNew, false);
});
