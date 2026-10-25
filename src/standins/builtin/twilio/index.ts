// Twilio, as a product's own Twilio code sees it (docs/standins.md): texts and their status callbacks, calls that
// run the product's TwiML, and the call and recording reads. Requests and webhooks keep Twilio's shapes and its
// signature (X-Twilio-Signature: base64 HMAC-SHA1 of the URL and every parameter, sorted by name, keyed with the
// auth token), so a product's webhook checks pass unchanged.
//
// An account's console settings, as the product gives them (account(tenant, settings)): smsUrl, voiceUrl and
// voiceStatusUrl, the addresses a person would set on the number in Twilio's console.

import { createHmac, randomBytes } from 'node:crypto';
import {
  defineStandIn,
  hexId,
  json,
  type Reply,
  type StandInContext,
  type StandInRequest,
} from '../../sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

interface Account {
  tenant: string;
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  number: string;
}
interface Message {
  sid: string;
  account: Account;
  to: string;
  from: string;
  body: string;
  status: string;
  errorCode: number | null;
  callback: string | null;
  created: Date;
}
interface Call {
  sid: string;
  account: Account;
  from: string;
  to: string;
  status: string;
  started: Date;
  duration: number;
  parent: string | null;
  /** Set while a held call rings: the caller hanging up ends it. */
  hangUp?: () => void;
}
interface Recording {
  sid: string;
  call: string;
  account: Account;
  duration: number;
  channels: number;
  created: Date;
}

const messages = new Map<string, Message>();
const calls = new Map<string, Call>();
const recordings = new Map<string, Recording>();

const rfc2822 = (d: Date) => d.toUTCString().replace('GMT', '+0000');
const err = (status: number, code: number, message: string): Reply =>
  json(status, { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });

/** The account a request authenticates as: Basic AccountSid:AuthToken, or ApiKeySid:ApiKeySecret. */
function caller(ctx: StandInContext, req: StandInRequest): Account | null {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Basic ')) return null;
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  for (const [tenant, a] of ctx.accounts) {
    const acct = { tenant, ...a } as Account;
    if (
      (user === acct.accountSid && pass === acct.authToken) ||
      (user === acct.apiKeySid && pass === acct.apiKeySecret)
    )
      return acct;
  }
  return null;
}

/** Post a signed, form-encoded webhook, as Twilio does; the product's answer comes back. */
async function webhook(ctx: StandInContext, account: Account, url: string, params: Record<string, string>) {
  const body = new URLSearchParams(params).toString();
  return ctx.deliver(url, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'TwilioProxy/1.1',
      'x-twilio-signature': twilioSignature(account.authToken, url, params),
      'i-twilio-idempotency-token': randomBytes(16).toString('hex'),
    },
    body,
  });
}

const accountOf = (ctx: StandInContext, tenant: string): Account => {
  const a = ctx.accounts.get(tenant);
  if (!a) throw new Error(`no Twilio account for ${tenant}`);
  return { tenant, ...a } as Account;
};
const setting = (ctx: StandInContext, tenant: string, key: string): string | null =>
  ctx.settings.get(tenant)?.[key] ?? null;

async function sendReceipt(ctx: StandInContext, m: Message, status: string, errorCode: number | null) {
  m.status = status;
  m.errorCode = errorCode;
  if (!m.callback) return 0;
  const params: Record<string, string> = {
    MessageSid: m.sid,
    SmsSid: m.sid,
    AccountSid: m.account.accountSid,
    From: m.from,
    To: m.to,
    MessageStatus: status,
    SmsStatus: status,
    ApiVersion: '2010-04-01',
    ...(errorCode ? { ErrorCode: String(errorCode) } : {}),
  };
  return (await webhook(ctx, m.account, m.callback, params)).status;
}

// ---- TwiML: the verbs a product answers a call with, run in order ----

interface Verb {
  name: string;
  attrs: Record<string, string>;
  text: string;
}
/** The verbs of a <Response>, with their attributes and text (enough of TwiML for Dial, Say, Record, Reject, Hangup). */
export function parseTwiml(xml: string): Verb[] {
  const body = /<Response\b[^>]*>([\s\S]*?)<\/Response>/.exec(xml)?.[1] ?? '';
  const verbs: Verb[] = [];
  const re = /<([A-Z][a-zA-Z]*)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) attrs[a[1]!] = unescapeXml(a[2]!);
    verbs.push({ name: m[1]!, attrs, text: unescapeXml((m[3] ?? '').replace(/<[^>]+>/g, '').trim()) });
  }
  return verbs;
}
const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

interface CallPlan {
  answer: 'answered' | 'no-answer' | 'busy';
  talkSec: number;
  voicemail: 'leave' | 'none';
  messageSec: number;
}

/** Run a call: ring the product's voice URL, follow its TwiML and each verb's action, then report how it ended. */
async function runCall(
  ctx: StandInContext,
  call: Call,
  plan: CallPlan,
  held: boolean,
  ringMs: number,
): Promise<string[]> {
  const account = call.account;
  const steps: string[] = [];
  const base = (status: string): Record<string, string> => ({
    CallSid: call.sid,
    AccountSid: account.accountSid,
    From: call.from,
    To: call.to,
    CallStatus: status,
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  });
  const voiceUrl = setting(ctx, account.tenant, 'voiceUrl');
  if (!voiceUrl) throw new Error(`no voiceUrl for ${account.tenant}: give it in the account's settings`);
  let answer = await webhook(ctx, account, voiceUrl, base('ringing'));
  steps.push(`rang ${voiceUrl}: ${answer.status}`);
  let ended: 'completed' | 'busy' | 'no-answer' | 'failed' = 'completed';
  if (held) {
    // Rings until the caller hangs up: whoever was being dialled is cancelled, and that's the call.
    await new Promise<void>((r) => (call.hangUp = r));
    const dial = parseTwiml(answer.text()).find((v) => v.name === 'Dial');
    if (dial?.attrs.action) {
      const a = await webhook(ctx, account, new URL(dial.attrs.action, voiceUrl).toString(), {
        ...base('completed'),
        DialCallStatus: 'canceled',
      });
      steps.push(`hung up while ringing; dial action: ${a.status}`);
    } else steps.push('hung up while ringing');
    answer = { ...answer, status: 204, text: () => '' };
  } else await new Promise((r) => setTimeout(r, Math.min(ringMs, 60_000)));

  let documents = 0;
  run: while (answer.status >= 200 && answer.status < 300 && documents++ < 10) {
    for (const verb of parseTwiml(answer.text())) {
      if (verb.name === 'Say' || verb.name === 'Play' || verb.name === 'Pause') {
        steps.push(`${verb.name.toLowerCase()}: ${verb.text.slice(0, 80)}`);
        continue;
      }
      if (verb.name === 'Reject') {
        ended = verb.attrs.reason === 'busy' ? 'busy' : 'no-answer';
        steps.push(`rejected (${verb.attrs.reason ?? 'rejected'})`);
        break run;
      }
      if (verb.name === 'Hangup') {
        steps.push('hung up');
        break run;
      }
      if (verb.name === 'Dial') {
        const outcome = plan.answer === 'answered' ? 'completed' : plan.answer;
        const params: Record<string, string> = { ...base('in-progress'), DialCallStatus: outcome };
        if (outcome === 'completed') {
          call.duration += plan.talkSec;
          params.DialCallDuration = String(plan.talkSec);
          params.DialCallSid = hexId('CA', 32);
          const { hangUp: _ringing, ...leg } = call;
          calls.set(params.DialCallSid, {
            ...leg,
            sid: params.DialCallSid,
            parent: call.sid,
            duration: plan.talkSec,
            status: 'completed',
          });
          if (verb.attrs.record?.startsWith('record-from')) {
            const rec = record(call, plan.talkSec, verb.attrs.record.endsWith('dual') ? 2 : 1);
            params.RecordingSid = rec.sid;
            params.RecordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${account.accountSid}/Recordings/${rec.sid}`;
            params.RecordingDuration = String(rec.duration);
          }
        }
        steps.push(`dialled ${verb.text}: ${outcome}`);
        if (!verb.attrs.action) {
          if (outcome === 'completed') break run;
          continue;
        }
        answer = await webhook(ctx, account, new URL(verb.attrs.action, voiceUrl).toString(), params);
        steps.push(`dial action: ${answer.status}`);
        continue run;
      }
      if (verb.name === 'Record') {
        if (plan.voicemail === 'none') {
          steps.push('asked to leave a message: left none');
          continue;
        }
        const max = Number(verb.attrs.maxLength ?? 3600);
        const rec = record(call, Math.min(plan.messageSec, max), 1);
        call.duration += rec.duration;
        steps.push(`left a ${rec.duration} s message`);
        if (!verb.attrs.action) continue;
        answer = await webhook(ctx, account, new URL(verb.attrs.action, voiceUrl).toString(), {
          ...base('in-progress'),
          RecordingSid: rec.sid,
          RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${account.accountSid}/Recordings/${rec.sid}`,
          RecordingDuration: String(rec.duration),
          Digits: 'hangup',
        });
        steps.push(`record action: ${answer.status}`);
        continue run;
      }
      steps.push(`skipped <${verb.name}>`);
    }
    break;
  }
  if (answer.status < 200 || answer.status >= 300) ended = 'failed';
  call.status = ended;
  const statusUrl = setting(ctx, account.tenant, 'voiceStatusUrl');
  if (statusUrl) {
    const done = await webhook(ctx, account, statusUrl, {
      ...base(ended),
      CallDuration: String(call.duration),
    });
    steps.push(`status ${ended}: ${done.status}`);
  }
  return steps;
}

function record(call: Call, duration: number, channels: number): Recording {
  const rec: Recording = {
    sid: hexId('RE', 32),
    call: call.sid,
    account: call.account,
    duration,
    channels,
    created: new Date(),
  };
  recordings.set(rec.sid, rec);
  return rec;
}

/** Silence as MP3: one MPEG-1 Layer III frame (128 kbps, 44.1 kHz, 417 bytes) per 26 ms, at most five seconds. */
function silentMp3(seconds: number): Buffer {
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9064, 0);
  const n = Math.max(1, Math.min(Math.round((Math.min(seconds, 5) * 1000) / 26.12), 200));
  return Buffer.concat(Array.from({ length: n }, () => frame));
}

const page = <T>(key: string, items: T[], req: StandInRequest) => {
  const size = Math.min(Number(req.query.get('PageSize') ?? 50), 1000);
  return json(200, {
    [key]: items.slice(0, size),
    page: 0,
    page_size: size,
    next_page_uri: null,
    uri: req.path,
  });
};

defineStandIn({
  manifest,
  account(_tenant, made) {
    // Twilio's own formats: AC and SK sids, a 32-hex auth token, all carrying the hex mark.
    return { ...made, accountSid: hexId('AC', 32), authToken: hexId('', 32), apiKeySid: hexId('SK', 32) };
  },
  routes: {
    'messages.create': (req, ctx) => {
      const acct = caller(ctx, req);
      if (!acct || acct.accountSid !== req.params.account) return err(401, 20003, 'Authenticate');
      const form = req.form();
      const to = form.get('To') ?? '';
      const from = form.get('From') ?? acct.number;
      const body = form.get('Body') ?? '';
      if (!to) return err(400, 21604, "A 'To' phone number is required.");
      if (!body && !form.get('MediaUrl')) return err(400, 21602, 'Message body is required.');
      if (ctx.take('reject', { operation: 'messages.create', tenant: acct.tenant, target: to }))
        return err(400, 21610, 'Attempt to send to unsubscribed recipient');
      const m: Message = {
        sid: hexId('SM', 32),
        account: acct,
        to,
        from,
        body,
        status: 'queued',
        errorCode: null,
        callback: form.get('StatusCallback'),
        created: ctx.now(),
      };
      messages.set(m.sid, m);
      if (!ctx.take('manual', { tenant: acct.tenant, target: to })) {
        const undelivered = ctx.take('undeliver', { tenant: acct.tenant, target: to });
        void (async () => {
          await sendReceipt(ctx, m, 'sent', null);
          await sendReceipt(ctx, m, undelivered ? 'undelivered' : 'delivered', undelivered ? 30003 : null);
        })();
      }
      return json(201, {
        sid: m.sid,
        account_sid: acct.accountSid,
        to,
        from,
        body,
        status: 'queued',
        num_segments: '1',
        direction: 'outbound-api',
        date_created: rfc2822(m.created),
        api_version: '2010-04-01',
        error_code: null,
        error_message: null,
        uri: `/2010-04-01/Accounts/${acct.accountSid}/Messages/${m.sid}.json`,
      });
    },
    'messages.get': (req, ctx) => {
      const acct = caller(ctx, req);
      if (!acct) return err(401, 20003, 'Authenticate');
      const m = messages.get(String(req.params.sid).replace(/\.json$/, ''));
      if (!m || m.account.accountSid !== acct.accountSid)
        return err(404, 20404, 'The requested resource was not found');
      return json(200, {
        sid: m.sid,
        to: m.to,
        from: m.from,
        body: m.body,
        status: m.status,
        error_code: m.errorCode,
      });
    },
    'calls.list': (req, ctx) => {
      const acct = caller(ctx, req);
      if (!acct || acct.accountSid !== req.params.account) return err(401, 20003, 'Authenticate');
      const after = req.query.get('StartTime>');
      const since = req.query.get('StartTime>=') ?? after;
      const before = req.query.get('StartTime<');
      const parent = req.query.get('ParentCallSid');
      const list = [...calls.values()]
        .filter((c) => c.account.accountSid === acct.accountSid)
        .filter((c) => (parent ? c.parent === parent : true))
        .filter(
          (c) =>
            (since ? c.started >= new Date(since) : true) && (before ? c.started < new Date(before) : true),
        )
        .map((c) => ({
          sid: c.sid,
          parent_call_sid: c.parent,
          from: c.from,
          to: c.to,
          direction: c.parent ? 'outbound-dial' : 'inbound',
          status: c.status,
          start_time: rfc2822(c.started),
          duration: String(c.duration),
        }));
      return page('calls', list, req);
    },
    'recordings.list': (req, ctx) => {
      const acct = caller(ctx, req);
      if (!acct || acct.accountSid !== req.params.account) return err(401, 20003, 'Authenticate');
      const callSid = req.query.get('CallSid');
      const list = [...recordings.values()]
        .filter((r) => r.account.accountSid === acct.accountSid && (!callSid || r.call === callSid))
        .map((r) => ({
          sid: r.sid,
          call_sid: r.call,
          duration: String(r.duration),
          channels: r.channels,
          date_created: rfc2822(r.created),
        }));
      return page('recordings', list, req);
    },
    'recordings.media': (req, ctx) => {
      const acct = caller(ctx, req);
      if (!acct) return err(401, 20003, 'Authenticate');
      const sid = String(req.params.file).replace(/\.(mp3|wav|json)$/, '');
      const rec = recordings.get(sid);
      if (!rec || rec.account.accountSid !== acct.accountSid)
        return err(404, 20404, 'The requested resource was not found');
      if (String(req.params.file).endsWith('.json'))
        return json(200, {
          sid: rec.sid,
          call_sid: rec.call,
          duration: String(rec.duration),
          channels: rec.channels,
        });
      return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: silentMp3(rec.duration) };
    },
    'transcriptions.list': (req, ctx) =>
      caller(ctx, req) ? page('transcriptions', [], req) : err(401, 20003, 'Authenticate'),
    // Voice Intelligence isn't switched on for these accounts, as on a real account that hasn't bought it.
    'intelligence.transcripts': (req, ctx) =>
      caller(ctx, req)
        ? err(403, 20403, 'Voice Intelligence is not enabled for this account')
        : err(401, 20003, 'Authenticate'),
    'intelligence.sentences': (req, ctx) =>
      caller(ctx, req)
        ? err(403, 20403, 'Voice Intelligence is not enabled for this account')
        : err(401, 20003, 'Authenticate'),
  },
  inbound: {
    async text(body, ctx) {
      const account = accountOf(ctx, String(body.tenant));
      const url = setting(ctx, account.tenant, 'smsUrl');
      if (!url) throw new Error(`no smsUrl for ${account.tenant}: give it in the account's settings`);
      const sid = hexId('SM', 32);
      const delivered = await webhook(ctx, account, url, {
        MessageSid: sid,
        SmsSid: sid,
        AccountSid: account.accountSid,
        From: String(body.from),
        To: account.number,
        Body: String(body.body ?? ''),
        NumMedia: '0',
        NumSegments: '1',
        ApiVersion: '2010-04-01',
      });
      return { message: sid, delivered: delivered.status };
    },
    async call(body, ctx) {
      const account = accountOf(ctx, String(body.tenant));
      const call: Call = {
        sid: hexId('CA', 32),
        account,
        from: String(body.from),
        to: account.number,
        status: 'ringing',
        started: ctx.now(),
        duration: 0,
        parent: null,
      };
      calls.set(call.sid, call);
      const answer = ['answered', 'no-answer', 'busy'].includes(String(body.answer))
        ? String(body.answer)
        : 'no-answer';
      const plan: CallPlan = {
        answer: answer as CallPlan['answer'],
        talkSec: Math.max(1, Math.min(Number(body.talkSec ?? 60) || 60, 7200)),
        voicemail: body.voicemail === 'none' ? 'none' : 'leave',
        messageSec: Math.max(1, Math.min(Number(body.messageSec ?? 20) || 20, 600)),
      };
      const held = body.hold === true || body.hold === 'true';
      const ringMs = Math.max(0, Number(body.ringMs ?? 3000) || 0);
      const running = runCall(ctx, call, plan, held, ringMs);
      // A held call is still ringing when this answers; the rest runs after a hangup.
      if (held) {
        running.catch(() => undefined);
        return { call: call.sid, status: 'ringing' };
      }
      const steps = await running;
      return { call: call.sid, status: call.status, steps };
    },
    hangup(body) {
      const call = calls.get(String(body.call));
      if (!call?.hangUp) throw new Error(`no call ${String(body.call)} is ringing`);
      const hangUp = call.hangUp;
      delete call.hangUp;
      hangUp();
      return { call: call.sid, hungUp: true };
    },
    async receipt(body, ctx) {
      const m = messages.get(String(body.message));
      if (!m) throw new Error(`no message ${String(body.message)}`);
      const status = ['sent', 'delivered', 'undelivered', 'failed'].includes(String(body.status))
        ? String(body.status)
        : 'delivered';
      const delivered = await sendReceipt(
        ctx,
        m,
        status,
        status === 'undelivered' || status === 'failed' ? 30003 : null,
      );
      return { message: m.sid, status, delivered };
    },
  },
  reset() {
    messages.clear();
    calls.clear();
    recordings.clear();
  },
});
