// The Twilio stand-in against a product that checks every signature as a real Twilio integration does: texts and
// their receipts, a customer's text, a call run through the product's TwiML (ring, dial, voicemail), an answered
// and recorded one, a caller who hangs up while it rings, and the call and recording reads.

import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import twilioSdk from 'twilio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinStandIn } from '../src/standins/builtin/index.ts';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';

const SANDBOX = process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required';

/** Twilio's signature, written again from its documentation, so the stand-in's own isn't checked against itself. */
const sign = (token: string, url: string, params: URLSearchParams) =>
  createHmac('sha1', token)
    .update([...params.keys()].sort().reduce((a, k) => a + k + (params.get(k) ?? ''), url))
    .digest('base64');

interface Hook {
  path: string;
  params: URLSearchParams;
  valid: boolean;
}
const hooks: Hook[] = [];
let token = '';
let product: http.Server;
let port = 0;
beforeAll(async () => {
  product = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const url = `http://${req.headers.host}${req.url}`;
      // Twice over: our own reading of Twilio's documentation, and Twilio's own library.
      const valid =
        req.headers['x-twilio-signature'] === sign(token, url, params) &&
        twilioSdk.validateRequest(
          token,
          String(req.headers['x-twilio-signature']),
          url,
          Object.fromEntries(params),
        );
      hooks.push({ path: req.url ?? '', params, valid });
      const twiml = (x: string) =>
        res
          .writeHead(200, { 'content-type': 'text/xml' })
          .end(`<?xml version="1.0"?><Response>${x}</Response>`);
      if (!valid) return res.writeHead(403).end();
      // As Flowology answers: ring a number and record; if nobody answers, voicemail; then goodbye.
      // A number whose TwiML dials with no action: Twilio goes on to the next verb.
      if (req.url === '/hooks/voice' && params.get('From') === '+12505550180')
        return twiml('<Dial><Number>+12505550111</Number></Dial><Say>After the dial.</Say><Hangup/>');
      if (req.url === '/hooks/voice')
        return twiml(
          '<Dial timeout="20" answerOnBridge="true" action="/hooks/voice-dial?step=forward" method="POST" record="record-from-answer-dual"><Number>+12505550111</Number></Dial>',
        );
      if (req.url?.startsWith('/hooks/voice-dial'))
        return params.get('DialCallStatus') === 'completed' || params.get('DialCallStatus') === 'canceled'
          ? twiml('<Hangup/>')
          : twiml(
              '<Say>Sorry, nobody can take your call.</Say><Record maxLength="120" playBeep="true" action="/hooks/voicemail" method="POST"/><Say>Goodbye.</Say><Hangup/>',
            );
      if (req.url === '/hooks/voicemail') return twiml('<Hangup/>');
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => product.listen(0, '127.0.0.1', r));
  port = (product.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => product.close(() => r())));

const origin = () => `http://acme.sample.test:${port}`;
/** Start a call, then read it with call-status until it has ended, as an agent would. */
const callThrough = async (twilio: StandIn, body: Record<string, string | number | boolean>) => {
  const started = (await twilio.inbound('call', body)) as { call: string; status: string };
  expect(started.status).toBe('ringing');
  for (let i = 0; i < 200; i++) {
    const s = (await twilio.inbound('call-status', { call: started.call })) as {
      done: boolean;
      status: string;
      steps: string[];
    };
    if (s.done) return { call: started.call, status: s.status, steps: s.steps };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`call ${started.call} never ended`);
};
const waitFor = async <T>(f: () => T | undefined, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('the Twilio stand-in', () => {
  let twilio: StandIn;
  let acct: Record<string, string>;
  const auth = (user = acct.accountSid, pass = acct.authToken) =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${twilio.baseUrls.api}/2010-04-01/Accounts/${acct.accountSid}${path}`, {
      ...init,
      headers: {
        authorization: auth(),
        'content-type': 'application/x-www-form-urlencoded',
        ...init.headers,
      },
    });
  const text = (to: string, callback = true) =>
    api('/Messages.json', {
      method: 'POST',
      body: new URLSearchParams({
        To: to,
        From: acct.number!,
        Body: 'Your estimate is ready',
        ...(callback ? { StatusCallback: `${origin()}/hooks/sms-status` } : {}),
      }),
    });

  beforeAll(async () => {
    twilio = await startStandIn({
      ...builtinStandIn('twilio'),
      deliverTo: `http://127.0.0.1:${port}`,
      baseDomain: 'sample.test',
      sandbox: SANDBOX,
      onStderr: (t) => process.stderr.write(t),
    });
    acct = await twilio.account('acme', {
      smsUrl: `${origin()}/hooks/sms`,
      voiceUrl: `${origin()}/hooks/voice`,
      voiceStatusUrl: `${origin()}/hooks/voice-status`,
    });
    token = acct.authToken!;
  });
  afterAll(() => twilio.stop());

  it('has accounts in Twilio’s own formats, marked as a stand-in’s', () => {
    expect(acct.accountSid).toMatch(/^ACc0ffee5b[0-9a-f]{24}$/);
    expect(acct.authToken).toMatch(/^c0ffee5b[0-9a-f]{24}$/);
    expect(acct.apiKeySid).toMatch(/^SKc0ffee5b/);
  });

  it('sends a text, and posts its receipts signed, sent then delivered', async () => {
    const r = await text('+12505550123');
    expect(r.status).toBe(201);
    const { sid, status } = (await r.json()) as { sid: string; status: string };
    expect(sid).toMatch(/^SM/);
    expect(status).toBe('queued');
    await waitFor(() =>
      hooks.filter((h) => h.params.get('MessageSid') === sid).length === 2 ? true : undefined,
    );
    const receipts = hooks.filter((h) => h.params.get('MessageSid') === sid);
    expect(receipts.map((h) => h.params.get('MessageStatus'))).toEqual(['sent', 'delivered']);
    expect(receipts.every((h) => h.valid && h.path === '/hooks/sms-status')).toBe(true);
  });

  it('refuses as Twilio does: a wrong token, an opted-out number; and can leave a text undelivered or its receipts to the agent', async () => {
    const bad = await fetch(`${twilio.baseUrls.api}/2010-04-01/Accounts/${acct.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: auth(acct.accountSid, 'wrong') },
      body: new URLSearchParams({ To: '+1', Body: 'x' }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: number }).code).toBe(20003);

    await twilio.behave({ behaviour: 'reject', count: 1, match: { target: '+12505550199' } });
    const opted = await text('+12505550199');
    expect(opted.status).toBe(400);
    expect(((await opted.json()) as { code: number }).code).toBe(21610);

    await twilio.behave({ behaviour: 'undeliver', count: 1, match: { target: '+12505550142' } });
    const lost = (await (await text('+12505550142')).json()) as { sid: string };
    const last = await waitFor(() =>
      hooks.find(
        (h) => h.params.get('MessageSid') === lost.sid && h.params.get('MessageStatus') === 'undelivered',
      ),
    );
    expect(last.params.get('ErrorCode')).toBe('30003');

    await twilio.behave({ behaviour: 'manual', count: 1 });
    const held = (await (await text('+12505550150')).json()) as { sid: string };
    await new Promise((r) => setTimeout(r, 200));
    expect(hooks.some((h) => h.params.get('MessageSid') === held.sid)).toBe(false);
    await twilio.inbound('receipt', { message: held.sid, status: 'delivered' });
    expect(
      hooks.some(
        (h) => h.params.get('MessageSid') === held.sid && h.params.get('MessageStatus') === 'delivered',
      ),
    ).toBe(true);
  });

  it('answers for Twilio when it is down or busy, in Twilio’s own words', async () => {
    await twilio.behave({ behaviour: 'limit', count: 1 });
    const limited = await text('+12505550123', false);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: number }).code).toBe(20429);
  });

  it('delivers a customer’s text to the number’s webhook', async () => {
    const got = (await twilio.inbound('text', {
      tenant: 'acme',
      from: '+12505550123',
      body: 'Is Tuesday OK?',
    })) as {
      message: string;
    };
    const hook = hooks.find((h) => h.params.get('MessageSid') === got.message)!;
    expect(hook.path).toBe('/hooks/sms');
    expect(hook.valid).toBe(true);
    expect(hook.params.get('Body')).toBe('Is Tuesday OK?');
    expect(hook.params.get('To')).toBe(acct.number);
  });

  it('runs a call through the product’s TwiML: nobody answers, so the caller leaves a message', async () => {
    const r = await callThrough(twilio, { tenant: 'acme', from: '+12505550177', ringMs: 0, messageSec: 14 });
    expect(r.status).toBe('completed');
    expect(r.steps).toEqual([
      'rang http://acme.sample.test:' + port + '/hooks/voice: 200',
      'dialled +12505550111: no-answer',
      'dial action: 200',
      'say: Sorry, nobody can take your call.',
      'left a 14 s message',
      'record action: 200',
      'hung up',
      'status completed: 204',
    ]);
    const of = (path: string) =>
      hooks.filter((h) => h.params.get('CallSid') === r.call && h.path.startsWith(path));
    expect(of('/hooks/voice-dial')[0]!.params.get('DialCallStatus')).toBe('no-answer');
    expect(of('/hooks/voicemail')[0]!.params.get('RecordingDuration')).toBe('14');
    // The recording's link is the stand-in's own: a product that fetches it stays in the world.
    expect(of('/hooks/voicemail')[0]!.params.get('RecordingUrl')).toMatch(
      new RegExp(`^${twilio.origin}/2010-04-01/`),
    );
    expect(of('/hooks/voice-status')[0]!.params.get('CallStatus')).toBe('completed');
    expect(hooks.filter((h) => h.params.get('CallSid') === r.call).every((h) => h.valid)).toBe(true);

    const recs = (await (await api(`/Recordings.json?CallSid=${r.call}`)).json()) as {
      recordings: { sid: string; duration: string }[];
    };
    expect(recs.recordings).toHaveLength(1);
    expect(recs.recordings[0]!.duration).toBe('14');
    const mp3 = await api(`/Recordings/${recs.recordings[0]!.sid}.mp3`);
    expect(mp3.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await mp3.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfb]));
  });

  it('records an answered call both ways, and lists it with its dialled leg', async () => {
    const r = await callThrough(twilio, {
      tenant: 'acme',
      from: '+12505550178',
      answer: 'answered',
      talkSec: 95,
      ringMs: 0,
    });
    const dial = hooks.find(
      (h) => h.params.get('CallSid') === r.call && h.path.startsWith('/hooks/voice-dial'),
    )!;
    expect(dial.params.get('DialCallStatus')).toBe('completed');
    expect(dial.params.get('DialCallDuration')).toBe('95');
    expect(dial.params.get('RecordingSid')).toMatch(/^RE/);
    const calls = (await (await api(`/Calls.json?ParentCallSid=${r.call}`)).json()) as {
      calls: { parent_call_sid: string }[];
    };
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]!.parent_call_sid).toBe(r.call);
    // Read with the API key, as a recordings job does.
    const viaKey = await fetch(
      `${twilio.baseUrls.api}/2010-04-01/Accounts/${acct.accountSid}/Recordings.json?CallSid=${r.call}`,
      {
        headers: { authorization: auth(acct.apiKeySid, acct.apiKeySecret) },
      },
    );
    expect(viaKey.status).toBe(200);
  });

  it('goes on to the next verb after a dial with no action, whatever its outcome', async () => {
    for (const answer of ['answered', 'no-answer']) {
      const r = await callThrough(twilio, { tenant: 'acme', from: '+12505550180', answer, ringMs: 0 });
      expect(r.steps).toContain('say: After the dial.');
      expect(r.steps).toContain('hung up');
    }
  });

  it('keeps a call ringing until the caller hangs up, then cancels the dial', async () => {
    const r = (await twilio.inbound('call', { tenant: 'acme', from: '+12505550179', hold: true })) as {
      call: string;
      status: string;
    };
    expect(r.status).toBe('ringing');
    await new Promise((x) => setTimeout(x, 150));
    expect(
      hooks.some((h) => h.params.get('CallSid') === r.call && h.path.startsWith('/hooks/voice-dial')),
    ).toBe(false);
    await twilio.inbound('hangup', { call: r.call });
    const dial = await waitFor(() =>
      hooks.find((h) => h.params.get('CallSid') === r.call && h.path.startsWith('/hooks/voice-dial')),
    );
    expect(dial.params.get('DialCallStatus')).toBe('canceled');
    const end = await waitFor(() =>
      hooks.find((h) => h.params.get('CallSid') === r.call && h.path === '/hooks/voice-status'),
    );
    expect(end.params.get('CallStatus')).toBe('completed');
  });
});
