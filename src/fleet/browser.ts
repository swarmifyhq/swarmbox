// The browser fleet: one screen per person, watchable and take-over-able.
//
// Swarmbox must own Chromium's launch, and this is forced rather than chosen. Tenant hostnames have no DNS
// record anywhere (no zone, no /etc/hosts entry) and resolve ONLY because Chromium is started with
// --host-resolver-rules. A generic browser automation server, or the operator's own Chrome, cannot reach a
// tenant's host at all. That is why Playwright is embedded here instead of chained as a separate MCP server.
//
// One Chromium per tenant origin, launched when that tenant's first screen opens. Web crypto (crypto.subtle)
// exists only in a secure context, and plain http is not one; Chromium will treat an origin as secure only
// when named exactly at launch (no wildcards), and a tenant's origin is known only once its world exists, so
// a single browser started up front cannot cover it. It needs the full Chromium build, not the headless
// shell, hence channel 'chromium'.
//
// A factory rather than a class: products run TypeScript through Node's strip-only loader, which does not
// support parameter properties.

import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import type { Persona, SignIn, StartCookie } from '../product.ts';

/** A sign-in's cookies, on the tenant's own origin: how a screen is signed in, and kept signed in. */
export async function setCookies(
  context: BrowserContext,
  origin: string,
  cookies: StartCookie[],
): Promise<void> {
  await context.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      url: origin,
      httpOnly: c.httpOnly ?? true,
      secure: false,
      sameSite: c.sameSite ?? 'Lax',
    })),
  );
}

/** Makes `*.{baseDomain}` resolve to loopback inside this browser, and nowhere else on the machine. */
export function resolverRule(baseDomain: string): string {
  return `--host-resolver-rules=MAP *.${baseDomain} 127.0.0.1`;
}

export interface FleetOptions {
  baseDomain: string;
  /** The port the product serves its tenants on, used to build each tenant's origin. */
  port: number;
  /** Headed is the default: the point of the sandbox is that the screens can be watched. */
  headless?: boolean;
  /** Slow actions down so a person can follow along. Milliseconds between operations. */
  slowMo?: number;
  /**
   * Provider pages a stand-in plays in the browser (a card form's script and iframe): every request to `origin`
   * is answered by the stand-in at `to`, so the page keeps the provider's origin and its origin checks pass.
   */
  routes?: { origin: string; to: string }[];
  /**
   * With routes, where else the browsers may go: the world's stand-ins and what the product loads from outside.
   * A routed provider page is the stand-in's own code in the browser, so the world's browsers then reach only the
   * world's hosts, the routed origins and these; every other request and WebSocket is blocked.
   */
  allowOrigins?: string[];
  /**
   * The world's stand-ins' own addresses (http://127.0.0.1:<port>): reachable from its browsers (a presigned
   * upload goes straight to S3's), but when its browsers play a provider's pages, only through the same checked
   * proxy as the routed origins, so a stand-in can't bounce the browser out with a redirect of its own.
   */
  standins?: string[];
}

/** What a page a stand-in plays may load and talk to: its own origin, nothing else. */
const ROUTED_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'self'; base-uri 'none'";

/** Hops Swarmbox follows itself between a stand-in's own pages before calling it a loop. */
const ROUTED_HOPS = 5;

/**
 * A request to a provider origin a stand-in plays, answered by that stand-in (FleetOptions.routes). Its redirects
 * are never left to the browser where the browser would leave the world, because Playwright routes only the first
 * URL of a navigation, not the hops after it:
 * - out of the world: refused here, with a 502;
 * - to a routed origin (the browser would go to the real provider) or a stand-in's own address (the browser would
 *   skip this proxy): a navigation is sent on afresh, so it is routed; anything else (a fetch, an image) is
 *   followed here, each hop checked;
 * - to the world's own hosts or what the product loads from outside: the browser follows it. The product is
 *   trusted: an open redirect of its own is a way out a stand-in could use, so a product shouldn't have one.
 */
async function answerRouted(route: Route, options: FleetOptions): Promise<void> {
  const req = route.request();
  const routes = options.routes ?? [];
  const headers = Object.fromEntries(
    Object.entries(await req.allHeaders()).filter(([k]) => !/^(host|cookie|:)/i.test(k)),
  );
  let url = new URL(req.url());
  let method = req.method();
  let body: Uint8Array<ArrayBuffer> | undefined =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0));
  const refuse = (what: string) =>
    route.fulfill({
      status: 502,
      headers: { 'content-type': 'text/plain', 'content-security-policy': ROUTED_CSP },
      body: `Swarmbox refused ${what}.`,
    });
  for (let hop = 0; ; hop++) {
    // A routed origin is answered by its stand-in; a stand-in's own address, by itself.
    const to = routes.find((x) => x.origin === url.origin)?.to ?? url.origin;
    if (to === url.origin && !(options.standins ?? []).includes(url.origin))
      return refuse('a request outside the world');
    const res = await fetch(`${to}${url.pathname}${url.search}`, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      let next: URL | null = null;
      try {
        next = new URL(location, url);
      } catch {
        // not a URL: refused below
      }
      if (!next || !insideWorld(next.href, options)) return refuse('a redirect out of the world');
      if (routes.some((x) => x.origin === next.origin) || (options.standins ?? []).includes(next.origin)) {
        if (req.isNavigationRequest())
          return route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html', 'content-security-policy': ROUTED_CSP },
            body: `<!doctype html><script>location.replace(${JSON.stringify(next.href).replace(/</g, '\\u003c')})</script>`,
          });
        if (hop >= ROUTED_HOPS) return refuse('a redirect loop');
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
    }
    const out = Object.fromEntries(
      [...res.headers].filter(
        // fetch has already decoded the body, and the stand-in's own CSP is replaced by ours.
        ([k]) => !/^(content-encoding|content-length|transfer-encoding|content-security-policy)$/i.test(k),
      ),
    );
    return route.fulfill({
      status: res.status,
      headers: { ...out, 'content-security-policy': ROUTED_CSP },
      body: Buffer.from(await res.arrayBuffer()),
    });
  }
}

/** Whether a URL is inside a world whose browsers play a provider's pages (see FleetOptions.allowOrigins). */
export function insideWorld(url: string, options: FleetOptions): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  const plain = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  const origin = `${plain}//${u.host}`;
  const world =
    plain === 'http:' &&
    Number(u.port || 80) === options.port &&
    (u.hostname === options.baseDomain || u.hostname.endsWith(`.${options.baseDomain}`));
  return (
    world ||
    (options.routes ?? []).some((r) => r.origin === origin) ||
    (options.standins ?? []).includes(origin) ||
    (options.allowOrigins ?? []).some((o) => {
      try {
        return new URL(o).origin === origin;
      } catch {
        return false;
      }
    })
  );
}

/**
 * The devices a screen can be. A sign-in's own viewport (a product's tablet app) is the default for that
 * app; a device named when the screen opens wins over it, so the same app can be tried on a phone or turned
 * to portrait. Sizes are CSS pixels of common devices: a 6.1" phone, an 11" tablet each way, a laptop.
 */
export const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  tablet: { viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 2 },
  'tablet-portrait': { viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 },
} as const;
export type Device = keyof typeof DEVICES;

/** How a screen looks: its device and the light or dark appearance its system asks for. */
export interface Appearance {
  device?: Device;
  colorScheme?: 'light' | 'dark';
}

/**
 * Who a screen is for: a signed-in person, or someone with only a link, a customer, whose browser has no
 * sign-in at all (signIn null).
 */
export interface Who {
  persona: Pick<Persona, 'tenant' | 'timeZone'>;
  signIn: SignIn | null;
}

export interface Screen {
  /** Null for a screen with no sign-in: a customer's, opened at their link. */
  signIn: SignIn | null;
  /** The client address the api sees for this screen (see open()). */
  address: string;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface Fleet {
  /** Open a screen as one person, already signed in, or as a customer with nothing but a link. */
  open(
    who: Who,
    path?: string,
    options?: Appearance & {
      address?: string;
      /** Called with the new context before it loads anything, so nothing it does is missed. */
      onContext?: (context: BrowserContext) => void | Promise<void>;
      /** The world's time, when its clock has moved: the page starts on it, not on this machine's. */
      clock?: { at: string; paused: boolean };
    },
  ): Promise<Screen>;
  originFor(tenant: string): string;
  readonly screens: readonly Screen[];
  close(): Promise<void>;
}

export async function launchFleet(options: FleetOptions): Promise<Fleet> {
  const browsers = new Map<string, Promise<Browser>>();
  const launch = (origin: string): Promise<Browser> =>
    chromium.launch({
      channel: 'chromium',
      headless: options.headless ?? false,
      args: [
        resolverRule(options.baseDomain),
        `--unsafely-treat-insecure-origin-as-secure=${origin}`,
        // Every screen is watched at once, so none may be treated as "in the background". Headed windows
        // overlap on a real desktop, and Chromium throttles painting in occluded windows; a page that does
        // not paint emits no screencast frames. Not reproducible headless (the tests run headless), so this
        // guards the headed case rather than fixing an observed failure.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
    });
  const browserFor = (origin: string): Promise<Browser> => {
    let b = browsers.get(origin);
    if (!b) {
      b = launch(origin);
      // A launch that failed is not kept: the next screen for that tenant tries again.
      b.catch(() => browsers.delete(origin));
      browsers.set(origin, b);
    }
    return b;
  };
  const screens: Screen[] = [];
  let nextAddress = 1;
  const originFor = (tenant: string): string => `http://${tenant}.${options.baseDomain}:${options.port}`;

  return {
    originFor,
    screens,

    /**
     * One BrowserContext per person, never one browser per person: contexts are isolated in cookies
     * and storage, which is what makes several people genuinely concurrent, and it is the pattern the
     * test suites already rely on.
     *
     * The sign-in's cookies are injected rather than typed: host-only (given by `url`, so no Domain
     * attribute; a `domain` here would make it a domain cookie that subdomains also receive), HttpOnly and
     * SameSite=Lax unless the product says otherwise, and never Secure, because a world is plain HTTP and a
     * Secure cookie over HTTP is dropped silently.
     *
     * Each screen gets its own client address unless one is given. Every browser here connects from
     * 127.0.0.1, and a product's per-address limits (sign-in attempts, lookups) would see the whole sandbox
     * as one huge office. A product behind a proxy trusts one hop, so the address goes in X-Forwarded-For,
     * the same path a real client's takes. Defaults come from 198.18.0.0/15, a range reserved for testing.
     * Giving several screens one address is how a crew behind one router is simulated.
     */
    async open(who, path = '/', { address, onContext, device, colorScheme, clock } = {}) {
      const signIn = who.signIn;
      const localStorage = signIn?.localStorage;
      const viewport = signIn?.viewport;
      const shape = device ? DEVICES[device] : viewport ? { viewport, hasTouch: true } : {};
      const origin = originFor(who.persona.tenant);
      const n = nextAddress++;
      const ip = address ?? `198.18.${Math.floor(n / 256) % 256}.${n % 256}`;
      const context = await (
        await browserFor(origin)
      ).newContext({
        baseURL: origin,
        // The server runs in UTC; a person's browser runs where they are. "Today", "Yesterday" and the
        // year on a byline are decided here, so this machine's zone must not leak in.
        timezoneId: who.persona.timeZone,
        // A contained world has no service workers: one on a routed origin would answer outside the routes.
        ...(options.routes?.length ? { serviceWorkers: 'block' as const } : {}),
        ...shape,
        ...(colorScheme ? { colorScheme } : {}),
      });
      // Before the app's scripts run, and only where absent: how a tablet that is already signed in is
      // opened (an app that keeps its tokens there), without putting back what the app later rewrites.
      if (localStorage)
        // Every frame runs it, sandboxed ones too, whose storage is refused: only the tenant's own page.
        await context.addInitScript(
          ({ items, at }: { items: Record<string, string>; at: string }) => {
            if (globalThis.location?.origin !== at) return;
            for (const [k, v] of Object.entries(items))
              if (globalThis.localStorage.getItem(k) === null) globalThis.localStorage.setItem(k, v);
          },
          { items: localStorage, at: origin },
        );
      // The address goes to the tenant's own server only. As a header on every request it also went to
      // other origins (an app's web fonts), where a non-simple header makes the browser ask first and the
      // answer is no: the fonts failed, which production never sees.
      //
      // The cost of routing: Playwright turns the HTTP cache off for a context with any route, so a screen
      // fetches every asset on every load. Behaviour is the same; first loads are slower than a real
      // device's repeat visits. Anything that depends on the HTTP cache is out of reach here.
      // allHeaders, not headers: the plain list leaves out the cookie, and the screen would be signed out.
      await context.route(`${origin}/**`, async (route) =>
        route.continue({ headers: { ...(await route.request().allHeaders()), 'x-forwarded-for': ip } }),
      );
      if (signIn?.cookies?.length) await setCookies(context, origin, signIn.cookies);
      if (options.routes?.length) {
        // Contained: nothing leaves the world but to its stand-ins and what the product loads from outside.
        await context.route(
          (url) => !insideWorld(url.href, options),
          (route) => route.abort('blockedbyclient'),
        );
        await context.routeWebSocket(
          (url) => !insideWorld(url.href, options),
          (ws) => ws.close({ code: 1008, reason: 'outside the world' }),
        );
      }
      // Matched by exact origin, never by a pattern a manifest could widen. A contained world's stand-ins are
      // reached through the same proxy, so every redirect any of them answers is checked.
      const proxied = [
        ...(options.routes ?? []).map((r) => r.origin),
        ...(options.routes?.length ? (options.standins ?? []) : []),
      ];
      for (const o of proxied)
        await context.route(
          (url) => url.origin === o,
          (route) =>
            answerRouted(route, options).catch(() => route.abort('connectionrefused').catch(() => undefined)),
        );
      let page: Page;
      try {
        // The screen's own set-up (its device): inside, so a failure there closes the half-made context too.
        await onContext?.(context);
        // Before the first page: an app that reads "today" as it starts would otherwise draw this machine's
        // date, or the epoch, until something made it look again.
        if (clock) {
          if (clock.paused) await context.clock.setFixedTime(new Date(clock.at));
          else await context.clock.setSystemTime(new Date(clock.at));
        }
        page = await context.newPage();
        // load, not domcontentloaded: an app drawn by its scripts is drawn after the HTML.
        await page.goto(path, { waitUntil: 'load' });
      } catch (e) {
        // A screen that can't be put on the world's time or opened is not left half-made, holding a context.
        await context.close().catch(() => undefined);
        throw e;
      }
      const screen: Screen = {
        signIn,
        address: ip,
        context,
        page,
        close: async () => {
          await context.close().catch(() => undefined);
          const i = screens.indexOf(screen);
          if (i >= 0) screens.splice(i, 1);
        },
      };
      screens.push(screen);
      return screen;
    },

    async close() {
      await Promise.all(screens.map((s) => s.context.close().catch(() => undefined)));
      screens.length = 0;
      const all = [...browsers.values()];
      browsers.clear();
      await Promise.all(all.map(async (b) => (await b.catch(() => null))?.close().catch(() => undefined)));
    },
  };
}
