// What a screen asked its servers for, newest last: method, address, status, how long it took, and the start of
// what was sent and what came back. The readout after an action names refusals in one line; this is where the
// agent reads the rest of them, and sees what a page keeps open (a live stream) or keeps asking for (polling).
//
// Nothing secret is kept: no headers at all (cookies, authorization), and in addresses and bodies any value
// whose name says it is a secret, and any value shaped like a token, is replaced before it is stored (redact.ts).

import type { Request as PwRequest, Response as PwResponse } from 'playwright-core';
import { redactBody, redactUrl } from './redact.ts';

export { redactBody, redactUrl };

export interface RequestRecord {
  /** Counts the screen's requests from 1, so a later read can ask for what came after. */
  seq: number;
  at: string;
  method: string;
  /** Path and query on the screen's own origin; the whole address elsewhere. Secrets redacted. */
  url: string;
  /** Playwright's resource type: document, fetch, xhr, eventsource, websocket, script, image… */
  type: string;
  state: 'open' | 'done' | 'failed';
  /** Once the response's headers arrive. */
  status?: number;
  /** To the response's headers, then to its end (or failure). */
  ms?: number;
  failure?: string;
  contentType?: string;
  sent?: string;
  got?: string;
}

/** Kept per screen; the oldest go first. */
export const REQUESTS_KEPT = 300;
/** Of each body, kept and shown. */
export const BODY_KEPT = 2000;

/** Loaded with the page, not asked for by it: left out unless every request is wanted. */
const ASSETS = new Set(['image', 'font', 'stylesheet', 'script', 'media', 'manifest', 'texttrack', 'other']);
/** Bodies worth reading back: what an app's own calls answer with. */
const READ_BODY = new Set(['fetch', 'xhr', 'document']);

function bounded(s: string): string {
  return s.length > BODY_KEPT ? `${s.slice(0, BODY_KEPT)}… (${s.length} characters)` : s;
}

function mainFrame(r: PwRequest): boolean {
  try {
    return r.frame().parentFrame() === null;
  } catch {
    // A service worker's request has no frame.
    return false;
  }
}

export interface RequestLog {
  records: RequestRecord[];
  /** The record a response belongs to, for the readout's refusal lines. */
  seqOf(r: PwRequest): number | undefined;
  onRequest(r: PwRequest): void;
  onResponse(r: PwResponse): void;
  onFinished(r: PwRequest): Promise<void>;
  onFailed(r: PwRequest): void;
}

/** A screen's log; `origin` is its own, whose addresses are shown as paths. */
export function requestLog(origin: string): RequestLog {
  const records: RequestRecord[] = [];
  const live = new WeakMap<PwRequest, { rec: RequestRecord; started: number }>();
  let seq = 0;
  return {
    records,
    seqOf: (r) => live.get(r)?.rec.seq,
    onRequest(r) {
      // A page load ends what the page before it had open (a live stream, a long poll), and Chromium reports
      // no end for a response it had already started streaming.
      if (r.isNavigationRequest() && mainFrame(r))
        for (const rec of records)
          if (rec.state === 'open') {
            rec.state = 'failed';
            rec.failure = 'cut off by a page load';
            rec.ms = Date.now() - Date.parse(rec.at);
          }
      const contentType = r.headers()['content-type'];
      const post = r.postData();
      const rec: RequestRecord = {
        seq: ++seq,
        at: new Date().toISOString(),
        method: r.method(),
        url: redactUrl(r.url(), origin),
        type: r.resourceType(),
        state: 'open',
        ...(post ? { sent: bounded(redactBody(post, contentType)) } : {}),
      };
      live.set(r, { rec, started: Date.now() });
      records.push(rec);
      if (records.length > REQUESTS_KEPT) records.shift();
    },
    onResponse(r) {
      const it = live.get(r.request());
      if (!it) return;
      it.rec.status = r.status();
      it.rec.ms = Date.now() - it.started;
      const ct = r.headers()['content-type'];
      if (ct) it.rec.contentType = ct.split(';')[0]!.trim();
    },
    async onFinished(r) {
      const it = live.get(r);
      if (!it) return;
      it.rec.state = 'done';
      it.rec.ms = Date.now() - it.started;
      const res = await r.response().catch(() => null);
      const ct = it.rec.contentType ?? '';
      if (!res || !READ_BODY.has(it.rec.type) || !/json|text|xml|javascript|x-component/.test(ct)) return;
      // A page the app was sent to is the screen itself: screen_read shows it better.
      if (it.rec.type === 'document' && res.status() < 400) return;
      const body = await res.text().catch(() => null);
      if (body) it.rec.got = bounded(redactBody(body, ct));
    },
    onFailed(r) {
      const it = live.get(r);
      if (!it) return;
      it.rec.state = 'failed';
      it.rec.ms = Date.now() - it.started;
      it.rec.failure = r.failure()?.errorText ?? 'failed';
    },
  };
}

export interface RequestQuery {
  /** Only addresses containing this (case-insensitive). */
  match?: string;
  /** Only those after this seq. */
  after?: number;
  /** Pages' scripts, styles, images and fonts too. */
  all?: boolean;
  /** What was sent and what came back, not only the lines. */
  bodies?: boolean;
  limit?: number;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** One request as the agent reads it. */
export function requestLine(r: RequestRecord, now = Date.now(), bodies = false): string {
  const time = r.at.slice(11, 23);
  const result =
    r.state === 'failed'
      ? `failed: ${r.failure} (${seconds(r.ms ?? 0)})`
      : r.state === 'open'
        ? `${r.status ?? '…'} open for ${seconds(now - Date.parse(r.at))}`
        : `${r.status} (${seconds(r.ms ?? 0)})`;
  const kind = r.type === 'fetch' || r.type === 'xhr' ? '' : ` ${r.type}`;
  const lines = [`#${r.seq} ${time} ${r.method} ${r.url} → ${result}${kind}`];
  if (bodies && r.sent) lines.push(`    sent: ${r.sent}`);
  if (bodies && r.got) lines.push(`    got: ${r.got}`);
  return lines.join('\n');
}

/** The records a query asks for, newest last, at most `limit` (the most recent). */
export function selectRequests(records: RequestRecord[], q: RequestQuery = {}): RequestRecord[] {
  const match = q.match?.toLowerCase();
  const picked = records.filter(
    (r) =>
      (q.all || !ASSETS.has(r.type)) &&
      (q.after === undefined || r.seq > q.after) &&
      (!match || r.url.toLowerCase().includes(match)),
  );
  return picked.slice(-(q.limit ?? 40));
}
