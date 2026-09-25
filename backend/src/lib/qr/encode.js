// QR Code symbol encoder (ISO/IEC 18004), byte mode, error-correction level M.
//
// Written here rather than pulled from npm because this deployment installs no
// new packages: the lane's node_modules is a read-through overlay of a shared
// dev clone and the host root filesystem is over 90% full. A printed table card
// is also the one artefact in this product a customer holds in their hand, so
// the encoder it comes from is worth having under test in-tree.
//
// Level M (~15% recovery) is the print default: a card behind glass or with a
// thumbprint on it still scans, and the symbol stays small enough to print at
// 30mm. tests/qrEncode.test.js decodes what this produces with an independent
// reader rather than comparing it to itself.

// --- GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 -----------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Product of (x + α^i) for i in 0..n-1, coefficients in descending powers.
const generatorPoly = (n) => {
  let g = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
};

const GEN_CACHE = new Map();
const genFor = (n) => {
  if (!GEN_CACHE.has(n)) GEN_CACHE.set(n, generatorPoly(n));
  return GEN_CACHE.get(n);
};

const rsRemainder = (data, ecLen) => {
  const gen = genFor(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j += 1) buf[i + j] ^= mul(gen[j], factor);
  }
  return buf.subarray(data.length);
};

// --- version characteristics, level M ----------------------------------------

// [totalCodewords, ecPerBlock, group1Blocks, group1DataCodewords,
//  group2Blocks, group2DataCodewords]. ISO/IEC 18004 table 13-22, level M rows.
// assertBlockTable() below re-derives totalCodewords from the block figures, so
// a transcription slip in either column fails at import instead of printing a
// card nobody can scan.
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

export const MAX_VERSION = 20;

const assertBlockTable = () => {
  for (const [v, [total, ec, g1, d1, g2, d2]] of Object.entries(M_BLOCKS)) {
    const sum = g1 * (d1 + ec) + g2 * (d2 + ec);
    if (sum !== total) {
      throw new Error(`QR block table is inconsistent at version ${v}: ${sum} != ${total}`);
    }
  }
};
assertBlockTable();

// Alignment pattern row/column centres. ISO/IEC 18004 annex E.
const ALIGN_CENTRES = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
};

export const sizeOfVersion = (v) => 17 + 4 * v;

const dataCodewordsOf = (v) => {
  const [, , g1, d1, g2, d2] = M_BLOCKS[v];
  return g1 * d1 + g2 * d2;
};

const countBitsOf = (v) => (v <= 9 ? 8 : 16);

// Derived, not tabulated: one fewer hand-copied column to get wrong.
export const byteCapacityOf = (v) =>
  Math.floor((dataCodewordsOf(v) * 8 - 4 - countBitsOf(v)) / 8);

// --- bit assembly -------------------------------------------------------------

const bitsToCodewords = (bits, dataCodewords) => {
  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  // Alternating 0xEC/0x11 filler, from the byte after the last data bit.
  let at = Math.ceil(bits.length / 8);
  for (let i = 0; at < dataCodewords; at += 1, i += 1) {
    out[at] = i % 2 === 0 ? 0xec : 0x11;
  }
  return out;
};

const buildBitStream = (bytes, version) => {
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBitsOf(version));
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewordsOf(version) * 8;
  // Terminator, then pad to the next codeword boundary. Both are "as many as
  // fit" — a symbol that is exactly full takes neither.
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  return bits;
};

// Data then EC, interleaved block-column-wise (ISO/IEC 18004 §8.6).
const interleave = (dataCodewords, version) => {
  const [, ec, g1, d1, g2, d2] = M_BLOCKS[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1; i += 1) {
    blocks.push(dataCodewords.subarray(at, at + d1));
    at += d1;
  }
  for (let i = 0; i < g2; i += 1) {
    blocks.push(dataCodewords.subarray(at, at + d2));
    at += d2;
  }
  const parity = blocks.map((b) => rsRemainder(b, ec));

  const out = [];
  const widest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < widest; i += 1) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ec; i += 1) {
    for (const p of parity) out.push(p[i]);
  }
  return Uint8Array.from(out);
};

// --- BCH check bits -----------------------------------------------------------

// Polynomial long division over GF(2): clear the bits above the generator's
// degree one at a time, most significant first, and what is left is the
// remainder. `degree` is the generator's degree, so the shift is by `degree`.
const bch = (value, generator, degree) => {
  let v = value << degree;
  for (let bit = 17; bit >= degree; bit -= 1) {
    if (v & (1 << bit)) v ^= generator << (bit - degree);
  }
  return v;
};

// 15-bit format information: 2 bits EC level (M = 00) + 3 bits mask, BCH(15,5)
// with generator 0x537, masked with 0x5412 so an all-zero format is impossible.
export const formatBits = (mask) => {
  const data = (0b00 << 3) | mask;
  return (((data << 10) | bch(data, 0x537, 10)) ^ 0x5412) & 0x7fff;
};

// 18-bit version information, v7+: 6 data bits + BCH(18,6), generator 0x1f25.
export const versionBits = (version) =>
  ((version << 12) | bch(version, 0x1f25, 12)) & 0x3ffff;

// --- matrix ------------------------------------------------------------------

const DARK = 1;

const newMatrix = (size) => ({
  size,
  modules: new Uint8Array(size * size),
  reserved: new Uint8Array(size * size),
});

const at = (m, r, c) => r * m.size + c;
const setFn = (m, r, c, dark) => {
  m.modules[at(m, r, c)] = dark ? DARK : 0;
  m.reserved[at(m, r, c)] = 1;
};

const placeFinder = (m, r0, c0) => {
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || c < 0 || r >= m.size || c >= m.size) continue;
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      setFn(m, r, c, dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && ring !== 2);
    }
  }
};

const placeAlignment = (m, version) => {
  const centres = ALIGN_CENTRES[version];
  const last = m.size - 7;
  for (const r of centres) {
    for (const c of centres) {
      // The three finder corners own their area; an alignment pattern there
      // would overwrite it.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(m, r + dr, c + dc, ring !== 1);
        }
      }
    }
  }
};

const placeTiming = (m) => {
  for (let i = 8; i < m.size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFn(m, 6, i, dark);
    setFn(m, i, 6, dark);
  }
};

// Reserved now, written after the mask is chosen.
const reserveFormat = (m) => {
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      m.reserved[at(m, 8, i)] = 1;
      m.reserved[at(m, i, 8)] = 1;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    m.reserved[at(m, 8, m.size - 1 - i)] = 1;
    m.reserved[at(m, m.size - 1 - i, 8)] = 1;
  }
  setFn(m, m.size - 8, 8, true); // the always-dark module
};

const reserveVersion = (m, version) => {
  if (version < 7) return;
  for (let i = 0; i < 18; i += 1) {
    m.reserved[at(m, Math.floor(i / 3), m.size - 11 + (i % 3))] = 1;
    m.reserved[at(m, m.size - 11 + (i % 3), Math.floor(i / 3))] = 1;
  }
};

const writeFormat = (m, mask) => {
  const bits = formatBits(mask);
  const bitAt = (i) => (bits >> i) & 1;
  // The format region is symmetric about the main diagonal, so a transposed
  // mapping still lands on real format modules — with the wrong bits in them,
  // and the symbol silently stops scanning. Rows/cols below are as printed.
  //
  // Copy 1, around the top-left finder: bits 0..5 down column 8, the three that
  // straddle the timing line, then bits 9..14 leftwards along row 8.
  for (let i = 0; i <= 5; i += 1) m.modules[at(m, i, 8)] = bitAt(i);
  m.modules[at(m, 7, 8)] = bitAt(6);
  m.modules[at(m, 8, 8)] = bitAt(7);
  m.modules[at(m, 8, 7)] = bitAt(8);
  for (let i = 9; i <= 14; i += 1) m.modules[at(m, 8, 14 - i)] = bitAt(i);
  // Copy 2: bits 0..7 leftwards along row 8 from the right edge, bits 8..14
  // upwards from the bottom edge in column 8. The column stops at row size-7
  // because (size-8, 8) is the always-dark module, not a format bit.
  for (let i = 0; i <= 7; i += 1) m.modules[at(m, 8, m.size - 1 - i)] = bitAt(i);
  for (let i = 8; i <= 14; i += 1) m.modules[at(m, m.size - 15 + i, 8)] = bitAt(i);
};

const writeVersion = (m, version) => {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    m.modules[at(m, Math.floor(i / 3), m.size - 11 + (i % 3))] = bit;
    m.modules[at(m, m.size - 11 + (i % 3), Math.floor(i / 3))] = bit;
  }
};

const placeData = (m, codewords) => {
  let bit = 0;
  const total = codewords.length * 8;
  let upward = true;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is not part of the data
    // region; the pair of columns steps over it rather than through it.
    const c1 = right <= 6 ? right - 1 : right;
    const c0 = c1 - 1;
    for (let step = 0; step < m.size; step += 1) {
      const r = upward ? m.size - 1 - step : step;
      for (const c of [c1, c0]) {
        if (m.reserved[at(m, r, c)]) continue;
        const value = bit < total ? (codewords[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
        m.modules[at(m, r, c)] = value;
        bit += 1;
      }
    }
    upward = !upward;
  }
  if (bit < total) throw new Error(`QR data region too small: placed ${bit} of ${total} bits`);
};

const MASK_RULES = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const applyMask = (m, mask) => {
  const rule = MASK_RULES[mask];
  const out = new Uint8Array(m.modules);
  for (let r = 0; r < m.size; r += 1) {
    for (let c = 0; c < m.size; c += 1) {
      if (m.reserved[at(m, r, c)]) continue;
      if (rule(r, c)) out[at(m, r, c)] ^= 1;
    }
  }
  return out;
};

// ISO/IEC 18004 §8.8.2 penalty scores. A high score means a symbol a scanner
// may struggle with — long same-colour runs, blocks, or shapes that look like a
// finder pattern.
const penalty = (modules, size) => {
  const get = (r, c) => modules[r * size + c];
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  const FINDER = [1, 0, 1, 1, 1, 0, 1];
  const looksLikeFinder = (line, i) => {
    for (let k = 0; k < 7; k += 1) if (line[i + k] !== FINDER[k]) return false;
    const before = line.slice(Math.max(0, i - 4), i);
    const after = line.slice(i + 7, i + 11);
    const clear = (part) => part.length >= 4 && part.every((v) => v === 0);
    return clear(before) || clear(after);
  };

  for (let r = 0; r < size; r += 1) {
    const row = [];
    const col = [];
    for (let c = 0; c < size; c += 1) {
      row.push(get(r, c));
      col.push(get(c, r));
    }
    score += runScore(row) + runScore(col);
    for (let i = 0; i + 7 <= size; i += 1) {
      if (looksLikeFinder(row, i)) score += 40;
      if (looksLikeFinder(col, i)) score += 40;
    }
  }

  for (let r = 0; r + 1 < size; r += 1) {
    for (let c = 0; c + 1 < size; c += 1) {
      const v = get(r, c);
      if (v === get(r, c + 1) && v === get(r + 1, c) && v === get(r + 1, c + 1)) score += 3;
    }
  }

  const dark = modules.reduce((a, v) => a + v, 0);
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
};

const smallestVersion = (byteLength, minVersion, maxVersion) => {
  for (let v = Math.max(1, minVersion); v <= Math.min(MAX_VERSION, maxVersion); v += 1) {
    if (byteLength <= byteCapacityOf(v)) return v;
  }
  return null;
};

/**
 * Encodes `text` as a QR symbol. Returns the module matrix without a quiet
 * zone — the renderer adds it, because the required 4-module margin is a
 * property of how the symbol is printed, not of the symbol.
 */
export const encodeQr = (text, { minVersion = 1, maxVersion = MAX_VERSION } = {}) => {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = smallestVersion(bytes.length, minVersion, maxVersion);
  if (version === null) {
    throw new Error(
      `QR payload of ${bytes.length} bytes exceeds level-M version ${maxVersion} ` +
        `(${byteCapacityOf(Math.min(MAX_VERSION, maxVersion))} bytes)`,
    );
  }

  const codewords = interleave(
    bitsToCodewords(buildBitStream(bytes, version), dataCodewordsOf(version)),
    version,
  );

  const size = sizeOfVersion(version);
  const m = newMatrix(size);
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  placeAlignment(m, version);
  placeTiming(m);
  reserveFormat(m);
  reserveVersion(m, version);
  placeData(m, codewords);
  writeVersion(m, version);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const masked = applyMask(m, mask);
    const candidate = { size, modules: masked, reserved: m.reserved, mask };
    writeFormat(candidate, mask);
    const score = penalty(candidate.modules, size);
    if (best === null || score < best.score) best = { ...candidate, score };
  }

  return { size, version, mask: best.mask, modules: best.modules };
};
