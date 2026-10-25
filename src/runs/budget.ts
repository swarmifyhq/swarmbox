// The daily testing budget.
//
// An agent driving Swarmbox usually runs on a subscription, so the budget is not dollars: it is
// browser-minutes (a run's wall time × the screens in it, since each screen is a browser someone's session
// is driving and reading) and runs per day. A run that would start past either limit is refused; one that
// runs past its own scenario's minutes is told so on every action. The ledger is one file in the product's
// Swarmbox home, counted by this machine's local day.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BudgetLimits {
  browserMinutes: number;
  runs: number;
}

export interface BudgetDay {
  day: string;
  browserMinutes: number;
  runs: number;
}

/** SWARMBOX_DAILY_BROWSER_MINUTES and SWARMBOX_DAILY_RUNS (SANDBOX_DAILY_* also read), 240 and 20 unset. */
export function budgetLimits(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const n = (v: string | undefined, d: number) =>
    v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d;
  return {
    browserMinutes: n(env.SWARMBOX_DAILY_BROWSER_MINUTES ?? env.SANDBOX_DAILY_BROWSER_MINUTES, 240),
    runs: n(env.SWARMBOX_DAILY_RUNS ?? env.SANDBOX_DAILY_RUNS, 20),
  };
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface Budget {
  today(): BudgetDay;
  limits: BudgetLimits;
  /** Why a new run may not start now, or null. */
  refusal(): string | null;
  /** A run started: counted at once, so a run that crashes still counts. */
  started(): void;
  /** A run used this many browser-minutes. */
  spend(browserMinutes: number): void;
}

export function openBudget(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Budget {
  const file = join(home, 'budget.json');
  const limits = budgetLimits(env);
  const read = (): BudgetDay => {
    const day = localDay(now());
    if (existsSync(file)) {
      const b = JSON.parse(readFileSync(file, 'utf8')) as BudgetDay;
      if (b.day === day) return b;
    }
    return { day, browserMinutes: 0, runs: 0 };
  };
  const write = (b: BudgetDay) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(b)}\n`);
  };
  return {
    limits,
    today: read,
    refusal() {
      const b = read();
      if (b.runs >= limits.runs) return `today's ${limits.runs} runs are used (SWARMBOX_DAILY_RUNS)`;
      if (b.browserMinutes >= limits.browserMinutes)
        return `today's ${limits.browserMinutes} browser-minutes are used (SWARMBOX_DAILY_BROWSER_MINUTES)`;
      return null;
    },
    started() {
      const b = read();
      write({ ...b, runs: b.runs + 1 });
    },
    spend(m) {
      const b = read();
      write({ ...b, browserMinutes: Math.round((b.browserMinutes + m) * 100) / 100 });
    },
  };
}
