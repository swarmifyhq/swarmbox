// The email stand-in (Resend) against a product that checks Svix signatures as Flowology's Resend code does: on its
// own copy of the algorithm, and the timestamp within five minutes of the world's (moved) clock.

import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinStandIn } from '../src/standins/builtin/index.ts';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';

const SANDBOX = process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required';
const WORLD_NOW = Date.parse('2030-03-02T16:00:00Z');

interface Event {
  type: string;
  data: { email_id: string; to: string[]; tags: { name: string; value: string }[] };
  valid: boolean;
}
const events: Event[] = [];
let secret = '';
let product: http.Server;
let port = 0;
beforeAll(async () => {
  product = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const id = String(req.headers['svix-id']);
      const ts = String(req.headers['svix-timestamp']);
      const want = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(`${id}.${ts}.${body}`)
        .digest('base64');
      const signed = String(req.headers['svix-signature'] ?? '')
        .split(' ')
        .some((s) => s === `v1,${want}`);
      const fresh = Math.abs(Number(ts) * 1000 - WORLD_NOW) < 5 * 60_000;
      events.push({ ...(JSON.parse(body) as Omit<Event, 'valid'>), valid: signed && fresh });
      res.writeHead(signed && fresh ? 200 : 400).end();
    });
  });
  await new Promise<void>((r) => product.listen(0, '127.0.0.1', r));
  port = (product.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => product.close(() => r())));

const waitFor = async <T>(f: () => T | undefined, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('the email stand-in', () => {
  let email: StandIn;
  let acct: Record<string, string>;
  const send = (to: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    fetch(`${email.baseUrls.api}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${acct.apiKey}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        from: 'Acme Air <office@acme.example>',
        to: [to],
        subject: 'Your sign-in code',
        text: 'Your code is 482913. It works for 10 minutes.',
        tags: [{ name: 'tenant_id', value: 't1' }],
        ...extra,
      }),
    });

  beforeAll(async () => {
    email = await startStandIn({
      ...builtinStandIn('email'),
      deliverTo: `http://127.0.0.1:${port}`,
      baseDomain: 'sample.test',
      // The product's own host, not a tenant's: one Resend account for the whole platform.
      clock: { at: new Date(WORLD_NOW).toISOString(), paused: true },
      sandbox: SANDBOX,
      onStderr: (t) => process.stderr.write(t),
    });
    acct = await email.account('platform', { webhookUrl: `http://sample.test:${port}/hooks/resend` });
    secret = acct.webhookSecret!;
  });
  afterAll(() => email.stop());

  it('has a key and a webhook secret in Resend’s shapes, both marked', () => {
    expect(acct.apiKey).toMatch(/^re_swarmbox_secret_/);
    expect(acct.webhookSecret).toMatch(/^whsec_swarmbox/);
  });

  it('sends, then posts sent and delivered, signed and timed on the world’s clock', async () => {
    const r = await send('jamie@customer.example');
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    await waitFor(() => (events.filter((e) => e.data.email_id === id).length === 2 ? true : undefined));
    const mine = events.filter((e) => e.data.email_id === id);
    expect(mine.map((e) => e.type)).toEqual(['email.sent', 'email.delivered']);
    expect(mine.every((e) => e.valid)).toBe(true);
    expect(mine[1]!.data.tags).toEqual([{ name: 'tenant_id', value: 't1' }]);
  });

  it('keeps an idempotency key as Resend does', async () => {
    const a = (await (await send('kim@customer.example', {}, { 'idempotency-key': 'k1' })).json()) as {
      id: string;
    };
    const b = (await (await send('kim@customer.example', {}, { 'idempotency-key': 'k1' })).json()) as {
      id: string;
    };
    expect(b.id).toBe(a.id);
    const clash = await send(
      'kim@customer.example',
      { subject: 'Something else' },
      { 'idempotency-key': 'k1' },
    );
    expect(clash.status).toBe(409);
    // Another account's same key is its own.
    const other = await email.account('other');
    const theirs = await fetch(`${email.baseUrls.api}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${other.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'k1',
      },
      body: JSON.stringify({
        from: 'o@other.example',
        to: ['kim@customer.example'],
        subject: 'Hi',
        text: 'Hi',
      }),
    });
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { id: string }).id).not.toBe(a.id);
  });

  it('refuses a bad address, bounces, or leaves the events to the agent', async () => {
    expect((await fetch(`${email.baseUrls.api}/emails`, { method: 'POST', body: '{}' })).status).toBe(401);
    const wrong = await fetch(`${email.baseUrls.api}/emails`, {
      method: 'POST',
      headers: { authorization: 'Bearer re_swarmbox_secret_nope' },
      body: '{}',
    });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { name: string }).name).toBe('invalid_api_key');
    await email.behave({ behaviour: 'reject', count: 1, match: { target: 'nobody@nowhere' } });
    const bad = await send('nobody@nowhere');
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { name: string }).name).toBe('validation_error');

    await email.behave({ behaviour: 'bounce', count: 1, match: { target: 'gone@customer.example' } });
    const { id } = (await (await send('gone@customer.example')).json()) as { id: string };
    expect(
      (await waitFor(() => events.find((e) => e.data.email_id === id && e.type !== 'email.sent'))).type,
    ).toBe('email.bounced');

    await email.behave({ behaviour: 'manual', count: 1 });
    const held = (await (await send('later@customer.example')).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.data.email_id === held.id)).toBe(false);
    await email.inbound('event', { email: held.id, type: 'complained' });
    expect(events.find((e) => e.data.email_id === held.id)!.type).toBe('email.complained');
  });

  it('shows what one address was sent, so a sign-in code can be read', async () => {
    const box = (await email.inbound('mailbox', { to: 'jamie@customer.example' })) as {
      subject: string;
      text: string;
    }[];
    expect(box[0]).toMatchObject({
      subject: 'Your sign-in code',
      text: 'Your code is 482913. It works for 10 minutes.',
    });
  });
});
