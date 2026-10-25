// An S3-compatible bucket, path style (/<bucket>/<key>), as a product's own S3 code or the AWS SDK uses it: every
// request checked with AWS Signature Version 4 on the real clock (header-signed, presigned, and the chunk signatures
// of an aws-chunked upload), Content-MD5 and every x-amz-checksum enforced (in a header or a chunked upload's
// trailer), checksums reported, ranges, uploads in parts with S3's own rules, and the browser's CORS preflight.
// Objects live in the stand-in's own folder, up to OBJECT_MAX each.
//
// An account's console settings, as the product gives them (account(tenant, settings)): region, the region its
// requests are signed for ("auto" by default, as R2 and Railway's buckets have it), and corsOrigins, a comma list of
// origins browsers may upload from to its buckets (by default any of the world's own hosts).

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineStandIn, type Reply, type StandInContext, type StandInRequest } from '../../sdk.ts';
import { CHECKSUMS, checksum, checksumNamed, digest, upper, type ChecksumName } from './checksums.ts';
import manifest from './manifest.json' with { type: 'json' };

/**
 * The most one object may hold: every body crosses to Swarmbox as one message, so objects stay well under its 32 MB
 * line. Bigger ones are refused as S3 refuses them, with EntityTooLarge.
 */
export const OBJECT_MAX = 15 * 1024 * 1024;
/** S3's smallest part, for every part of an upload but the last. */
const PART_MIN = 5 * 1024 * 1024;
/** S3's longest presigned link: a week. */
const PRESIGN_MAX_S = 604_800;

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const EMPTY_SHA = sha256hex('');
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
const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );
const s3err = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  xml(status, `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, extra);
const tooLarge = () =>
  s3err(
    400,
    'EntityTooLarge',
    `Your proposed upload exceeds the maximum allowed size (${OBJECT_MAX} bytes in this stand-in).`,
  );

type ChecksumType = 'FULL_OBJECT' | 'COMPOSITE';
interface Checksum {
  name: ChecksumName;
  value: string;
  type: ChecksumType;
}
interface Obj {
  file: string;
  size: number;
  etag: string;
  checksum: Checksum;
  type: string;
  disposition: string | null;
  modified: Date;
}
interface Part {
  file: string;
  size: number;
  etag: string;
  md5: Buffer;
  /** In the upload's checksum, base64. */
  checksum: string;
  /** The checksum it was sent with, when another (an upload that named none). */
  given: { name: ChecksumName; value: string } | null;
}
interface Upload {
  id: string;
  bucket: string;
  key: string;
  initiated: Date;
  type: string;
  algorithm: ChecksumName;
  checksumType: ChecksumType;
  /** Asked for when it started, so every part must carry it. */
  declared: boolean;
  parts: Map<number, Part>;
}
const buckets = new Map<string, string>(); // bucket → the tenant whose account made it
const objects = new Map<string, Obj>(); // "<bucket>/<key>"
const uploads = new Map<string, Upload>();
let folder: string | null = null;
let seq = 0;

/** A request whose signature checks: whose it is, and what its chunks' signatures are worked out from. */
interface Signer {
  tenant: string;
  amzDate: string;
  scope: string;
  key: Buffer;
  /** The request's own signature: the first chunk's "previous". */
  seed: string;
  /** x-amz-content-sha256, or UNSIGNED-PAYLOAD for a presigned request without it. */
  payload: string;
}
const STREAMING = new Set([
  'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
  'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
  'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
]);

/** Which account signed this, or why it isn't signed right: SigV4 header or query, on the real clock. */
function verify(req: StandInRequest, ctx: StandInContext): Signer | Reply {
  const q = req.query;
  const presigned = q.has('X-Amz-Signature');
  const malformed = (why: string) =>
    presigned
      ? s3err(400, 'AuthorizationQueryParametersError', why)
      : s3err(400, 'AuthorizationHeaderMalformed', `The authorization header is malformed; ${why}`);
  let credential: string;
  let signedHeaders: string;
  let signature: string;
  let amzDate: string;
  if (presigned) {
    if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256')
      return malformed('X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"');
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
  const parts = credential.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request')
    return malformed(
      'the Credential is mal-formed; expecting "<YOUR-AKID>/YYYYMMDD/REGION/SERVICE/aws4_request".',
    );
  const [accessKey, day, region, service] = parts as [string, string, string, string];
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
  if (day !== amzDate.slice(0, 8))
    return malformed('Invalid credential date. Date is not the same as X-Amz-Date.');
  const expected = ctx.settings.get(tenant)?.region || 'auto';
  if (region !== expected) return malformed(`the region '${region}' is wrong; expecting '${expected}'`);
  if (service !== 's3') return malformed(`the service '${service}' is wrong; expecting 's3'`);

  const now = Date.now(); // the bucket's own clock: real time, whatever the world's says
  if (presigned) {
    const expires = q.get('X-Amz-Expires') ?? '';
    if (!/^\d{1,7}$/.test(expires) || Number(expires) < 1 || Number(expires) > PRESIGN_MAX_S)
      return malformed(
        `X-Amz-Expires must be less than a week (in seconds) that is; ${PRESIGN_MAX_S}, and at least 1`,
      );
    if (now > when + Number(expires) * 1000) return s3err(403, 'AccessDenied', 'Request has expired');
  } else if (Math.abs(now - when) > 15 * 60_000)
    return s3err(
      403,
      'RequestTimeTooSkewed',
      'The difference between the request time and the current time is too large.',
    );

  const given = req.headers['x-amz-content-sha256'];
  if (!presigned && given === undefined)
    return s3err(400, 'InvalidRequest', 'Missing required header for this request: x-amz-content-sha256');
  const payload = given ?? 'UNSIGNED-PAYLOAD';
  if (payload !== 'UNSIGNED-PAYLOAD' && !STREAMING.has(payload) && !/^[0-9a-f]{64}$/.test(payload))
    return payload.startsWith('STREAMING-')
      ? s3err(501, 'NotImplemented', 'A header you provided implies functionality that is not implemented.')
      : s3err(
          400,
          'InvalidArgument',
          'x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a STREAMING- value, or a valid sha256 value.',
        );
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
  const key = hmac(hmac(hmac(hmac(`AWS4${account.secretAccessKey}`, day), region), service), 'aws4_request');
  if (createHmac('sha256', key).update(toSign).digest('hex') !== signature)
    return s3err(
      403,
      'SignatureDoesNotMatch',
      'The request signature we calculated does not match the signature you provided.',
    );
  return { tenant, amzDate, scope, key, seed: signature, payload };
}

const isReply = (v: unknown): v is Reply => typeof v === 'object' && v !== null && 'status' in v;

/**
 * The bytes a put carries: its body as sent, or an aws-chunked body decoded, each chunk's signature checked in
 * turn (signed streaming), and its trailer read (and its signature checked, when signed).
 */
function payloadOf(req: StandInRequest, s: Signer): Reply | { bytes: Buffer; trailer: Map<string, string> } {
  const trailer = new Map<string, string>();
  if (/^[0-9a-f]{64}$/.test(s.payload)) {
    if (sha256hex(req.body) !== s.payload)
      return s3err(
        400,
        'XAmzContentSHA256Mismatch',
        'The provided x-amz-content-sha256 header does not match what was computed.',
      );
    return { bytes: req.body, trailer };
  }
  if (!STREAMING.has(s.payload)) return { bytes: req.body, trailer };

  const signed = s.payload.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD');
  const withTrailer = s.payload.endsWith('-TRAILER');
  const body = req.body;
  const incomplete = () =>
    s3err(400, 'IncompleteBody', 'The request body is not a complete aws-chunked body.');
  const badSignature = () =>
    s3err(
      403,
      'SignatureDoesNotMatch',
      'The chunk signature we calculated does not match the one you provided.',
    );
  const chunkString = (kind: 'PAYLOAD' | 'TRAILER', prev: string, hash: string) =>
    createHmac('sha256', s.key)
      .update(
        [
          `AWS4-HMAC-SHA256-${kind}`,
          s.amzDate,
          s.scope,
          prev,
          ...(kind === 'PAYLOAD' ? [EMPTY_SHA] : []),
          hash,
        ].join('\n'),
      )
      .digest('hex');
  let pos = 0;
  const line = (): string | null => {
    const end = body.indexOf('\r\n', pos);
    if (end < 0) return null;
    const l = body.subarray(pos, end).toString('latin1');
    pos = end + 2;
    return l;
  };
  let prev = s.seed;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const head = line();
    const m = head === null ? null : /^([0-9a-fA-F]{1,8})(?:;chunk-signature=([0-9a-f]{64}))?$/.exec(head);
    if (!m || (signed && !m[2])) return incomplete();
    const size = parseInt(m[1]!, 16);
    if (pos + size > body.length) return incomplete();
    const data = body.subarray(pos, pos + size);
    pos += size;
    if (signed) {
      if (chunkString('PAYLOAD', prev, sha256hex(data)) !== m[2]) return badSignature();
      prev = m[2]!;
    }
    if (size > 0) {
      total += size;
      if (total > OBJECT_MAX) return tooLarge();
      chunks.push(data);
      if (body.subarray(pos, pos + 2).toString('latin1') !== '\r\n') return incomplete();
      pos += 2;
      continue;
    }
    if (withTrailer) {
      let canonical = '';
      let trailerSignature: string | null = null;
      for (;;) {
        const l = line();
        if (l === null) return incomplete();
        if (l === '') break;
        const i = l.indexOf(':');
        if (i < 1) return incomplete();
        const name = l.slice(0, i).trim().toLowerCase();
        const value = l.slice(i + 1).trim();
        if (name === 'x-amz-trailer-signature') trailerSignature = value;
        else {
          trailer.set(name, value);
          canonical += `${name}:${value}\n`;
        }
      }
      if (
        signed &&
        (!trailerSignature || chunkString('TRAILER', prev, sha256hex(canonical)) !== trailerSignature)
      )
        return badSignature();
    } else if (line() !== '') return incomplete();
    break;
  }
  if (pos !== body.length) return incomplete();
  const bytes = Buffer.concat(chunks);
  const decoded = req.headers['x-amz-decoded-content-length'];
  if (decoded !== undefined && Number(decoded) !== bytes.length)
    return s3err(
      400,
      'IncompleteBody',
      'You did not provide the number of bytes specified by the x-amz-decoded-content-length header.',
    );
  const declared = req.headers['x-amz-trailer']?.trim().toLowerCase();
  if (withTrailer && declared && !trailer.has(declared))
    return s3err(
      400,
      'MalformedTrailerError',
      `The request did not end with the declared trailer, ${declared}.`,
    );
  return { bytes, trailer };
}

/**
 * Checks the bytes against what the request says they are: Content-MD5, its length, and the one x-amz-checksum
 * it may carry (in a header, or the trailer). Answers the checksum given, if any.
 */
function bodyChecks(
  req: StandInRequest,
  bytes: Buffer,
  trailer: Map<string, string>,
): Reply | { md5: Buffer; given: { name: ChecksumName; value: string } | null } {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) !== req.body.length)
    return s3err(
      400,
      'IncompleteBody',
      'You did not provide the number of bytes specified by the Content-Length HTTP header.',
    );
  if (bytes.length > OBJECT_MAX) return tooLarge();
  const md5 = createHash('md5').update(bytes).digest();
  const givenMd5 = req.headers['content-md5'];
  if (givenMd5 && givenMd5 !== md5.toString('base64'))
    return s3err(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
  const given = CHECKSUMS.flatMap((name) => {
    const value = req.headers[`x-amz-checksum-${name}`] ?? trailer.get(`x-amz-checksum-${name}`);
    return value === undefined ? [] : [{ name, value }];
  });
  if (given.length > 1)
    return s3err(
      400,
      'InvalidRequest',
      'Expecting a single x-amz-checksum- header. Multiple checksum Types are not allowed.',
    );
  const [one] = given;
  if (one && one.value !== checksum(one.name, bytes))
    return s3err(
      400,
      'BadDigest',
      `The ${upper(one.name)} you specified did not match the calculated checksum.`,
    );
  return { md5, given: one ?? null };
}

/** Whether a browser on `origin` may reach this bucket: its owner's corsOrigins, or the world's own hosts. */
function allowed(ctx: StandInContext, bucket: string, origin: string): boolean {
  const owner = buckets.get(bucket);
  if (owner === undefined) return false;
  const listed = (ctx.settings.get(owner)?.corsOrigins ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (listed.length) return listed.includes(origin) || listed.includes('*');
  try {
    const h = new URL(origin).hostname;
    return h === ctx.baseDomain || h.endsWith(`.${ctx.baseDomain}`);
  } catch {
    return false;
  }
}
const EXPOSED = ['ETag', ...CHECKSUMS.map((n) => `x-amz-checksum-${n}`), 'x-amz-checksum-type'].join(', ');
const corsOf = (ctx: StandInContext, req: StandInRequest): Record<string, string> => {
  const origin = req.headers.origin;
  return origin && allowed(ctx, req.params.bucket!, origin)
    ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': EXPOSED, vary: 'Origin' }
    : {};
};

/** The bucket a request names, if it is the caller's: S3's NoSuchBucket, or AccessDenied for another account's. */
function ownBucket(req: StandInRequest, tenant: string): Reply | null {
  const owner = buckets.get(req.params.bucket!);
  if (owner === undefined) return s3err(404, 'NoSuchBucket', 'The specified bucket does not exist');
  if (owner !== tenant) return s3err(403, 'AccessDenied', 'Access Denied');
  return null;
}

const objectKey = (req: StandInRequest) =>
  `${req.params.bucket}/${decodeURIComponent(req.params.rest ?? '')}`;

function store(ctx: StandInContext, bytes: Buffer): string {
  folder = join(ctx.tmp, 'objects');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${Date.now()}-${seq++}`);
  writeFileSync(file, bytes);
  return file;
}
const drop = (file: string | undefined) => {
  if (file) rmSync(file, { force: true });
};

const checksumHeaders = (c: Checksum): Record<string, string> => ({
  [`x-amz-checksum-${c.name}`]: c.value,
  'x-amz-checksum-type': c.type,
});
const checksumTag = (name: ChecksumName, value: string) =>
  `<Checksum${upper(name)}>${escapeXml(value)}</Checksum${upper(name)}>`;

type Route = (req: StandInRequest, ctx: StandInContext) => Reply;
/** A path that won't decode is S3's InvalidURI, not a stand-in that fell over. */
const parsed =
  (route: Route): Route =>
  (req, ctx) => {
    try {
      return route(req, ctx);
    } catch (e) {
      if (e instanceof URIError) return s3err(400, 'InvalidURI', "Couldn't parse the specified URI.");
      throw e;
    }
  };

const routes: Record<string, Route> = {
  'bucket.put': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return v;
    const owner = buckets.get(req.params.bucket!);
    if (owner !== undefined && owner !== v.tenant)
      return s3err(409, 'BucketAlreadyExists', 'The requested bucket name is not available.');
    const where = /<LocationConstraint>([^<]*)<\/LocationConstraint>/.exec(req.text())?.[1];
    const region = ctx.settings.get(v.tenant)?.region || 'auto';
    if (where && where !== region)
      return s3err(
        400,
        'IllegalLocationConstraintException',
        `The ${where} location constraint is incompatible for the region specific endpoint this request was sent to.`,
      );
    buckets.set(req.params.bucket!, v.tenant);
    return { status: 200, headers: { location: `/${req.params.bucket}` } };
  },
  'bucket.head': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return v;
    const refused = ownBucket(req, v.tenant);
    return { status: refused ? refused.status : 200 };
  },
  'bucket.get': (req, ctx) => listUploads(req, ctx),
  'bucket.list': (req, ctx) => listUploads(req, ctx),
  preflight: (req, ctx) => {
    const origin = req.headers.origin ?? '';
    if (!origin || !allowed(ctx, req.params.bucket!, origin))
      return s3err(403, 'AccessForbidden', 'CORSResponse: This CORS request is not allowed.');
    return {
      status: 200,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, PUT, HEAD',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
        'access-control-expose-headers': EXPOSED,
        'access-control-max-age': '3000',
        vary: 'Origin',
      },
    };
  },
  'object.put': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return { ...v, headers: { ...v.headers, ...corsOf(ctx, req) } };
    const refused = ownBucket(req, v.tenant);
    if (refused) return refused;
    if (ctx.take('reject', { tenant: v.tenant, target: objectKey(req) }))
      return s3err(403, 'AccessDenied', 'Access Denied');
    const payload = payloadOf(req, v);
    if (isReply(payload)) return payload;
    const checked = bodyChecks(req, payload.bytes, payload.trailer);
    if (isReply(checked)) return checked;
    const { bytes } = payload;
    const etag = `"${checked.md5.toString('hex')}"`;

    const uploadId = req.query.get('uploadId');
    if (uploadId) {
      const up = uploads.get(uploadId);
      if (!up || up.bucket !== req.params.bucket)
        return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
      const n = Number(req.query.get('partNumber'));
      if (!Number.isInteger(n) || n < 1 || n > 10000)
        return s3err(400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000');
      // An upload that named its checksum takes only that one on its parts; one that didn't takes any.
      if (up.declared && checked.given && checked.given.name !== up.algorithm)
        return s3err(
          400,
          'InvalidRequest',
          `Checksum Type mismatch occurred, expected checksum Type: ${up.algorithm}, actual checksum Type: ${checked.given.name}`,
        );
      if (!checked.given && up.declared)
        return s3err(
          400,
          'InvalidRequest',
          `The upload was created using a ${up.algorithm} checksum. The part upload request must include a checksum of the same type.`,
        );
      const value =
        checked.given?.name === up.algorithm ? checked.given.value : checksum(up.algorithm, bytes);
      drop(up.parts.get(n)?.file);
      up.parts.set(n, {
        file: store(ctx, bytes),
        size: bytes.length,
        etag,
        md5: checked.md5,
        checksum: value,
        given: checked.given,
      });
      const echoed = checked.given ?? { name: up.algorithm, value };
      return {
        status: 200,
        headers: { etag, [`x-amz-checksum-${echoed.name}`]: echoed.value, ...corsOf(ctx, req) },
      };
    }
    // Without a checksum, S3 gives every new object its own CRC64NVME.
    const c: Checksum = checked.given
      ? { ...checked.given, type: 'FULL_OBJECT' }
      : { name: 'crc64nvme', value: checksum('crc64nvme', bytes), type: 'FULL_OBJECT' };
    const k = objectKey(req);
    drop(objects.get(k)?.file);
    objects.set(k, {
      file: store(ctx, bytes),
      size: bytes.length,
      etag,
      checksum: c,
      type: req.headers['content-type'] ?? 'binary/octet-stream',
      disposition: req.headers['content-disposition'] ?? null,
      modified: new Date(),
    });
    return { status: 200, headers: { etag, ...checksumHeaders(c), ...corsOf(ctx, req) } };
  },
  'object.head': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return { status: v.status };
    const refused = ownBucket(req, v.tenant);
    if (refused) return { status: refused.status };
    const o = objects.get(objectKey(req));
    if (!o) return { status: 404 };
    return { status: 200, headers: headersOf(o, req, ctx, true) };
  },
  'object.get': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return v;
    const refused = ownBucket(req, v.tenant);
    if (refused) return refused;
    const uploadId = req.query.get('uploadId');
    if (uploadId) return listParts(uploadId, req);
    const o = objects.get(objectKey(req));
    if (!o) return s3err(404, 'NoSuchKey', 'The specified key does not exist.');
    const all = readFileSync(o.file);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, o.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), o.size - 1) : o.size - 1;
      if (start >= o.size || start > end)
        return s3err(416, 'InvalidRange', 'The requested range is not satisfiable');
      return {
        status: 206,
        // A part of the object: S3 sends no whole-object checksum with it.
        headers: { ...headersOf(o, req, ctx, false), 'content-range': `bytes ${start}-${end}/${o.size}` },
        body: all.subarray(start, end + 1),
      };
    }
    return { status: 200, headers: headersOf(o, req, ctx, true), body: all };
  },
  'object.delete': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return v;
    const refused = ownBucket(req, v.tenant);
    if (refused) return refused;
    const uploadId = req.query.get('uploadId');
    if (uploadId) {
      const up = uploads.get(uploadId);
      if (!up || up.bucket !== req.params.bucket)
        return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
      for (const p of up.parts.values()) drop(p.file);
      uploads.delete(uploadId);
      return { status: 204 };
    }
    const k = objectKey(req);
    drop(objects.get(k)?.file);
    objects.delete(k);
    return { status: 204 };
  },
  'object.post': (req, ctx) => {
    const v = verify(req, ctx);
    if (isReply(v)) return v;
    const refused = ownBucket(req, v.tenant);
    if (refused) return refused;
    const k = objectKey(req);
    if (req.query.has('uploads')) return startUpload(req, k);
    const uploadId = req.query.get('uploadId');
    if (uploadId) return completeUpload(req, ctx, k, uploadId);
    return s3err(400, 'InvalidRequest', 'This POST is not one S3 takes here.');
  },
};

/** CreateMultipartUpload: its checksum as asked (x-amz-checksum-algorithm and -type), or S3's own CRC64NVME. */
function startUpload(req: StandInRequest, k: string): Reply {
  const asked = req.headers['x-amz-checksum-algorithm'];
  const algorithm = asked === undefined ? 'crc64nvme' : checksumNamed(asked);
  if (!algorithm) return s3err(400, 'InvalidRequest', `Checksum algorithm ${asked} is not supported.`);
  const isCrc = algorithm.startsWith('crc');
  const type = (req.headers['x-amz-checksum-type'] ??
    (algorithm === 'crc64nvme' ? 'FULL_OBJECT' : 'COMPOSITE')) as string;
  if (type !== 'FULL_OBJECT' && type !== 'COMPOSITE')
    return s3err(400, 'InvalidRequest', 'x-amz-checksum-type must be FULL_OBJECT or COMPOSITE.');
  if ((type === 'FULL_OBJECT' && !isCrc) || (type === 'COMPOSITE' && algorithm === 'crc64nvme'))
    return s3err(
      400,
      'InvalidRequest',
      `The ${upper(algorithm)} checksum algorithm does not support the ${type} checksum type.`,
    );
  const id = randomBytes(24).toString('base64url');
  uploads.set(id, {
    id,
    bucket: req.params.bucket!,
    key: k,
    initiated: new Date(),
    type: req.headers['content-type'] ?? 'binary/octet-stream',
    algorithm,
    checksumType: type,
    declared: asked !== undefined,
    parts: new Map(),
  });
  return xml(
    200,
    `<InitiateMultipartUploadResult><Bucket>${escapeXml(req.params.bucket!)}</Bucket><Key>${escapeXml(k.slice(req.params.bucket!.length + 1))}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    { 'x-amz-checksum-algorithm': upper(algorithm), 'x-amz-checksum-type': type },
  );
}

/** CompleteMultipartUpload, with S3's rules: parts in ascending order, each but the last at least 5 MB. */
function completeUpload(req: StandInRequest, ctx: StandInContext, k: string, uploadId: string): Reply {
  const up = uploads.get(uploadId);
  if (!up || up.bucket !== req.params.bucket)
    return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
  const asked = [...req.text().matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => {
    const tag = (name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(m[1]!)?.[1];
    const named = CHECKSUMS.map((n) => [n, tag(`Checksum${upper(n)}`)] as const).find(([, x]) => x);
    return {
      n: Number(tag('PartNumber')),
      etag: (tag('ETag') ?? '').replace(/&quot;/g, '"').replace(/"/g, ''),
      checksum: named ? { name: named[0], value: named[1]! } : null,
    };
  });
  if (!asked.length || asked.some((a) => !Number.isInteger(a.n)))
    return s3err(
      400,
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema.',
    );
  for (let i = 1; i < asked.length; i++)
    if (asked[i]!.n <= asked[i - 1]!.n)
      return s3err(
        400,
        'InvalidPartOrder',
        'The list of parts was not in ascending order. The parts list must be specified in order by part number.',
      );
  const parts: Part[] = [];
  for (const a of asked) {
    const p = up.parts.get(a.n);
    if (
      !p ||
      p.etag.replace(/"/g, '') !== a.etag ||
      (a.checksum &&
        !(a.checksum.name === up.algorithm && a.checksum.value === p.checksum) &&
        !(a.checksum.name === p.given?.name && a.checksum.value === p.given.value))
    )
      return s3err(400, 'InvalidPart', 'One or more of the specified parts could not be found.');
    parts.push(p);
  }
  if (parts.slice(0, -1).some((p) => p.size < PART_MIN))
    return s3err(
      400,
      'EntityTooSmall',
      'Your proposed upload is smaller than the minimum allowed object size.',
    );
  if (parts.reduce((n, p) => n + p.size, 0) > OBJECT_MAX) return tooLarge();
  const bytes = Buffer.concat(parts.map((p) => readFileSync(p.file)));
  const etag = `"${createHash('md5')
    .update(Buffer.concat(parts.map((p) => p.md5)))
    .digest('hex')}-${parts.length}"`;
  const c: Checksum =
    up.checksumType === 'COMPOSITE'
      ? {
          name: up.algorithm,
          value: `${digest(up.algorithm, Buffer.concat(parts.map((p) => Buffer.from(p.checksum, 'base64')))).toString('base64')}-${parts.length}`,
          type: 'COMPOSITE',
        }
      : { name: up.algorithm, value: checksum(up.algorithm, bytes), type: 'FULL_OBJECT' };
  const whole = req.headers[`x-amz-checksum-${up.algorithm}`];
  if (whole !== undefined && up.checksumType === 'FULL_OBJECT' && whole !== c.value)
    return s3err(
      400,
      'BadDigest',
      `The ${upper(up.algorithm)} you specified did not match the calculated checksum.`,
    );
  drop(objects.get(k)?.file);
  objects.set(k, {
    file: store(ctx, bytes),
    size: bytes.length,
    etag,
    checksum: c,
    type: up.type,
    disposition: null,
    modified: new Date(),
  });
  for (const p of up.parts.values()) drop(p.file);
  uploads.delete(uploadId);
  return xml(
    200,
    `<CompleteMultipartUploadResult><Bucket>${escapeXml(up.bucket)}</Bucket><Key>${escapeXml(k.slice(up.bucket.length + 1))}</Key><ETag>${escapeXml(etag)}</ETag>${checksumTag(c.name, c.value)}<ChecksumType>${c.type}</ChecksumType></CompleteMultipartUploadResult>`,
  );
}

/** The SDK sends a bucket's own requests to "/<bucket>/": an object route with no key is the bucket's. */
const BUCKET_OF: Record<string, string> = {
  'object.put': 'bucket.put',
  'object.head': 'bucket.head',
  'object.get': 'bucket.get',
};
defineStandIn({
  manifest,
  routes: Object.fromEntries(
    Object.entries(routes).map(([name, route]) => [
      name,
      parsed((req, ctx) =>
        (BUCKET_OF[name] && !req.params.rest ? routes[BUCKET_OF[name]]! : route)(req, ctx),
      ),
    ]),
  ),
  reset() {
    if (folder) rmSync(folder, { recursive: true, force: true });
    buckets.clear();
    objects.clear();
    uploads.clear();
  },
});

function headersOf(o: Obj, req: StandInRequest, ctx: StandInContext, whole: boolean): Record<string, string> {
  return {
    etag: o.etag,
    'content-length': String(o.size),
    'content-type': req.query.get('response-content-type') ?? o.type,
    'last-modified': o.modified.toUTCString(),
    'accept-ranges': 'bytes',
    ...(req.query.get('response-content-disposition') || o.disposition
      ? { 'content-disposition': req.query.get('response-content-disposition') ?? o.disposition! }
      : {}),
    ...(whole && req.headers['x-amz-checksum-mode'] === 'ENABLED' ? checksumHeaders(o.checksum) : {}),
    ...corsOf(ctx, req),
  };
}

function listParts(uploadId: string, req: StandInRequest): Reply {
  const up = uploads.get(uploadId);
  if (!up || up.bucket !== req.params.bucket)
    return s3err(404, 'NoSuchUpload', 'The specified upload does not exist.');
  const after = Number(req.query.get('part-number-marker') ?? 0);
  const max = Math.min(Number(req.query.get('max-parts') ?? 1000), 1000);
  const all = [...up.parts.entries()].sort(([a], [b]) => a - b).filter(([n]) => n > after);
  const page = all.slice(0, max);
  const truncated = all.length > page.length;
  return xml(
    200,
    `<ListPartsResult><UploadId>${up.id}</UploadId><ChecksumAlgorithm>${upper(up.algorithm)}</ChecksumAlgorithm><ChecksumType>${up.checksumType}</ChecksumType><IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? `<NextPartNumberMarker>${page.at(-1)![0]}</NextPartNumberMarker>` : '') +
      page
        .map(
          ([n, p]) =>
            `<Part><PartNumber>${n}</PartNumber><ETag>${escapeXml(p.etag)}</ETag><Size>${p.size}</Size>${checksumTag(up.algorithm, p.checksum)}</Part>`,
        )
        .join('') +
      `</ListPartsResult>`,
  );
}

function listUploads(req: StandInRequest, ctx: StandInContext): Reply {
  const v = verify(req, ctx);
  if (isReply(v)) return v;
  const refused = ownBucket(req, v.tenant);
  if (refused) return refused;
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
