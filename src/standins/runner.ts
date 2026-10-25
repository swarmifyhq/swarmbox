// Swarmbox's side of a stand-in (docs/standins.md): it starts the stand-in as its own process inside an
// operating-system sandbox with no network at all, serves its port, applies the general behaviours, delivers its
// webhooks to the world, and keeps the log. The stand-in only ever sees messages on its stdin.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { GENERAL, Manifest, operationOf, type Behaviour } from './manifest.ts';
import type { SandboxManager as SandboxManagerApi } from '@anthropic-ai/sandbox-runtime';
import { decode, encode, type ClockState, type FromStandIn, type Rule, type ToStandIn } from './protocol.ts';

export interface LogEntry {
  cursor: string;
  at: string;
  kind: 'request' | 'deliver' | 'inbound';
  operation: string | null;
  tenant: string | null;
  method: string;
  /** A request's path, or a delivery's URL. */
  target: string;
  status: number | null;
  /** The behaviour Swarmbox applied, when one did. */
  behaviour?: Behaviour;
  /** Bodies, cut to 4 KB each: what the product sent, and what it got back (or was delivered). */
  sent?: string;
  answered?: string;
}

export interface StandInOptions {
  /** The stand-in's folder: manifest.json and its entry module. */
  dir: string;
  /** Its entry module, relative to dir. Default index.ts, else index.js. */
  entry?: string;
  /** The world's product, http://127.0.0.1:<port>: where webhooks to a tenant's host are delivered. */
  deliverTo: string;
  /** Tenants' hosts are <tenant>.<baseDomain>. */
  baseDomain: string;
  clock?: ClockState | null;
  /**
   * Run it in the operating-system sandbox. "required" (the default) refuses to start where the sandbox isn't
   * available; "off" is for Swarmbox's own tests on a machine without one, never for someone else's stand-in.
   */
  sandbox?: 'required' | 'off';
  /** Folders the stand-in may read besides its own (Swarmbox's own package, for the kit it imports). */
  readable?: string[];
}

export interface StandIn {
  manifest: Manifest;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** The manifest's base addresses, absolute. */
  baseUrls: Record<string, string>;
  account(tenant: string): Promise<Record<string, string>>;
  behave(rule: Omit<Rule, 'id'>): Promise<Rule>;
  rules(): Rule[];
  clearRules(id?: string): Promise<void>;
  inbound(kind: string, body: Record<string, unknown>): Promise<unknown>;
  log(after?: string): LogEntry[];
  setClock(clock: ClockState): void;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const SWARMBOX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_KEPT = 5000;
const cut = (b: Buffer) =>
  b.length > 4096 ? `${b.subarray(0, 4096).toString('utf8')}…` : b.toString('utf8');

let sandboxReady: Promise<typeof SandboxManagerApi> | undefined;
/** The sandbox runtime, set up once per process with no network for anything it wraps. */
function sandbox() {
  return (sandboxReady ??= (async () => {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    if (!SandboxManager.isSupportedPlatform())
      throw new Error(
        `stand-ins need the operating-system sandbox, which this platform (${process.platform}) lacks`,
      );
    // No ask callback: anything the lists don't allow is denied, and the lists allow nothing.
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: ['~'], allowRead: [], allowWrite: [], denyWrite: [] },
    });
    return SandboxManager;
  })());
}

export async function startStandIn(options: StandInOptions): Promise<StandIn> {
  const dir = resolve(options.dir);
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  const entry = join(dir, options.entry ?? (existsSync(join(dir, 'index.ts')) ? 'index.ts' : 'index.js'));
  const tmp = mkdtempSync(join(tmpdir(), `swarmbox-standin-${manifest.name}-`));
  const env = { PATH: '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, SWARMBOX_STANDIN: '1' };
  const node = process.execPath;

  let child: ChildProcess;
  if ((options.sandbox ?? 'required') === 'required') {
    const sm = await sandbox();
    const nodeDir = dirname(dirname(node));
    const command = await sm.wrapWithSandbox(`'${node}' '${entry}'`, undefined, {
      filesystem: {
        // The user's files and every temp folder: where worlds keep their database sockets and other stand-ins
        // their state. Then back only what this one needs: its own package, Node, Swarmbox's kit, its own folder.
        denyRead: ['~', tmpdir(), '/tmp', '/private/tmp', '/private/var/folders'],
        allowRead: [dir, nodeDir, SWARMBOX_ROOT, tmp, ...(options.readable ?? [])],
        allowWrite: [tmp],
        denyWrite: [],
      },
    });
    child = spawn(command, { shell: true, env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    child = spawn(node, [entry], { env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // The stand-in's stderr is its own business, but a crash should be readable.
  const stderr: string[] = [];
  child.stderr!.on('data', (d: Buffer) => {
    stderr.push(d.toString());
    if (stderr.length > 50) stderr.shift();
  });
  const send = (m: ToStandIn) => child.stdin!.write(`${JSON.stringify(m)}\n`);
  let next = 0;
  const id = () => `m${next++}`;
  const pending = new Map<string, (m: FromStandIn) => void>();
  const ask = <T>(m: ToStandIn & { id: string }): Promise<T> =>
    new Promise<T>((resolveIt, reject) => {
      pending.set(m.id, (r) => {
        if (r.type !== 'result') return reject(new Error(`${manifest.name}: unexpected ${r.type}`));
        if (r.ok) resolveIt(r.value as T);
        else reject(new Error(`${manifest.name}: ${r.error}`));
      });
      send(m);
    });

  const log: LogEntry[] = [];
  let cursor = 0;
  const record = (e: Omit<LogEntry, 'cursor' | 'at'>) => {
    log.push({ cursor: String(++cursor), at: new Date().toISOString(), ...e });
    if (log.length > LOG_KEPT) log.shift();
  };

  // Accounts, so a request can be told apart by tenant: any credential value it carries.
  const accounts = new Map<string, Record<string, string>>();
  const tenantOf = (req: { path: string; headers: Record<string, string>; body: Buffer }): string | null => {
    const auth = req.headers.authorization ?? '';
    const basic = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
    const hay = [req.path, auth, basic, ...Object.values(req.headers), req.body.toString('utf8')].join('\n');
    for (const [tenant, creds] of accounts)
      if (Object.values(creds).some((v) => v.length >= 8 && hay.includes(v))) return tenant;
    return null;
  };

  // Rules: the general ones Swarmbox applies here; the rest go to the stand-in.
  let rules: Rule[] = [];
  const takeGeneral = (
    behaviour: Behaviour,
    operation: string | null,
    tenant: string | null,
  ): Rule | null => {
    const i = rules.findIndex(
      (r) =>
        r.behaviour === behaviour &&
        (!r.match?.operation || r.match.operation === operation) &&
        (!r.match?.tenant || r.match.tenant === tenant),
    );
    if (i < 0) return null;
    const rule = rules[i]!;
    if (rule.count !== undefined) {
      if (rule.count <= 1) rules.splice(i, 1);
      else rules[i] = { ...rule, count: rule.count - 1 };
    }
    return rule;
  };

  // Deliveries: to the world's product only, with the tenant's Host; duplicate and reorder applied here.
  const world = new URL(options.deliverTo);
  const held: (() => Promise<void>)[] = [];
  let holdTimer: NodeJS.Timeout | undefined;
  const post = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<number> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return 0;
    }
    const host = target.hostname;
    const domain = options.baseDomain;
    const isTenant =
      host === domain || host.endsWith(`.${domain}`) || host === '127.0.0.1' || host === 'localhost';
    if (!isTenant) {
      record({
        kind: 'deliver',
        operation: null,
        tenant: null,
        method,
        target: url,
        status: null,
        sent: 'refused: not the world',
      });
      return 0;
    }
    return new Promise<number>((done) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: Number(world.port),
          method,
          path: `${target.pathname}${target.search}`,
          headers: { ...headers, host: target.host, 'content-length': String(body.length) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            record({
              kind: 'deliver',
              operation: null,
              tenant: null,
              method,
              target: url,
              status: res.statusCode ?? 0,
              sent: cut(body),
              answered: cut(Buffer.concat(chunks)),
            });
            done(res.statusCode ?? 0);
          });
        },
      );
      req.on('error', (e) => {
        record({
          kind: 'deliver',
          operation: null,
          tenant: null,
          method,
          target: url,
          status: 0,
          sent: cut(body),
          answered: e.message,
        });
        done(0);
      });
      req.end(body);
    });
  };
  const deliver = async (m: Extract<FromStandIn, { type: 'deliver' }>) => {
    const body = decode(m.body);
    const run = async () => {
      const status = await post(m.url, m.method, m.headers, body);
      send({ type: 'delivered', id: m.id, status });
    };
    if (takeGeneral('duplicate', null, null)) {
      await run();
      void post(m.url, m.method, m.headers, body);
      return;
    }
    const reorder = rules.find((r) => r.behaviour === 'reorder');
    if (reorder || held.length) {
      // Held for a moment, then sent last first.
      if (reorder) takeGeneral('reorder', null, null);
      held.push(run);
      clearTimeout(holdTimer);
      holdTimer = setTimeout(
        () => {
          const all = held.splice(0).reverse();
          void all.reduce((p, f) => p.then(f), Promise.resolve());
        },
        Number(reorder?.param?.windowMs ?? 500),
      );
      return;
    }
    await run();
  };

  let ready: () => void;
  const started = new Promise<void>((r) => (ready = r));
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let m: FromStandIn;
    try {
      m = JSON.parse(line) as FromStandIn;
    } catch {
      return; // a stand-in that writes anything else to stdout gets ignored, never parsed as data
    }
    if (m.type === 'ready') return ready();
    if (m.type === 'deliver') return void deliver(m);
    const waiting = pending.get(m.id);
    pending.delete(m.id);
    waiting?.(m);
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  send({ type: 'start', baseDomain: options.baseDomain, clock: options.clock ?? null, tmp });
  const crashed = exited.then((code) => {
    throw new Error(`${manifest.name} stopped before it was ready (${code}): ${stderr.join('').slice(-800)}`);
  });
  await Promise.race([started, crashed]);

  // The provider's port.
  const hanging = new Set<ServerResponse>();
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://standin');
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]),
        );
        const op = operationOf(manifest, req.method ?? 'GET', url.pathname);
        const tenant = tenantOf({ path: url.pathname, headers, body });
        const base = {
          kind: 'request' as const,
          operation: op?.name ?? null,
          tenant,
          method: req.method ?? 'GET',
          target: `${url.pathname}${url.search}`,
          sent: cut(body),
        };
        const answer = (status: number, h: Record<string, string>, b: Buffer, behaviour?: Behaviour) => {
          record({ ...base, status, answered: cut(b), ...(behaviour ? { behaviour } : {}) });
          res.writeHead(status, h).end(b);
        };

        if (takeGeneral('hang', base.operation, tenant)) {
          record({ ...base, status: null, behaviour: 'hang' });
          hanging.add(res);
          res.on('close', () => hanging.delete(res));
          return;
        }
        const failing = takeGeneral('fail', base.operation, tenant);
        if (failing) {
          const a = manifest.answers?.fail ?? { status: 503, body: { error: 'service unavailable' } };
          return answer(
            a.status,
            { 'content-type': 'application/json', ...a.headers },
            Buffer.from(JSON.stringify(a.body ?? {})),
            'fail',
          );
        }
        const limited = takeGeneral('limit', base.operation, tenant);
        if (limited) {
          const a = manifest.answers?.limit ?? { status: 429, body: { error: 'too many requests' } };
          const retry = String(limited.param?.retryAfterSec ?? 1);
          return answer(
            a.status,
            { 'content-type': 'application/json', 'retry-after': retry, ...a.headers },
            Buffer.from(JSON.stringify(a.body ?? {})),
            'limit',
          );
        }
        const slow = takeGeneral('slow', base.operation, tenant);
        if (slow) await new Promise((r) => setTimeout(r, Number(slow.param?.delayMs ?? 5000)));

        const rid = id();
        const reply = await new Promise<FromStandIn>((r) => {
          pending.set(rid, r);
          send({
            type: 'request',
            id: rid,
            operation: op?.name ?? null,
            params: op?.params ?? {},
            tenant,
            method: req.method ?? 'GET',
            path: url.pathname,
            query: url.search.slice(1),
            headers,
            body: encode(body),
          });
        });
        if (reply.type !== 'response') return answer(500, {}, Buffer.from('stand-in answered out of turn'));
        answer(reply.status, reply.headers ?? {}, decode(reply.body), slow ? 'slow' : undefined);
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    manifest,
    origin,
    baseUrls: Object.fromEntries(
      Object.entries(manifest.connect.baseUrls).map(([k, p]) => [k, `${origin}${p === '/' ? '' : p}`]),
    ),
    async account(tenant) {
      const creds = await ask<Record<string, string>>({ type: 'account', id: id(), tenant });
      accounts.set(tenant, creds);
      return creds;
    },
    async behave(input) {
      if (!manifest.behaviours.includes(input.behaviour))
        throw new Error(
          `${manifest.name} doesn't support "${input.behaviour}"; it supports ${manifest.behaviours.join(', ')}`,
        );
      const rule: Rule = { ...input, id: randomBytes(4).toString('hex') };
      if (GENERAL.includes(rule.behaviour)) rules.push(rule);
      else await ask({ type: 'behave', id: id(), rule });
      return rule;
    },
    rules: () => [...rules],
    async clearRules(ruleId) {
      rules = ruleId ? rules.filter((r) => r.id !== ruleId) : [];
      await ask({ type: 'unbehave', id: id(), ruleId: ruleId ?? null });
    },
    async inbound(kind, body) {
      if (!manifest.inbound.some((k) => k.kind === kind))
        throw new Error(
          `${manifest.name} has no inbound "${kind}"; it has ${manifest.inbound.map((k) => k.kind).join(', ') || 'none'}`,
        );
      const value = await ask<unknown>({ type: 'inbound', id: id(), kind, body });
      record({
        kind: 'inbound',
        operation: kind,
        tenant: null,
        method: '-',
        target: kind,
        status: null,
        sent: JSON.stringify(body).slice(0, 4096),
      });
      return value;
    },
    log: (after) => (after ? log.filter((e) => Number(e.cursor) > Number(after)) : [...log]),
    setClock(clock) {
      send({ type: 'clock', clock });
    },
    async reset() {
      rules = [];
      await ask({ type: 'reset', id: id() });
    },
    async stop() {
      for (const res of hanging) res.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      child.stdin!.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
