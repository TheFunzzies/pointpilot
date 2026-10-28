import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-simplefin-server-'));
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
const { startServer, setSimpleFinCredentialStore } = await import('../server.mjs');
const nativeFetch = globalThis.fetch;
const storage = { accessUrl: null, isAvailable: () => true, async read() { return this.accessUrl; }, async save(value) { this.accessUrl = value; }, async remove() { this.accessUrl = null; } };
setSimpleFinCredentialStore(storage);
const claimUrl = 'https://bridge.simplefin.org/simplefin/claim/one-time-secret';
const token = Buffer.from(claimUrl).toString('base64');
const accessUrl = 'https://pointpilot_user:private_access_password@bridge.simplefin.org/simplefin';
let providerRequests = [];
globalThis.fetch = async (url, options = {}) => {
  providerRequests.push({ url: String(url), options });
  if (String(url) === claimUrl) return { ok: true, status: 200, headers: new Headers(), text: async () => accessUrl };
  if (String(url).startsWith('https://bridge.simplefin.org/simplefin/accounts?')) return {
    ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ errlist: [], connections: [{ conn_id: 'conn-1', name: 'Rewards institution' }], accounts: [
      { id: 'points-1', conn_id: 'conn-1', name: 'Membership Rewards', currency: 'https://currency.example/mr', balance: '42000', 'balance-date': 1790000000 },
      { id: 'cash-1', conn_id: 'conn-1', name: 'Card balance', currency: 'USD', balance: '-125.50', 'balance-date': 1790000000 }
    ] })
  };
  throw new Error('Unexpected provider request');
};
const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
const port = server.address().port;
test.after(() => { globalThis.fetch = nativeFetch; server.close(); });

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('SimpleFIN claims and encryptable storage receives access URL while APIs expose only mapped reward accounts', async () => {
  providerRequests = [];
  const connected = await request('POST', '/api/simplefin/connect', { token });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.connected, true);
  assert.equal(connected.body.accounts.length, 2);
  assert.equal(connected.body.accounts.find(a => a.name === 'Membership Rewards').rewardsCurrency, true);
  assert.equal(connected.body.accounts.find(a => a.name === 'Card balance').rewardsCurrency, false);
  assert.equal(JSON.stringify(connected.body).includes('private_access_password'), false);
  assert.equal(storage.accessUrl, accessUrl);
  assert.equal(providerRequests.length, 2);
  assert.equal(providerRequests[1].options.headers.Authorization, 'Basic ' + Buffer.from('pointpilot_user:private_access_password').toString('base64'));
  assert.equal(providerRequests[1].options.redirect, 'manual');
  assert.match(providerRequests[1].url, /balances-only=1/);
  assert.match(providerRequests[1].url, /version=2/);
  assert.doesNotMatch(providerRequests[1].url, /private_access_password/);
});

test('SimpleFIN mapping sync changes only mapped wallet programs and disconnect leaves points intact', async () => {
  const accounts = (await request('GET', '/api/simplefin')).body.accounts;
  const rewards = accounts.find(a => a.rewardsCurrency);
  const mapped = await request('PUT', '/api/simplefin/mappings', { mappings: [{ key: rewards.key, program: 'amex' }] });
  assert.equal(mapped.status, 200);
  await request('PUT', '/api/user', { balances: [{ program: 'amex', balance: 1000, cpp: 1.75 }, { program: 'united', balance: 23000, cpp: 1.2 }], preferences: {} });
  const synced = await request('POST', '/api/simplefin/sync', {});
  assert.equal(synced.status, 200);
  assert.equal(synced.body.user.balances.find(b => b.code === 'amex').balance, 42000);
  assert.equal(synced.body.user.balances.find(b => b.code === 'amex').cpp, 1.75);
  assert.equal(synced.body.user.balances.find(b => b.code === 'united').balance, 23000);
  const disconnected = await request('DELETE', '/api/simplefin', {});
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.body.connected, false);
  assert.equal(storage.accessUrl, null);
  const wallet = await request('GET', '/api/user');
  assert.equal(wallet.body.balances.find(b => b.code === 'amex').balance, 42000);
});
