// The stand-ins that come with Swarmbox, by name: a product lists them in Product.standins with builtinStandIn.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StandInSource } from '../../product.ts';

export const BUILTIN_STANDINS = ['twilio', 'email', 's3', 'helcim', 'expo-push'] as const;
export type BuiltinStandIn = (typeof BUILTIN_STANDINS)[number];

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where a built-in stand-in is, for Product.standins: `[builtinStandIn('twilio')]`. */
export function builtinStandIn(name: BuiltinStandIn, options: { always?: boolean } = {}): StandInSource {
  const dir = join(HERE, name);
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`Swarmbox has no built-in stand-in ${name}`);
  // Swarmbox's own stand-ins are reviewed with their pages, so they come with their browser origins approved.
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    connect?: { browser?: { origins?: string[] } };
  };
  const browserOrigins = manifest.connect?.browser?.origins ?? [];
  return {
    name,
    dir,
    ...(options.always === undefined ? {} : { always: options.always }),
    ...(browserOrigins.length ? { browserOrigins } : {}),
  };
}
