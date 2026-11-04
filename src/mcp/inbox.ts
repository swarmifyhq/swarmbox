// One person's inbox, as phone_inbox gives it: the tenant's own messages to them, and the ones the product
// sends as itself (sign-in codes, invites, sign-up confirmations), which a product files under its platform
// mailbox, not under any tenant. Read apart, a tester looking in the company's mailbox finds no code and
// says it never came, though it was sent.

import type { FeedItem, FeedPage, Hooks } from '../hooks.ts';

const BOTH = 'both:';

/** One cursor for the two mailboxes, as `next`: each one's own, kept apart. */
export function joinCursor(own: string, platform: string): string {
  return BOTH + Buffer.from(JSON.stringify([own, platform])).toString('base64url');
}

/** The two cursors a joined one holds. A product's own cursor (from before the merge) is the tenant's. */
export function splitCursor(after: string | undefined): { own?: string; platform?: string } {
  if (!after) return {};
  if (!after.startsWith(BOTH)) return { own: after };
  try {
    const [own, platform] = JSON.parse(Buffer.from(after.slice(BOTH.length), 'base64url').toString()) as [
      string,
      string,
    ];
    return { ...(own ? { own } : {}), ...(platform ? { platform } : {}) };
  } catch {
    return { own: after };
  }
}

/** A platform message, marked so the agent reads who sent it. */
const asPlatform = ({ cursor, kind, at, ...rest }: FeedItem): FeedItem => ({
  cursor,
  kind,
  at,
  sentAs: 'the platform',
  ...rest,
});

/**
 * The tenant's messages to `to`, and the platform mailbox's when the product has one, in time order. A platform
 * mailbox the product refuses to read leaves the tenant's messages, with a note saying why.
 */
export async function readInbox(
  hooks: Pick<Hooks, 'messages'>,
  tenant: string,
  to: string,
  after: string | undefined,
  platformMailbox: string | undefined,
): Promise<FeedPage & { note?: string }> {
  const at = splitCursor(after);
  const own = await hooks.messages(tenant, to, at.own ? { after: at.own } : {});
  if (!platformMailbox || platformMailbox === tenant) return own;
  let platform: FeedPage;
  try {
    platform = await hooks.messages(platformMailbox, to, at.platform ? { after: at.platform } : {});
  } catch (e) {
    return { ...own, note: `the platform mailbox (${platformMailbox}) wasn’t read: ${(e as Error).message}` };
  }
  const items = [...own.items, ...platform.items.map(asPlatform)].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  return {
    items,
    next: joinCursor(own.next, platform.next),
    lagMs: Math.max(own.lagMs, platform.lagMs),
  };
}
