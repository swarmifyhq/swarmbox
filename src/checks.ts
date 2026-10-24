// What a product's checks report, and how a run shows them. The checks themselves are the product's: rules
// its data must always obey, asked of its database or its code, never of a model.
//
// Outcomes are kept distinct on purpose. "Nothing to check" is not a pass, an error is not a pass, and a
// known defect that starts passing is announced, not quietly taken as good news.

export type Outcome = 'pass' | 'fail' | 'nothing-to-check' | 'error' | 'known-red' | 'known-red-now-passes';

export interface Violation {
  summary: string;
  /** The rows behind it, for the report (a few are shown). */
  rows?: Record<string, unknown>[];
}

export interface CheckResult {
  id: string;
  title: string;
  /** Where it ran: a tenant, or what the product calls its other scopes ("control", "code"). */
  where: string;
  outcome: Outcome;
  /** How much it looked at: a check with nothing to look at says so instead of passing. */
  examined: number;
  unit: string;
  violations: Violation[];
  error?: string;
  /** A known, ticketed defect this check is red for. */
  knownRed?: { ref: string; why: string };
}

/** Background work still outstanding when settling gave up: an event a handler has not finished. */
export interface Pending {
  seq: number;
  type: string;
  handler: string;
  /** Null when the handler has not picked the work up at all. */
  status: string | null;
  lastError: string | null;
}

export interface Settled {
  settled: boolean;
  /** How long it took, or how long it waited before giving up. */
  ms: number;
  /** What was still outstanding when it gave up; empty when settled. */
  pending: Pending[];
  /** Outstanding work that is a known, ticketed defect: reported, never dropped, and never waited for. */
  known: Array<Pending & { ref: string }>;
}

const MARK: Record<Outcome, string> = {
  pass: 'pass',
  fail: 'FAIL',
  error: 'ERROR',
  'nothing-to-check': 'nothing to check yet',
  'known-red': 'known red',
  'known-red-now-passes': 'KNOWN RED NOW PASSES',
};

/** A plain-text report: failures first, then what could not be checked, then passes. */
export function formatReport(results: CheckResult[]): string {
  const order: Outcome[] = ['fail', 'error', 'known-red-now-passes', 'known-red', 'nothing-to-check', 'pass'];
  const sorted = [...results].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome));
  const tally = order
    .map((o) => [o, results.filter((r) => r.outcome === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([o, n]) => `${n} ${MARK[o]}`)
    .join(', ');
  const lines = [`${results.length} checks: ${tally}`];
  for (const r of sorted) {
    const head = `[${MARK[r.outcome]}] ${r.id} @ ${r.where} — ${r.examined} ${r.unit}`;
    lines.push(head);
    if (r.error) lines.push(`    error: ${r.error}`);
    if (r.knownRed) lines.push(`    known defect ${r.knownRed.ref}: ${r.knownRed.why}`);
    for (const v of r.violations) {
      lines.push(`    ${v.summary}`);
      for (const row of v.rows?.slice(0, 5) ?? []) lines.push(`      ${JSON.stringify(row)}`);
      if ((v.rows?.length ?? 0) > 5) lines.push(`      … ${v.rows!.length - 5} more`);
    }
  }
  return lines.join('\n');
}

/** Failing or broken checks: what a run's end counts. */
export const failing = (results: CheckResult[]): CheckResult[] =>
  results.filter((c) => c.outcome === 'fail' || c.outcome === 'error');
