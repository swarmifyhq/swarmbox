// What a run says about the things it was asked to look at again: each one held, came back or wasn't reached.
// A plain file beside the run's report, for any product, with or without a tracker. A tester's word and a
// check's word are kept apart, because a product can ask for one, the other or both before it believes a fix.

import type { CheckResult } from '../checks.ts';

export type ResultOutcome = 'held' | 'came-back' | 'not-reached';

export interface TesterResult {
  ref: string;
  outcome: ResultOutcome;
  /** What was done and seen: the path taken, since a hold only speaks for that path. */
  what: string;
  at: string;
  /** Relative to the run's directory. */
  screenshot?: string;
}

export interface ResultRow {
  ref: string;
  outcome: ResultOutcome;
  what: string;
  by: 'tester' | 'check' | 'nobody';
  /** The check that said so, for a row by a check. */
  check?: string;
  screenshot?: string;
}

export interface ResultsFile {
  run: string;
  product: string;
  scenario: string;
  commit: string;
  provenance: string;
  startedAt: string;
  endedAt: string;
  /** What the run was asked to look at. */
  recheck: string[];
  results: ResultRow[];
  checks: { id: string; where: string; outcome: CheckResult['outcome'] }[];
}

export interface ResultsInput {
  id: string;
  product: string;
  scenario: { id: string };
  commit: string;
  provenance: string;
  startedAt: string;
  endedAt: string;
  recheck: string[];
  results: TesterResult[];
  checks: CheckResult[];
}

/**
 * One row per thing said. A check's red only counts against something the run was asked about, since a known
 * red elsewhere is old news. Anything asked about that nobody spoke to wasn't reached: silence is never a hold.
 */
export function buildResults(r: ResultsInput): ResultsFile {
  const rows: ResultRow[] = r.results.map((t) => ({
    ref: t.ref,
    outcome: t.outcome,
    what: t.what,
    by: 'tester',
    ...(t.screenshot ? { screenshot: t.screenshot } : {}),
  }));
  for (const c of r.checks) {
    if (!c.knownRed) continue;
    const ref = c.knownRed.ref;
    if (c.outcome === 'known-red-now-passes')
      rows.push({
        ref,
        outcome: 'held',
        what: `${c.title}: passes @ ${c.where}, ${c.examined} ${c.unit}`,
        by: 'check',
        check: c.id,
      });
    else if (c.outcome === 'known-red' && r.recheck.includes(ref))
      rows.push({
        ref,
        outcome: 'came-back',
        what: `${c.title}: still red @ ${c.where}: ${c.violations[0]?.summary ?? c.knownRed.why}`,
        by: 'check',
        check: c.id,
      });
  }
  const spoken = new Set(rows.map((x) => x.ref));
  for (const ref of r.recheck)
    if (!spoken.has(ref))
      rows.push({ ref, outcome: 'not-reached', what: 'Nobody reported on it', by: 'nobody' });
  return {
    run: r.id,
    product: r.product,
    scenario: r.scenario.id,
    commit: r.commit,
    provenance: r.provenance,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    recheck: r.recheck,
    results: rows,
    checks: r.checks.map((c) => ({ id: c.id, where: c.where, outcome: c.outcome })),
  };
}
