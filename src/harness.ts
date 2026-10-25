/// <reference lib="dom" />
// (DOM types for the functions handed to a page to run there.)
//
// The harness: the worlds that are running, the screens open in them, and who is in control of each screen.
// The MCP tools and the control room are two views over this one object, so what an agent does through a
// tool and what a person sees on a tile are the same state by construction.
//
// Control of a screen is a rule, not a convention: while a person has a screen, agent actions on it are
// refused. Reads are still allowed, because watching what the person does is useful to the agent.

import net from 'node:net';
import type {
  CDPSession,
  Locator,
  Request as PwRequest,
  Response as PwResponse,
  Route,
} from 'playwright-core';
import type { CheckResult, Settled } from './checks.ts';
import {
  launchFleet,
  setCookies,
  type Appearance,
  type Fleet,
  type Screen,
  type Who,
} from './fleet/browser.ts';
import {
  behindModal,
  changes,
  dialogsText,
  draw,
  glance,
  openDialogs,
  pickAmong,
  whyNotClicked,
  type Stroke,
} from './fleet/sight.ts';
import type { ClockMove, ClockState, FeedItem, Hooks } from './hooks.ts';
import type { Persona, Product, ProductWorld, WorldSpec } from './product.ts';

export type Controller = 'agent' | 'person';

export interface WorldEntry<W extends ProductWorld = ProductWorld> {
  id: string;
  spec: WorldSpec;
  world: W;
  fleet: Fleet;
  createdAt: Date;
  /** Sandbox time, once the world's clock has been moved: screens' browsers follow it. Null at rest. */
  clock: { at: string; paused: boolean } | null;
  /** Where each tenant's feed has been read to, so an action reports what happened after it, only. */
  feedAt: Map<string, string>;
}

export interface ScreenEntry {
  id: string;
  worldId: string;
  /** For a customer's screen, a stand-in: the tenant, and "Customer (link)" as who. */
  persona: Persona;
  /** Opened at a customer's link, with no sign-in (openLink). */
  customer: boolean;
  /** The app it was opened in; undefined for the product's main one. */
  app: string | undefined;
  screen: Screen;
  controller: Controller;
  cdp: CDPSession;
  /** The most recent screencast frame, JPEG. Undefined until the first frame arrives. */
  frame: Buffer | undefined;
  /** Counts frames, so the control room fetches a picture only when there is a new one. */
  frameSeq: number;
  /** Called with each new frame: the control room's live streams. */
  watchers: Set<(frame: Buffer) => void>;
  /** What the screen's browser reported going wrong, newest last (bounded). */
  signals: Signal[];
  /** Whether this screen's browser clock follows the world's (once the world's clock has moved). */
  clockInstalled?: boolean;
  network: NetworkMode;
  /** Cut off every request the screen's network is holding (a stall), as a dropped connection does. */
  releaseStalled(): void;
}

/**
 * Something a screen's browser saw go wrong without anyone asking: an error in the console or an uncaught
 * one, a server error, a request that failed. Collected on every screen from its first request; a run's
 * report lists the ones from its own time.
 */
export interface Signal {
  at: string;
  screen: string;
  kind: 'console-error' | 'page-error' | 'server-error' | 'request-failed';
  text: string;
  url?: string;
}

export type NetworkMode =
  | { mode: 'online' }
  | { mode: 'offline' }
  /** Matching requests get no answer and no error, until the screen is set online again. */
  | { mode: 'stall'; match: string }
  /** Matching requests are answered late. */
  | { mode: 'slow'; match: string; delayMs: number };

const SIGNALS_KEPT = 500;

export interface HarnessOptions {
  /** Headed by default: the screens are meant to be watched and taken over. */
  headless?: boolean;
  /** Slows every browser action, so a person can follow along. */
  slowMo?: number;
}

/** A refusal the caller can show as-is: wrong arguments, a screen someone else has, and so on. */
export class HarnessError extends Error {}

const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const;
/** Long enough that a click's re-render has landed, short enough not to stall the agent. */
const SETTLE_MS = 400;
const READ_LIMIT = 12_000;
/** After a command, how long to wait for the worker's first consequences (a text sent or refused). */
const WORKER_MS = 1_200;
/** How many ports past the product's first a world may take. */
const PORT_RANGE = 50;

/** A request the tenant's server refused, as one line: what was asked, the status and the reason. */
async function refusal(r: PwResponse, origin: string): Promise<string> {
  let why = '';
  try {
    const b = (await r.json()) as {
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    why = [b.error?.code ?? b.code, b.error?.message ?? b.message].filter(Boolean).join(': ');
  } catch {
    // Not JSON: the status says enough.
  }
  return `${r.request().method()} ${r.url().slice(origin.length) || '/'} → ${r.status()}${why ? ` ${why.slice(0, 200)}` : ''}`;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}

export interface OpenScreenOptions extends Appearance {
  address?: string;
  /** One of the product's apps (Product.apps); default its main one. */
  app?: string;
}

export interface Harness<W extends ProductWorld = ProductWorld> {
  readonly product: Product<W>;
  createWorld(spec?: Partial<WorldSpec>): Promise<WorldEntry<W>>;
  /** A full rebuild: the same spec on the same port. */
  resetWorld(worldId: string): Promise<WorldEntry<W>>;
  destroyWorld(worldId: string): Promise<void>;
  worlds(): WorldEntry<W>[];
  world(worldId: string): WorldEntry<W>;
  people(worldId: string): Promise<Persona[]>;
  openScreen(
    worldId: string,
    personId: string,
    path?: string,
    options?: OpenScreenOptions,
  ): Promise<ScreenEntry>;
  /**
   * Open a customer's link (an estimate, an invoice, an invitation) as the customer would: a browser with no
   * sign-in, on the tenant's own host. The full link or just its path.
   */
  openLink(worldId: string, link: string, options?: Appearance & { address?: string }): Promise<ScreenEntry>;
  /** Change what a screen's network does: airplane mode, a signal that stalls, a slow one, or back to normal. */
  setNetwork(screenId: string, mode: NetworkMode): Promise<void>;
  screens(): ScreenEntry[];
  screen(screenId: string): ScreenEntry;
  read(screenId: string): Promise<string>;
  act(screenId: string, action: Action): Promise<string>;
  image(screenId: string): Promise<Buffer>;
  setController(screenId: string, controller: Controller): Promise<void>;
  /**
   * What a person does on a tile they have taken over, sent to that screen's browser: a click or a wheel at
   * a point given as a fraction of the picture (so any tile size works), a key, or text. Refused unless the
   * person has the screen, as the agent's actions are refused while they do.
   */
  personInput(screenId: string, input: PersonInput): Promise<void>;
  closeScreen(screenId: string): Promise<void>;
  /**
   * Read the world's clock, or move it (forward only), through the product's hooks, and bring every screen's
   * browser to the same time: "today" and a byline's date are decided in the browser.
   */
  moveClock(worldId: string, move?: ClockMove): Promise<ClockState>;
  /** Wait for the product's background work to catch up, then run its checks against the world. */
  check(worldId: string): Promise<{ settled: Record<string, Settled>; results: CheckResult[] }>;
  /** The world's hooks, or a refusal saying why there are none. */
  hooks(worldId: string): Promise<Hooks>;
  shutdown(): Promise<void>;
}

export type PersonInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; dy: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string };

export type Action =
  | { kind: 'click'; role: string; name: string; exact?: boolean; index?: number }
  | { kind: 'fill'; label: string; text: string; exact?: boolean; index?: number }
  | { kind: 'select'; label: string; option: string; exact?: boolean; index?: number }
  | { kind: 'press'; key: string }
  /** A path on the tenant's host, or a full link to it (as a text or email gives one), port or not. */
  | { kind: 'goto'; path: string }
  /** Pointer strokes on an element found by its label (a signature pad), as fractions of its box. */
  | { kind: 'draw'; label: string; exact?: boolean; index?: number; strokes?: Stroke[] };

/**
 * Playwright's URL glob, for matching inside one route: ** is anything, * is anything but a slash,
 * ? is one character. A pattern with no scheme matches the URL's path and what follows it.
 */
export function globMatches(glob: string, url: string): boolean {
  const re = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${re}$`).test(url);
}

export interface LinkWorld {
  baseDomain: string;
  tenants: readonly string[];
  tenantOfPath?(path: string): string | undefined;
}

/**
 * A link or path on a tenant's own host, as the path to open there. A full link must be on the tenant's
 * host (`<tenant>.<baseDomain>`, with or without the world's port: products write links without it). A
 * bare path names its tenant the way the product's links do (tenantOfPath), or is on the only tenant.
 */
export function linkPath(
  link: string,
  world: LinkWorld,
  only?: string,
  noun = 'tenant',
): { tenant: string; path: string } {
  const { baseDomain, tenants } = world;
  let tenant: string | undefined;
  let path = link.trim();
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith(`.${baseDomain}`))
      throw new HarnessError(`${u.hostname} is not a ${noun} here; links here are on *.${baseDomain}`);
    tenant = host.slice(0, -(baseDomain.length + 1));
    path = `${u.pathname}${u.search}${u.hash}`;
  }
  if (!path.startsWith('/'))
    throw new HarnessError(`a path on the ${noun}’s host starts with /, or give the full link`);
  tenant ??= only ?? world.tenantOfPath?.(path) ?? (tenants.length === 1 ? tenants[0] : undefined);
  if (!tenant)
    throw new HarnessError(`say which ${noun}: give the full link (this world has ${tenants.join(', ')})`);
  if (only && tenant !== only)
    throw new HarnessError(`that link is ${tenant}’s; this screen is on ${only}’s host`);
  if (!tenants.includes(tenant)) throw new HarnessError(`this world has no ${noun} ${tenant}`);
  return { tenant, path };
}

/** Text from a feed row's field, or nothing. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * One line for the agent about something the server did, or null when it's nothing to tell: this
 * screen's own commands (with what they set off), and anything anywhere in the tenant that failed or
 * was refused, such as a text the worker couldn't send a second after the office was told it went.
 */
export function feedLine(it: FeedItem, s: Pick<ScreenEntry, 'customer' | 'persona'>): string | null {
  if (it.kind === 'action') {
    const p = (it.principal ?? {}) as { kind?: string; membershipId?: string; id?: string };
    const who = p.membershipId ?? (p.kind === 'customer' ? undefined : p.id);
    const mine = s.customer ? p.kind === 'customer' : Boolean(who) && who === s.persona.id;
    const outcome = str(it.outcome) || 'ok';
    const name = str(it.name);
    const failure = /failed/i.test(name);
    if (it.actionKind === 'query' && outcome === 'ok') return null;
    if (!mine && outcome === 'ok' && !failure) return null;
    const nested =
      Array.isArray(it.nested) && it.nested.length
        ? ` → ${(it.nested as unknown[]).map(str).join(', ')}`
        : '';
    const code = str(it.errorCode) ? ` (${str(it.errorCode)})` : '';
    const input = (it.input ?? {}) as Record<string, unknown>;
    const said = failure
      ? [str(input.code), str(input.message)].filter(Boolean).join(': ').slice(0, 200)
      : '';
    const by = mine
      ? 'you'
      : p.kind === 'system'
        ? 'the system'
        : p.kind === 'customer'
          ? 'a customer'
          : p.kind === 'agent'
            ? 'an agent'
            : 'someone else';
    return `${by}: ${name} ${outcome}${code}${nested}${said ? ` — ${said}` : ''}`;
  }
  if (it.kind === 'delivery') {
    const status = str(it.status);
    if (status !== 'failed' && status !== 'dead') return null;
    const error = str(it.error).slice(0, 200);
    return `the worker: ${str(it.handler)} on ${str(it.type)} ${status}${error ? ` — ${error}` : ''}`;
  }
  return null;
}

const SERVER_LINES = 15;

/**
 * A form field by its accessible name, among the roles that can take this action. A label search alone
 * also matches regions, groups and buttons whose names contain the words ("Technicians" for "Technician"),
 * and a label that wraps a select carries every option's text, so exact never matches it. The label
 * search stays as the fallback for fields with no role match.
 */
async function field(
  page: Screen['page'],
  roles: ('combobox' | 'listbox' | 'textbox' | 'searchbox' | 'spinbutton')[],
  name: string,
  exact: boolean,
) {
  const byRole = roles.map((role) => page.getByRole(role, { name, exact })).reduce((a, b) => a.or(b));
  return (await byRole.count()) > 0 ? byRole : page.getByLabel(name, { exact });
}

/** Bring one screen's browser to the world's sandbox time, paused or running. */
async function followClock(s: ScreenEntry, clock: { at: string; paused: boolean }): Promise<void> {
  const c = s.screen.context.clock;
  const at = new Date(clock.at);
  // Fixed time freezes the page's Date while its timers keep running, so a paused world stands still
  // and the app stays usable; system time sets the date and lets it run on. Either works in any order
  // (checked against Playwright), and neither needs the fake timers installed.
  if (clock.paused) await c.setFixedTime(at);
  else await c.setSystemTime(at);
  s.clockInstalled = true;
}

export function createHarness<W extends ProductWorld>(
  product: Product<W>,
  options: HarnessOptions = {},
): Harness<W> {
  const noun = product.tenantNoun ?? 'tenant';
  const worlds = new Map<string, WorldEntry<W>>();
  const screens = new Map<string, ScreenEntry>();
  let nextWorld = 1;
  let nextScreen = 1;
  // World creation picks a port and then starts on it; two at once must not pick the same one.
  let creating: Promise<unknown> = Promise.resolve();

  const getWorld = (id: string): WorldEntry<W> => {
    const w = worlds.get(id);
    if (!w)
      throw new HarnessError(
        `there is no world ${id}; running worlds: ${[...worlds.keys()].join(', ') || 'none'}`,
      );
    return w;
  };
  const getScreen = (id: string): ScreenEntry => {
    const s = screens.get(id);
    if (!s)
      throw new HarnessError(
        `there is no screen ${id}; open screens: ${[...screens.keys()].join(', ') || 'none'}`,
      );
    return s;
  };

  async function freePort(): Promise<number> {
    // Port base 0: any free port, the product's own choice (tests run that way).
    if (product.portBase === 0) return 0;
    const taken = new Set([...worlds.values()].map((w) => w.world.port));
    for (let p = product.portBase; p < product.portBase + PORT_RANGE; p++)
      if (!taken.has(p) && (await portFree(p))) return p;
    throw new HarnessError(`no free port from ${product.portBase} to ${product.portBase + PORT_RANGE - 1}`);
  }

  async function startEntry(id: string, spec: WorldSpec, port?: number): Promise<WorldEntry<W>> {
    const world = await product.startWorld(spec, port ?? (await freePort()));
    try {
      const fleet = await launchFleet({
        baseDomain: world.baseDomain,
        port: world.port,
        headless: options.headless ?? false,
        ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
      });
      return { id, spec, world, fleet, createdAt: new Date(), clock: null, feedAt: new Map() };
    } catch (e) {
      await world.stop();
      throw e;
    }
  }

  async function closeEntry(s: ScreenEntry): Promise<void> {
    screens.delete(s.id);
    s.watchers.clear();
    await s.cdp.detach().catch(() => undefined);
    await s.screen.close();
  }

  async function stopEntry(w: WorldEntry<W>): Promise<void> {
    for (const s of [...screens.values()].filter((s) => s.worldId === w.id)) await closeEntry(s);
    await w.fleet.close();
    await w.world.stop();
  }

  /**
   * Locate the one element an action means, or say clearly why it is not one. Of several, the one in
   * the dialog holding the screen is meant; otherwise each is described, to pick by index.
   */
  async function target(
    s: ScreenEntry,
    locator: Locator,
    what: string,
    index: number | undefined,
  ): Promise<{ el: Locator; why: string }> {
    const count = await locator.count();
    if (count === 0) {
      const open = (await openDialogs(s.screen.page)).find((d) => d.modal);
      throw new HarnessError(
        `nothing on screen matches ${what}${open ? ` (the dialog "${open.title}" is open: only it can be used)` : ''}; read the screen and try again`,
      );
    }
    if (index !== undefined) {
      if (index < 0 || index >= count)
        throw new HarnessError(`${what} matches ${count}; index ${index} is out of range`);
      return { el: locator.nth(index), why: '' };
    }
    if (count === 1) return { el: locator, why: '' };
    const p = await pickAmong(locator, count);
    if (p.index !== null) return { el: locator.nth(p.index), why: p.why };
    throw new HarnessError(
      `${what} matches ${count} elements; pass index (0-${count - 1}) to pick one:\n  ${p.described.join('\n  ')}`,
    );
  }

  /** Refuse, with the reason, an action on something behind a modal dialog: it would only time out. */
  async function reachable(el: Locator, what: string): Promise<void> {
    const dialog = await behindModal(el);
    if (dialog)
      throw new HarnessError(
        `${what} is behind the open dialog "${dialog}": act in the dialog, or close it first`,
      );
  }

  /** Whether the world's product has its hooks (asked once per world, kept once they answer). */
  const hooksUp = new Map<string, boolean>();
  async function hooked(w: WorldEntry<W>): Promise<Hooks | null> {
    const hooks = w.world.hooks;
    if (!hooks) return null;
    if (hooksUp.get(w.id)) return hooks;
    const up = (await hooks.available().catch(() => 'unreachable')) === null;
    if (up) hooksUp.set(w.id, true);
    return up ? hooks : null;
  }

  /** Read a tenant's feed to its end, once, so later reads start from now. */
  async function feedCursor(w: WorldEntry<W>, tenant: string): Promise<void> {
    if (w.feedAt.has(tenant)) return;
    const hooks = await hooked(w);
    if (!hooks) return;
    let page = await hooks.feed(tenant, { limit: 500 });
    for (let i = 0; i < 200 && page.items.length === 500; i++)
      page = await hooks.feed(tenant, { after: page.next, limit: 500 });
    w.feedAt.set(tenant, page.next);
  }

  /** What the server did since a tenant's feed was last read, as lines for this screen's agent. */
  async function serverSince(w: WorldEntry<W>, s: ScreenEntry): Promise<string[]> {
    const after = w.feedAt.get(s.persona.tenant);
    const hooks = w.world.hooks;
    if (after === undefined || !hooks) return [];
    const lines: string[] = [];
    let cursor = after;
    for (let i = 0; i < 10; i++) {
      const page = await hooks.feed(s.persona.tenant, { after: cursor, limit: 500 });
      for (const it of page.items) {
        const line = feedLine(it, s);
        if (line) lines.push(line);
      }
      cursor = page.next;
      if (page.items.length < 500) break;
    }
    w.feedAt.set(s.persona.tenant, cursor);
    return lines;
  }

  /**
   * A screen for someone already worked out: a signed-in person, or a customer with a link. Everything a
   * screen carries from here on is the same for both: its signals, its network, its live picture, its clock.
   */
  async function attach(
    w: WorldEntry<W>,
    persona: Persona,
    who: Who,
    path: string | undefined,
    options: OpenScreenOptions & { customer?: boolean },
  ): Promise<ScreenEntry> {
    const worldId = w.id;
    const customer = options.customer ?? false;
    const id = `s${nextScreen++}`;
    const signals: Signal[] = [];
    // Set once the screen exists; the listeners below can fire during its first page load, before that.
    const ref: { entry?: ScreenEntry } = {};
    // Requests the sandbox cut off itself (a stall let go): the condition, never a finding.
    const deliberate = new WeakSet<PwRequest>();
    // Their addresses too: Chrome's console line for a request cut off carries the URL, not the request.
    const cutUrls = new Set<string>();
    const stalled = new Set<Route>();
    const signal = (kind: Signal['kind'], text: string, url?: string) => {
      signals.push({
        at: new Date().toISOString(),
        screen: id,
        kind,
        text: text.slice(0, 1000),
        ...(url ? { url } : {}),
      });
      if (signals.length > SIGNALS_KEPT) signals.shift();
    };
    const screen = await w.fleet.open(who, path ?? who.signIn?.path ?? '/', {
      ...(options.address ? { address: options.address } : {}),
      ...(options.device ? { device: options.device } : {}),
      ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
      onContext: (ctx) => {
        ctx.on('console', (m) => {
          // A 4xx is the server refusing something, which the app handles and shows (a conflict, a
          // validation error); Chrome logs each as a console error regardless. 5xx are server-error below.
          if (m.type() !== 'error' || /status of 4\d\d\b/.test(m.text())) return;
          // Offline or stalled on purpose, Chrome logs each request it could not make: the condition, not a finding.
          if (/net::ERR_/.test(m.text())) {
            if (ref.entry && ref.entry.network.mode !== 'online') return;
            if (cutUrls.delete(m.location().url)) return;
          }
          signal('console-error', m.text(), m.location().url || undefined);
        });
        ctx.on('weberror', (e) => signal('page-error', String(e.error()?.stack ?? e.error())));
        ctx.on('response', (r) => {
          if (r.status() >= 500) signal('server-error', `${r.status()} ${r.request().method()}`, r.url());
        });
        ctx.on('requestfailed', (r) => {
          // A stalled or offline screen fails requests on purpose; those are the condition, not a finding.
          if (deliberate.has(r) || (ref.entry && ref.entry.network.mode !== 'online')) return;
          // Aborted by the page itself: a reload or a move away cancels what was in flight, as does the
          // app's own AbortController. Nothing failed.
          if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
          signal('request-failed', `${r.method()} ${r.failure()?.errorText ?? 'failed'}`, r.url());
        });
      },
    });
    // One route for the screen's whole life, reading its network mode per request. Adding and removing
    // routes per mode hung: removing one waits for its handlers, and a stalled request never returns.
    // It runs before the address route (later routes run first) and hands requests on with fallback.
    await screen.context.route('**/*', async (route) => {
      const mode = ref.entry?.network ?? { mode: 'online' as const };
      const url = route.request().url();
      if (mode.mode === 'stall' && globMatches(mode.match, url)) {
        stalled.add(route); // no answer and no error, until the signal comes back
        return;
      }
      if (mode.mode === 'slow' && globMatches(mode.match, url))
        await new Promise((r) => setTimeout(r, mode.delayMs));
      await route.fallback().catch(() => undefined);
    });
    const cdp = await screen.context.newCDPSession(screen.page);
    ref.entry = {
      id,
      worldId,
      persona,
      customer,
      app: options.app,
      screen,
      controller: 'agent',
      cdp,
      frame: undefined,
      frameSeq: 0,
      watchers: new Set(),
      signals,
      network: { mode: 'online' },
      releaseStalled: () => {
        for (const route of stalled) {
          deliberate.add(route.request());
          cutUrls.add(route.request().url());
          void route.abort('connectionaborted').catch(() => undefined);
        }
        stalled.clear();
      },
    };
    const made = ref.entry;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      made.frame = Buffer.from(f.data, 'base64');
      made.frameSeq++;
      for (const watch of made.watchers) watch(made.frame);
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    // Keep painting while another screen is in front (see the launch flags in fleet/browser.ts).
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Page.startScreencast', SCREENCAST);
    screens.set(made.id, made);
    try {
      // A screen opened after the world's clock moved starts on the world's time, not this machine's, read
      // now: a running clock has moved on since it was last set.
      if (w.clock && w.world.hooks) {
        const now = await w.world.hooks.clock();
        w.clock = { at: now.process.at, paused: now.clock.frozenAt !== null };
        await followClock(made, w.clock);
      }
      await who.signIn?.ready?.(screen.page);
    } catch (e) {
      // A screen that can't be put on the world's time, or past its app's first screen, is not handed out
      // half-made.
      await closeEntry(made).catch(() => undefined);
      throw e;
    }
    // As after an action: give the app a moment to draw what its first requests brought back.
    await screen.page.waitForTimeout(SETTLE_MS);
    return made;
  }

  const harness: Harness<W> = {
    product,

    createWorld(partial = {}) {
      if (partial.keep && [...worlds.values()].some((w) => w.spec.keep === partial.keep))
        return Promise.reject(new HarnessError(`kept world ${partial.keep} is already running here`));
      const spec: WorldSpec = {
        tenants: partial.tenants ?? [],
        seed: partial.seed ?? false,
        ...(partial.keep ? { keep: partial.keep } : {}),
        ...(partial.options ? { options: partial.options } : {}),
      };
      const id = `w${nextWorld++}`;
      const run = creating.then(async () => {
        const entry = await startEntry(id, spec);
        worlds.set(id, entry);
        return entry;
      });
      creating = run.catch(() => undefined);
      return run;
    },

    async resetWorld(worldId) {
      const old = getWorld(worldId);
      const port = old.world.port;
      worlds.delete(worldId);
      await stopEntry(old);
      const entry = await startEntry(worldId, old.spec, port);
      worlds.set(worldId, entry);
      return entry;
    },

    async destroyWorld(worldId) {
      const w = getWorld(worldId);
      worlds.delete(worldId);
      await stopEntry(w);
    },

    worlds: () => [...worlds.values()],
    world: getWorld,

    people: (worldId) => getWorld(worldId).world.people(),

    async openScreen(worldId, personId, path, options = {}) {
      const w = getWorld(worldId);
      const persona = (await w.world.people()).find((p) => p.id === personId);
      if (!persona) throw new HarnessError(`world ${worldId} has nobody with id ${personId}`);
      if (options.app !== undefined && !(product.apps ?? []).includes(options.app))
        throw new HarnessError(
          `${product.name} has no app ${options.app}; its apps: ${['(main)', ...(product.apps ?? [])].join(', ')}`,
        );
      const signIn = await w.world.signIn(persona, options.app);
      return attach(w, persona, { persona, signIn }, path, options);
    },

    async openLink(worldId, link, options = {}) {
      const w = getWorld(worldId);
      const { tenant, path } = linkPath(link, w.world, undefined, noun);
      const someone = (await w.world.people()).find((p) => p.tenant === tenant);
      // A stand-in: the tenant and its time zone are real, the person is whoever has the link.
      const persona: Persona = {
        id: '',
        tenant,
        label: 'Customer (link)',
        name: 'Customer',
        email: '',
        roles: ['customer'],
        timeZone: someone?.timeZone ?? 'UTC',
      };
      return attach(w, persona, { persona, signIn: null }, path, { ...options, customer: true });
    },

    screens: () => [...screens.values()],
    screen: getScreen,

    async setNetwork(screenId, mode) {
      const s = getScreen(screenId);
      // The screen's one network route (attach) reads the mode on every request, so a change is just
      // this: let go of anything a stall is holding, then say what the network does now.
      s.releaseStalled();
      await s.screen.context.setOffline(mode.mode === 'offline');
      s.network = mode;
    },

    async read(screenId) {
      const s = getScreen(screenId);
      const page = s.screen.page;
      // Open dialogs first and whole: on a long page they are drawn last, and a cut page lost them.
      const [tree, dialogs] = await Promise.all([page.ariaSnapshot({ timeout: 10_000 }), openDialogs(page)]);
      const mode = s.network.mode === 'online' ? '' : ` [network: ${s.network.mode}]`;
      const head = `${s.persona.label} @ ${page.url()} — "${await page.title()}" [controlled by ${s.controller}]${mode}`;
      const body =
        tree.length > READ_LIMIT
          ? `${tree.slice(0, READ_LIMIT)}\n… (${tree.length - READ_LIMIT} more characters)`
          : tree;
      const top = dialogsText(dialogs);
      return `${head}\n${top ? `${top}\n` : ''}${body}`;
    },

    async act(screenId, action) {
      const s = getScreen(screenId);
      if (s.controller !== 'agent')
        throw new HarnessError(
          `${s.persona.name}'s screen ${s.id} is with a person right now; actions are refused until it is handed back`,
        );
      const w = getWorld(s.worldId);
      const page = s.screen.page;
      const before = await glance(page);
      // From here: what the server does next is what this action caused (or something late finishing).
      await feedCursor(w, s.persona.tenant);
      const origin = w.fleet.originFor(s.persona.tenant);
      const refused: Promise<string>[] = [];
      const onResponse = (r: PwResponse) => {
        if (r.status() >= 400 && r.url().startsWith(origin)) refused.push(refusal(r, origin));
      };
      page.on('response', onResponse);
      let did = '';
      try {
        switch (action.kind) {
          case 'click': {
            const what = `role=${action.role} name="${action.name}"`;
            const t = await target(
              s,
              page.getByRole(action.role as Parameters<typeof page.getByRole>[0], {
                name: action.name,
                exact: action.exact ?? false,
              }),
              what,
              action.index,
            );
            await reachable(t.el, what);
            did = `clicked ${action.role} "${action.name}"${t.why ? `, ${t.why}` : ''}`;
            await t.el.click({ timeout: 10_000 }).catch((e: unknown) => {
              throw new HarnessError(`could not click ${what}: ${whyNotClicked(e)}`);
            });
            break;
          }
          case 'fill': {
            const what = `label "${action.label}"`;
            const t = await target(
              s,
              await field(page, ['textbox', 'searchbox', 'spinbutton'], action.label, action.exact ?? false),
              what,
              action.index,
            );
            await reachable(t.el, what);
            did = `filled "${action.label}"${t.why ? `, ${t.why}` : ''}`;
            await t.el.fill(action.text, { timeout: 10_000 }).catch((e: unknown) => {
              throw new HarnessError(`could not fill ${what}: ${whyNotClicked(e)}`);
            });
            break;
          }
          case 'select': {
            const what = `label "${action.label}"`;
            const t = await target(
              s,
              await field(page, ['combobox', 'listbox'], action.label, action.exact ?? false),
              what,
              action.index,
            );
            await reachable(t.el, what);
            did = `chose "${action.option}" in "${action.label}"${t.why ? `, ${t.why}` : ''}`;
            await t.el.selectOption({ label: action.option }, { timeout: 10_000 }).catch((e: unknown) => {
              throw new HarnessError(`could not choose in ${what}: ${whyNotClicked(e)}`);
            });
            break;
          }
          case 'draw': {
            const what = `label "${action.label}"`;
            const t = await target(
              s,
              page.getByLabel(action.label, { exact: action.exact ?? false }),
              what,
              action.index,
            );
            await reachable(t.el, what);
            did = `drew on "${action.label}"${t.why ? `, ${t.why}` : ''}`;
            await draw(page, t.el, action.strokes).catch((e: unknown) => {
              throw new HarnessError(`could not draw on ${what}: ${(e as Error).message}`);
            });
            break;
          }
          case 'press':
            did = `pressed ${action.key}`;
            await page.keyboard.press(action.key);
            break;
          case 'goto': {
            const { path } = linkPath(action.path, w.world, s.persona.tenant, noun);
            did = `went to ${path}`;
            await page.goto(path, { waitUntil: 'load' });
            break;
          }
        }
        // Not networkidle: an app holding an event stream open never lets the network go idle.
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(SETTLE_MS);
      } finally {
        page.off('response', onResponse);
      }
      const changed = changes(before, await glance(page));
      let server: string[] = [];
      if (w.feedAt.has(s.persona.tenant)) {
        server = await serverSince(w, s);
        // A command sets the worker going (a text, a posting); give it a moment, so its failure shows here.
        if (server.some((l) => l.startsWith('you:'))) {
          await page.waitForTimeout(WORKER_MS);
          server.push(...(await serverSince(w, s)));
        }
      }
      const refusals = await Promise.all(refused);
      const report = [
        `did: ${did}`,
        `changed: ${changed.length ? changed.join('; ') : 'nothing a person would notice'}`,
        ...(server.length
          ? [
              `server: ${server.slice(0, SERVER_LINES).join('\n        ')}${server.length > SERVER_LINES ? `\n        … ${server.length - SERVER_LINES} more (feed_read has them)` : ''}`,
            ]
          : w.feedAt.has(s.persona.tenant)
            ? ['server: nothing from this screen']
            : []),
        ...(refusals.length ? [`refused: ${refusals.join('\n         ')}`] : []),
      ].join('\n');
      return `${report}\n---\n${await harness.read(screenId)}`;
    },

    async image(screenId) {
      return getScreen(screenId).screen.page.screenshot({ type: 'jpeg', quality: 70 });
    },

    async setController(screenId, controller) {
      const s = getScreen(screenId);
      s.controller = controller;
      if (controller === 'person') await s.screen.page.bringToFront().catch(() => undefined);
    },

    async personInput(screenId, input) {
      const s = getScreen(screenId);
      if (s.controller !== 'person') throw new HarnessError(`take over ${screenId} first`);
      const page = s.screen.page;
      const size =
        page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
      const at = (x: number, y: number) => {
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
          throw new HarnessError('x and y are fractions of the picture, 0 to 1');
        return { x: Math.round(x * size.width), y: Math.round(y * size.height) };
      };
      if (input.type === 'click') {
        const p = at(input.x, input.y);
        await page.mouse.click(p.x, p.y);
      } else if (input.type === 'wheel') {
        const p = at(input.x, input.y);
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, input.dy)));
      } else if (input.type === 'key') {
        if (!/^[A-Za-z0-9+]{1,40}$/.test(input.key)) throw new HarnessError('not a key name');
        await page.keyboard.press(input.key);
      } else {
        if (input.text.length > 2000) throw new HarnessError('too much text at once');
        await page.keyboard.insertText(input.text);
      }
    },

    async check(worldId) {
      const w = getWorld(worldId);
      // Settle first: checks read consequences (postings, deliveries), and without waiting they race the
      // worker. If it does not settle, the checks still run, and the report says so.
      const settled = await w.world.settle();
      return { settled, results: await w.world.check() };
    },

    async hooks(worldId) {
      const w = getWorld(worldId);
      if (!w.world.hooks) throw new HarnessError(`${product.name} has no Swarmbox hooks`);
      const why = await w.world.hooks.available();
      if (why) throw new HarnessError(why);
      return w.world.hooks;
    },

    async closeScreen(screenId) {
      await closeEntry(getScreen(screenId));
    },

    async moveClock(worldId, move) {
      const w = getWorld(worldId);
      const hooks = await harness.hooks(worldId);
      const state = move ? await hooks.moveClock(move) : await hooks.clock();
      if (move) {
        w.clock = { at: state.process.at, paused: state.clock.frozenAt !== null };
        for (const s of [...screens.values()].filter((x) => x.worldId === worldId)) {
          await followClock(s, w.clock);
          // Signed in again on the new time, as a person who kept using the app would still be. A customer's
          // screen has no sign-in to keep.
          if (!s.customer && w.world.renewSignIn)
            await setCookies(
              s.screen.context,
              w.fleet.originFor(s.persona.tenant),
              await w.world.renewSignIn(s.persona, s.app),
            );
        }
      }
      return state;
    },

    async shutdown() {
      for (const w of [...worlds.values()]) {
        worlds.delete(w.id);
        await stopEntry(w).catch(() => undefined);
      }
      await product.shutdown?.();
    },
  };
  return harness;
}
