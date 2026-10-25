// Swarmbox's side of a stand-in (docs/standins.md): it starts the stand-in as its own process inside an
// operating-system sandbox with no network and almost nothing to read, serves its port, applies the general
// behaviours, delivers its webhooks to the world, and keeps the log.
//
// A stand-in is untrusted code. Nothing it sends may stop Swarmbox: every message is checked before it is used, every
// wait has a time limit, and a stand-in that misbehaves is stopped while every world goes on. Nothing it writes
// reaches the agent unshaped (shape.ts).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxManager as SandboxManagerApi } from '@anthropic-ai/sandbox-runtime';
import { GENERAL, Manifest, operationOf, type Behaviour } from './manifest.ts';
import { decode, encode, type ClockState, type Rule, type ToStandIn } from './protocol.ts';
import {
  LIVE_CREDENTIAL,
  METHODS,
  plain,
  shapeAccount,
  shapeData,
  shapeHeaders,
  shapeParam,
} from './shape.ts';

export interface LogEntry {
  cursor: string;
  at: string;
  kind: 'request' | 'deliver' | 'inbound' | 'refused';
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

/** A stand-in refused something. `said` is its own words, made plain: shown to anyone only as data. */
export class StandInError extends Error {
  readonly standin: string;
  readonly what: string;
  readonly said: string;
  constructor(standin: string, what: string, said: string) {
    super(`${standin} refused ${what}: ${said}`);
    this.standin = standin;
    this.what = what;
    this.said = said;
  }
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
  /** How long the stand-in has to answer one request before the product gets a 504. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long it has to say it is ready. Default 10 s. */
  readyTimeoutMs?: number;
  /** Called with a stand-in's own stderr, for the operator's console; never shown to the agent. */
  onStderr?: (text: string) => void;
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
  /** Null while it runs; why it stopped, once it has. */
  stopped(): string | null;
  /** Its own folder; removed when it stops. */
  folder: string;
  stop(): Promise<void>;
}

/** The sandbox runtime's own helpers (on Linux, the seccomp program it runs before the command): real path, since
 * a package manager keeps it behind symlinks. */
const RUNTIME_VENDOR = (() => {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'));
    let d = dirname(entry);
    while (!existsSync(join(d, 'package.json')) && dirname(d) !== d) d = dirname(d);
    return realpathSync(join(d, 'vendor'));
  } catch {
    return null;
  }
})();

/**
 * What the system needs readable for Node to start at all, beyond Node's own folder: on Linux the dynamic loader,
 * the C and C++ libraries and /proc (Node reads its own there); on macOS the OpenSSL settings it reads as it starts.
 */
const SYSTEM_READS: string[] = [
  ...(RUNTIME_VENDOR ? [RUNTIME_VENDOR] : []),
  ...(process.platform === 'darwin' ? ['/System/Library/OpenSSL'] : []),
  ...(process.platform === 'linux'
    ? [
        '/lib',
        '/lib64',
        '/usr/lib',
        '/usr/lib64',
        '/etc/ld.so.cache',
        '/etc/ld.so.conf',
        '/etc/ld.so.conf.d',
        '/proc',
        '/dev',
      ]
        .filter((p) => existsSync(p))
        .map((p) => realpathSync(p))
    : []),
];

/** The kit's own folder: sdk and protocol, which import nothing but Node's built-ins. */
const KIT_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));
const LOG_KEPT = 2000;
/** Behaviours applied at once, per stand-in: a rule with no count stays until it's cleared. */
const RULES_KEPT = 100;
/** Refused deliveries logged per minute; past it, one line says how many more there were. */
const REFUSALS_LOGGED = 100;
const MAX_LINE = 32 * 1024 * 1024;
const READY_MS = 10_000;
const ASK_MS = 10_000;
const DELIVERIES_IN_FLIGHT = 64;
const ALWAYS_SENT = new Set(['content-type', 'user-agent', 'accept']);
const cut = (b: Buffer) =>
  b.length > 4096 ? `${b.subarray(0, 4096).toString('utf8')}…` : b.toString('utf8');

let sandboxReady: Promise<typeof SandboxManagerApi> | undefined;
/** The sandbox runtime, set up once per process with no network for anything it wraps. */
function sandbox() {
  return (sandboxReady ??= (async () => {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    if (!SandboxManager.isSupportedPlatform())
      throw new Error(`stand-ins need the operating-system sandbox, which ${process.platform} lacks here`);
    const deps = SandboxManager.checkDependencies();
    if (deps.errors.length)
      throw new Error(`stand-ins need the operating-system sandbox: ${deps.errors.join('; ')}`);
    // No ask callback: anything the lists don't allow is denied, and the lists allow nothing.
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: ['/'], allowRead: [], allowWrite: [], denyWrite: [] },
    });
    return SandboxManager;
  })());
}

/** Reads a stream as lines, refusing any line past `max` bytes instead of buffering it. */
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onTooLong: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, i));
      onLine(Buffer.concat(parts).toString('utf8'));
      parts = [];
      size = 0;
      start = i + 1;
    }
    const rest = chunk.subarray(start);
    size += rest.length;
    if (size > MAX_LINE) {
      parts = [];
      size = 0;
      onTooLong();
      return;
    }
    if (rest.length) parts.push(rest);
  });
}

/** The parent in a /proc/<pid>/stat line, "pid (comm) state ppid …": the name may hold spaces and parentheses. */
export function ppidOfStat(stat: string): number {
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}

/** Each process's parent, from the system's process table: /proc on Linux (no ps there in slim images), ps elsewhere. */
function parents(): Map<number, number> {
  const table = new Map<number, number>();
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        table.set(Number(entry), ppidOfStat(readFileSync(`/proc/${entry}/stat`, 'utf8')));
      } catch {
        // gone while we read
      }
    }
    return table;
  }
  const ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
  for (const line of ps.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) table.set(pid, ppid);
  }
  return table;
}

/** Every process below `root`. Throws when the process table can't be read, so the caller can say so. */
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents()) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const out: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function startStandIn(options: StandInOptions): Promise<StandIn> {
  // Real paths throughout: the sandbox compares them, and a package manager's symlinks or macOS's /var -> /private/var
  // would otherwise leave a stand-in unable to read its own folder.
  const dir = realpathSync(resolve(options.dir));
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  const entry = join(dir, options.entry ?? (existsSync(join(dir, 'index.ts')) ? 'index.ts' : 'index.js'));
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), `swarmbox-standin-${manifest.name}-`)));
  const env = { PATH: '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, SWARMBOX_STANDIN: '1' };
  const node = realpathSync(process.execPath);
  const requestMs = options.requestTimeoutMs ?? 60_000;

  let child: ChildProcess;
  try {
    if ((options.sandbox ?? 'required') === 'required') {
      const sm = await sandbox();
      const command = await sm.wrapWithSandbox(`'${node}' '${entry}'`, undefined, {
        filesystem: {
          // Nothing to read but what it runs on: its own package, Node, the kit, its own folder, and what the
          // system needs to start Node (SYSTEM_READS). The rest of the disk is not there for it.
          denyRead: ['/'],
          allowRead: [dir, dirname(dirname(node)), KIT_DIR, tmp, ...SYSTEM_READS],
          allowWrite: [tmp],
          denyWrite: [],
        },
      });
      // No new processes: a stand-in has no need of one, and on macOS a child that starts its own session would
      // outlive any group kill. The runtime's profile allows fork; this one doesn't.
      const noFork =
        process.platform === 'darwin'
          ? command.replace('(allow process-fork)', '(deny process-fork)')
          : command;
      if (process.platform === 'darwin' && noFork === command)
        throw new Error("the sandbox's profile changed shape: it no longer says (allow process-fork)");
      // Its own process group too, so stopping it stops anything it is part of.
      child = spawn(noFork, { shell: true, env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } else {
      child = spawn(node, [entry], { env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }

  let stoppedWhy: string | null = null;
  const kill = (why: string) => {
    if (!stoppedWhy) stoppedWhy = why;
    // Already gone: its pid, and its group's, may belong to someone else by now (another world's stand-in).
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    // Everything under it, as the system sees it now, then its group: what a stand-in started can't outlive it,
    // even one that left the group.
    let below: number[] = [];
    try {
      below = descendants(child.pid);
    } catch (e) {
      // Without the table only its group can be stopped; say so rather than pass it off as "nothing under it".
      options.onStderr?.(
        `swarmbox: could not read the process table to stop what ${manifest.name} started: ${(e as Error).message}\n`,
      );
    }
    for (const pid of below) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  child.on('error', (e) => kill(`could not run: ${e.message}`));
  child.stdin!.on('error', () => undefined); // a stand-in that died while we wrote: noticed on exit
  child.stderr!.on('data', (d: Buffer) => options.onStderr?.(d.toString()));
  const send = (m: ToStandIn) => {
    if (stoppedWhy || !child.stdin!.writable) return;
    child.stdin!.write(`${JSON.stringify(m)}\n`);
  };

  let next = 0;
  const id = () => `m${next++}`;
  // Everything waiting on the stand-in, so its exit can answer all of it.
  const pending = new Map<
    string,
    { resolve: (m: Record<string, unknown>) => void; fail: (why: string) => void }
  >();
  const wait = (key: string, ms: number, what: string) =>
    new Promise<Record<string, unknown>>((ok, no) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        no(new Error(`${manifest.name} did not answer ${what} within ${ms / 1000} s`));
      }, ms);
      pending.set(key, {
        resolve: (m) => (clearTimeout(timer), ok(m)),
        fail: (why) => (clearTimeout(timer), no(new Error(`${manifest.name} stopped: ${why}`))),
      });
    });
  const ask = async (m: ToStandIn & { id: string }, what: string): Promise<unknown> => {
    const answer = wait(m.id, ASK_MS, what);
    send(m);
    const r = await answer;
    if (r.type !== 'result') throw new Error(`${manifest.name} answered ${what} out of turn`);
    if (r.ok !== true) throw new StandInError(manifest.name, what, plain(r.error));
    return r.value;
  };

  const log: LogEntry[] = [];
  let cursor = 0;
  const record = (e: Omit<LogEntry, 'cursor' | 'at'>) => {
    log.push({ cursor: String(++cursor), at: new Date().toISOString(), ...e });
    if (log.length > LOG_KEPT) log.shift();
  };

  // Accounts, so a request can be told apart by tenant: any credential value it carries.
  const accounts = new Map<string, Record<string, string>>();
  const tenantOf = (hay: string): string | null => {
    for (const [tenant, creds] of accounts)
      if (Object.values(creds).some((v) => v.length >= 8 && hay.includes(v))) return tenant;
    return null;
  };

  // Rules: the general ones Swarmbox applies here; the rest go to the stand-in, which Swarmbox counts by id.
  let rules: Rule[] = [];
  const ownRules = new Set<string>();
  let ownPending = 0;
  /** Its own rules as it reports them (behave and unbehave answer with the list): ids only, at most the cap. */
  const ownFrom = (answer: unknown) => {
    if (!Array.isArray(answer)) return;
    ownRules.clear();
    for (const r of answer.slice(0, RULES_KEPT))
      if (isObject(r) && typeof r.id === 'string' && r.id.length <= 40) ownRules.add(r.id);
  };
  const refreshOwn = async () =>
    ownFrom(await ask({ type: 'unbehave', id: id(), ruleId: '-' }, 'listing behaviours').catch(() => null));
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

  // Deliveries: to a tenant's host on the world's product only; the stand-in picks the path and its declared headers.
  const world = new URL(options.deliverTo);
  const tenantHost = new RegExp(
    `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${options.baseDomain.replace(/\./g, '\\.')}$`,
  );
  const declared = new Set(manifest.webhooks?.headers ?? []);
  let inFlight = 0;
  let refusedThisMinute = 0;
  let refusedDropped = 0;
  const refusals = setInterval(() => {
    if (refusedDropped)
      record({
        kind: 'refused',
        operation: null,
        tenant: null,
        method: '-',
        target: '-',
        status: null,
        sent: `and ${refusedDropped} more refused`,
      });
    refusedThisMinute = 0;
    refusedDropped = 0;
  }, 60_000);
  refusals.unref();
  const refuseDelivery = (url: string, method: string, why: string) => {
    if (++refusedThisMinute > REFUSALS_LOGGED) {
      refusedDropped++;
      return 0;
    }
    record({
      kind: 'refused',
      operation: null,
      tenant: null,
      method: plain(method, 16),
      target: plain(url, 300),
      status: null,
      sent: why,
    });
    return 0;
  };
  const post = (url: string, method: string, rawHeaders: unknown, body: Buffer): Promise<number> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return Promise.resolve(refuseDelivery(String(url), method, 'refused: not a URL'));
    }
    if (!METHODS.has(method))
      return Promise.resolve(refuseDelivery(url, method, 'refused: not an HTTP method'));
    if (target.protocol !== 'http:' || !tenantHost.test(target.hostname))
      return Promise.resolve(refuseDelivery(url, method, "refused: not a tenant's host in this world"));
    if (target.pathname.startsWith('/_sandbox'))
      return Promise.resolve(refuseDelivery(url, method, "refused: the product's own sandbox hooks"));
    if (inFlight >= DELIVERIES_IN_FLIGHT)
      return Promise.resolve(refuseDelivery(url, method, 'refused: too many at once'));
    const headers = shapeHeaders(rawHeaders, (name) => ALWAYS_SENT.has(name) || declared.has(name));
    inFlight++;
    return new Promise<number>((done) => {
      const finish = (status: number, answered: string) => {
        inFlight--;
        record({
          kind: 'deliver',
          operation: null,
          tenant: target.hostname.split('.')[0]!,
          method,
          target: plain(url, 500),
          status,
          sent: cut(body),
          answered,
        });
        done(status);
      };
      try {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: Number(world.port),
            method,
            path: `${target.pathname}${target.search}`,
            headers: { ...headers, host: target.host, 'content-length': String(body.length) },
            timeout: 30_000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => finish(res.statusCode ?? 0, cut(Buffer.concat(chunks))));
            res.on('error', (e) => finish(0, e.message));
          },
        );
        req.on('timeout', () => req.destroy(new Error('the product did not answer within 30 s')));
        req.on('error', (e) => finish(0, e.message));
        req.end(body);
      } catch (e) {
        finish(0, (e as Error).message);
      }
    });
  };
  const held: (() => Promise<void>)[] = [];
  let holdTimer: NodeJS.Timeout | undefined;
  const deliver = async (m: Record<string, unknown>) => {
    const deliveryId = String(m.id);
    const url = String(m.url ?? '').slice(0, 4096);
    const method = String(m.method ?? 'POST')
      .slice(0, 16)
      .toUpperCase();
    const body = decode(typeof m.body === 'string' ? m.body : '');
    const run = async () => {
      const status = await post(url, method, m.headers, body);
      send({ type: 'delivered', id: deliveryId, status });
    };
    if (takeGeneral('duplicate', null, null)) {
      await run();
      await post(url, method, m.headers, body);
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
          void all.reduce((p, f) => p.then(f), Promise.resolve()).catch(() => undefined);
        },
        Math.min(Number(reorder?.param?.windowMs ?? 500), 10_000),
      );
      return;
    }
    await run();
  };

  let ready: () => void = () => undefined;
  const started = new Promise<void>((r) => (ready = r));
  lines(
    child.stdout!,
    (line) => {
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        return; // anything but a message is ignored, never parsed as data
      }
      if (!isObject(m) || typeof m.type !== 'string') return;
      if (m.type === 'ready') return ready();
      if (m.type === 'deliver') {
        if (typeof m.id !== 'string') return;
        void deliver(m).catch(() => undefined);
        return;
      }
      if (typeof m.id !== 'string') return;
      const waiting = pending.get(m.id);
      pending.delete(m.id);
      waiting?.resolve(m);
    },
    () => kill('it wrote a message over 32 MB'),
  );
  const hanging = new Set<ServerResponse>();
  const exited = new Promise<number | null>((r) =>
    child.on('exit', (code) => {
      if (!stoppedWhy) stoppedWhy = `it exited (code ${code})`;
      for (const [key, p] of pending) {
        pending.delete(key);
        p.fail(stoppedWhy);
      }
      for (const res of hanging) res.destroy();
      r(code);
    }),
  );

  const cleanUp = async () => {
    clearInterval(refusals);
    kill('stopped');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    rmSync(tmp, { recursive: true, force: true });
  };

  send({ type: 'start', baseDomain: options.baseDomain, clock: options.clock ?? null, tmp });
  const why = await Promise.race([
    started.then(() => null),
    exited.then(() => `it stopped before it was ready: ${stoppedWhy} (its stderr is on Swarmbox's console)`),
    new Promise<string>((r) => {
      const ms = options.readyTimeoutMs ?? READY_MS;
      setTimeout(() => r(`it was not ready within ${ms / 1000} s`), ms).unref();
    }),
  ]);
  if (why) {
    await cleanUp();
    throw new Error(`${manifest.name}: ${why}`);
  }

  // The provider's port.
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_LINE / 2) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks)).catch(() => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
    });
  });
  const handle = async (req: IncomingMessage, res: ServerResponse, body: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://standin');
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]),
    );
    const method = req.method ?? 'GET';
    const op = operationOf(manifest, method, url.pathname);
    const auth = headers.authorization ?? '';
    const basic = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
    const hay = [url.pathname, url.search, basic, ...Object.values(headers), body.toString('utf8')].join(
      '\n',
    );
    const tenant = tenantOf(hay);
    const base = {
      kind: 'request' as const,
      operation: op?.name ?? null,
      tenant,
      method,
      target: `${url.pathname}${url.search}`,
    };
    const answer = (status: number, h: Record<string, string>, b: Buffer, behaviour?: Behaviour) => {
      record({ ...base, sent: cut(body), status, answered: cut(b), ...(behaviour ? { behaviour } : {}) });
      res.writeHead(status, h).end(b);
    };

    // A real live key never reaches a stand-in, and is never logged.
    if (LIVE_CREDENTIAL.test(hay)) {
      record({ ...base, status: 401, sent: '[a live credential: refused, not logged]' });
      return res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Swarmbox stand-ins refuse live credentials' }));
    }
    if (takeGeneral('hang', base.operation, tenant)) {
      record({ ...base, sent: cut(body), status: null, behaviour: 'hang' });
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
      const retry = String(Math.max(0, Math.min(3600, Number(limited.param?.retryAfterSec ?? 1) || 1)));
      return answer(
        a.status,
        { 'content-type': 'application/json', 'retry-after': retry, ...a.headers },
        Buffer.from(JSON.stringify(a.body ?? {})),
        'limit',
      );
    }
    const slow = takeGeneral('slow', base.operation, tenant);
    if (slow)
      await new Promise((r) => setTimeout(r, Math.min(Number(slow.param?.delayMs ?? 5000) || 0, 120_000)));
    if (stoppedWhy)
      return answer(
        502,
        { 'content-type': 'text/plain' },
        Buffer.from(`the ${manifest.name} stand-in stopped`),
      );

    const rid = id();
    const replied = wait(rid, requestMs, 'a request');
    send({
      type: 'request',
      id: rid,
      operation: op?.name ?? null,
      params: op?.params ?? {},
      tenant,
      method,
      path: url.pathname,
      query: url.search.slice(1),
      headers,
      body: encode(body),
    });
    let reply: Record<string, unknown>;
    try {
      reply = await replied;
    } catch (e) {
      const timedOut = !stoppedWhy;
      return answer(
        timedOut ? 504 : 502,
        { 'content-type': 'text/plain' },
        Buffer.from(plain((e as Error).message)),
      );
    }
    const status = Number(reply.status);
    if (reply.type !== 'response' || !Number.isInteger(status) || status < 100 || status > 599)
      return answer(502, { 'content-type': 'text/plain' }, Buffer.from('the stand-in gave no valid answer'));
    answer(
      status,
      shapeHeaders(reply.headers),
      decode(typeof reply.body === 'string' ? reply.body : ''),
      slow ? 'slow' : undefined,
    );
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    manifest,
    origin,
    baseUrls: Object.fromEntries(
      Object.entries(manifest.connect.baseUrls).map(([k, p]) => [k, `${origin}${p === '/' ? '' : p}`]),
    ),
    async account(tenant) {
      const made = await ask({ type: 'account', id: id(), tenant }, 'an account');
      let creds: Record<string, string>;
      try {
        creds = shapeAccount(made, manifest.accounts.fields);
      } catch (e) {
        // What's wrong names the stand-in's own fields: its words, so framed as its refusal.
        throw new StandInError(manifest.name, 'an account', plain((e as Error).message));
      }
      accounts.set(tenant, creds);
      return creds;
    },
    async behave(input) {
      if (!manifest.behaviours.includes(input.behaviour))
        throw new Error(
          `${manifest.name} doesn't support "${input.behaviour}"; it supports ${manifest.behaviours.join(', ')}`,
        );
      // The stand-in's own count goes stale as its counted rules run out: ask it before refusing.
      if (rules.length + ownRules.size + ownPending >= RULES_KEPT) await refreshOwn();
      if (rules.length + ownRules.size + ownPending >= RULES_KEPT)
        throw new Error(`${manifest.name} has ${RULES_KEPT} behaviours applied already: clear some first`);
      const rule: Rule = {
        ...input,
        ...(input.param ? { param: shapeParam(input.param) } : {}),
        ...(input.count !== undefined
          ? { count: Math.max(1, Math.min(Math.floor(input.count), 100_000)) }
          : {}),
        id: randomBytes(4).toString('hex'),
      };
      if (GENERAL.includes(rule.behaviour)) rules.push(rule);
      else {
        // Its slot is held while the stand-in answers, so calls at once can't all pass the cap.
        ownPending++;
        try {
          ownFrom(await ask({ type: 'behave', id: id(), rule }, 'a behaviour'));
        } finally {
          ownPending--;
        }
      }
      return rule;
    },
    rules: () => [...rules],
    async clearRules(ruleId) {
      rules = ruleId ? rules.filter((r) => r.id !== ruleId) : [];
      ownFrom(await ask({ type: 'unbehave', id: id(), ruleId: ruleId ?? null }, 'clearing behaviours'));
    },
    async inbound(kind, body) {
      if (!manifest.inbound.some((k) => k.kind === kind))
        throw new Error(
          `${manifest.name} has no inbound "${kind}"; it has ${manifest.inbound.map((k) => k.kind).join(', ') || 'none'}`,
        );
      const value = shapeData(await ask({ type: 'inbound', id: id(), kind, body }, `an inbound ${kind}`));
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
      await ask({ type: 'reset', id: id() }, 'a reset');
      ownRules.clear();
    },
    stopped: () => stoppedWhy,
    folder: tmp,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await cleanUp();
    },
  };
}
