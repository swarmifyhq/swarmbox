// Props (docs/standins.md, The device and props): things a person makes or carries, a photo of the job, a vendor's
// bill as a PDF, a signature. Swarmbox makes them, so a world never needs a real person's files, and tags each one
// with its id, so a check can later tell which arrived where: visibly in a corner, and inside the file itself (a
// JPEG comment, a PNG text chunk, a line of the PDF's text). A world can also offer files Swarmbox can't draw (an
// export from another system: ProductWorld.files); taken as a prop, such a file is copied as it is, untagged, and
// told apart by its sha256.

import { createHash, randomBytes } from 'node:crypto';
import { constants, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { ProductFile } from '../product.ts';
import { chromium, type Browser } from 'playwright-core';

export type PropKind = 'photo' | 'document' | 'signature' | 'file';

/** Props kept at once; past it the oldest go, with their files. */
export const PROPS_KEPT = 200;

/** The largest file a world can hand over as a prop. */
export const FILE_MAX_BYTES = 512 * 2 ** 20;

/** World files kept at once, in bytes; past it the oldest go. A world's go when it stops. */
export const FILES_TOTAL_MAX_BYTES = 2 * 2 ** 30;

const MIME: Record<string, string> = {
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eml': 'message/rfc822',
  '.pst': 'application/vnd.ms-outlook',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export interface Prop {
  id: string;
  kind: PropKind;
  /** What it shows, as asked for. */
  about: string;
  file: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** The tag inside the file: `swarmbox-prop:<id>`. A world's file carries none: `world-file:<world>/<name>`. */
  tag: string;
  /** For a world's file: the world that offered it. */
  world?: string;
  /** The colour a photo is drawn in, so a frame of it on a screen can be told apart. */
  colour?: string;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A JPEG with a comment segment (FF FE) after its start and its JFIF header (APP0): where a photo carries its tag. */
export function withJpegComment(jpeg: Buffer, text: string): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  // After APP0 when there is one, where strict readers expect it to stay first.
  const at = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  const body = Buffer.from(text, 'latin1');
  const segment = Buffer.alloc(4 + body.length);
  segment.writeUInt16BE(0xfffe, 0);
  segment.writeUInt16BE(body.length + 2, 2);
  body.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, at), segment, jpeg.subarray(at)]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A PNG with a tEXt chunk right after its header: where a signature carries its tag. */
export function withPngText(png: Buffer, keyword: string, text: string): Buffer {
  const IHDR_END = 8 + 25; // signature, then the IHDR chunk (4 length + 4 type + 13 data + 4 crc)
  if (png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const typed = Buffer.concat([Buffer.from('tEXt', 'latin1'), data]);
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  typed.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typed), 8 + data.length);
  return Buffer.concat([png.subarray(0, IHDR_END), chunk, png.subarray(IHDR_END)]);
}

/** A refusal about a prop, worded for the agent: it names no host path. */
export class PropError extends Error {}

/**
 * Copy `from` to `to`, hashing as it goes, without blocking: only a regular file, opened without following a
 * link (O_NOFOLLOW) and without waiting on a pipe (O_NONBLOCK), so a FIFO or a device is refused, not read. The
 * size is counted on what is copied, so a file that grows past the limit midway is refused too.
 */
async function copyRegularFile(
  from: string,
  to: string,
  name: string,
  max: number,
  deadline: number,
): Promise<{ bytes: number; sha256: string }> {
  let source;
  try {
    source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new PropError(`${name} is a link; a world offers its files themselves`);
    throw new PropError(`${name} can't be read (${code ?? 'failed'})`);
  }
  try {
    const st = await source.stat();
    if (!st.isFile()) throw new PropError(`${name} isn't a regular file`);
    // O_NOFOLLOW covers the last part of the path only. Folders on the way are followed (on macOS the temp folder
    // itself sits under a link), so the file is checked against its own folder: it must be that folder's file, not
    // a link to another. A file with other names (a hard link) may be a file the world never made.
    const folderReal = await realpath(dirname(resolve(from)));
    if ((await realpath(from)) !== join(folderReal, basename(from)))
      throw new PropError(`${name} is reached through a link; a world offers its files themselves`);
    if (st.nlink > 1)
      throw new PropError(`${name} has other names (a hard link); a world offers a file of its own`);
    if (st.size > max) throw new PropError(tooBig(name, st.size, max));
    const hash = createHash('sha256');
    let bytes = 0;
    const out = await open(to, 'wx');
    try {
      const chunk = Buffer.alloc(2 ** 20);
      for (let n; (n = (await source.read(chunk, 0, chunk.length, null)).bytesRead) > 0;) {
        bytes += n;
        if (bytes > max) throw new PropError(tooBig(name, bytes, max));
        if (Date.now() > deadline)
          throw new PropError(`${name} took over ${TAKE_MS / 60_000} minutes to copy`);
        hash.update(chunk.subarray(0, n));
        await out.write(chunk, 0, n);
      }
    } finally {
      await out.close();
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await source.close();
  }
}

const mb = (bytes: number) => `${Math.round((bytes / 2 ** 20) * 10) / 10} MB`;
const tooBig = (name: string, bytes: number, max: number) =>
  `${name} is over ${mb(bytes)}; a prop is at most ${mb(max)}`;

/** The one file of a world's offer with this name, or a refusal that says why there isn't one. */
export function chooseOffered(world: string, offered: ProductFile[], name: string): ProductFile {
  const named = offered.filter((x) => x.name === name);
  if (named.length > 1)
    throw new PropError(
      `${world} offers ${named.length} files named "${name}"; its product must name them apart`,
    );
  if (!named.length)
    throw new PropError(
      `${world} offers no file "${name}"; it offers ${offered.map((x) => x.name).join(', ') || 'none'}`,
    );
  return named[0]!;
}

/** The largest world file a screen's camera is shown: each page with the camera open gets all of it. */
export const CAMERA_MAX_BYTES = 8 * 2 ** 20;

/** Why a prop can't go in front of a screen's camera in this world, or null when it can. */
export function cameraRefusal(prop: Prop, screenWorld: string, max = CAMERA_MAX_BYTES): string | null {
  if (prop.kind !== 'file') return null;
  if (prop.world !== screenWorld)
    return `${prop.id} is ${prop.world}'s file; this screen is in ${screenWorld}`;
  if (!prop.mime.startsWith('image/'))
    return `${prop.id} is ${prop.name}, not a picture: a camera can't show it; file_pick it`;
  // Every page with the camera open is sent the whole picture, as a data URL.
  if (prop.bytes > max) return `${prop.id} is ${mb(prop.bytes)}; a camera shows at most ${mb(max)}`;
  return null;
}

/** Limits on a world's files, for tests to set small. */
export interface FileLimits {
  /** The largest one. */
  fileMax: number;
  /** All kept at once. */
  totalMax: number;
}

/** A taken file, and any older ones removed to make room for it (from any world). */
export interface Taken {
  prop: Prop;
  evicted: Prop[];
}

/** Leftovers older than this in the props folder, from a harness that was killed, go when the next one starts. */
const STALE_MS = 12 * 3600_000;

/** The longest one take may copy for; close() waits for one no longer than this. */
const TAKE_MS = 10 * 60_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Clear what a killed harness left in `dir`: its `prop_` entries older than STALE_MS. Never while another live
 * harness uses the same folder (each marks it with `.harness-<pid>`), and one entry that can't be removed never
 * stops the rest. Links are aged by themselves, not their targets. Returns this harness's mark, to remove on close.
 */
export function sweepProps(dir: string): string {
  mkdirSync(dir, { recursive: true });
  let others = false;
  for (const f of readdirSync(dir)) {
    const pid = /^\.harness-(\d+)$/.exec(f)?.[1];
    if (!pid) continue;
    if (Number(pid) !== process.pid && alive(Number(pid))) others = true;
    else if (Number(pid) !== process.pid) rmSync(join(dir, f), { force: true });
  }
  const mark = join(dir, `.harness-${process.pid}`);
  writeFileSync(mark, '');
  if (others) return mark;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('prop_')) continue;
    try {
      if (Date.now() - lstatSync(join(dir, f)).mtimeMs > STALE_MS)
        rmSync(join(dir, f), { recursive: true, force: true });
    } catch {
      /* gone already, or not ours to remove: the rest still go */
    }
  }
  return mark;
}

export interface PropMaker {
  make(kind: Exclude<PropKind, 'file'>, about: string): Promise<Prop>;
  /**
   * Copy a file a world offers (ProductWorld.files) in as a prop, under its own name. Only a regular file, never
   * through a link; at most FILE_MAX_BYTES. Refusals are PropErrors, which name no host path. Takes run one at a
   * time, so copies in flight never pass the limits together.
   */
  take(world: string, file: ProductFile): Promise<Taken>;
  /** Remove a world's files, when the world stops. */
  dropWorld(world: string): void;
  get(id: string): Prop;
  list(): Prop[];
  close(): Promise<void>;
}

/** Makes props into `dir`, drawing them in a headless Chromium of its own, started the first time it's needed. */
export function propMaker(
  dir: string,
  limits: FileLimits = { fileMax: FILE_MAX_BYTES, totalMax: FILES_TOTAL_MAX_BYTES },
): PropMaker {
  const props = new Map<string, Prop>();
  // A harness that was killed left its props behind.
  const mark = sweepProps(dir);
  // One take at a time; and each world's drops counted, so a copy that finishes after its world stopped goes.
  let takes: Promise<unknown> = Promise.resolve();
  const drops = new Map<string, number>();
  let closed = false;
  let browser: Promise<Browser> | undefined;
  // Drawn offline: the HTML is static and escaped, and there's still no reason for this browser to reach anything.
  const page = async () =>
    (
      await (
        await (browser ??= chromium.launch({ channel: 'chromium', headless: true }))
      ).newContext({
        offline: true,
      })
    ).newPage();

  const remove = (p: Prop) =>
    rmSync(p.kind === 'file' ? join(dir, p.id) : p.file, { recursive: true, force: true });
  const keep = (prop: Prop): Prop => {
    props.set(prop.id, prop);
    // At most PROPS_KEPT: the oldest go, with their files.
    while (props.size > PROPS_KEPT) {
      const [oldest, old] = props.entries().next().value!;
      props.delete(oldest);
      remove(old);
    }
    return prop;
  };

  async function takeOne(world: string, f: ProductFile, dropsBefore: number): Promise<Taken> {
    if (closed) throw new PropError('Swarmbox is shutting down');
    if ((drops.get(world) ?? 0) !== dropsBefore)
      throw new PropError(`${world} stopped before ${f.name} was copied`);
    const name = f.name;
    if (!name || name === '.' || name === '..' || basename(name) !== name || name.includes('\0'))
      throw new PropError(`a world's file needs a plain name, not "${name}"`);
    const id = `prop_${randomBytes(4).toString('hex')}`;
    const folder = join(dir, id);
    // In a folder of its own, so the file keeps its name: a chooser given a path names the file by it.
    const path = join(folder, name);
    let copied: { bytes: number; sha256: string };
    try {
      await mkdir(folder, { recursive: true });
      copied = await copyRegularFile(f.path, `${path}.part`, name, limits.fileMax, Date.now() + TAKE_MS);
      await rename(`${path}.part`, path);
      if ((drops.get(world) ?? 0) !== dropsBefore || closed)
        throw new PropError(
          closed ? 'Swarmbox is shutting down' : `${world} stopped while ${name} was copied`,
        );
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      if (e instanceof PropError) throw e;
      // An fs error names host paths: the agent gets the name and the code only.
      throw new PropError(`could not take ${name}: ${(e as NodeJS.ErrnoException).code ?? 'failed'}`);
    }
    const prop = keep({
      id,
      kind: 'file',
      about: f.about.trim().slice(0, 300) || name,
      file: path,
      name,
      mime: f.mime ?? MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
      ...copied,
      tag: `world-file:${world}/${name}`,
      world,
    });
    // Copies are large: past the total, the oldest world files go (from any world), never the one just taken.
    const evicted: Prop[] = [];
    let total = [...props.values()].filter((p) => p.kind === 'file').reduce((n, p) => n + p.bytes, 0);
    for (const old of [...props.values()]) {
      if (total <= limits.totalMax) break;
      if (old.kind !== 'file' || old.id === prop.id) continue;
      props.delete(old.id);
      remove(old);
      evicted.push(old);
      total -= old.bytes;
    }
    return { prop, evicted };
  }

  return {
    async make(kind, about) {
      const text = about.trim().slice(0, 300) || kind;
      const id = `prop_${randomBytes(4).toString('hex')}`;
      const tag = `swarmbox-prop:${id}`;
      const hue = parseInt(id.slice(5, 9), 16) % 360;
      const colour = `hsl(${hue}, 55%, 42%)`;
      const p = await page();
      let file: Buffer;
      let ext: string;
      let mime: string;
      try {
        if (kind === 'photo') {
          await p.setViewportSize({ width: 1280, height: 960 });
          await p.setContent(
            `<body style="margin:0;width:1280px;height:960px;background:${colour};font:600 56px system-ui;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center">` +
              `<div style="max-width:1000px">${escape(text)}</div>` +
              `<div style="position:absolute;right:24px;bottom:18px;font:24px ui-monospace,monospace;opacity:.8">${tag}</div></body>`,
          );
          file = withJpegComment(await p.screenshot({ type: 'jpeg', quality: 85 }), tag);
          [ext, mime] = ['jpg', 'image/jpeg'];
        } else if (kind === 'signature') {
          await p.setViewportSize({ width: 600, height: 200 });
          await p.setContent(
            `<body style="margin:0;background:#fff"><svg width="600" height="200"><path d="M40 140 C 90 40, 130 40, 160 120 S 230 180, 270 90 S 360 40, 400 130 S 500 150, 560 70" ` +
              `fill="none" stroke="#123" stroke-width="5" stroke-linecap="round"/><text x="40" y="190" font-size="14" fill="#999">${escape(text)}</text></svg></body>`,
          );
          file = withPngText(await p.screenshot({ type: 'png' }), 'Comment', tag);
          [ext, mime] = ['png', 'image/png'];
        } else {
          await p.setContent(
            `<body style="font:16px system-ui;padding:48px"><h1 style="font-size:28px">${escape(text)}</h1>` +
              `<p>Made by Swarmbox for a test world. Not a real document.</p>` +
              `<p style="color:#fff;font-size:6px">${tag}</p></body>`,
          );
          file = await p.pdf({ format: 'Letter', printBackground: true });
          [ext, mime] = ['pdf', 'application/pdf'];
        }
      } finally {
        await p.context().close();
      }
      mkdirSync(dir, { recursive: true });
      const name = `${
        text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || kind
      }.${ext}`;
      const path = join(dir, `${id}-${name}`);
      writeFileSync(path, file);
      const prop: Prop = {
        id,
        kind,
        about: text,
        file: path,
        name,
        mime,
        bytes: file.length,
        sha256: createHash('sha256').update(file).digest('hex'),
        tag,
        ...(kind === 'photo' ? { colour } : {}),
      };
      return keep(prop);
    },
    take(world, f) {
      // The world's drops as it asks, not as its turn comes: a take still queued when its world stops is refused.
      const dropsAsked = drops.get(world) ?? 0;
      const run = takes.then(() => takeOne(world, f, dropsAsked));
      takes = run.catch(() => undefined);
      return run;
    },
    dropWorld(world) {
      drops.set(world, (drops.get(world) ?? 0) + 1);
      for (const p of [...props.values()])
        if (p.kind === 'file' && p.world === world) {
          props.delete(p.id);
          remove(p);
        }
    },
    get(id) {
      const prop = props.get(id);
      if (!prop) throw new Error(`no prop ${id}; make one with prop_make`);
      return prop;
    },
    list: () => [...props.values()],
    async close() {
      closed = true;
      // A copy in flight finishes (or fails) first, then goes with the rest.
      await takes;
      const b = await browser?.catch(() => undefined);
      browser = undefined;
      await b?.close();
      // A world's props are for its run: none outlive the harness.
      for (const p of props.values()) remove(p);
      props.clear();
      rmSync(mark, { force: true });
    },
  };
}
