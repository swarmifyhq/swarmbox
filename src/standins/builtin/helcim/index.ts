// Helcim, as a product's own Helcim code uses it (API v2, header api-token) and as its customers meet it in the
// browser: HelcimPay.js from https://secure.helcim.app, whose iframe takes the card and posts the result to the
// page as Helcim's does ({eventName: "helcim-pay-js-<checkoutToken>", eventStatus, eventMessage: JSON of {data,
// hash}}), the hash being SHA-256 of the data's JSON (non-ASCII escaped as \uXXXX) and the session's secretToken.
// The world's browsers get those pages from this stand-in at Helcim's own address (manifest connect.browser).
//
// Test cards: 4111 1111 1111 1111 is approved, 4000 0000 0000 0002 declined; any expiry ahead and any CVV.

import { createHash, randomBytes } from 'node:crypto';
import { defineStandIn, json, type Reply, type StandInContext, type StandInRequest } from '../../sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

/**
 * Helcim's hash over a result, as its documentation computes it: sha256(json_encode($data) . $secretToken). PHP's
 * json_encode with its default flags escapes "/" as "\/" and everything past ASCII as \uXXXX (each UTF-16 unit,
 * lowercase hex), and leaves DEL (\u007f) as it is.
 */
export function helcimHash(data: unknown, secretToken: string): string {
  const text = JSON.stringify(data).replace(/[/\u0080-\uffff]/g, (c) =>
    c === '/' ? '\\/' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return createHash('sha256')
    .update(text + secretToken)
    .digest('hex');
}

interface Txn {
  transactionId: number;
  tenant: string;
  dateCreated: string;
  at: number;
  cardBatchId: number;
  status: 'APPROVED' | 'DECLINED';
  user: string;
  type: 'purchase' | 'verify' | 'refund';
  amount: number;
  currency: string;
  avsResponse: string;
  cvvResponse: string;
  approvalCode: string;
  cardToken: string;
  cardNumber: string;
  cardHolderName: string;
  customerCode: string;
  invoiceNumber: string;
  warning: string;
  original?: number;
}
interface Session {
  token: string;
  secret: string;
  tenant: string;
  paymentType: 'purchase' | 'verify';
  amount: number;
  currency: string;
  customerCode: string | null;
  contactName: string | null;
  done: boolean;
  created: number;
}
interface Card {
  id: number;
  cardToken: string;
  cardF6L4: string;
  cardExpiry: string;
  customerId: number;
  expired: boolean;
}
interface Customer {
  id: number;
  tenant: string;
  customerCode: string;
  contactName: string;
}

const txns = new Map<number, Txn>();
const sessions = new Map<string, Session>();
const customers = new Map<number, Customer>();
const cards = new Map<number, Card>();
/**
 * Idempotency keys, as Helcim keeps them: per account and operation, five minutes on the world's clock. The same key
 * and body answer the first result; another body under the same key is refused.
 */
const idempotent = new Map<string, { txn: Txn; body: string; at: number }>();
const KEY_KEPT_MS = 5 * 60_000;
/** A checkout lasts 60 minutes (Helcim's documentation). */
const CHECKOUT_MS = 60 * 60_000;
/** Forget what Helcim would have: checkouts past their hour, idempotency keys past five minutes. */
function sweep(now: number) {
  for (const [token, s] of sessions) if (now - s.created > CHECKOUT_MS) sessions.delete(token);
  for (const [key, k] of idempotent) if (now - k.at > KEY_KEPT_MS) idempotent.delete(key);
}
let nextTxn = 30_000_000;
let nextCustomer = 9000;
let nextCard = 70_000;

const errors = (status: number, ...messages: string[]): Reply => json(status, { errors: messages });
const money = (n: number) => Math.round(n * 100) / 100;

/** Helcim's own dates: Mountain Time, "YYYY-MM-DD HH:MM:SS". */
function mountain(at: Date): string {
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
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function caller(ctx: StandInContext, req: StandInRequest): string | null {
  const token = req.headers['api-token'];
  if (!token) return null;
  for (const [tenant, a] of ctx.accounts) if (a.apiToken === token) return tenant;
  return null;
}

function record(
  ctx: StandInContext,
  t: Omit<
    Txn,
    | 'transactionId'
    | 'dateCreated'
    | 'at'
    | 'cardBatchId'
    | 'user'
    | 'avsResponse'
    | 'cvvResponse'
    | 'approvalCode'
    | 'warning'
  >,
): Txn {
  const now = ctx.now();
  const txn: Txn = {
    ...t,
    transactionId: nextTxn++,
    dateCreated: mountain(now),
    at: now.getTime(),
    cardBatchId: 1,
    user: 'Helcim Pay',
    avsResponse: t.status === 'APPROVED' ? 'X' : '',
    cvvResponse: t.status === 'APPROVED' ? 'M' : '',
    approvalCode: t.status === 'APPROVED' ? String(100000 + Math.floor(Math.random() * 899999)) : '',
    warning: '',
  };
  txns.set(txn.transactionId, txn);
  return txn;
}

const view = (t: Txn) => {
  const { tenant: _t, at: _a, original: _o, ...shown } = t;
  return shown;
};

/** The customer for a code, made when a card is first saved for one. */
function customerFor(tenant: string, code: string, name: string): Customer {
  for (const c of customers.values()) if (c.tenant === tenant && c.customerCode === code) return c;
  const c: Customer = { id: nextCustomer++, tenant, customerCode: code, contactName: name };
  customers.set(c.id, c);
  return c;
}

const START_JS = `
// HelcimPay.js, as a Swarmbox stand-in serves it: the same globals, the same iframe and messages.
(function () {
  window.appendHelcimPayIframe = function (checkoutToken) {
    var old = document.getElementById('helcimPayIframe');
    if (old) old.remove();
    var f = document.createElement('iframe');
    f.id = 'helcimPayIframe';
    f.title = 'Helcim payment';
    f.src = 'https://secure.helcim.app/helcim-pay/checkout/' + encodeURIComponent(checkoutToken);
    f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:rgba(0,0,0,.4)';
    document.body.appendChild(f);
  };
  window.removeHelcimPayIframe = function () {
    var f = document.getElementById('helcimPayIframe');
    if (f) f.remove();
  };
})();
`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function checkoutPage(s: Session): string {
  const what = s.paymentType === 'verify' ? 'Save card' : `Pay $${s.amount.toFixed(2)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Helcim</title>
<style>body{font:15px system-ui;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
form{background:#fff;padding:24px;border-radius:12px;width:320px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
label{display:block;margin:10px 0 4px}input{width:100%;padding:8px;font:inherit;box-sizing:border-box}
.row{display:flex;gap:8px}.row label{flex:1}button{margin-top:16px;width:100%;padding:10px;font:inherit}
#status{margin-top:10px}</style></head><body>
<form id="card" aria-label="Card details">
<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(what)}</h1>
<label>Card number<input name="number" autocomplete="cc-number" inputmode="numeric"></label>
<div class="row"><label>Expiry (MM/YY)<input name="expiry" autocomplete="cc-exp"></label><label>CVV<input name="cvv" autocomplete="cc-csc"></label></div>
<label>Name on card<input name="name" autocomplete="cc-name"></label>
<button type="submit">${escapeHtml(what)}</button>
<button type="button" id="cancel">Cancel</button>
<p id="status" role="status"></p>
</form>
<script>
var token = ${JSON.stringify(s.token)};
var send = function (eventStatus, eventMessage) {
  window.parent.postMessage({ eventName: 'helcim-pay-js-' + token, eventStatus: eventStatus, eventMessage: eventMessage }, '*');
};
document.getElementById('cancel').onclick = function () { send('ABORTED', 'Cancelled by the customer'); };
document.getElementById('card').onsubmit = async function (e) {
  e.preventDefault();
  var f = e.target;
  var r = await fetch('/helcim-pay/checkout/' + encodeURIComponent(token) + '/pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ number: f.number.value, expiry: f.expiry.value, cvv: f.cvv.value, name: f.name.value })
  });
  var b = await r.json();
  document.getElementById('status').textContent = b.message || '';
  if (b.status === 'SUCCESS') send('SUCCESS', JSON.stringify({ data: b.data, hash: b.hash }));
  else if (b.status === 'FAILED') send('ABORTED', b.message);
};
</script></body></html>`;
}

defineStandIn({
  manifest,
  account(_tenant, made) {
    return { ...made, apiToken: `${made.apiToken}` };
  },
  routes: {
    'checkout.initialize': (req, ctx) => {
      const tenant = caller(ctx, req);
      if (!tenant) return errors(401, 'Unauthorized');
      let b: Record<string, unknown>;
      try {
        b = req.json();
      } catch {
        return errors(400, 'Invalid JSON');
      }
      const paymentType =
        b.paymentType === 'verify' ? 'verify' : b.paymentType === 'purchase' ? 'purchase' : null;
      if (!paymentType) return errors(400, 'paymentType must be purchase or verify');
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount < 0 || (paymentType === 'purchase' && amount <= 0))
        return errors(400, 'amount is invalid');
      if (ctx.take('reject', { operation: 'checkout.initialize', tenant }))
        return errors(400, 'The checkout could not be started');
      const request = (b.customerRequest ?? null) as { customerCode?: unknown; contactName?: unknown } | null;
      const customerCode =
        typeof b.customerCode === 'string'
          ? b.customerCode
          : typeof request?.customerCode === 'string'
            ? request.customerCode
            : null;
      if (
        typeof b.customerCode === 'string' &&
        ![...customers.values()].some((c) => c.tenant === tenant && c.customerCode === b.customerCode)
      )
        return errors(400, 'Customer not found');
      const s: Session = {
        token: randomBytes(12).toString('hex'),
        secret: randomBytes(16).toString('hex'),
        tenant,
        paymentType,
        amount: money(amount),
        currency: typeof b.currency === 'string' ? b.currency : 'CAD',
        customerCode,
        contactName: typeof request?.contactName === 'string' ? request.contactName : null,
        done: false,
        created: ctx.now().getTime(),
      };
      sweep(s.created);
      sessions.set(s.token, s);
      return json(200, { checkoutToken: s.token, secretToken: s.secret });
    },
    'browser.script': () => ({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: START_JS,
    }),
    'browser.checkout': (req, ctx) => {
      const s = sessions.get(req.params.token!);
      if (!s || s.done || ctx.now().getTime() - s.created > CHECKOUT_MS)
        return {
          status: 404,
          headers: { 'content-type': 'text/html' },
          body: '<p>This checkout has expired.</p>',
        };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: checkoutPage(s) };
    },
    'browser.pay': (req, ctx) => {
      const s = sessions.get(req.params.token!);
      if (!s || s.done || ctx.now().getTime() - s.created > CHECKOUT_MS)
        return json(200, { status: 'FAILED', message: 'This checkout has expired.' });
      let b: { number?: string; expiry?: string; cvv?: string; name?: string };
      try {
        b = req.json();
      } catch {
        return json(200, { status: 'FAILED', message: 'Enter the card details.' });
      }
      const number = String(b.number ?? '').replace(/\D/g, '');
      const expiry = String(b.expiry ?? '').replace(/\D/g, '');
      if (number.length < 13 || expiry.length !== 4)
        return json(200, { status: 'INVALID', message: 'Check the card number and expiry.' });
      const declined =
        number === '4000000000000002' || ctx.take('decline', { tenant: s.tenant, target: number });
      const status = declined ? 'DECLINED' : 'APPROVED';
      let cardToken = '';
      if (status === 'APPROVED' && (s.paymentType === 'verify' || s.customerCode)) {
        const customer = customerFor(
          s.tenant,
          s.customerCode ?? `CST${nextCustomer}`,
          s.contactName ?? String(b.name ?? ''),
        );
        s.customerCode = customer.customerCode;
        cardToken = randomBytes(12).toString('hex');
        const card: Card = {
          id: nextCard++,
          cardToken,
          cardF6L4: `${number.slice(0, 6)}${number.slice(-4)}`,
          cardExpiry: expiry,
          customerId: customer.id,
          expired: false,
        };
        cards.set(card.id, card);
      }
      const t = record(ctx, {
        tenant: s.tenant,
        status,
        type: s.paymentType,
        amount: s.paymentType === 'verify' ? 0 : s.amount,
        currency: s.currency,
        cardToken,
        cardNumber: `${number.slice(0, 4)}********${number.slice(-4)}`,
        cardHolderName: String(b.name ?? ''),
        customerCode: s.customerCode ?? '',
        invoiceNumber: '',
      });
      if (status === 'DECLINED')
        return json(200, { status: 'DECLINED', message: 'The card was declined. Try another card.' });
      s.done = true;
      const data = { ...view(t), cardType: number.startsWith('4') ? 'VI' : 'MC' };
      return json(200, { status: 'SUCCESS', message: 'Approved', data, hash: helcimHash(data, s.secret) });
    },
    'transactions.get': (req, ctx) => {
      const tenant = caller(ctx, req);
      if (!tenant) return errors(401, 'Unauthorized');
      const t = txns.get(Number(req.params.id));
      if (!t || t.tenant !== tenant) return errors(404, 'Transaction not found');
      return json(200, view(t));
    },
    'transactions.list': (req, ctx) => {
      const tenant = caller(ctx, req);
      if (!tenant) return errors(401, 'Unauthorized');
      const from = req.query.get('dateFrom');
      const token = req.query.get('cardToken');
      const limit = Math.min(Number(req.query.get('limit') ?? 100), 1000);
      const list = [...txns.values()]
        .filter(
          (t) =>
            t.tenant === tenant &&
            (!from || t.dateCreated.slice(0, 10) >= from) &&
            (!token || t.cardToken === token),
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map(view);
      return json(200, list);
    },
    'customers.list': (req, ctx) => {
      const tenant = caller(ctx, req);
      if (!tenant) return errors(401, 'Unauthorized');
      const code = req.query.get('customerCode');
      return json(
        200,
        [...customers.values()]
          .filter((c) => c.tenant === tenant && (!code || c.customerCode === code))
          .map(({ tenant: _t, ...c }) => c),
      );
    },
    'cards.list': (req, ctx) => {
      const tenant = caller(ctx, req);
      if (!tenant) return errors(401, 'Unauthorized');
      const customer = customers.get(Number(req.params.customer));
      if (!customer || customer.tenant !== tenant) return errors(404, 'Customer not found');
      const token = req.query.get('cardToken');
      return json(
        200,
        [...cards.values()]
          .filter((c) => c.customerId === customer.id && (!token || c.cardToken === token))
          .map((c) => ({
            id: c.id,
            cardToken: c.cardToken,
            cardF6L4: c.cardF6L4,
            cardExpiry: c.cardExpiry,
            default: false,
          })),
      );
    },
    'cards.delete': (req, ctx) => {
      const tenant = caller(ctx, req);
      if (!tenant) return errors(401, 'Unauthorized');
      const card = cards.get(Number(req.params.card));
      const customer = card && customers.get(card.customerId);
      if (!card || !customer || customer.tenant !== tenant) return errors(404, 'Card not found');
      cards.delete(card.id);
      return { status: 204 };
    },
    'payment.purchase': (req, ctx) => charge(req, ctx, 'purchase'),
    'payment.refund': (req, ctx) => charge(req, ctx, 'refund'),
  },
  inbound: {
    expire(body) {
      const card = [...cards.values()].find((c) => c.cardToken === String(body.cardToken));
      if (!card) throw new Error(`no card ${String(body.cardToken)}`);
      card.expired = true;
      card.cardExpiry = '0120';
      return { cardToken: card.cardToken, expired: true };
    },
  },
  reset() {
    txns.clear();
    sessions.clear();
    customers.clear();
    cards.clear();
    idempotent.clear();
  },
});

/** A purchase on a saved card, or a refund: idempotent by key, and declined, refused or lost as asked. */
async function charge(req: StandInRequest, ctx: StandInContext, kind: 'purchase' | 'refund'): Promise<Reply> {
  const tenant = caller(ctx, req);
  if (!tenant) return errors(401, 'Unauthorized');
  const key = req.headers['idempotency-key'];
  if (!key) return errors(400, 'An idempotency-key header is required');
  const now = ctx.now().getTime();
  sweep(now);
  const slot = `${kind} ${tenant} ${key}`;
  const body = createHash('sha256').update(req.body).digest('hex');
  const seen = idempotent.get(slot);
  if (seen && seen.body === body) return json(200, view(seen.txn));
  // Helcim documents no answer for this; the stand-in refuses it, as a key's meaning is its first request.
  if (seen) return errors(409, 'The idempotency-key was already used with a different request');
  let b: Record<string, unknown>;
  try {
    b = req.json();
  } catch {
    return errors(400, 'Invalid JSON');
  }
  const amount = money(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0) return errors(400, 'amount is invalid');
  let t: Txn;
  if (kind === 'purchase') {
    const token = String((b.cardData as { cardToken?: unknown } | undefined)?.cardToken ?? '');
    const card = [...cards.values()].find(
      (c) => c.cardToken === token && customers.get(c.customerId)?.tenant === tenant,
    );
    if (!card) return errors(400, 'Card token not found');
    if (card.expired) return errors(400, 'The card has expired');
    const declined = ctx.take('decline', { operation: 'payment.purchase', tenant, target: token });
    const customer = customers.get(card.customerId)!;
    t = record(ctx, {
      tenant,
      status: declined ? 'DECLINED' : 'APPROVED',
      type: 'purchase',
      amount,
      currency: String(b.currency ?? 'CAD'),
      cardToken: token,
      cardNumber: `${card.cardF6L4.slice(0, 4)}********${card.cardF6L4.slice(-4)}`,
      cardHolderName: customer.contactName,
      customerCode: customer.customerCode,
      invoiceNumber: '',
    });
  } else {
    const original = txns.get(Number(b.originalTransactionId));
    if (
      !original ||
      original.tenant !== tenant ||
      original.type !== 'purchase' ||
      original.status !== 'APPROVED'
    )
      return errors(400, 'The original transaction was not found');
    const refunded = [...txns.values()]
      .filter((x) => x.type === 'refund' && x.original === original.transactionId && x.status === 'APPROVED')
      .reduce((n, x) => n + x.amount, 0);
    if (amount > money(original.amount - refunded) + 1e-9)
      return errors(400, 'The refund is more than what remains of the transaction');
    t = record(ctx, {
      ...view(original),
      tenant,
      status: 'APPROVED',
      type: 'refund',
      amount,
      original: original.transactionId,
    });
  }
  idempotent.set(slot, { txn: t, body, at: now });
  // Charged, but the answer lost: the client times out, and must find it by listing the day's transactions.
  if (ctx.take('timeout', { operation: kind === 'purchase' ? 'payment.purchase' : 'payment.refund', tenant }))
    return new Promise<Reply>(() => undefined);
  return json(200, view(t));
}
