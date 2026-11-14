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
  source,
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
  opts: { url?: string; gate?: Promise<void>; deleted?: string[] } = {},
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
    delete: async () => void (opts.deleted && opts.deleted.push(name)),
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

  it('keeps a JSON file as the file has it: its spacing, 424.10 and a 20-digit id', () => {
    const raw = '{\n  "total": 424.10,\n  "id": 12345678901234567890,\n  "password": "hunter2"\n}\n';
    expect(contents('export.json', Buffer.from(raw), false).text).toBe(raw.replace('hunter2', '[redacted]'));
  });

  it('redacts a secret kept as a number, and leaves other numbers as written', () => {
    const raw = '{"api_key": 123456, "otp":441723, "total": 424.10, "count": 3}';
    expect(contents('k.json', Buffer.from(raw), false).text).toBe(
      '{"api_key": "[redacted]", "otp":"[redacted]", "total": 424.10, "count": 3}',
    );
  });

  it('redacts the columns of a tab-separated .txt by its header, as a UTF-16 export is', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('name\tPortal Token\tTotal\nAda\tabc123\t4\n', 'utf16le'),
    ]);
    expect(contents('export.txt', utf16, false).text).toBe('name\tPortal Token\tTotal\nAda\t[redacted]\t4\n');
    expect(contents('notes.txt', Buffer.from('a line, with a comma\n'), false).text).toBe(
      'a line, with a comma\n',
    );
  });

  it('reads a UTF-8 character cut at the sniffed length as text, and a UTF-16 export by its mark', () => {
    const cut = Buffer.concat([Buffer.from('a'.repeat(64 * 1024 - 1)), Buffer.from('é')]);
    expect(isText('export', cut)).toBe(true);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name\tTotal\nAda\t4\n', 'utf16le')]);
    expect(contents('export.txt', utf16, false).text).toBe('name\tTotal\nAda\t4\n');
  });

  it('leaves long paths, slugs and numbers alone, and still takes a mixed long run', () => {
    const kept =
      '/jobs/1001/invoices/download-final-version-north-2026 the-north-plumbing-and-heating-company-estimate 1234567890123456789012345678901234567890';
    expect(redactWords(kept)).toBe(kept);
    expect(redactWords(`k ${'a1B2'.repeat(12)} k`)).toBe('k [redacted] k');
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

  it('shows a page-made blob whole, a data: address by its type and length, and bounds a long address', () => {
    expect(source('blob:http://north.sample.test:3110/1b4e28ba-2fa1-41d2-883f-0016d3cca427', ORIGIN)).toBe(
      'blob:http://north.sample.test:3110/1b4e28ba-2fa1-41d2-883f-0016d3cca427',
    );
    const data = 'data:text/csv;charset=utf-8,name%2Capi_key%0AAda%2Cabc123secret';
    expect(source(data, ORIGIN)).toBe(`data:text/csv (${data.length} characters)`);
    expect(source(`${ORIGIN}/api/x?q=${'a.b'.repeat(140)}`, ORIGIN)).toMatch(/^\/api\/x\?q=(a\.b)+a?\.?…$/);
    expect(source(`${ORIGIN}/api/x?q=${'a.b'.repeat(140)}`, ORIGIN)).toHaveLength(301);
  });

  it('deletes the browser’s copy once it is read, or once it failed', async () => {
    const deleted: string[] = [];
    const log = downloadLog(ORIGIN);
    log.onDownload(fakeDownload('a.csv', Buffer.from('x'), { deleted }));
    log.onDownload(fakeDownload('b.csv', new Error('gone'), { deleted }));
    await log.settled(0);
    expect(deleted.sort()).toEqual(['a.csv', 'b.csv']);
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
