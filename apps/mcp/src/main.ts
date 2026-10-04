/**
 * Entry point for the Assumption Firewall MCP server.
 *
 * Transport only -- the tools live in server.ts, so they can be exercised in a
 * test over an in-memory transport rather than by shelling out to a process.
 *
 *   pnpm mcp                     stdio, how an editor agent connects
 *   pnpm mcp --http              Streamable HTTP on 127.0.0.1:4311
 *   MMD_MCP_ALLOW_WRITES=1       also allow record_understanding
 *
 * Claude Code:  claude mcp add mental-model-drift -- npx tsx apps/mcp/src/main.ts
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildEngine } from '#engine';
import { createMcpServer } from './server.ts';

const built = buildEngine();
const server = createMcpServer(built, { allowWrites: process.env.MMD_MCP_ALLOW_WRITES === '1' });
const described = built.describe();

if (process.argv.includes('--http')) {
  const port = Number(process.env.MMD_MCP_PORT ?? 4311);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  createServer((req, res) => {
    void transport.handleRequest(req, res).catch((err: Error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  }).listen(port, '127.0.0.1', () => {
    console.error(`mental-model-drift MCP  http://127.0.0.1:${port}  (${described.mode} mode, bee: ${described.bee})`);
  });
} else {
  await server.connect(new StdioServerTransport());
  // stdout is the transport. Anything a human reads has to go to stderr.
  console.error(`mental-model-drift MCP  stdio  (${described.mode} mode, bee: ${described.bee})`);
}
