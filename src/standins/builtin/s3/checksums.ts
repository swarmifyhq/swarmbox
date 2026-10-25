// The checksums S3 takes (x-amz-checksum-<name>, as a header or a chunked upload's trailer), each as S3 writes it:
// the big-endian digest in base64. CRC32C and CRC64NVME are table-driven here; CRC32 is Node's own.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export const CHECKSUMS = ['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'] as const;
export type ChecksumName = (typeof CHECKSUMS)[number];

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

// CRC-64/NVME, reflected (poly 0x9a6c9329ac4bc9b5), kept as two 32-bit halves so it runs on plain numbers.
const [CRC64_HI, CRC64_LO] = (() => {
  const hi = new Uint32Array(256);
  const lo = new Uint32Array(256);
  const poly = 0x9a6c9329ac4bc9b5n;
  for (let i = 0n; i < 256n; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ poly : c >> 1n;
    hi[Number(i)] = Number(c >> 32n);
    lo[Number(i)] = Number(c & 0xffffffffn);
  }
  return [hi, lo];
})();

const be32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

export function digest(name: ChecksumName, bytes: Buffer): Buffer {
  switch (name) {
    case 'crc32':
      return be32(zlib.crc32(bytes));
    case 'crc32c': {
      let c = 0xffffffff;
      for (const b of bytes) c = CRC32C[(c ^ b) & 0xff]! ^ (c >>> 8);
      return be32(~c);
    }
    case 'crc64nvme': {
      let hi = 0xffffffff;
      let lo = 0xffffffff;
      for (const b of bytes) {
        const i = (lo ^ b) & 0xff;
        lo = ((lo >>> 8) | (hi << 24)) ^ CRC64_LO[i]!;
        hi = (hi >>> 8) ^ CRC64_HI[i]!;
      }
      return Buffer.concat([be32(~hi), be32(~lo)]);
    }
    case 'sha1':
    case 'sha256':
      return createHash(name).update(bytes).digest();
  }
}

export const checksum = (name: ChecksumName, bytes: Buffer) => digest(name, bytes).toString('base64');

/** The name S3 uses in its messages and in x-amz-checksum-algorithm. */
export const upper = (name: ChecksumName) => name.toUpperCase();

export function checksumNamed(s: string | undefined): ChecksumName | null {
  const n = (s ?? '').toLowerCase().replace(/^x-amz-checksum-/, '');
  return (CHECKSUMS as readonly string[]).includes(n) ? (n as ChecksumName) : null;
}
