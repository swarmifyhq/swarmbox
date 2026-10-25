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
  h = createHarness(sampleProduct({ scenarioDir, home: join(tmp, 'home') }), { headless: true });
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

  it('moves the clock, and every screen follows', async () => {
    const before = Date.now();
    const moved = await call('world_clock', { world, jumpMs: 86_400_000 });
    expect(moved.text).toMatch(/screens follow it/);
    const s = h.screens().find((x) => x.persona.id === 'north-ana')!;
    const now = await s.screen.page.evaluate(() => Date.now());
    expect(now - before).toBeGreaterThan(86_000_000);
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
        world: { seed: false },
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

    const office = h.screens().find((s) => s.persona.id === 'demo-shop-ana')!.id;
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
