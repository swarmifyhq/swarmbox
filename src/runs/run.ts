// A run: one scenario played on one world, from start to report.
//
// Starting a run makes the world the scenario asks for, puts its cast on screens and starts a Playwright
// trace on each, so every action, request and frame is kept and can be replayed later. While it runs, the
// agent logs findings (each with a screenshot of the screen it is about); the screens' own errors are
// collected without anyone asking. Ending it stops the traces, runs every check on the world, and writes
// the report: one page, with the findings, the checks, what the browsers saw go wrong, and the traces.
//
// Everything a run keeps is under the product's Swarmbox home, runs/<run>, outside the repository.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { failing, type CheckResult, type Settled } from '../checks.ts';
import { HarnessError, type Harness, type Signal } from '../harness.ts';
import type { FindingSink, Persona, ProductWorld, SinkRun } from '../product.ts';
import { describeProvenance } from '../provenance.ts';
import { loadScenario, type Scenario } from '../scenarios/spec.ts';
import { openBudget, type Budget } from './budget.ts';
import { renderReport } from './report.ts';

export type Severity = 'blocker' | 'major' | 'minor' | 'note';

export interface Finding {
  n: number;
  at: string;
  title: string;
  severity: Severity;
  /** What happened, in plain words. */
  what: string;
  expected?: string;
  screen?: string;
  url?: string;
  /** Relative to the run's directory. */
  screenshot?: string;
  /** What the product's tracker filed it as, or why it was not filed. */
  filed?: string;
}

export interface CastMember {
  role: string;
  part?: string;
  persona: Persona;
  screen: string;
}

export interface RunRecord {
  id: string;
  /** The product's title, as reports show it. */
  product: string;
  scenario: Scenario;
  worldId: string;
  dir: string;
  startedAt: string;
  endedAt?: string;
  cast: CastMember[];
  findings: Finding[];
  provenance: string;
  /** The product commit the world ran: a filed finding's found_in. */
  commit: string;
  /** Filled at the end. */
  checks?: { settled: Record<string, Settled>; results: CheckResult[] };
  signals?: Signal[];
  traces?: { screen: string; file: string }[];
  browserMinutes?: number;
  summary?: string;
  /** Whether the run is registered in the product's tracker, or why not. */
  filed?: string;
}

export interface Runs {
  start(scenarioId: string): Promise<RunRecord>;
  /** Records a finding; files it to the product's tracker unless it is a note or `report` is false. */
  finding(
    runId: string,
    f: Omit<Finding, 'n' | 'at' | 'url' | 'screenshot' | 'filed'>,
    report?: boolean,
  ): Promise<Finding>;
  end(
    runId: string,
    opts?: { summary?: string; keepWorld?: boolean },
  ): Promise<RunRecord & { report: string }>;
  get(runId: string): RunRecord;
  active(): RunRecord[];
  /**
   * A screen opened on a world while a run is going on it joins the run: recorded, its findings allowed,
   * in the report. Returns the run's id, or null when no run is on that world.
   */
  join(screenId: string): Promise<string | null>;
  /** For an action on a screen: a warning when its run is past its scenario's minutes, or null. */
  overrun(screenId: string): string | null;
  budget: Budget;
  /** Where its scenarios are read and written: the product's, or a test's own directory. */
  scenarioDir: string;
}

const minutesSince = (iso: string) => (Date.now() - Date.parse(iso)) / 60_000;

export function createRuns<W extends ProductWorld>(
  h: Harness<W>,
  opts: { env?: NodeJS.ProcessEnv; scenarioDir?: string; home?: string; findings?: FindingSink | null } = {},
): Runs {
  const env = opts.env ?? process.env;
  const product = h.product;
  const home = opts.home ?? product.home;
  const sink = opts.findings === undefined ? product.findings : opts.findings;
  const budget = openBudget(home, env);
  const runs = new Map<string, RunRecord>();
  const get = (id: string) => {
    const r = runs.get(id);
    if (!r) throw new HarnessError(`no run ${id}`);
    return r;
  };
  const save = (r: RunRecord) => writeFileSync(join(r.dir, 'run.json'), `${JSON.stringify(r, null, 2)}\n`);

  const scenarioDir = opts.scenarioDir ?? product.scenarioDir;
  const sinkRun = (r: RunRecord): SinkRun => ({
    id: r.id,
    scenario: r.scenario,
    roles: r.cast.map((c) => c.role),
    startedAt: r.startedAt,
    provenance: r.provenance,
    commit: r.commit,
    findings: r.findings.length,
  });
  return {
    budget,
    scenarioDir,
    get,
    active: () => [...runs.values()].filter((r) => !r.endedAt),

    async start(scenarioId) {
      const scenario = loadScenario(scenarioId, scenarioDir);
      const refused = budget.refusal();
      if (refused) throw new HarnessError(`not starting ${scenarioId}: ${refused}`);
      budget.started();
      const w = await h.createWorld({
        ...(scenario.world.tenants ? { tenants: scenario.world.tenants } : {}),
        seed: scenario.world.seed,
        ...(scenario.world.keep ? { keep: scenario.world.keep } : {}),
      });
      try {
        // The cast, by role: the first person holding it, the second for a second of the same role.
        const people = await h.people(w.id);
        const used = new Set<string>();
        const cast: CastMember[] = [];
        for (const c of scenario.cast) {
          const p = people.find(
            (x) => x.roles.includes(c.role) && (!c.tenant || x.tenant === c.tenant) && !used.has(x.id),
          );
          if (!p) {
            const roles = [...new Set(people.flatMap((x) => x.roles))].join(', ');
            throw new HarnessError(
              `this world has no ${c.role} left for the cast (it has: ${roles || 'nobody'})`,
            );
          }
          used.add(p.id);
          // The app this person works in: the scenario's word, else the product's (a technician's tablet).
          const app = c.app ?? (await product.appFor?.(p, w.world));
          const s = await h.openScreen(w.id, p.id, undefined, app === undefined ? {} : { app });
          // Every action, request and frame from here on, replayable with `npx playwright show-trace`.
          await s.screen.context.tracing.start({ screenshots: true, snapshots: true });
          cast.push({ role: c.role, ...(c.part ? { part: c.part } : {}), persona: p, screen: s.id });
        }
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
        const id = `${stamp}-${scenario.id}-${randomBytes(2).toString('hex')}`;
        const dir = join(home, 'runs', id);
        mkdirSync(join(dir, 'findings'), { recursive: true });
        mkdirSync(join(dir, 'traces'), { recursive: true });
        const r: RunRecord = {
          id,
          product: product.title ?? product.name,
          scenario,
          worldId: w.id,
          dir,
          startedAt: new Date().toISOString(),
          cast,
          findings: [],
          provenance: describeProvenance(w.world.provenance),
          commit: w.world.provenance.commit,
        };
        runs.set(id, r);
        save(r);
        return r;
      } catch (e) {
        await h.destroyWorld(w.id).catch(() => undefined);
        throw e;
      }
    },

    async join(screenId) {
      const s = h.screen(screenId);
      const r = [...runs.values()].find((x) => !x.endedAt && x.worldId === s.worldId);
      if (!r) return null;
      if (r.cast.some((c) => c.screen === screenId)) return r.id;
      await s.screen.context.tracing.start({ screenshots: true, snapshots: true });
      r.cast.push({
        role: s.customer ? 'customer' : (s.persona.roles[0] ?? 'person'),
        part: s.customer ? 'the customer, at their link' : 'joined during the run',
        persona: s.persona,
        screen: s.id,
      });
      save(r);
      return r.id;
    },

    async finding(runId, f, report = f.severity !== 'note') {
      const r = get(runId);
      if (r.endedAt) throw new HarnessError(`run ${runId} has ended`);
      const n = r.findings.length + 1;
      const finding: Finding = { ...f, n, at: new Date().toISOString() };
      if (f.screen) {
        if (!r.cast.some((c) => c.screen === f.screen))
          throw new HarnessError(`screen ${f.screen} is not in run ${runId}`);
        const page = h.screen(f.screen).screen.page;
        finding.url = page.url();
        const shot = join('findings', `${n}.png`);
        await page.screenshot({ path: join(r.dir, shot) }).then(
          () => (finding.screenshot = shot),
          () => undefined,
        );
      }
      if (report && sink) {
        if (sink.unavailable) finding.filed = `not filed: ${sink.unavailable}`;
        else
          await sink
            .file(sinkRun(r), {
              n,
              title: f.title,
              what: f.what,
              ...(f.expected ? { expected: f.expected } : {}),
              ...(finding.screenshot ? { screenshot: join(r.dir, finding.screenshot) } : {}),
            })
            .then(
              (id) => (finding.filed = id),
              (e: Error) => (finding.filed = `not filed: ${e.message.slice(0, 200)}`),
            );
      }
      r.findings.push(finding);
      save(r);
      return finding;
    },

    async end(runId, { summary, keepWorld = false } = {}) {
      const r = get(runId);
      if (r.endedAt) throw new HarnessError(`run ${runId} has already ended`);
      r.traces = [];
      // A screen closed during the run (a customer's link, done with) has no trace left to stop.
      const open = (id: string) => h.screens().find((x) => x.id === id);
      for (const c of r.cast) {
        const file = join('traces', `${c.screen}.zip`);
        await open(c.screen)
          ?.screen.context.tracing.stop({ path: join(r.dir, file) })
          .then(
            () => r.traces!.push({ screen: c.screen, file }),
            () => undefined,
          );
      }
      r.signals = r.cast
        .flatMap((c) => open(c.screen)?.signals ?? [])
        .filter((s) => s.at >= r.startedAt)
        .sort((a, b) => a.at.localeCompare(b.at));
      r.checks = await h.check(r.worldId);
      r.endedAt = new Date().toISOString();
      r.browserMinutes = Math.round(minutesSince(r.startedAt) * r.cast.length * 100) / 100;
      if (summary) r.summary = summary;
      budget.spend(r.browserMinutes);
      if (sink) {
        if (sink.unavailable) r.filed = `not registered: ${sink.unavailable}`;
        else
          await sink
            .register({
              ...sinkRun(r),
              endedAt: r.endedAt,
              failingChecks: failing(r.checks.results).length,
              reportPath: join(r.dir, 'report.html'),
            })
            .then(
              () => (r.filed = 'registered'),
              (e: Error) => (r.filed = `not registered: ${e.message.slice(0, 200)}`),
            );
      }
      save(r);
      const report = join(r.dir, 'report.html');
      writeFileSync(report, renderReport(r));
      if (!keepWorld) await h.destroyWorld(r.worldId).catch(() => undefined);
      return { ...r, report };
    },

    overrun(screenId) {
      const r = [...runs.values()].find((x) => !x.endedAt && x.cast.some((c) => c.screen === screenId));
      if (!r) return null;
      const m = minutesSince(r.startedAt);
      return m > r.scenario.budgetMinutes
        ? `run ${r.id} is ${Math.round(m)} minutes in, past its ${r.scenario.budgetMinutes}: wrap up and end it`
        : null;
    },
  };
}
