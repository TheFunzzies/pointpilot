import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-simplefin-wallet-'));
const { projectRewardAccounts, saveSimpleFinSnapshot, saveSimpleFinMappings, simpleFinAccountKey, syncSimpleFinBalances, clearSimpleFinWalletState } = await import('../lib/simplefin-wallet.mjs');
const { saveUser, loadUser } = await import('../lib/settings.mjs');

test('only SimpleFIN custom currencies are eligible; point accounts map to programs and update just mapped wallet rows', async () => {
  const simpleFinRows = [
    { id: 'rewards-1', conn_id: 'cards', name: 'Rewards\nAccount', currency: 'https://rewards.example/amex', balance: '45000', 'balance-date': 1790000000, currencyName: 'Membership Rewards', currencyAbbr: 'MR' },
    { id: 'card-1', conn_id: 'cards', name: 'Credit Card', currency: 'USD', balance: '-850.25', 'balance-date': 1790000000 }
  ];
  const projected = projectRewardAccounts(simpleFinRows);
  assert.equal(projected[0].rewardsCurrency, true);
  assert.equal(projected[0].name, 'RewardsAccount');
  assert.equal(projected[1].rewardsCurrency, false);
  await saveUser({ balances: [{ program: 'amex', balance: 1000, cpp: 1.75 }, { program: 'united', balance: 23000, cpp: 1.2 }], preferences: {} });
  await saveSimpleFinSnapshot(simpleFinRows);
  await saveSimpleFinMappings([{ key: simpleFinAccountKey(simpleFinRows[0]), program: 'amex' }]);
  const result = await syncSimpleFinBalances();
  assert.deepEqual(result.sync.programs.map(row => [row.code, row.balance]), [['amex', 45000]]);
  assert.equal(result.user.balances.find(row => row.code === 'amex').cpp, 1.75);
  assert.equal(result.user.balances.find(row => row.code === 'amex').balance, 45000);
  assert.equal(result.user.balances.find(row => row.code === 'united').balance, 23000);
  await clearSimpleFinWalletState();
  assert.equal((await loadUser()).balances.find(row => row.code === 'united').balance, 23000);
});

test('mapping rejects standard-money accounts and unknown programs', async () => {
  const account = { id: 'cash-1', conn_id: 'bank', name: 'Checking', currency: 'USD', balance: '100' };
  await saveSimpleFinSnapshot([account]);
  await assert.rejects(saveSimpleFinMappings([{ key: simpleFinAccountKey(account), program: 'amex' }]), /no longer available/);
  const rewards = { id: 'points-1', conn_id: 'bank', name: 'Points', currency: 'https://bank.example/currency', balance: '1' };
  await saveSimpleFinSnapshot([rewards]);
  await assert.rejects(saveSimpleFinMappings([{ key: simpleFinAccountKey(rewards), program: 'unknown-program' }]), /supported loyalty program/);
});
