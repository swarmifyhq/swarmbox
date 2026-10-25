#!/usr/bin/env node
// swarmbox call <tool> ['{"json":"args"}'] [--port 3101]
//
// Call one Swarmbox tool from a shell, through the same MCP server an agent uses: for a session that cannot
// load the MCP server itself (one already running when Swarmbox started), and for scripts. It prints the
// tool's text; an image result is saved to a file and its path printed. A refusal prints ERROR and exits 1,
// so a pipe through grep cannot hide it.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_PORTS } from './serve.ts';

const USAGE = "usage: swarmbox call <tool> ['{json args}'] [--port <mcp port>]";

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const port =
  portAt >= 0
    ? Number(args.splice(portAt, 2)[1])
    : Number(process.env.SWARMBOX_MCP_PORT ?? DEFAULT_PORTS.mcp);
const [command, tool, raw] = args;
if (command !== 'call' || !tool || !Number.isInteger(port)) {
  console.error(USAGE);
  process.exit(2);
}

const client = new Client({ name: 'swarmbox-call', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
try {
  // Starting a world or a run can take minutes (a product's seed data): past the client's default timeout.
  const r = (await client.callTool({ name: tool, arguments: raw ? JSON.parse(raw) : {} }, undefined, {
    timeout: 600_000,
  })) as {
    isError?: boolean;
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
  };
  if (r.isError) console.log('ERROR');
  for (const c of r.content) {
    if (c.type === 'text') (r.isError ? console.error : console.log)(c.text);
    else if (c.type === 'image' && c.data) {
      const file = join(tmpdir(), `swarmbox-${tool}-${Date.now()}.${c.mimeType?.split('/')[1] ?? 'png'}`);
      writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`image: ${file}`);
    }
  }
  process.exitCode = r.isError ? 1 : 0;
} finally {
  await client.close();
}
