// A product small enough to read in one sitting, for Swarmbox's own tests: proof that nothing in the core
// is shaped for one product. Two tenants on their own hosts, two people each, a sign-in cookie, a page
// with a dialog that sends a text, and the hooks: a feed that records each send (and the text failing a
// moment later), a clock, and an inbox.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { hooksFor, type Hooks } from '../../src/hooks.ts';
import type { CheckResult, Settled } from '../../src/checks.ts';
import type { Persona, Product, ProductWorld, SignIn, StandInEndpoint } from '../../src/product.ts';
import { builtinStandIn } from '../../src/standins/builtin/index.ts';

export const BASE_DOMAIN = 'sample.test';
const TOKEN = 't'.repeat(43);

const PEOPLE = (tenant: string): Persona[] => [
  {
    id: `${tenant}-ana`,
    tenant,
    label: 'Ana (owner)',
    name: 'Ana',
    email: `ana@${tenant}.example`,
    roles: ['owner'],
    timeZone: 'America/Edmonton',
  },
  {
    id: `${tenant}-ben`,
    tenant,
    label: 'Ben (technician)',
    name: 'Ben',
    email: `ben@${tenant}.example`,
    roles: ['technician'],
    timeZone: 'America/Edmonton',
  },
];

const page = (
  who: string,
  tenant: string,
) => `<!doctype html><html><head><title>${tenant}</title></head><body>
<main><h1>Jobs at ${tenant}</h1><p>Signed in as ${who}</p>
<button type="button" id="open">Send estimate</button>
<p role="status" id="status"></p>
<button type="button" id="photo-btn">Add a photo</button>
<input type="file" id="photo" accept="image/*" capture="environment" hidden>
<button type="button" id="cam">Use the camera</button>
<button type="button" id="where">Where am I</button>
<p id="device" aria-label="Device"></p></main>
<dialog id="d" aria-labelledby="t"><h2 id="t">Send estimate E-1</h2>
  <label>To <input name="to" value="+15550100"></label>
  <button type="button" id="cancel">Cancel</button><button type="button" id="send">Send</button></dialog>
<script>
  // What "now" was as the page started, as an app that reads today once would see it.
  window.startedAt = Date.now();
  const d = document.getElementById('d');
  document.getElementById('open').onclick = () => d.showModal();
  document.getElementById('cancel').onclick = () => d.close();
  // As a tablet app's camera button does: a file input with capture, clicked for the person.
  const photo = document.getElementById('photo');
  const device = document.getElementById('device');
  document.getElementById('photo-btn').onclick = () => photo.click();
  photo.onchange = async () => {
    const f = photo.files[0];
    await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    device.textContent = 'Uploaded ' + f.name;
  };
  document.getElementById('cam').onclick = async () => {
    const v = document.createElement('video');
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video: true });
    v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, 400));
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const x = c.getContext('2d');
    x.drawImage(v, 0, 0, 64, 48);
    const d = x.getImageData(5, 5, 1, 1).data;
    device.textContent = 'Camera sees rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
  };
  document.getElementById('where').onclick = () =>
    navigator.geolocation.getCurrentPosition(
      (p) => (device.textContent = 'At ' + p.coords.latitude.toFixed(3) + ',' + p.coords.longitude.toFixed(3)),
      (e) => (device.textContent = 'No location: ' + e.message),
    );
  document.getElementById('send').onclick = async () => {
    const r = await fetch('/api/send', { method: 'POST', body: d.querySelector('input').value });
    d.close();
    document.getElementById('status').textContent = r.ok ? 'Estimate E-1 sent.' : 'Could not send.';
  };
</script></body></html>`;

const TECH_PAGE = `<!doctype html><html><head><title>Tech</title></head><body>
<h1>Choose a PIN</h1><input aria-label="PIN" autofocus>
<script>document.querySelector('input').onkeydown = (e) => { if (e.key === 'Enter') document.body.innerHTML = '<h1>Today</h1>'; };</script>
</body></html>`;

interface Row {
  cursor: string;
  kind: string;
  at: string;
  [k: string]: unknown;
}

export interface SampleWorld extends ProductWorld {
  /** Every request a tenant's host got, for assertions. */
  requests: string[];
  /** The postbox stand-in's receipts this world's shops got, as "<shop> <body>". */
  receipts: string[];
  /** Files people uploaded, as received. */
  uploads: { tenant: string; name: string; body: Buffer }[];
  /** Each shop's Helcim account and its API's address, when the world has the Helcim stand-in. */
  cards: { api: string; accounts: Map<string, Record<string, string>> } | null;
}

async function startSample(
  tenants: string[],
  port: number,
  closed: string[] = [],
  texts?: StandInEndpoint,
  failStop = false,
  cards?: StandInEndpoint,
): Promise<SampleWorld> {
  // With the Helcim stand-in, each shop has a payments account, for its own pay page.
  const cardAccounts = new Map<string, Record<string, string>>();
  if (cards) for (const t of tenants) cardAccounts.set(t, await cards.account(t));
  // With the postbox stand-in, each shop has its own account there, and texts really go through it.
  const textAccounts = new Map<string, Record<string, string>>();
  if (texts) for (const t of tenants) textAccounts.set(t, await texts.account(t));
  const receipts: string[] = [];
  const uploads: { tenant: string; name: string; body: Buffer }[] = [];
  const feeds = new Map<string, Row[]>(tenants.map((t) => [t, []]));
  const inbox: Row[] = [];
  let seq = 0;
  let offsetMs = 0;
  /** A twelve-hour session, minted on the world's time. */
  const session = (id: string) => [{ name: 'sid', value: `${id}.${Date.now() + offsetMs + 12 * 3_600_000}` }];
  const requests: string[] = [];
  const push = (tenant: string, row: { kind: string; [k: string]: unknown }) =>
    feeds.get(tenant)!.push({ ...row, cursor: String(++seq), at: new Date().toISOString() });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString();
      const host = (req.headers.host ?? '').split(':')[0]!;
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, v: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      // The hooks, on the bare host only, behind the world's token.
      if (host === '127.0.0.1' && url.pathname.startsWith('/_sandbox/')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`)
          return json(401, { ok: false, error: { code: 'unauthorized' } });
        const path = url.pathname.slice('/_sandbox'.length);
        if (path === '/health') return json(200, { ok: true, result: {} });
        if (path === '/clock') {
          if (req.method === 'POST') {
            const move = JSON.parse(body) as { jumpMs?: number; to?: string };
            offsetMs = move.to ? Date.parse(move.to) - Date.now() : offsetMs + Number(move.jumpMs ?? 0);
          }
          return json(200, {
            ok: true,
            result: {
              clock: { offsetMs, frozenAt: null },
              process: { at: new Date(Date.now() + offsetMs).toISOString(), following: true },
            },
          });
        }
        if (path === '/feed') {
          const rows = feeds.get(url.searchParams.get('company') ?? '') ?? [];
          const after = Number(url.searchParams.get('after') ?? 0);
          const items = rows.filter((r) => Number(r.cursor) > after);
          return json(200, {
            ok: true,
            result: { items, next: items.at(-1)?.cursor ?? String(after), lagMs: 0 },
          });
        }
        if (path === '/messages') {
          const items = inbox.filter((m) => m.to === url.searchParams.get('to'));
          return json(200, { ok: true, result: { items, next: items.at(-1)?.cursor ?? '0', lagMs: 0 } });
        }
        return json(404, { ok: false, error: { code: 'not_found', message: path } });
      }
      const tenant = host.endsWith(`.${BASE_DOMAIN}`) ? host.slice(0, -(BASE_DOMAIN.length + 1)) : '';
      if (!feeds.has(tenant)) return json(404, { error: 'no such tenant' });
      requests.push(`${tenant} ${req.method} ${url.pathname}`);
      // A session is <person>.<expiry>, and expires on the world's time, as a real product's would.
      const [sid, until] = (/(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '').split('.');
      const who =
        Number(until) > Date.now() + offsetMs ? PEOPLE(tenant).find((p) => p.id === sid) : undefined;
      if (url.pathname === '/tech/')
        return res.writeHead(200, { 'content-type': 'text/html' }).end(TECH_PAGE);
      if (url.pathname.startsWith('/p/'))
        return res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<title>Estimate</title><h1>Your estimate</h1>');
      if (url.pathname === '/pay') {
        // A pay page as a product makes one: HelcimPay.js from Helcim's own address, its iframe, and its message.
        const token = JSON.stringify(url.searchParams.get('token') ?? '');
        return res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `<!doctype html><title>Pay</title><h1>Pay your invoice</h1><p id="payment" aria-label="Payment"></p>` +
              `<script src="https://secure.helcim.app/helcim-pay/services/start.js"></script><script>` +
              `addEventListener('message', (e) => { if (e.data && e.data.eventName === 'helcim-pay-js-' + ${token}) ` +
              `document.getElementById('payment').textContent = e.origin + ' ' + e.data.eventStatus + ' ' + ` +
              `(e.data.eventStatus === 'SUCCESS' ? JSON.parse(e.data.eventMessage).data.amount : ''); });` +
              `appendHelcimPayIframe(${token});</script>`,
          );
      }
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        uploads.push({ tenant, name: url.searchParams.get('name') ?? '', body: raw });
        return json(200, { ok: true });
      }
      if (url.pathname === '/hooks/postbox' && req.method === 'POST') {
        receipts.push(`${tenant} ${body}`);
        return res.writeHead(204).end();
      }
      if (url.pathname === '/api/send' && req.method === 'POST') {
        if (!who) return json(401, { error: { code: 'signed_out', message: 'Sign in first.' } });
        push(tenant, {
          kind: 'action',
          name: 'estimates.send',
          actionKind: 'command',
          outcome: 'ok',
          principal: { kind: 'user', membershipId: who.id },
          nested: ['messages.send'],
        });
        // The text fails a moment later, in the background, as a real provider's refusal would.
        setTimeout(
          () =>
            push(tenant, {
              kind: 'delivery',
              type: 'estimate.sent',
              handler: 'messaging.send',
              status: 'failed',
              error: `no provider for ${body}`,
            }),
          200,
        );
        inbox.push({
          cursor: String(++seq),
          at: new Date().toISOString(),
          kind: 'sms',
          to: body,
          body: 'Your estimate',
        });
        const acct = textAccounts.get(tenant);
        if (texts && acct) {
          // The product's own client, pointed at the stand-in: the real provider's API, with its receipts to come
          // to this shop's own host.
          void fetch(`${texts.baseUrls.api}/v1/accounts/${acct.account}/messages`, {
            method: 'POST',
            headers: {
              authorization: `Basic ${Buffer.from(`${acct.account}:${acct.secret}`).toString('base64')}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              To: body,
              Body: 'Your estimate',
              StatusCallback: `http://${tenant}.${BASE_DOMAIN}:${actual}/hooks/postbox`,
            }),
          });
        }
        return json(200, { ok: true });
      }
      if (!who)
        return res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<title>Sign in</title><h1>Sign in</h1>');
      return res.writeHead(200, { 'content-type': 'text/html' }).end(page(who.name, tenant));
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const actual = (server.address() as AddressInfo).port;
  const hooks: Hooks = hooksFor(`http://127.0.0.1:${actual}/_sandbox`, TOKEN);
  return {
    baseDomain: BASE_DOMAIN,
    port: actual,
    tenants,
    origin: (t) => `http://${t}.${BASE_DOMAIN}:${actual}`,
    provenance: { commit: 'a'.repeat(40), dirty: false, base: 'origin/main', behind: 0, fetchedAt: null },
    hooks,
    requests,
    receipts,
    uploads,
    cards: cards ? { api: cards.baseUrls.api!, accounts: cardAccounts } : null,
    people: async () => tenants.flatMap(PEOPLE),
    signIn: async (p, app): Promise<SignIn> =>
      app === 'tech'
        ? {
            cookies: session(p.id),
            path: '/tech/',
            viewport: { width: 1180, height: 820 },
            ready: async (pg) => {
              await pg.getByLabel('PIN').fill('1234');
              await pg.keyboard.press('Enter');
              await pg.getByRole('heading', { name: 'Today' }).waitFor();
            },
          }
        : { cookies: session(p.id) },
    renewSignIn: async (p) => session(p.id),
    tenantOfPath: (path) => /^\/p\/([a-z0-9-]+)\//.exec(path)?.[1],
    settle: async (): Promise<Record<string, Settled>> =>
      Object.fromEntries(tenants.map((t) => [t, { settled: true, ms: 0, pending: [], known: [] }])),
    check: async (): Promise<CheckResult[]> =>
      tenants.map((t) => {
        const sends = feeds.get(t)!.filter((r) => r.name === 'estimates.send').length;
        const failed = feeds.get(t)!.filter((r) => r.kind === 'delivery' && r.status === 'failed').length;
        return {
          id: 'texts-arrive',
          title: 'Every text sent is delivered',
          where: t,
          outcome: sends === 0 ? 'nothing-to-check' : failed ? 'fail' : 'pass',
          examined: sends,
          unit: 'texts',
          violations: failed ? [{ summary: `${failed} texts failed` }] : [],
        };
      }),
    notes: () => ['a sample world', ...closed.map((t) => `${t} is closed for the season`)],
    // Its server's log is the requests it served, with a line for each refusal.
    log: ({ lines, match }) =>
      requests.filter((l) => !match || l.toLowerCase().includes(match.toLowerCase())).slice(-lines),
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (failStop) throw new Error('the sample shop would not stop cleanly');
    },
  };
}

export function sampleProduct(dirs: { scenarioDir: string; home: string }): Product<SampleWorld> {
  return {
    name: 'sample',
    title: 'Sample',
    tenantNoun: 'shop',
    portBase: 0,
    scenarioDir: dirs.scenarioDir,
    home: dirs.home,
    apps: ['tech'],
    startWorld: (spec, port) =>
      startSample(
        spec.tenants.length ? spec.tenants : ['demo-shop'],
        port,
        (spec.options?.closed as string[] | undefined) ?? [],
        spec.endpoints?.postbox,
        spec.options?.failStop === true,
        spec.endpoints?.helcim,
      ),
    baseDomain: BASE_DOMAIN,
    // Only in a world that asks for it, so the other tests start no stand-in.
    standins: [
      { name: 'postbox', dir: join(import.meta.dirname, 'standins/postbox'), always: false },
      builtinStandIn('helcim', { always: false }),
    ],
    worldOptions: {
      closed: z.array(z.string()).optional().describe('Shops closed for the season'),
      failStop: z.boolean().optional().describe('Its stop fails, as a product that won’t shut down cleanly'),
    },
    appFor: async (p) => (p.roles.includes('technician') ? 'tech' : undefined),
  };
}
