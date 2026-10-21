import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-occupancy-'));
const { normalizeStayPlan } = await import('../lib/itinerary.mjs');
const { searchHotels } = await import('../lib/search.mjs');
const { saveAwards, normalizeHotelAward } = await import('../lib/awards.mjs');
const { saveUser, updateSettings } = await import('../lib/settings.mjs');
const { searchOccupancyCashOffers } = await import('../lib/hotelinfo.mjs');
const { addStay, clearPlan, getPlan } = await import('../lib/stayplan.mjs');

const date = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('stay schema v1 migrates without changing identity and preserves user-entered occupancy evidence', async () => {
  const old = { schemaVersion: 1, stays: [{ id: 'stay1', name: 'Hotel', program: 'hyatt', checkIn: '2027-02-01', checkOut: '2027-02-03', nightlyPoints: 20000, totalPoints: 40000 }] };
  const migrated = normalizeStayPlan(old);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.stays[0].rooms, [{ adults: 2, childrenAges: [], roomType: 'standard' }]);
  const enriched = normalizeStayPlan({ schemaVersion: 2, stays: [{ ...old.stays[0], estimated: false, rooms: [{ adults: 2, childrenAges: [6], roomType: 'standard' }, { adults: 1, childrenAges: [], roomType: 'suite' }], programEvidence: { roomCount: { value: 2, source: 'program chat', date: '2026-10-21', currency: null }, taxes: { amount: 35, source: 'program chat', date: '2026-10-21', currency: 'USD' }, resortFee: { amount: null, source: 'hotel page', date: '2026-10-21', currency: 'USD', waived: true }, cancellation: { text: 'Free cancellation by local deadline', source: 'hotel page', date: '2026-10-21', currency: null } } }] });
  assert.equal(enriched.stays[0].programEvidence.roomCount.value, 2);
  assert.equal(enriched.stays[0].programEvidence.taxes.currency, 'USD');
  assert.equal(enriched.stays[0].estimated, true, 'import normalization must force multi-room stays to estimated');
  await saveUser({ balances: [] });
  await clearPlan();
  await addStay({ ...old.stays[0], estimated: false, rooms: enriched.stays[0].rooms });
  assert.equal((await getPlan()).stays[0].estimated, true, 'save normalization must force multi-room stays to estimated');
  for (const rooms of [[], Array.from({ length: 5 }, () => ({ adults: 1, childrenAges: [] })), [{ adults: 9, childrenAges: [] }], [{ adults: 1, childrenAges: Array(7).fill(4) }]]) {
    assert.throws(() => normalizeStayPlan({ schemaVersion: 2, stays: [{ ...old.stays[0], rooms }] }), { code: 'INVALID_INPUT' });
  }
});

test('room estimates multiply the observed per-room awards and fund the estimated stay total', async () => {
  const checkIn = date(180), checkOut = date(182);
  await saveUser({ balances: [{ code: 'hyatt', balance: 500000 }] });
  await saveAwards([normalizeHotelAward({ dataSource: 'manual', program: 'hyatt', hotelId: 'h-occupancy', name: 'Occupancy Hotel', city: 'Bangkok', searchLocation: 'bangkok', checkIn, roomType: 'standard', nightlyPoints: 25000, pricedNights: 2, pricedTotalPoints: 50000, capturedAt: new Date().toISOString() })]);
  const one = await searchHotels({ destination: 'Bangkok', checkIn, checkOut, rooms: [{ adults: 2, childrenAges: [], roomType: 'standard' }] }, { allowApi: false });
  assert.equal(one.rows.length, 1, JSON.stringify(one));
  assert.equal(one.rows[0].observedSingleRoomPoints, 50000);
  assert.equal(one.rows[0].totalPoints, 50000);
  assert.equal(one.rows[0].inventoryStatus, 'unknown');
  assert.equal(one.rows[0].occupancyStatus, 'unverified');
  const two = await searchHotels({ destination: 'Bangkok', checkIn, checkOut, rooms: [{ adults: 2, childrenAges: [7], roomType: 'standard' }, { adults: 2, childrenAges: [], roomType: 'standard' }] }, { allowApi: false });
  assert.equal(two.rows[0].estimatedPointsForRooms, 100000);
  assert.equal(two.rows[0].totalPoints, 100000);
  assert.equal(two.rows[0].estimated, true);
  assert.equal(two.rows[0].roomEstimateLabel, 'Estimated points for 2 rooms');
  assert.equal(two.rows[0].cashUsd, null);
});

test('flexible-date room estimates use rates for the same hotel, date, nights and room type', async () => {
  const middle = date(210), before = date(209), after = date(211), checkOut = date(212);
  await saveAwards([
    normalizeHotelAward({ id: 'flex-room-before', dataSource: 'manual', program: 'hyatt', hotelId: 'flex-hotel', name: 'Flex Hotel', city: 'Tokyo', searchLocation: 'tokyo', checkIn: before, roomType: 'standard', nightlyPoints: 25000, pricedNights: 2, pricedTotalPoints: 50000, capturedAt: new Date().toISOString() }),
    normalizeHotelAward({ id: 'flex-room-after', dataSource: 'manual', program: 'hyatt', hotelId: 'flex-hotel', name: 'Flex Hotel', city: 'Tokyo', searchLocation: 'tokyo', checkIn: after, roomType: 'standard', nightlyPoints: 50000, pricedNights: 2, pricedTotalPoints: 100000, capturedAt: new Date().toISOString() })
  ]);
  const result = await searchHotels({ destination: 'Tokyo', checkIn: middle, checkOut, flexDays: 1, rooms: [{ adults: 1, childrenAges: [], roomType: 'standard' }] }, { allowApi: false });
  const beforeRow = result.rows.find(row => row.checkIn === before);
  const afterRow = result.rows.find(row => row.checkIn === after);
  assert.equal(beforeRow.observedSingleRoomPoints, 50000);
  assert.equal(beforeRow.totalPoints, 50000);
  assert.equal(beforeRow.estimated, false);
  assert.equal(afterRow.observedSingleRoomPoints, 100000);
  assert.equal(afterRow.totalPoints, 100000);
  assert.equal(afterRow.estimated, false);
});

test('a missing requested room type is explicitly marked as a type-mismatch estimate', async () => {
  const checkIn = date(250), checkOut = date(252);
  await saveAwards([normalizeHotelAward({ id: 'only-standard-room', dataSource: 'manual', program: 'hyatt', hotelId: 'type-hotel', name: 'Type Hotel', city: 'Osaka', searchLocation: 'osaka', checkIn, roomType: 'standard', nightlyPoints: 20000, pricedNights: 2, pricedTotalPoints: 40000, capturedAt: new Date().toISOString() })]);
  const result = await searchHotels({ destination: 'Osaka', checkIn, checkOut, rooms: [{ adults: 1, childrenAges: [], roomType: 'suite' }] }, { allowApi: false });
  assert.equal(result.rows[0].roomType, 'standard');
  assert.equal(result.rows[0].roomTypeMismatch, true);
  assert.equal(result.rows[0].estimated, true);
  assert.match(result.rows[0].roomEstimateLabel, /requested suite, observed standard/);
});

test('invalid occupancy is rejected before any rooms.aero call or usage accounting', async () => {
  await updateSettings({ seatsAeroApiKey: 'pro_occupancy_test' });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }); };
  try {
    await assert.rejects(searchHotels({ destination: 'Tokyo', checkIn: date(200), rooms: [] }), { status: 400, code: 'INVALID_INPUT' });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    await updateSettings({ seatsAeroApiKey: '' });
  }
});

test('cash offers query each occupancy, cache separately and escape bounded policy text', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (!String(url).includes('property_token=')) return new Response(JSON.stringify({ properties: [{ name: 'Safe Hotel Rome', property_token: 'token-1' }] }), { status: 200 });
    return new Response(JSON.stringify({ property_token: 'token-1', featured_prices: [{ rooms: [{ num_guests: 2, total_rate: { extracted_lowest: 250, extracted_before_taxes_fees: 200 }, rates: [{ free_cancellation: false, free_cancellation_until_date: '<script>bad</script>' }] }] }] }), { status: 200 });
  };
  const input = { hotel: { name: 'Safe Hotel Rome', city: 'Rome' }, checkIn: '2027-07-01', checkOut: '2027-07-03', rooms: [{ adults: 2, childrenAges: [0], roomType: 'standard' }], currency: 'EUR', apiKey: 'test', fetchImpl };
  const first = await searchOccupancyCashOffers(input);
  assert.equal(first.length, 1);
  assert.equal(first[0].currency, 'EUR');
  assert.equal(first[0].totalBeforeTaxes, 200);
  assert.equal(first[0].totalAfterTaxes, 250);
  assert.equal(first[0].freeCancellation, false);
  assert.equal(first[0].rawPolicyText.includes('<script>'), false);
  assert.ok(urls[0].includes('adults=2'));
  assert.ok(urls[0].includes('children_ages=1'));
  await searchOccupancyCashOffers(input);
  assert.equal(urls.length, 2);
  await searchOccupancyCashOffers({ ...input, rooms: [{ adults: 2, childrenAges: [8], roomType: 'standard' }] });
  assert.equal(urls.length, 4);
});

test('cash property and actual room type must match the selected hotel location and requested room', async () => {
  let detailCalls = 0;
  const fetchImpl = async url => {
    const params = new URL(String(url)).searchParams;
    if (!params.has('property_token')) return new Response(JSON.stringify({ properties: [{ name: 'Hyatt Regency', address: params.get('q').includes('Tokyo') ? 'Paris, France' : 'Tokyo, Japan', property_token: 'wrong-city' }] }), { status: 200 });
    detailCalls++;
    return new Response(JSON.stringify({ property_token: 'room-check', featured_prices: [{ rooms: [{ name: 'Standard Room', total_rate: { extracted_lowest: 100 }, rates: [{ total_rate: { extracted_lowest: 100 } }] }] }] }), { status: 200 });
  };
  const wrongCity = await searchOccupancyCashOffers({ hotel: { name: 'Hyatt Regency', city: 'Tokyo' }, checkIn: '2027-08-01', checkOut: '2027-08-02', rooms: [{ adults: 2, childrenAges: [], roomType: 'suite' }], apiKey: 'test', fetchImpl });
  assert.deepEqual(wrongCity, []);
  assert.equal(detailCalls, 0, 'wrong-location property must not be opened');
  const standardForSuite = await searchOccupancyCashOffers({ hotel: { name: 'Hyatt Regency Tokyo', city: 'Tokyo' }, checkIn: '2027-08-02', checkOut: '2027-08-03', rooms: [{ adults: 2, childrenAges: [], roomType: 'suite' }], apiKey: 'test', fetchImpl: async url => {
    const params = new URL(String(url)).searchParams;
    if (!params.has('property_token')) return new Response(JSON.stringify({ properties: [{ name: 'Hyatt Regency Tokyo', address: 'Tokyo, Japan', property_token: 'room-check' }] }), { status: 200 });
    detailCalls++;
    return new Response(JSON.stringify({ property_token: 'room-check', featured_prices: [{ rooms: [{ name: 'Standard Room', total_rate: { extracted_lowest: 100 }, rates: [{ total_rate: { extracted_lowest: 100 } }] }] }] }), { status: 200 });
  } });
  assert.deepEqual(standardForSuite, [], 'standard offer must not be labeled as a suite');
});
