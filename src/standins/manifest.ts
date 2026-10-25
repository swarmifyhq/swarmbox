// A stand-in's manifest: everything Swarmbox knows about it, and the only source of what the agent reads about it
// (docs/standins.md). Typed and checked, so a stand-in can't hand the agent free text as guidance.

import { z } from 'zod';

/** The behaviours every stand-in shares (docs/standins.md, Behaviours). */
export const BEHAVIOURS = [
  'fail',
  'hang',
  'slow',
  'limit',
  'reject',
  'decline',
  'timeout',
  'late',
  'undeliver',
  'bounce',
  'manual',
  'duplicate',
  'reorder',
  'gone',
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** The ones Swarmbox applies itself, in front of every stand-in; the rest are a stand-in's own. */
export const GENERAL: readonly Behaviour[] = ['fail', 'hang', 'slow', 'limit', 'duplicate', 'reorder'];

const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'lowercase letters, digits and dashes');
// Words the agent will read: short, one line, no markup. A stand-in's manifest is checked against this before any
// of it reaches a tool description.
const Label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} .,:()/'+&-]+$/u, 'plain words only');

const Answer = z.strictObject({
  status: z.int().min(400).max(599),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

export const Manifest = z.strictObject({
  name: Slug,
  provider: Label,
  apiVersion: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'a version: letters, digits, dots and dashes'),
  surfaces: z.array(Slug).min(1).max(12),
  /** The provider's API, operation by operation, so behaviours can match one and the log can name it. */
  operations: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-zA-Z0-9.]{1,59}$/),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
        /** A path pattern: `:name` is one segment, `*` the rest. */
        path: z.string().startsWith('/').max(200),
      }),
    )
    .min(1)
    .max(100),
  connect: z.strictObject({
    /** The base addresses a product maps to its own settings, by name: {"api": "/"}. */
    baseUrls: z.record(Slug, z.string().regex(/^\/[A-Za-z0-9._~/-]*$/, 'a path')),
    hosts: z
      .array(z.string().regex(/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, 'a host name'))
      .max(20)
      .optional(),
    browser: z.strictObject({ origins: z.array(z.url()).min(1) }).optional(),
  }),
  accounts: z.strictObject({
    fields: z.record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
      z.enum(['id', 'secret', 'phone', 'email', 'text']),
    ),
  }),
  behaviours: z.array(z.enum(BEHAVIOURS)).min(1),
  answers: z.strictObject({ fail: Answer.optional(), limit: Answer.optional() }).optional(),
  /** Headers its webhooks carry besides content-type, user-agent and accept: its signature, its timestamp. */
  webhooks: z
    .strictObject({
      headers: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(20),
      /** Its webhooks may also go to the product's own host (the bare base domain): one account for the whole platform. */
      platform: z.boolean().optional(),
    })
    .optional(),
  inbound: z
    .array(
      z.strictObject({
        kind: Slug,
        label: Label,
        /** The fields its body takes, each with a label for the tool's description. */
        fields: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), Label),
      }),
    )
    .max(30)
    .default([]),
  clock: z.enum(['world', 'real']),
});
export type Manifest = z.infer<typeof Manifest>;
export type ManifestInput = z.input<typeof Manifest>;

/** A path pattern as a matcher: `/2010-04-01/Accounts/:sid/Messages.json` gives `{sid}`. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg === '*') return { ...params, rest: a.slice(i).join('/') };
    if (i >= a.length) return null;
    if (seg.startsWith(':')) {
      if (!a[i]) return null;
      params[seg.slice(1)] = decodeURIComponent(a[i]!);
    } else if (seg !== a[i]) return null;
  }
  return p.length === a.length ? params : null;
}

/** Which of a manifest's operations a request is, if any. */
export function operationOf(
  manifest: Manifest,
  method: string,
  path: string,
): { name: string; params: Record<string, string> } | null {
  for (const op of manifest.operations) {
    if (op.method !== method) continue;
    const params = matchPath(op.path, path);
    if (params) return { name: op.name, params };
  }
  return null;
}
