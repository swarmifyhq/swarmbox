import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PropError, propMaker } from '../../src/device/props.ts';

const dir = mkdtempSync(join(tmpdir(), 'swarmbox-take-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a world's file, taken as a prop", () => {
  const root = join(dir, 'props');
  const props = propMaker(root);
  const src = join(dir, 'export.zip');
  writeFileSync(src, 'PK made-up export');
  const take = (name: string, path = src) => props.take('w1', { name, path, about: 'a made-up export' });

  it('is a copy under its own name, untagged, told apart by its sha256', async () => {
    const p = await take('export.zip');
    expect(p).toMatchObject({
      kind: 'file',
      name: 'export.zip',
      mime: 'application/zip',
      world: 'w1',
      bytes: 17,
    });
    expect(p.tag).toBe('world-file:w1/export.zip');
    expect(p.file.endsWith(join(p.id, 'export.zip'))).toBe(true);
    expect(p.sha256).toBe(createHash('sha256').update('PK made-up export').digest('hex'));
    // The world changing its file afterwards doesn't change the prop.
    writeFileSync(src, 'changed');
    expect(readFileSync(p.file, 'utf8')).toBe('PK made-up export');
    expect(props.get(p.id)).toBe(p);
    writeFileSync(src, 'PK made-up export');
  });

  it('refuses a name that is a path, or . or ..', async () => {
    for (const name of ['../export.zip', 'a/b', '.', '..', ''])
      await expect(take(name)).rejects.toThrow(/plain name/);
  });

  it('copies only a regular file, never through a link, and names no host path when it refuses', async () => {
    const link = join(dir, 'link.zip');
    symlinkSync(src, link);
    const folder = join(dir, 'a-folder');
    mkdirSync(folder);
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const refusals = [
      [link, /is a link/],
      [folder, /isn't a regular file/],
      [fifo, /isn't a regular file/],
      [join(dir, 'missing.zip'), /can't be read \(ENOENT\)/],
    ] as const;
    for (const [path, said] of refusals) {
      const e = await take('x.zip', path).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(PropError);
      expect((e as Error).message).toMatch(said);
      expect((e as Error).message).not.toContain(dir);
    }
    // No folder is left behind by a refusal.
    const left = readdirSync(root).filter((f) => !props.list().some((p) => p.id === f));
    expect(left).toEqual([]);
  });

  it('takes the mime it is given, else octet-stream for an unknown kind', async () => {
    expect((await take('a.bin')).mime).toBe('application/octet-stream');
    const given = await props.take('w1', { name: 'b.dat', path: src, about: 'x', mime: 'text/plain' });
    expect(given.mime).toBe('text/plain');
  });

  it("removes a world's files when the world stops, and the rest when the harness closes", async () => {
    const mine = await take('export.zip');
    const other = await props.take('w2', { name: 'export.zip', path: src, about: 'x' });
    props.dropWorld('w1');
    expect(existsSync(join(root, mine.id))).toBe(false);
    expect(props.list().some((p) => p.world === 'w1')).toBe(false);
    expect(existsSync(other.file)).toBe(true);
    await props.close();
    expect(existsSync(join(root, other.id))).toBe(false);
  });
});
