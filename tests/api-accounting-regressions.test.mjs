import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-api-attempts-'));
const { searchSeatsAero } = await import('../lib/seatsaero.mjs');
const { searchRoomsAero } = await import('../lib/roomsaero.mjs');
const { getTrips, getTripsCached } = await import('../lib/flights.mjs');
const { searchTrip, searchHotels, expandAwards } = await import('../lib/search.mjs');
const { apiUsage, updateSettings } = await import('../lib/settings.mjs');
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const args = { apiKey: 'attempt-key', origins: ['JFK'], destinations: ['LHR'], start: day(80), end: day(80), cabin: 'business', location: 'Tokyo' };
const response = body => ({ ok: true, status: 200, json: async () => body });
const fail = async () => ({ ok: false, status: 500 });

for (const [name, search, usageKey, page] of [
  ['seats', searchSeatsAero, 'calls', more => ({ data: [{}], hasMore: more, cursor: more ? 'next' : null })],
  ['rooms', searchRoomsAero, 'roomsCalls', more => ({ data: [{}], has_more: more })],
]) {
  test(`${name}: HTTP 500 records exactly one attempted request`, async () => {
    const before = (await apiUsage())[usageKey];
    await assert.rejects(search({ ...args, fetchImpl: fail }), { calls: 1, code: 'API_ERROR' });
    assert.equal((await apiUsage())[usageKey] - before, 1);
  });
  test(`${name}: successful pagination and failure on page two each count two attempts`, async () => {
    for (const fails of [false, true]) {
      const before = (await apiUsage())[usageKey];
      let attempted = 0;
      const work = search({ ...args, fetchImpl: async () => {
        attempted++;
        return attempted === 2 && fails ? fail() : response(page(attempted === 1));
      } });
      if (fails) await assert.rejects(work, { calls: 2 });
      else assert.equal((await work).calls, 2);
      assert.equal(attempted, 2);
      assert.equal((await apiUsage())[usageKey] - before, 2);
    }
  });
}

test('trip details: direct and cached failures count once; cached success and concurrent calls avoid duplicates', async () => {
  let before = (await apiUsage()).calls;
  await assert.rejects(getTrips({ ...args, availabilityId: 'direct-failure', fetchImpl: fail }), { code: 'API_ERROR' });
  assert.equal((await apiUsage()).calls - before, 1);
  let observed = 0;
  before = (await apiUsage()).calls;
  await assert.rejects(getTripsCached({ ...args, availabilityId: 'cached-failure', fetchImpl: fail }, n => { observed += n; }));
  assert.equal(observed, 1);
  assert.equal((await apiUsage()).calls - before, 1);
  before = (await apiUsage()).calls;
  let attempted = 0;
  const query = { ...args, availabilityId: 'cached-success', fetchImpl: async () => { attempted++; return response({ data: [] }); } };
  await Promise.all([getTripsCached(query), getTripsCached(query)]);
  await getTripsCached(query);
  assert.equal(attempted, 1);
  assert.equal((await apiUsage()).calls - before, 1);
});

test('search and expansion statuses include failed attempts without double counting usage', async () => {
  await updateSettings({ seatsAeroApiKey: 'status-key' });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = fail;
  try {
    let before = (await apiUsage()).calls;
    const flight = await searchTrip({ origins: 'JFK', destination: 'LHR', departDate: day(100) });
    assert.equal(flight.dataStatus.calls, 1);
    assert.equal((await apiUsage()).calls - before, 1);
    before = (await apiUsage()).roomsCalls;
    const hotel = await searchHotels({ destination: 'Tokyo', checkIn: day(100) });
    assert.equal(hotel.dataStatus.calls, 1);
    assert.equal((await apiUsage()).roomsCalls - before, 1);
    before = (await apiUsage()).calls;
    const details = await expandAwards({ awards: [{ id: 'expand-failure', availabilityId: 'expand-failure', cabin: 'business' }] });
    assert.equal(details.dataStatus.calls, 1);
    assert.equal((await apiUsage()).calls - before, 1);
  } finally { globalThis.fetch = nativeFetch; }
});
