// Email, as Resend: POST /emails as a product's own Resend code sends it, and the delivery events back to the
// account's webhook, signed as Resend's webhooks are (Svix: base64 HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>"
// keyed with the secret after "whsec_", timestamped with the world's time, which the product checks against its own).
//
// An account's console settings, as the product gives them (account(tenant, settings)): webhookUrl, the endpoint a
// person would add in Resend's dashboard. A product with one account for everyone uses one tenant for it.
//
// Attachments are kept whole, as files in the stand-in's folder: listed and retrieved as Resend's API does
// (GET /emails/:id/attachments[/:attachment_id]), each with a signed download_url on the stand-in's own address
// that expires after an hour of the world's time, and listed with their files in the mailbox.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
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
  attachments: Attachment[];
  created: Date;
  last: string;
  /** Its Idempotency-Key in `keys`, so the key goes when the email does. */
  key: string | null;
}

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  disposition: 'attachment' | 'inline';
  contentId: string | null;
  size: number;
  sha256: string;
  /** Where its bytes are kept; null for one given as a remote path, which the stand-in can't fetch. */
  file: string | null;
}

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.zip': 'application/zip',
};

/** An attachment's bytes, in any of the forms Resend's SDKs send: base64, an array of bytes, a serialised Buffer. */
function bytesOf(content: unknown): Buffer | null {
  if (typeof content === 'string') return Buffer.from(content, 'base64');
  const arr = Array.isArray(content)
    ? content
    : content && typeof content === 'object' && Array.isArray((content as { data?: unknown }).data)
      ? (content as { data: unknown[] }).data
      : null;
  if (!arr || !arr.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 256))
    return null;
  return Buffer.from(arr as number[]);
}

/** An email's attachments as sent, kept as files; or the validation error Resend would give. */
function keepAttachments(raw: unknown, emailId: string, ctx: StandInContext): Attachment[] | Reply {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return err(422, 'validation_error', 'The `attachments` field must be an array.');
  const out: Attachment[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    const filename = typeof a?.filename === 'string' && a.filename ? a.filename : 'attachment';
    const bytes = a?.content === undefined ? null : bytesOf(a.content);
    if (a?.content !== undefined && !bytes)
      return err(422, 'validation_error', 'An attachment’s `content` must be base64 or a buffer.');
    if (!bytes && typeof a?.path !== 'string')
      return err(422, 'validation_error', 'An attachment needs `content` or `path`.');
    const id = randomUUID();
    let file: string | null = null;
    if (bytes) {
      folder = join(ctx.tmp, 'attachments');
      const dir = join(folder, emailId);
      mkdirSync(dir, { recursive: true });
      file = join(dir, `${id}-${filename.replace(/[^\w.-]+/g, '_').slice(-100)}`);
      writeFileSync(file, bytes);
    }
    const given = a.content_type ?? a.contentType;
    out.push({
      id,
      filename,
      contentType:
        typeof given === 'string' && given
          ? given
          : (TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream'),
      disposition: a.content_id || a.contentId || a.inline_content_id ? 'inline' : 'attachment',
      contentId: String(a.content_id ?? a.contentId ?? a.inline_content_id ?? '') || null,
      size: bytes?.length ?? 0,
      sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : '',
      file,
    });
  }
  return out;
}

/** Where attachments are kept: the stand-in's own folder, once one has come. */
let folder = '';

/** How long a download_url works, in the world's time. */
const DOWNLOAD_FOR_MS = 60 * 60_000;
const DOWNLOAD_KEY = randomBytes(32);
const downloadSignature = (email: string, attachment: string, expires: string) =>
  createHmac('sha256', DOWNLOAD_KEY).update(`${email}/${attachment}/${expires}`).digest('hex');

/** An attachment as Resend's API shows it, with a download link that works for an hour. */
function attachmentJson(e: Email, a: Attachment, ctx: StandInContext) {
  const expires = new Date(ctx.now().getTime() + DOWNLOAD_FOR_MS);
  const at = String(Math.floor(expires.getTime() / 1000));
  return {
    id: a.id,
    filename: a.filename,
    size: a.size,
    content_type: a.contentType,
    content_disposition: a.disposition,
    ...(a.contentId ? { content_id: a.contentId } : {}),
    download_url: a.file
      ? `${ctx.origin}/_cdn/${e.id}/attachments/${a.id}?expires=${at}&signature=${downloadSignature(e.id, a.id, at)}`
      : null,
    expires_at: expires.toISOString(),
  };
}

/** The web links in an email, from its text and its HTML's hrefs, first seen first. */
function linksIn(e: Email): string[] {
  const found = [
    ...(e.text.match(/https?:\/\/[^\s<>"'()[\]]+/g) ?? []),
    ...[...(e.html ?? '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/&amp;/g, '&')),
  ].filter((u) => /^https?:\/\//.test(u));
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 20);
}

const forget = (e: Email) => {
  if (e.attachments.length && folder) rmSync(join(folder, e.id), { recursive: true, force: true });
};

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
      const id = randomUUID();
      const attachments = keepAttachments(b.attachments, id, ctx);
      if (!Array.isArray(attachments)) return attachments;
      const tags = Array.isArray(b.tags)
        ? (b.tags as { name?: unknown; value?: unknown }[])
            .filter((t) => typeof t?.name === 'string')
            .map((t) => ({ name: String(t.name), value: String(t.value ?? '') }))
        : [];
      const e: Email = {
        id,
        tenant,
        from: b.from,
        to,
        subject: b.subject,
        text: typeof b.text === 'string' ? keep(b.text) : '',
        html: typeof b.html === 'string' ? keep(b.html) : null,
        replyTo: typeof b.reply_to === 'string' ? b.reply_to : null,
        tags,
        attachments,
        created: ctx.now(),
        last: 'email.sent',
        key,
      };
      emails.set(e.id, e);
      if (key) keys.set(key, { id: e.id, body: hash(raw) });
      for (const old of emails.values()) {
        if (emails.size <= EMAILS_KEPT) break;
        emails.delete(old.id);
        forget(old);
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
    'emails.attachments': (req, ctx) => {
      const who = caller(ctx, req);
      if ('refused' in who) return who.refused;
      const e = emails.get(req.params.id!);
      if (!e || e.tenant !== who.tenant) return err(404, 'not_found', 'Email not found.');
      const after = req.query.get('after');
      const before = req.query.get('before');
      if (after && before)
        return err(422, 'validation_error', 'You can only use one of `after` or `before`.');
      const limit = req.query.has('limit') ? Number(req.query.get('limit')) : e.attachments.length;
      if (req.query.has('limit') && !(Number.isInteger(limit) && limit >= 1 && limit <= 100))
        return err(422, 'validation_error', 'The `limit` must be between 1 and 100.');
      let list = e.attachments;
      const at = (id: string) => list.findIndex((a) => a.id === id);
      if (after) list = list.slice(at(after) + 1);
      if (before) list = at(before) < 0 ? list : list.slice(0, at(before));
      const page = before ? list.slice(-limit) : list.slice(0, limit);
      return json(200, {
        object: 'list',
        has_more: page.length < list.length,
        data: page.map((a) => attachmentJson(e, a, ctx)),
      });
    },
    'emails.attachment': (req, ctx) => {
      const who = caller(ctx, req);
      if ('refused' in who) return who.refused;
      const e = emails.get(req.params.id!);
      const a = e?.tenant === who.tenant ? e.attachments.find((x) => x.id === req.params.attachment) : null;
      if (!e || !a) return err(404, 'not_found', 'Attachment not found.');
      return json(200, { object: 'attachment', ...attachmentJson(e, a, ctx) });
    },
    // The download link's own host, as Resend's CDN: no key, a signature that expires.
    'attachments.download': (req, ctx): Reply => {
      const expires = req.query.get('expires') ?? '';
      const given = Buffer.from(req.query.get('signature') ?? '');
      const want = Buffer.from(downloadSignature(req.params.id!, req.params.attachment!, expires));
      const e = emails.get(req.params.id!);
      const a = e?.attachments.find((x) => x.id === req.params.attachment);
      if (given.length !== want.length || !timingSafeEqual(given, want) || !a?.file)
        return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'Forbidden' };
      if (Number(expires) * 1000 < ctx.now().getTime())
        return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'This link has expired' };
      return {
        status: 200,
        headers: {
          'content-type': a.contentType,
          'content-disposition': `attachment; filename="${a.filename.replace(/["\\\r\n]/g, '_')}"`,
        },
        body: readFileSync(a.file),
      };
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
          links: linksIn(e),
          attachments: e.attachments.map((a) => ({
            filename: a.filename,
            content_type: a.contentType,
            size: a.size,
            sha256: a.sha256,
            file: a.file,
          })),
          sent: e.created.toISOString(),
          last: e.last,
        }));
    },
  },
  reset() {
    if (folder) rmSync(folder, { recursive: true, force: true });
    emails.clear();
    keys.clear();
  },
});
