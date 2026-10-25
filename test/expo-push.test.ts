// The Expo push stand-in as Flowology's Expo code uses it: a ticket per recipient, then the receipt, and
// DeviceNotRegistered when a token no longer reaches its iPad, at the ticket or the receipt; Expo's request limits;
// enhanced push security; receipts that come late, on the world's clock.

import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinStandIn } from '../src/standins/builtin/index.ts';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';

const SANDBOX = process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required';
const AT = '2030-03-02T16:00:00.000Z';

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; details: { error: string } };
type Receipt = { status: 'ok' } | { status: 'error'; details: { error: string } };

describe('the Expo push stand-in', () => {
  let expo: StandIn;
  let secure: Record<string, string>;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${expo.baseUrls.api}/--/api/v2/push/${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const send = async (messages: unknown, token?: string) => {
    const r = await post('send', messages, token);
    return { status: r.status, body: (await r.json()) as { data?: Ticket[]; errors?: { code: string }[] } };
  };
  const receipts = async (ids: string[], token?: string) =>
    ((await (await post('getReceipts', { ids }, token)).json()) as { data: Record<string, Receipt> }).data;
  const register = async (tenant: string, device: string) =>
    ((await expo.inbound('register', { tenant, device })) as { token: string }).token;
  const ticketId = (t: Ticket | undefined) => (t?.status === 'ok' ? t.id : '');

  beforeAll(async () => {
    expo = await startStandIn({
      ...builtinStandIn('expo-push'),
      deliverTo: 'http://127.0.0.1:9',
      baseDomain: 'sample.test',
      clock: { at: AT, paused: true },
      sandbox: SANDBOX,
      onStderr: (t) => process.stderr.write(t),
    });
    await expo.account('acme');
    await expo.account('other');
    secure = await expo.account('secure', { enhancedSecurity: 'on' });
  });
  afterAll(() => expo.stop());

  it('gives a ticket, then an ok receipt, and the device has it', async () => {
    const ipad = await register('acme', 'Ana’s iPad');
    expect(ipad).toMatch(/^ExponentPushToken\[swarmbox[0-9a-f]{14}\]$/);
    const { status, body } = await send([
      { to: ipad, title: 'New job', body: '14:00 Lindqvist', data: { job: 'J-1' }, sound: 'default' },
      { to: ipad, data: { sync: true }, _contentAvailable: true },
    ]);
    expect(status).toBe(200);
    expect(body.data!.map((t) => t.status)).toEqual(['ok', 'ok']);
    const ids = body.data!.map(ticketId);
    expect(await receipts(ids)).toEqual({ [ids[0]!]: { status: 'ok' }, [ids[1]!]: { status: 'ok' } });
    const got = (await expo.inbound('received', { token: 'Ana’s iPad' })) as {
      received: { title: string | null; data: unknown; silent: boolean }[];
    };
    expect(got.received).toMatchObject([
      { title: 'New job', data: { job: 'J-1' }, silent: false },
      { title: null, data: { sync: true }, silent: true },
    ]);
  });

  it('answers a token it doesn’t know, and Expo’s limits, as Expo does', async () => {
    const { body } = await send({ to: 'ExponentPushToken[nobody]', title: 'x' });
    expect(body.data![0]).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered' } });

    const ipad = await register('acme', 'big');
    expect((await send({ to: ipad, body: 'x'.repeat(5000) })).body.data![0]).toMatchObject({
      details: { error: 'MessageTooBig' },
    });
    const many = await send({ to: Array.from({ length: 101 }, () => ipad), title: 'x' });
    expect(many.status).toBe(400);
    expect(many.body.errors![0]!.code).toBe('PUSH_TOO_MANY_NOTIFICATIONS');
    const mixed = await send([
      { to: ipad, title: 'x' },
      { to: await register('other', 'theirs'), title: 'x' },
    ]);
    expect(mixed.status).toBe(400);
    expect(mixed.body.errors![0]!.code).toBe('PUSH_TOO_MANY_EXPERIENCE_IDS');
    expect((await post('getReceipts', { ids: Array.from({ length: 1001 }, () => 'a') })).status).toBe(400);
  });

  it('turns away a project’s tokens without its access token, once enhanced security is on', async () => {
    const ipad = await register('secure', 'locked');
    const without = await send({ to: ipad, title: 'x' });
    expect(without.status).toBe(401);
    expect(without.body.errors![0]!.code).toBe('UNAUTHORIZED');
    expect((await send({ to: ipad, title: 'x' }, 'swarmbox_secret_wrong')).status).toBe(401);
    const ok = await send({ to: ipad, title: 'x' }, secure.accessToken);
    expect(ok.status).toBe(200);
    const id = ticketId(ok.body.data![0]);
    const unsigned = await post('getReceipts', { ids: [id] });
    expect(unsigned.status).toBe(401);
    expect(await receipts([id], secure.accessToken)).toEqual({ [id]: { status: 'ok' } });

    // One project's token never sends to another's devices, or reads its receipts, locked or not.
    const other = await expo.account('neighbour');
    const theirs = await register('acme', 'not yours');
    const crossed = await send({ to: theirs, title: 'x' }, other.accessToken);
    expect(crossed.status).toBe(401);
    expect(crossed.body.errors![0]!.code).toBe('UNAUTHORIZED');
    const own = ticketId((await send({ to: theirs, title: 'x' })).body.data![0]);
    expect((await post('getReceipts', { ids: [own] }, other.accessToken)).status).toBe(401);
  });

  it('takes a gzipped body, as expo-server-sdk sends one over 1 KB', async () => {
    const ipad = await register('acme', 'zipped');
    const batch = Array.from({ length: 20 }, (_, i) => ({
      to: ipad,
      title: `Job ${i}`,
      body: 'x'.repeat(100),
    }));
    const r = await fetch(`${expo.baseUrls.api}/--/api/v2/push/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', accept: 'application/json' },
      body: new Uint8Array(gzipSync(JSON.stringify(batch))),
    });
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as { data: Ticket[] };
    expect(data.filter((t) => t.status === 'ok')).toHaveLength(20);
    // A body that unpacks past its limit is refused, not unpacked.
    const bomb = await fetch(`${expo.baseUrls.api}/--/api/v2/push/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: new Uint8Array(gzipSync(Buffer.alloc(8 * 1024 * 1024, ' '))),
    });
    expect(bomb.status).toBe(400);
  });

  it('a wiped iPad: DeviceNotRegistered at the receipt (or the ticket), and on every send after', async () => {
    const ipad = await register('acme', 'wiped');
    await expo.behave({ behaviour: 'gone', count: 1, match: { target: ipad } });
    const first = ticketId((await send({ to: ipad, title: 'x' })).body.data![0]);
    expect((await receipts([first]))[first]).toMatchObject({ details: { error: 'DeviceNotRegistered' } });
    const next = ticketId((await send({ to: ipad, title: 'y' })).body.data![0]);
    expect((await receipts([next]))[next]).toMatchObject({ details: { error: 'DeviceNotRegistered' } });
    expect(((await expo.inbound('received', { token: ipad })) as { received: unknown[] }).received).toEqual(
      [],
    );

    const other = await register('acme', 'gone at once');
    await expo.behave({ behaviour: 'gone', count: 1, match: { target: other }, param: { at: 'ticket' } });
    expect((await send({ to: other, title: 'x' })).body.data![0]).toMatchObject({
      details: { error: 'DeviceNotRegistered' },
    });

    const removed = await register('acme', 'removed');
    await expo.inbound('unregister', { token: 'removed' });
    const r = ticketId((await send({ to: removed, title: 'x' })).body.data![0]);
    expect((await receipts([r]))[r]).toMatchObject({ details: { error: 'DeviceNotRegistered' } });
  });

  it('refuses as Apple would, and leaves a late receipt out until the world gets there', async () => {
    const ipad = await register('acme', 'slow');
    await expo.behave({ behaviour: 'reject', count: 1, param: { as: 'MessageRateExceeded' } });
    expect((await send({ to: ipad, title: 'x' })).body.data![0]).toMatchObject({
      details: { error: 'MessageRateExceeded' },
    });

    await expo.behave({ behaviour: 'late', count: 1, param: { delayMs: 15 * 60_000 } });
    const id = ticketId((await send({ to: ipad, title: 'x' })).body.data![0]);
    expect(await receipts([id])).toEqual({});
    expo.setClock({ at: '2030-03-02T16:16:00.000Z', paused: true });
    expect(await receipts([id])).toEqual({ [id]: { status: 'ok' } });
    // Kept a day, then gone.
    expo.setClock({ at: '2030-03-03T16:17:00.000Z', paused: true });
    expect(await receipts([id])).toEqual({});
    expo.setClock({ at: AT, paused: true });
  });

  it('is down or rate-limited as Expo is', async () => {
    await expo.behave({ behaviour: 'limit', count: 1 });
    const r = await post('send', { to: 'ExponentPushToken[x]', title: 'x' });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe('TOO_MANY_REQUESTS');
  });
});
