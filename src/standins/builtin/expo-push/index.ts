// Expo's push service, as a product's own Expo code sends to it: POST /--/api/v2/push/send answers with a ticket per
// recipient, and POST /--/api/v2/push/getReceipts with each ticket's receipt once it is ready (kept a day). An error
// on either carries Expo's `details.error`: DeviceNotRegistered when the token no longer reaches the device,
// MessageTooBig past 4096 bytes, InvalidCredentials or MessageRateExceeded as `reject` says.
//
// Each tenant's account is one Expo project, with an access token for enhanced push security. Its console setting,
// as the product gives it (account(tenant, settings)): enhancedSecurity "on", after which a request for its tokens
// without that token is refused, as Expo refuses it. Devices are registered by the agent (inbound `register`), as
// installing the app would: the token goes to the product however its app sends it.

import { randomBytes, randomUUID } from 'node:crypto';
import { defineStandIn, json, type Reply, type StandInContext, type StandInRequest } from '../../sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

/** Expo's limits: messages per send, receipt ids per read, the size of one message, how long a receipt is kept. */
const PER_SEND = 100;
const PER_READ = 1000;
const MESSAGE_BYTES = 4096;
const RECEIPT_KEPT_MS = 24 * 60 * 60_000;
/** What is kept, oldest dropped first. */
const TICKETS_KEPT = 5000;
const RECEIVED_KEPT = 200;

interface Device {
  token: string;
  tenant: string;
  name: string;
  /** Removed or wiped: sends to it are receipted DeviceNotRegistered. */
  gone: boolean;
  received: { title: string | null; body: string | null; data: unknown; silent: boolean; at: string }[];
}
type Problem = { status: 'error'; message: string; details: { error: string } };
interface Ticket {
  id: string;
  tenant: string;
  /** When its receipt is ready, on the world's clock. */
  ready: number;
  sent: number;
  receipt: { status: 'ok' } | Problem;
}

const devices = new Map<string, Device>();
const tickets = new Map<string, Ticket>();

const refused = (status: number, code: string, message: string): Reply =>
  json(status, { errors: [{ code, message }] });
const problem = (error: string, message: string): Problem => ({
  status: 'error',
  message,
  details: { error },
});
const notRegistered = (token: string) =>
  problem('DeviceNotRegistered', `"${token}" is not a registered push notification recipient`);

/** A token, or a device's name: the agent may use either. */
function deviceOf(body: Record<string, unknown>): Device {
  const key = String(body.token ?? '');
  const d = devices.get(key) ?? [...devices.values()].find((x) => x.name === key);
  if (!d) throw new Error(`no device ${key}`);
  return d;
}

/** The project a request may use: none named, or the one whose access token it carries. */
function bearer(ctx: StandInContext, req: StandInRequest): { tenant: string | null } | { refused: Reply } {
  const auth = req.headers.authorization;
  if (!auth) return { tenant: null };
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  for (const [tenant, a] of ctx.accounts) if (token && a.accessToken === token) return { tenant };
  return { refused: refused(401, 'UNAUTHORIZED', 'The bearer token is invalid.') };
}

/** Whether a project's enhanced security turns away a request that doesn't carry its access token. */
const locked = (ctx: StandInContext, tenant: string, caller: string | null) =>
  ctx.settings.get(tenant)?.enhancedSecurity === 'on' && caller !== tenant;

defineStandIn({
  manifest,
  routes: {
    'push.send': (req, ctx) => {
      const who = bearer(ctx, req);
      if ('refused' in who) return who.refused;
      let body: unknown;
      try {
        body = req.json<unknown>();
      } catch {
        return refused(400, 'VALIDATION_ERROR', 'The request body must be JSON.');
      }
      const messages = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
      if (messages.some((m) => typeof m !== 'object' || m === null))
        return refused(400, 'VALIDATION_ERROR', 'Each message must be an object.');
      // One ticket for each recipient, as Expo answers a message whose `to` is a list.
      const sends = messages.flatMap((m) =>
        (Array.isArray(m.to) ? m.to : [m.to]).map((to) => ({ m, to: String(to ?? '') })),
      );
      if (sends.length > PER_SEND)
        return refused(
          400,
          'PUSH_TOO_MANY_NOTIFICATIONS',
          `You are trying to send more than ${PER_SEND} push notifications in one request.`,
        );
      const projects = new Set(sends.map((s) => devices.get(s.to)?.tenant).filter(Boolean));
      if (projects.size > 1)
        return refused(
          400,
          'PUSH_TOO_MANY_EXPERIENCE_IDS',
          'All push notification messages in the same request must be for the same project.',
        );
      const [project] = [...projects] as (string | undefined)[];
      if (project && locked(ctx, project, who.tenant))
        return refused(
          401,
          'UNAUTHORIZED',
          'This project has enhanced push security on: send with its access token.',
        );

      const now = ctx.now().getTime();
      const data = sends.map(({ m, to }) => {
        const d = devices.get(to);
        if (!d) return notRegistered(to);
        const take = (b: 'reject' | 'gone' | 'late') =>
          ctx.take(b, { operation: 'push.send', tenant: d.tenant, target: d.token });
        const rejected = take('reject');
        if (rejected) {
          const error = String(rejected.param?.as ?? 'InvalidCredentials');
          return problem(
            error,
            error === 'MessageRateExceeded'
              ? 'You are sending messages too frequently to this device.'
              : 'Could not find APNs credentials for this project.',
          );
        }
        const message = { ...m, to: d.token };
        if (Buffer.byteLength(JSON.stringify(message)) > MESSAGE_BYTES)
          return problem('MessageTooBig', `The message is larger than ${MESSAGE_BYTES} bytes.`);
        const gone = take('gone');
        if (gone) d.gone = true;
        // Gone at the ticket when the agent says so; otherwise, as with Expo most often, at the receipt.
        if (gone?.param?.at === 'ticket') return notRegistered(d.token);
        const late = take('late');
        const id = randomUUID();
        tickets.set(id, {
          id,
          tenant: d.tenant,
          sent: now,
          ready: now + (late ? Math.max(0, Number(late.param?.delayMs ?? 60_000)) : 0),
          receipt: d.gone ? notRegistered(d.token) : { status: 'ok' },
        });
        for (const old of tickets.keys()) {
          if (tickets.size <= TICKETS_KEPT) break;
          tickets.delete(old);
        }
        if (!d.gone) {
          d.received.push({
            title: typeof m.title === 'string' ? m.title.slice(0, 500) : null,
            body: typeof m.body === 'string' ? m.body.slice(0, 2000) : null,
            data: m.data ?? null,
            silent: typeof m.title !== 'string' && typeof m.body !== 'string',
            at: new Date(now).toISOString(),
          });
          if (d.received.length > RECEIVED_KEPT) d.received.shift();
        }
        return { status: 'ok' as const, id };
      });
      return json(200, { data });
    },
    'push.receipts': (req, ctx) => {
      const who = bearer(ctx, req);
      if ('refused' in who) return who.refused;
      let ids: unknown;
      try {
        ids = req.json<{ ids?: unknown }>().ids;
      } catch {
        return refused(400, 'VALIDATION_ERROR', 'The request body must be JSON.');
      }
      if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string'))
        return refused(400, 'VALIDATION_ERROR', '`ids` must be a list of ticket ids.');
      if (ids.length > PER_READ)
        return refused(
          400,
          'PUSH_TOO_MANY_RECEIPTS',
          `You are trying to get more than ${PER_READ} receipts in one request.`,
        );
      const now = ctx.now().getTime();
      const data: Record<string, Ticket['receipt']> = {};
      for (const id of ids as string[]) {
        const t = tickets.get(id);
        // Not ready yet, a day old, or another locked project's: left out, as Expo leaves out what it hasn't got.
        if (!t || t.ready > now || now - t.sent > RECEIPT_KEPT_MS || locked(ctx, t.tenant, who.tenant))
          continue;
        data[id] = t.receipt;
      }
      return json(200, { data });
    },
  },
  inbound: {
    register(body, ctx) {
      const tenant = String(body.tenant ?? '');
      if (!ctx.accounts.has(tenant)) throw new Error(`no account for ${tenant}`);
      const name = String(body.device ?? '').slice(0, 80) || 'a device';
      // Expo's own shape, with the mark: ExponentPushToken[...].
      const token = `ExponentPushToken[swarmbox${randomBytes(7).toString('hex')}]`;
      devices.set(token, { token, tenant, name, gone: false, received: [] });
      return { token, device: name };
    },
    unregister(body) {
      const d = deviceOf(body);
      d.gone = true;
      return { token: d.token, gone: true };
    },
    received(body) {
      const d = deviceOf(body);
      return { device: d.name, gone: d.gone, received: d.received.slice(-20) };
    },
  },
  reset() {
    devices.clear();
    tickets.clear();
  },
});
