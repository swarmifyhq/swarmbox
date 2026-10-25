// Scenarios: what a run is trying to test, written down before it starts.
//
// A scenario says what to try and what good looks like, in plain words, for the agent driving the
// screens to play. It names people by role, not by name, so it runs on any world with those roles. It
// says nothing about where to click: the screens are the system under test, and a scenario that scripts
// clicks tests the script.
//
// One JSON file each, in the product's scenarios folder, so a person can read one and git keeps their
// history.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STARTS_AT } from '../time.ts';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'lowercase letters, digits and dashes');

export const Scenario = z.strictObject({
  id: Slug,
  title: z.string().min(3).max(120),
  /** The one question this scenario answers. */
  goal: z.string().min(10).max(1000),
  world: z
    .strictObject({
      /** Tenant slugs; default the product's own (one). */
      tenants: z.array(Slug).min(1).max(5).optional(),
      seed: z.boolean().default(true),
      /** Run on a kept world (world/kept.ts) instead of a fresh one. */
      keep: Slug.optional(),
      /**
       * When the world's day starts, in the first tenant's zone: "09:00" (the next one), or
       * "2026-10-31 23:30" for a test across a date or a time change. The clock moves there before anyone
       * signs in. Needs the product's hooks. Default: this machine's now.
       */
      startsAt: z.string().regex(STARTS_AT, '"HH:MM" or "YYYY-MM-DD HH:MM"').optional(),
      /** The product's own world options (what world_create's options take), checked when the run starts. */
      options: z.record(z.string(), z.unknown()).optional(),
      /** Stand-ins beyond the product's own, by name (docs/standins.md). */
      standins: z.array(Slug).max(20).optional(),
    })
    .default({ seed: true }),
  /** Who is on a screen: a role each, the first person holding it (a second of the same role, the second). */
  cast: z
    .array(
      z.strictObject({
        role: z.string().min(2).max(40),
        tenant: Slug.optional(),
        /** What this person is doing, for the report: "the office", "a tech on the road". */
        part: z.string().max(80).optional(),
        /** Which of the product's apps their screen opens; default the product's choice for their role. */
        app: z.string().min(1).max(40).optional(),
      }),
    )
    .min(1)
    .max(8),
  /** What to try, in order, in plain words. */
  try: z.array(z.string().min(3).max(500)).min(1).max(30),
  /** What good looks like. Anything else seen is a finding. */
  expect: z.array(z.string().min(3).max(500)).min(1).max(30),
  /** Network conditions to apply on the way, in plain words: "the tech loses signal after starting the job". */
  conditions: z.array(z.string().min(3).max(300)).max(10).default([]),
  /** Wall-clock minutes this run should take at most; past it, every action says so. */
  budgetMinutes: z.number().int().min(1).max(240).default(20),
});
export type Scenario = z.infer<typeof Scenario>;

export function listScenarios(dir: string): Scenario[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => loadScenario(f.slice(0, -5), dir));
}

export function loadScenario(id: string, dir: string): Scenario {
  Slug.parse(id);
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`no scenario ${id} (${file})`);
  const s = Scenario.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (s.id !== id) throw new Error(`${file} names itself ${s.id}`);
  return s;
}

/** Validates and writes; returns the file. An existing scenario is replaced only when asked. */
export function saveScenario(input: unknown, opts: { dir: string; replace?: boolean }): string {
  const s = Scenario.parse(input);
  const dir = opts.dir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.id}.json`);
  if (existsSync(file) && !opts.replace)
    throw new Error(`scenario ${s.id} exists; pass replace to overwrite it`);
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  return file;
}
