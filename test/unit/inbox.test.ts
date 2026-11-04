// phone_inbox's two mailboxes: a tenant's own messages to a person, and what the product sent them as itself
// (Flowology QA-793: a sign-in code filed under the platform, so the tester never found it).

import { describe, expect, it } from 'vitest';
import type { FeedItem, FeedPage, Hooks } from '../../src/hooks.ts';
import { joinCursor, readInbox, splitCursor } from '../../src/mcp/inbox.ts';

const mail: Record<string, FeedItem[]> = {
  north: [
    {
      cursor: '1',
      kind: 'email',
      at: '2026-11-02T10:00:00Z',
      to: 'ann@example.test',
      subject: 'Your estimate',
    },
    {
      cursor: '4',
      kind: 'email',
      at: '2026-11-02T10:05:00Z',
      to: 'ann@example.test',
      subject: 'Your invoice',
    },
  ],
  _platform: [
    { cursor: 'p7', kind: 'email', at: '2026-11-02T10:02:00Z', to: 'ann@example.test', subject: 'Your code' },
  ],
};
const asked: { company: string; after?: string }[] = [];
const hooks: Pick<Hooks, 'messages'> = {
  messages: (company, to, opts = {}) => {
    asked.push({ company, ...(opts.after ? { after: opts.after } : {}) });
    if (company === 'locked') return Promise.reject(new Error('GET /messages: 403 forbidden'));
    const all = (mail[company] ?? []).filter((m) => m.to === to);
    const items = opts.after ? all.slice(all.findIndex((m) => m.cursor === opts.after) + 1) : all;
    return Promise.resolve<FeedPage>({ items, next: items.at(-1)?.cursor ?? opts.after ?? '0', lagMs: 3 });
  },
};

describe('phone_inbox with a platform mailbox', () => {
  it('reads the tenant’s and the platform’s mail, in time order, the platform’s marked', async () => {
    const page = await readInbox(hooks, 'north', 'ann@example.test', undefined, '_platform');
    expect(page.items.map((i) => i.subject)).toEqual(['Your estimate', 'Your code', 'Your invoice']);
    expect(page.items[1]!.sentAs).toBe('the platform');
    expect(page.items[0]!.sentAs).toBeUndefined();
    expect(splitCursor(page.next)).toEqual({ own: '4', platform: 'p7' });
  });

  it('reads on from a joined cursor, each mailbox from its own place', async () => {
    asked.length = 0;
    const page = await readInbox(hooks, 'north', 'ann@example.test', joinCursor('1', 'p7'), '_platform');
    expect(asked).toEqual([
      { company: 'north', after: '1' },
      { company: '_platform', after: 'p7' },
    ]);
    expect(page.items.map((i) => i.subject)).toEqual(['Your invoice']);
  });

  it('takes a product’s own cursor as the tenant’s, from a read before there were two', () => {
    expect(splitCursor('4')).toEqual({ own: '4' });
    expect(splitCursor('both:not-json')).toEqual({ own: 'both:not-json' });
  });

  it('reads one mailbox when the product has no platform mailbox, or when it is the one asked for', async () => {
    asked.length = 0;
    const plain = await readInbox(hooks, 'north', 'ann@example.test', undefined, undefined);
    const platform = await readInbox(hooks, '_platform', 'ann@example.test', undefined, '_platform');
    expect(asked.map((a) => a.company)).toEqual(['north', '_platform']);
    expect(plain.next).toBe('4');
    expect(platform.items.map((i) => i.subject)).toEqual(['Your code']);
  });

  it('keeps the tenant’s mail, and says why, when the platform mailbox can’t be read', async () => {
    const page = await readInbox(hooks, 'north', 'ann@example.test', undefined, 'locked');
    expect(page.items).toHaveLength(2);
    expect(page.note).toBe('the platform mailbox (locked) wasn’t read: GET /messages: 403 forbidden');
  });
});
