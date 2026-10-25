// The S3 stand-in against a client that signs as AWS documents Signature Version 4 (written here, not shared with
// the stand-in): a bucket, header-signed puts with Content-MD5, presigned puts that sign their SHA-256, heads with
// checksums, ranges, an upload in parts, the browser's preflight, and the refusals a real bucket gives.

import { createHash, createHmac } from 'node:crypto';
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
  } = {},
): Signed {
  const at = o.at ?? new Date();
  const t = amz(at);
  const day = t.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const host = new URL(origin).host;
  const headers: Record<string, string> = { host, ...(o.headers ?? {}) };
  const query: Record<string, string> = { ...(o.query ?? {}) };
  const payload = o.presign ? 'UNSIGNED-PAYLOAD' : sha(o.body ?? '');
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
  } else Object.assign(headers, { 'x-amz-date': t, 'x-amz-content-sha256': payload });
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
  for (const part of ['auto', 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  if (o.presign) {
    query['X-Amz-Signature'] = signature;
    const qs = Object.entries(query)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join('&');
    return {
      url: `${origin}${path}?${qs}`,
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host')),
    };
  }
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const qs = canonicalQuery ? `?${canonicalQuery}` : '';
  return {
    url: `${origin}${path}${qs}`,
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host')),
  };
}

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
    expect(head.headers.get('x-amz-checksum-sha256')).toBe(
      createHash('sha256').update(body).digest('base64'),
    );
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
    const parts = [Buffer.alloc(5 * 1024, 1), Buffer.alloc(1024, 2)];
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

    const done = Buffer.from(
      `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
    );
    const joined = await xml(
      await go('POST', '/files/t/acme/video.mp4', { query: { uploadId }, body: done }),
    );
    // S3 writes the ETag's quotes escaped in XML, as &quot;.
    expect(joined).toMatch(/<ETag>&quot;[0-9a-f]{32}-2&quot;<\/ETag>/);
    const back = Buffer.from(await (await go('GET', '/files/t/acme/video.mp4')).arrayBuffer());
    expect(back.equals(Buffer.concat(parts))).toBe(true);

    const another = /<UploadId>([^<]+)<\/UploadId>/.exec(
      await xml(await go('POST', '/files/t/acme/v2.mp4', { query: { uploads: '' } })),
    )![1]!;
    expect((await go('DELETE', '/files/t/acme/v2.mp4', { query: { uploadId: another } })).status).toBe(204);
    expect(
      await xml(await go('GET', '/files/', { query: { uploads: '', prefix: 't/acme/' } })),
    ).not.toContain(another);
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
