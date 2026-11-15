import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraRefusal, chooseOffered, PropError, propMaker, type Prop } from '../../src/device/props.ts';

const dir = mkdtempSync(join(tmpdir(), 'swarmbox-take-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const src = join(dir, 'export.zip');
writeFileSync(src, 'PK made-up export');
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'taken',
    (e: unknown) => e,
  );

describe("a world's file, taken as a prop", () => {
  const root = join(dir, 'props');
  const props = propMaker(root);
  const take = async (name: string, path = src, world = 'w1') =>
    (await props.take(world, { name, path, about: 'a made-up export' })).prop;

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

  it('copies only a regular file of its own, never through a link, and names no host path when it refuses', async () => {
    const link = join(dir, 'link.zip');
    symlinkSync(src, link);
    const folder = join(dir, 'a-folder');
    mkdirSync(folder);
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    // A folder on the way that is a link, and a file with a second name.
    const real = join(dir, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'inside.zip'), 'PK');
    symlinkSync(real, join(dir, 'via'));
    const shared = join(dir, 'shared.zip');
    writeFileSync(shared, 'PK');
    linkSync(shared, join(dir, 'second-name.zip'));
    const refusals = [
      [link, /is a link/],
      [folder, /isn't a regular file/],
      [fifo, /isn't a regular file/],
      [join(dir, 'via', 'inside.zip'), /reached through a link/],
      [shared, /other names \(a hard link\)/],
      [join(dir, 'missing.zip'), /can't be read \(ENOENT\)/],
    ] as const;
    for (const [path, said] of refusals) {
      const e = await refusal(take('x.zip', path));
      expect(e).toBeInstanceOf(PropError);
      expect((e as Error).message).toMatch(said);
      expect((e as Error).message).not.toContain(dir);
    }
    // No folder is left behind by a refusal.
    expect(readdirSync(root).filter((f) => !props.list().some((p) => p.id === f))).toEqual([]);
  });

  it('takes the mime it is given, else octet-stream for an unknown kind', async () => {
    expect((await take('a.bin')).mime).toBe('application/octet-stream');
    const given = await props.take('w1', { name: 'b.dat', path: src, about: 'x', mime: 'text/plain' });
    expect(given.prop.mime).toBe('text/plain');
  });

  it('runs takes one at a time: several at once all arrive', async () => {
    const all = await Promise.all([1, 2, 3].map(() => take('export.zip')));
    expect(new Set(all.map((p) => p.id)).size).toBe(3);
    for (const p of all) expect(readFileSync(p.file, 'utf8')).toBe('PK made-up export');
  });

  it("removes a world's files when the world stops, and the rest when the harness closes", async () => {
    const mine = await take('export.zip');
    const other = await take('export.zip', src, 'w2');
    props.dropWorld('w1');
    expect(existsSync(join(root, mine.id))).toBe(false);
    expect(props.list().some((p) => p.world === 'w1')).toBe(false);
    expect(existsSync(other.file)).toBe(true);
    // A take asked for as the harness closes is refused, and leaves nothing.
    const late = refusal(take('export.zip', src, 'w2'));
    await props.close();
    expect(((await late) as Error).message).toMatch(/shutting down/);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('limits on world files', () => {
  it('refuses a file over the size limit, and past the total removes the oldest, from any world, and says which', async () => {
    const root = join(dir, 'small');
    const props = propMaker(root, { fileMax: 20, totalMax: 40 });
    const big = join(dir, 'big.zip');
    writeFileSync(big, 'x'.repeat(21));
    await expect(props.take('w1', { name: 'big.zip', path: big, about: 'x' })).rejects.toThrow(/at most/);
    const first = await props.take('w1', { name: 'export.zip', path: src, about: 'x' }); // 17 bytes
    const second = await props.take('w2', { name: 'export.zip', path: src, about: 'x' }); // 34 in all
    expect(second.evicted).toEqual([]);
    const third = await props.take('w2', { name: 'export.zip', path: src, about: 'x' }); // 51: w1's goes
    expect(third.evicted.map((p) => p.id)).toEqual([first.prop.id]);
    expect(existsSync(join(root, first.prop.id))).toBe(false);
    await props.close();
  });

  it("clears what a killed harness left, older than half a day, and keeps a running one's", () => {
    const root = join(dir, 'left');
    mkdirSync(join(root, 'prop_00000001'), { recursive: true });
    mkdirSync(join(root, 'prop_00000002'));
    const old = new Date(Date.now() - 13 * 3600_000);
    utimesSync(join(root, 'prop_00000001'), old, old);
    propMaker(root);
    expect(readdirSync(root)).toEqual(['prop_00000002']);
  });
});

describe('choosing and showing a world file', () => {
  const offer = (name: string) => ({ name, path: src, about: 'x' });
  it('takes the one file by that name; refuses two of a name, or none', () => {
    expect(chooseOffered('w1', [offer('a.zip'), offer('b.zip')], 'b.zip').name).toBe('b.zip');
    expect(() => chooseOffered('w1', [offer('a.zip'), offer('a.zip')], 'a.zip')).toThrow(
      /2 files named "a.zip"/,
    );
    expect(() => chooseOffered('w1', [offer('a.zip')], 'c.zip')).toThrow(
      /offers no file "c.zip"; it offers a.zip/,
    );
  });

  it("a camera shows only its own world's picture, under the size limit", () => {
    const file = (over: Partial<Prop>): Prop => ({
      id: 'prop_1',
      kind: 'file',
      about: 'x',
      file: '/x',
      name: 'a.png',
      mime: 'image/png',
      bytes: 100,
      sha256: '',
      tag: '',
      world: 'w1',
      ...over,
    });
    expect(cameraRefusal(file({}), 'w1')).toBeNull();
    expect(cameraRefusal(file({}), 'w2')).toMatch(/w1's file; this screen is in w2/);
    expect(cameraRefusal(file({ mime: 'application/zip', name: 'a.zip' }), 'w1')).toMatch(/not a picture/);
    expect(cameraRefusal(file({ bytes: 101 }), 'w1', 100)).toMatch(/a camera shows at most/);
    expect(cameraRefusal({ ...file({}), kind: 'photo', world: undefined }, 'w2')).toBeNull();
  });
});
