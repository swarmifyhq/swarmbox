// A product's Swarmbox hooks (protocol v0): the clock, the feed of what the server did, the phone inbox, and
// the fake providers' rules and inbound. The product serves them only in a sandbox world, behind a bearer
// token the world was started with, which this client sends.
//
// They answer on the product's bare host only, never a tenant's (where testers' browsers are signed in), so
// requests go to a loopback base such as http://127.0.0.1:<port>/_sandbox. A product build without them
// answers 404 on /health; every call then says so instead of failing obscurely.
//
//   GET  /health                       200 when the hooks are there
//   GET  /clock, POST /clock           sandbox time; move it: {jumpMs} | {to} | {pause} | {play}
//   GET  /feed?company&after&limit     what happened in a tenant, in order, from a cursor
//   GET  /messages?company&to&after    one recipient's texts and emails, as the fakes delivered them
//   GET|POST|DELETE /fakes             the fake providers' rules
//   POST /fakes/inbound                something arrives from outside (a text, a call, a receipt)
//
// Every answer is {ok: true, result} or {ok: false, error: {code, message}}. A feed row is {cursor, kind,
// at, ...}; for kind "action": name, actionKind (command|query), outcome (ok|rejected|forbidden|error),
// errorCode, principal {kind: user|customer|system|agent, membershipId?}, nested (what it set off) and
// input; for kind "delivery": type, handler, status (done|failed|dead) and error.

export class HooksMissing extends Error {}
export class HooksRefused extends Error {}

export type ClockMove = { jumpMs: number } | { to: string } | { pause: true } | { play: true };

export interface ClockState {
  /** The control plane's clock: how far it is moved, and where it stands while paused. */
  clock: { offsetMs: number; frozenAt: string | null; [k: string]: unknown };
  /** The api process's own time, which is sandbox time. */
  process: { at: string; following: boolean };
}

export interface FeedItem {
  cursor: string;
  kind: string;
  at: string;
  wallAt?: string;
  [k: string]: unknown;
}

export interface FeedPage {
  items: FeedItem[];
  next: string;
  lagMs: number;
}

export interface FakeRule {
  provider: string;
  rule: string;
  company?: string;
  to?: string;
  count?: number;
}

export interface Hooks {
  /** Null when the hooks answer; otherwise why not (no hooks in this build, or the gate refused). */
  available(): Promise<string | null>;
  clock(): Promise<ClockState>;
  moveClock(move: ClockMove): Promise<ClockState>;
  feed(company: string, opts?: { after?: string; queries?: boolean; limit?: number }): Promise<FeedPage>;
  /** One recipient's texts and emails: the product asks whose (a number or an address). */
  messages(company: string, to: string, opts?: { after?: string }): Promise<FeedPage>;
  fakeRules(): Promise<unknown[]>;
  addFakeRule(rule: FakeRule): Promise<unknown>;
  clearFakeRules(): Promise<unknown>;
  inbound(body: Record<string, unknown>): Promise<unknown>;
  /** Any other hook the product serves under the same base, for its own tools. */
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** The hooks a product serves at `base` (e.g. http://127.0.0.1:3094/_sandbox), with the world's token. */
export function hooksFor(base: string, token: string, fetchImpl: typeof fetch = fetch): Hooks {
  const root = base.replace(/\/$/, '');
  const prefix = new URL(root).pathname;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 404 && path === '/health')
      throw new HooksMissing('this product build has no Swarmbox hooks');
    const text = await res.text();
    let json: { ok?: boolean; result?: T; error?: { code?: string; message?: string } } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // Not JSON: reported below with the status.
    }
    if (!res.ok || json.ok === false)
      throw new HooksRefused(
        `${method} ${prefix}${path}: ${res.status}${json.error ? ` ${json.error.code ?? ''}: ${json.error.message ?? ''}` : ` ${text.slice(0, 200)}`}`,
      );
    return (json.result ?? (json as unknown)) as T;
  }
  const q = (o: Record<string, string | number | boolean | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== false) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  return {
    async available() {
      try {
        await call('GET', '/health');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    clock: () => call<ClockState>('GET', '/clock'),
    moveClock: (move) => call<ClockState>('POST', '/clock', move),
    feed: (company, o = {}) =>
      call<FeedPage>(
        'GET',
        `/feed${q({ company, after: o.after, include: o.queries ? 'queries' : undefined, limit: o.limit })}`,
      ),
    messages: (company, to, o = {}) =>
      call<FeedPage>('GET', `/messages${q({ company, to, after: o.after })}`),
    fakeRules: async () => (await call<{ rules: unknown[] }>('GET', '/fakes')).rules,
    addFakeRule: (rule) => call('POST', '/fakes', rule),
    clearFakeRules: () => call('DELETE', '/fakes'),
    inbound: (body) => call('POST', '/fakes/inbound', body),
    call,
  };
}
