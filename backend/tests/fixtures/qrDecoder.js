// An independent QR reader, for the tests only.
//
// src/lib/qr is hand-written against ISO/IEC 18004 because no encoder package
// is reachable from this lane. A round-trip through the same helpers would
// prove nothing, so nothing here is imported from src/: the Galois field, the
// mask rules, the zigzag walk and the block geometry are all restated, and the
// Reed-Solomon syndromes are recomputed rather than trusted. A wrong generator
// polynomial or a transposed format region in the encoder fails here instead of
// reaching a printer.
//
// It reads only what this codebase emits: 1-bit greyscale PNG, filter 0, level
// M, byte mode. Anything else throws rather than guessing.

import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG -> grid

const pngChunks = (buf) => {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
};

/** PNG bytes -> { width, height, dark(x, y) }. 1-bit greyscale only. */
export const readPng = (buf) => {
  const chunks = pngChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colour = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 1 || colour !== 0) throw new Error(`expected 1-bit greyscale, got depth ${depth} colour ${colour}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (idat.length === 0) throw new Error('PNG has no IDAT');
  const raw = inflateSync(Buffer.concat(idat));

  const rowBytes = Math.ceil(width / 8);
  if (raw.length !== (rowBytes + 1) * height) {
    throw new Error(`IDAT is ${raw.length} bytes, expected ${(rowBytes + 1) * height}`);
  }
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (rowBytes + 1)] !== 0) throw new Error(`row ${y} uses filter ${raw[y * (rowBytes + 1)]}, only 0 supported`);
  }

  // Greyscale depth 1: bit set is white, bit clear is black.
  const dark = (x, y) => (raw[y * (rowBytes + 1) + 1 + (x >> 3)] & (0x80 >> (x & 7))) === 0;
  return { width, height, dark };
};

/**
 * Recovers the module grid from a rendered image without being told the scale
 * or the quiet zone: the top-left finder's first horizontal dark run is 7
 * modules wide by definition, which fixes the pitch, and its start fixes the
 * origin. A renderer that quietly changed either is caught here.
 */
export const gridFromPng = (buf) => {
  const { width, height, dark } = readPng(buf);
  if (width !== height) throw new Error(`symbol is ${width}x${height}, expected square`);

  let originY = -1;
  for (let y = 0; y < height && originY < 0; y += 1) {
    for (let x = 0; x < width; x += 1) if (dark(x, y)) { originY = y; break; }
  }
  if (originY < 0) throw new Error('image is blank');
  let originX = 0;
  while (!dark(originX, originY)) originX += 1;

  let run = 0;
  while (originX + run < width && dark(originX + run, originY)) run += 1;
  if (run % 7 !== 0) throw new Error(`finder run is ${run}px, not a multiple of 7 — pitch undetectable`);
  const scale = run / 7;
  if (originX !== originY) throw new Error(`quiet zone is ${originX}px left but ${originY}px top`);
  const quiet = originX / scale;
  if (!Number.isInteger(quiet)) throw new Error(`quiet zone ${originX}px is not a whole number of modules`);

  const size = width / scale - quiet * 2;
  if (!Number.isInteger(size) || (size - 17) % 4 !== 0) {
    throw new Error(`derived size ${size} is not a valid QR size`);
  }

  // Sample each module at its centre, then insist every pixel in it agrees —
  // a scaling or run-merging bug shows up as a module that is not uniform.
  const modules = new Uint8Array(size * size);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const x0 = (quiet + c) * scale;
      const y0 = (quiet + r) * scale;
      const value = dark(x0, y0);
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          if (dark(x0 + dx, y0 + dy) !== value) throw new Error(`module ${r},${c} is not uniform`);
        }
      }
      modules[r * size + c] = value ? 1 : 0;
    }
  }
  return { size, modules, scale, quiet };
};

// ------------------------------------------------------------- GF(256) and RS

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = x << 1;
    if (x > 0xff) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Syndromes of a received block. QR's generator is prod(x - a^i) over i = 0..ec-1,
 * so the roots start at a^0 — evaluating at a^1..a^ec instead reports a perfectly
 * good codeword as corrupt. All zero means the block lies exactly on the code,
 * i.e. the encoder's parity is right and not merely self-consistent.
 */
const syndromes = (block, ec) => {
  const out = [];
  for (let i = 0; i < ec; i += 1) {
    let acc = 0;
    for (const byte of block) acc = gmul(acc, EXP[i]) ^ byte;
    out.push(acc);
  }
  return out;
};

// ------------------------------------------------------------ block geometry

// [total codewords, ec per block, group1 blocks, group1 data, group2, data],
// level M, versions 1..20. Restated from the standard's table 9.
const M_BLOCKS = {
  1: [26, 10, 1, 16, 0, 0],
  2: [44, 16, 1, 28, 0, 0],
  3: [70, 26, 1, 44, 0, 0],
  4: [100, 18, 2, 32, 0, 0],
  5: [134, 24, 2, 43, 0, 0],
  6: [172, 16, 4, 27, 0, 0],
  7: [196, 18, 4, 31, 0, 0],
  8: [242, 22, 2, 38, 2, 39],
  9: [292, 22, 3, 36, 2, 37],
  10: [346, 26, 4, 43, 1, 44],
  11: [404, 30, 1, 50, 4, 51],
  12: [466, 22, 6, 36, 2, 37],
  13: [532, 22, 8, 37, 1, 38],
  14: [581, 24, 4, 40, 5, 41],
  15: [655, 24, 5, 41, 5, 42],
  16: [733, 28, 7, 45, 3, 46],
  17: [815, 28, 10, 46, 1, 47],
  18: [901, 26, 9, 43, 4, 44],
  19: [991, 26, 3, 44, 11, 45],
  20: [1085, 26, 3, 41, 13, 42],
};

const ALIGN_CENTRES = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
};

/** Which modules carry no data: finders, separators, timing, alignment, format, version. */
const functionMap = (size, version) => {
  const map = new Uint8Array(size * size);
  const set = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) map[r * size + c] = 1;
  };
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr += 1) for (let dc = -1; dc <= 7; dc += 1) set(r0 + dr, c0 + dc);
  }
  for (let i = 0; i < size; i += 1) {
    set(6, i);
    set(i, 6);
  }
  const last = size - 7;
  for (const r of ALIGN_CENTRES[version]) {
    for (const c of ALIGN_CENTRES[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc);
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    set(8, i);
    set(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    set(8, size - 1 - i);
    set(size - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      set(Math.floor(i / 3), size - 11 + (i % 3));
      set(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return map;
};

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// --------------------------------------------------------------- format info

const FORMAT_GEN = 0x537;
const FORMAT_XOR = 0x5412;

const formatOf = (data) => {
  let v = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (v & (1 << bit)) v ^= FORMAT_GEN << (bit - 10);
  }
  return ((data << 10) | v) ^ FORMAT_XOR;
};

// 32 legal format strings; a read that is not one of them is a hard failure
// rather than something to error-correct, because we are checking an encoder.
const FORMAT_TABLE = new Map();
for (let data = 0; data < 32; data += 1) FORMAT_TABLE.set(formatOf(data), data);

const EC_NAMES = { 0b01: 'L', 0b00: 'M', 0b11: 'Q', 0b10: 'H' };

const readFormat = (size, modules) => {
  const bit = (r, c) => modules[r * size + c];
  let copy1 = 0;
  const put1 = (i, value) => { copy1 |= value << i; };
  for (let i = 0; i <= 5; i += 1) put1(i, bit(i, 8));
  put1(6, bit(7, 8));
  put1(7, bit(8, 8));
  put1(8, bit(8, 7));
  for (let i = 9; i <= 14; i += 1) put1(i, bit(8, 14 - i));

  let copy2 = 0;
  const put2 = (i, value) => { copy2 |= value << i; };
  for (let i = 0; i <= 7; i += 1) put2(i, bit(8, size - 1 - i));
  for (let i = 8; i <= 14; i += 1) put2(i, bit(size - 15 + i, 8));

  if (copy1 !== copy2) {
    throw new Error(`format copies disagree: 0x${copy1.toString(16)} vs 0x${copy2.toString(16)}`);
  }
  if (!FORMAT_TABLE.has(copy1)) {
    throw new Error(`format bits 0x${copy1.toString(16)} fail the BCH(15,5) check`);
  }
  const data = FORMAT_TABLE.get(copy1);
  return { ecLevel: EC_NAMES[data >> 3], mask: data & 7 };
};

const VERSION_GEN = 0x1f25;

const readVersion = (size, modules) => {
  const guess = (size - 17) / 4;
  if (guess < 7) return guess;
  let bits = 0;
  for (let i = 0; i < 18; i += 1) {
    bits |= modules[Math.floor(i / 3) * size + (size - 11 + (i % 3))] << i;
  }
  const payload = bits >> 12;
  let v = payload << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if (v & (1 << bit)) v ^= VERSION_GEN << (bit - 12);
  }
  if ((((payload << 12) | v) & 0x3ffff) !== bits) {
    throw new Error(`version bits 0x${bits.toString(16)} fail the BCH(18,6) check`);
  }
  if (payload !== guess) throw new Error(`version block says ${payload} but the size says ${guess}`);
  return payload;
};

// ------------------------------------------------------------------ the read

/**
 * Matrix (no quiet zone) -> { version, mask, ecLevel, text }.
 * Throws on any inconsistency; never error-corrects.
 */
export const decodeMatrix = ({ size, modules }) => {
  if (!Number.isInteger(size) || (size - 17) % 4 !== 0) throw new Error(`bad size ${size}`);
  const version = readVersion(size, modules);
  if (!M_BLOCKS[version]) throw new Error(`version ${version} outside the checked range`);
  const { ecLevel, mask } = readFormat(size, modules);
  if (ecLevel !== 'M') throw new Error(`expected level M, symbol says ${ecLevel}`);

  const fn = functionMap(size, version);
  const rule = MASKS[mask];
  const unmasked = new Uint8Array(size * size);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const i = r * size + c;
      unmasked[i] = fn[i] ? modules[i] : modules[i] ^ (rule(r, c) ? 1 : 0);
    }
  }

  // Zigzag: column pairs right to left, alternating direction, stepping over
  // the timing column.
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const c1 = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [c1, c1 - 1]) {
        if (!fn[r * size + c]) bits.push(unmasked[r * size + c]);
      }
    }
    upward = !upward;
  }

  const [total, ec, g1, d1, g2, d2] = M_BLOCKS[version];
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b];
    codewords.push(byte);
  }
  if (codewords.length < total) throw new Error(`read ${codewords.length} codewords, need ${total}`);

  // De-interleave: data columns first (short blocks run out early), then EC.
  const blocks = [];
  for (let i = 0; i < g1; i += 1) blocks.push({ data: [], ec: [], dataLen: d1 });
  for (let i = 0; i < g2; i += 1) blocks.push({ data: [], ec: [], dataLen: d2 });
  let p = 0;
  const maxData = Math.max(d1, d2 || 0);
  for (let col = 0; col < maxData; col += 1) {
    for (const block of blocks) if (col < block.dataLen) block.data.push(codewords[p++]);
  }
  for (let col = 0; col < ec; col += 1) {
    for (const block of blocks) block.ec.push(codewords[p++]);
  }
  if (p !== total) throw new Error(`de-interleave consumed ${p} of ${total} codewords`);

  const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  blocks.forEach((block, i) => {
    const bad = syndromes([...block.data, ...block.ec], ec).filter((s) => s !== 0);
    if (bad.length > 0) {
      throw new Error(`block ${i} has non-zero Reed-Solomon syndromes\n  data ${hex(block.data)}\n  ec   ${hex(block.ec)}`);
    }
  });

  const data = blocks.flatMap((b) => b.data);
  const stream = [];
  for (const byte of data) for (let b = 7; b >= 0; b -= 1) stream.push((byte >> b) & 1);

  let at = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | (stream[at + i] ?? 0);
    at += n;
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode (0100), got ${mode.toString(2).padStart(4, '0')}`);
  const countBits = version <= 9 ? 8 : 16;
  const length = take(countBits);
  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(take(8));
  const terminator = take(4);
  if (terminator !== 0) throw new Error(`expected a terminator after the payload, got ${terminator}`);

  return { version, mask, ecLevel, text: Buffer.from(bytes).toString('utf8') };
};

/** PNG bytes straight to the encoded text. */
export const decodePng = (buf) => decodeMatrix(gridFromPng(buf));
