import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-hotel-occupancy-http-'));
process.env.POINTPILOT_DATA_DIR = dir;
const realFetch = globalThis.fetch;
let server;
let port;
test.before(async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const { startServer } = await import('../server.mjs');
  port = await new Promise(resolve => { server = startServer({ port: 0, monitor: false, onReady: resolve }); });
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  globalThis.fetch = realFetch;
  await new Promise(resolve => setTimeout(resolve, 100));
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('hotel search HTTP accepts explicit room allocations and rejects out-of-bounds occupancy', async () => {
  const call = async body => {
    const response = await realFetch(`http://127.0.0.1:${port}/api/search/hotels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  const valid = await call({ destination: 'Bangkok', checkIn: '2027-06-01', checkOut: '2027-06-03', rooms: [{ adults: 2, childrenAges: [8], roomType: 'standard' }, { adults: 1, childrenAges: [], roomType: 'suite' }] });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.payload.query.rooms.map(r => [r.adults, r.childrenAges.length, r.roomType]), [[2, 1, 'standard'], [1, 0, 'suite']]);
  assert.equal((await call({ destination: 'Bangkok', checkIn: '2027-06-01', rooms: Array(5).fill({ adults: 1, childrenAges: [] }) })).status, 400);
});

