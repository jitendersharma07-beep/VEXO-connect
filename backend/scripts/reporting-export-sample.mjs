// Writes one sample report in all four formats, so the files can be opened by a
// real spreadsheet and a real PDF reader rather than only by the test's own
// parser. A test that validates a file with the same code that wrote it proves
// the code is self-consistent, not that Excel will open it.
//
//   node scripts/reporting-export-sample.mjs [outDir] [rowCount]
//
// A row count above a page's worth is the way to check that pagination repeats
// the header row and does not clip the last line.
//
// No database and no server: the sample is a hand-built canonical report object
// of exactly the shape builders.js returns.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FORMATS, renderExport, exportFilename } from '../src/lib/reporting/export.js';
import { money } from '../src/lib/reporting/metrics.js';
import { quantity, toBase, VOLUME, MASS } from '../src/lib/reporting/units.js';

const outDir = resolve(process.argv[2] ?? '/tmp/reporting-export-sample');

const report = {
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
    companyId: 'sample-co',
    storeIds: ['s1', 's2', 's3'],
    stores: [
      { id: 's1', name: 'Connaught Place, Block A' },
      { id: 's2', name: 'Saket "South Court"' },
      { id: 's3', name: 'Gurugram Cyber Hub' },
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
      milk: quantity(toBase(2.5, 'kg'), MASS, 'KG'),
      dataCoverage: { state: 'NOT_COUNTED', note: 'No physical count in this period.' },
    },
    {
      store: 'Gurugram Cyber Hub',
      netSales: money(542300),
      orders: 181,
      aov: money(2996),
      discountPercent: 2.05,
      milk: quantity(toBase(9, 'L'), VOLUME, 'L'),
      dataCoverage: { state: 'PARTIAL_COUNT', note: 'Opening count only.' },
    },
  ],
  totals: {
    netSales: money(1875567),
    orders: 626,
    aov: money(2996),
  },
  comparison: {
    label: 'Last Month (1 to 24 August)',
    note: 'Compared against the same elapsed part of the previous period.',
  },
  coverage: { state: 'PARTIAL', note: '1 of 3 locations has a complete physical count.' },
  basis: { sales: 'Invoice date', collections: 'Payment received date' },
  caveats: ['No provider settlement file has been imported.'],
  notes: ['Ratios are recalculated from company totals, not averaged across stores.'],
  meta: {},
  generatedAt: new Date().toISOString(),
};

const rowCount = Number(process.argv[3] ?? 0);
if (rowCount > report.rows.length) {
  const base = report.rows;
  report.rows = Array.from({ length: rowCount }, (_, i) => ({
    ...base[i % base.length],
    store: `${base[i % base.length].store} #${i + 1}`,
    netSales: money(100000 + i * 137),
    orders: 10 + i,
  }));
  report.totals = {
    netSales: money(report.rows.reduce((a, r) => a + r.netSales.paise, 0)),
    orders: report.rows.reduce((a, r) => a + r.orders, 0),
    aov: money(2996),
  };
}

mkdirSync(outDir, { recursive: true });
for (const format of FORMATS) {
  const { body, contentType } = renderExport(report, format);
  const path = join(outDir, exportFilename(report, format));
  writeFileSync(path, body);
  console.log(`${path}  ${contentType}`);
}
