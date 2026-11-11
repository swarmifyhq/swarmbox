import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../src/checks.ts';
import { buildResults, type ResultsInput } from '../../src/runs/results.ts';

const run = (over: Partial<ResultsInput> = {}): ResultsInput => ({
  id: 'r1',
  product: 'Sample',
  scenario: { id: 's1' },
  commit: 'abc',
  provenance: 'built at abc',
  startedAt: '2026-11-07T00:00:00Z',
  endedAt: '2026-11-07T01:00:00Z',
  recheck: [],
  results: [],
  checks: [],
  ...over,
});
const check = (over: Partial<CheckResult>): CheckResult => ({
  id: 'money.adds-up',
  title: 'Money adds up',
  where: 'north',
  outcome: 'pass',
  examined: 4,
  unit: 'invoices',
  violations: [],
  ...over,
});
const tester = {
  ref: 'B-1',
  outcome: 'held' as const,
  what: 'Walked it',
  at: 'now',
  screenshot: 'results/1.png',
};

describe('a run’s results', () => {
  it('keeps what the tester said, with its picture', () => {
    expect(buildResults(run({ results: [tester] })).results).toEqual([
      { ref: 'B-1', outcome: 'held', what: 'Walked it', by: 'tester', screenshot: 'results/1.png' },
    ]);
  });

  it('never takes silence for a hold', () => {
    const f = buildResults(run({ recheck: ['B-1', 'B-2'], results: [tester] }));
    expect(f.results.find((x) => x.ref === 'B-2')).toMatchObject({ outcome: 'not-reached', by: 'nobody' });
    expect(f.results.filter((x) => x.ref === 'B-1')).toHaveLength(1);
  });

  it('takes a known red that now passes only as backing for a tester’s hold', () => {
    const c = check({ outcome: 'known-red-now-passes', knownRed: { ref: 'B-1', why: 'x' } });
    expect(buildResults(run({ results: [tester], checks: [c] })).results).toEqual([
      expect.objectContaining({ ref: 'B-1', by: 'tester' }),
      expect.objectContaining({ ref: 'B-1', outcome: 'held', by: 'check', check: 'money.adds-up' }),
    ]);
  });

  it('never takes a known red that now passes for a hold by itself: the run may not have gone near it', () => {
    const c = check({ outcome: 'known-red-now-passes', knownRed: { ref: 'B-3', why: 'x' } });
    expect(buildResults(run({ checks: [c] })).results).toEqual([]);
    expect(buildResults(run({ recheck: ['B-3'], checks: [c] })).results).toEqual([
      expect.objectContaining({ ref: 'B-3', outcome: 'not-reached', by: 'nobody' }),
    ]);
  });

  it('counts a known red against only what the run was asked about', () => {
    const c = check({ outcome: 'known-red', knownRed: { ref: 'B-3', why: 'x' } });
    expect(buildResults(run({ checks: [c] })).results).toEqual([]);
    expect(buildResults(run({ recheck: ['B-3'], checks: [c] })).results).toEqual([
      expect.objectContaining({ ref: 'B-3', outcome: 'came-back', by: 'check' }),
    ]);
  });

  it('keeps both words when a tester and a check disagree', () => {
    const c = check({ outcome: 'known-red', knownRed: { ref: 'B-1', why: 'x' } });
    const rows = buildResults(run({ recheck: ['B-1'], results: [tester], checks: [c] })).results;
    expect(rows.map((x) => [x.by, x.outcome])).toEqual([
      ['tester', 'held'],
      ['check', 'came-back'],
    ]);
  });

  it('takes a check that guards a bug as backing for a tester’s hold, once it has looked at something', () => {
    const c = check({ outcome: 'pass', examined: 4, guards: ['B-1'] });
    const rows = buildResults(run({ results: [tester], checks: [c] })).results;
    expect(rows.map((r) => [r.ref, r.outcome, r.by, r.check])).toEqual([
      ['B-1', 'held', 'tester', undefined],
      ['B-1', 'held', 'check', c.id],
    ]);
  });

  it('never takes a guard for a hold by itself, or when it looked at nothing', () => {
    const c = check({ outcome: 'pass', examined: 4, guards: ['B-3'] });
    expect(buildResults(run({ checks: [c] })).results).toEqual([]);
    const idle = check({ outcome: 'nothing-to-check', examined: 0, guards: ['B-1'] });
    expect(buildResults(run({ results: [tester], checks: [idle] })).results.map((r) => r.by)).toEqual([
      'tester',
    ]);
  });

  it('counts a guard’s red against a bug the run was asked about or a tester held', () => {
    const c = check({
      outcome: 'fail',
      guards: ['B-1'],
      violations: [{ summary: '2 days left open', rows: [] }],
    });
    const asked = buildResults(run({ recheck: ['B-1'], checks: [c] })).results;
    expect(asked.map((r) => [r.outcome, r.by])).toEqual([['came-back', 'check']]);
    const held = buildResults(run({ results: [tester], checks: [c] })).results;
    expect(held.map((r) => [r.outcome, r.by])).toEqual([
      ['held', 'tester'],
      ['came-back', 'check'],
    ]);
    expect(buildResults(run({ checks: [c] })).results).toEqual([]);
  });

  it('says a ref once per check, however often the check names it', () => {
    const twice = check({ outcome: 'pass', guards: ['B-1', 'B-1'] });
    expect(buildResults(run({ results: [tester], checks: [twice] })).results.map((r) => r.by)).toEqual([
      'tester',
      'check',
    ]);
    const both = check({
      outcome: 'known-red-now-passes',
      knownRed: { ref: 'B-1', why: 'x' },
      guards: ['B-1'],
    });
    expect(buildResults(run({ results: [tester], checks: [both] })).results.map((r) => r.by)).toEqual([
      'tester',
      'check',
    ]);
  });

  it('lists every check’s outcome', () => {
    expect(buildResults(run({ checks: [check({})] })).checks).toEqual([
      { id: 'money.adds-up', where: 'north', outcome: 'pass' },
    ]);
  });
});
