import test from 'node:test';
import assert from 'node:assert/strict';
import { fundPrograms, evaluateTrip } from '../lib/optimizer.mjs';
import { effectiveRatio, planTransfer } from '../lib/transfers.mjs';

const TODAY = '2026-10-05';
const transfers = {
  banks: {
    amex: { minTransfer: 1000, increment: 1000 },
    chase: { minTransfer: 1000, increment: 1000 },
    marriott: { minTransfer: 3000, increment: 3000, airlineChunkBonus: { every: 60000, bonus: 5000 } }
  },
  programs: {
    aeroplan: { transfers: { amex: { ratio: [1, 1] }, chase: { ratio: [1, 1] }, marriott: { ratio: [3, 1] } } },
    united: { transfers: { chase: { ratio: [1, 1] } } },
    flyingblue: { transfers: { amex: { ratio: [1, 1], bonusPct: 0.25, bonusEnds: '2026-09-30' } } }
  }
};
const noFlexPremium = { preserveFlexiblePoints: false };

test('award prices are multiplied by the number of travelers', () => {
  const leg = { program: 'aeroplan', mileageCost: 60000, totalTaxes: 100, cashValue: 3000 };
  const t1 = evaluateTrip([leg], { travelers: 1, balances: [{ code: 'amex', balance: 500000, cpp: 1.5 }], transfers, today: TODAY });
  const t2 = evaluateTrip([leg], { travelers: 2, balances: [{ code: 'amex', balance: 500000, cpp: 1.5 }], transfers, today: TODAY });
  assert.equal(t1.totalTargetPoints, 60000);
  assert.equal(t2.totalTargetPoints, 120000);
  assert.equal(t2.taxesUsd, 200);
  assert.equal(t2.cashUsd, 6000);
});

test('taxes are treated as USD (not cents)', () => {
  const t = evaluateTrip([{ program: 'aeroplan', mileageCost: 50000, totalTaxes: 560, cashValue: 4000 }],
    { travelers: 1, balances: [{ code: 'amex', balance: 100000, cpp: 1 }], transfers, prefs: noFlexPremium, today: TODAY });
  assert.equal(t.taxesUsd, 560);
  assert.equal(t.effectiveCostUsd, 500 + 560);
  assert.ok(Math.abs(t.cpp - ((4000 - 560) / 50000) * 100) < 1e-9);
});

test('program names from manual entry are normalized ("Aeroplan", "Air Canada")', () => {
  for (const program of ['Aeroplan', 'Air Canada', 'AEROPLAN']) {
    const t = evaluateTrip([{ program, mileageCost: 10000 }], { balances: [{ code: 'amex', balance: 20000 }], transfers, today: TODAY });
    assert.ok(t, program);
    assert.equal(t.legs[0].program, 'aeroplan');
  }
});

test('expired transfer bonuses are ignored', () => {
  const edge = transfers.programs.flyingblue.transfers.amex;
  assert.equal(effectiveRatio(edge, '2026-09-01'), 1.25);
  assert.equal(effectiveRatio(edge, TODAY), 1);
});

test('transfers respect minimums and increments', () => {
  const plan = planTransfer(transfers, 'amex', 'aeroplan', { ratio: [1, 1] }, 12345, 100000, TODAY);
  assert.deepEqual(plan, { source: 13000, target: 13000 });
  assert.equal(planTransfer(transfers, 'amex', 'aeroplan', { ratio: [1, 1] }, 500, 900, TODAY), null);
});

test('Marriott 60k -> 25k airline chunk bonus is applied', () => {
  const plan = planTransfer(transfers, 'marriott', 'aeroplan', { ratio: [3, 1] }, 25000, 200000, TODAY);
  assert.deepEqual(plan, { source: 60000, target: 25000 });
});

test('shared bank points are allocated so every program gets funded', () => {
  // Chase is cheapest for both, but United can only be funded by Chase.
  const balances = [{ code: 'chase', balance: 60000, cpp: 1.0 }, { code: 'amex', balance: 60000, cpp: 2.0 }];
  const r = fundPrograms({ aeroplan: 50000, united: 50000 }, balances, transfers, noFlexPremium, TODAY);
  assert.ok(r, 'should be fundable');
  const united = r.sources.filter(s => s.targetProgram === 'united');
  assert.deepEqual(united.map(s => s.from), ['chase']);
  const aeroplan = r.sources.filter(s => s.targetProgram === 'aeroplan');
  assert.ok(aeroplan.some(s => s.from === 'amex'));
});

test('existing airline miles are used before transferring', () => {
  const r = fundPrograms({ aeroplan: 70000 }, [{ code: 'aeroplan', balance: 25000, cpp: 1.5 }, { code: 'amex', balance: 100000, cpp: 1.6 }], transfers, {}, TODAY);
  assert.equal(r.sources[0].from, 'aeroplan');
  assert.equal(r.sources[0].fromPoints, 25000);
  assert.equal(r.sources[1].fromPoints, 45000);
});

test('returns null when the portfolio cannot cover the trip', () => {
  assert.equal(fundPrograms({ united: 100000 }, [{ code: 'amex', balance: 500000 }], transfers, {}, TODAY), null);
});

test('consolidates into fewer transfers when the cheapest mix would exceed the limit', () => {
  const balances = [{ code: 'chase', balance: 30000, cpp: 1.0 }, { code: 'amex', balance: 200000, cpp: 1.6 }];
  const r = fundPrograms({ aeroplan: 100000 }, balances, transfers, { maxTransfers: 1 }, TODAY);
  assert.ok(r);
  assert.deepEqual(r.sources.map(s => [s.from, s.fromPoints]), [['amex', 100000]]);
});

test('maxTransfers preference is enforced', () => {
  const balances = [{ code: 'chase', balance: 10000 }, { code: 'amex', balance: 10000 }];
  assert.equal(fundPrograms({ aeroplan: 15000 }, balances, transfers, { maxTransfers: 1 }, TODAY), null);
  assert.ok(fundPrograms({ aeroplan: 15000 }, balances, transfers, { maxTransfers: 2 }, TODAY));
});
