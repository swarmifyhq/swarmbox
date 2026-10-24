// What an agent needs to see on a screen that a person sees at a glance (on the first long run, a "Send
// estimate" dialog was open the whole time and the agent never knew).
//
// A screen is read as its accessibility tree, cut at a limit. Apps draw their dialogs at the end of the
// page, so on a long page the one thing a person can use, the open dialog, was what got cut. Here:
// open dialogs come first and whole; an action says what it changed (a dialog opened or closed, a status
// line, the address); a click that can't land says what is in the way; and when two controls share a name,
// the one in the open dialog is the one meant.

import type { Locator, Page } from 'playwright-core';

/** Dialogs, open and showing: `<dialog open>` and anything with a dialog role. */
const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"]';
/** What a page says without being asked: status lines, alerts, live regions. */
const LIVE = '[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"], output';
/** A whole dialog is kept even on a long page; past this it is cut, and says so. */
const DIALOG_LIMIT = 20_000;

export interface OpenDialog {
  title: string;
  /** Modal: everything behind it is out of reach until it closes. */
  modal: boolean;
  /** Its accessibility tree, as a read shows a page. */
  tree: string;
}

interface DialogInfo {
  title: string;
  modal: boolean;
  visible: boolean;
}

/** In the page: a dialog's name as a person would say it, and whether it holds the screen. */
function describeDialogs(els: Element[]): DialogInfo[] {
  const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return els.map((el) => {
    const labelled = el.getAttribute('aria-labelledby');
    const byId = labelled
      ? labelled
          .split(/\s+/)
          .map((id) => text(document.getElementById(id)))
          .join(' ')
          .trim()
      : '';
    const heading = el.querySelector('h1, h2, h3, h4, [role="heading"]');
    const title = el.getAttribute('aria-label') || byId || text(heading) || text(el).slice(0, 60);
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      title,
      modal: el.matches(':modal') || el.getAttribute('aria-modal') === 'true',
      visible: style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0,
    };
  });
}

/**
 * The dialogs a person can see, the ones holding the screen first, the most recently opened (latest in
 * the page) first among those.
 */
export async function openDialogs(page: Page): Promise<OpenDialog[]> {
  const all = page.locator(DIALOGS);
  const info = await all.evaluateAll(describeDialogs);
  const shown = info.map((d, i) => ({ ...d, i })).filter((d) => d.visible);
  // A dialog inside another (a confirm inside a drawer) shows in its parent's tree too; that's fine.
  shown.sort((a, b) => Number(b.modal) - Number(a.modal) || b.i - a.i);
  const out: OpenDialog[] = [];
  for (const d of shown) {
    const tree = await all
      .nth(d.i)
      .ariaSnapshot({ timeout: 5_000 })
      .catch(() => '');
    out.push({
      title: d.title,
      modal: d.modal,
      tree:
        tree.length > DIALOG_LIMIT
          ? `${tree.slice(0, DIALOG_LIMIT)}\n… (${tree.length - DIALOG_LIMIT} more characters)`
          : tree,
    });
  }
  return out;
}

/** The dialogs, written for the top of a read: what can be used right now. */
export function dialogsText(dialogs: OpenDialog[]): string {
  if (!dialogs.length) return '';
  const modal = dialogs.find((d) => d.modal);
  const lines = dialogs.map((d) => {
    const head =
      d === modal
        ? `OPEN DIALOG "${d.title}" (modal: only this can be used until it closes)`
        : `open ${d.modal ? 'modal dialog' : 'panel'} "${d.title}"`;
    return `${head}\n${d.tree}`;
  });
  return `${lines.join('\n')}\n--- the page${modal ? ' behind it' : ''} ---`;
}

/** What a screen looks like at a glance: enough to say afterwards what an action changed. */
export interface Glance {
  url: string;
  dialogs: string[];
  /** Visible status and alert text. */
  said: string[];
}

export async function glance(page: Page): Promise<Glance> {
  const [info, said] = await Promise.all([
    page.locator(DIALOGS).evaluateAll(describeDialogs),
    page.locator(LIVE).evaluateAll((els) =>
      els
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden';
        })
        // innerText, as laid out: textContent runs "1:05 p.m." into the next line's "Lakeside".
        .map((e) => ((e as HTMLElement).innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0),
    ),
  ]);
  return {
    url: page.url(),
    dialogs: info.filter((d) => d.visible).map((d) => (d.modal ? `${d.title} (modal)` : d.title)),
    said: [...new Set(said)].map((t) => (t.length > 200 ? `${t.slice(0, 200)}…` : t)),
  };
}

/** Lines saying what moved between two glances; empty when nothing a person would notice did. */
export function changes(before: Glance, after: Glance): string[] {
  const lines: string[] = [];
  const gone = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  for (const d of gone(after.dialogs, before.dialogs)) lines.push(`dialog opened: "${d}"`);
  for (const d of gone(before.dialogs, after.dialogs)) lines.push(`dialog closed: "${d}"`);
  for (const t of gone(after.said, before.said)) lines.push(`says: "${t}"`);
  if (before.url !== after.url) lines.push(`address: ${pathOf(before.url)} → ${pathOf(after.url)}`);
  return lines;
}

/** A web address without its origin, which never changes on a screen; anything else as it is. */
const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? `${x.pathname}${x.search}${x.hash}` : u;
  } catch {
    return u;
  }
};

/**
 * Of several controls an action's words match, the one meant: the only one in the dialog in front.
 * Dialogs stack (a job's panel, then "Send estimate" over it), and only the one in front can be used:
 * the innermost of the open modal ones, the latest opened among equals. Null when that doesn't settle
 * it, with each match described for the agent to pick by index.
 */
export async function pickAmong(
  matches: Locator,
  count: number,
): Promise<{ index: number; why: string } | { index: null; described: string[] }> {
  const { top, info } = await matches.evaluateAll((els) => {
    // Repeated in behindModal: a function handed to the page can't call one of ours.
    const name = (d: Element) =>
      d.getAttribute('aria-label') ||
      (d.querySelector('h1, h2, h3, h4, [role="heading"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const modals = [...document.querySelectorAll('dialog, [aria-modal="true"]')].filter(
      (d) => d.matches(':modal') || d.getAttribute('aria-modal') === 'true',
    );
    const front = modals.filter((m) => !modals.some((o) => o !== m && m.contains(o))).at(-1) ?? null;
    return {
      top: front ? name(front) : null,
      info: els.map((el) => {
        const d = el.closest('dialog, [role="dialog"], [role="alertdialog"]');
        const b = el.getBoundingClientRect();
        return {
          dialog: d ? name(d) : null,
          inFront: Boolean(front?.contains(el)),
          visible: b.width > 0 && b.height > 0,
        };
      }),
    };
  });
  const each = info.map((m, i) => ({ ...m, i }));
  if (top !== null) {
    const usable = each.filter((m) => m.inFront && m.visible);
    if (usable.length === 1) return { index: usable[0]!.i, why: `the one in dialog "${top}"` };
  } else {
    const visible = each.filter((m) => m.visible);
    if (visible.length === 1 && count > 1)
      return { index: visible[0]!.i, why: 'the only one showing; the others are hidden' };
  }
  return {
    index: null,
    described: each.map(
      (m) =>
        `${m.i}: ${m.dialog ? `in "${m.dialog}"` : 'on the page'}${m.visible ? '' : ', hidden'}` +
        `${top !== null && !m.inFront ? `, behind the dialog "${top}"` : ''}`,
    ),
  };
}

/** When the element is behind the modal dialog in front, that dialog's title: a click there can't land. */
export async function behindModal(el: Locator): Promise<string | null> {
  return el
    .evaluate((e) => {
      const name = (d: Element) =>
        d.getAttribute('aria-label') ||
        (d.querySelector('h1, h2, h3, h4, [role="heading"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const modals = [...document.querySelectorAll('dialog, [aria-modal="true"]')].filter(
        (d) => d.matches(':modal') || d.getAttribute('aria-modal') === 'true',
      );
      const front = modals.filter((m) => !modals.some((o) => o !== m && m.contains(o))).at(-1);
      if (!front || front.contains(e)) return null;
      return name(front) || 'a dialog';
    })
    .catch(() => null);
}

/** Why a click failed, in a sentence, from Playwright's log of what it tried. */
export function whyNotClicked(e: unknown): string {
  // Playwright colours its call log for a terminal; the codes would split every line we look for.
  // eslint-disable-next-line no-control-regex
  const msg = String((e as Error)?.message ?? e).replace(/\u001b\[[0-9;]*m/g, '');
  const over = /\n\s*-\s*(<[^\n]+?)\s+(?:from <[^\n]+?>\s+subtree\s+)?intercepts pointer events/.exec(msg);
  if (over) return `something is in front of it: ${over[1]!.slice(0, 200)}`;
  if (/element is not enabled|element is disabled/.test(msg)) return 'it is disabled';
  if (/element is not visible/.test(msg)) return 'it is not showing';
  if (/element is not stable/.test(msg)) return 'it kept moving (an animation that did not finish)';
  if (/Timeout \d+ms exceeded/.test(msg)) return 'it never became clickable within 10 s';
  return msg.split('\n')[0]!.slice(0, 300);
}

/** A stroke as fractions of the element's box: [x, y] pairs, 0 to 1. */
export type Stroke = [number, number][];

/** A signature-like scribble, for a pad that only needs one. */
export const SIGNATURE: Stroke[] = [
  [
    [0.08, 0.62],
    [0.14, 0.3],
    [0.2, 0.7],
    [0.27, 0.35],
    [0.33, 0.66],
    [0.4, 0.42],
    [0.48, 0.6],
  ],
  [
    [0.52, 0.55],
    [0.6, 0.32],
    [0.66, 0.68],
    [0.74, 0.4],
    [0.82, 0.58],
    [0.9, 0.45],
  ],
];

/** Draws strokes on an element with the pointer, as a finger or a mouse would: down, moves, up. */
export async function draw(page: Page, el: Locator, strokes: Stroke[] = SIGNATURE): Promise<void> {
  await el.scrollIntoViewIfNeeded({ timeout: 10_000 });
  const box = await el.boundingBox({ timeout: 10_000 });
  if (!box) throw new Error('it has no size on screen');
  const at = ([x, y]: [number, number]) => ({ x: box.x + x * box.width, y: box.y + y * box.height });
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    const first = at(stroke[0]!);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const p of stroke.slice(1)) {
      const q = at(p);
      await page.mouse.move(q.x, q.y, { steps: 6 });
    }
    await page.mouse.up();
  }
}
