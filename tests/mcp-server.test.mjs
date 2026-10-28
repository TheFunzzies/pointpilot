import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('PointPilot MCP stdio server advertises read-only tools and answers wallet requests', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('mcp/server.mjs')],
    cwd: process.cwd()
  });
  const client = new Client({ name: 'pointpilot-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), [
      'pointpilot_wallet', 'pointpilot_search_cached_awards', 'pointpilot_compare_destinations_cached'
    ]);
    const result = await client.callTool({ name: 'pointpilot_wallet', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.doesNotThrow(() => JSON.parse(result.content[0].text));
  } finally {
    await client.close();
  }
});
