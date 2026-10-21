import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcile, transferContentHash } from '../lib/transfer-sources.mjs';
import { bonusActive } from '../lib/transfers.mjs';
import { newerTransferData, refreshReference, loadCachedReference, transferData, _setTransferData, validateTransferData } from '../lib/reference.mjs';

const original = transferData();
const originalDir = process.env.POINTPILOT_DATA_DIR;
const dir = await mkdtemp(path.join(tmpdir(), 'pp-reference-regressions-'));
process.env.POINTPILOT_DATA_DIR = dir;
after(async () => {
  _setTransferData(original);
  if (originalDir === undefined) delete process.env.POINTPILOT_DATA_DIR;
  else process.env.POINTPILOT_DATA_DIR = originalDir;
  await rm(dir, { recursive: true, force: true });
});
const today = '2026-10-20';
const row = (bonusPct = 0) => ({ bank: 'amex', program: 'aeroplan', ratio: [1, 1], days: 0, bonusPct });
const fixture = () => ({ schemaVersion: 2, lastUpdated: '2026-10-18', banks: { amex: { minTransfer: 1000, increment: 1000 } }, programs: { aeroplan: { transfers: { amex: { ratio: [1, 1] } } } } });
const edge = d => d.programs.aeroplan.transfers.amex;

test('DOM-2: rolling bonus has a confirmation timestamp and no invented expiry', () => {
  const first = reconcile(fixture(), { roame: [row(0.2)] }, { today, checkedAt: `${today}T10:00:00.000Z` }).data;
  assert.equal(edge(first).bonusEnds, undefined);
  assert.equal(edge(first).bonusLastConfirmedAt, `${today}T10:00:00.000Z`);
  assert.equal(bonusActive(edge(first), today), true);
  assert.equal(bonusActive(edge(first), '2026-10-21'), false, 'unconfirmed rolling offers do not survive into another day');
  assert.equal(bonusActive({ bonusPct: 0.2, bonusEnds: '2026-10-27', bonusRolling: true }, today), false, 'old synthetic seven-day expiry is not authoritative');
  const again = reconcile(first, { roame: [row(0.2)] }, { today, checkedAt: `${today}T12:00:00.000Z` });
  assert.ok(again.changes.some(s => /Confirmed bonus/.test(s)));
  assert.ok(newerTransferData(again.data, first));
  assert.equal(again.data.revision, first.revision + 1);
  assert.notEqual(again.data.contentHash, first.contentHash);
});

test('DOM-2: a successful negative refresh disables a rolling bonus, including missing routes', () => {
  const current = reconcile(fixture(), { roame: [row(0.2)] }, { today }).data;
  for (const rows of [[row()], []]) {
    const result = reconcile(current, { roame: rows }, { today, checkedAt: `${today}T12:00:00.000Z` });
    assert.equal(bonusActive(edge(result.data), today), false);
    assert.equal(edge(result.data).bonusPct, undefined);
    assert.ok(result.changes.some(s => /Removed unlisted/.test(s)));
    assert.ok(newerTransferData(result.data, current));
  }
  const unavailable = reconcile(current, { upgradedpoints: [row()] }, { today }).data;
  assert.equal(edge(unavailable).bonusPct, 0.2, 'an unavailable confirming source is not a negative check');
});

test('DOM-2: authoritative expiry is preserved, and changed percentage invalidates old expiry', () => {
  const current = fixture();
  Object.assign(edge(current), { bonusPct: 0.2, bonusEnds: '2026-10-31' });
  const unchanged = reconcile(current, { roame: [row(0.2)] }, { today }).data;
  assert.equal(edge(unchanged).bonusEnds, '2026-10-31');
  assert.equal(edge(unchanged).bonusRolling, undefined);
  assert.equal(bonusActive(edge(unchanged), '2026-10-25'), true);
  const changed = reconcile(unchanged, { roame: [row(0.3)] }, { today }).data;
  assert.equal(edge(changed).bonusEnds, undefined);
  assert.equal(edge(changed).bonusRolling, true);
});

test('DOM-2: live-bonus consensus agrees on the percentage and prioritizes Roame', () => {
  const mixed = reconcile(fixture(), { upgradedpoints: [row(0.3)], roame: [row(0.2)] }, { today }).data;
  assert.equal(edge(mixed).bonusPct, 0.2);
  assert.deepEqual(edge(mixed).bonusConfirmedBy, ['roame']);
  const noConsensus = reconcile(fixture(), { upgradedpoints: [row(0.3)], tpg: [row(0.2)] }, { today }).data;
  assert.equal(edge(noConsensus).bonusPct, undefined);
});

test('DOM-2: same-day ratio corrections and equal-clock changes advance reference versions', () => {
  const first = reconcile(fixture(), { roame: [row()] }, { today }).data;
  const corrected = reconcile(first, { roame: [{ ...row(), ratio: [2, 1] }] }, { today }).data;
  assert.equal(first.lastUpdated, corrected.lastUpdated);
  assert.ok(newerTransferData(corrected, first));
  assert.ok(corrected.updatedAt > first.updatedAt);
  assert.equal(corrected.contentHash, transferContentHash(corrected));
  const repeat = reconcile(corrected, { roame: [{ ...row(), ratio: [2, 1] }] }, { today, checkedAt: `${today}T16:00:00.000Z` }).data;
  assert.equal(repeat.revision, corrected.revision, 'check-only metadata is not a material change');
  assert.equal(newerTransferData(repeat, corrected), false);
  assert.equal(validateTransferData(fixture()), null, 'date-only schema-2 remains valid');
});

test('DOM-1: daily reconciliation migrates legacy rules and seeds newly discovered partner edges', () => {
  const current = fixture();
  current.banks.marriott = { airlineChunkBonus: { every: 60000, bonus: 5000 } };
  current.programs.american = { transfers: { marriott: { ratio: [3, 1] } } };
  const data = reconcile(current, { roame: [{ bank: 'marriott', program: 'united', ratio: [3, 1] }] }, { today }).data;
  assert.equal(data.banks.marriott.airlineChunkBonus, undefined);
  assert.equal(data.programs.american.transfers.marriott.chunkBonus, false);
  assert.deepEqual(data.programs.united.transfers.marriott.chunkBonus, { every: 60000, bonus: 5000 });
  assert.equal(validateTransferData(data), null);
});

test('DOM-2: installed clients refresh and reload same-day corrections without downgrading', async () => {
  const first = reconcile(fixture(), { roame: [row()] }, { today }).data;
  const second = reconcile(first, { roame: [row(0.2)] }, { today, checkedAt: `${today}T11:00:00.000Z` }).data;
  _setTransferData(first);
  const result = await refreshReference({ fetchImpl: async () => ({ ok: true, json: async () => second }) });
  assert.equal(result.updated, true);
  assert.equal(result.revision, second.revision);
  assert.equal(edge(transferData()).bonusPct, 0.2);
  const old = await refreshReference({ fetchImpl: async () => ({ ok: true, json: async () => first }) });
  assert.equal(old.updated, false);
  _setTransferData(first);
  await loadCachedReference();
  assert.equal(transferData().revision, second.revision);
});
