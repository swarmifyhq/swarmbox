// How feed_read and phone_inbox print a page of items: one line each, the item as JSON. A message is shown
// whole, since it is what the person reads; a feed line may be cut to keep a long page readable, and then it
// says so. Cut silently, an email read as ending mid-sentence (Flowology QA-1294: an invitation's two-factor
// sentence came after the cut, and the tester said it couldn't be read).

export type Page = { items: Record<string, unknown>[]; next: string; lagMs: number };

/** Characters of an item's JSON a feed line keeps before cutting it. */
export const FEED_LINE_CHARS = 400;

export function feedText(p: Page, opts: { clipAt?: number; whole?: string } = {}): string {
  const { clipAt } = opts;
  return [
    `${p.items.length} items; next ${p.next}; lag ${p.lagMs} ms`,
    ...p.items.map((i) => {
      const { cursor, kind, at, ...rest } = i;
      const json = JSON.stringify(rest);
      const shown =
        clipAt !== undefined && json.length > clipAt
          ? `${json.slice(0, clipAt)}… (cut: ${json.length - clipAt} more characters${opts.whole ? `; ${opts.whole}` : ''})`
          : json;
      return `${String(at)}  ${String(kind).padEnd(8)} ${shown}  [${String(cursor)}]`;
    }),
  ].join('\n');
}
