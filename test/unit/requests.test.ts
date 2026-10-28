import { describe, expect, it } from 'vitest';
import {
  pendingSince,
  redactBody,
  redactUrl,
  requestLine,
  selectRequests,
  type RequestRecord,
} from '../../src/requests.ts';

const JWT = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..abc123.def456.ghi789';

describe('what a screen’s request log keeps', () => {
  it('shows its own origin’s addresses as paths, and redacts secret query values and tokens in the path', () => {
    expect(redactUrl('http://north.sample.test:3110/api/jobs?page=2', 'http://north.sample.test:3110')).toBe(
      '/api/jobs?page=2',
    );
    expect(
      redactUrl('http://north.sample.test:3110/api/live?token=abc&since=4', 'http://north.sample.test:3110'),
    ).toBe('/api/live?token=[redacted]&since=4');
    expect(redactUrl(`http://x.test/p/${'a'.repeat(48)}`)).toBe('http://x.test/p/[redacted]');
    // An id is not a secret.
    expect(redactUrl('http://x.test/jobs/3f2b8c1e-0d4a-4c3b-9e1f-2a7b6c5d4e3f')).toBe(
      'http://x.test/jobs/3f2b8c1e-0d4a-4c3b-9e1f-2a7b6c5d4e3f',
    );
  });

  it('redacts JSON by key and by shape, a form by field, and a body that is only a token', () => {
    const json = JSON.parse(
      redactBody(
        JSON.stringify({
          email: 'ana@x.test',
          password: 'hunter2',
          nested: { apiKey: 'k', note: JWT },
          otp: 123456,
        }),
        'application/json',
      ),
    ) as Record<string, unknown>;
    expect(json).toEqual({
      email: 'ana@x.test',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', note: '[redacted]' },
      otp: '[redacted]',
    });
    expect(redactBody('To=%2B15550100&AuthToken=abc', 'application/x-www-form-urlencoded')).toBe(
      'To=%2B15550100&AuthToken=[redacted]',
    );
    expect(redactBody(`Bearer ${'x'.repeat(30)}`)).toBe('[redacted]');
    expect(redactBody('+15550100')).toBe('+15550100');
    // By the name's last words: a setting about signatures is not a secret, a header's key is.
    expect(
      redactBody(
        '{"two_signature_threshold":"25000.00","x-api-key":"k","sessionId":"s","sid":"AC1"}',
        'application/json',
      ),
    ).toBe(
      '{"two_signature_threshold":"25000.00","x-api-key":"[redacted]","sessionId":"[redacted]","sid":"AC1"}',
    );
    // Words that only contain "pass" are not secrets.
    expect(redactBody('{"passenger":"Ana","bypass":false}', 'application/json')).toBe(
      '{"passenger":"Ana","bypass":false}',
    );
  });

  it('leaves out the page’s assets unless asked, narrows by address and #number, and says what is still open', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const rec = (
      seq: number,
      type: string,
      url: string,
      more: Partial<RequestRecord> = {},
    ): RequestRecord => ({
      seq,
      at,
      method: 'GET',
      url,
      type,
      state: 'done',
      status: 200,
      ms: 12,
      ...more,
    });
    const records = [
      rec(1, 'document', '/'),
      rec(2, 'script', '/_next/app.js'),
      rec(3, 'eventsource', '/api/live/stream', { state: 'open' }),
      rec(4, 'fetch', '/api/approve', {
        method: 'POST',
        status: 400,
        sent: '{"note":"x"}',
        got: '{"detail":"no"}',
      }),
    ];
    expect(selectRequests(records).map((r) => r.seq)).toEqual([1, 3, 4]);
    expect(selectRequests(records, { all: true }).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(selectRequests(records, { match: '/API/' }).map((r) => r.seq)).toEqual([3, 4]);
    expect(selectRequests(records, { after: 3 }).map((r) => r.seq)).toEqual([4]);
    expect(selectRequests(records, { limit: 1 }).map((r) => r.seq)).toEqual([4]);

    const now = Date.parse(at) + 61_000;
    expect(requestLine(records[2]!, now)).toBe(
      '#3 10:00:00.000 GET /api/live/stream → 200 open for 61.0 s eventsource',
    );
    expect(requestLine(records[3]!, now, true)).toBe(
      '#4 10:00:00.000 POST /api/approve → 400 (12 ms)\n    sent: {"note":"x"}\n    got: {"detail":"no"}',
    );
    expect(requestLine(records[3]!, now)).not.toContain('sent:');
  });

  it('says which of an action’s requests are still to wait for: not a stream, not an asset, not one before it', () => {
    const r = (seq: number, type: string, more: Partial<RequestRecord> = {}): RequestRecord => ({
      seq,
      at: '2026-10-28T10:00:00.000Z',
      method: 'GET',
      url: `/r${seq}`,
      type,
      state: 'open',
      ...more,
    });
    const records = [
      r(1, 'fetch'),
      r(2, 'fetch', { method: 'POST' }),
      r(3, 'fetch', { state: 'done', status: 200 }),
      r(4, 'eventsource'),
      r(5, 'fetch', { status: 200, contentType: 'text/event-stream' }),
      r(6, 'image'),
      r(7, 'document'),
      r(8, 'xhr', { state: 'failed' }),
    ];
    expect(pendingSince(records, 1).map((x) => x.seq)).toEqual([2, 7]);
    expect(pendingSince(records, 7)).toEqual([]);
  });
});
