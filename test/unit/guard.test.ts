import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CHARS, FAILURE_LINES, failureText, guard } from '../../src/mcp/server.ts';

const said = (r: Awaited<ReturnType<typeof guard>>) => (r.content[0] as { text: string }).text;

describe('a tool that fails', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the agent the lines below the first, where a seed script’s traceback is', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const traceback = [
      '<python> world_seed.py failed (1):',
      'Traceback (most recent call last):',
      '  File "world_seed.py", line 12, in <module>',
      'ExtrasError: the seed needs the extra "demo"',
    ].join('\n');
    const result = await guard(async () => {
      throw new Error(traceback);
    });
    expect(result.isError).toBe(true);
    expect(said(result)).toBe(`failed: ${traceback}`);
    expect(err).toHaveBeenCalledWith(`swarmbox: a tool failed: ${traceback}\n`);
  });

  it('keeps at most FAILURE_LINES lines, and says it cut the rest', () => {
    const many = Array.from({ length: FAILURE_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
    const got = failureText(many).split('\n');
    expect(got).toHaveLength(FAILURE_LINES + 1);
    expect(got[FAILURE_LINES - 1]).toBe(`line ${FAILURE_LINES - 1}`);
    expect(got[FAILURE_LINES]).toMatch(/^… \(cut; the whole message is in serve's output\)$/);
  });

  it('keeps at most FAILURE_CHARS characters of one long line', () => {
    const got = failureText('x'.repeat(FAILURE_CHARS * 3));
    expect(got.startsWith('x'.repeat(FAILURE_CHARS) + '\n… (cut')).toBe(true);
    expect(got.length).toBeLessThan(FAILURE_CHARS + 60);
  });

  it('leaves a one-line failure as it was', () => {
    expect(failureText('port 5432 is taken\n')).toBe('port 5432 is taken');
  });
});
