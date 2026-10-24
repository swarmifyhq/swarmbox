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

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Persona, SignIn } from '../product.ts';

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
    options?: {
      address?: string;
      /** Called with the new context before it loads anything, so nothing it does is missed. */
      onContext?: (context: BrowserContext) => void;
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
    async open(who, path = '/', { address, onContext } = {}) {
      const signIn = who.signIn;
      const localStorage = signIn?.localStorage;
      const viewport = signIn?.viewport;
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
        ...(viewport ? { viewport, hasTouch: true } : {}),
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
      if (signIn?.cookies?.length)
        await context.addCookies(
          signIn.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            url: origin,
            httpOnly: c.httpOnly ?? true,
            secure: false,
            sameSite: c.sameSite ?? 'Lax',
          })),
        );
      onContext?.(context);
      const page = await context.newPage();
      // load, not domcontentloaded: an app drawn by its scripts is drawn after the HTML.
      await page.goto(path, { waitUntil: 'load' });
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
