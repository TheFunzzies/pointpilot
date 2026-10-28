#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { POINTPILOT_TOOLS } from '../lib/mcp-tools.mjs';

const server = new McpServer({ name: 'pointpilot', version: '0.1.0' });
for (const tool of POINTPILOT_TOOLS) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async args => {
    try {
      const result = await tool.run(tool.inputSchema.parse(args ?? {}));
      const text = JSON.stringify(result);
      const clipped = text.length > 180_000 ? JSON.stringify({ truncated: true, preview: text.slice(0, 180_000) }) : text;
      return { content: [{ type: 'text', text: clipped }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message || 'PointPilot request failed.' }] };
    }
  });
}

await server.connect(new StdioServerTransport());
