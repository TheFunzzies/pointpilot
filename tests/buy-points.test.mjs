import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { quotePointPurchases } from '../lib/buy-points.mjs';
import { validateSettings } from '../lib/settings.mjs';

const offer = {
  program: 'united', pricePerPointCents: 1.8, minimumPurchase: 10000,
  purchaseIncrement: 5000, offerEnds: '2027-01-31',
  offerUrl: 'https://www.united.com/mileageplus/buy-miles', notes: '100% bonus'
};

test('buy-points quote applies direct program balance, traveler count, minimum, and increments', () => {
  const quote = quotePointPurchases({ travelers: 2, legs: [
    { program: 'united', mileageCost: 20000, totalTaxes: 25 },
    { program: 'united', mileageCost: 20000, totalTaxes: 25 }
  ] }, { balances: [{ code: 'united', balance: 10000 }, { code: 'chase', balance: 100000 }], offers: [offer], today: '2026-10-27' });
  assert.equal(quote.totalPointsNeeded, 80000);
  assert.equal(quote.totalPointsShort, 70000);
  assert.equal(quote.totalPointsToBuy, 70000);
  assert.equal(quote.purchaseCostUsd, 1260);
  assert.equal(quote.taxesUsd, 100);
  assert.equal(quote.taxesComplete, true);
  assert.equal(quote.byProgram[0].extraPoints, 0);
  assert.equal(quote.byProgram[0].status, 'priced');
});

test('buy-points quote rounds to purchase increments and excludes expired or missing offers', () => {
  const base = { travelers: 1, legs: [{ program: 'united', mileageCost: 10500, totalTaxes: null }] };
  const rounded = quotePointPurchases(base, { balances: [{ code: 'united', balance: 10000 }], offers: [offer], today: '2026-10-27' });
  assert.equal(rounded.byProgram[0].pointsShort, 500);
  assert.equal(rounded.byProgram[0].pointsToBuy, 10000);
  assert.equal(rounded.byProgram[0].extraPoints, 9500);
  assert.equal(rounded.taxesComplete, false);
  assert.equal(quotePointPurchases(base, { offers: [{ ...offer, offerEnds: '2026-01-01' }], today: '2026-10-27' }).byProgram[0].status, 'expired');
  assert.equal(quotePointPurchases(base).byProgram[0].status, 'missing-offer');
  assert.equal(quotePointPurchases({ travelers: 1, legs: [{ program: 'united', mileageCost: 10000 }] }, { balances: [{ code: 'united', balance: 10000 }] }).byProgram[0].status, 'covered');
});

test('buy-points offers are normalized and strictly validated for settings and backups', () => {
  const settings = validateSettings({ buyPointsOffers: [{ ...offer, program: 'United MileagePlus' }] });
  assert.deepEqual(settings.buyPointsOffers, [{ ...offer, program: 'united' }]);
  assert.throws(() => validateSettings({ buyPointsOffers: [{ ...offer, program: 'chase' }] }), /supported airline/);
  assert.throws(() => validateSettings({ buyPointsOffers: [{ ...offer, offerUrl: 'http://example.com' }] }), /HTTPS/);
  assert.throws(() => validateSettings({ buyPointsOffers: [offer, offer] }), /Only one active offer/);
});

test('POST /api/points/purchase-quote uses saved wallet and offers', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-buy-points-'));
  process.env.POINTPILOT_DATA_DIR = dir;
  process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
  process.env.POINTPILOT_CABINS_URL = 'http://127.0.0.1:9/unreachable.json';
  const [{ startServer }, { saveUser, updateSettings }] = await Promise.all([
    import('../server.mjs'), import('../lib/settings.mjs')
  ]);
  await saveUser({ balances: [{ code: 'united', balance: 10000 }], preferences: {} });
  await updateSettings({ buyPointsOffers: [offer] });
  const server = await new Promise(resolve => { const s = startServer({ port: 0, monitor: false, onReady: () => resolve(s) }); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/points/purchase-quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ travelers: 2, legs: [{ program: 'united', mileageCost: 20000, totalTaxes: 25 }, { program: 'united', mileageCost: 20000, totalTaxes: 25 }] })
  });
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.purchaseCostUsd, 1260);
  assert.equal(quote.taxesUsd, 100);
  const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/points/purchase-quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ travelers: 1, legs: [], secret: 'unexpected' })
  });
  assert.equal(bad.status, 400);
});
