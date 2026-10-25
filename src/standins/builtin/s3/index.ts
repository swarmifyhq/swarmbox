// An S3-compatible bucket, path style (/<bucket>/<key>), as a product's own S3 code uses it: every request checked
// with AWS Signature Version 4 on the real clock (header-signed and presigned), SHA-256 and Content-MD5 enforced,
// checksums reported, ranges, uploads in parts, and the browser's CORS preflight. Objects live in the stand-in's
// own folder.
//
// An account's console settings, as the product gives them (account(tenant, settings)): corsOrigins, a comma list
// of origins browsers may upload from; by default any of the world's own hosts.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineStandIn, type Reply, type StandInContext, type StandInRequest } from '../../sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986, as SigV4 wants it: everything but unreserved characters, and '/' too unless kept. */
const enc = (s: string, keepSlash = false) => {
  const e = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? e.replace(/%2F/g, '/') : e;
};

const xml = (status: number, body: string, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: {
    'content-type': 'application/xml',
    'x-amz-request-id': randomBytes(8).toString('hex').toUpperCase(),
    ...headers,
  },
  body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`,
});
const s3err = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  xml(status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`, extra);
const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

interface Obj {
  file: string;
  size: number;
  etag: string;
  sha256: string;
  type: string;
  disposition: string | null;
  modified: Date;
}
interface Upload {
  id: string;
  bucket: string;
  key: string;
  initiated: Date;
  type: string;
  parts: Map<number, { file: string; size: number; etag: string; md5: Buffer; sha256: string | null }>;
}
const buckets = new Set<string>();
const objects = new Map<string, Obj>(); // "<bucket>/<key>"
const uploads = new Map<string, Upload>();
let seq = 0;

/** Which account signed this, or why it isn't signed right: SigV4 header or query, on the real clock. */
function verify(req: StandInRequest, ctx: StandInContext): { tenant: string } | Reply {
  const q = req.query;
  const presigned = q.has('X-Amz-Signature');
  let credential: string;
  let signedHeaders: string;
  let signature: string;
  let amzDate: string;
  if (presigned) {
    credential = q.get('X-Amz-Credential') ?? '';
    signedHeaders = q.get('X-Amz-SignedHeaders') ?? '';
    signature = q.get('X-Amz-Signature') ?? '';
    amzDate = q.get('X-Amz-Date') ?? '';
  } else {
    const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]+)$/.exec(
      req.headers.authorization ?? '',
    );
    if (!m) return s3err(403, 'AccessDenied', 'Access Denied');
    [, credential, signedHeaders, signature] = m as unknown as [string, string, string, string];
    amzDate = req.headers['x-amz-date'] ?? '';
  }
  const [accessKey, day, region, service] = credential.split('/');
  const entry = [...ctx.accounts].find(([, a]) => a.accessKeyId === accessKey);
  if (!entry)
    return s3err(
      403,
      'InvalidAccessKeyId',
      'The AWS Access Key Id you provided does not exist in our records.',
    );
  const [tenant, account] = entry;
  const when = Date.parse(amzDate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (!Number.isFinite(when)) return s3err(403, 'AccessDenied', 'X-Amz-Date is missing or malformed');
  const now = Date.now(); // the bucket's own clock: real time, whatever the world's says
  if (presigned) {
    if (now > when + Number(q.get('X-Amz-Expires') ?? 0) * 1000)
      return s3err(403, 'AccessDenied', 'Request has expired');
  } else if (Math.abs(now - when) > 15 * 60_000)
    return s3err(
      403,
      'RequestTimeTooSkewed',
      'The difference between the request time and the current time is too large.',
    );

  const payload = presigned
    ? (req.headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD')
    : (req.headers['x-amz-content-sha256'] ?? '');
  const query = [...q.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const names = signedHeaders.split(';');
  const canonical = [
    req.method,
    enc(decodeURIComponent(req.path), true),
    query,
    names
      .map(
        (n) =>
          `${n}:${String(req.headers[n] ?? '')
            .trim()
            .replace(/\s+/g, ' ')}\n`,
      )
      .join(''),
    signedHeaders,
    payload,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${account.secretAccessKey}`, day!), region!), service!),
    'aws4_request',
  );
  if (createHmac('sha256', key).update(toSign).digest('hex') !== signature)
    return s3err(
      403,
      'SignatureDoesNotMatch',
      'The request signature we calculated does not match the signature you provided.',
    );
  if (!presigned && /^[0-9a-f]{64}$/.test(payload) && sha256hex(req.body) !== payload)
    return s3err(
      400,
      'XAmzContentSHA256Mismatch',
      'The provided x-amz-content-sha256 header does not match what was computed.',
    );
  return { tenant };
}

/** Whether a browser on `origin` may upload: the account's corsOrigins, or the world's own hosts. */
function allowed(ctx: StandInContext, origin: string): boolean {
  const listed = [...ctx.settings.values()].flatMap((s) =>
    (s.corsOrigins ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
  if (listed.length) return listed.includes(origin) || listed.includes('*');
  try {
    const h = new URL(origin).hostname;
    return h === ctx.baseDomain || h.endsWith(`.${ctx.baseDomain}`);
  } catch {
    return false;
  }
}
const corsOf = (ctx: StandInContext, req: StandInRequest): Record<string, string> => {
  const origin = req.headers.origin;
  return origin && allowed(ctx, origin)
    ? {
        'access-control-allow-origin': origin,
        'access-control-expose-headers': 'ETag, x-amz-checksum-sha256',
        vary: 'Origin',
      }
    : {};
};

/** Checks a body against what the request says it is: Content-MD5, and x-amz-checksum-sha256. */
function bodyChecks(req: StandInRequest): Reply | { md5: Buffer; sha256: string } {
  const md5 = createHash('md5').update(req.body).digest();
  const sha256 = createHash('sha256').update(req.body).digest('base64');
  const givenMd5 = req.headers['content-md5'];
  if (givenMd5 && givenMd5 !== md5.toString('base64'))
    return s3err(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
  const givenSha = req.headers['x-amz-checksum-sha256'];
  if (givenSha && givenSha !== sha256)
    return s3err(400, 'BadDigest', 'The SHA256 you specified did not match the calculated checksum.');
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) !== req.body.length)
    return s3err(
      400,
      'IncompleteBody',
      'You did not provide the number of bytes specified by the Content-Length HTTP header.',
    );
  return { md5, sha256 };
}

const objectKey = (req: StandInRequest) =>
  `${req.params.bucket}/${decodeURIComponent(req.params.rest ?? '')}`;

function store(ctx: StandInContext, bytes: Buffer): string {
  const dir = join(ctx.tmp, 'objects');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${seq++}`);
  writeFileSync(file, bytes);
  return file;
}

defineStandIn({
  manifest,
  routes: {
    'bucket.put': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return v;
      buckets.add(req.params.bucket!);
      return { status: 200, headers: { location: `/${req.params.bucket}` } };
    },
    'bucket.head': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return v;
      return { status: buckets.has(req.params.bucket!) ? 200 : 404 };
    },
    'bucket.get': (req, ctx) => listUploads(req, ctx),
    'bucket.list': (req, ctx) => listUploads(req, ctx),
    preflight: (req, ctx) => {
      const origin = req.headers.origin ?? '';
      if (!origin || !allowed(ctx, origin))
        return s3err(403, 'AccessForbidden', 'CORSResponse: This CORS request is not allowed.');
      return {
        status: 200,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, PUT, HEAD',
          'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
          'access-control-expose-headers': 'ETag, x-amz-checksum-sha256',
          'access-control-max-age': '3000',
          vary: 'Origin',
        },
      };
    },
    'object.put': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return { ...v, headers: { ...v.headers, ...corsOf(ctx, req) } };
      if (!buckets.has(req.params.bucket!))
        return s3err(404, 'NoSuchBucket', 'The specified bucket does not exist');
      if (ctx.take('reject', { tenant: v.tenant, target: objectKey(req) }))
        return s3err(403, 'AccessDenied', 'Access Denied');
      const checked = bodyChecks(req);
      if ('status' in checked) return checked;
      const uploadId = req.query.get('uploadId');
      if (uploadId) {
        const up = uploads.get(uploadId);
        if (!up) return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
        const n = Number(req.query.get('partNumber'));
        if (!Number.isInteger(n) || n < 1 || n > 10000)
          return s3err(400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000');
        const etag = `"${checked.md5.toString('hex')}"`;
        up.parts.set(n, {
          file: store(ctx, req.body),
          size: req.body.length,
          etag,
          md5: checked.md5,
          sha256: req.headers['x-amz-checksum-sha256'] ?? null,
        });
        return { status: 200, headers: { etag, ...corsOf(ctx, req) } };
      }
      const etag = `"${checked.md5.toString('hex')}"`;
      const k = objectKey(req);
      const old = objects.get(k);
      if (old && existsSync(old.file)) rmSync(old.file);
      objects.set(k, {
        file: store(ctx, req.body),
        size: req.body.length,
        etag,
        sha256: checked.sha256,
        type: req.headers['content-type'] ?? 'binary/octet-stream',
        disposition: req.headers['content-disposition'] ?? null,
        modified: new Date(),
      });
      return { status: 200, headers: { etag, 'x-amz-checksum-sha256': checked.sha256, ...corsOf(ctx, req) } };
    },
    'object.head': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return { status: v.status };
      const o = objects.get(objectKey(req));
      if (!o) return { status: 404 };
      return { status: 200, headers: headersOf(o, req, ctx) };
    },
    'object.get': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return v;
      const uploadId = req.query.get('uploadId');
      if (uploadId) return listParts(uploadId, req);
      const o = objects.get(objectKey(req));
      if (!o) return s3err(404, 'NoSuchKey', 'The specified key does not exist.');
      const all = readFileSync(o.file);
      const h = headersOf(o, req, ctx);
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, o.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), o.size - 1) : o.size - 1;
        if (start >= o.size) return s3err(416, 'InvalidRange', 'The requested range is not satisfiable');
        return {
          status: 206,
          headers: { ...h, 'content-range': `bytes ${start}-${end}/${o.size}` },
          body: all.subarray(start, end + 1),
        };
      }
      return { status: 200, headers: h, body: all };
    },
    'object.delete': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return v;
      const uploadId = req.query.get('uploadId');
      if (uploadId) {
        const up = uploads.get(uploadId);
        if (!up) return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
        for (const p of up.parts.values()) rmSync(p.file, { force: true });
        uploads.delete(uploadId);
        return { status: 204 };
      }
      const k = objectKey(req);
      const o = objects.get(k);
      if (o) rmSync(o.file, { force: true });
      objects.delete(k);
      return { status: 204 };
    },
    'object.post': (req, ctx) => {
      const v = verify(req, ctx);
      if ('status' in v) return v;
      const k = objectKey(req);
      if (req.query.has('uploads')) {
        const id = randomBytes(24).toString('base64url');
        uploads.set(id, {
          id,
          bucket: req.params.bucket!,
          key: k,
          initiated: new Date(),
          type: req.headers['content-type'] ?? 'binary/octet-stream',
          parts: new Map(),
        });
        return xml(
          200,
          `<InitiateMultipartUploadResult><Bucket>${escapeXml(req.params.bucket!)}</Bucket><Key>${escapeXml(k.slice(req.params.bucket!.length + 1))}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      const uploadId = req.query.get('uploadId');
      if (uploadId) {
        const up = uploads.get(uploadId);
        if (!up) return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
        const asked = [
          ...req
            .text()
            .matchAll(
              /<Part>[\s\S]*?<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<ETag>([^<]+)<\/ETag>[\s\S]*?<\/Part>/g,
            ),
        ].map((m) => ({ n: Number(m[1]), etag: m[2]!.replace(/&quot;/g, '"') }));
        if (!asked.length)
          return s3err(
            400,
            'MalformedXML',
            'The XML you provided was not well-formed or did not validate against our published schema.',
          );
        const parts = [];
        for (const a of asked) {
          const p = up.parts.get(a.n);
          if (!p || p.etag.replace(/"/g, '') !== a.etag.replace(/"/g, ''))
            return s3err(400, 'InvalidPart', 'One or more of the specified parts could not be found.');
          parts.push(p);
        }
        const bytes = Buffer.concat(parts.map((p) => readFileSync(p.file)));
        const etag = `"${createHash('md5')
          .update(Buffer.concat(parts.map((p) => p.md5)))
          .digest('hex')}-${parts.length}"`;
        objects.set(k, {
          file: store(ctx, bytes),
          size: bytes.length,
          etag,
          sha256: createHash('sha256').update(bytes).digest('base64'),
          type: up.type,
          disposition: null,
          modified: new Date(),
        });
        for (const p of up.parts.values()) rmSync(p.file, { force: true });
        uploads.delete(uploadId);
        return xml(
          200,
          `<CompleteMultipartUploadResult><Bucket>${escapeXml(up.bucket)}</Bucket><Key>${escapeXml(k.slice(up.bucket.length + 1))}</Key><ETag>${escapeXml(etag)}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      return s3err(400, 'InvalidRequest', 'This POST is not one S3 takes here.');
    },
  },
  reset() {
    buckets.clear();
    objects.clear();
    uploads.clear();
  },
});

function headersOf(o: Obj, req: StandInRequest, ctx: StandInContext): Record<string, string> {
  return {
    etag: o.etag,
    'content-length': String(o.size),
    'content-type': req.query.get('response-content-type') ?? o.type,
    'last-modified': o.modified.toUTCString(),
    'accept-ranges': 'bytes',
    ...(req.query.get('response-content-disposition') || o.disposition
      ? { 'content-disposition': req.query.get('response-content-disposition') ?? o.disposition! }
      : {}),
    ...(req.headers['x-amz-checksum-mode'] === 'ENABLED'
      ? { 'x-amz-checksum-sha256': o.sha256, 'x-amz-checksum-type': 'FULL_OBJECT' }
      : {}),
    ...corsOf(ctx, req),
  };
}

function listParts(uploadId: string, req: StandInRequest): Reply {
  const up = uploads.get(uploadId);
  if (!up) return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
  const after = Number(req.query.get('part-number-marker') ?? 0);
  const max = Math.min(Number(req.query.get('max-parts') ?? 1000), 1000);
  const all = [...up.parts.entries()].sort(([a], [b]) => a - b).filter(([n]) => n > after);
  const page = all.slice(0, max);
  const truncated = all.length > page.length;
  return xml(
    200,
    `<ListPartsResult><UploadId>${up.id}</UploadId><IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? `<NextPartNumberMarker>${page.at(-1)![0]}</NextPartNumberMarker>` : '') +
      page
        .map(
          ([n, p]) =>
            `<Part><PartNumber>${n}</PartNumber><ETag>${escapeXml(p.etag)}</ETag><Size>${p.size}</Size>${p.sha256 ? `<ChecksumSHA256>${p.sha256}</ChecksumSHA256>` : ''}</Part>`,
        )
        .join('') +
      `</ListPartsResult>`,
  );
}

function listUploads(req: StandInRequest, ctx: StandInContext): Reply {
  const v = verify(req, ctx);
  if ('status' in v) return v;
  if (!req.query.has('uploads'))
    return s3err(400, 'InvalidRequest', 'Only the list of uploads in parts is served on a bucket here.');
  const bucket = req.params.bucket!;
  const prefix = req.query.get('prefix') ?? '';
  const max = Math.min(Number(req.query.get('max-uploads') ?? 1000), 1000);
  const after = req.query.get('key-marker') ?? '';
  const all = [...uploads.values()]
    .filter(
      (u) =>
        u.bucket === bucket &&
        u.key.slice(bucket.length + 1).startsWith(prefix) &&
        u.key.slice(bucket.length + 1) > after,
    )
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const page = all.slice(0, max);
  const truncated = all.length > page.length;
  return xml(
    200,
    `<ListMultipartUploadsResult><Bucket>${escapeXml(bucket)}</Bucket><IsTruncated>${truncated}</IsTruncated>` +
      (truncated
        ? `<NextKeyMarker>${escapeXml(page.at(-1)!.key.slice(bucket.length + 1))}</NextKeyMarker><NextUploadIdMarker>${page.at(-1)!.id}</NextUploadIdMarker>`
        : '') +
      page
        .map(
          (u) =>
            `<Upload><Key>${escapeXml(u.key.slice(bucket.length + 1))}</Key><UploadId>${u.id}</UploadId><Initiated>${u.initiated.toISOString()}</Initiated></Upload>`,
        )
        .join('') +
      `</ListMultipartUploadsResult>`,
  );
}
