// The kit a stand-in is written with: handlers for its provider's operations and inbound kinds, nothing about
// servers or message loops. Swarmbox runs it as its own sandboxed process and speaks to it over stdin and stdout
// (protocol.ts), so the code here is everything a stand-in sees of the world.

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  decode,
  encode,
  HEX_MARK,
  MARK,
  type ClockState,
  type FromStandIn,
  type Rule,
  type ToStandIn,
} from './protocol.ts';

export interface StandInRequest {
  operation: string | null;
  params: Record<string, string>;
  /** The tenant whose account the request carried, when Swarmbox could tell. */
  tenant: string | null;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
  form(): URLSearchParams;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface StandInContext {
  /** The world's time when the stand-in signs with it (manifest clock "world"), else this machine's. */
  now(): Date;
  /** Send a webhook. A URL on a tenant's host reaches the world's product; nothing else is reachable. */
  deliver(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: Buffer | string },
  ): Promise<Delivered>;
  /** A behaviour of the stand-in's own that applies to this call, used up by one; null when none does. */
  take(
    behaviour: Rule['behaviour'],
    match?: { operation?: string; tenant?: string; target?: string },
  ): Rule | null;
  /** The accounts made so far, by tenant. */
  accounts: Map<string, Record<string, string>>;
  /** What the product set for each tenant's account, as a person would in the provider's console. */
  settings: Map<string, Record<string, string>>;
  /** A folder the stand-in may write. */
  tmp: string;
  /** Tenants' hosts are <tenant>.<baseDomain>; the product's own is the bare base domain. */
  baseDomain: string;
  /** The stand-in's own address, for links it gives out that a product follows (a recording's URL). */
  origin: string;
}

/** The product's answer to a webhook: 0 when it couldn't be delivered. */
export interface Delivered {
  status: number;
  contentType: string;
  body: Buffer;
  text(): string;
}

export interface StandInDefinition {
  /** Its manifest.json, imported: checked here as Swarmbox checks it. */
  manifest: unknown;
  /** Handlers by operation name (the manifest's operations). */
  routes: Record<string, (req: StandInRequest, ctx: StandInContext) => Reply | Promise<Reply>>;
  /** Handlers by inbound kind (the manifest's inbound); what it returns is shown to the agent as data. */
  inbound?: Record<string, (body: Record<string, unknown>, ctx: StandInContext) => unknown>;
  /** Shape an account; given credentials already made from the manifest's fields, all marked. */
  account?(
    tenant: string,
    made: Record<string, string>,
    ctx: StandInContext,
    settings: Record<string, string>,
  ): Record<string, string>;
  /** Forget state on reset (accounts stay). */
  reset?(): void;
}

/** Credentials marked as a stand-in's, in the format each field type needs. */
export function makeCredential(kind: 'id' | 'secret' | 'phone' | 'email' | 'text', tenant: string): string {
  const hex = (n: number) =>
    randomBytes(Math.ceil(n / 2))
      .toString('hex')
      .slice(0, n);
  switch (kind) {
    case 'id':
      return `${MARK}_${tenant}_${hex(12)}`;
    case 'secret':
      return `${MARK}_secret_${hex(32)}`;
    case 'phone':
      // 555-01xx: the range North American numbering keeps for fiction.
      return `+1250555${String(100 + (randomBytes(1)[0]! % 100)).padStart(4, '0')}`;
    case 'email':
      return `${tenant}@${MARK}.invalid`;
    case 'text':
      return `${MARK}_${tenant}`;
  }
}

/** A hex id in a provider's own format that still carries the mark: `hexId("AC", 32)` for a Twilio AccountSid. */
export function hexId(prefix: string, length: number): string {
  return (
    prefix +
    HEX_MARK +
    randomBytes(length)
      .toString('hex')
      .slice(0, length - HEX_MARK.length)
  );
}

export const json = (status: number, value: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
});

/** Run a stand-in over this process's stdin and stdout. Called by the stand-in's module, once. */
export function defineStandIn(def: StandInDefinition): StandInDefinition {
  // Swarmbox has checked the manifest already; the kit imports nothing but Node's own modules, so a stand-in in
  // its sandbox needs to read nothing outside its own folder, Node and the kit.
  if (process.env.SWARMBOX_STANDIN === '1') serve(def, def.manifest as KitManifest);
  return def;
}

/** What the kit reads of a manifest. */
interface KitManifest {
  name: string;
  clock: 'world' | 'real';
  accounts: { fields: Record<string, 'id' | 'secret' | 'phone' | 'email' | 'text'> };
}

function serve(def: StandInDefinition, manifest: KitManifest): void {
  const send = (m: FromStandIn) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let clock: ClockState | null = null;
  let clockSetAt = Date.now();
  let tmp = '';
  let baseDomain = '';
  let origin = '';
  let rules: Rule[] = [];
  const waiting = new Map<string, (d: Delivered) => void>();
  const settings = new Map<string, Record<string, string>>();
  let nextDelivery = 0;
  const accounts = new Map<string, Record<string, string>>();

  const ctx: StandInContext = {
    now() {
      if (manifest.clock === 'real' || !clock) return new Date();
      const base = new Date(clock.at).getTime();
      return new Date(clock.paused ? base : base + (Date.now() - clockSetAt));
    },
    deliver(url, init) {
      const id = `d${nextDelivery++}`;
      return new Promise<Delivered>((resolve) => {
        waiting.set(id, resolve);
        send({
          type: 'deliver',
          id,
          url,
          method: init.method ?? 'POST',
          headers: init.headers ?? {},
          body: encode(init.body),
        });
      });
    },
    take(behaviour, match = {}) {
      const i = rules.findIndex(
        (r) =>
          r.behaviour === behaviour &&
          (!r.match?.operation || r.match.operation === match.operation) &&
          (!r.match?.tenant || r.match.tenant === match.tenant) &&
          (!r.match?.target || r.match.target === match.target),
      );
      if (i < 0) return null;
      const rule = rules[i]!;
      if (rule.count !== undefined) {
        if (rule.count <= 1) rules.splice(i, 1);
        else rules[i] = { ...rule, count: rule.count - 1 };
      }
      return rule;
    },
    accounts,
    settings,
    get tmp() {
      return tmp;
    },
    get baseDomain() {
      return baseDomain;
    },
    get origin() {
      return origin;
    },
  };

  const reply = (id: string, f: () => unknown) =>
    Promise.resolve()
      .then(f)
      .then(
        (value) => send({ type: 'result', id, ok: true, value }),
        (e: unknown) =>
          send({ type: 'result', id, ok: false, error: e instanceof Error ? e.message : String(e) }),
      );

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let m: ToStandIn;
    try {
      m = JSON.parse(line) as ToStandIn;
    } catch {
      return;
    }
    switch (m.type) {
      case 'start':
        clock = m.clock;
        clockSetAt = Date.now();
        tmp = m.tmp;
        baseDomain = m.baseDomain;
        origin = m.origin;
        send({ type: 'ready' });
        return;
      case 'clock':
        clock = m.clock;
        clockSetAt = Date.now();
        return;
      case 'request': {
        const handler = m.operation ? def.routes[m.operation] : undefined;
        const body = decode(m.body);
        const req: StandInRequest = {
          operation: m.operation,
          params: m.params,
          tenant: m.tenant,
          method: m.method,
          path: m.path,
          query: new URLSearchParams(m.query),
          headers: m.headers,
          body,
          text: () => body.toString('utf8'),
          json: <T>() => JSON.parse(body.toString('utf8')) as T,
          form: () => new URLSearchParams(body.toString('utf8')),
        };
        void Promise.resolve()
          .then(() =>
            handler ? handler(req, ctx) : json(404, { error: `no such operation: ${m.method} ${m.path}` }),
          )
          .then(
            (r) =>
              send({
                type: 'response',
                id: m.id,
                status: r.status,
                headers: r.headers ?? {},
                body: encode(r.body),
              }),
            (e: unknown) =>
              send({
                type: 'response',
                id: m.id,
                status: 500,
                headers: { 'content-type': 'text/plain' },
                body: encode(`stand-in error: ${e instanceof Error ? e.message : String(e)}`),
              }),
          );
        return;
      }
      case 'account':
        void reply(m.id, () => {
          // Asked again for a tenant it has: the same account, its settings changed, as a person changes a
          // number's webhooks in the console. A product learns some of them (its own webhook id) only after it
          // has connected the credentials.
          const had = accounts.get(m.tenant);
          if (had) {
            settings.set(m.tenant, { ...settings.get(m.tenant), ...m.settings });
            return had;
          }
          const made = Object.fromEntries(
            Object.entries(manifest.accounts.fields).map(([k, kind]) => [k, makeCredential(kind, m.tenant)]),
          );
          settings.set(m.tenant, m.settings ?? {});
          const account = def.account ? def.account(m.tenant, made, ctx, m.settings ?? {}) : made;
          accounts.set(m.tenant, account);
          return account;
        });
        return;
      case 'behave':
        void reply(m.id, () => {
          rules.push(m.rule);
          return rules;
        });
        return;
      case 'unbehave':
        void reply(m.id, () => {
          rules = m.ruleId ? rules.filter((r) => r.id !== m.ruleId) : [];
          return rules;
        });
        return;
      case 'inbound':
        void reply(m.id, () => {
          const handler = def.inbound?.[m.kind];
          if (!handler) throw new Error(`${manifest.name} has no inbound ${m.kind}`);
          return handler(m.body, ctx);
        });
        return;
      case 'reset':
        void reply(m.id, () => {
          rules = [];
          def.reset?.();
        });
        return;
      case 'delivered':
        {
          const body = decode(m.body);
          waiting.get(m.id)?.({
            status: m.status,
            contentType: m.contentType ?? '',
            body,
            text: () => body.toString('utf8'),
          });
        }
        waiting.delete(m.id);
        return;
    }
  });
  lines.on('close', () => process.exit(0));
}
