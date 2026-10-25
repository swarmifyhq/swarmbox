// What code a world is running.
//
// Learned the hard way: a defect was reproduced, filed and routed as a Major against product code that was
// 247 commits behind staging, where it had already been fixed. A finding is only as good as the commit it
// names, so every world records the product commit it started on, whether the product tree had local
// changes, and how far behind the branch it ships from it is, and every report says so at the top.
//
// Only product code counts (the paths the product names): changes to its tests, docs or sandbox adapter do
// not change what the world runs.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface Provenance {
  /** The commit the world's product code came from. */
  commit: string;
  /** Uncommitted changes in the product's code: the world runs code no commit describes. */
  dirty: boolean;
  /** The branch it is measured against, e.g. origin/staging. */
  base: string;
  /** Commits on the base that this commit lacks, as of the last fetch; null if there is no such ref. */
  behind: number | null;
  /** When origin was last fetched, so "0 behind" can be read for what it is worth. */
  fetchedAt: Date | null;
}

export interface ProvenanceOptions {
  /** The product's code, relative to the repo: a change anywhere else doesn't change what a world runs. */
  paths?: string[];
  /** The branch it ships from. Default origin/staging. */
  base?: string;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function provenance(repo: string, options: ProvenanceOptions = {}): Provenance {
  const base = options.base ?? 'origin/staging';
  const commit = git(repo, ['rev-parse', 'HEAD']);
  const dirty = git(repo, ['status', '--porcelain', '--', ...(options.paths ?? ['.'])]).length > 0;
  let behind: number | null = null;
  try {
    behind = Number(git(repo, ['rev-list', '--count', `${commit}..${base}`]));
  } catch {
    // No such ref here (a detached archive, a fork): unknown, and reported as unknown.
  }
  let fetchedAt: Date | null = null;
  try {
    const p = git(repo, ['rev-parse', '--git-path', 'FETCH_HEAD']);
    fetchedAt = statSync(isAbsolute(p) ? p : join(repo, p)).mtime;
  } catch {
    // Never fetched.
  }
  return { commit, dirty, base, behind, fetchedAt };
}

/** One line for a report header; a WARNING prefix whenever the world is not running current, committed code. */
export function describeProvenance(p: Provenance): string {
  const short = p.commit.slice(0, 7);
  const name = p.base.replace(/^origin\//, '');
  const fetched = p.fetchedAt ? ` (${name} as of ${p.fetchedAt.toISOString().slice(0, 16)}Z)` : '';
  const problems = [
    ...(p.dirty ? ['uncommitted product changes: no commit describes this code'] : []),
    ...(p.behind ? [`${p.behind} commits behind ${p.base}: findings may already be fixed`] : []),
    ...(p.behind === null ? [`distance from ${name} unknown`] : []),
  ];
  return problems.length
    ? `WARNING — product ${short}${p.dirty ? '+dirty' : ''}: ${problems.join('; ')}${fetched}`
    : `product ${short}, current with ${p.base}${fetched}`;
}
