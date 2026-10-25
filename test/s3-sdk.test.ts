// The S3 stand-in against the AWS SDK v3 itself (a dev dependency), which signs, frames and checks as it does
// against AWS: stream bodies sent aws-chunked with their checksum in the trailer, every checksum algorithm, uploads
// in parts with composite checksums, and the checksums the SDK verifies when it reads an object back.

import { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type ChecksumAlgorithm,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinStandIn } from '../src/standins/builtin/index.ts';
import { startStandIn, type StandIn } from '../src/standins/runner.ts';
import { OBJECT_MAX } from '../src/standins/builtin/s3/index.ts';

const SANDBOX = process.env.SWARMBOX_NO_SANDBOX === '1' ? 'off' : 'required';
const MB = 1024 * 1024;

describe('the S3 stand-in, through the AWS SDK', () => {
  let s3: StandIn;
  let client: S3Client;
  const Bucket = 'recordings';
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof S3ServiceException ? e.name : String(e);
    }
    return 'accepted';
  };
  const read = async (Key: string) => {
    const got = await client.send(new GetObjectCommand({ Bucket, Key, ChecksumMode: 'ENABLED' }));
    return { got, bytes: Buffer.from(await got.Body!.transformToByteArray()) };
  };

  beforeAll(async () => {
    s3 = await startStandIn({
      ...builtinStandIn('s3'),
      deliverTo: 'http://127.0.0.1:9',
      baseDomain: 'sample.test',
      sandbox: SANDBOX,
      onStderr: (t) => process.stderr.write(t),
    });
    const creds = await s3.account('platform', { region: 'ca-central-1' });
    client = new S3Client({
      endpoint: s3.baseUrls.endpoint!,
      region: 'ca-central-1',
      forcePathStyle: true,
      credentials: { accessKeyId: creds.accessKeyId!, secretAccessKey: creds.secretAccessKey! },
    });
    await client.send(new CreateBucketCommand({ Bucket }));
  });
  afterAll(async () => {
    client?.destroy();
    await s3.stop();
  });

  it('takes a stream body sent aws-chunked, its checksum in the trailer, and stores the bytes alone', async () => {
    const body = Buffer.from('a call recording, streamed '.repeat(5000));
    await client.send(
      new PutObjectCommand({
        Bucket,
        Key: 'calls/streamed.mp3',
        Body: Readable.from([body.subarray(0, 70_000), body.subarray(70_000)]),
        ContentLength: body.length,
        ChecksumAlgorithm: 'CRC32',
      }),
    );
    const sent = s3.log().findLast((e) => e.operation === 'object.put');
    // What the SDK actually sent: framed, not the bytes.
    expect(sent?.sent).toMatch(/^[0-9a-f]+(;chunk-signature=[0-9a-f]{64})?\r\n/);
    const { got, bytes } = await read('calls/streamed.mp3');
    expect(bytes.equals(body)).toBe(true);
    expect(got.ChecksumCRC32).toBeTruthy();
  });

  it('checks every checksum the SDK sends, and the SDK checks what it reads back', async () => {
    const body = Buffer.from('a signed estimate, as a PDF');
    for (const algorithm of ['CRC32', 'CRC32C', 'CRC64NVME', 'SHA1', 'SHA256'] as ChecksumAlgorithm[]) {
      const Key = `docs/${algorithm}.pdf`;
      await client.send(new PutObjectCommand({ Bucket, Key, Body: body, ChecksumAlgorithm: algorithm }));
      const head = await client.send(new HeadObjectCommand({ Bucket, Key, ChecksumMode: 'ENABLED' }));
      expect(head.ChecksumType).toBe('FULL_OBJECT');
      // The SDK validates the response's checksum against the bytes; a wrong one would throw here.
      expect((await read(Key)).bytes.equals(body)).toBe(true);
    }
    // No algorithm asked: SDK v3 sends its own default, a CRC32, which is kept.
    await client.send(new PutObjectCommand({ Bucket, Key: 'docs/plain.txt', Body: body }));
    expect((await read('docs/plain.txt')).got.ChecksumCRC32).toBeTruthy();

    expect(
      await refusal(
        client.send(
          new PutObjectCommand({ Bucket, Key: 'docs/bad', Body: body, ChecksumCRC32C: 'AAAAAA==' }),
        ),
      ),
    ).toBe('BadDigest');
  });

  it('joins parts as S3 does: at least 5 MB but the last, and a composite checksum of the parts', async () => {
    const Key = 'calls/long.mp3';
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket, Key, ChecksumAlgorithm: 'SHA256' }),
    );
    const bodies = [Buffer.alloc(5 * MB, 1), Buffer.alloc(300_000, 2)];
    const Parts = [];
    for (const [i, Body] of bodies.entries()) {
      const r = await client.send(
        new UploadPartCommand({
          Bucket,
          Key,
          UploadId,
          PartNumber: i + 1,
          Body,
          ChecksumAlgorithm: 'SHA256',
        }),
      );
      Parts.push({ PartNumber: i + 1, ETag: r.ETag, ChecksumSHA256: r.ChecksumSHA256 });
    }
    const done = await client.send(
      new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } }),
    );
    expect(done.ChecksumSHA256).toMatch(/-2$/);
    expect(done.ChecksumType).toBe('COMPOSITE');
    expect((await read(Key)).bytes.equals(Buffer.concat(bodies))).toBe(true);

    const small = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: 'calls/small.mp3' }));
    const tags = [];
    for (const n of [1, 2])
      tags.push({
        PartNumber: n,
        ETag: (
          await client.send(
            new UploadPartCommand({
              Bucket,
              Key: 'calls/small.mp3',
              UploadId: small.UploadId,
              PartNumber: n,
              Body: Buffer.alloc(1000, n),
            }),
          )
        ).ETag,
      });
    expect(
      await refusal(
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: 'calls/small.mp3',
            UploadId: small.UploadId,
            MultipartUpload: { Parts: tags },
          }),
        ),
      ),
    ).toBe('EntityTooSmall');
  });

  it('holds an object up to its limit, and refuses a bigger one with EntityTooLarge', async () => {
    const big = Buffer.alloc(OBJECT_MAX, 3);
    await client.send(new PutObjectCommand({ Bucket, Key: 'big.bin', Body: big }));
    expect((await read('big.bin')).bytes.length).toBe(OBJECT_MAX);
    expect(
      await refusal(
        client.send(new PutObjectCommand({ Bucket, Key: 'bigger.bin', Body: Buffer.alloc(OBJECT_MAX + 1) })),
      ),
    ).toBe('EntityTooLarge');
    expect(s3.stopped()).toBeNull();
  });

  it('refuses a request signed for another region', async () => {
    const elsewhere = new S3Client({
      endpoint: s3.baseUrls.endpoint!,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: await client.config.credentials(),
    });
    expect(await refusal(elsewhere.send(new PutObjectCommand({ Bucket, Key: 'x', Body: 'x' })))).toBe(
      'AuthorizationHeaderMalformed',
    );
    elsewhere.destroy();
  });
});
