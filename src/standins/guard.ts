// The production guard (docs/standins.md, Security): a product calls this as it starts in production, so nothing a
// stand-in issued, and no address only a world uses, can ever be accepted there. Cheap, and it never reads more
// than the environment it is given.

import { HEX_MARK, MARK } from './protocol.ts';

export interface StandInLeak {
  variable: string;
  why: string;
}

const LOOPBACK = /^(?:https?:\/\/)?(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(?::\d+)?(?:\/|$)/i;

/** What in this environment came from a stand-in or points at one. Values are never repeated, only named. */
export function standInLeaks(env: Record<string, string | undefined>): StandInLeak[] {
  const leaks: StandInLeak[] = [];
  for (const [variable, value] of Object.entries(env)) {
    if (!value) continue;
    if (value.toLowerCase().includes(MARK)) leaks.push({ variable, why: 'a stand-in credential' });
    else if (value.toLowerCase().includes(HEX_MARK)) leaks.push({ variable, why: 'a stand-in id' });
    else if (
      /(_URL|_HOST|_ENDPOINT|_BASE)$/i.test(variable) &&
      LOOPBACK.test(value) &&
      /^[A-Z0-9_]+$/.test(variable)
    )
      leaks.push({ variable, why: 'a provider address on this machine' });
    else if (variable === 'NODE_EXTRA_CA_CERTS' && /swarmbox/i.test(value))
      leaks.push({ variable, why: 'Swarmbox’s local certificate authority' });
  }
  return leaks;
}

/**
 * Refuse to start production with anything from a stand-in. `allowLoopback` names variables that may point at this
 * machine in production (a sidecar the product really runs, a database socket).
 */
export function assertNoStandins(
  env: Record<string, string | undefined> = process.env,
  options: { allowLoopback?: string[] } = {},
): void {
  const leaks = standInLeaks(env).filter(
    (l) => !(l.why === 'a provider address on this machine' && options.allowLoopback?.includes(l.variable)),
  );
  if (leaks.length)
    throw new Error(
      `Refusing to start: ${leaks.map((l) => `${l.variable} is ${l.why}`).join('; ')}. ` +
        'These belong to a Swarmbox world, never to production.',
    );
}
