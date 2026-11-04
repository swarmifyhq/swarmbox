// The phone's authenticator app, checked against RFC 6238's own test values.

import { describe, expect, it } from 'vitest';
import { base32Decode, parseKey, totp } from '../../src/mcp/authenticator.ts';

// RFC 6238 appendix B: the ASCII seeds "1234567890" repeated to 20, 32 and 64 bytes, as base32.
const SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SHA512 =
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';
const link = (secret: string, algorithm: string) =>
  `otpauth://totp/Example:ann@example.test?secret=${secret}&issuer=Example&algorithm=${algorithm}&digits=8&period=30`;

describe('the authenticator', () => {
  it('gives RFC 6238’s codes', () => {
    const cases: [number, string, string, string][] = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1234567890, '89005924', '91819424', '93441116'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [t, a, b, c] of cases) {
      expect(totp(parseKey(link(SHA1, 'SHA1')), t * 1000).code).toBe(a);
      expect(totp(parseKey(link(SHA256, 'SHA256')), t * 1000).code).toBe(b);
      expect(totp(parseKey(link(SHA512, 'SHA512')), t * 1000).code).toBe(c);
    }
  });

  it('reads a bare key as a setup screen shows it: grouped, any case, six digits every 30 s', () => {
    const grouped = SHA1.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(totp(parseKey(grouped), 59_000)).toEqual({ code: '287082', secondsLeft: 1 });
    expect(totp(parseKey(SHA1), 60_000).secondsLeft).toBe(30);
  });

  it('refuses what an app would refuse, and says why', () => {
    expect(() => base32Decode('not a key!')).toThrow(/base32/);
    expect(() => parseKey('otpauth://hotp/x?secret=GEZA')).toThrow(/not totp/);
    expect(() => parseKey('otpauth://totp/x?issuer=X')).toThrow(/no secret/);
    expect(() => parseKey(`otpauth://totp/x?secret=${SHA1}&algorithm=MD5`)).toThrow(/MD5/);
  });
});
