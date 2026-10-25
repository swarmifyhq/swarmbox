// The whole loop on a product that isn't Flowology: a world, people signed in on their own hosts, a dialog
// the agent sees first and acts in, what the server did after, a tablet app past its PIN, a customer's
// link, the clock, the checks, and a run from its scenario to its report, all through the MCP tools an
// agent uses. Needs Chromium (pnpm exec playwright install chromium).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../src/harness.ts';
import { serveMcp, type McpHttp } from '../src/mcp/server.ts';
import { saveScenario } from '../src/scenarios/spec.ts';
import { sampleProduct, type SampleWorld } from './fixtures/sample-product.ts';

const tmp = mkdtempSync(join(tmpdir(), 'swarmbox-harness-'));
const scenarioDir = join(tmp, 'scenarios');
let h: Harness<SampleWorld>;
let mcp: McpHttp;
let client: Client;

/** A tool's text, and whether it was a refusal. */
async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; error: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), error: r.isError === true };
}

beforeAll(async () => {
  h = createHarness(sampleProduct({ scenarioDir, home: join(tmp, 'home') }), {
    headless: true,
    standinSandbox: process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required',
  });
  mcp = await serveMcp(h, 0);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
});
afterAll(async () => {
  await client.close();
  await mcp.close();
  await h.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe('a world of a product Swarmbox knows nothing about', () => {
  let world = '';

  it('starts, with its tenants on their own hosts and its own word for them', async () => {
    const made = await call('world_create', { tenants: ['north', 'south'] });
    expect(made.error).toBe(false);
    world = /^(w\d+)/.exec(made.text)![1]!;
    expect(made.text).toContain('a sample world');
    expect(made.text).toMatch(/north: http:\/\/north\.sample\.test:\d+/);
    const people = await call('persona_list', { world });
    expect(people.text).toContain('north-ana  north  Ana (owner)');
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === 'world_list')!.description).toContain('shops');
  });

  it('talks to a stand-in as its provider, and the agent can make it misbehave', async () => {
    const made = await call('world_create', { tenants: ['east'], standins: ['postbox'] });
    expect(made.error, made.text).toBe(false);
    const w = /^(w\d+)/.exec(made.text)![1]!;
    expect(made.text).toMatch(/stand-ins: postbox \(Postbox\) at http:\/\/127\.0\.0\.1:\d+/);
    expect((await call('standin_catalog')).text).toContain('"provider": "Postbox"');

    const screen = /^screen (s\d+)/.exec(
      (await call('screen_open', { world: w, person: 'east-ana' })).text,
    )![1]!;
    const send = async () => {
      await call('screen_act', { screen, action: { kind: 'click', role: 'button', name: 'Send estimate' } });
      await call('screen_act', { screen, action: { kind: 'click', role: 'button', name: 'Send' } });
    };
    await send();
    const world = h.world(w).world;
    for (let i = 0; i < 40 && !world.receipts.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(world.receipts[0]).toMatch(/^east MessageSid=SM\d+&MessageStatus=delivered$/);
    const log = (await call('standin_log', { world: w, standin: 'postbox' })).text;
    expect(log).toContain('Data from the postbox stand-in');
    expect(log).toContain('"operation": "messages.create"');
    expect(log).toContain('"tenant": "east"');

    const failed = await call('standin_behave', {
      world: w,
      standin: 'postbox',
      behaviour: 'fail',
      count: 1,
    });
    expect(failed.text).toContain('applied by Swarmbox in front of it');
    await send();
    for (let i = 0; i < 40; i++) {
      if ((await call('standin_log', { world: w, standin: 'postbox' })).text.includes('"behaviour": "fail"'))
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await call('standin_log', { world: w, standin: 'postbox' })).text).toContain(
      '"behaviour": "fail"',
    );
    const nope = await call('standin_behave', { world: w, standin: 'postbox', behaviour: 'decline' });
    expect(nope.text).toContain('doesn\'t support "decline"');
    await call('world_destroy', { world: w });
  });

  it('takes the product’s own world options, and refuses ones it doesn’t know', async () => {
    const made = await call('world_create', { tenants: ['east'], options: { closed: ['east'] } });
    expect(made.text).toContain('east is closed for the season');
    await call('world_destroy', { world: /^(w\d+)/.exec(made.text)![1]! });
    const odd = await call('world_create', { tenants: ['east'], options: { colour: 'red' } });
    expect(odd.error).toBe(true);
  });

  it('opens a person signed in, sees the dialog first, acts in it, and hears what the server did', async () => {
    const opened = await call('screen_open', { world, person: 'north-ana' });
    expect(opened.text).toContain('Signed in as Ana');
    const screen = /^screen (s\d+)/.exec(opened.text)![1]!;

    const open = await call('screen_act', {
      screen,
      action: { kind: 'click', role: 'button', name: 'Send estimate' },
    });
    expect(open.text).toContain('changed: dialog opened: "Send estimate E-1 (modal)"');
    expect(open.text).toContain('OPEN DIALOG "Send estimate E-1" (modal');

    // "Send" matches the page's "Send estimate" too: the one in the dialog in front is meant.
    const sent = await call('screen_act', {
      screen,
      action: { kind: 'click', role: 'button', name: 'Send' },
    });
    expect(sent.error).toBe(false);
    expect(sent.text).toContain('the one in dialog "Send estimate E-1"');
    expect(sent.text).toContain('dialog closed: "Send estimate E-1 (modal)"');
    expect(sent.text).toContain('says: "Estimate E-1 sent."');
    expect(sent.text).toContain('you: estimates.send ok → messages.send');
    expect(sent.text).toContain(
      'the worker: messaging.send on estimate.sent failed — no provider for +15550100',
    );

    const inbox = await call('phone_inbox', { world, tenant: 'north', to: '+15550100' });
    expect(inbox.text).toContain('Your estimate');
  });

  it('reads the world’s own log, narrowed by text', async () => {
    const all = await call('world_log', { world, lines: 2 });
    expect(all.text.split('\n')).toHaveLength(2);
    const sends = await call('world_log', { world, match: 'post /api/send' });
    expect(sends.text).toContain('north POST /api/send');
    expect((await call('world_log', { world, match: 'nothing-like-this' })).text).toContain(
      'no line contains',
    );
    // Text, not a pattern: what would be a broken or runaway pattern is just looked for.
    expect((await call('world_log', { world, match: '(a+)+$' })).error).toBe(false);
  });

  it('refuses a click behind an open dialog, naming the dialog', async () => {
    const screen = h.screens().find((s) => s.persona.id === 'north-ana')!.id;
    await call('screen_act', { screen, action: { kind: 'click', role: 'button', name: 'Send estimate' } });
    const behind = await call('screen_act', {
      screen,
      action: { kind: 'click', role: 'button', name: 'Send estimate', exact: true },
    });
    expect(behind.error).toBe(true);
    expect(behind.text).toContain('is behind the open dialog "Send estimate E-1"');
  });

  it('opens a tablet app past its first screen, and a customer’s link with no sign-in', async () => {
    const tech = await call('screen_open', { world, person: 'south-ben', app: 'tech' });
    expect(tech.text).toContain('heading "Today"');
    const s = h.screens().find((x) => x.persona.id === 'south-ben')!;
    expect(s.screen.page.viewportSize()).toEqual({ width: 1180, height: 820 });

    const nope = await call('screen_open', { world, person: 'south-ben', app: 'watch' });
    expect(nope.text).toContain('sample has no app watch; its apps: (main), tech');

    // Without the port, as products write their links.
    const link = await call('screen_open', { world, link: 'http://south.sample.test/p/south/e/abc' });
    expect(link.text).toContain('Customer (link)');
    expect(link.text).toContain('Your estimate');
    const bare = await call('screen_open', { world, link: '/p/north/e/abc' });
    expect(bare.text).toContain('Your estimate');
    expect(h.world(world).world.requests).toContain('north GET /p/north/e/abc');
  });

  it('opens a screen as a phone or a turned tablet, light or dark', async () => {
    const look = async (args: Record<string, unknown>) => {
      const opened = await call('screen_open', { world, ...args });
      expect(opened.error, opened.text).toBe(false);
      const s = h.screen(/^screen (s\d+)/.exec(opened.text)![1]!);
      // The screen's size, not the page's layout width: a page with no viewport tag is laid out at 980 px on a
      // phone, as a real one does.
      return {
        ...s.screen.page.viewportSize(),
        ...(await s.screen.page.evaluate(() => ({
          touch: matchMedia('(pointer: coarse)').matches,
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
        }))),
      };
    };
    // A customer on a phone, at night.
    expect(await look({ link: '/p/north/e/abc', device: 'phone', colorScheme: 'dark' })).toEqual({
      width: 390,
      height: 844,
      touch: true,
      dark: true,
    });
    // The tablet app turned to portrait: the device wins over the app's own landscape.
    expect(await look({ person: 'south-ben', app: 'tech', device: 'tablet-portrait' })).toMatchObject({
      width: 820,
      height: 1180,
      dark: false,
    });
    const odd = await call('screen_open', { world, person: 'north-ana', device: 'watch' });
    expect(odd.error).toBe(true);
  });

  it('moves the clock, and every screen follows', async () => {
    const before = Date.now();
    const moved = await call('world_clock', { world, jumpMs: 86_400_000 });
    expect(moved.text).toMatch(/screens follow it/);
    const s = h.screens().find((x) => x.persona.id === 'north-ana')!;
    const now = await s.screen.page.evaluate(() => Date.now());
    expect(now - before).toBeGreaterThan(86_000_000);
    // A day on, past the twelve-hour session it opened with: still signed in, as a person who kept using it.
    await s.screen.page.reload();
    expect(await s.screen.page.textContent('main')).toContain('Signed in as Ana');
    // A screen opened now starts on the world's day from its first script, not this machine's.
    const later = await call('screen_open', { world, person: 'north-ana' });
    const page = h.screen(/^screen (s\d+)/.exec(later.text)![1]!).screen.page;
    const started = await page.evaluate(() => (window as unknown as { startedAt: number }).startedAt);
    expect(started - before).toBeGreaterThan(86_000_000);
  });

  it('runs the product’s checks', async () => {
    const checked = await call('checks_run', { world });
    expect(checked.text).toContain('[FAIL] texts-arrive @ north — 1 texts');
    expect(checked.text).toContain('[nothing to check yet] texts-arrive @ south');
    await call('world_destroy', { world });
  });
});

describe('a run of a scenario', () => {
  it('casts the scenario’s roles in their apps, logs a finding with its screenshot, and writes the report', async () => {
    saveScenario(
      {
        id: 'send-an-estimate',
        title: 'Send an estimate',
        goal: 'Does the customer get the estimate?',
        // A Saturday morning in March, in the shop's zone.
        world: { seed: false, startsAt: '2030-03-02 09:00' },
        cast: [{ role: 'owner', part: 'the office' }, { role: 'technician' }],
        try: ['Send the estimate to the customer'],
        expect: ['The customer gets a text with the link'],
      },
      { dir: scenarioDir },
    );
    const started = await call('run_start', { scenario: 'send-an-estimate' });
    expect(started.error).toBe(false);
    const run = /^run (\S+)/.exec(started.text)![1]!;
    expect(started.text).toMatch(/s\d+: Ana \(owner\), the office/);
    const tech = h.screens().find((s) => s.persona.id === 'demo-shop-ben')!;
    expect(tech.screen.page.url()).toContain('/tech/');

    // The day began when the scenario said, in the shop's zone, and the cast signed in on it. The page's
    // clock is read and shown here, in Node: Chromium's own tzdata can disagree with Node's on a zone.
    const ana = h.screens().find((s) => s.persona.id === 'demo-shop-ana')!;
    const at = await ana.screen.page.evaluate(() => Date.now());
    const shown = new Intl.DateTimeFormat('sv-SE', {
      timeZone: ana.persona.timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(at);
    expect(shown).toBe('2030-03-02 09:00');
    expect(await ana.screen.page.textContent('main')).toContain('Signed in as Ana');
    const office = ana.id;
    const logged = await call('finding_log', {
      run,
      title: 'The text never arrives',
      severity: 'major',
      what: 'The office says sent; the worker failed it.',
      screen: office,
    });
    expect(logged.text).toBe('finding #1 logged with a screenshot');

    const ended = await call('run_end', { run, summary: 'Sent one estimate.' });
    expect(ended.text).toMatch(/1 findings, 0 failing checks/);
    expect(ended.text).not.toContain('tracker:');
    const report = /report: (\S+)/.exec(ended.text)![1]!;
    const html = readFileSync(report, 'utf8');
    expect(html).toContain('Sample run');
    expect(html).toContain('The text never arrives');
    expect(existsSync(join(report, '..', 'findings', '1.png'))).toBe(true);
    expect(h.worlds()).toHaveLength(0);
  });
});
