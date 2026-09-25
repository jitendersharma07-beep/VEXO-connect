// LANE reporting — the export writers.
//
// The requirement being tested is "screen, exports and scheduled summaries
// agree". In this architecture that is meant to be true by construction: there is
// one canonical report object and three writers that only format it. This file
// checks the construction actually holds — that no writer rounds, reorders,
// relabels or quietly drops a figure the JSON payload contains.
//
// The XLSX is read back by walking the ZIP central directory, which is what Excel
// itself reads. A test that only walked the local headers would pass on a file
// Excel refuses to open.

import { describe, it, expect } from 'vitest';
import { inflateRawSync, crc32 } from 'node:zlib';

import {
  FORMATS,
  toCsv,
  toXlsx,
  toPdf,
  exportFilename,
  renderExport,
} from '../src/lib/reporting/export.js';
import { money } from '../src/lib/reporting/metrics.js';
import { quantity, toBase, VOLUME, MASS } from '../src/lib/reporting/units.js';

// ---------------------------------------------------------------------------
// A ZIP reader, so the assertions are about the bytes and not about zip.js
// agreeing with itself.
// ---------------------------------------------------------------------------

const readZip = (buf) => {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  expect(cdStart + cdSize).toBe(eocd);

  const entries = new Map();
  let p = cdStart;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const declaredCrc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // Follow the offset the central directory gave us into the local header.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`central directory points at non-local-header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(bodyStart, bodyStart + compSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

    expect(data.length).toBe(rawSize);
    expect(crc32(data)).toBe(declaredCrc);

    entries.set(name, data.toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  expect(p).toBe(eocd);
  return entries;
};

// ---------------------------------------------------------------------------
// One canonical report object, shaped exactly as builders.js `envelope` returns.
// ---------------------------------------------------------------------------

const BELL = String.fromCharCode(7); // never written literally into this file

const makeReport = (over = {}) => ({
  available: true,
  report: 'locationComparison',
  family: 'locationComparison',
  label: 'Location comparison',
  currency: 'INR',
  period: {
    preset: 'this_month',
    label: 'This Month',
    from: '2026-09-01',
    to: '2026-09-24',
    startUtc: '2026-08-31T18:30:00.000Z',
    endUtc: '2026-09-24T18:30:00.000Z',
    partial: true,
    grouping: 'day',
    timezone: 'Asia/Kolkata',
    businessDayCutoffMinutes: 300,
    weekStartDay: 1,
    financialYearStartMonth: 4,
  },
  scope: {
    companyId: 'co-1',
    storeIds: ['s1', 's2'],
    // A store name containing a comma and a quote: the CSV must not split it.
    stores: [
      { id: 's1', name: 'Connaught Place, Block A' },
      { id: 's2', name: 'Saket "South Court"' },
    ],
    narrowed: false,
    filters: {},
  },
  columns: [
    { key: 'store', label: 'Location', type: 'text' },
    { key: 'netSales', label: 'Net sales', type: 'money' },
    { key: 'orders', label: 'Finalised orders', type: 'integer' },
    { key: 'aov', label: 'Average order value', type: 'money' },
    { key: 'discountPercent', label: 'Discount %', type: 'percent' },
    { key: 'milk', label: 'Milk consumed', type: 'qty' },
    { key: 'dataCoverage', label: 'Data coverage', type: 'coverage' },
  ],
  rows: [
    {
      store: 'Connaught Place, Block A',
      netSales: money(1234567),
      orders: 412,
      aov: money(2996),
      discountPercent: 4.18,
      milk: quantity(toBase(17, 'L'), VOLUME, 'L'),
      dataCoverage: { state: 'MEASURED', note: 'Counted on 2026-09-24.' },
    },
    {
      store: 'Saket "South Court"',
      netSales: money(98700),
      orders: 33,
      aov: money(2990),
      discountPercent: 0,
      // A different unit family in the same column: the reason the unit travels
      // with the cell rather than sitting in the header.
      milk: quantity(toBase(2.5, 'kg'), MASS, 'KG'),
      dataCoverage: { state: 'NOT_COUNTED', note: 'No physical count in this period.' },
    },
  ],
  totals: {
    netSales: money(1333267),
    orders: 445,
    aov: money(2996),
  },
  comparison: {
    label: 'Last Month (1 to 24 September)',
    note: 'Compared against the same elapsed part of the previous period.',
  },
  coverage: { state: 'PARTIAL', note: '1 of 2 locations has a physical count.' },
  basis: {
    sales: 'Invoice date',
    collections: 'Payment received date',
  },
  caveats: [`No provider settlement file has been imported.${BELL}`],
  notes: ['Ratios are recalculated from company totals, not averaged across stores.'],
  meta: {},
  generatedAt: '2026-09-24T09:15:00.000Z',
  ...over,
});

const moneyColumns = (report) => report.columns.filter((c) => c.type === 'money');

// Stated here rather than imported, so the test asserts the format it expects
// instead of asserting that export.js agrees with itself.
const inr = (n) =>
  Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

describe('reporting export — format surface', () => {
  it('offers exactly the four formats the routes accept', () => {
    expect(FORMATS).toEqual(['csv', 'xlsx', 'pdf', 'json']);
  });

  it('refuses an unknown format with a 400 rather than guessing', () => {
    let err;
    try {
      renderExport(makeReport(), 'docx');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/docx/);
  });

  it('names the file after the report and its period, not the download time', () => {
    const r = makeReport();
    expect(exportFilename(r, 'xlsx')).toBe('location-comparison-2026-09-01-to-2026-09-24.xlsx');
    expect(exportFilename(r, 'csv')).toBe('location-comparison-2026-09-01-to-2026-09-24.csv');
  });

  it('serves each format with the content type its reader expects', () => {
    const r = makeReport();
    expect(renderExport(r, 'csv').contentType).toBe('text/csv; charset=utf-8');
    expect(renderExport(r, 'xlsx').contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(renderExport(r, 'pdf').contentType).toBe('application/pdf');
    expect(renderExport(r, 'json').contentType).toBe('application/json; charset=utf-8');
  });

  it('round-trips the JSON export back to the same object', () => {
    const r = makeReport();
    expect(JSON.parse(renderExport(r, 'json').body)).toEqual(JSON.parse(JSON.stringify(r)));
  });
});

describe('reporting export — CSV', () => {
  it('carries a BOM and CRLF so Excel on Windows does not mangle it', () => {
    const csv = toCsv(makeReport());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n').length).toBeGreaterThan(10);
  });

  it('quotes a store name containing a comma instead of splitting the column', () => {
    const csv = toCsv(makeReport());
    const body = csv.split('\r\n');
    const header = body.findIndex((l) => l.startsWith('Location,'));
    expect(header).toBeGreaterThan(0);
    const row = body[header + 1];
    expect(row).toContain('"Connaught Place, Block A"');
    // Seven columns, so six separators outside the quoted field.
    const outside = row.replace(/"[^"]*"/g, '');
    expect(outside.split(',').length - 1).toBe(6);
  });

  it('doubles an embedded quote per RFC 4180', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('"Saket ""South Court"""');
  });

  it('states the period, timezone, business-day cutoff and week start', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('# Period,This Month (2026-09-01 to 2026-09-24)');
    expect(csv).toContain('# Timezone,Asia/Kolkata');
    expect(csv).toContain('# Business day starts,05:00');
    expect(csv).toContain('# Week starts,Monday');
  });

  it('says the period is incomplete rather than letting it read as a full month', () => {
    expect(toCsv(makeReport())).toContain('# Period complete,No — this period is still in progress');
    const done = makeReport();
    done.period = { ...done.period, partial: false };
    expect(toCsv(done)).toContain('# Period complete,Yes');
  });

  it('names every store it included, so a filtered export cannot be mistaken for all', () => {
    const csv = toCsv(makeReport());
    // The store list itself contains commas and quotes, so the whole field is
    // quoted and the inner quotes doubled. It stays one cell.
    expect(csv).toContain('# Stores,"2: Connaught Place, Block A, Saket ""South Court"""');
  });

  it('carries the date each family of figures is driven by', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('# Figures driven by — sales,Invoice date');
    expect(csv).toContain('# Figures driven by — collections,Payment received date');
  });

  it('carries caveats, notes, coverage and the comparison basis', () => {
    const csv = toCsv(makeReport());
    expect(csv).toMatch(/# Caveat,.*No provider settlement file has been imported/);
    expect(csv).toContain('Ratios are recalculated from company totals');
    expect(csv).toContain('1 of 2 locations has a physical count.');
    expect(csv).toContain('Compared against the same elapsed part of the previous period.');
  });

  it('writes money in rupees with the paise preserved exactly', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('12345.67');
    // Written as a bare number, not padded text, so the spreadsheet parses it as
    // a number and applies its own currency format.
    expect(csv).toContain(',987,');
    expect(csv).not.toContain('1234567');
  });

  it('keeps the unit on the quantity so litres and kilograms are never one column of numbers', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('17 L');
    expect(csv).toContain('2.5 kg');
  });

  it('renders a percent as a percent, including a true zero', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('4.18%');
    expect(csv).toContain('0%');
  });

  it('prints the coverage note, so an uncounted location does not read as zero', () => {
    const csv = toCsv(makeReport());
    expect(csv).toContain('No physical count in this period.');
  });

  it('leaves a null cell empty rather than writing zero or "null"', () => {
    const r = makeReport();
    r.rows[1].netSales = null;
    r.rows[1].milk = null;
    const csv = toCsv(r);
    expect(csv).not.toMatch(/\bnull\b/);
    const line = csv.split('\r\n').find((l) => l.startsWith('"Saket'));
    expect(line).toContain('",,33,');
  });
});

describe('reporting export — XLSX', () => {
  it('is a ZIP whose central directory resolves and whose CRCs match', () => {
    const parts = readZip(toXlsx(makeReport()));
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('starts with the local file header signature Excel sniffs for', () => {
    const buf = toXlsx(makeReport());
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PK');
  });

  it('declares the worksheet, styles and workbook content types', () => {
    const parts = readZip(toXlsx(makeReport()));
    const types = parts.get('[Content_Types].xml');
    expect(types).toContain('/xl/workbook.xml');
    expect(types).toContain('/xl/worksheets/sheet1.xml');
    expect(types).toContain('/xl/styles.xml');
  });

  it('holds every money figure at exactly paise ÷ 100', () => {
    const report = makeReport();
    const sheet = readZip(toXlsx(report)).get('xl/worksheets/sheet1.xml');
    for (const row of report.rows) {
      for (const c of moneyColumns(report)) {
        expect(sheet).toContain(`<v>${row[c.key].paise / 100}</v>`);
      }
    }
    expect(sheet).toContain('<v>12345.67</v>');
    expect(sheet).toContain('<v>13332.67</v>');
  });

  it('writes money, percent and integer as numbers and quantities as text with their unit', () => {
    const sheet = readZip(toXlsx(makeReport())).get('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<v>4.18</v>');
    expect(sheet).toContain('<v>412</v>');
    expect(sheet).toContain('17 L');
    expect(sheet).toContain('2.5 kg');
  });

  it('applies a currency number format to money cells and a percent format to percents', () => {
    const parts = readZip(toXlsx(makeReport()));
    expect(parts.get('xl/styles.xml')).toContain('formatCode="#,##0.00"');
    expect(parts.get('xl/styles.xml')).toContain('numFmtId="165"');
    const sheet = parts.get('xl/worksheets/sheet1.xml');
    expect(sheet).toMatch(/s="2"><v>12345\.67<\/v>/);
    expect(sheet).toMatch(/s="3"><v>4\.18<\/v>/);
  });

  it('escapes XML metacharacters in a store name', () => {
    const r = makeReport();
    r.rows[0].store = 'Tom & Jerry <Deli>';
    const sheet = readZip(toXlsx(r)).get('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('Tom &amp; Jerry &lt;Deli&gt;');
    expect(sheet).not.toContain('<Deli>');
  });

  it('strips a control character rather than producing a file Excel refuses', () => {
    const buf = toXlsx(makeReport());
    const sheet = readZip(buf).get('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('No provider settlement file has been imported.');
    expect(sheet).not.toContain(BELL);
    expect(sheet.codePointAt(0)).toBe(0x3c);
    for (const ch of sheet) {
      const cp = ch.codePointAt(0);
      if (cp < 32) expect([9, 10, 13]).toContain(cp);
    }
  });

  it('keeps the sheet name legal: no forbidden character, never over 31 chars', () => {
    const r = makeReport({ label: 'Sales: daily / weekly [by store] *2026*' });
    const wb = readZip(toXlsx(r)).get('xl/workbook.xml');
    const name = /name="([^"]*)"/.exec(wb)[1];
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[:\\/?*[\]]/);
  });

  it('carries the same provenance block as the CSV', () => {
    const r = makeReport();
    const sheet = readZip(toXlsx(r)).get('xl/worksheets/sheet1.xml');
    for (const [key] of Object.entries(r.basis)) {
      expect(sheet).toContain(`Figures driven by — ${key}`);
    }
    expect(sheet).toContain('Asia/Kolkata');
    expect(sheet).toContain('05:00');
    expect(sheet).toContain('2026-09-24T09:15:00.000Z');
  });

  it('survives an empty report without emitting a broken sheet', () => {
    const parts = readZip(toXlsx(makeReport({ rows: [], totals: null })));
    const sheet = parts.get('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<sheetData>');
    expect(sheet).toContain('Location');
  });
});

describe('reporting export — PDF', () => {
  const parsePdf = (buf) => {
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    const startxref = Number(/startxref\s+(\d+)/.exec(text)[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const size = Number(/\/Size (\d+)/.exec(text)[1]);
    const table = text.slice(startxref);
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBe(size - 1);
    // Every xref offset must land on the object it claims, or a reader shows a
    // blank page with no error.
    offsets.forEach((off, i) => {
      expect(text.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
    return { text, size };
  };

  it('is a structurally valid PDF whose xref offsets all resolve', () => {
    parsePdf(toPdf(makeReport()));
  });

  it('names a catalog, a page tree and every page that tree claims', () => {
    const { text } = parsePdf(toPdf(makeReport()));
    expect(text).toContain('/Type /Catalog');
    const count = Number(/\/Type \/Pages[^>]*\/Count (\d+)/.exec(text)[1]);
    const kids = /\/Kids \[([^\]]*)\]/.exec(text)[1].trim().split(/\s+0 R\s*/).filter(Boolean);
    expect(kids.length).toBe(count);
    expect((text.match(/\/Type \/Page\b(?!s)/g) ?? []).length).toBe(count);
  });

  it('every page points back at the real page tree object', () => {
    const { text } = parsePdf(toPdf(makeReport()));
    const pagesId = Number(/(\d+) 0 obj\n<< \/Type \/Pages/.exec(text)[1]);
    for (const m of text.matchAll(/\/Type \/Page \/Parent (\d+) 0 R/g)) {
      expect(Number(m[1])).toBe(pagesId);
    }
  });

  it('declares each content stream length as the bytes actually written', () => {
    const { text } = parsePdf(toPdf(makeReport()));
    const streams = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
    expect(streams.length).toBeGreaterThan(0);
    for (const [, declared, body] of streams) {
      expect(Buffer.byteLength(body, 'latin1')).toBe(Number(declared));
    }
  });

  it('prints the title, the period and the provenance', () => {
    const { text } = parsePdf(toPdf(makeReport()));
    expect(text).toContain('(Location comparison)');
    // Parentheses delimit a PDF string, so a period label containing them must
    // arrive escaped or the rest of the line is swallowed.
    expect(text).toContain('This Month \\(2026-09-01 to 2026-09-24\\)');
    expect(text).toContain('Asia/Kolkata');
    expect(text).toContain('Business day starts: 05:00');
  });

  it('substitutes the rupee sign rather than printing a wrong glyph in Helvetica', () => {
    const { text } = parsePdf(toPdf(makeReport({ label: 'Sales ₹ summary' })));
    expect(text).toContain('Sales Rs  summary');
    expect(text).not.toContain('₹');
    for (let i = 0; i < text.length; i += 1) {
      expect(text.charCodeAt(i)).toBeLessThan(256);
    }
  });

  it('escapes a parenthesis in a store name instead of ending the string early', () => {
    const r = makeReport();
    r.rows[0].store = 'Saket (DLF) \\ Mall';
    const { text } = parsePdf(toPdf(r));
    expect(text).toContain('Saket \\(DLF\\) \\\\ Mall');
  });

  it('names the currency in the money header, which is what repeats on page 2', () => {
    const { text } = parsePdf(toPdf(makeReport()));
    expect(text).toContain('Net sales \\(INR\\)');
    expect(text).toContain('(Location)'); // a text column keeps its plain label
  });

  it('paginates a long report and repeats the header row on each page', () => {
    const r = makeReport();
    r.rows = Array.from({ length: 140 }, (_, i) => ({
      store: `Store ${i + 1}`,
      netSales: money(100000 + i),
      orders: i,
      aov: money(2500),
      discountPercent: 1.5,
      milk: quantity(toBase(1, 'L'), VOLUME, 'L'),
      dataCoverage: { state: 'MEASURED', note: 'Counted.' },
    }));
    const { text } = parsePdf(toPdf(r));
    const count = Number(/\/Type \/Pages[^>]*\/Count (\d+)/.exec(text)[1]);
    expect(count).toBeGreaterThan(1);
    expect((text.match(/\(Location\) Tj/g) ?? []).length).toBeGreaterThanOrEqual(count);
    expect(text).toContain('(Store 140)');
  });

  it('says why an empty table is empty instead of leaving a blank page', () => {
    const { text } = parsePdf(toPdf(makeReport({ rows: [], totals: null })));
    expect(text).toContain('1 of 2 locations has a physical count.');
  });

  it('falls back to a plain explanation when there is no coverage note either', () => {
    const { text } = parsePdf(toPdf(makeReport({ rows: [], totals: null, coverage: null })));
    expect(text).toContain('No rows in this period.');
  });
});

describe('reporting export — the three writers agree', () => {
  const report = makeReport();
  const csv = toCsv(report);
  const sheet = readZip(toXlsx(report)).get('xl/worksheets/sheet1.xml');
  const pdf = toPdf(report).toString('latin1');

  it('shows every money figure in the payload, unrounded, in all three', () => {
    const seen = [];
    for (const row of report.rows) {
      for (const c of moneyColumns(report)) seen.push(row[c.key].paise);
    }
    for (const [, v] of Object.entries(report.totals)) {
      if (v && typeof v === 'object' && 'paise' in v) seen.push(v.paise);
    }
    expect(seen.length).toBe(6); // 2 rows x 2 money columns, plus 2 money totals
    for (const paise of seen) {
      // Same value, three renderings: the spreadsheet formats get a bare number
      // to parse, the PDF gets the grouped form a person reads.
      const bare = String(paise / 100);
      const grouped = inr(paise / 100);
      expect(csv, `csv missing ${bare}`).toContain(bare);
      expect(sheet, `xlsx missing ${bare}`).toContain(bare);
      expect(pdf, `pdf missing ${grouped}`).toContain(grouped);
    }
  });

  it('groups the PDF figures for reading without changing the value', () => {
    expect(pdf).toContain('12,345.67'); // 1234567 paise
    expect(pdf).toContain('987.00'); //      98700 paise, padded so decimals line up
    expect(csv).not.toContain('12,345.67'); // a grouped number would not parse
    expect(sheet).not.toContain('12,345.67');
  });

  it('labels every column identically in all three', () => {
    for (const c of report.columns) {
      expect(csv, `csv missing ${c.label}`).toContain(c.label);
      expect(sheet, `xlsx missing ${c.label}`).toContain(c.label);
      expect(pdf, `pdf missing ${c.label}`).toContain(c.label.slice(0, 8));
    }
  });

  it('carries the same period, timezone and generation instant in all three', () => {
    for (const fact of ['Asia/Kolkata', '2026-09-01', '2026-09-24', '2026-09-24T09:15:00.000Z']) {
      expect(csv, `csv missing ${fact}`).toContain(fact);
      expect(sheet, `xlsx missing ${fact}`).toContain(fact);
      expect(pdf, `pdf missing ${fact}`).toContain(fact);
    }
  });

  it('carries the same caveat in all three, so no rendering looks more certain', () => {
    const caveat = 'No provider settlement file has been imported.';
    expect(csv).toContain(caveat);
    expect(sheet).toContain(caveat);
    expect(pdf).toContain(caveat);
  });

  it('keeps the uncounted location uncounted in all three — never zero', () => {
    const note = 'No physical count in this period.';
    expect(csv).toContain(note);
    expect(sheet).toContain(note);
    expect(pdf).toContain(note);
  });

  it('never presents a quantity without its unit in any rendering', () => {
    for (const out of [csv, sheet, pdf]) {
      expect(out).toContain('17 L');
      expect(out).toContain('2.5 kg');
    }
  });

  it('shows the same totals in all three', () => {
    for (const out of [csv, sheet, pdf]) {
      expect(out).toMatch(/[Tt]otals/);
      expect(out).toContain('445');
    }
    expect(csv).toContain('13332.67');
    expect(sheet).toContain('13332.67');
    expect(pdf).toContain('13,332.67');
  });

  it('labels totals with the words the columns use, never the property name', () => {
    for (const out of [csv, sheet, pdf]) {
      expect(out).toContain('Net sales');
      expect(out).toContain('Finalised orders');
      expect(out, 'a raw object key reached the reader').not.toMatch(/netSales/);
    }
  });

  it('humanises a totals key that has no column of its own', () => {
    const r = makeReport();
    r.totals = { ...r.totals, unreconcilableValue: money(50000) };
    expect(toCsv(r)).toContain('Unreconcilable value');
    expect(toPdf(r).toString('latin1')).toContain('Unreconcilable value');
  });
});
