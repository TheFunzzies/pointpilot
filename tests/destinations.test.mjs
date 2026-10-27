import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDestinations } from '../lib/destinations.mjs';

const query = { origins: 'JFK', destinations: ['LHR', 'CDG'], departDate: '2027-06-05' };
const unusedSearch = async () => { throw new Error('search should not be called'); };

test('destination discovery rejects malformed containers, bounds and strings before searching', async () => {
  const invalid = [
    null,
    [],
    { ...query, origins: '' },
    { ...query, origins: ['JFK'] },
    { ...query, origins: 'x'.repeat(1001) },
    { ...query, destinations: 'LHR' },
    { ...query, destinations: [] },
    { ...query, destinations: Array(9).fill('LHR') },
    { ...query, destinations: [''] },
    { ...query, destinations: ['   '] },
    { ...query, destinations: [42] },
    { ...query, destinations: ['x'.repeat(161)] },
    { ...query, destination: 'LHR' }
  ];
  for (const input of invalid) await assert.rejects(searchDestinations(input, { search: unusedSearch }), { status: 400, code: 'INVALID_INPUT' });
});

test('destination discovery forwards trip fields, preserves order and caps concurrency per destination', async () => {
  const destinations = ['LHR', 'CDG', 'HND', 'LIS', 'SYD'];
  const calls = [];
  let active = 0, maximum = 0;
  const search = async (params, options) => {
    calls.push({ params, options });
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { mode: 'results', marker: params.destination, dataStatus: { api: 'fetched', warnings: [] }, truncated: false };
  };
  const response = await searchDestinations({
    origins: ' JFK, BOS ', destinations, departDate: '2027-06-05', returnDate: '2027-06-12',
    flexDays: 3, cabin: 'business', travelers: 2, nonstopOnly: true, preserveFlexible: true, rank: 'points'
  }, { search });

  assert.equal(calls.length, destinations.length);
  assert.ok(maximum <= 2);
  assert.deepEqual(response.results.map(entry => entry.destination), destinations);
  assert.deepEqual(response.results.map(entry => entry.result.marker), destinations);
  assert.ok(response.results.every(entry => entry.error === null));
  assert.ok(calls.every(({ params, options }) => options.allowApi === true && params.origins === 'JFK, BOS' && !('destinations' in params) &&
    params.departDate === '2027-06-05' && params.returnDate === '2027-06-12' && params.flexDays === 3 &&
    params.cabin === 'business' && params.travelers === 2 && params.nonstopOnly === true && params.preserveFlexible === true && params.rank === 'points'));
  assert.deepEqual(response.limits, { maxDestinations: 8, concurrency: 2, maxProviderCallsPerDestination: 6, maxProviderCallsTotal: 30 });
  assert.match(response.warnings[0], /30 total/);
});

test('destination discovery exposes source and thrown errors without calling them no inventory', async () => {
  const search = async ({ destination }) => {
    if (destination === 'Atlantis') throw Object.assign(new Error('"Atlantis" is not a known place.'), { code: 'UNKNOWN_PLACE', status: 400 });
    if (destination === 'CDG') return {
      mode: 'no-inventory', outbound: [], return: [], counts: { outbound: 0, return: 0 },
      dataStatus: { api: 'error', warnings: ['seats.aero daily API limit reached.'] },
      truncated: true, truncatedReason: 'API page limit reached'
    };
    return { mode: 'no-inventory', outbound: [], dataStatus: { api: 'not-configured', warnings: [] }, truncated: false };
  };
  const { results } = await searchDestinations({ ...query, destinations: ['CDG', 'Atlantis', 'LHR'] }, { search });

  assert.equal(results[0].result.mode, 'error');
  assert.equal(results[0].result.truncated, true);
  assert.equal(results[0].result.dataStatus.warnings[0], 'seats.aero daily API limit reached.');
  assert.deepEqual(results[0].error, { code: 'API_ERROR', message: 'Availability refresh failed; any retained options are cached.' });
  assert.equal(results[1].result, null);
  assert.deepEqual(results[1].error, { code: 'UNKNOWN_PLACE', message: '"Atlantis" is not a known place.' });
  assert.equal(results[2].result.mode, 'no-inventory');
  assert.equal(results[2].error, null);
});

test('destination discovery preserves cached results during a source failure and supports cache-only searches', async () => {
  const cached = {
    mode: 'results', outbound: [{ id: 'cached' }], recommended: { trip: { id: 'cached' } },
    dataStatus: { api: 'error', warnings: ['offline'] }, truncated: false
  };
  let options;
  const response = await searchDestinations(query, {
    allowApi: false,
    search: async (_params, received) => { options = received; return cached; }
  });
  assert.deepEqual(options, { allowApi: false });
  assert.equal(response.results[0].result.mode, 'results');
  assert.deepEqual(response.results[0].result.recommended, cached.recommended);
  assert.equal(response.results[0].error.code, 'API_ERROR');
  assert.equal(response.limits.maxProviderCallsPerDestination, 0);
  assert.equal(response.limits.maxProviderCallsTotal, 0);
  assert.deepEqual(response.warnings, []);
});
