// Minimal PNG writer for QR symbols: 1-bit greyscale, no interlace, one IDAT.
// zlib is a node built-in, so this adds no dependency.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/**
 * Renders a QR matrix to PNG bytes. `scale` is pixels per module and `quiet` is
 * the margin in modules — 4 is the standard minimum and a symbol printed with
 * less is the usual reason a card will not scan, so it is the default and the
 * caller has to ask for less.
 */
export const qrToPng = ({ size, modules }, { scale = 8, quiet = 4 } = {}) => {
  if (!Number.isInteger(scale) || scale < 1) throw new Error('scale must be a positive integer');
  if (!Number.isInteger(quiet) || quiet < 0) throw new Error('quiet must be a non-negative integer');

  const span = size + quiet * 2;
  const px = span * scale;
  // Bit depth 1: 0 is black, 1 is white, so a dark module is a cleared bit.
  const rowBytes = Math.ceil(px / 8);
  const raw = Buffer.alloc((rowBytes + 1) * px, 0);

  for (let y = 0; y < px; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter: none
    const mr = Math.floor(y / scale) - quiet;
    for (let x = 0; x < px; x += 1) {
      const mc = Math.floor(x / scale) - quiet;
      const dark =
        mr >= 0 && mr < size && mc >= 0 && mc < size && modules[mr * size + mc] === 1;
      if (!dark) raw[rowStart + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
