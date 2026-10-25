// Scenarios, the daily budget and the report: the parts that need no world.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openBudget } from '../../src/runs/budget.ts';
import { renderReport } from '../../src/runs/report.ts';
import type { RunRecord } from '../../src/runs/run.ts';
import { listScenarios, loadScenario, saveScenario, Scenario } from '../../src/scenarios/spec.ts';

const tmp = mkdtempSync(join(tmpdir(), 'swarmbox-scenarios-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const minimal = {
  id: 'a-test',
  title: 'A test',
  goal: 'Does the thing do the thing?',
  cast: [{ role: 'owner' }],
  try: ['Do it'],
  expect: ['It works'],
};

describe('scenarios', () => {
  it('lists a folder’s scenarios, each loaded and checked, and nothing for a folder that isn’t there', () => {
    const dir = mkdtempSync(join(tmp, 'list-'));
    saveScenario({ ...minimal, id: 'b-test' }, { dir });
    saveScenario(minimal, { dir });
    expect(listScenarios(dir).map((s) => s.id)).toEqual(['a-test', 'b-test']);
    expect(listScenarios(join(tmp, 'none'))).toEqual([]);
  });

  it('takes tenants, a cast member’s tenant and any of the product’s apps', () => {
    const s = Scenario.parse({
      ...minimal,
      world: { tenants: ['acme'], seed: false },
      cast: [{ role: 'technician', tenant: 'acme', app: 'tablet' }],
    });
    expect(s.cast[0]).toEqual({ role: 'technician', tenant: 'acme', app: 'tablet' });
    expect(() => Scenario.parse({ ...minimal, world: { companies: ['acme'] } })).toThrow();
  });

  it('fills defaults: a seeded world, no conditions, 20 minutes', () => {
    expect(Scenario.parse(minimal)).toMatchObject({
      world: { seed: true },
      conditions: [],
      budgetMinutes: 20,
    });
  });

  it.each([
    ['no cast', { ...minimal, cast: [] }],
    ['nothing to try', { ...minimal, try: [] }],
    ['no idea of good', { ...minimal, expect: [] }],
    ['an unknown field', { ...minimal, clicks: ['#submit'] }],
    ['a path in the id', { ...minimal, id: '../x' }],
  ])('refuses %s', (_why, s) => {
    expect(() => Scenario.parse(s)).toThrow();
  });

  it('saves, refuses to overwrite unless asked, and loads back', () => {
    saveScenario(minimal, { dir: tmp });
    expect(() => saveScenario(minimal, { dir: tmp })).toThrow(/exists/);
    saveScenario({ ...minimal, title: 'Renamed' }, { dir: tmp, replace: true });
    expect(loadScenario('a-test', tmp).title).toBe('Renamed');
  });
});

describe('the daily budget', () => {
  it('counts runs and browser-minutes for today, refuses past either, and starts again tomorrow', () => {
    const home = mkdtempSync(join(tmp, 'budget-'));
    let now = new Date(2026, 9, 16, 10);
    const env = { SWARMBOX_DAILY_RUNS: '2', SANDBOX_DAILY_BROWSER_MINUTES: '30' };
    const b = openBudget(home, env, () => now);
    expect(b.refusal()).toBeNull();
    b.started();
    b.spend(12.5);
    expect(b.today()).toMatchObject({ runs: 1, browserMinutes: 12.5 });
    b.spend(20);
    expect(b.refusal()).toMatch(/30 browser-minutes/);
    now = new Date(2026, 9, 17, 9);
    expect(b.refusal()).toBeNull();
    b.started();
    b.started();
    expect(b.refusal()).toMatch(/2 runs/);
  });
});

describe('the report', () => {
  it('escapes everything that came from a world or an agent', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = {
      id: 'r1',
      product: evil,
      scenario: Scenario.parse({ ...minimal, title: evil }),
      worldId: 'w1',
      dir: tmp,
      startedAt: '2026-10-16T10:00:00.000Z',
      endedAt: '2026-10-16T10:05:00.000Z',
      cast: [],
      findings: [{ n: 1, at: '2026-10-16T10:01:00.000Z', title: evil, severity: 'major', what: evil }],
      provenance: 'product abc1234',
      checks: { settled: {}, results: [] },
      signals: [{ at: '2026-10-16T10:02:00.000Z', screen: 's1', kind: 'console-error', text: evil }],
      traces: [],
      browserMinutes: 5,
    } as unknown as RunRecord;
    const html = renderReport(r);
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Problems found');
  });
});
