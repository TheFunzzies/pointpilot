import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-hotels-'));
const { mapHotelResult, searchRoomsAero } = await import('../lib/roomsaero.mjs');
const { updateSettings, apiUsage, saveUser, exampleUser } = await import('../lib/settings.mjs');
await saveUser(exampleUser());
const { searchHotels } = await import('../lib/search.mjs');
const { createAlert, runMonitor, setNotifier } = await import('../lib/monitor.mjs');

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const CHECKIN = inDays(90);

// Shape per https://developers.seats.aero/reference/rooms-search
const result = (over = {}) => ({
  hotel: { id: 'h1', source: 'hyatt', name: 'Park Hyatt Bangkok', award_category: '6', city: 'Bangkok', country: 'Thailand', url: 'https://www.hyatt.com/park-hyatt/bkkph' },
  lowest_award_standard: 75000, lowest_cash_standard: 120000, currency_code: 'USD', standard_date: CHECKIN, standard_nights: 3,
  lowest_award_suite: 150000, lowest_cash_suite: 300000, suite_date: CHECKIN, suite_nights: 3,
  cpp: 1.6, last_checked_at: '2026-10-05T00:00:00Z',
  ...over
});

test('rooms.aero results map to per-night hotel rows (stay totals, cents -> USD)', () => {
  const [std, suite] = mapHotelResult(result(), { searchLocation: 'Bangkok', stayNights: 3 });
  assert.equal(std.program, 'hyatt');
  assert.equal(std.nightlyPoints, 25000);              // 75,000 for 3 nights
  assert.equal(std.cashValue, 400);                     // cpp 1.6 * 75,000 / 100 / 3
  assert.equal(std.roomType, 'standard');
  assert.equal(std.bookingUrl, 'https://www.hyatt.com/park-hyatt/bkkph');
  assert.equal(std.estimated, false);
  assert.equal(suite.nightlyPoints, 50000);
  assert.equal(suite.cashValue, 1000);                  // 300,000 cents / 3 nights
});

test('non-USD cash without cpp is left unknown; long stays are flagged estimated', () => {
  const [row] = mapHotelResult(result({ cpp: 0, currency_code: 'THB', lowest_award_suite: 0 }), { searchLocation: 'Bangkok', stayNights: 7 });
  assert.equal(row.cashValue, null);
  assert.equal(row.estimated, true);
});

test('rooms.aero search paginates, dedupes and reports auth errors', async () => {
  const urls = [];
  const fake = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: [result()], has_more: urls.length < 2 }) }; };
  const r = await searchRoomsAero({ apiKey: 'pro_x', location: 'Bangkok', start: CHECKIN, end: CHECKIN, stayNights: 9, fetchImpl: fake });
  assert.equal(r.calls, 2);
  assert.equal(r.rows.length, 2);                       // same hotel twice -> deduped (standard + suite)
  assert.match(urls[0], /nights=5/);                    // API max is 5 nights
  assert.match(urls[1], /skip=500/);
  await assert.rejects(searchRoomsAero({ apiKey: 'bad', location: 'x', start: CHECKIN, end: CHECKIN, fetchImpl: async () => ({ ok: false, status: 401 }) }), /rejected the API key/);
});

test('hotel search end to end: live API rows, funding from Chase -> Hyatt, separate quota', async () => {
  await updateSettings({ seatsAeroApiKey: 'pro_test' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /^https:\/\/rooms\.aero\/partnerapi\/search\?/);
    return { ok: true, status: 200, json: async () => ({ data: [result(), result({ hotel: { id: 'h2', source: 'hilton', name: 'Conrad Bangkok', city: 'Bangkok', country: 'Thailand' }, lowest_award_standard: 150000, cpp: 0.5, lowest_award_suite: 0 })], has_more: false }) };
  };
  try {
    const r = await searchHotels({ destination: 'Bangkok', checkIn: CHECKIN, checkOut: inDays(93), flexDays: 0, roomType: 'standard' });
    assert.equal(r.nights, 3);
    assert.equal(r.dataStatus.api, 'fetched');
    const hyatt = r.rows.find(h => h.program === 'hyatt');
    assert.equal(hyatt.totalPoints, 75000);
    assert.ok(hyatt.affordable);                         // sample wallet: 30k Hyatt + Chase UR transfers
    assert.deepEqual(hyatt.funding.sources.map(s => s.from), ['hyatt', 'chase']);
    // Ranked by points value spent: Conrad (150k Hilton ≈ 58k Amex via 1:2 + 30% bonus) beats Hyatt.
    assert.equal(r.rows[0].program, 'hilton');
    assert.deepEqual(r.rows[0].funding.sources.map(s => [s.from, s.fromPoints]), [['amex', 58000]]);
    assert.ok(r.rows[0].effectiveCostUsd <= r.rows[1].effectiveCostUsd);
    assert.equal(r.rows.every(h => h.roomType === 'standard'), true);
    assert.equal((await apiUsage()).roomsCalls, 1);
    assert.equal((await apiUsage()).calls, 0);

    // Same query within the refresh window is served from cache (no extra API call).
    await searchHotels({ destination: 'Bangkok', checkIn: CHECKIN, checkOut: inDays(93) });
    assert.equal((await apiUsage()).roomsCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('hotel alerts notify when a stay under the points limit appears', async () => {
  const notes = [];
  setNotifier(n => notes.push(n));
  await createAlert({ kind: 'hotel', destination: 'Bangkok', checkIn: CHECKIN, checkOut: inDays(93), maxPointsPerNight: 30000 });
  const r = await runMonitor();
  const hotel = r.results.find(x => x.title.includes('Bangkok'));
  assert.equal(hotel.isNew, true);
  assert.match(notes[0].body, /Park Hyatt Bangkok/);
  const again = await runMonitor();
  assert.equal(again.results.find(x => x.title.includes('Bangkok')).isNew, false); // no repeat notification
});
