import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-v09-'));
const { mapTrip, getTripsCached } = await import('../lib/flights.mjs');
const { describe } = await import('../lib/geo.mjs');
const { resolveAirports } = await import('../lib/places.mjs');
const { searchHotels, splitCities } = await import('../lib/search.mjs');
const { addStay, getPlan, removeStay } = await import('../lib/stayplan.mjs');
const { dealsFromAirports } = await import('../lib/cash.mjs');
const { updateSettings, saveUser, exampleUser, apiUsage } = await import('../lib/settings.mjs');
await saveUser(exampleUser());

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// seats.aero Get Trips shape (times in UTC).
const TRIP = {
  ID: 't1', Cabin: 'business', MileageCost: 87500, TotalTaxes: 5610, TaxesCurrency: 'USD', RemainingSeats: 2, TotalDuration: 1265,
  AvailabilitySegments: [
    { Order: 0, FlightNumber: 'NH9', OriginAirport: 'JFK', DestinationAirport: 'NRT', DepartsAt: '2027-03-05T15:30:00Z', ArrivesAt: '2027-03-06T05:40:00Z', AircraftName: 'Boeing 777-300ER', AircraftCode: '77W', FareClass: 'I' },
    { Order: 1, FlightNumber: 'NH805', OriginAirport: 'NRT', DestinationAirport: 'BKK', DepartsAt: '2027-03-06T08:35:00Z', ArrivesAt: '2027-03-06T14:35:00Z', AircraftName: 'Boeing 787-9', AircraftCode: '789' }
  ]
};

test('trip details: local times, next-day arrival, layover, aircraft and seat expectations', () => {
  const t = mapTrip(TRIP, { cabin: 'business' });
  assert.equal(t.depart.time, '10:30');                 // 15:30Z = 10:30 New York (EST)
  assert.equal(t.depart.date, '2027-03-05');
  assert.equal(t.arrive.time, '21:35');                 // 14:35Z = 21:35 Bangkok
  assert.equal(t.arriveDayOffset, 1);                   // lands the next day
  assert.equal(t.segments[0].arrive.time, '14:40');     // 05:40Z = 14:40 Tokyo
  assert.equal(t.layovers[0].airport, 'NRT');
  assert.equal(t.layovers[0].city, 'Tokyo');
  assert.equal(t.layovers[0].durationMin, 175);         // 2h 55m
  assert.equal(t.totalDurationMin, 1265);
  assert.equal(t.taxes, 56.1);
  assert.deepEqual(t.flightNumbers, ['NH9', 'NH805']);
  assert.equal(t.segments[0].airline, 'All Nippon Airways');
  assert.equal(t.segments[0].aircraft, 'Boeing 777-300ER');
  assert.match(t.segments[0].seat.type, /Lie-flat/);
  assert.match(t.segments[0].seatMaps.aerolopa, /aerolopa\.com/);
});

test('trip details are fetched once and cached; booking links and cabin filter applied', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    assert.match(url, /\/partnerapi\/trips\/avail-1$/);
    return { ok: true, status: 200, json: async () => ({ data: [TRIP, { ...TRIP, ID: 't2', Cabin: 'economy' }], booking_links: [{ label: 'Book on Air Canada', link: 'https://www.aircanada.com/x', primary: true }, { label: 'bad', link: 'javascript:alert(1)' }] }) };
  };
  let recorded = 0;
  const a = await getTripsCached({ apiKey: 'k', availabilityId: 'avail-1', cabin: 'business', fetchImpl }, async n => { recorded += n; });
  const b = await getTripsCached({ apiKey: 'k', availabilityId: 'avail-1', cabin: 'business', fetchImpl }, async n => { recorded += n; });
  assert.equal(a.trips.length, 1);
  assert.equal(a.bookingLinks.length, 1);
  assert.equal(b.cached, true);
  assert.equal(calls, 1);
  assert.equal(recorded, 1);
});

test('places: any city with an airport works, metro codes expand, labels include the country', () => {
  assert.deepEqual(resolveAirports('Hanoi'), ['HAN']);
  assert.deepEqual(resolveAirports('TYO').sort(), ['HND', 'NRT']);
  assert.deepEqual(resolveAirports('BKK'), ['BKK']);
  assert.equal(describe('LIS').label, 'Lisbon, Portugal');
  assert.equal(describe('TYO').label, 'Tokyo, Japan');
  assert.equal(splitCities('Tokyo, Kyoto and Osaka').join('|'), 'Tokyo|Kyoto|Osaka');
});

const hotel = (id, name, city, source, points, cat, nights = 1) => ({
  hotel: { id, source, name, award_category: cat, city, country: 'Japan', url: `https://example.com/${id}` },
  lowest_award_standard: points, lowest_cash_standard: 0, currency_code: 'JPY', standard_date: null, standard_nights: nights, cpp: 1.5, lowest_award_suite: 0
});

test('multi-city hotel search: each city searched separately, compared side by side, categories kept', async () => {
  await updateSettings({ seatsAeroApiKey: 'pro_test' });
  const checkIn = inDays(60);
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    seen.push(u.searchParams.get('location'));
    const loc = u.searchParams.get('location');
    // rooms.aero reports standard_nights=1 even though we asked for 2: rows must still be used.
    const data = loc === 'Tokyo'
      ? [hotel('h1', 'Park Hyatt Tokyo', 'Tokyo', 'hyatt', 70000, '7', 2), hotel('h2', 'Hyatt Regency Tokyo', 'Tokyo', 'hyatt', 30000, '4', 1)]
      : [hotel('h3', 'Park Hyatt Kyoto', 'Kyoto', 'hyatt', 90000, '8', 2)];
    return { ok: true, status: 200, json: async () => ({ data: data.map(d => ({ ...d, standard_date: checkIn })), has_more: false }) };
  };
  try {
    const r = await searchHotels({ destination: 'Tokyo, Kyoto', checkIn, checkOut: inDays(62), flexDays: 0 });
    assert.deepEqual(seen, ['Tokyo', 'Kyoto']);
    assert.deepEqual(r.query.cities, ['Tokyo', 'Kyoto']);
    assert.equal(r.cities.length, 2);
    assert.equal(r.rows.filter(h => h.city === 'Tokyo').length, 2);
    const regency = r.rows.find(h => h.name === 'Hyatt Regency Tokyo');
    assert.equal(regency.category, '4');
    assert.equal(regency.nightlyPoints, 30000);          // priced per night by the API's own nights
    assert.equal(regency.totalPoints, 60000);            // 2-night stay
    assert.equal(r.cities[0].cheapest.name, 'Hyatt Regency Tokyo');
    assert.equal((await apiUsage()).roomsCalls, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('stay plan: stays are ordered, totaled, funded together, and gaps are flagged', async () => {
  const d = n => inDays(60 + n);
  await addStay({ name: 'Park Hyatt Kyoto', program: 'hyatt', city: 'Kyoto', category: '8', checkIn: d(2), checkOut: d(4), nightlyPoints: 45000, cashPerNight: 900 });
  let plan = await addStay({ name: 'Hyatt Regency Tokyo', program: 'hyatt', city: 'Tokyo', category: '4', checkIn: d(0), checkOut: d(2), nightlyPoints: 15000, cashPerNight: 300 });
  assert.deepEqual(plan.stays.map(s => s.city), ['Tokyo', 'Kyoto']);
  assert.equal(plan.summary.totalPoints, 120000);
  assert.equal(plan.summary.nights, 4);
  assert.equal(plan.summary.cashUsd, 2400);
  assert.equal(plan.summary.cpp, 2);
  assert.equal(plan.summary.nextCheckIn, d(4));
  assert.ok(plan.summary.affordable);                    // 30k Hyatt + Chase/Bilt transfers in the example wallet
  assert.deepEqual(plan.summary.funding.sources.map(s => s.from).sort(), ['bilt', 'chase', 'hyatt'].filter(x => plan.summary.funding.sources.some(s => s.from === x)).sort());
  assert.equal(plan.summary.warnings.length, 0);
  plan = await addStay({ name: 'Conrad Osaka', program: 'hilton', city: 'Osaka', checkIn: d(6), checkOut: d(7), nightlyPoints: 80000 });
  assert.match(plan.summary.warnings[0], /Gap: no hotel for 2 night/);
  assert.equal(plan.summary.cashUsd, null);              // one stay has no cash price
  plan = await removeStay(plan.stays[2].id);
  assert.equal(plan.stays.length, 2);
  assert.equal((await getPlan()).stays.length, 2);
});

test('business-class deals use trip_class=1 and are labeled with city and country', async () => {
  await updateSettings({ travelpayoutsToken: 'tp' });
  const realFetch = globalThis.fetch;
  let tripClass;
  globalThis.fetch = async url => {
    tripClass = new URL(String(url)).searchParams.get('trip_class');
    return { ok: true, status: 200, json: async () => ({ success: true, data: [{ origin: 'NYC', destination: 'LIS', depart_date: inDays(40), return_date: inDays(47), value: 2100, number_of_changes: 0 }] }) };
  };
  try {
    const r = await dealsFromAirports({ airports: 'JFK', cabin: 'business' });
    assert.equal(tripClass, '1');
    assert.equal(r.deals[0].destinationName, 'Lisbon');
    assert.equal(r.deals[0].destinationCountry, 'Portugal');
    assert.equal(r.deals[0].cabin, 'business');
    assert.equal(r.deals[0].originName, 'New York, United States');
  } finally { globalThis.fetch = realFetch; }
});
