// What a screen saved as a file: an export, a report, a statement. A browser drew nothing for it, so without
// this the agent could press "Download" and never know what came out. Each download is read as it finishes:
// its name, size, a fingerprint, and, for a text file (CSV, JSON, a calendar file…), the text itself, which
// screen_downloads shows. Secrets in the text are redacted as a response body's are (redact.ts).
//
// Read through the download's stream, not its path: the path isn't there when the browser is remote.

import { createHash } from 'node:crypto';
import type { Download } from 'playwright-core';
import { REDACTED, redactText, redactUrl, secretName } from './redact.ts';

export interface DownloadRecord {
  /** Counts the screen's downloads from 1. */
  seq: number;
  at: string;
  /** The name the page gave it. */
  name: string;
  /** Where it came from: a path on the screen's own origin, else the whole address. Secrets redacted. */
  url: string;
  state: 'saving' | 'saved' | 'failed';
  bytes?: number;
  sha256?: string;
  /** A text file's contents (redacted), up to TEXT_KEPT characters. */
  text?: string;
  /** The text was longer than TEXT_KEPT, or the file longer than READ_MAX. */
  cut?: boolean;
  binary?: boolean;
  failure?: string;
}

/** Kept per screen; the oldest go first. */
export const DOWNLOADS_KEPT = 50;
/** Of a file, read for its text; the fingerprint and size cover all of it. */
export const READ_MAX = 10 * 1024 * 1024;
/** Of a text file, kept. */
export const TEXT_KEPT = 500_000;
/** The longest a download is waited for after the action that started it. */
export const DOWNLOAD_WAIT_MS = 30_000;

/** Files whose bytes are text, by name; anything else is text only if it reads as UTF-8. */
const TEXT_NAMES = /\.(csv|tsv|txt|json|xml|ics|vcf|html?|md|iif|ofx|qbo|qfx|log|ya?ml)$/i;
/** How far into a file without a text name its UTF-8 is checked. */
const SNIFF = 64 * 1024;

/**
 * A file's text, or null when it isn't text: UTF-16 by its byte-order mark (a spreadsheet's "Unicode text"
 * export holds NULs, so it's looked for first), else UTF-8 with no NUL. A character cut at the end of what's
 * checked or kept is still text.
 */
export function decodeText(name: string, bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.includes(0)) return null;
  if (!TEXT_NAMES.test(name)) {
    try {
      // stream: a multi-byte character cut at SNIFF is held back, not an error.
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, SNIFF), { stream: true });
    } catch {
      return null;
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Whether these bytes are a text file's. */
export function isText(name: string, bytes: Buffer): boolean {
  return decodeText(name, bytes) !== null;
}

/**
 * A word that is a token by its shape wherever it sits in a file: a JWT or a provider's secret key, and a long
 * run of key characters that mixes letters and digits and isn't a path. A body is redacted only when it is one
 * token (redact.ts); a file is mostly not secret, so its words are looked at one by one. Best effort: a
 * fingerprint or a slug with numbers in it reads as a token, and a short key (32 hex characters) doesn't.
 */
const KNOWN_TOKEN =
  /\beyJ[\w-]+\.[\w-]+\.[\w-]*|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}/g;
const LONG_RUN = /(?<![\w+/=-])[A-Za-z0-9_+/=-]{40,}(?![\w+/=-])/g;

export function redactWords(text: string): string {
  return text
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(LONG_RUN, (w) => (w.startsWith('/') || !/\d/.test(w) || !/[A-Za-z]/.test(w) ? w : REDACTED));
}

/** A row's cells, split on `sep` outside quotes (a quoted cell holding a line break is read as two rows). */
function cells(row: string, sep: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (const ch of row) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/** A table with every cell under a secret-named header ("password", "api_key", "portal token"…) redacted. */
export function redactTable(text: string, sep: string): string {
  const rows = text.split('\n');
  const secret = cells(rows[0] ?? '', sep).map((h) => secretName(h.replace(/^\s*"|"\s*$/g, '').trim()));
  if (!secret.some(Boolean)) return text;
  return [
    rows[0],
    ...rows.slice(1).map((r) =>
      cells(r, sep)
        .map((c, i) => (secret[i] && c.trim() ? REDACTED : c))
        .join(sep),
    ),
  ].join('\n');
}

/** A file's contents as kept: the text (redacted, bounded) or that it's binary. */
export function contents(
  name: string,
  bytes: Buffer,
  longer: boolean,
): Pick<DownloadRecord, 'text' | 'cut' | 'binary'> {
  const raw = decodeText(name, bytes);
  if (raw === null) return { binary: true };
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  // Redacted in place, never reparsed: an export's 424.10 and its 20-digit ids are read as the file has them.
  let text = redactText(raw);
  // A table by its name, or tab-separated text by its first line (a spreadsheet's "Unicode text" is .txt).
  const sep = ext === 'csv' ? ',' : ext === 'tsv' || /^[^\n]*\t/.test(text) ? '\t' : null;
  if (sep) text = redactTable(text, sep);
  text = redactWords(text);
  let cut = longer;
  if (text.length > TEXT_KEPT) {
    text = text.slice(0, TEXT_KEPT);
    cut = true;
  }
  return { text, ...(cut ? { cut } : {}) };
}

/** The longest "from" address shown. */
const URL_SHOWN = 300;

/**
 * Where a download came from, for its line: a path on the screen's own origin, else the whole address, secrets
 * redacted and bounded. A data: address is the file itself, so only its type and length are shown.
 */
export function source(url: string, origin: string): string {
  const data = /^data:([^,;]*)/i.exec(url);
  if (data) return `data:${data[1] || 'text/plain'} (${url.length} characters)`;
  const shown = redactUrl(url, origin);
  return shown.length > URL_SHOWN ? `${shown.slice(0, URL_SHOWN)}…` : shown;
}

export interface DownloadLog {
  records: DownloadRecord[];
  /** The last record's number: an action's downloads are the ones after it. */
  last(): number;
  onDownload(d: Download): void;
  /** Resolves when every download after `seq` has been saved or has failed, or after `ms`. */
  settled(seq: number, ms?: number): Promise<DownloadRecord[]>;
}

/** A screen's log; `origin` is its own, whose addresses are shown as paths. */
export function downloadLog(origin: string): DownloadLog {
  const records: DownloadRecord[] = [];
  const pending = new Map<number, Promise<void>>();
  let seq = 0;
  const read = async (d: Download, rec: DownloadRecord) => {
    try {
      const stream = await d.createReadStream();
      const hash = createHash('sha256');
      const kept: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk);
        if (size < READ_MAX) kept.push(chunk.subarray(0, READ_MAX - size));
        size += chunk.length;
      }
      Object.assign(rec, {
        state: 'saved',
        bytes: size,
        sha256: hash.digest('hex'),
        ...contents(rec.name, Buffer.concat(kept), size > READ_MAX),
      });
    } catch (e) {
      rec.state = 'failed';
      rec.failure = (await d.failure().catch(() => null)) ?? (e as Error).message.split('\n')[0];
    }
    // Read, so the browser's copy goes: it sits in the temp folder, which is memory on some machines.
    await d.delete().catch(() => {});
  };
  return {
    records,
    last: () => seq,
    onDownload(d) {
      const rec: DownloadRecord = {
        seq: ++seq,
        at: new Date().toISOString(),
        name: d.suggestedFilename(),
        url: source(d.url(), origin),
        state: 'saving',
      };
      records.push(rec);
      if (records.length > DOWNLOADS_KEPT) records.shift();
      const done = read(d, rec).finally(() => pending.delete(rec.seq));
      pending.set(rec.seq, done);
    },
    async settled(after, ms = DOWNLOAD_WAIT_MS) {
      const waiting = [...pending].filter(([n]) => n > after).map(([, p]) => p);
      if (waiting.length) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(waiting), new Promise((r) => (timer = setTimeout(r, ms)))]).finally(
          () => clearTimeout(timer),
        );
      }
      return records.filter((r) => r.seq > after);
    },
  };
}

function size(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line for a download: the readout after an action, and screen_downloads' list. */
export function downloadLine(r: DownloadRecord): string {
  const what =
    r.state === 'saving'
      ? 'still saving'
      : r.state === 'failed'
        ? `failed: ${r.failure ?? 'unknown'}`
        : `${size(r.bytes ?? 0)}, ${r.binary ? 'binary' : `text${r.cut ? ', cut' : ''}`}`;
  return `#${r.seq} ${r.name} (${what}) from ${r.url}`;
}

/** One download in full: its line, fingerprint and text from `offset`, at most `limit` characters. */
export function downloadText(r: DownloadRecord, offset = 0, limit = 20_000): string {
  const head = `${downloadLine(r)}${r.sha256 ? `\nsha256 ${r.sha256}` : ''}`;
  if (r.state !== 'saved') return head;
  if (r.binary) return `${head}\nA binary file: its contents aren't shown.`;
  const text = r.text ?? '';
  const part = text.slice(offset, offset + limit);
  const more =
    offset + limit < text.length
      ? `\n… ${text.length - offset - limit} more characters: offset ${offset + limit}`
      : '';
  const cut = r.cut ? '\n(the file was longer than Swarmbox keeps; the rest is not shown)' : '';
  return `${head}\n---\n${part}${more}${!more ? cut : ''}`;
}
