// How a world describes the code it runs. A finding against stale or uncommitted code has to say so on its
// first line: one was once filed against product code 247 commits behind staging.

import { describe, expect, it } from 'vitest';
import { describeProvenance } from '../../src/provenance.ts';

const commit = 'abcdef0123456789abcdef0123456789abcdef01';
const fetchedAt = new Date('2026-10-16T08:00:00Z');
const base = 'origin/staging';

describe('describeProvenance', () => {
  it('states the commit plainly when the code is current and committed', () => {
    expect(describeProvenance({ commit, dirty: false, base, behind: 0, fetchedAt })).toBe(
      'product abcdef0, current with origin/staging (staging as of 2026-10-16T08:00Z)',
    );
  });
  it('warns when the world runs code behind staging', () => {
    const line = describeProvenance({ commit, dirty: false, base, behind: 247, fetchedAt });
    expect(line).toMatch(/^WARNING/);
    expect(line).toContain('247 commits behind origin/staging');
  });
  it('warns when the product tree has uncommitted changes', () => {
    const line = describeProvenance({ commit, dirty: true, base, behind: 0, fetchedAt });
    expect(line).toMatch(/^WARNING — product abcdef0\+dirty/);
  });
  it('names the branch the product ships from', () => {
    expect(describeProvenance({ commit, dirty: false, base: 'origin/main', behind: 3, fetchedAt })).toBe(
      'WARNING — product abcdef0: 3 commits behind origin/main: findings may already be fixed (main as of 2026-10-16T08:00Z)',
    );
  });
  it('does not claim to be current when it cannot tell', () => {
    expect(describeProvenance({ commit, dirty: false, base, behind: null, fetchedAt: null })).toMatch(
      /^WARNING.*unknown/,
    );
  });
});
