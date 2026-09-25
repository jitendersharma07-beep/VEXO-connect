// LANE reporting — CSV, XLSX and PDF, all three from the same object.
//
// None of these re-query. Each one takes the object the screen rendered and
// writes it out, so "the export says something different" is not a defect that
// can exist here: there is one set of numbers and three renderings of it.
//
// Every export carries its own provenance block — period, timezone, business-day
// cutoff, the exact stores included, the date each figure is driven by, and any
// caveat. A spreadsheet outlives the screen it came from and will be opened by
// somebody who was not there when it was run.

import { toRupees } from '../money.js';
import { zipSync } from './zip.js';

export const FORMATS = Object.freeze(['csv', 'xlsx', 'pdf', 'json']);

const cellValue = (row, column) => {
  const v = row[column.key];
  if (v === null || v === undefined) return null;
  switch (column.type) {
    case 'money':
      // Rupees, because a spreadsheet the accountant sums must not be in paise.
      // The paise are still in the JSON payload for exact comparison.
      return typeof v === 'object' ? Number(v.amount ?? toRupees(v.paise ?? 0)) : Number(v);
    case 'qty':
      return typeof v === 'object' ? Number(v.qty) : Number(v);
    case 'percent':
    case 'integer':
      return typeof v === 'number' ? v : Number(v);
    case 'coverage':
      return typeof v === 'object' ? (v.note ?? v.state) : String(v);
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
};

const unitSuffix = (row, column) => {
  if (column.type !== 'qty') return '';
  const v = row[column.key];
  return v && typeof v === 'object' && v.unitLabel ? ` ${v.unitLabel}` : '';
};

const displayValue = (row, column) => {
  const v = cellValue(row, column);
  if (v === null) return '';
  if (column.type === 'percent') return `${v}%`;
  if (column.type === 'qty') return `${v}${unitSuffix(row, column)}`;
  return String(v);
};

const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Provenance, in the order somebody reading a stray file needs it.
const provenanceRows = (report) => {
  const p = report.period;
  const rows = [
    ['Report', report.label],
    ['Period', `${p.label} (${p.from} to ${p.to})`],
    ['Timezone', p.timezone],
    ['Business day starts', hhmm(p.businessDayCutoffMinutes ?? 0)],
    ['Week starts', WEEKDAYS[p.weekStartDay] ?? String(p.weekStartDay)],
    ['Grouping', p.grouping],
    ['Period complete', p.partial ? 'No — this period is still in progress' : 'Yes'],
    [
      'Stores',
      `${report.scope.stores.length}: ${report.scope.stores.map((s) => s.name).join(', ') || 'none'}`,
    ],
    ['Currency', report.currency],
    ['Generated at', report.generatedAt],
  ];
  for (const [k, v] of Object.entries(report.basis ?? {})) rows.push([`Figures driven by — ${k}`, v]);
  for (const c of report.caveats ?? []) rows.push(['Caveat', c]);
  for (const n of report.notes ?? []) rows.push(['Note', n]);
  if (report.coverage?.note) rows.push(['Data coverage', report.coverage.note]);
  if (report.comparison) {
    rows.push(['Comparison', `${report.comparison.label} — ${report.comparison.note}`]);
  }
  return rows;
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// RFC 4180. A store called "Connaught Place, Block A" must not become two
// columns, and a note containing a newline must not become two rows.
const csvCell = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvRow = (cells) => cells.map(csvCell).join(',');

// `netSales` is a property name, not a label. Where the report already has a
// column for the key its label is reused, so the total is worded exactly as the
// column it totals; otherwise the key is turned into a readable phrase. A totals
// block that reads "netSales: 18755.67" tells the owner they are looking at a
// developer's object rather than at their own figures.
const humanizeKey = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

const totalsPairs = (totals, columns = []) => {
  const out = [];
  for (const [k, v] of Object.entries(totals ?? {})) {
    if (v === null || v === undefined) continue;
    const isMoney = v && typeof v === 'object' && 'paise' in v;
    out.push({
      label: columns.find((c) => c.key === k)?.label ?? humanizeKey(k),
      value: isMoney ? Number(v.amount) : typeof v === 'object' ? JSON.stringify(v) : v,
      money: isMoney,
    });
  }
  return out;
};

export const toCsv = (report) => {
  const lines = [];
  for (const [k, v] of provenanceRows(report)) lines.push(csvRow([`# ${k}`, v]));
  lines.push('');
  lines.push(csvRow(report.columns.map((c) => c.label)));
  for (const row of report.rows) {
    lines.push(csvRow(report.columns.map((c) => displayValue(row, c))));
  }
  if (report.totals) {
    lines.push('');
    lines.push(csvRow(['# Totals']));
    for (const t of totalsPairs(report.totals, report.columns)) {
      lines.push(csvRow([t.label, t.value]));
    }
  }
  // CRLF and a byte-order mark: Excel on Windows opens a UTF-8 CSV as Latin-1
  // without one, which turns every rupee sign and every accent into mojibake.
  return `﻿${lines.join('\r\n')}\r\n`;
};

// ---------------------------------------------------------------------------
// XLSX — SpreadsheetML in a ZIP, written directly
// ---------------------------------------------------------------------------

// Built from codepoints rather than written as a literal character class, so no
// control byte ends up in this file and every diff of it stays readable.
const CONTROL_CHARS = new RegExp(
  `[${[...Array(32).keys()]
    .filter((c) => c !== 9 && c !== 10 && c !== 13)
    .map((c) => `\\u${c.toString(16).padStart(4, '0')}`)
    .join('')}]`,
  'g',
);

// Excel refuses a file containing control characters outright, so they are
// stripped rather than escaped. They can only arrive from a pasted note.
const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(CONTROL_CHARS, '');

const colName = (index) => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const STYLE = { TEXT: 0, BOLD: 1, MONEY: 2, PERCENT: 3, INTEGER: 4 };

const styleFor = (type) =>
  type === 'money'
    ? STYLE.MONEY
    : type === 'percent'
      ? STYLE.PERCENT
      : type === 'integer'
        ? STYLE.INTEGER
        : STYLE.TEXT;

const sheetXml = (rows) => {
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          if (cell === null || cell === undefined) return '';
          if (cell.v === null || cell.v === undefined || cell.v === '') return '';
          const ref = `${colName(c)}${r + 1}`;
          const style = cell.s ? ` s="${cell.s}"` : '';
          if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
            return `<c r="${ref}"${style}><v>${cell.v}</v></c>`;
          }
          // Inline strings rather than a shared-string table: one fewer part to
          // keep consistent, and a report is written once and read once.
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${inner}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export const toXlsx = (report) => {
  const dataRows = [
    [{ v: report.label, s: STYLE.BOLD }],
    ...provenanceRows(report).map(([k, v]) => [{ v: k, s: STYLE.BOLD }, { v }]),
    [],
    report.columns.map((c) => ({ v: c.label, s: STYLE.BOLD })),
    ...report.rows.map((row) =>
      report.columns.map((c) => {
        const v = cellValue(row, c);
        if (v === null) return null;
        // A quantity keeps its unit in the cell. A spreadsheet column holding
        // both litres and kilograms as bare numbers invites exactly the sum
        // units.js exists to refuse.
        if (c.type === 'qty') return { v: `${v}${unitSuffix(row, c)}` };
        return { v, s: styleFor(c.type) };
      }),
    ),
  ];
  if (report.totals) {
    dataRows.push([]);
    dataRows.push([{ v: 'Totals', s: STYLE.BOLD }]);
    for (const t of totalsPairs(report.totals, report.columns)) {
      dataRows.push([
        { v: t.label, s: STYLE.BOLD },
        t.money ? { v: t.value, s: STYLE.MONEY } : { v: t.value },
      ]);
    }
  }

  // Excel rejects a sheet name over 31 characters or containing : \ / ? * [ ].
  const sheetName = xmlEscape(report.label).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Report';
  return zipSync([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(dataRows) },
  ]);
};

// ---------------------------------------------------------------------------
// PDF — written directly, for the same reason as the ZIP
// ---------------------------------------------------------------------------

// WinAnsi, which is what the built-in Helvetica font is encoded in. The rupee
// sign is not in it, so money is labelled with the ISO code instead of a glyph
// that would print as a wrong character.
const pdfText = (s) =>
  String(s)
    .replace(/₹/g, 'Rs ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^ -~]/g, '?')
    .replace(/([\\()])/g, '\\$1');

// A4 landscape, because a report is wide.
const PAGE = { width: 842, height: 595, margin: 36 };

// The PDF is the only one of the three that is read rather than recalculated, so
// it is the only one that formats. The CSV and XLSX keep bare numbers, because a
// spreadsheet must parse them and apply its own format.
const inr = (n) =>
  Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pdfDisplay = (row, column) => {
  const v = cellValue(row, column);
  if (v === null) return '';
  if (column.type === 'money') return inr(v);
  if (column.type === 'percent') return `${v.toFixed(2)}%`;
  if (column.type === 'integer') return Number(v).toLocaleString('en-IN');
  if (column.type === 'qty') return `${v}${unitSuffix(row, column)}`;
  return String(v);
};

// Helvetica advance widths, in 1/1000 em. Every digit is 556, so a column of
// numbers measures exactly rather than approximately — which is what makes right
// alignment land on the decimal point instead of near it.
const GLYPH = { ',': 278, '.': 278, '-': 333, '%': 889, ' ': 278 };
const textWidth = (s, size) =>
  ([...String(s)].reduce((a, ch) => a + (GLYPH[ch] ?? 556), 0) * size) / 1000;

const RIGHT_ALIGNED = new Set(['money', 'integer', 'percent']);

const wrapText = (text, maxChars) => {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line.length) line = w;
    else if (`${line} ${w}`.length <= maxChars) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [''];
};

export const toPdf = (report) => {
  const pages = [];
  let ops = [];
  let y = PAGE.height - PAGE.margin;

  const newPage = () => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = [];
    y = PAGE.height - PAGE.margin;
  };
  const line = (text, { size = 9, bold = false, indent = 0 } = {}) => {
    if (y < PAGE.margin + size * 2) newPage();
    ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${PAGE.margin + indent} ${y} Tm (${pdfText(text)}) Tj ET`,
    );
    y -= size + 3;
  };
  const gap = (n = 6) => {
    y -= n;
  };
  const rule = () => {
    if (y < PAGE.margin + 12) newPage();
    ops.push(`${PAGE.margin} ${y} m ${PAGE.width - PAGE.margin} ${y} l 0.6 w S`);
    y -= 8;
  };

  line(report.label, { size: 15, bold: true });
  gap(2);
  for (const [k, v] of provenanceRows(report)) {
    for (const [i, l] of wrapText(`${k}: ${v}`, 150).entries()) {
      line(l, { size: 8, indent: i ? 10 : 0 });
    }
  }
  gap();
  rule();

  // Columns sized by the longest thing in them, so a long note column does not
  // squeeze the money columns into each other.
  // The provenance block only appears on the first page, but the header row
  // repeats on every one. A money column on page 3 has to say what currency it
  // is in without it.
  const headerLabel = (c) => (c.type === 'money' ? `${c.label} (${report.currency})` : c.label);

  const widths = report.columns.map((c) =>
    Math.min(
      Math.max(
        report.rows.reduce((a, r) => Math.max(a, pdfDisplay(r, c).length), headerLabel(c).length),
        6,
      ),
      40,
    ),
  );
  const totalUnits = widths.reduce((a, w) => a + w, 0) || 1;
  const usable = PAGE.width - PAGE.margin * 2;
  const xs = [];
  let acc = 0;
  for (const w of widths) {
    xs.push(PAGE.margin + (acc / totalUnits) * usable);
    acc += w;
  }
  const spanOf = (i) => (i + 1 < xs.length ? xs[i + 1] : PAGE.width - PAGE.margin) - xs[i];
  const charsFor = (i) => Math.max(4, Math.floor(spanOf(i) / 4.6));
  // A right-aligned cell stops one character short of the next column, so the
  // widest number never touches the one beside it.
  const placeX = (i, text, type, size) =>
    RIGHT_ALIGNED.has(type)
      ? Math.max(xs[i], xs[i] + spanOf(i) - 5 - textWidth(text, size))
      : xs[i];

  const headerRow = () => {
    if (y < PAGE.margin + 24) newPage();
    ops.push('BT /F2 8 Tf');
    report.columns.forEach((c, i) => {
      const t = headerLabel(c).slice(0, charsFor(i));
      ops.push(`1 0 0 1 ${placeX(i, t, c.type, 8).toFixed(1)} ${y} Tm (${pdfText(t)}) Tj`);
    });
    ops.push('ET');
    y -= 12;
    rule();
  };
  headerRow();

  for (const row of report.rows) {
    if (y < PAGE.margin + 16) {
      newPage();
      headerRow();
    }
    ops.push('BT /F1 8 Tf');
    report.columns.forEach((c, i) => {
      const v = pdfDisplay(row, c).slice(0, charsFor(i));
      if (v) ops.push(`1 0 0 1 ${placeX(i, v, c.type, 8).toFixed(1)} ${y} Tm (${pdfText(v)}) Tj`);
    });
    ops.push('ET');
    y -= 11;
  }

  if (report.totals) {
    gap(4);
    rule();
    line('Totals', { size: 10, bold: true });
    // Totals are laid out as a label column and a right-aligned figure column, so
    // they line up with each other rather than trailing off after a colon.
    const pairs = totalsPairs(report.totals, report.columns);
    const labelWidth = pairs.reduce((a, t) => Math.max(a, textWidth(t.label, 8)), 0);
    const figureRight = PAGE.margin + 16 + labelWidth + 24 + 90;
    for (const t of pairs) {
      const text = t.money ? inr(t.value) : String(t.value);
      if (y < PAGE.margin + 16) newPage();
      ops.push('BT /F1 8 Tf');
      ops.push(`1 0 0 1 ${(PAGE.margin + 16).toFixed(1)} ${y} Tm (${pdfText(t.label)}) Tj`);
      ops.push(`1 0 0 1 ${(figureRight - textWidth(text, 8)).toFixed(1)} ${y} Tm (${pdfText(text)}) Tj`);
      ops.push('ET');
      y -= 11;
    }
  }
  if (!report.rows.length) {
    // An empty table needs to say why it is empty, or the reader assumes a fault.
    gap(4);
    line(report.coverage?.note ?? 'No rows in this period.', { size: 9 });
  }
  newPage();

  // --- assemble ---
  const objects = [];
  const push = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };
  const contentIds = pages.map((content) =>
    push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`),
  );
  const fontRegular = push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const fontBold = push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  // Each page names its parent, so the page-tree object number has to be known
  // before that object is written. It is predicted here and checked below: if the
  // prediction were wrong the file would be broken in a way no reader explains.
  const predictedPagesId = objects.length + pages.length + 1;
  const pageIds = contentIds.map((contentId) =>
    push(
      `<< /Type /Page /Parent ${predictedPagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ),
  );
  const pagesId = push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  if (pagesId !== predictedPagesId) {
    throw new Error(`PDF page tree id mismatch: predicted ${predictedPagesId}, wrote ${pagesId}`);
  }
  const catalogId = push(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const infoId = push(
    `<< /Title (${pdfText(report.label)}) /Subject (${pdfText(report.period.label)}) /Creator (VEXO Connect) /Producer (VEXO Connect reporting) >>`,
  );

  const chunks = ['%PDF-1.4\n'];
  const offsets = [];
  let pos = Buffer.byteLength(chunks[0], 'latin1');
  objects.forEach((body, i) => {
    const s = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    chunks.push(s);
    pos += Buffer.byteLength(s, 'latin1');
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(xref);

  return Buffer.from(chunks.join(''), 'latin1');
};

// ---------------------------------------------------------------------------

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

export const exportFilename = (report, format) =>
  `${slug(report.label)}-${report.period.from}-to-${report.period.to}.${format}`;

export const renderExport = (report, format) => {
  if (format === 'csv') {
    return { body: toCsv(report), contentType: 'text/csv; charset=utf-8' };
  }
  if (format === 'xlsx') {
    return {
      body: toXlsx(report),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if (format === 'pdf') {
    return { body: toPdf(report), contentType: 'application/pdf' };
  }
  if (format === 'json') {
    return { body: JSON.stringify(report, null, 2), contentType: 'application/json; charset=utf-8' };
  }
  throw Object.assign(new Error(`Unsupported export format: ${format}`), { statusCode: 400 });
};
