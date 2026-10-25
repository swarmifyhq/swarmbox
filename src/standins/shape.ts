// Everything a stand-in hands back is untrusted: it may be written to steer the agent, or to break Swarmbox. These
// shape it before it goes anywhere, into a credential, a tool's answer or an error message: what doesn't fit is
// cut, refused or replaced, never passed on as it came.

import { HEX_MARK, MARK } from './protocol.ts';

/** One line of plain words, cut to `max`: for an error or a label from a stand-in. */
export function plain(value: unknown, max = 200): string {
  const s = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[^\p{L}\p{N} .,:;()/'"+&@_=?#%[\]-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,256}$/;
/** 555-0100 to 555-0199: the North American numbers kept for fiction, so a stand-in's phone marks itself. */
export const FICTIONAL_PHONE = /^\+1\d{3}55501\d{2}$/;

/**
 * A stand-in's account, checked: plain keys, printable values with no spaces, every id and secret marked, every
 * phone fictional and every email on swarmbox.invalid. A stand-in can't hand out a credential that would pass for a
 * real one in production.
 */
export function shapeAccount(
  value: unknown,
  fields: Record<string, 'id' | 'secret' | 'phone' | 'email' | 'text'>,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('an account is an object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new Error('an account has at most 20 fields');
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!KEY.test(k)) throw new Error('an account field name must be a plain identifier');
    if (typeof v !== 'string' || !CREDENTIAL.test(v))
      throw new Error(`account field ${k} must be printable text without spaces, up to 256 characters`);
    const kind = fields[k];
    const marked = v.toLowerCase().includes(MARK) || v.toLowerCase().includes(HEX_MARK);
    if ((kind === 'id' || kind === 'secret' || kind === 'text' || kind === undefined) && !marked)
      throw new Error(`account field ${k} is not marked as a stand-in's`);
    if (kind === 'phone' && !FICTIONAL_PHONE.test(v))
      throw new Error(`account field ${k} is not a fictional number`);
    if (kind === 'email' && !v.toLowerCase().endsWith(`@${MARK}.invalid`))
      throw new Error(`account field ${k} is not on ${MARK}.invalid`);
    out[k] = v;
  }
  for (const k of Object.keys(fields)) if (!(k in out)) throw new Error(`the account has no ${k}`);
  return out;
}

/**
 * Data from a stand-in for the agent to read (an inbound's result): plain JSON, at most four levels deep, short
 * arrays and identifier keys, every string made plain and cut. Anything else is dropped.
 */
export function shapeData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return plain(value, 500);
  if (depth >= 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => shapeData(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50))
      if (KEY.test(k)) out[k] = shapeData(v, depth + 1);
    return out;
  }
  return null;
}

/** A behaviour's param: at most ten plain keys, each a number, a boolean, or a string of 200 characters at most. */
export function shapeParam(param: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(param).slice(0, 10)) {
    if (!KEY.test(k)) throw new Error('a behaviour param name must be a plain identifier');
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 200) out[k] = v;
    else
      throw new Error(`behaviour param ${k} must be a number, a boolean, or text of 200 characters at most`);
  }
  return out;
}

/** Real-looking live credentials: a stand-in refuses a request carrying one, and never logs it. */
export const LIVE_CREDENTIAL = /\b(?:sk|rk|pk)_live_[0-9A-Za-z]{8,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'te',
  'trailer',
]);

/** Headers a stand-in answers with: valid names, no line breaks, nothing that frames the connection. */
export function shapeHeaders(headers: unknown, allow?: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>).slice(0, 50)) {
    const name = k.toLowerCase();
    if (!HEADER_NAME.test(name) || HOP_BY_HOP.has(name)) continue;
    if (allow && !allow(name)) continue;
    if (typeof v !== 'string' || v.length > 4096 || /[\r\n\0]/.test(v)) continue;
    out[name] = v;
  }
  return out;
}

export const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
