import test from 'node:test';
import assert from 'node:assert/strict';
import { POINTPILOT_TOOLS, runPointPilotTool } from '../lib/mcp-tools.mjs';

test('MCP tool list is read-only and exposes only PointPilot data helpers', () => {
  assert.deepEqual(POINTPILOT_TOOLS.map(tool => tool.name), [
    'pointpilot_wallet', 'pointpilot_search_cached_awards', 'pointpilot_compare_destinations_cached'
  ]);
  assert.ok(POINTPILOT_TOOLS.every(tool => !/transfer|buy|book|delete|write|save/i.test(tool.name)));
});

test('wallet tool returns per-program balances without combining currencies', async () => {
  const text = await runPointPilotTool('pointpilot_wallet', {}, { loadUser: async () => ({
    balances: [{ program: 'Amex Membership Rewards', code: 'amex', type: 'bank', balance: 50000, cpp: 1.6 }], preferences: {}
  }) });
  assert.deepEqual(JSON.parse(text).balances[0], { program: 'Amex Membership Rewards', code: 'amex', type: 'bank', balance: 50000, cpp: 1.6 });
});

test('cached award tool disables provider refresh and returns a bounded result shape', async () => {
  let options;
  const text = await runPointPilotTool('pointpilot_search_cached_awards', {
    origins: 'Boston', destination: 'Thailand', departDate: '2027-03-01'
  }, { search: async (_query, opts) => { options = opts; return {
    mode: 'results', query: { destination: 'Thailand' }, dataStatus: { api: 'cache', warnings: ['cache only'] },
    trips: Array.from({ length: 12 }, (_, i) => ({ destination: 'Thailand', legs: [], totalSourcePoints: i }))
  }; } });
  const result = JSON.parse(text);
  assert.deepEqual(options, { allowApi: false });
  assert.equal(result.trips.length, 10);
  assert.deepEqual(result.warnings, ['cache only']);
});

test('MCP tool inputs reject too many destination candidates and unknown tools', async () => {
  await assert.rejects(runPointPilotTool('pointpilot_compare_destinations_cached', {
    origins: 'BOS', destinations: Array(9).fill('Paris'), departDate: '2027-03-01'
  }), /Too big|at most|maximum/i);
  await assert.rejects(runPointPilotTool('arbitrary_tool', {}), /Unknown PointPilot tool/);
});
