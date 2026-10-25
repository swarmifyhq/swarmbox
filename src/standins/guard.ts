// The production guard (docs/standins.md, Security): a product calls this as it starts in production, so nothing a
// stand-in issued, and no address only a world uses, can ever be accepted there. Cheap, and it never reads more
// than the environment it is given.

import { HEX_MARK, MARK } from './protocol.ts';
import { FICTIONAL_PHONE } from './shape.ts';

export interface StandInLeak {
  variable: string;
  why: string;
}

/** A variable that names where something is: a provider's address. */
const ADDRESS_VAR = /(?:_URL|_URI|_HOST|_ENDPOINT|_BASE|_ORIGIN|_ADDR|_ADDRESS)$/i;

/** Whether a host name is this machine, however it's written. */
export function isThisMachine(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) return isThisMachine(mapped[1]!);
  // IPv4, including shorthand (127.1) and a single number (2130706433): Node's URL parser reads them as the
  // browser does, so ask it.
  let v4: string;
  try {
    v4 = new URL(`http://${h}/`).hostname;
  } catch {
    return false;
  }
  return /^127\.\d+\.\d+\.\d+$/.test(v4) || v4 === '0.0.0.0';
}

/** The host a value points at, if it is an address: a URL (any scheme, with or without userinfo), or host:port. */
function hostOf(value: string): string | null {
  const v = value.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return new URL(v).hostname;
  } catch {
    return null;
  }
  const bare = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+)(?::\d+)?(?:\/.*)?$/.exec(v);
  return bare ? bare[1]! : null;
}

/** What in this environment came from a stand-in or points at one. Values are never repeated, only named. */
export function standInLeaks(env: Record<string, string | undefined>): StandInLeak[] {
  const leaks: StandInLeak[] = [];
  for (const [variable, value] of Object.entries(env)) {
    if (!value) continue;
    const lower = value.toLowerCase();
    if (variable === 'NODE_EXTRA_CA_CERTS' && lower.includes(MARK))
      leaks.push({ variable, why: 'Swarmbox’s local certificate authority' });
    else if (lower.includes(MARK)) leaks.push({ variable, why: 'a stand-in credential' });
    else if (lower.includes(HEX_MARK)) leaks.push({ variable, why: 'a stand-in id' });
    else if (FICTIONAL_PHONE.test(value.trim())) leaks.push({ variable, why: 'a fictional 555-01xx number' });
    else if (ADDRESS_VAR.test(variable)) {
      const host = hostOf(value);
      if (host && isThisMachine(host)) leaks.push({ variable, why: 'an address on this machine' });
    }
  }
  return leaks;
}

/**
 * Refuse to start production with anything from a stand-in. `allowLoopback` names variables that may point at this
 * machine in production (a sidecar the product really runs, a local database socket).
 */
export function assertNoStandins(
  env: Record<string, string | undefined> = process.env,
  options: { allowLoopback?: string[] } = {},
): void {
  const leaks = standInLeaks(env).filter(
    (l) => !(l.why === 'an address on this machine' && options.allowLoopback?.includes(l.variable)),
  );
  if (leaks.length)
    throw new Error(
      `Refusing to start: ${leaks.map((l) => `${l.variable} is ${l.why}`).join('; ')}. ` +
        'These belong to a Swarmbox world, never to production.',
    );
}
