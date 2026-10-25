// Stand-ins end to end: a stand-in process in the operating-system sandbox (where there is one), a product that
// calls it and takes its webhooks on a tenant's host, the general behaviours Swarmbox applies, the stand-in's own,
// the log, inbound, the clock, and what a hostile stand-in can't do.

import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';

const SANDBOX = process.platform === 'darwin' ? 'required' : 'off';
const fixture = (name: string) => join(import.meta.dirname, 'fixtures/standins', name);

/** A product that takes webhooks, as a real one behind one port serves every tenant's host. */
interface Hook {
  host: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}
let product: http.Server;
let productUrl = '';
const hooks: Hook[] = [];
beforeAll(async () => {
  product = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      hooks.push({ host: req.headers.host ?? '', path: req.url ?? '', body, headers: req.headers });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => product.listen(0, '127.0.0.1', r));
  productUrl = `http://127.0.0.1:${(product.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => product.close(() => r())));

const waitFor = async <T>(f: () => T | undefined, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('a stand-in a product talks to as its provider', () => {
  let s: StandIn;
  let acct: Record<string, string>;
  const auth = () => `Basic ${Buffer.from(`${acct.account}:${acct.secret}`).toString('base64')}`;
  const sendText = (to: string, callback?: string) =>
    fetch(`${s.baseUrls.api}/v1/accounts/${acct.account}/messages`, {
      method: 'POST',
      headers: { authorization: auth(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: to,
        Body: 'Your estimate',
        ...(callback ? { StatusCallback: callback } : {}),
      }),
    });

  beforeAll(async () => {
    s = await startStandIn({
      dir: fixture('postbox'),
      deliverTo: productUrl,
      baseDomain: 'sample.test',
      clock: { at: '2030-03-02T16:00:00.000Z', paused: true },
      sandbox: SANDBOX,
    });
    acct = await s.account('north');
  });
  afterAll(() => s.stop());

  it('makes accounts with credentials marked as a stand-in’s', () => {
    expect(acct.account).toMatch(/^swarmbox_north_/);
    expect(acct.secret).toMatch(/^swarmbox_secret_/);
    expect(acct.from).toMatch(/^\+1250555\d{4}$/);
  });

  it('answers as the provider, and posts its signed webhook to the tenant’s host at the world’s time', async () => {
    const r = await sendText('+12505550123', 'http://north.sample.test:3094/hooks/postbox/status');
    expect(r.status).toBe(201);
    const { sid } = (await r.json()) as { sid: string };
    const hook = await waitFor(() => hooks.find((h) => h.body.includes(sid)));
    expect(hook.host).toBe('north.sample.test:3094');
    expect(hook.path).toBe('/hooks/postbox/status');
    expect(hook.body).toContain('MessageStatus=delivered');
    // Signed with the world's (paused) time, over the URL as written.
    expect(hook.headers['x-postbox-time']).toBe(String(Date.parse('2030-03-02T16:00:00Z') / 1000));
    const want = createHmac('sha256', acct.secret!)
      .update(
        `http://north.sample.test:3094/hooks/postbox/status.${hook.headers['x-postbox-time']}.${hook.body}`,
      )
      .digest('hex');
    expect(hook.headers['x-postbox-signature']).toBe(want);

    const log = s.log();
    expect(log.find((e) => e.kind === 'request' && e.operation === 'messages.create')).toMatchObject({
      tenant: 'north',
      status: 201,
    });
    expect(log.find((e) => e.kind === 'deliver')).toMatchObject({ status: 204 });
  });

  it('applies the general behaviours itself, in the provider’s own words', async () => {
    await s.behave({ behaviour: 'fail', count: 1 });
    const down = await sendText('+12505550123');
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ code: 20500, message: 'Postbox is down' });
    expect((await sendText('+12505550123')).status).toBe(201); // used up

    await s.behave({ behaviour: 'limit', count: 1, param: { retryAfterSec: 7 } });
    const limited = await sendText('+12505550123');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');

    await s.behave({ behaviour: 'slow', count: 1, param: { delayMs: 300 } });
    const t0 = Date.now();
    expect((await sendText('+12505550123')).status).toBe(201);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);

    await s.behave({ behaviour: 'hang', count: 1, match: { operation: 'messages.create' } });
    const hung = await Promise.race([
      sendText('+12505550123').then(() => 'answered'),
      new Promise((r) => setTimeout(() => r('no answer'), 500)),
    ]);
    expect(hung).toBe('no answer');
    expect(s.log().some((e) => e.behaviour === 'hang')).toBe(true);
  });

  it('applies its own behaviours, and refuses ones it doesn’t support', async () => {
    await s.behave({ behaviour: 'reject', count: 1, match: { target: '+12505550199' } });
    const refused = await sendText('+12505550199');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: number }).code).toBe(21610);

    await s.behave({ behaviour: 'undeliver', count: 1, match: { target: '+12505550142' } });
    const r = await sendText('+12505550142', 'http://north.sample.test/hooks/postbox/status');
    const { sid } = (await r.json()) as { sid: string };
    expect((await waitFor(() => hooks.find((h) => h.body.includes(sid)))).body).toContain(
      'MessageStatus=undelivered',
    );

    await expect(s.behave({ behaviour: 'decline' })).rejects.toThrow(/doesn't support "decline"/);
  });

  it('delivers a webhook twice, or out of order, when asked', async () => {
    await s.behave({ behaviour: 'duplicate', count: 1 });
    const r = await sendText('+12505550111', 'http://north.sample.test/hooks/postbox/status');
    const { sid } = (await r.json()) as { sid: string };
    await waitFor(() => (hooks.filter((h) => h.body.includes(sid)).length === 2 ? true : undefined));

    await s.behave({ behaviour: 'reorder', count: 1, param: { windowMs: 300 } });
    const a = (await (await sendText('+12505550112', 'http://north.sample.test/a')).json()) as {
      sid: string;
    };
    const b = (await (await sendText('+12505550113', 'http://north.sample.test/b')).json()) as {
      sid: string;
    };
    await waitFor(() => (hooks.some((h) => h.body.includes(a.sid)) ? true : undefined), 3000);
    const order = hooks.filter((h) => h.body.includes(a.sid) || h.body.includes(b.sid)).map((h) => h.path);
    expect(order).toEqual(['/b', '/a']);
  });

  it('makes something arrive from outside, and won’t deliver anywhere but the world', async () => {
    const got = await s.inbound('reply', {
      tenant: 'north',
      from: '+12505550123',
      body: 'Tuesday works',
      url: 'http://north.sample.test/hooks/postbox/inbound',
    });
    expect(got).toEqual({ delivered: 204 });
    expect(hooks.some((h) => h.path === '/hooks/postbox/inbound' && h.body.includes('Tuesday+works'))).toBe(
      true,
    );

    await expect(
      s.inbound('reply', { tenant: 'north', from: '+1', body: 'x', url: 'https://example.com/steal' }),
    ).resolves.toEqual({ delivered: 0 });
    expect(s.log().some((e) => e.kind === 'deliver' && e.sent === 'refused: not the world')).toBe(true);
    await expect(s.inbound('dispute', {})).rejects.toThrow(/has no inbound "dispute"/);
  });
});

describe.skipIf(SANDBOX === 'off')('a hostile stand-in, in the sandbox', () => {
  it('can write its own folder and nothing else, and reach no network at all', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'swarmbox-secret-'));
    const secret = join(secretDir, 'key');
    writeFileSync(secret, 'not for stand-ins');
    process.env.SWARMBOX_CANARY = 'leaked';
    const s = await startStandIn({
      dir: fixture('hostile'),
      deliverTo: productUrl,
      baseDomain: 'sample.test',
      sandbox: 'required',
    });
    try {
      const outside = join(secretDir, 'written');
      const q = new URLSearchParams({ port: new URL(productUrl).port, secret, outside });
      const r = (await (await fetch(`${s.baseUrls.api}/probe?${q}`)).json()) as Record<string, unknown>;
      expect(r).toMatchObject({
        internet: 'blocked',
        loopback: 'blocked',
        listen: 'blocked',
        readSecret: 'blocked',
        writeOutside: 'blocked',
        writeOwn: 'allowed',
        canary: null,
      });
      expect(existsSync(outside)).toBe(false);
      expect(r.home).not.toBe(process.env.HOME);
    } finally {
      delete process.env.SWARMBOX_CANARY;
      await s.stop();
      rmSync(secretDir, { recursive: true, force: true });
    }
  });
});
