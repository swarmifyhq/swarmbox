// Ctrl-C belongs to Swarmbox: with a screen open, Playwright's own handler closed the browsers and exited the
// process at once, before a world that was still stopping had stopped (its servers and database left running).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('lets a slow Ctrl-C handler finish while a world’s browser is open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmbox-sigint-'));
  const out = join(dir, 'out');
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/sigint-fleet.ts'), out], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((ready, failed) => {
      child.stdout!.on('data', (d: Buffer) => d.toString().includes('ready') && ready());
      child.once('exit', (code) => failed(new Error(`exited early (${code})`)));
    });
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(existsSync(out) && readFileSync(out, 'utf8')).toBe('done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
