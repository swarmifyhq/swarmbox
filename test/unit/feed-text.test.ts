// feed_read's and phone_inbox's lines: a message whole, a long feed line cut only with a mark that says so
// (Flowology QA-1294: an invitation email cut at "Once", read as its end).

import { describe, expect, it } from 'vitest';
import { FEED_LINE_CHARS, feedText } from '../../src/mcp/feed-text.ts';

const sentence = 'Your company requires two-step sign-in: set it up within 7 days of your first sign-in.';
const invite = {
  cursor: '8103:12',
  kind: 'message',
  at: '2026-12-02T22:18:38.235Z',
  sentAs: 'the platform',
  to: 'pat@example.test',
  text: `You’re invited.\n\n${'Open this link, then press Email me a code. '.repeat(10)}Once you’re in, add a password.\n\n${sentence}`,
};
const page = { items: [invite], next: 'n1', lagMs: 0 };

describe('feedText', () => {
  it('shows a message whole when no cut is asked for, as phone_inbox does', () => {
    const out = feedText(page);
    expect(out).toContain('1 items; next n1; lag 0 ms');
    expect(out).toContain(sentence);
    expect(out).not.toContain('(cut:');
    expect(out).toContain('[8103:12]');
  });

  it('cuts a long feed line only with a mark saying how much is left and how to see it', () => {
    const out = feedText(page, { clipAt: FEED_LINE_CHARS, whole: 'whole: true shows it all' });
    expect(out).not.toContain(sentence);
    const left =
      JSON.stringify({ sentAs: invite.sentAs, to: invite.to, text: invite.text }).length - FEED_LINE_CHARS;
    expect(out).toContain(`… (cut: ${left} more characters; whole: true shows it all)  [8103:12]`);
  });

  it('leaves a short line alone under a cut', () => {
    const out = feedText(
      { items: [{ cursor: '1', kind: 'sms', at: 'x', text: 'On my way' }], next: 'n', lagMs: 3 },
      { clipAt: FEED_LINE_CHARS },
    );
    expect(out).toContain('{"text":"On my way"}  [1]');
    expect(out).not.toContain('(cut:');
  });
});
