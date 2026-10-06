import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-v010-'));
const { cabinProduct } = await import('../lib/cabins.mjs');
const { parseAerolopa, parseSeatmaps } = await import('../lib/seatmaps.mjs');
const { mapAvailability } = await import('../lib/seatsaero.mjs');
const { flightOptions, evaluateSelection, searchTrip } = await import('../lib/search.mjs');
const { saveUser, exampleUser, updateSettings } = await import('../lib/settings.mjs');
const { setFlights, updateTripSettings, searchPositioning, setPositioning, getTripPlan } = await import('../lib/tripplan.mjs');
const { addStay } = await import('../lib/stayplan.mjs');
const { dealsFromAirports } = await import('../lib/cash.mjs');
const { zonedToUtc } = await import('../lib/geo.mjs');
await saveUser(exampleUser());

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DEP = inDays(90), RET = inDays(100);

test('cabin products: Qsuite, Delta One Suite, THE Room, JAL A350-1000; generic fallback', () => {
  assert.equal(cabinProduct({ carrier: 'QR', aircraftCode: '351', aircraftName: 'Airbus A350-1000', cabin: 'business' }).product, 'Qsuite');
  assert.equal(cabinProduct({ carrier: 'QR', aircraftCode: '77W', aircraftName: 'Boeing 777-300ER', cabin: 'business' }).certainty, 'varies');
  assert.equal(cabinProduct({ carrier: 'DL', aircraftName: 'Airbus A330-900', cabin: 'business' }).product, 'Delta One Suite');
  assert.equal(cabinProduct({ carrier: 'NH', aircraftCode: '77W', cabin: 'business' }).product, 'THE Room');
  assert.equal(cabinProduct({ carrier: 'JL', aircraftName: 'Airbus A350-1000', cabin: 'first' }).score, 5);
  assert.equal(cabinProduct({ carrier: 'ZZ', aircraftName: 'Boeing 787-9', cabin: 'business' }).certainty, 'generic');
  // An airline default never upgrades a regional narrow-body to "lie-flat".
  assert.equal(cabinProduct({ carrier: 'DL', aircraftName: 'Airbus A220-100', cabin: 'business' }).score, 1);
});

test('seat-map index parsing (AeroLOPA img alt text, SeatMaps link text)', () => {
  const lopa = '<a href="/qr-7d3"><img src="x" alt="Boeing 777-300ER"></a> <a href="/qr-351"><img alt="Airbus A350-1000"></a>';
  assert.deepEqual(parseAerolopa(lopa, 'qr').map(x => [x.code, x.name]), [['7d3', 'Boeing 777-300ER'], ['351', 'Airbus A350-1000']]);
  const sm = '<a href="/airlines/qr-qatar-airways/boeing-777-300er/" class="x">Boeing 777-300ER</a>';
  assert.deepEqual(parseSeatmaps(sm, '/airlines/qr-qatar-airways/'), [{ path: '/airlines/qr-qatar-airways/boeing-777-300er/', name: 'Boeing 777-300ER' }]);
});

const seg = (fn, o, d, dep, arr, ac, code) => ({ FlightNumber: fn, OriginAirport: o, DestinationAirport: d, DepartsAt: dep, ArrivesAt: arr, AircraftName: ac, AircraftCode: code });
function availability(id, origin, dest, date, miles, trips) {
  return { ID: id, Date: date, Source: 'aeroplan', Route: { OriginAirport: origin, DestinationAirport: dest }, JAvailable: true, JMileageCost: String(miles), JRemainingSeats: 4, JDirect: false,
    AvailabilityTrips: trips.map((t, i) => ({ ID: `${id}-t${i}`, Cabin: 'business', MileageCost: t.miles, TotalTaxes: 5600, TaxesCurrency: 'USD', RemainingSeats: 4, TotalDuration: t.dur, AvailabilitySegments: t.segs.map((s, k) => ({ ...s, Order: k })) })) };
}

test('each award becomes one option per flight, with seat quality from the product data', () => {
  const rec = availability('a1', 'JFK', 'BKK', DEP, 87500, [
    { miles: 87500, dur: 1265, segs: [seg('NH9', 'JFK', 'NRT', `${DEP}T15:30:00Z`, `${DEP}T05:40:00Z`.replace(DEP, inDays(91)), 'Boeing 777-300ER', '77W'), seg('NH805', 'NRT', 'BKK', `${inDays(91)}T08:35:00Z`, `${inDays(91)}T14:35:00Z`, 'Boeing 787-9', '789')] },
    { miles: 87500, dur: 1300, segs: [seg('AC15', 'JFK', 'YVR', `${DEP}T12:00:00Z`, `${DEP}T18:00:00Z`, 'Airbus A220-300', '223'), seg('AC5', 'YVR', 'BKK', `${DEP}T20:00:00Z`, `${inDays(91)}T09:40:00Z`, 'Boeing 787-9', '789')] }
  ]);
  const row = mapAvailability(rec, 'business');
  assert.equal(row.flights.length, 2);
  const opts = flightOptions([row], 'Outbound');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].flight.product.type, 'THE Room');   // same points: better seat sorts first
  assert.equal(opts[0].seatScore, 5);
  assert.equal(opts[1].flight.product.type, 'Signature Class');
  assert.equal(opts[0].totalTaxes, 56);
});

test('picking flights: evaluateSelection funds the chosen pair; unaffordable pairs explain why', async () => {
  const out = { id: 'o', leg: 'Outbound', program: 'aeroplan', mileageCost: 87500, totalTaxes: 56, cabin: 'business', origin: 'JFK', destination: 'BKK', date: DEP };
  const back = { id: 'b', leg: 'Return', program: 'flyingblue', mileageCost: 95000, totalTaxes: 210, cabin: 'business', origin: 'BKK', destination: 'JFK', date: RET };
  const r = await evaluateSelection({ legs: [out, back], travelers: 1 });
  assert.equal(r.affordable, true);
  assert.equal(r.trip.totalTargetPoints, 182500);
  const big = await evaluateSelection({ legs: [{ ...out, mileageCost: 2000000 }], travelers: 1 });
  assert.equal(big.affordable, false);
  assert.match(big.reason, /can't cover/);
});

test('local airport time converts to UTC across DST', () => {
  assert.equal(zonedToUtc('2027-01-15', '10:00', 'BOS'), '2027-01-15T15:00:00Z');
  assert.equal(zonedToUtc('2027-07-15', '10:00', 'BOS'), '2027-07-15T14:00:00Z');
});

test('trip builder: positioning BOS→JFK must land before the award departs; combined points with hotels', async () => {
  await updateSettings({ serpApiKey: 'serp', seatsAeroApiKey: '', travelpayoutsToken: '' });
  const awardOut = { id: 'o1', leg: 'Outbound', program: 'aeroplan', programName: 'Air Canada Aeroplan', mileageCost: 87500, totalTaxes: 56, cabin: 'business', origin: 'JFK', destination: 'BKK', date: DEP,
    flight: { departUtc: `${DEP}T22:00:00Z`, arriveUtc: `${inDays(91)}T14:00:00Z`, depart: { date: DEP, time: '18:00' }, arrive: { date: inDays(91), time: '21:00' }, origin: 'JFK', destination: 'BKK', flightNumbers: ['NH9'], totalDurationMin: 1200, stops: 0, layovers: [] } };
  let plan = await setFlights({ outbound: awardOut, travelers: 2 });
  assert.equal(plan.home.origin, 'JFK');
  assert.equal(plan.needs.outbound, null);                    // starts at the award airport: nothing to add
  plan = await updateTripSettings({ home: { origin: 'BOS', returnTo: 'BOS' }, buffers: { outboundHours: 3 } });
  assert.equal(plan.needs.outbound.from, 'BOS');
  assert.equal(plan.needs.outbound.latestArrivalUtc, `${DEP}T19:00:00.000Z`);
  assert.match(plan.summary.warnings.join(' '), /add a positioning flight/);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    best_flights: [
      { price: 129, total_duration: 75, flights: [{ departure_airport: { id: 'BOS', time: `${DEP} 12:00` }, arrival_airport: { id: 'JFK', time: `${DEP} 13:15` }, airline: 'JetBlue', flight_number: 'B6 518' }] },
      { price: 99, total_duration: 75, flights: [{ departure_airport: { id: 'BOS', time: `${DEP} 15:30` }, arrival_airport: { id: 'JFK', time: `${DEP} 16:45` }, airline: 'Delta', flight_number: 'DL 5432' }] }
    ] }) });
  try {
    const s = await searchPositioning({ direction: 'outbound' });
    assert.equal(s.need.from, 'BOS');
    assert.equal(s.cash[0].fits, true);                       // 13:15 EDT/EST lands before 14:00 local cutoff
    assert.equal(s.cash[0].price, 129);
    assert.equal(s.cash[1].fits, false);                      // cheaper, but lands too late
    plan = await setPositioning('outbound', { ...s.cash[0], kind: 'cash' });
  } finally { globalThis.fetch = realFetch; }
  await addStay({ name: 'Park Hyatt Bangkok', program: 'hyatt', city: 'Bangkok', checkIn: inDays(91), checkOut: inDays(94), nightlyPoints: 25000 });
  plan = await getTripPlan();
  assert.equal(plan.summary.cashUsd, 2 * 56 + 2 * 129);       // award taxes + positioning fares, both travelers
  assert.deepEqual(plan.summary.pointsByProgram.map(p => [p.program, p.points]).sort(), [['aeroplan', 175000], ['hyatt', 75000]]);
  assert.deepEqual(plan.timeline.map(t => t.type), ['positioning', 'award', 'hotel']);
  assert.ok(!plan.summary.warnings.some(w => /positioning/.test(w)));
});

test('deals: destination filter uses city codes; deals are tagged domestic or international', async () => {
  await updateSettings({ travelpayoutsToken: 'tp' });
  const realFetch = globalThis.fetch;
  const dests = [];
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    dests.push(u.searchParams.get('destination'));
    return { ok: true, status: 200, json: async () => ({ success: true, data: [
      { origin: 'BOS', destination: 'TYO', depart_date: inDays(40), return_date: inDays(50), value: 780, number_of_changes: 1 },
      { origin: 'BOS', destination: 'MIA', depart_date: inDays(30), return_date: inDays(33), value: 140, number_of_changes: 0 }
    ] }) };
  };
  try {
    const any = await dealsFromAirports({ airports: 'BOS' });
    assert.deepEqual(dests, [null]);
    assert.equal(any.deals.find(d => d.destination === 'TYO').scope, 'international');
    assert.equal(any.deals.find(d => d.destination === 'MIA').scope, 'domestic');
    assert.match(any.googleLinks.deals, /google\.com\/travel\/flights\/deals/);
    dests.length = 0;
    await dealsFromAirports({ airports: 'BOS', destination: 'Tokyo' });
    assert.deepEqual(dests, ['TYO']);                          // HND+NRT collapse to the TYO city code
  } finally { globalThis.fetch = realFetch; }
});
