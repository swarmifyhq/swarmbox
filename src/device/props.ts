// Props (docs/standins.md, The device and props): things a person makes or carries, a photo of the job, a vendor's
// bill as a PDF, a signature. Swarmbox makes them, so a world never needs a real person's files, and tags each one
// with its id, so a check can later tell which arrived where: visibly in a corner, and inside the file itself (a
// JPEG comment, a PNG text chunk, a line of the PDF's text).

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

export type PropKind = 'photo' | 'document' | 'signature';

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
  /** The tag inside the file: `swarmbox-prop:<id>`. */
  tag: string;
  /** The colour a photo is drawn in, so a frame of it on a screen can be told apart. */
  colour?: string;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A JPEG with a comment segment (FF FE) right after its start: where a photo carries its tag. */
export function withJpegComment(jpeg: Buffer, text: string): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  const body = Buffer.from(text, 'latin1');
  const segment = Buffer.alloc(4 + body.length);
  segment.writeUInt16BE(0xfffe, 0);
  segment.writeUInt16BE(body.length + 2, 2);
  body.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
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

export interface PropMaker {
  make(kind: PropKind, about: string): Promise<Prop>;
  get(id: string): Prop;
  list(): Prop[];
  close(): Promise<void>;
}

/** Makes props into `dir`, drawing them in a headless Chromium of its own, started the first time it's needed. */
export function propMaker(dir: string): PropMaker {
  const props = new Map<string, Prop>();
  let browser: Promise<Browser> | undefined;
  const page = async () =>
    (await (browser ??= chromium.launch({ channel: 'chromium', headless: true }))).newPage();

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
        await p.close();
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
      props.set(id, prop);
      return prop;
    },
    get(id) {
      const prop = props.get(id);
      if (!prop) throw new Error(`no prop ${id}; make one with prop_make`);
      return prop;
    },
    list: () => [...props.values()],
    async close() {
      const b = await browser?.catch(() => undefined);
      browser = undefined;
      await b?.close();
    },
  };
}
