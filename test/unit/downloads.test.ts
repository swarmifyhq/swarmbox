import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { Download } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import {
  contents,
  downloadLine,
  downloadLog,
  downloadText,
  DOWNLOADS_KEPT,
  isText,
  redactTable,
  redactWords,
  TEXT_KEPT,
  type DownloadRecord,
} from '../../src/downloads.ts';

const ORIGIN = 'http://north.sample.test:3110';

/** A download as Playwright hands it over: its bytes come through a stream, maybe late, maybe not at all. */
function fakeDownload(
  name: string,
  bytes: Buffer | Error,
  opts: { url?: string; gate?: Promise<void> } = {},
): Download {
  return {
    suggestedFilename: () => name,
    url: () => opts.url ?? `${ORIGIN}/api/export/${name}`,
    async createReadStream() {
      await opts.gate;
      if (bytes instanceof Error) throw bytes;
      return Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]);
    },
    failure: async () => (bytes instanceof Error ? 'canceled' : null),
  } as unknown as Download;
}

describe('which downloads are text', () => {
  it('reads text by name, or as UTF-8 with no NUL, and never a file holding a NUL', () => {
    expect(isText('jobs.csv', Buffer.from('a,b\n1,2\n'))).toBe(true);
    expect(isText('export', Buffer.from('{"ok":true}'))).toBe(true);
    expect(isText('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isText('report.csv', Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
  });

  it('keeps a text file’s contents with secrets redacted, and only says a binary one is binary', () => {
    const csv = contents(
      'keys.json',
      Buffer.from('{"name":"North","apiKey":"sk_live_abcdefghijklmnop"}'),
      false,
    );
    expect(csv.text).toContain('North');
    expect(csv.text).not.toContain('sk_live_abcdefghijklmnop');
    expect(contents('a.pdf', Buffer.from([0x25, 0x50, 0x00, 0x46]), false)).toEqual({ binary: true });
  });

  it('redacts token-shaped words anywhere in a file, and leaves ordinary words and ids alone', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const key = `sk_live_${'Ab3'.repeat(10)}`;
    const long = 'Q'.repeat(20) + 'r9'.repeat(15);
    expect(redactWords(`Ada Lovelace,${jwt},${key};note ${long} end`)).toBe(
      'Ada Lovelace,[redacted],[redacted];note [redacted] end',
    );
    const ordinary =
      'job 1001, 3f2a6c1e-8b7d-4e0f-9a1b-2c3d4e5f6a7b, 2026-11-13, Water heater (50 gal), $424.31';
    expect(redactWords(ordinary)).toBe(ordinary);
  });

  it('redacts a table’s cells under a secret-named header, quoted commas kept together', () => {
    expect(redactTable('name,api_key,total\n"Doe, Ada",abc123,4\nLee,,5', ',')).toBe(
      'name,api_key,total\n"Doe, Ada",[redacted],4\nLee,,5',
    );
    expect(redactTable('name\tPortal Token\nAda\txyz', '\t')).toBe('name\tPortal Token\nAda\t[redacted]');
    expect(redactTable('a,b\n1,2', ',')).toBe('a,b\n1,2');
  });

  it('cuts text longer than it keeps, and says so', () => {
    const rows = '1001,Water heater,424.31\n'.repeat(Math.ceil(TEXT_KEPT / 20) + 10);
    const long = contents('big.csv', Buffer.from(rows), false);
    expect(long.text).toHaveLength(TEXT_KEPT);
    expect(long.cut).toBe(true);
    expect(contents('part.txt', Buffer.from('abc'), true).cut).toBe(true);
    expect(contents('small.txt', Buffer.from('abc'), false).cut).toBeUndefined();
  });
});

describe('a screen’s download log', () => {
  it('reads each download through its stream: name, size, fingerprint and text, with its address as a path', async () => {
    const log = downloadLog(ORIGIN);
    const bytes = Buffer.from('Job,Total\n1001,424.31\n');
    log.onDownload(fakeDownload('jobs.csv', bytes));
    const [rec] = await log.settled(0);
    expect(rec).toMatchObject({
      seq: 1,
      name: 'jobs.csv',
      url: '/api/export/jobs.csv',
      state: 'saved',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      text: 'Job,Total\n1001,424.31\n',
    });
  });

  it('gives an action only the downloads it started, waiting until they are read', async () => {
    const log = downloadLog(ORIGIN);
    log.onDownload(fakeDownload('earlier.csv', Buffer.from('a')));
    await log.settled(0);
    const before = log.last();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    log.onDownload(fakeDownload('now.csv', Buffer.from('b,c'), { gate }));
    const waiting = log.settled(before);
    expect(log.records.at(-1)?.state).toBe('saving');
    open();
    const got = await waiting;
    expect(got.map((r) => [r.name, r.state])).toEqual([['now.csv', 'saved']]);
  });

  it('stops waiting after its limit, leaving a slow download saving', async () => {
    const log = downloadLog(ORIGIN);
    log.onDownload(fakeDownload('slow.csv', Buffer.from('x'), { gate: new Promise(() => {}) }));
    const [rec] = await log.settled(0, 20);
    expect(rec?.state).toBe('saving');
    expect(downloadLine(rec!)).toBe('#1 slow.csv (still saving) from /api/export/slow.csv');
  });

  it('records a failed download with the browser’s reason', async () => {
    const log = downloadLog(ORIGIN);
    log.onDownload(fakeDownload('gone.csv', new Error('stream closed\nat …')));
    const [rec] = await log.settled(0);
    expect(rec).toMatchObject({ state: 'failed', failure: 'canceled' });
  });

  it('keeps the newest DOWNLOADS_KEPT, numbering on from the oldest dropped', async () => {
    const log = downloadLog(ORIGIN);
    for (let i = 0; i < DOWNLOADS_KEPT + 2; i++) log.onDownload(fakeDownload(`f${i}.txt`, Buffer.from('x')));
    await log.settled(0);
    expect(log.records).toHaveLength(DOWNLOADS_KEPT);
    expect(log.records[0]?.seq).toBe(3);
    expect(log.last()).toBe(DOWNLOADS_KEPT + 2);
  });

  it('redacts a secret in another origin’s address', () => {
    const log = downloadLog(ORIGIN);
    log.onDownload(
      fakeDownload('s.csv', Buffer.from('x'), { url: 'https://files.sample.test/s.csv?token=abc' }),
    );
    expect(log.records[0]?.url).toBe('https://files.sample.test/s.csv?token=[redacted]');
  });
});

describe('reading a download', () => {
  const saved = (over: Partial<DownloadRecord>): DownloadRecord => ({
    seq: 2,
    at: '2026-11-13T00:00:00Z',
    name: 'jobs.csv',
    url: '/api/export',
    state: 'saved',
    bytes: 2048,
    sha256: 'ab12',
    ...over,
  });

  it('names size and kind on its line', () => {
    expect(downloadLine(saved({ text: 'x' }))).toBe('#2 jobs.csv (2.0 KB, text) from /api/export');
    expect(downloadLine(saved({ binary: true, bytes: 12 }))).toBe(
      '#2 jobs.csv (12 B, binary) from /api/export',
    );
    expect(downloadLine(saved({ state: 'failed', failure: 'canceled' }))).toBe(
      '#2 jobs.csv (failed: canceled) from /api/export',
    );
  });

  it('pages a text file’s contents and says where the next page starts', () => {
    const r = saved({ text: 'abcdefghij' });
    expect(downloadText(r, 0, 4)).toBe(
      '#2 jobs.csv (2.0 KB, text) from /api/export\nsha256 ab12\n---\nabcd\n… 6 more characters: offset 4',
    );
    expect(downloadText(r, 8, 4)).toBe('#2 jobs.csv (2.0 KB, text) from /api/export\nsha256 ab12\n---\nij');
  });

  it('says a cut file’s rest isn’t kept on its last page, and shows no contents for a binary one', () => {
    expect(downloadText(saved({ text: 'abc', cut: true }))).toMatch(
      /abc\n\(the file was longer than Swarmbox keeps/,
    );
    expect(downloadText(saved({ binary: true }))).toMatch(/A binary file: its contents aren't shown\.$/);
  });
});
