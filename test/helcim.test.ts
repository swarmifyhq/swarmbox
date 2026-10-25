// The Helcim stand-in as Flowology's Helcim code uses it: a checkout and its card page, the result's hash checked
// as Helcim documents it (written here, not shared with the stand-in), a card saved and charged by token once per
// idempotency key, a refund with what remains, a charge whose answer is lost, and a card that expires.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinStandIn } from '../src/standins/builtin/index.ts';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';

const SANDBOX = process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required';
/** PHP's json_encode with its default flags, as Helcim's documentation hashes with: "/" and non-ASCII escaped. */
const jsonEncode = (data: unknown) =>
  JSON.stringify(data)
    .replaceAll('/', '\\/')
    .replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const hash = (data: unknown, secret: string) =>
  createHash('sha256')
    .update(jsonEncode(data) + secret)
    .digest('hex');

const mountain = (iso: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};

describe('the Helcim stand-in', () => {
  let helcim: StandIn;
  let token = '';
  const api = (path: string, init: { method?: string; body?: unknown; key?: string } = {}) =>
    fetch(`${helcim.baseUrls.api}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'api-token': token,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.key ? { 'idempotency-key': init.key } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  const page = (path: string, body?: unknown) =>
    fetch(`${helcim.origin}${path}`, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    helcim = await startStandIn({
      ...builtinStandIn('helcim'),
      deliverTo: 'http://127.0.0.1:9',
      baseDomain: 'sample.test',
      clock: { at: '2030-03-02T16:00:00.000Z', paused: true },
      sandbox: SANDBOX,
      requestTimeoutMs: 400,
      onStderr: (t) => process.stderr.write(t),
    });
    token = (await helcim.account('acme')).apiToken!;
  });
  afterAll(() => helcim.stop());

  it('runs a checkout: the card page takes the card, and its result carries Helcim’s hash', async () => {
    expect((await api('/helcim-pay/initialize', { method: 'POST', body: {} })).status).toBe(400);
    const init = await api('/helcim-pay/initialize', {
      method: 'POST',
      body: { paymentType: 'purchase', amount: 135.45, currency: 'CAD' },
    });
    const { checkoutToken, secretToken } = (await init.json()) as {
      checkoutToken: string;
      secretToken: string;
    };
    expect(await (await page('/helcim-pay/services/start.js')).text()).toContain(
      'window.appendHelcimPayIframe',
    );
    expect(await (await page(`/helcim-pay/checkout/${checkoutToken}`)).text()).toContain('Pay $135.45');

    const declined = (await (
      await page(`/helcim-pay/checkout/${checkoutToken}/pay`, {
        number: '4000 0000 0000 0002',
        expiry: '12/31',
        cvv: '123',
        name: 'Jamie Chen',
      })
    ).json()) as { status: string };
    expect(declined.status).toBe('DECLINED');
    const paid = (await (
      await page(`/helcim-pay/checkout/${checkoutToken}/pay`, {
        number: '4111 1111 1111 1111',
        expiry: '12/31',
        cvv: '123',
        name: 'Jamie Chén / Acme',
      })
    ).json()) as {
      status: string;
      data: {
        transactionId: number;
        amount: number;
        status: string;
        dateCreated: string;
        cardNumber: string;
      };
      hash: string;
    };
    expect(paid.status).toBe('SUCCESS');
    // The name carries "/" and an é, which PHP's json_encode escapes: the hash covers them as Helcim's does.
    expect(paid.hash).toBe(hash(paid.data, secretToken));
    expect(jsonEncode(paid.data)).toContain('Jamie Ch\\u00e9n \\/ Acme');
    expect(paid.data).toMatchObject({ amount: 135.45, status: 'APPROVED', cardNumber: '4111********1111' });
    // Helcim's own dates: Mountain Time, on the world's clock. The offset comes from this machine's tzdata (2030's
    // rules differ between releases), so the expected time is worked out the same way, not written down.
    expect(paid.data.dateCreated).toBe(mountain('2030-03-02T16:00:00.000Z'));
    const back = (await (await api(`/card-transactions/${paid.data.transactionId}`)).json()) as {
      amount: number;
      status: string;
    };
    expect(back).toMatchObject({ amount: 135.45, status: 'APPROVED' });
    // A finished checkout can't be paid again.
    expect(
      (
        (await (
          await page(`/helcim-pay/checkout/${checkoutToken}/pay`, {
            number: '4111111111111111',
            expiry: '1231',
          })
        ).json()) as { status: string }
      ).status,
    ).toBe('FAILED');
  });

  it('saves a card for a customer, charges it by token once per key, and refunds what remains', async () => {
    const init = (await (
      await api('/helcim-pay/initialize', {
        method: 'POST',
        body: {
          paymentType: 'verify',
          amount: 0,
          currency: 'CAD',
          customerRequest: { customerCode: 'CST100', contactName: 'Lindqvist residence' },
        },
      })
    ).json()) as { checkoutToken: string };
    const saved = (await (
      await page(`/helcim-pay/checkout/${init.checkoutToken}/pay`, {
        number: '4111111111111111',
        expiry: '1231',
        cvv: '1',
        name: 'L',
      })
    ).json()) as {
      data: { cardToken: string; customerCode: string; type: string };
    };
    expect(saved.data).toMatchObject({ type: 'verify', customerCode: 'CST100' });
    const [customer] = (await (await api('/customers?customerCode=CST100')).json()) as { id: number }[];
    const [card] = (await (
      await api(`/customers/${customer!.id}/cards?cardToken=${saved.data.cardToken}`)
    ).json()) as { id: number; cardF6L4: string; cardExpiry: string }[];
    expect(card).toMatchObject({ cardF6L4: '4111111111', cardExpiry: '1231' });

    const buy = {
      ipAddress: '0.0.0.0',
      currency: 'CAD',
      amount: 200,
      cardData: { cardToken: saved.data.cardToken },
    };
    const first = (await (
      await api('/payment/purchase', { method: 'POST', body: buy, key: 'k-1' })
    ).json()) as { transactionId: number; status: string };
    const again = (await (
      await api('/payment/purchase', { method: 'POST', body: buy, key: 'k-1' })
    ).json()) as { transactionId: number };
    expect(first.status).toBe('APPROVED');
    expect(again.transactionId).toBe(first.transactionId);
    expect((await api('/payment/purchase', { method: 'POST', body: buy })).status).toBe(400);

    await helcim.behave({ behaviour: 'decline', count: 1 });
    expect(
      (
        (await (await api('/payment/purchase', { method: 'POST', body: buy, key: 'k-2' })).json()) as {
          status: string;
        }
      ).status,
    ).toBe('DECLINED');

    const refund = (body: unknown, key: string) => api('/payment/refund', { method: 'POST', body, key });
    expect(
      (await refund({ originalTransactionId: first.transactionId, amount: 150, ipAddress: '0.0.0.0' }, 'r-1'))
        .status,
    ).toBe(200);
    // A key belongs to its operation: a refund under the purchase's key is its own refund, not the purchase back.
    const sameKey = (await (
      await refund({ originalTransactionId: first.transactionId, amount: 10, ipAddress: '0.0.0.0' }, 'k-1')
    ).json()) as { type: string; amount: number };
    expect(sameKey).toMatchObject({ type: 'refund', amount: 10 });
    // The same key with another body is refused; five minutes on, the key is free again.
    const changed = await api('/payment/purchase', {
      method: 'POST',
      body: { ...buy, amount: 201 },
      key: 'k-1',
    });
    expect(changed.status).toBe(409);
    helcim.setClock({ at: '2030-03-02T16:06:00.000Z', paused: true });
    expect(
      (await api('/payment/purchase', { method: 'POST', body: { ...buy, amount: 1 }, key: 'k-1' })).status,
    ).toBe(200);
    helcim.setClock({ at: '2030-03-02T16:00:00.000Z', paused: true });
    const over = await refund(
      { originalTransactionId: first.transactionId, amount: 50, ipAddress: '0.0.0.0' },
      'r-2',
    );
    expect(over.status).toBe(400);
    expect(((await over.json()) as { errors: string[] }).errors[0]).toMatch(/more than what remains/);

    // A charge whose answer is lost is still on the day's list, as Flowology looks for it.
    await helcim.behave({ behaviour: 'timeout', count: 1 });
    expect(
      (await api('/payment/purchase', { method: 'POST', body: { ...buy, amount: 42 }, key: 'k-3' })).status,
    ).toBe(504);
    const day = (await (
      await api(`/card-transactions?dateFrom=2030-03-02&cardToken=${saved.data.cardToken}`)
    ).json()) as { amount: number; type: string }[];
    expect(day.some((t) => t.amount === 42 && t.type === 'purchase')).toBe(true);

    // An expired card is refused; a deleted one is gone.
    await helcim.inbound('expire', { cardToken: saved.data.cardToken });
    expect((await api('/payment/purchase', { method: 'POST', body: buy, key: 'k-4' })).status).toBe(400);
    expect((await api(`/customers/${customer!.id}/cards/${card!.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(await (await api(`/customers/${customer!.id}/cards`)).json()).toEqual([]);
  });

  it('answers only an account’s own token', async () => {
    const r = await fetch(`${helcim.baseUrls.api}/card-transactions/1`, { headers: { 'api-token': 'nope' } });
    expect(r.status).toBe(401);
  });
});
