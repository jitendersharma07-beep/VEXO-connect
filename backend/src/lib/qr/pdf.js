// Print-ready PDF for table QR cards, written by hand against the PDF 1.4
// syntax. No dependency, and no rasterisation: the symbol is drawn as filled
// vector rectangles, so a card stays sharp whether it is printed at 40mm on a
// table tent or scaled up for a wall.
//
// Text uses the base-14 Helvetica faces every reader has built in, so nothing
// has to be embedded. That is also the limitation: base-14 is WinAnsi-encoded,
// so a store or table name outside that repertoire (Devanagari, for instance)
// cannot be drawn and is replaced with '?'. The URL inside the symbol is
// unaffected — it is ASCII by construction. Fixing the label case means
// embedding a TrueType subset.

const PT_PER_MM = 72 / 25.4;
const A4 = { width: 595.28, height: 841.89 };

// Where WinAnsiEncoding differs from Latin-1: the 0x80-0x9F band.
const WIN_ANSI_EXTRA = new Map([
  ['€', 0x80],
  ['‚', 0x82],
  ['ƒ', 0x83],
  ['„', 0x84],
  ['…', 0x85],
  ['†', 0x86],
  ['‡', 0x87],
  ['ˆ', 0x88],
  ['‰', 0x89],
  ['‹', 0x8b],
  ['‘', 0x91],
  ['’', 0x92],
  ['“', 0x93],
  ['”', 0x94],
  ['•', 0x95],
  ['–', 0x96],
  ['—', 0x97],
  ['™', 0x99],
  ['›', 0x9b],
]);

const winAnsiBytes = (text) => {
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 0x0a || code === 0x0d) {
      out.push(0x20);
    } else if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
    } else if (WIN_ANSI_EXTRA.has(ch)) {
      out.push(WIN_ANSI_EXTRA.get(ch));
    } else if (code >= 0xa0 && code <= 0xff) {
      out.push(code);
    } else {
      out.push(0x3f);
    }
  }
  return Buffer.from(out);
};

// PDF string literal: backslash, both parentheses and nothing else.
const pdfString = (text) => {
  const bytes = winAnsiBytes(text);
  const parts = [Buffer.from('(', 'latin1')];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) parts.push(Buffer.from([0x5c]));
    parts.push(Buffer.from([b]));
  }
  parts.push(Buffer.from(')', 'latin1'));
  return Buffer.concat(parts).toString('latin1');
};

const n2 = (v) => (Math.round(v * 100) / 100).toString();

// Horizontal runs of dark modules become one rectangle each: a 37x37 symbol
// drops from ~700 operators to ~200, and the printed result is identical.
const symbolOps = ({ size, modules }, x, y, side) => {
  const step = side / size;
  const ops = [];
  for (let r = 0; r < size; r += 1) {
    let c = 0;
    while (c < size) {
      if (modules[r * size + c] !== 1) {
        c += 1;
        continue;
      }
      let end = c;
      while (end + 1 < size && modules[r * size + end + 1] === 1) end += 1;
      const w = (end - c + 1) * step;
      // PDF's origin is bottom-left; matrix row 0 is the symbol's top row.
      ops.push(`${n2(x + c * step)} ${n2(y + side - (r + 1) * step)} ${n2(w)} ${n2(step)} re`);
      c = end + 1;
    }
  }
  return `0 0 0 rg\n${ops.join('\n')}\nf\n`;
};

const truncate = (text, max) => {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

const LAYOUTS = {
  sheet: { cols: 2, rows: 3, cardW: 260, cardH: 248, symbol: 118, titleSize: 11, tableSize: 26 },
  single: { cols: 1, rows: 1, cardW: 420, cardH: 470, symbol: 250, titleSize: 16, tableSize: 46 },
};

// Cards are laid out from the top-left down, which is the order a person
// cutting a sheet reads them in.
const cardOrigin = (layout, index) => {
  const marginX = (A4.width - layout.cols * layout.cardW) / 2;
  const marginY = (A4.height - layout.rows * layout.cardH) / 2;
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return {
    x: marginX + col * layout.cardW,
    y: A4.height - marginY - (row + 1) * layout.cardH,
  };
};

const drawCard = (layout, card, index) => {
  const { x, y } = cardOrigin(layout, index);
  const pad = layout.cardW * 0.07;
  const left = x + pad;
  const ops = [];

  // Cut border. Light grey so it guides scissors without dominating the card.
  ops.push('q 0.78 0.78 0.78 RG 0.5 w [3 3] 0 d');
  ops.push(`${n2(x + 4)} ${n2(y + 4)} ${n2(layout.cardW - 8)} ${n2(layout.cardH - 8)} re S Q`);

  let cursor = y + layout.cardH - pad - layout.titleSize;

  const text = (font, sizePt, value, colour = '0 0 0 rg') => {
    ops.push(
      `BT ${colour} /${font} ${n2(sizePt)} Tf ${n2(left)} ${n2(cursor)} Td ${pdfString(value)} Tj ET`,
    );
  };

  text('F2', layout.titleSize, truncate(card.storeName, 34));
  cursor -= layout.titleSize * 1.25;
  text('F1', layout.titleSize * 0.82, truncate(card.placeLine, 42), '0.35 0.35 0.35 rg');

  cursor -= layout.tableSize * 1.15;
  text('F2', layout.tableSize, truncate(card.tableLabel, 16));

  const symbolTop = cursor - pad * 0.6;
  const symbolY = symbolTop - layout.symbol;
  ops.push(symbolOps(card.matrix, left, symbolY, layout.symbol));

  let footer = symbolY - layout.titleSize * 1.4;
  ops.push(
    `BT 0 0 0 rg /F1 ${n2(layout.titleSize * 0.95)} Tf ${n2(left)} ${n2(footer)} Td ` +
      `${pdfString('Scan to see the menu and order')} Tj ET`,
  );
  footer -= layout.titleSize * 1.15;
  ops.push(
    `BT 0.45 0.45 0.45 rg /F1 ${n2(layout.titleSize * 0.72)} Tf ${n2(left)} ${n2(footer)} Td ` +
      `${pdfString(truncate(card.footerLine, 58))} Tj ET`,
  );

  return ops.join('\n');
};

/**
 * @param cards  [{ storeName, placeLine, tableLabel, footerLine, matrix }]
 *               `matrix` is an encodeQr() result.
 * @param layout 'sheet' (6 per A4, with cut lines) or 'single' (one large card).
 */
export const renderQrCardsPdf = (cards, { layout = 'sheet' } = {}) => {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('cards must be a non-empty array');
  const spec = LAYOUTS[layout];
  if (!spec) throw new Error(`unknown layout "${layout}"`);
  const perPage = spec.cols * spec.rows;

  const pages = [];
  for (let i = 0; i < cards.length; i += perPage) {
    pages.push(cards.slice(i, i + perPage));
  }

  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs.
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  pages.forEach((pageCards, pageIndex) => {
    const pageId = pageIds[pageIndex];
    const contentId = pageId + 1;
    const stream = pageCards.map((card, i) => drawCard(spec, card, i)).join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(A4.width)} ${n2(A4.height)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = { stream };
  });

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];

  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id];
    const text =
      typeof body === 'string'
        ? `${id} 0 obj\n${body}\nendobj\n`
        : `${id} 0 obj\n<< /Length ${Buffer.byteLength(body.stream, 'latin1')} >>\nstream\n${body.stream}\nendstream\nendobj\n`;
    const buf = Buffer.from(text, 'latin1');
    offsets[id] = offset;
    offset += buf.length;
    chunks.push(buf);
  }

  const xrefAt = offset;
  const lines = [`xref\n0 ${objects.length}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < objects.length; id += 1) {
    lines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  lines.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  chunks.push(Buffer.from(lines.join(''), 'latin1'));

  return Buffer.concat(chunks);
};

export const mmToPt = (mm) => mm * PT_PER_MM;
