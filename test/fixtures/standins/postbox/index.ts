// A small texting provider, the way a real stand-in is written: handlers for its operations and inbound kinds,
// signed webhooks, and its own behaviours (reject, undeliver). For Swarmbox's tests.

import { createHmac } from 'node:crypto';
import { defineStandIn, json, type StandInContext } from '../../../../src/standins/sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

interface Message {
  sid: string;
  account: string;
  to: string;
  body: string;
  status: string;
}
const messages = new Map<string, Message>();
let n = 0;

/** Postbox signs a webhook as HMAC-SHA256 of the URL, a dot, the time and a dot, then the body. */
const sign = (secret: string, url: string, at: string, body: string) =>
  createHmac('sha256', secret).update(`${url}.${at}.${body}`).digest('hex');

async function post(ctx: StandInContext, secret: string, url: string, fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  const at = String(Math.floor(ctx.now().getTime() / 1000));
  return ctx.deliver(url, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-postbox-time': at,
      'x-postbox-signature': sign(secret, url, at, body),
    },
    body,
  });
}

const accountOf = (ctx: StandInContext, account: string, auth: string | undefined) => {
  const want = [...ctx.accounts.values()].find((a) => a.account === account);
  const given = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
  return want && given === `${want.account}:${want.secret}` ? want : null;
};

defineStandIn({
  manifest,
  routes: {
    'messages.create': async (req, ctx) => {
      const acct = accountOf(ctx, req.params.account!, req.headers.authorization);
      if (!acct) return json(401, { code: 20003, message: 'Authenticate' });
      const form = req.form();
      const to = form.get('To') ?? '';
      if (ctx.take('reject', { operation: 'messages.create', target: to }))
        return json(400, { code: 21610, message: 'The recipient has opted out' });
      const sid = `SM${String(++n).padStart(4, '0')}`;
      const msg: Message = {
        sid,
        account: acct.account!,
        to,
        body: form.get('Body') ?? '',
        status: 'queued',
      };
      messages.set(sid, msg);
      const callback = form.get('StatusCallback');
      if (callback) {
        const undelivered = ctx.take('undeliver', { target: to });
        msg.status = undelivered ? 'undelivered' : 'delivered';
        void post(ctx, acct.secret!, callback, { MessageSid: sid, MessageStatus: msg.status });
      }
      return json(201, { sid, status: 'queued', to });
    },
    'messages.get': (req, ctx) => {
      if (!accountOf(ctx, req.params.account!, req.headers.authorization)) return json(401, { code: 20003 });
      const msg = messages.get(req.params.sid!);
      return msg ? json(200, msg) : json(404, { code: 20404, message: 'Not found' });
    },
  },
  inbound: {
    reply: async (body, ctx) => {
      const acct = ctx.accounts.get(String(body.tenant));
      if (!acct) throw new Error(`no account for ${String(body.tenant)}`);
      const status = await post(ctx, acct.secret!, String(body.url), {
        From: String(body.from),
        To: acct.from!,
        Body: String(body.body),
      });
      return { delivered: status };
    },
  },
  reset: () => messages.clear(),
});
