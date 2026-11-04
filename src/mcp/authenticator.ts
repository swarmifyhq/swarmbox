// The authenticator app on a person's phone: a TOTP code (RFC 6238) from the key a product's two-step setup
// shows, at the world's own time, since that's the clock the product checks it against. Without it an agent
// can't turn two-step sign-in on, or play anything a product puts behind it.

import { createHmac } from 'node:crypto';

export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpKey {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: Algorithm;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, as a setup screen shows it: any case, spaces and dashes between groups, padding optional. */
export function base32Decode(text: string): Buffer {
  const clean = text
    .replace(/[\s-]+/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('the key isn’t base32 (letters A–Z and digits 2–7)');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A key as typed into the app: the base32 secret alone, or the otpauth:// link a QR code holds. */
export function parseKey(input: string): TotpKey {
  const given = input.trim();
  if (!given.toLowerCase().startsWith('otpauth://'))
    return { secret: base32Decode(given), digits: 6, period: 30, algorithm: 'SHA1' };
  const url = new URL(given);
  if (url.host.toLowerCase() !== 'totp') throw new Error(`an otpauth link for ${url.host}, not totp`);
  const q = url.searchParams;
  const secret = q.get('secret');
  if (!secret) throw new Error('the otpauth link has no secret');
  const digits = Number(q.get('digits') ?? 6);
  const period = Number(q.get('period') ?? 30);
  const algorithm = (q.get('algorithm') ?? 'SHA1').toUpperCase();
  if (![6, 7, 8].includes(digits)) throw new Error(`digits ${digits}: an app shows 6, 7 or 8`);
  if (!Number.isInteger(period) || period < 1) throw new Error(`period ${q.get('period')}: whole seconds`);
  if (algorithm !== 'SHA1' && algorithm !== 'SHA256' && algorithm !== 'SHA512')
    throw new Error(`algorithm ${algorithm}: SHA1, SHA256 or SHA512`);
  return { secret: base32Decode(secret), digits, period, algorithm };
}

/** The code at an instant (ms), and how many seconds it has left. */
export function totp(key: TotpKey, atMs: number): { code: string; secondsLeft: number } {
  const step = Math.floor(atMs / 1000 / key.period);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac(key.algorithm.toLowerCase(), key.secret).update(counter).digest();
  const at = mac[mac.length - 1]! & 0x0f;
  const n = mac.readUInt32BE(at) & 0x7fffffff;
  return {
    code: String(n % 10 ** key.digits).padStart(key.digits, '0'),
    secondsLeft: key.period - (Math.floor(atMs / 1000) % key.period),
  };
}
