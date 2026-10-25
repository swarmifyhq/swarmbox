// The S3 stand-in against a client that signs as AWS documents Signature Version 4 (written here, not shared with
// the stand-in): a bucket, header-signed puts with Content-MD5, presigned puts that sign their SHA-256, heads with
// checksums, ranges, an upload in parts, the browser's preflight, and the refusals a real bucket gives.

import { createHash, createHmac } from 'node:crypto';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinStandIn } from '../src/standins/builtin/index.ts';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';

const SANDBOX = process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amz = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

interface Signed {
  url: string;
  headers: Record<string, string>;
}
/** A SigV4 request, header-signed or (presign: seconds) query-signed. */
function sign(
  creds: { accessKeyId: string; secretAccessKey: string },
  method: string,
  origin: string,
  path: string,
  o: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Buffer;
    presign?: number;
    at?: Date;
    /** x-amz-content-sha256 as given (a STREAMING- value), or none at all. */
    payload?: string | null;
    region?: string;
    service?: string;
    /** The credential's date, when not the request's own. */
    day?: string;
  } = {},
): Signed & { signature: string; amzDate: string; scope: string; key: Buffer } {
  const at = o.at ?? new Date();
  const t = amz(at);
  const day = o.day ?? t.slice(0, 8);
  const region = o.region ?? 'auto';
  const service = o.service ?? 's3';
  const scope = `${day}/${region}/${service}/aws4_request`;
  const host = new URL(origin).host;
  const headers: Record<string, string> = { host, ...(o.headers ?? {}) };
  const query: Record<string, string> = { ...(o.query ?? {}) };
  const payload = o.payload ?? (o.presign ? 'UNSIGNED-PAYLOAD' : sha(o.body ?? ''));
  if (o.presign) {
    Object.assign(query, {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
      'X-Amz-Date': t,
      'X-Amz-Expires': String(o.presign),
      'X-Amz-SignedHeaders': Object.keys(headers)
        .map((k) => k.toLowerCase())
        .sort()
        .join(';'),
    });
  } else {
    headers['x-amz-date'] = t;
    if (o.payload !== null) headers['x-amz-content-sha256'] = payload;
  }
  const names = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort()
    .join('&');
  const canonical = [
    method,
    path.split('/').map(rfc3986).join('/'),
    canonicalQuery,
    names.map((n) => `${n}:${lower[n]!.trim()}\n`).join(''),
    names.join(';'),
    payload,
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha(canonical)].join('\n');
  let key: Buffer = createHmac('sha256', `AWS4${creds.secretAccessKey}`).update(day).digest();
  for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  if (o.presign) {
    query['X-Amz-Signature'] = signature;
    const qs = Object.entries(query)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join('&');
    return {
      url: `${origin}${path}?${qs}`,
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host')),
      signature,
      amzDate: t,
      scope,
      key,
    };
  }
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const qs = canonicalQuery ? `?${canonicalQuery}` : '';
  return {
    url: `${origin}${path}${qs}`,
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host')),
    signature,
    amzDate: t,
    scope,
    key,
  };
}

/** One chunk's signature, as AWS documents signed streaming uploads; `trailer` for the trailing headers'. */
const chunkSignature = (
  key: Buffer,
  amzDate: string,
  scope: string,
  prev: string,
  data: Buffer | string,
  kind: 'PAYLOAD' | 'TRAILER' = 'PAYLOAD',
) =>
  createHmac('sha256', key)
    .update(
      [
        `AWS4-HMAC-SHA256-${kind}`,
        amzDate,
        scope,
        prev,
        ...(kind === 'PAYLOAD' ? [sha('')] : []),
        sha(data),
      ].join('\n'),
    )
    .digest('hex');

/** A body framed aws-chunked, every chunk signed in turn, with a signed trailer when one is given. */
function chunked(
  s: { key: Buffer; amzDate: string; scope: string; signature: string },
  pieces: Buffer[],
  trailer?: string,
): Buffer {
  let prev = s.signature;
  const out: Buffer[] = [];
  for (const p of [...pieces, Buffer.alloc(0)]) {
    prev = chunkSignature(s.key, s.amzDate, s.scope, prev, p);
    out.push(Buffer.from(`${p.length.toString(16)};chunk-signature=${prev}\r\n`), p);
    if (p.length) out.push(Buffer.from('\r\n'));
  }
  if (trailer === undefined) out.push(Buffer.from('\r\n'));
  else {
    const t = chunkSignature(s.key, s.amzDate, s.scope, prev, `${trailer}\n`, 'TRAILER');
    out.push(Buffer.from(`${trailer}\r\nx-amz-trailer-signature:${t}\r\n\r\n`));
  }
  return Buffer.concat(out);
}

describe('signed streaming, as AWS documents it', () => {
  it('signs chunks to AWS’s own example values', () => {
    let key = createHmac('sha256', 'AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
      .update('20130524')
      .digest();
    for (const p of ['us-east-1', 's3', 'aws4_request']) key = createHmac('sha256', key).update(p).digest();
    const scope = '20130524/us-east-1/s3/aws4_request';
    let prev = '4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9';
    const got = [65536, 1024, 0].map(
      (n) => (prev = chunkSignature(key, '20130524T000000Z', scope, prev, Buffer.alloc(n, 'a'))),
    );
    expect(got).toEqual([
      'ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648',
      '0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497',
      'b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9',
    ]);
  });
});

describe('the S3 stand-in', () => {
  let s3: StandIn;
  let creds: { accessKeyId: string; secretAccessKey: string };
  const go = async (method: string, path: string, o: Parameters<typeof sign>[4] = {}) => {
    const r = sign(creds, method, s3.baseUrls.endpoint!, path, o);
    return fetch(r.url, {
      method,
      headers: r.headers,
      ...(o.body && !o.presign ? { body: new Uint8Array(o.body) } : {}),
    });
  };

  beforeAll(async () => {
    s3 = await startStandIn({
      ...builtinStandIn('s3'),
      deliverTo: 'http://127.0.0.1:9',
      baseDomain: 'sample.test',
      sandbox: SANDBOX,
      onStderr: (t) => process.stderr.write(t),
    });
    creds = (await s3.account('platform')) as typeof creds;
    expect((await go('PUT', '/files')).status).toBe(200);
  });
  afterAll(() => s3.stop());

  it('stores what a header-signed put sends, checks its Content-MD5, and reads it back whole or in part', async () => {
    const body = Buffer.from('the nightly backup, part one');
    const md5 = createHash('md5').update(body).digest('base64');
    const put = await go('PUT', '/files/t/acme/backup.txt', {
      body,
      headers: { 'content-md5': md5, 'content-type': 'text/plain' },
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBe(`"${createHash('md5').update(body).digest('hex')}"`);
    const wrong = await go('PUT', '/files/t/acme/backup.txt', {
      body,
      headers: { 'content-md5': createHash('md5').update('x').digest('base64') },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('<Code>BadDigest</Code>');

    const head = await go('HEAD', '/files/t/acme/backup.txt', {
      headers: { 'x-amz-checksum-mode': 'ENABLED' },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(body.length));
    // No checksum sent, so S3's own: a CRC64NVME of the whole object (the SDK test checks its value).
    expect(head.headers.get('x-amz-checksum-crc64nvme')).toMatch(/^[A-Za-z0-9+/]{11}=$/);
    expect(head.headers.get('x-amz-checksum-type')).toBe('FULL_OBJECT');
    expect(await (await go('GET', '/files/t/acme/backup.txt')).text()).toBe(body.toString());
    const part = await go('GET', '/files/t/acme/backup.txt', { headers: { range: 'bytes=4-9' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('nightl');
    expect((await go('DELETE', '/files/t/acme/backup.txt')).status).toBe(204);
    expect((await go('GET', '/files/t/acme/backup.txt')).status).toBe(404);
  });

  it('takes a presigned put of the exact bytes it signed, and refuses others', async () => {
    const photo = Buffer.from('a jpeg, honestly');
    const sum = createHash('sha256').update(photo).digest('base64');
    const signed = sign(creds, 'PUT', s3.baseUrls.endpoint!, '/files/t/acme/photo.jpg', {
      presign: 900,
      headers: {
        'content-length': String(photo.length),
        'content-type': 'image/jpeg',
        'x-amz-checksum-sha256': sum,
      },
    });
    const ok = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(photo),
    });
    expect(ok.status).toBe(200);
    const other = Buffer.from('a jpeg, not hone');
    const bad = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(other),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('BadDigest');
  });

  it('refuses a wrong signature, a clock off by 20 minutes, an expired link and an unknown key, as S3 does', async () => {
    const tampered = sign(creds, 'GET', s3.baseUrls.endpoint!, '/files/t/acme/photo.jpg');
    const r1 = await fetch(tampered.url.replace('photo', 'phot0'), { headers: tampered.headers });
    expect(await r1.text()).toContain('SignatureDoesNotMatch');
    const skewed = await go('GET', '/files/t/acme/photo.jpg', { at: new Date(Date.now() - 20 * 60_000) });
    expect(await skewed.text()).toContain('RequestTimeTooSkewed');
    const old = sign(creds, 'GET', s3.baseUrls.endpoint!, '/files/t/acme/photo.jpg', {
      presign: 60,
      at: new Date(Date.now() - 120_000),
    });
    expect(await (await fetch(old.url)).text()).toContain('Request has expired');
    const stranger = sign(
      { accessKeyId: 'swarmbox_nobody', secretAccessKey: 'x' },
      'GET',
      s3.baseUrls.endpoint!,
      '/files/t/acme/photo.jpg',
    );
    expect(await (await fetch(stranger.url, { headers: stranger.headers })).text()).toContain(
      'InvalidAccessKeyId',
    );
  });

  it('takes an upload in parts: starts, lists parts, lists unfinished uploads, joins, aborts', async () => {
    const xml = async (r: Response) => r.text();
    const start = await xml(await go('POST', '/files/t/acme/video.mp4', { query: { uploads: '' } }));
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(start)![1]!;
    // S3's rule: every part but the last at least 5 MB.
    const parts = [Buffer.alloc(5 * 1024 * 1024, 1), Buffer.alloc(1024, 2)];
    const etags: string[] = [];
    for (const [i, p] of parts.entries()) {
      const r = await go('PUT', '/files/t/acme/video.mp4', {
        query: { partNumber: String(i + 1), uploadId },
        body: p,
      });
      expect(r.status).toBe(200);
      etags.push(r.headers.get('etag')!);
    }
    const listed = await xml(await go('GET', '/files/t/acme/video.mp4', { query: { uploadId } }));
    expect([...listed.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => m[1])).toEqual(['1', '2']);
    const unfinished = await xml(await go('GET', '/files/', { query: { uploads: '', prefix: 't/acme/' } }));
    expect(unfinished).toContain(`<UploadId>${uploadId}</UploadId>`);

    const complete = (order: number[]) =>
      Buffer.from(
        `<CompleteMultipartUpload>${order.map((n) => `<Part><PartNumber>${n}</PartNumber><ETag>${etags[n - 1]}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
      );
    const backwards = await go('POST', '/files/t/acme/video.mp4', {
      query: { uploadId },
      body: complete([2, 1]),
    });
    expect(await xml(backwards)).toContain('<Code>InvalidPartOrder</Code>');
    const done = complete([1, 2]);
    const joined = await xml(
      await go('POST', '/files/t/acme/video.mp4', { query: { uploadId }, body: done }),
    );
    // S3 writes the ETag's quotes escaped in XML, as &quot;.
    expect(joined).toMatch(/<ETag>&quot;[0-9a-f]{32}-2&quot;<\/ETag>/);
    const back = Buffer.from(await (await go('GET', '/files/t/acme/video.mp4')).arrayBuffer());
    expect(back.equals(Buffer.concat(parts))).toBe(true);

    // A small part anywhere but last is refused, as S3 refuses it.
    const small = /<UploadId>([^<]+)<\/UploadId>/.exec(
      await xml(await go('POST', '/files/t/acme/small.bin', { query: { uploads: '' } })),
    )![1]!;
    const smallTags: string[] = [];
    for (const n of [1, 2])
      smallTags.push(
        (
          await go('PUT', '/files/t/acme/small.bin', {
            query: { partNumber: String(n), uploadId: small },
            body: Buffer.alloc(1024, n),
          })
        ).headers.get('etag')!,
      );
    const tooSmall = await go('POST', '/files/t/acme/small.bin', {
      query: { uploadId: small },
      body: Buffer.from(
        `<CompleteMultipartUpload>${smallTags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
      ),
    });
    expect(await xml(tooSmall)).toContain('<Code>EntityTooSmall</Code>');

    const another = /<UploadId>([^<]+)<\/UploadId>/.exec(
      await xml(await go('POST', '/files/t/acme/v2.mp4', { query: { uploads: '' } })),
    )![1]!;
    expect((await go('DELETE', '/files/t/acme/v2.mp4', { query: { uploadId: another } })).status).toBe(204);
    expect(
      await xml(await go('GET', '/files/', { query: { uploads: '', prefix: 't/acme/' } })),
    ).not.toContain(another);
  });

  it('takes a signed aws-chunked upload, checks every chunk’s signature and the trailer’s, and stores the bytes', async () => {
    const pieces = [Buffer.alloc(9000, 'x'), Buffer.from('the end')];
    const bytes = Buffer.concat(pieces);
    const put = async (payload: string, frame: (s: ReturnType<typeof sign>) => Buffer, extra = {}) => {
      const headers = {
        'content-encoding': 'aws-chunked',
        'x-amz-decoded-content-length': String(bytes.length),
        ...extra,
      };
      const s = sign(creds, 'PUT', s3.baseUrls.endpoint!, '/files/t/acme/chunked.bin', { headers, payload });
      return fetch(s.url, { method: 'PUT', headers: s.headers, body: new Uint8Array(frame(s)) });
    };
    const plain = await put('STREAMING-AWS4-HMAC-SHA256-PAYLOAD', (s) => chunked(s, pieces));
    expect(plain.status).toBe(200);
    expect(
      Buffer.from(await (await go('GET', '/files/t/acme/chunked.bin')).arrayBuffer()).equals(bytes),
    ).toBe(true);

    const crc = zlib.crc32(bytes);
    const crc32 = Buffer.from([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]).toString(
      'base64',
    );
    const trailed = await put(
      'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
      (s) => chunked(s, pieces, `x-amz-checksum-crc32:${crc32}`),
      { 'x-amz-trailer': 'x-amz-checksum-crc32' },
    );
    expect(trailed.status).toBe(200);
    expect(trailed.headers.get('x-amz-checksum-crc32')).toBe(crc32);
    const wrongSum = await put(
      'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
      (s) => chunked(s, pieces, 'x-amz-checksum-crc32:AAAAAA=='),
      { 'x-amz-trailer': 'x-amz-checksum-crc32' },
    );
    expect(await wrongSum.text()).toContain('<Code>BadDigest</Code>');

    // A chunk changed after signing, or a chunk signed out of turn, is refused.
    const tampered = await put('STREAMING-AWS4-HMAC-SHA256-PAYLOAD', (s) => {
      const b = chunked(s, pieces);
      b[b.indexOf('x')] = 'y'.charCodeAt(0);
      return b;
    });
    expect(await tampered.text()).toContain('<Code>SignatureDoesNotMatch</Code>');
    // Chunks chained from another request's signature: each is signed right, but not in this request's turn.
    const replayed = await put('STREAMING-AWS4-HMAC-SHA256-PAYLOAD', (s) =>
      chunked({ ...s, signature: 'f'.repeat(64) }, pieces),
    );
    expect(await replayed.text()).toContain('<Code>SignatureDoesNotMatch</Code>');
    const short = await put('STREAMING-AWS4-HMAC-SHA256-PAYLOAD', (s) => chunked(s, pieces).subarray(0, 100));
    expect(await short.text()).toContain('<Code>IncompleteBody</Code>');
  });

  it('enforces CRC32C and CRC64NVME, and one checksum at a time', async () => {
    const body = Buffer.from('123456789');
    const ok = await go('PUT', '/files/t/acme/check.txt', {
      body,
      headers: { 'x-amz-checksum-crc32c': Buffer.from('e3069283', 'hex').toString('base64') },
    });
    expect(ok.status).toBe(200);
    const crc64 = await go('PUT', '/files/t/acme/check.txt', {
      body,
      headers: { 'x-amz-checksum-crc64nvme': Buffer.from('ae8b14860a799888', 'hex').toString('base64') },
    });
    expect(crc64.status).toBe(200);
    const bad = await go('PUT', '/files/t/acme/check.txt', {
      body,
      headers: { 'x-amz-checksum-crc32c': 'AAAAAA==' },
    });
    expect(await bad.text()).toContain('The CRC32C you specified did not match');
    const two = await go('PUT', '/files/t/acme/check.txt', {
      body,
      headers: {
        'x-amz-checksum-crc32c': Buffer.from('e3069283', 'hex').toString('base64'),
        'x-amz-checksum-crc32': Buffer.from('cbf43926', 'hex').toString('base64'),
      },
    });
    expect(await two.text()).toContain('Multiple checksum Types are not allowed');
  });

  it('holds signatures to S3’s rules: date, region, service, a week at most, the payload header', async () => {
    const code = async (o: Parameters<typeof sign>[4]) => {
      const r = sign(creds, 'GET', s3.baseUrls.endpoint!, '/files/t/acme/check.txt', o);
      return /<Code>([^<]+)<\/Code>/.exec(await (await fetch(r.url, { headers: r.headers })).text())?.[1];
    };
    expect(await code({ day: '20200101' })).toBe('AuthorizationHeaderMalformed');
    expect(await code({ region: 'us-east-1' })).toBe('AuthorizationHeaderMalformed');
    expect(await code({ service: 'dynamodb' })).toBe('AuthorizationHeaderMalformed');
    expect(await code({ payload: null })).toBe('InvalidRequest');
    expect(await code({ presign: 604_801 })).toBe('AuthorizationQueryParametersError');
    expect(await code({ presign: 604_800 })).toBe(undefined);
  });

  it('keeps each account to its own buckets, and answers a path that won’t decode as S3 does', async () => {
    const other = (await s3.account('other')) as typeof creds;
    const theirs = sign(other, 'GET', s3.baseUrls.endpoint!, '/files/t/acme/check.txt');
    expect(await (await fetch(theirs.url, { headers: theirs.headers })).text()).toContain(
      '<Code>AccessDenied</Code>',
    );
    const taken = sign(other, 'PUT', s3.baseUrls.endpoint!, '/files');
    expect(await (await fetch(taken.url, { method: 'PUT', headers: taken.headers })).text()).toContain(
      'BucketAlreadyExists',
    );
    const r = sign(creds, 'GET', s3.baseUrls.endpoint!, '/files/a');
    const odd = await fetch(r.url.replace('/files/a', '/files/%E0%A4%A'), { headers: r.headers });
    expect(odd.status).toBe(400);
    expect(await odd.text()).toContain('<Code>InvalidURI</Code>');
    expect(s3.stopped()).toBeNull();
  });

  it('answers a browser’s preflight from the world’s own hosts, and nobody else’s', async () => {
    const ask = (origin: string) =>
      fetch(`${s3.baseUrls.endpoint}/files/t/acme/photo.jpg`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      });
    const ours = await ask('http://acme.sample.test:3094');
    expect(ours.status).toBe(200);
    expect(ours.headers.get('access-control-allow-origin')).toBe('http://acme.sample.test:3094');
    expect((await ask('https://evil.example')).status).toBe(403);
  });

  it('is down or slow as S3 is', async () => {
    await s3.behave({ behaviour: 'limit', count: 1 });
    const slow = await go('GET', '/files/t/acme/photo.jpg');
    expect(slow.status).toBe(503);
    expect(await slow.text()).toContain('<Code>SlowDown</Code>');
  });
});
