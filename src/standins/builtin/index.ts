// The stand-ins that come with Swarmbox, by name: a product lists them in Product.standins with builtinStandIn.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StandInSource } from '../../product.ts';

export const BUILTIN_STANDINS = ['twilio'] as const;
export type BuiltinStandIn = (typeof BUILTIN_STANDINS)[number];

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where a built-in stand-in is, for Product.standins: `[builtinStandIn('twilio')]`. */
export function builtinStandIn(name: BuiltinStandIn, options: { always?: boolean } = {}): StandInSource {
  const dir = join(HERE, name);
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`Swarmbox has no built-in stand-in ${name}`);
  return { name, dir, ...(options.always === undefined ? {} : { always: options.always }) };
}
