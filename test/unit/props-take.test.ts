import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { propMaker } from '../../src/device/props.ts';

const dir = mkdtempSync(join(tmpdir(), 'swarmbox-take-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a world's file, taken as a prop", () => {
  const props = propMaker(join(dir, 'props'));
  const src = join(dir, 'export.zip');
  writeFileSync(src, 'PK made-up export');

  it('is a copy under its own name, untagged, told apart by its sha256', () => {
    const p = props.take('w1', { name: 'export.zip', path: src, about: 'a made-up export' });
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
  });

  it('refuses a name that is a path', () => {
    expect(() => props.take('w1', { name: '../export.zip', path: src, about: 'x' })).toThrow(/plain name/);
  });

  it('takes the mime it is given, else octet-stream for an unknown kind', () => {
    expect(props.take('w1', { name: 'a.bin', path: src, about: 'x' }).mime).toBe('application/octet-stream');
    expect(props.take('w1', { name: 'b.dat', path: src, about: 'x', mime: 'text/plain' }).mime).toBe(
      'text/plain',
    );
  });

  it('removes its folder when the harness closes', async () => {
    const p = props.take('w1', { name: 'export.zip', path: src, about: 'x' });
    await props.close();
    expect(existsSync(join(dir, 'props', p.id))).toBe(false);
  });
});
