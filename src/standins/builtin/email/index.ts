// Email, as Resend: POST /emails as a product's own Resend code sends it, and the delivery events back to the
// account's webhook, signed as Resend's webhooks are (Svix: base64 HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>"
// keyed with the secret after "whsec_", timestamped with the world's time, which the product checks against its own).
//
// An account's console settings, as the product gives them (account(tenant, settings)): webhookUrl, the endpoint a
// person would add in Resend's dashboard. A product with one account for everyone uses one tenant for it.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { defineStandIn, json, type Reply, type StandInContext, type StandInRequest } from '../../sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

interface Email {
  id: string;
  tenant: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  replyTo: string | null;
  tags: { name: string; value: string }[];
  attachments: { filename: string; bytes: number }[];
  created: Date;
  last: string;
  /** Its Idempotency-Key in `keys`, so the key goes when the email does. */
  key: string | null;
}

/** Emails kept, oldest dropped first, and the most of a text or HTML body kept (a run sends sign-in codes, not books). */
const EMAILS_KEPT = 2000;
const BODY_KEPT = 256 * 1024;
const emails = new Map<string, Email>();
/**
 * Idempotency-Key, as Resend keeps it, per account: the same key and body give the same email, a different body is
 * refused. Keyed "<tenant> <key>", so two accounts' keys never meet.
 */
const keys = new Map<string, { id: string; body: string }>(); // body: the request body's sha-256
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const keep = (text: string) => (text.length > BODY_KEPT ? text.slice(0, BODY_KEPT) : text);

const err = (status: number, name: string, message: string): Reply =>
  json(status, { statusCode: status, name, message });

/** The account a request's key belongs to, or Resend's answer: 401 with no key, 403 with one it doesn't know. */
function caller(ctx: StandInContext, req: StandInRequest): { tenant: string } | { refused: Reply } {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.length === 7)
    return { refused: err(401, 'missing_api_key', 'Missing API key in the authorization header.') };
  for (const [tenant, a] of ctx.accounts) if (a.apiKey === auth.slice(7)) return { tenant };
  return { refused: err(403, 'invalid_api_key', 'API key is invalid.') };
}

async function event(
  ctx: StandInContext,
  e: Email,
  type: 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.complained',
) {
  e.last = type;
  const account = ctx.accounts.get(e.tenant);
  const url = ctx.settings.get(e.tenant)?.webhookUrl;
  if (!account || !url) return 0;
  const body = JSON.stringify({
    type,
    created_at: ctx.now().toISOString(),
    data: {
      email_id: e.id,
      created_at: e.created.toISOString(),
      from: e.from,
      to: e.to,
      subject: e.subject,
      tags: e.tags,
      ...(type === 'email.bounced'
        ? { bounce: { message: 'The recipient’s mailbox does not exist.', type: 'Permanent' } }
        : {}),
    },
  });
  const id = `msg_${randomBytes(12).toString('hex')}`;
  const timestamp = String(Math.floor(ctx.now().getTime() / 1000));
  const sent = await ctx.deliver(url, {
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Svix-Webhooks/1.0',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': svixSignature(account.webhookSecret!, id, timestamp, body),
    },
    body,
  });
  return sent.status;
}

defineStandIn({
  manifest,
  account(_tenant, made) {
    // Resend's own shapes: an "re_" key, and a "whsec_" secret whose base64 still carries the mark.
    return {
      ...made,
      apiKey: `re_${made.apiKey}`,
      webhookSecret: `whsec_swarmbox${randomBytes(24).toString('base64')}`,
    };
  },
  routes: {
    'emails.send': (req, ctx) => {
      const who = caller(ctx, req);
      if ('refused' in who) return who.refused;
      const { tenant } = who;
      let b: Record<string, unknown>;
      try {
        b = req.json<Record<string, unknown>>();
      } catch {
        return err(422, 'validation_error', 'The request body must be JSON.');
      }
      const to = (Array.isArray(b.to) ? b.to : [b.to]).filter((x): x is string => typeof x === 'string');
      if (!to.length) return err(422, 'validation_error', 'The `to` field is missing.');
      if (typeof b.from !== 'string') return err(422, 'validation_error', 'The `from` field is missing.');
      if (typeof b.subject !== 'string')
        return err(422, 'validation_error', 'The `subject` field is missing.');
      if (typeof b.text !== 'string' && typeof b.html !== 'string')
        return err(422, 'validation_error', 'Either `text` or `html` is required.');
      if (ctx.take('reject', { operation: 'emails.send', tenant, target: to[0] }))
        return err(422, 'validation_error', `Invalid \`to\` field. ${to[0]} is not a valid address.`);

      const key = req.headers['idempotency-key'] ? `${tenant} ${req.headers['idempotency-key']}` : null;
      const raw = req.text();
      if (key) {
        const seen = keys.get(key);
        if (seen && seen.body === hash(raw)) return json(200, { id: seen.id });
        if (seen)
          return err(
            409,
            'invalid_idempotent_request',
            'Same idempotency key used with a different request body.',
          );
      }
      const tags = Array.isArray(b.tags)
        ? (b.tags as { name?: unknown; value?: unknown }[])
            .filter((t) => typeof t?.name === 'string')
            .map((t) => ({ name: String(t.name), value: String(t.value ?? '') }))
        : [];
      const e: Email = {
        id: randomUUID(),
        tenant,
        from: b.from,
        to,
        subject: b.subject,
        text: typeof b.text === 'string' ? keep(b.text) : '',
        html: typeof b.html === 'string' ? keep(b.html) : null,
        replyTo: typeof b.reply_to === 'string' ? b.reply_to : null,
        tags,
        attachments: Array.isArray(b.attachments)
          ? (b.attachments as { filename?: unknown; content?: unknown }[]).map((a) => ({
              filename: String(a.filename ?? 'attachment'),
              bytes: typeof a.content === 'string' ? Buffer.from(a.content, 'base64').length : 0,
            }))
          : [],
        created: ctx.now(),
        last: 'email.sent',
        key,
      };
      emails.set(e.id, e);
      if (key) keys.set(key, { id: e.id, body: hash(raw) });
      for (const old of emails.values()) {
        if (emails.size <= EMAILS_KEPT) break;
        emails.delete(old.id);
        if (old.key) keys.delete(old.key);
      }
      if (!ctx.take('manual', { tenant, target: to[0] })) {
        const bounce = ctx.take('bounce', { tenant, target: to[0] });
        void (async () => {
          await event(ctx, e, 'email.sent');
          await event(
            ctx,
            e,
            bounce
              ? bounce.param?.as === 'complaint'
                ? 'email.complained'
                : 'email.bounced'
              : 'email.delivered',
          );
        })();
      }
      return json(200, { id: e.id });
    },
    'emails.get': (req, ctx) => {
      const who = caller(ctx, req);
      if ('refused' in who) return who.refused;
      const { tenant } = who;
      const e = emails.get(req.params.id!);
      if (!e || e.tenant !== tenant) return err(404, 'not_found', 'Email not found.');
      return json(200, {
        object: 'email',
        id: e.id,
        to: e.to,
        from: e.from,
        subject: e.subject,
        text: e.text,
        html: e.html,
        created_at: e.created.toISOString(),
        last_event: e.last.replace(/^email\./, ''),
      });
    },
  },
  inbound: {
    async event(body, ctx) {
      const e = emails.get(String(body.email));
      if (!e) throw new Error(`no email ${String(body.email)}`);
      const type = { delivered: 'email.delivered', bounced: 'email.bounced', complained: 'email.complained' }[
        String(body.type)
      ];
      if (!type) throw new Error('type is delivered, bounced or complained');
      return { email: e.id, type, delivered: await event(ctx, e, type as 'email.delivered') };
    },
    mailbox(body) {
      const to = String(body.to).toLowerCase();
      return [...emails.values()]
        .filter((e) => e.to.some((t) => t.toLowerCase().includes(to)))
        .slice(-20)
        .map((e) => ({
          id: e.id,
          from: e.from,
          subject: e.subject,
          text: e.text.slice(0, 2000),
          sent: e.created.toISOString(),
          last: e.last,
        }));
    },
  },
  reset() {
    emails.clear();
    keys.clear();
  },
});
