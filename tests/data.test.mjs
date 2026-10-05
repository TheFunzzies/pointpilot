import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-test-'));
process.env.POINTPILOT_DATA_DIR = dir;

const { updateJson, readJson, clearStoreCache } = await import('../lib/store.mjs');
const { resolveAirports } = await import('../lib/places.mjs');
const { programId, normalizeCabin } = await import('../lib/programs.mjs');
const { recordAwards, loadHistory } = await import('../lib/history.mjs');
const { mapAvailability, searchSeatsAero } = await import('../lib/seatsaero.mjs');
const { validateTransferData } = await import('../lib/reference.mjs');

test('concurrent updates are not lost', async () => {
  const file = path.join(dir, 'counter.json');
  await Promise.all(Array.from({ length: 50 }, () => updateJson(file, { n: 0 }, v => { v.n++; })));
  clearStoreCache();
  assert.equal((await readJson(file, null)).n, 50);
});

test('a corrupt file is moved aside, not silently reused', async () => {
  const file = path.join(dir, 'broken.json');
  writeFileSync(file, '{not json');
  clearStoreCache();
  assert.deepEqual(await readJson(file, []), []);
  assert.ok(readdirSync(dir).some(f => f.startsWith('broken.json.corrupt-')));
});

test('destinations resolve and unknown names are rejected instead of becoming Thailand', () => {
  assert.deepEqual(resolveAirports('Tokyo'), ['NRT', 'HND']);
  assert.deepEqual(resolveAirports('lis, Tokyo'), ['LIS', 'NRT', 'HND']);
  assert.deepEqual(resolveAirports('Lisbon'), ['LIS']);
  assert.throws(() => resolveAirports('Atlantis'), /isn't a known place/);
});

test('program and cabin aliases normalize', () => {
  assert.equal(programId('Flying Blue'), 'flyingblue');
  assert.equal(programId('Amex MR'), 'amex');
  assert.equal(programId('KrisFlyer'), 'singapore');
  assert.equal(programId('nonsense program'), null);
  assert.equal(normalizeCabin('J'), 'business');
  assert.equal(normalizeCabin('Premium Economy'), 'premium');
});

test('history ignores repeat sightings of the same price on the same day', async () => {
  const row = { program: 'aeroplan', product: 'flight', origin: 'JFK', destination: 'BKK', date: '2027-03-01', cabin: 'business', mileageCost: 87500, capturedAt: '2026-10-05T10:00:00Z' };
  const before = (await loadHistory()).length;
  await recordAwards([row]);
  await recordAwards([{ ...row, capturedAt: '2026-10-05T18:00:00Z' }]);
  assert.equal((await loadHistory()).length, before + 1);
  await recordAwards([{ ...row, capturedAt: '2026-10-06T10:00:00Z' }]);
  assert.equal((await loadHistory()).length, before + 2);
});

const SAMPLE = {
  ID: 'abc', Date: '2027-03-02', Source: 'aeroplan', UpdatedAt: '2026-10-05T01:00:00Z',
  Route: { OriginAirport: 'JFK', DestinationAirport: 'BKK', Source: 'aeroplan' },
  JAvailable: true, JMileageCost: '87500', JRemainingSeats: 2, JAirlines: 'NH', JDirect: false, JTotalTaxes: 5610, TaxesCurrency: 'USD',
  YAvailable: false, YMileageCost: '0'
};

test('seats.aero records map to award rows (taxes cents -> USD)', () => {
  const row = mapAvailability(SAMPLE, 'business');
  assert.equal(row.program, 'aeroplan');
  assert.equal(row.mileageCost, 87500);
  assert.equal(row.totalTaxes, 56.1);
  assert.equal(row.remainingSeats, 2);
  assert.equal(row.direct, false);
  assert.equal(mapAvailability(SAMPLE, 'economy'), null);
  assert.equal(mapAvailability({ ...SAMPLE, TaxesCurrency: 'CAD' }, 'business').totalTaxes, null);
});

test('seats.aero search paginates and reports auth errors', async () => {
  const calls = [];
  const fake = async url => {
    calls.push(url);
    const page = calls.length;
    return { ok: true, status: 200, json: async () => ({ data: [SAMPLE], hasMore: page < 2, cursor: 99 }) };
  };
  const r = await searchSeatsAero({ apiKey: 'k', origins: ['JFK'], destinations: ['BKK'], start: '2027-03-01', end: '2027-03-05', cabin: 'business', fetchImpl: fake });
  assert.equal(r.calls, 2);
  assert.equal(r.rows.length, 2);
  assert.match(calls[1], /cursor=99/);
  await assert.rejects(searchSeatsAero({ apiKey: 'bad', origins: ['JFK'], destinations: ['BKK'], start: 'a', end: 'b', cabin: 'business', fetchImpl: async () => ({ ok: false, status: 401 }) }), /rejected the API key/);
});

test('bundled transfer data passes validation; bad remote data is rejected', () => {
  const bundled = JSON.parse(readFileSync(new URL('../reference/transfer-partners.json', import.meta.url), 'utf8'));
  assert.equal(validateTransferData(bundled), null);
  assert.match(validateTransferData({ ...bundled, schemaVersion: 1 }), /schemaVersion/);
  const bad = structuredClone(bundled); bad.programs.united.transfers.chase.ratio = [1, 0];
  assert.match(validateTransferData(bad), /bad ratio/);
  assert.ok(existsSync(dir));
});
