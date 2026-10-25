// What Swarmbox and a stand-in say to each other: one JSON message per line on the stand-in's stdin and stdout
// (docs/standins.md, A stand-in's process). Bodies are base64, so any bytes go through.

import type { Behaviour } from './manifest.ts';

/**
 * How a credential shows it came from a stand-in, so a product's production guard can refuse it. Free-text formats
 * carry the word; formats that allow only hex (a Twilio AccountSid) carry the hex mark.
 */
export const MARK = 'swarmbox';
export const HEX_MARK = 'c0ffee5b';

export interface ClockState {
  at: string;
  paused: boolean;
}

/** A behaviour applied to the next `count` matching calls (all of them when count is absent). */
export interface Rule {
  id: string;
  behaviour: Behaviour;
  match?: { operation?: string; tenant?: string; target?: string };
  count?: number;
  param?: Record<string, unknown>;
}

export interface WireRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /** base64 */
  body: string;
}

export interface WireResponse {
  status: number;
  headers?: Record<string, string>;
  /** base64 */
  body?: string;
}

/** Swarmbox to the stand-in. */
export type ToStandIn =
  /** origin: the stand-in's own address, http://127.0.0.1:<port>, for links it gives out (a recording's URL). */
  | { type: 'start'; baseDomain: string; clock: ClockState | null; tmp: string; origin: string }
  | ({
      type: 'request';
      id: string;
      operation: string | null;
      params: Record<string, string>;
      tenant: string | null;
    } & WireRequest)
  /** settings: what a person sets in the provider's console for this account (a number's webhook addresses). */
  | { type: 'account'; id: string; tenant: string; settings: Record<string, string> }
  | { type: 'behave'; id: string; rule: Rule }
  | { type: 'unbehave'; id: string; ruleId: string | null }
  | { type: 'inbound'; id: string; kind: string; body: Record<string, unknown> }
  | { type: 'clock'; clock: ClockState }
  | { type: 'reset'; id: string }
  /** The product's answer to a webhook: its status, type and body (base64, at most 1 MB), e.g. TwiML. */
  | { type: 'delivered'; id: string; status: number; contentType: string; body: string };

/** The stand-in to Swarmbox. */
export type FromStandIn =
  | { type: 'ready' }
  | ({ type: 'response'; id: string } & WireResponse)
  | { type: 'result'; id: string; ok: true; value?: unknown }
  | { type: 'result'; id: string; ok: false; error: string }
  | {
      type: 'deliver';
      id: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    };

export const encode = (b: Buffer | string | undefined): string =>
  b === undefined ? '' : (typeof b === 'string' ? Buffer.from(b) : b).toString('base64');
export const decode = (s: string | undefined): Buffer => Buffer.from(s ?? '', 'base64');
