/// <reference lib="dom" />

// What an agent sees (fleet/sight.ts), against plain pages in a real Chromium: no world needed. Each case
// is one the 24 Oct run tripped on: a dialog at the end of a long page, two "Send" buttons, a click behind a
// dialog that timed out with no reason given, and a signature pad only a pointer can sign.

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  behindModal,
  changes,
  dialogsText,
  draw,
  glance,
  openDialogs,
  pickAmong,
  whyNotClicked,
} from '../src/fleet/sight.ts';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await (await browser.newContext()).newPage();
});

// A long page, as a job is, with its dialog drawn at the very end, as the office draws them.
const LONG = `<main>${Array.from({ length: 400 }, (_, i) => `<p>Line ${i} of the job's history</p>`).join('')}
  <form><button type="button">Send</button></form></main>
  <dialog id="d" aria-labelledby="t"><h2 id="t">Send estimate E-9145</h2>
    <label><input type="checkbox" checked> Tom Whitaker · text</label>
    <button type="button">Cancel</button><button type="button" id="send">Send</button></dialog>`;

describe('a dialog at the end of a long page', () => {
  it('comes first and whole, named as a person would say it, and says it holds the screen', async () => {
    await page.setContent(LONG);
    expect((await page.locator('body').ariaSnapshot()).length).toBeGreaterThan(12_000);
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal());
    const dialogs = await openDialogs(page);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({ title: 'Send estimate E-9145', modal: true });
    expect(dialogs[0]!.tree).toContain('button "Send"');
    const text = dialogsText(dialogs);
    expect(text.startsWith('OPEN DIALOG "Send estimate E-9145" (modal')).toBe(true);
    expect(text).toContain('--- the page behind it ---');
  });

  it('is not listed once it closes', async () => {
    await page.setContent(LONG);
    expect(await openDialogs(page)).toEqual([]);
    expect(dialogsText([])).toBe('');
  });
});

describe('what an action changed', () => {
  it('says a dialog opened, then closed with a status line, and the address moved', async () => {
    await page.setContent(`${LONG}<p role="status" id="s"></p>`);
    const before = await glance(page);
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal());
    const opened = await glance(page);
    expect(changes(before, opened)).toEqual(['dialog opened: "Send estimate E-9145 (modal)"']);
    await page.evaluate(() => {
      (document.getElementById('d') as HTMLDialogElement).close();
      document.getElementById('s')!.textContent = 'Estimate E-9145 sent to the customer.';
      location.hash = '#/jobs/24591';
    });
    expect(changes(opened, await glance(page))).toEqual([
      'dialog closed: "Send estimate E-9145 (modal)"',
      'says: "Estimate E-9145 sent to the customer."',
      'address: about:blank → about:blank#/jobs/24591',
    ]);
  });

  it('says nothing when nothing a person would notice moved', async () => {
    await page.setContent(LONG);
    expect(changes(await glance(page), await glance(page))).toEqual([]);
  });
});

describe('two controls with one name', () => {
  it('means the one in the open dialog', async () => {
    await page.setContent(LONG);
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal());
    const sends = page.getByRole('button', { name: 'Send', exact: true });
    expect(await sends.count()).toBe(2);
    expect(await pickAmong(sends, 2)).toEqual({
      index: 1,
      why: 'the one in dialog "Send estimate E-9145"',
    });
  });

  it('means the one in the dialog in front, when a dialog opens over another', async () => {
    // As the office has it: the job's panel is modal, with its own Send, and "Send estimate" opens over it.
    await page.setContent(`<dialog id="job" aria-label="Job #24584"><form><button type="button">Send</button></form>
        <dialog id="d" aria-label="Send estimate E-9145"><button type="button">Cancel</button>
          <button type="button" id="send">Send</button></dialog></dialog>`);
    await page.evaluate(() => {
      (document.getElementById('job') as HTMLDialogElement).showModal();
      (document.getElementById('d') as HTMLDialogElement).showModal();
    });
    const sends = page.getByRole('button', { name: 'Send', exact: true });
    expect(await pickAmong(sends, 2)).toEqual({ index: 1, why: 'the one in dialog "Send estimate E-9145"' });
    expect(await behindModal(sends.nth(0))).toBe('Send estimate E-9145');
    expect(await behindModal(page.locator('#send'))).toBeNull();
    const dialogs = await openDialogs(page);
    expect(dialogs.map((d) => d.title)).toEqual(['Send estimate E-9145', 'Job #24584']);
  });

  it('describes each when nothing settles it', async () => {
    await page.setContent('<button>Bill</button><section><button>Bill</button></section>');
    const bills = page.getByRole('button', { name: 'Bill' });
    expect(await pickAmong(bills, 2)).toEqual({
      index: null,
      described: ['0: on the page', '1: on the page'],
    });
  });

  it('knows a control behind the open dialog can’t be reached, and which dialog is in the way', async () => {
    await page.setContent(LONG);
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal());
    expect(await behindModal(page.locator('main button'))).toBe('Send estimate E-9145');
    expect(await behindModal(page.locator('#send'))).toBeNull();
  });
});

describe('a click that can’t land', () => {
  it('says what is in front of it', async () => {
    await page.setContent(`<button id="b">Complete job</button>
      <div style="position:fixed;inset:0;background:transparent" class="scrim">over</div>`);
    const err = await page
      .locator('#b')
      .click({ timeout: 1_500 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(whyNotClicked(err)).toMatch(/^something is in front of it: <div [^>]*class="scrim"/);
  });

  it('says a disabled control is disabled', async () => {
    await page.setContent('<button disabled>Sign and approve</button>');
    const err = await page
      .getByRole('button')
      .click({ timeout: 1_000 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(whyNotClicked(err)).toBe('it is disabled');
  });
});

describe('drawing', () => {
  it('signs a pad that only listens to the pointer', async () => {
    await page.setContent(`<canvas id="sig" width="300" height="100" aria-label="Signature pad"></canvas>
      <script>
        const c = document.getElementById('sig'); const x = c.getContext('2d'); let on = false;
        window.strokes = 0;
        c.addEventListener('pointerdown', (e) => { on = true; window.strokes++; x.beginPath(); x.moveTo(e.offsetX, e.offsetY); });
        c.addEventListener('pointermove', (e) => { if (on) { x.lineTo(e.offsetX, e.offsetY); x.stroke(); } });
        c.addEventListener('pointerup', () => (on = false));
      </script>`);
    await draw(page, page.getByLabel('Signature pad'));
    expect(await page.evaluate(() => (window as unknown as { strokes: number }).strokes)).toBe(2);
    const inked = await page.evaluate(() => {
      const c = document.getElementById('sig') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
      return n;
    });
    expect(inked).toBeGreaterThan(100);
  });
});
