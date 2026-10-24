// Serve a product through Swarmbox: the MCP server an agent drives it through, and the control room a person
// watches. A product's own start script is a few lines:
//
//   import { serve } from '@swarmifyhq/swarmbox';
//   import { myProduct } from './product.ts';
//   await serve(myProduct());
//
// Ctrl-C stops every world: its screens, browsers and the product.

import { serveControlRoom, type ControlRoom } from './control-room/server.ts';
import { createHarness, type Harness } from './harness.ts';
import { serveMcp, type McpHttp } from './mcp/server.ts';
import type { Product, ProductWorld } from './product.ts';

/** Where an agent and a person reach Swarmbox unless told otherwise. */
export const DEFAULT_PORTS = { controlRoom: 3100, mcp: 3101 } as const;

export interface ServeOptions {
  /** The MCP server's port; 0 picks a free one. Default 3101. */
  mcpPort?: number;
  /** The control room's port; 0 picks a free one. Default 3100. */
  controlRoomPort?: number;
  /** Headed by default: the screens are meant to be watched and taken over. */
  headless?: boolean;
  /** The name to suggest for `claude mcp add`. Default swarmbox-<product>. */
  mcpName?: string;
  /** Stop everything on SIGINT and SIGTERM, then exit. Default true. */
  handleSignals?: boolean;
  /** Where to print the addresses; default the console. Null for nothing. */
  log?: ((line: string) => void) | null;
}

export interface Served<W extends ProductWorld> {
  harness: Harness<W>;
  mcp: McpHttp;
  room: ControlRoom;
  stop(): Promise<void>;
}

export async function serve<W extends ProductWorld>(
  product: Product<W>,
  options: ServeOptions = {},
): Promise<Served<W>> {
  const harness = createHarness(product, { headless: options.headless ?? false });
  const mcp = await serveMcp(harness, options.mcpPort ?? DEFAULT_PORTS.mcp);
  const room = await serveControlRoom(harness, options.controlRoomPort ?? DEFAULT_PORTS.controlRoom);
  const log = options.log === undefined ? (l: string) => console.log(l) : options.log;
  log?.(`control room  ${room.url}`);
  log?.(`mcp           ${mcp.url}`);
  log?.(
    `connect:      claude mcp add --transport http ${options.mcpName ?? `swarmbox-${product.name}`} ${mcp.url}`,
  );

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await harness.shutdown();
      await Promise.all([mcp.close(), room.close()]);
    })());
  if (options.handleSignals ?? true)
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        log?.(`\n${signal}: stopping every world…`);
        void stop().then(() => process.exit(0));
      });
  return { harness, mcp, room, stop };
}
