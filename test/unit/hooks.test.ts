// The client for a product's Swarmbox hooks, against a stand-in server: what it sends, and what it says
// when a build has no hooks or refuses.

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hooksFor } from '../../src/hooks.ts';

const TOKEN = 'a'.repeat(43);
const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
let hooksPresent = true;
let server: http.Server;
let port = 0;
const base = () => `http://127.0.0.1:${port}/_sandbox`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const send = (status: number, v: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (!hooksPresent) return send(404, { message: 'Route not found' });
      if (req.headers.authorization !== `Bearer ${TOKEN}`)
        return send(401, { ok: false, error: { code: 'unauthorized', message: 'no' } });
      if (req.url === '/_sandbox/health') return send(200, { ok: true, result: { env: 'sandbox' } });
      if (req.url === '/_sandbox/clock' && req.method === 'POST') {
        if (JSON.parse(body).to === '2000-01-01T00:00:00Z')
          return send(409, {
            ok: false,
            error: { code: 'clock_backwards', message: 'The sandbox clock only moves forward.' },
          });
        return send(200, {
          ok: true,
          result: {
            clock: { offsetMs: 3_600_000, frozenAt: null },
            process: { at: '2026-10-17T09:00:00.000Z', following: true },
          },
        });
      }
      if (req.url!.startsWith('/_sandbox/feed'))
        return send(200, {
          ok: true,
          result: { items: [{ cursor: '7:1', kind: 'action', at: 'x' }], next: '7:1', lagMs: 3 },
        });
      if (req.url === '/_sandbox/fakes') return send(200, { ok: true, result: { rules: [] } });
      send(404, { ok: false, error: { code: 'not_found', message: 'nope' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the hooks client', () => {
  it('sends the world’s token as its bearer, and reads results', async () => {
    const h = hooksFor(base(), TOKEN);
    expect(await h.available()).toBeNull();
    const st = await h.moveClock({ jumpMs: 3_600_000 });
    expect(st.process.at).toBe('2026-10-17T09:00:00.000Z');
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/_sandbox/clock',
      auth: `Bearer ${TOKEN}`,
      body: '{"jumpMs":3600000}',
    });
  });

  it('builds the feed query as the product reads it', async () => {
    const page = await hooksFor(base(), TOKEN).feed('demo-co', { after: '5:2', queries: true, limit: 50 });
    expect(page).toEqual({ items: [{ cursor: '7:1', kind: 'action', at: 'x' }], next: '7:1', lagMs: 3 });
    expect(seen.at(-1)!.url).toBe('/_sandbox/feed?company=demo-co&after=5%3A2&include=queries&limit=50');
  });

  it('takes the base with a trailing slash too, and calls a product’s own hook', async () => {
    const h = hooksFor(`${base()}/`, TOKEN);
    expect(await h.call('GET', '/fakes')).toEqual({ rules: [] });
    expect(seen.at(-1)!.url).toBe('/_sandbox/fakes');
  });

  it('says what the product refused, with its code', async () => {
    await expect(hooksFor(base(), TOKEN).moveClock({ to: '2000-01-01T00:00:00Z' })).rejects.toThrow(
      /409 clock_backwards: The sandbox clock only moves forward/,
    );
    await expect(hooksFor(base(), 'b'.repeat(43)).fakeRules()).rejects.toThrow(/401 unauthorized/);
  });

  it('says plainly when a build has no hooks at all', async () => {
    hooksPresent = false;
    try {
      expect(await hooksFor(base(), TOKEN).available()).toMatch(/no Swarmbox hooks/);
    } finally {
      hooksPresent = true;
    }
  });
});
