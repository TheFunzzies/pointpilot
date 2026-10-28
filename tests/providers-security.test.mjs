import test from 'node:test';
import assert from 'node:assert/strict';
import { providerUrlAllowed } from '../lib/providers.mjs';

test('provider capture URLs require the selected provider domain over HTTPS', () => {
  assert.equal(providerUrlAllowed('aeroplan', 'https://www.aircanada.com/aeroplan/redeem/'), true);
  assert.equal(providerUrlAllowed('aeroplan', 'https://rewards.aircanada.com/search'), true);
  assert.equal(providerUrlAllowed('aeroplan', 'https://aircanada.com.attacker.example/'), false);
  assert.equal(providerUrlAllowed('aeroplan', 'https://attackeraircanada.com/'), false);
  assert.equal(providerUrlAllowed('aeroplan', 'http://www.aircanada.com/'), false);
  assert.equal(providerUrlAllowed('unknown', 'https://www.aircanada.com/'), false);
  assert.equal(providerUrlAllowed('aeroplan', 'https://user:pass@www.aircanada.com/'), false);
});
