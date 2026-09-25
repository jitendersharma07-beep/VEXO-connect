// Reads back the PDFs that src/lib/qr/pdf.js writes, for the tests only.
//
// pdf.js assembles PDF 1.4 by hand, including the cross-reference table, so the
// byte offsets in that table are a thing this codebase computes rather than a
// thing a library guarantees. A reader that follows startxref -> xref -> object
// offset and does not land on "N 0 obj" means the file is broken for real
// readers even though it may still open in a forgiving one.
//
// It also rebuilds the QR grid from the filled rectangles, so the symbol that
// would actually be printed is checked, not just the PNG rendered from the same
// matrix.

const asLatin1 = (buf) => buf.toString('latin1');

/**
 * Walks the trailer and xref table. Returns the object bodies keyed by id and
 * throws if any recorded offset does not point at that object's header.
 */
export const parsePdf = (buf) => {
  const text = asLatin1(buf);
  if (!text.startsWith('%PDF-1.')) throw new Error('missing %PDF header');
  if (!text.endsWith('%%EOF\n')) throw new Error('missing %%EOF terminator');

  const startxrefAt = text.lastIndexOf('startxref');
  if (startxrefAt < 0) throw new Error('no startxref');
  const xrefAt = Number(text.slice(startxrefAt + 9).trim().split(/\s/)[0]);
  if (!Number.isInteger(xrefAt) || xrefAt <= 0 || xrefAt >= buf.length) {
    throw new Error(`startxref points at ${xrefAt}, outside a ${buf.length}-byte file`);
  }
  if (!text.startsWith('xref', xrefAt)) throw new Error(`byte ${xrefAt} is not the xref table`);

  const header = text.slice(xrefAt).match(/^xref\s+(\d+)\s+(\d+)\s/);
  if (!header) throw new Error('malformed xref header');
  const size = Number(header[2]);

  // The subsection starts at object 0 — its free entry occupies the first row,
  // so object N is the (N+1)th, and every entry is exactly 20 bytes.
  const rows = text.slice(xrefAt + header[0].length).slice(0, size * 20);
  const objects = new Map();
  for (let id = 0; id < size; id += 1) {
    const row = rows.slice(id * 20, (id + 1) * 20);
    // Exactly 20 bytes: offset, generation, keyword, then a two-byte EOL.
    const m = row.match(/^(\d{10}) (\d{5}) ([nf])(?: \n| \r|\r\n)$/);
    if (!m) throw new Error(`xref row for object ${id} is malformed: ${JSON.stringify(row)}`);
    if (m[3] !== 'n') continue;
    const offset = Number(m[1]);
    const expect = `${id} 0 obj`;
    if (!text.startsWith(expect, offset)) {
      throw new Error(
        `xref says object ${id} is at byte ${offset}, but that byte begins ` +
          `${JSON.stringify(text.slice(offset, offset + expect.length))}`,
      );
    }
    const end = text.indexOf('endobj', offset);
    objects.set(id, text.slice(offset + expect.length, end));
  }

  const trailer = text.slice(text.lastIndexOf('trailer'));
  const rootId = Number(trailer.match(/\/Root (\d+) 0 R/)?.[1]);
  if (!objects.has(rootId)) throw new Error('trailer /Root does not resolve');
  const declared = Number(trailer.match(/\/Size (\d+)/)?.[1]);
  if (declared !== size) throw new Error(`trailer /Size ${declared} disagrees with the xref count ${size}`);

  const pagesId = Number(objects.get(rootId).match(/\/Pages (\d+) 0 R/)?.[1]);
  const pagesObj = objects.get(pagesId);
  if (!pagesObj) throw new Error('catalog /Pages does not resolve');
  const kids = [...pagesObj.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  const count = Number(pagesObj.match(/\/Count (\d+)/)?.[1]);
  if (count !== kids.length) throw new Error(`/Count ${count} disagrees with ${kids.length} kids`);

  const pages = kids.map((id) => {
    const page = objects.get(id);
    if (!page) throw new Error(`page ${id} does not resolve`);
    const contentId = Number(page.match(/\/Contents (\d+) 0 R/)?.[1]);
    const raw = objects.get(contentId);
    if (raw === undefined) throw new Error(`page ${id} /Contents does not resolve`);
    const declaredLen = Number(raw.match(/\/Length (\d+)/)?.[1]);
    const body = raw.slice(raw.indexOf('stream\n') + 7, raw.lastIndexOf('\nendstream'));
    if (body.length !== declaredLen) {
      throw new Error(`content ${contentId} declares /Length ${declaredLen} but holds ${body.length} bytes`);
    }
    return { id, dict: page, content: body };
  });

  return { objects, pages, size };
};

/** The WinAnsi text drawn by Tj, in stream order. */
export const textsOf = (content) =>
  [...content.matchAll(/\(((?:\\.|[^\\()])*)\) Tj/g)].map((m) =>
    m[1].replace(/\\([()\\])/g, '$1'),
  );

/**
 * Rebuilds every QR grid on a page from the black-filled rectangles.
 *
 * The module pitch is taken from the shortest rectangle rather than from the
 * layout constants, so a card whose symbol was scaled or whose rows were merged
 * wrongly produces a grid that fails to decode instead of one that silently
 * matches whatever pdf.js happens to do today.
 */
export const gridsOf = (content) => {
  const fills = [...content.matchAll(/0 0 0 rg\n((?:-?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ re\n)+)f/g)];
  return fills.map((fill, index) => {
    const rects = fill[1]
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).slice(0, 4).map(Number));

    const step = Math.min(...rects.map(([, , , h]) => h));
    if (!(step > 0)) throw new Error(`symbol ${index} has a non-positive module pitch`);
    const x0 = Math.min(...rects.map(([x]) => x));
    const right = Math.max(...rects.map(([x, , w]) => x + w));
    const top = Math.max(...rects.map(([, y, , h]) => y + h));
    const bottom = Math.min(...rects.map(([, y]) => y));

    // A QR's finders touch all four sides, so the filled bounding box is the
    // symbol box and the size follows from it.
    const size = Math.round((right - x0) / step);
    const tall = Math.round((top - bottom) / step);
    if (size !== tall) throw new Error(`symbol ${index} is ${size}x${tall} modules, not square`);
    if ((size - 17) % 4 !== 0) throw new Error(`symbol ${index} derived size ${size} is not a QR size`);

    const modules = new Uint8Array(size * size);
    for (const [x, y, w, h] of rects) {
      if (Math.abs(h - step) > step * 0.02) throw new Error(`symbol ${index} has a rect ${h} tall, pitch is ${step}`);
      const r = Math.round((top - (y + h)) / step);
      const c = Math.round((x - x0) / step);
      const span = Math.round(w / step);
      for (let i = 0; i < span; i += 1) {
        const idx = r * size + c + i;
        if (modules[idx] === 1) throw new Error(`symbol ${index} fills module ${r},${c + i} twice`);
        modules[idx] = 1;
      }
    }
    return { size, modules };
  });
};
