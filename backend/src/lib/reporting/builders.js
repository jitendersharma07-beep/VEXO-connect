// LANE reporting — one builder per report, returning one canonical object.
//
// Every report is the same shape: columns, rows, totals, period, scope, coverage,
// caveats. The screen renders it, the drill-down filters it, and the CSV, XLSX and
// PDF writers serialise it. None of them re-query, so "the export disagrees with
// the screen" is not a bug that can be introduced here — there is only one number
// and three ways of looking at it.
//
// A column declares its own type so a formatter never has to guess. `money` is
// paise in the payload and rupees on the page; `qty` carries its unit with it;
// `percent` is already a percentage, not a fraction.

import { prisma } from '../prisma.js';
import { toRupees } from '../money.js';
import { paiseOf } from '../orders.js';
import { orderScopeWhere, viaOrderScopeWhere } from './scope.js';
import { periodDescriptor, businessDatesIn } from './period.js';
import { readMoney, publicTotals, money, ratio, aovPaise, SALES_STATUSES, deltaOf } from './metrics.js';
import { AVAILABLE, storeCoverage, DATA_NEVER_RECORDED } from './capability.js';
import { fromBase, toBase, displayUnitFor, VOLUME, MASS, COUNT } from './units.js';

const col = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

export const REPORT_KEYS = [
  'sales',
  'salesByPeriod',
  'tax',
  'discounts',
  'collections',
  'dues',
  'refunds',
  'settlement',
  'locationComparison',
  'productMix',
  'cash',
  'consumption',
  'wastage',
  'stockValuation',
  'expiry',
  'transfers',
  'purchasing',
  'kitchenDelays',
  'loyalty',
  'delivery',
  'profitability',
];

// Which capability family each report belongs to. Several reports share one
// family — a sales report and a sales-by-period report are the same data asked a
// different way — and the family is what decides whether the data exists at all.
export const FAMILY_OF = Object.freeze({
  sales: 'sales',
  salesByPeriod: 'sales',
  tax: 'sales',
  discounts: 'sales',
  collections: 'collections',
  dues: 'dues',
  refunds: 'refunds',
  settlement: 'settlement',
  locationComparison: 'locationComparison',
  productMix: 'productMix',
  cash: 'cash',
  consumption: 'consumption',
  wastage: 'wastage',
  stockValuation: 'stockValuation',
  expiry: 'expiry',
  transfers: 'transfers',
  purchasing: 'purchasing',
  kitchenDelays: 'kitchenDelays',
  loyalty: 'loyalty',
  delivery: 'delivery',
  profitability: 'profitability',
});

const storeNameMap = (scope) => new Map(scope.stores.map((s) => [s.id, s]));

/**
 * Wrap a builder's rows in the canonical envelope.
 *
 * `basis` travels with the report because §3 requires each date to stay
 * explainable: an owner comparing sales to collections is comparing billedAt to
 * a payment's createdAt, and the payload says so rather than leaving them to
 * assume the two are the same clock.
 */
const envelope = ({
  key,
  label,
  period,
  scope,
  columns,
  rows,
  totals = null,
  comparison = null,
  coverage = null,
  basis = null,
  caveats = [],
  notes = [],
  meta = {},
}) => ({
  available: true,
  report: key,
  family: FAMILY_OF[key] ?? key,
  label,
  currency: 'INR',
  period: periodDescriptor(period),
  scope: {
    companyId: scope.companyId,
    storeIds: scope.storeIds,
    stores: scope.stores,
    narrowed: scope.narrowed,
    filters: scope.filters,
  },
  columns,
  rows,
  totals,
  comparison,
  coverage,
  basis,
  caveats,
  notes,
  meta,
  generatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Money reports — all five read one pass and differ only in presentation
// ---------------------------------------------------------------------------

const withComparison = async ({ scope, period, current }) => {
  if (!period.comparison) return null;
  const previous = await readMoney({
    scope,
    period,
    window: { startUtc: period.comparison.startUtc, endUtc: period.comparison.endUtc },
  });
  const p = previous.total;
  const c = current.total;
  return {
    basis: period.comparison.basis,
    label: period.comparison.label,
    from: period.comparison.from,
    to: period.comparison.to,
    // Spelled out because the two bases answer different questions. A partial
    // period compared against the whole of the previous one always looks like a
    // collapse, so today-so-far is compared against yesterday-to-this-time.
    note:
      period.comparison.basis === 'SAME_ELAPSED'
        ? 'Compared against the same elapsed time in the previous period.'
        : 'Compared against the whole of the previous period.',
    previous: publicTotals(p),
    delta: {
      netSales: deltaOf(c.netSalesPaise, p.netSalesPaise),
      collected: deltaOf(c.collectedPaise, p.collectedPaise),
      refunds: deltaOf(c.refundsPaise, p.refundsPaise),
      discounts: deltaOf(c.discountsPaise, p.discountsPaise),
      finalizedOrders: deltaOf(c.finalizedOrders, p.finalizedOrders),
      averageOrderValue: deltaOf(
        aovPaise(c.netSalesPaise, c.finalizedOrders) ?? 0,
        aovPaise(p.netSalesPaise, p.finalizedOrders),
      ),
    },
  };
};

const coverageForStores = async ({ scope, period, money: m, settings, now }) => {
  // "Never traded" needs a question the period cannot answer, so it is asked
  // once for the stores that are empty in this window rather than for all of them.
  const emptyIds = scope.storeIds.filter((id) => !m.perStore.get(id)?.finalizedOrders);
  const everRecorded = new Set();
  const lastSeen = new Map();
  if (emptyIds.length) {
    const rows = await prisma.order.groupBy({
      by: ['branchId'],
      where: { companyId: scope.companyId, branchId: { in: emptyIds } },
      _max: { createdAt: true },
    });
    for (const r of rows) {
      everRecorded.add(r.branchId);
      lastSeen.set(r.branchId, r._max.createdAt);
    }
  }
  const out = {};
  for (const id of scope.storeIds) {
    const row = m.perStore.get(id);
    out[id] = storeCoverage({
      rowsInPeriod: row?.finalizedOrders ?? 0,
      lastActivityAt: row?.lastActivityAt ?? lastSeen.get(id) ?? null,
      everRecorded: Boolean(row?.finalizedOrders) || everRecorded.has(id),
      period,
      staleAfterMinutes: settings.staleAfterMinutes,
      now,
    });
  }
  const counted = Object.values(out);
  return {
    stores: out,
    summary: {
      total: counted.length,
      active: counted.filter((c) => c.state === 'ACTIVE').length,
      noActivity: counted.filter((c) => c.state === 'NO_ACTIVITY').length,
      neverRecorded: counted.filter((c) => c.state === DATA_NEVER_RECORDED).length,
      stale: counted.filter((c) => c.state === 'STALE').length,
    },
  };
};

const SALES_COLUMNS = [
  col('storeName', 'Store', 'text'),
  col('grossItems', 'Gross items', 'money'),
  col('itemDiscounts', 'Item discounts', 'money'),
  col('orderDiscounts', 'Bill discounts', 'money'),
  col('netSales', 'Net sales (excl. tax)', 'money'),
  col('tax', 'Tax', 'money'),
  // Both figures on the row on purpose. Net sales is what the business earned;
  // invoiced is what the bill said, and it is the only figure a collection can
  // sensibly be compared against. Showing one without the other is what makes
  // "collected is more than we sold" look like a bug.
  col('invoiced', 'Invoiced (incl. tax)', 'money'),
  col('finalizedOrders', 'Bills', 'integer'),
  col('averageOrderValue', 'Average bill', 'money'),
  col('discountRatePercent', 'Discount rate', 'percent'),
];

const storeRows = (scope, m, pick) => {
  const names = storeNameMap(scope);
  return scope.storeIds.map((id) => {
    const t = m.perStore.get(id) ?? null;
    const s = names.get(id);
    return {
      storeId: id,
      storeName: s?.name ?? id,
      storeCode: s?.code ?? null,
      regionName: s?.regionName ?? null,
      ...pick(t),
    };
  });
};

const emptyRowFor = (columns) =>
  Object.fromEntries(columns.filter((c) => c.type !== 'text').map((c) => [c.key, null]));

export const buildSales = async (ctx) => {
  const { scope, period, settings, now } = ctx;
  const m = await readMoney({ scope, period });
  const rows = storeRows(scope, m, (t) =>
    t
      ? {
          grossItems: money(t.grossItemsPaise),
          itemDiscounts: money(t.itemDiscountsPaise),
          orderDiscounts: money(t.orderDiscountsPaise),
          netSales: money(t.netSalesPaise),
          tax: money(t.taxPaise),
          invoiced: money(t.invoicedPaise),
          finalizedOrders: t.finalizedOrders,
          averageOrderValue: t.finalizedOrders ? money(aovPaise(t.netSalesPaise, t.finalizedOrders)) : null,
          discountRatePercent: ratio(t.discountsPaise, t.grossItemsPaise),
        }
      : emptyRowFor(SALES_COLUMNS),
  );
  return envelope({
    key: 'sales',
    label: 'Sales, tax and discounts',
    period,
    scope,
    columns: SALES_COLUMNS,
    rows,
    totals: publicTotals(m.total),
    comparison: await withComparison({ scope, period, current: m }),
    coverage: await coverageForStores({ scope, period, money: m, settings, now }),
    basis: { sales: m.basis.sales },
  });
};

export const buildSalesByPeriod = async (ctx) => {
  const { scope, period } = ctx;
  const m = await readMoney({ scope, period });
  const columns = [
    col('bucketLabel', period.grouping === 'DAY' ? 'Day' : period.grouping === 'WEEK' ? 'Week' : 'Month', 'text'),
    col('netSales', 'Net sales', 'money'),
    col('finalizedOrders', 'Bills', 'integer'),
    col('averageOrderValue', 'Average bill', 'money'),
    col('collected', 'Collected', 'money'),
    col('refunds', 'Refunds', 'money'),
    col('discounts', 'Discounts', 'money'),
  ];
  const rows = period.buckets.map((b) => {
    const t = m.perBucket.get(b.key);
    return {
      bucketKey: b.key,
      bucketLabel: b.label,
      from: b.from,
      to: b.to,
      // A bucket in the future is not a zero: nothing has happened in it yet, and
      // a chart that plots it at the axis invents a collapse in trade.
      future: b.future ?? false,
      partial: b.partial ?? false,
      netSales: b.future ? null : money(t?.netSalesPaise ?? 0),
      finalizedOrders: b.future ? null : (t?.finalizedOrders ?? 0),
      averageOrderValue:
        t?.finalizedOrders > 0 ? money(aovPaise(t.netSalesPaise, t.finalizedOrders)) : null,
      collected: b.future ? null : money(t?.collectedPaise ?? 0),
      refunds: b.future ? null : money(t?.refundsPaise ?? 0),
      discounts: b.future ? null : money(t?.discountsPaise ?? 0),
    };
  });
  return envelope({
    key: 'salesByPeriod',
    label: `Sales by ${period.grouping.toLowerCase()}`,
    period,
    scope,
    columns,
    rows,
    totals: publicTotals(m.total),
    comparison: await withComparison({ scope, period, current: m }),
    basis: m.basis,
    notes: rows.some((r) => r.future)
      ? ['Periods that have not happened yet are shown as blank, not as zero.']
      : [],
  });
};

export const buildTax = async (ctx) => {
  const { scope, period } = ctx;
  const orderScope = orderScopeWhere(scope);
  const orders = await prisma.order.findMany({
    where: { ...orderScope, status: { in: SALES_STATUSES }, billedAt: { gte: period.startUtc, lt: period.endUtc } },
    select: { id: true, branchId: true },
  });
  const byRate = new Map();
  if (orders.length) {
    const items = await prisma.orderItem.groupBy({
      by: ['taxRateName', 'taxRatePercent'],
      where: { orderId: { in: orders.map((o) => o.id) }, status: 'ACTIVE' },
      _sum: { lineSubtotal: true, lineTax: true, discountShare: true },
      _count: { _all: true },
    });
    for (const r of items) {
      // An untaxed line is its own bucket, not a 0% rate: "no tax rate was set"
      // and "this is exempt" are different answers to a tax officer.
      const name = r.taxRateName ?? 'No tax rate set';
      const percent = r.taxRatePercent === null ? null : Number(r.taxRatePercent);
      const key = `${name}|${percent}`;
      const row = byRate.get(key) ?? { name, percent, taxablePaise: 0, taxPaise: 0, lines: 0 };
      row.taxablePaise += paiseOf(r._sum.lineSubtotal ?? 0) - paiseOf(r._sum.discountShare ?? 0);
      row.taxPaise += paiseOf(r._sum.lineTax ?? 0);
      row.lines += r._count._all;
      byRate.set(key, row);
    }
  }
  const rows = [...byRate.values()]
    .sort((a, b) => b.taxPaise - a.taxPaise)
    .map((r) => ({
      rateName: r.name,
      ratePercent: r.percent,
      taxable: money(r.taxablePaise),
      tax: money(r.taxPaise),
      lines: r.lines,
    }));
  const taxablePaise = rows.reduce((a, r) => a + r.taxable.paise, 0);
  const taxPaise = rows.reduce((a, r) => a + r.tax.paise, 0);
  return envelope({
    key: 'tax',
    label: 'Tax by rate',
    period,
    scope,
    columns: [
      col('rateName', 'Tax rate', 'text'),
      col('ratePercent', 'Rate', 'percent'),
      col('taxable', 'Taxable value', 'money'),
      col('tax', 'Tax', 'money'),
      col('lines', 'Lines', 'integer'),
    ],
    rows,
    totals: { taxable: money(taxablePaise), tax: money(taxPaise), lines: rows.reduce((a, r) => a + r.lines, 0) },
    basis: { sales: 'Order.billedAt — the date the invoice was raised' },
    notes: [
      'Taxable value is the line subtotal after its share of any bill-level discount, which is the base the tax was charged on.',
    ],
  });
};

export const buildDiscounts = async (ctx) => {
  const { scope, period } = ctx;
  const m = await readMoney({ scope, period });
  const rows = storeRows(scope, m, (t) => ({
    grossItems: money(t?.grossItemsPaise ?? 0),
    itemDiscounts: money(t?.itemDiscountsPaise ?? 0),
    orderDiscounts: money(t?.orderDiscountsPaise ?? 0),
    discounts: money(t?.discountsPaise ?? 0),
    netSales: money(t?.netSalesPaise ?? 0),
    discountRatePercent: t ? ratio(t.discountsPaise, t.grossItemsPaise) : null,
  }));
  return envelope({
    key: 'discounts',
    label: 'Discounts given',
    period,
    scope,
    columns: [
      col('storeName', 'Store', 'text'),
      col('grossItems', 'Gross items', 'money'),
      col('itemDiscounts', 'Item discounts', 'money'),
      col('orderDiscounts', 'Bill discounts', 'money'),
      col('discounts', 'Total discounts', 'money'),
      col('discountRatePercent', 'Discount rate', 'percent'),
    ],
    rows,
    totals: publicTotals(m.total),
    comparison: await withComparison({ scope, period, current: m }),
    basis: { sales: m.basis.sales },
  });
};

export const buildCollections = async (ctx) => {
  const { scope, period } = ctx;
  const m = await readMoney({ scope, period });
  const total = m.byMethod.reduce((a, r) => a + r.amountPaise, 0);
  const rows = m.byMethod.map((r) => ({
    method: r.method,
    channel: r.channel,
    // Spelled out because "UPI" collected by hand and "UPI" confirmed by a
    // provider webhook are evidence of very different strength.
    channelLabel: r.channel === 'GATEWAY' ? 'Provider-settled' : 'Hand-recorded',
    amount: money(r.amountPaise),
    count: r.count,
    sharePercent: ratio(r.amountPaise, total),
  }));
  return envelope({
    key: 'collections',
    label: 'Collections by payment method',
    period,
    scope,
    columns: [
      col('method', 'Method', 'text'),
      col('channelLabel', 'Recorded as', 'text'),
      col('amount', 'Collected', 'money'),
      col('count', 'Payments', 'integer'),
      col('sharePercent', 'Share', 'percent'),
    ],
    rows,
    totals: {
      collected: money(total),
      netSales: money(m.total.netSalesPaise),
      invoiced: money(m.total.invoicedPaise),
      // Against the invoiced figure: money arrives tax-inclusive.
      collectedVsSalesPercent: ratio(m.total.collectedPaise, m.total.invoicedPaise),
      payments: rows.reduce((a, r) => a + r.count, 0),
    },
    comparison: await withComparison({ scope, period, current: m }),
    basis: { collections: m.basis.collections, sales: m.basis.sales },
    notes: [
      'Collected can differ from net sales in either direction: a bill raised yesterday may be paid today, and a bill raised today may still be unpaid.',
    ],
  });
};

export const buildDues = async (ctx) => {
  const { scope, period } = ctx;
  const orderScope = orderScopeWhere(scope);
  const orders = await prisma.order.findMany({
    where: { ...orderScope, status: 'BILLED', billedAt: { lt: period.endUtc } },
    select: {
      id: true,
      branchId: true,
      billedAt: true,
      invoiceNumber: true,
      total: true,
      payments: { select: { amount: true } },
    },
    orderBy: { billedAt: 'asc' },
  });
  const names = storeNameMap(scope);
  const rows = [];
  for (const o of orders) {
    const paid = o.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
    const outstanding = paiseOf(o.total) - paid;
    if (outstanding <= 0) continue;
    const ageDays = Math.floor((period.endUtc.getTime() - o.billedAt.getTime()) / 86400000);
    rows.push({
      orderId: o.id,
      invoiceNumber: o.invoiceNumber ?? null,
      storeId: o.branchId,
      storeName: names.get(o.branchId)?.name ?? o.branchId,
      billedAt: o.billedAt.toISOString(),
      total: money(paiseOf(o.total)),
      paid: money(paid),
      outstanding: money(outstanding),
      ageDays,
      // Buckets, because a bill three days old and one three months old are not
      // the same problem even though both are "due".
      ageBucket: ageDays <= 7 ? '0-7 days' : ageDays <= 30 ? '8-30 days' : ageDays <= 90 ? '31-90 days' : 'Over 90 days',
    });
  }
  rows.sort((a, b) => b.outstanding.paise - a.outstanding.paise);
  return envelope({
    key: 'dues',
    label: 'Outstanding dues',
    period,
    scope,
    columns: [
      col('invoiceNumber', 'Bill', 'text'),
      col('storeName', 'Store', 'text'),
      col('billedAt', 'Billed', 'datetime'),
      col('total', 'Bill total', 'money'),
      col('paid', 'Paid', 'money'),
      col('outstanding', 'Outstanding', 'money'),
      col('ageBucket', 'Age', 'text'),
    ],
    rows,
    totals: {
      dues: money(rows.reduce((a, r) => a + r.outstanding.paise, 0)),
      dueOrders: rows.length,
    },
    basis: { dues: 'Outstanding on every unpaid bill as at the end of the period, whenever it was raised' },
    notes: [
      'This is a position, not a period figure: it includes bills raised before this period that are still unpaid.',
    ],
  });
};

export const buildRefunds = async (ctx) => {
  const { scope, period } = ctx;
  const refunds = await prisma.refund.findMany({
    where: { ...viaOrderScopeWhere(scope), createdAt: { gte: period.startUtc, lt: period.endUtc } },
    select: {
      id: true,
      createdAt: true,
      amount: true,
      status: true,
      method: true,
      channel: true,
      reason: true,
      order: { select: { id: true, invoiceNumber: true, branchId: true, total: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const names = storeNameMap(scope);
  const rows = refunds.map((r) => ({
    refundId: r.id,
    orderId: r.order?.id ?? null,
    invoiceNumber: r.order?.invoiceNumber ?? null,
    storeId: r.order?.branchId ?? null,
    storeName: r.order?.branchId ? (names.get(r.order.branchId)?.name ?? r.order.branchId) : null,
    createdAt: r.createdAt.toISOString(),
    amount: money(paiseOf(r.amount)),
    status: r.status,
    method: r.method,
    channel: r.channel,
    reason: r.reason ?? null,
    // The share of the bill that came back. A full refund and a ₹20 goodwill
    // gesture read identically in a money column.
    ofBillPercent: r.order?.total ? ratio(paiseOf(r.amount), paiseOf(r.order.total)) : null,
  }));
  const succeeded = rows.filter((r) => r.status === 'SUCCEEDED');
  const pending = rows.filter((r) => r.status === 'PENDING');
  const failed = rows.filter((r) => r.status === 'FAILED');
  const sum = (list) => list.reduce((a, r) => a + r.amount.paise, 0);
  return envelope({
    key: 'refunds',
    label: 'Refunds',
    period,
    scope,
    columns: [
      col('invoiceNumber', 'Bill', 'text'),
      col('storeName', 'Store', 'text'),
      col('createdAt', 'Refunded', 'datetime'),
      col('amount', 'Amount', 'money'),
      col('ofBillPercent', 'Of bill', 'percent'),
      col('status', 'Status', 'text'),
      col('method', 'Method', 'text'),
      col('reason', 'Reason', 'text'),
    ],
    rows,
    totals: {
      refunds: money(sum(succeeded)),
      refundsPending: money(sum(pending)),
      refundsFailed: money(sum(failed)),
      count: rows.length,
      succeededCount: succeeded.length,
      pendingCount: pending.length,
      failedCount: failed.length,
    },
    basis: { refunds: 'Refund.createdAt — the date the refund was made' },
    notes: pending.length
      ? ['Pending provider refunds have not returned money to anyone yet and are reported separately from refunds made.']
      : [],
  });
};

export const buildSettlement = async (ctx) => {
  const { scope, period } = ctx;
  const payments = await prisma.payment.findMany({
    where: {
      ...viaOrderScopeWhere(scope),
      branchId: orderScopeWhere(scope).branchId,
      channel: 'GATEWAY',
      createdAt: { gte: period.startUtc, lt: period.endUtc },
    },
    select: {
      id: true,
      branchId: true,
      createdAt: true,
      amount: true,
      method: true,
      providerRef: true,
      order: { select: { invoiceNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const names = storeNameMap(scope);
  // A gateway payment with no provider reference cannot be matched against a
  // settlement file at all. That is the exception worth listing: it is not a
  // mismatch, it is a payment nobody can prove arrived.
  const rows = payments.map((p) => ({
    paymentId: p.id,
    invoiceNumber: p.order?.invoiceNumber ?? null,
    storeName: names.get(p.branchId)?.name ?? p.branchId,
    createdAt: p.createdAt.toISOString(),
    amount: money(paiseOf(p.amount)),
    method: p.method,
    providerRef: p.providerRef ?? null,
    matched: Boolean(p.providerRef),
    exception: p.providerRef
      ? null
      : 'No provider charge id recorded, so this cannot be reconciled against a settlement file.',
  }));
  const unmatched = rows.filter((r) => !r.matched);
  return envelope({
    key: 'settlement',
    label: 'Settlement reconciliation',
    period,
    scope,
    columns: [
      col('invoiceNumber', 'Bill', 'text'),
      col('storeName', 'Store', 'text'),
      col('createdAt', 'Received', 'datetime'),
      col('amount', 'Amount', 'money'),
      col('method', 'Method', 'text'),
      col('providerRef', 'Provider charge id', 'text'),
      col('exception', 'Exception', 'text'),
    ],
    rows,
    totals: {
      gatewayCollected: money(rows.reduce((a, r) => a + r.amount.paise, 0)),
      payments: rows.length,
      unreconcilable: unmatched.length,
      // A money object, not a bare paise integer: a totals row reading
      // "Unreconcilable paise: 98700" is read as rupees by everyone who sees it.
      unreconcilableValue: money(unmatched.reduce((a, r) => a + r.amount.paise, 0)),
    },
    basis: { collections: 'Payment.createdAt — the date the money was received' },
    caveats: [
      'This compares what the POS recorded against the provider references it holds. A provider settlement file has not been imported, so bank credit dates and provider fees are not part of this report.',
    ],
  });
};

export const buildLocationComparison = async (ctx) => {
  const { scope, period, settings, now } = ctx;
  const m = await readMoney({ scope, period });
  const previous = period.comparison
    ? await readMoney({
        scope,
        period,
        window: { startUtc: period.comparison.startUtc, endUtc: period.comparison.endUtc },
      })
    : null;
  const coverage = await coverageForStores({ scope, period, money: m, settings, now });
  const names = storeNameMap(scope);
  const rows = scope.storeIds.map((id) => {
    const t = m.perStore.get(id);
    const p = previous?.perStore.get(id);
    const s = names.get(id);
    return {
      storeId: id,
      storeName: s?.name ?? id,
      storeCode: s?.code ?? null,
      city: s?.city ?? null,
      regionName: s?.regionName ?? null,
      brands: (s?.brands ?? []).map((b) => b.name),
      netSales: money(t?.netSalesPaise ?? 0),
      finalizedOrders: t?.finalizedOrders ?? 0,
      averageOrderValue:
        t?.finalizedOrders > 0 ? money(aovPaise(t.netSalesPaise, t.finalizedOrders)) : null,
      collected: money(t?.collectedPaise ?? 0),
      dues: money(t?.duesPaise ?? 0),
      refunds: money(t?.refundsPaise ?? 0),
      discountRatePercent: t ? ratio(t.discountsPaise, t.grossItemsPaise) : null,
      voidedOrders: t?.voidedOrders ?? 0,
      openOrders: t?.openOrders ?? 0,
      // Each store's own numerator over its own denominator. The company row is
      // computed the same way from company totals, never from these.
      collectedVsSalesPercent: t ? ratio(t.collectedPaise, t.invoicedPaise) : null,
      changePercent: p ? deltaOf(t?.netSalesPaise ?? 0, p.netSalesPaise)?.changePercent ?? null : null,
      sharePercent: ratio(t?.netSalesPaise ?? 0, m.total.netSalesPaise),
      coverage: coverage.stores[id],
    };
  });
  rows.sort((a, b) => b.netSales.paise - a.netSales.paise);
  rows.forEach((r, i) => {
    r.rank = r.netSales.paise > 0 ? i + 1 : null;
  });
  return envelope({
    key: 'locationComparison',
    label: 'Location comparison',
    period,
    scope,
    columns: [
      col('rank', '#', 'integer'),
      col('storeName', 'Store', 'text'),
      col('netSales', 'Net sales', 'money'),
      col('sharePercent', 'Share', 'percent'),
      col('changePercent', 'Change', 'percent'),
      col('finalizedOrders', 'Bills', 'integer'),
      col('averageOrderValue', 'Average bill', 'money'),
      col('collected', 'Collected', 'money'),
      col('dues', 'Dues', 'money'),
      col('discountRatePercent', 'Discount rate', 'percent'),
      col('coverage', 'Data', 'coverage'),
    ],
    rows,
    totals: publicTotals(m.total),
    comparison: await withComparison({ scope, period, current: m }),
    coverage,
    basis: m.basis,
    notes: [
      'The company row is recomputed from company totals. Averaging the stores’ percentages would give the mean of the averages, which is a different number.',
    ],
  });
};

export const buildProductMix = async (ctx) => {
  const { scope, period, query = {} } = ctx;
  const orders = await prisma.order.findMany({
    where: {
      ...orderScopeWhere(scope),
      status: { in: SALES_STATUSES },
      billedAt: { gte: period.startUtc, lt: period.endUtc },
    },
    select: { id: true, branchId: true },
  });
  if (!orders.length) {
    return envelope({
      key: 'productMix',
      label: 'Product and menu mix',
      period,
      scope,
      columns: PRODUCT_MIX_COLUMNS,
      rows: [],
      totals: { netSales: money(0), qty: 0, lines: 0, products: 0 },
      basis: { sales: 'Order.billedAt — the date the invoice was raised' },
    });
  }
  const orderIds = orders.map((o) => o.id);
  const items = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIds }, status: 'ACTIVE' },
    select: {
      id: true,
      productId: true,
      variantId: true,
      name: true,
      qty: true,
      lineSubtotal: true,
      lineDiscount: true,
      discountShare: true,
      lineTax: true,
      lineTotal: true,
      product: { select: { id: true, name: true, categoryId: true, category: { select: { name: true } } } },
      variant: { select: { id: true, name: true } },
    },
  });

  const groupBy = ['product', 'variant', 'category'].includes(query.groupBy) ? query.groupBy : 'product';
  const keyOf = (i) =>
    groupBy === 'category'
      ? (i.product?.categoryId ?? 'uncategorised')
      : groupBy === 'variant'
        ? `${i.productId}|${i.variantId ?? ''}`
        : i.productId;
  const labelOf = (i) =>
    groupBy === 'category'
      ? (i.product?.category?.name ?? 'Uncategorised')
      : groupBy === 'variant'
        ? `${i.product?.name ?? i.name}${i.variant ? ` — ${i.variant.name}` : ''}`
        : (i.product?.name ?? i.name);

  const agg = new Map();
  for (const i of items) {
    const k = keyOf(i);
    let r = agg.get(k);
    if (!r) {
      r = {
        key: k,
        name: labelOf(i),
        productId: groupBy === 'category' ? null : i.productId,
        variantId: groupBy === 'variant' ? (i.variantId ?? null) : null,
        categoryName: i.product?.category?.name ?? null,
        qty: 0,
        lines: 0,
        grossPaise: 0,
        discountPaise: 0,
        taxPaise: 0,
        netPaise: 0,
      };
      agg.set(k, r);
    }
    const sub = paiseOf(i.lineSubtotal);
    const itemDisc = paiseOf(i.lineDiscount);
    const share = paiseOf(i.discountShare);
    r.qty += i.qty;
    r.lines += 1;
    r.grossPaise += sub + itemDisc;
    r.discountPaise += itemDisc + share;
    r.taxPaise += paiseOf(i.lineTax);
    r.netPaise += paiseOf(i.lineTotal);
  }

  // Modifiers are their own question: "how many extra shots did we sell" is not
  // answerable from the drink they were attached to, because the line's unit
  // price already absorbed them.
  const modifiers = await prisma.orderItemModifier.groupBy({
    by: ['optionId', 'groupName', 'name'],
    where: { orderItemId: { in: items.map((i) => i.id) } },
    _count: { _all: true },
    _sum: { price: true },
  });

  const totalNet = [...agg.values()].reduce((a, r) => a + r.netPaise, 0);
  const rows = [...agg.values()]
    .sort((a, b) => b.netPaise - a.netPaise)
    .map((r, idx) => ({
      rank: idx + 1,
      key: r.key,
      productId: r.productId,
      variantId: r.variantId,
      name: r.name,
      categoryName: r.categoryName,
      qty: r.qty,
      lines: r.lines,
      gross: money(r.grossPaise),
      discounts: money(r.discountPaise),
      tax: money(r.taxPaise),
      netSales: money(r.netPaise),
      sharePercent: ratio(r.netPaise, totalNet),
      averagePrice: r.qty > 0 ? money(Math.round(r.netPaise / r.qty)) : null,
    }));

  return envelope({
    key: 'productMix',
    label:
      groupBy === 'category'
        ? 'Menu mix by category'
        : groupBy === 'variant'
          ? 'Menu mix by variant'
          : 'Product and menu mix',
    period,
    scope,
    columns: PRODUCT_MIX_COLUMNS,
    rows,
    totals: {
      netSales: money(totalNet),
      qty: rows.reduce((a, r) => a + r.qty, 0),
      lines: rows.reduce((a, r) => a + r.lines, 0),
      products: rows.length,
    },
    basis: { sales: 'Order.billedAt — the date the invoice was raised' },
    meta: {
      groupBy,
      modifiers: modifiers
        .map((m) => ({
          optionId: m.optionId,
          groupName: m.groupName,
          name: m.name,
          count: m._count._all,
          revenue: money(paiseOf(m._sum.price ?? 0) * 1),
        }))
        .sort((a, b) => b.count - a.count),
      modifierNote:
        'Modifier revenue is already included in the line totals above; it is listed separately for volume, not added to them.',
    },
  });
};

const PRODUCT_MIX_COLUMNS = [
  col('rank', '#', 'integer'),
  col('name', 'Item', 'text'),
  col('categoryName', 'Category', 'text'),
  col('qty', 'Quantity', 'integer'),
  col('gross', 'Gross', 'money'),
  col('discounts', 'Discounts', 'money'),
  col('netSales', 'Net sales', 'money'),
  col('sharePercent', 'Share', 'percent'),
  col('averagePrice', 'Average price', 'money'),
];

export const buildCash = async (ctx) => {
  const { scope, period, settings } = ctx;
  // DayClose stores a business date string, so the window is expressed in the
  // company's own business dates rather than instants. That is also what makes a
  // 23:40 closing land on the day the staff were working.
  const closes = await prisma.dayClose.findMany({
    where: {
      companyId: scope.companyId,
      branchId: { in: scope.storeIds.length ? scope.storeIds : ['__none__'] },
      businessDate: { gte: period.from, lte: period.to },
    },
    select: {
      id: true,
      branchId: true,
      businessDate: true,
      openingFloatPaise: true,
      countedCashPaise: true,
      expectedCashPaise: true,
      cashSalesPaise: true,
      cashRefundsPaise: true,
      cardSalesPaise: true,
      upiSalesPaise: true,
      otherSalesPaise: true,
      gatewaySalesPaise: true,
      variancePaise: true,
      ordersBilled: true,
      note: true,
      closedAt: true,
      closedBy: { select: { id: true, fullName: true } },
      correctedBy: { select: { id: true } },
    },
    orderBy: [{ businessDate: 'desc' }, { branchId: 'asc' }],
  });
  const names = storeNameMap(scope);
  // A corrected closing is history, not the current figure. The chain is kept so
  // "what did they say before they re-counted" stays answerable, but the report
  // shows what stands now.
  const rows = closes
    .filter((c) => !c.correctedBy)
    .map((c) => ({
      dayCloseId: c.id,
      storeId: c.branchId,
      storeName: names.get(c.branchId)?.name ?? c.branchId,
      businessDate: c.businessDate,
      openingFloat: money(c.openingFloatPaise),
      cashSales: money(c.cashSalesPaise),
      cashRefunds: money(c.cashRefundsPaise),
      expectedCash: money(c.expectedCashPaise),
      countedCash: money(c.countedCashPaise),
      variance: money(c.variancePaise),
      varianceDirection: c.variancePaise === 0 ? 'EXACT' : c.variancePaise > 0 ? 'OVER' : 'SHORT',
      nonCash: money(c.cardSalesPaise + c.upiSalesPaise + c.otherSalesPaise + c.gatewaySalesPaise),
      ordersBilled: c.ordersBilled,
      note: c.note ?? null,
      closedBy: c.closedBy?.fullName ?? null,
      closedAt: c.closedAt.toISOString(),
    }));

  // An unclosed day is the finding. A drawer that was never counted has no
  // variance, which is not the same as a variance of zero. Today is excluded:
  // a day still being traded is not yet late.
  const closedKeys = new Set(rows.map((r) => `${r.storeId}|${r.businessDate}`));
  const expectedDays = [];
  for (const date of businessDatesIn(period)) {
    if (date >= period.today) continue;
    for (const id of scope.storeIds) {
      if (!closedKeys.has(`${id}|${date}`)) {
        expectedDays.push({ storeId: id, storeName: names.get(id)?.name ?? id, businessDate: date });
      }
    }
  }

  const sum = (k) => rows.reduce((a, r) => a + r[k].paise, 0);
  return envelope({
    key: 'cash',
    label: 'Cash, shift and day-close differences',
    period,
    scope,
    columns: [
      col('businessDate', 'Business day', 'date'),
      col('storeName', 'Store', 'text'),
      col('openingFloat', 'Opening float', 'money'),
      col('cashSales', 'Cash sales', 'money'),
      col('cashRefunds', 'Cash refunds', 'money'),
      col('expectedCash', 'Expected', 'money'),
      col('countedCash', 'Counted', 'money'),
      col('variance', 'Difference', 'money'),
      col('varianceDirection', 'Direction', 'text'),
      col('closedBy', 'Closed by', 'text'),
      col('note', 'Explanation', 'text'),
    ],
    rows,
    totals: {
      expectedCash: money(sum('expectedCash')),
      countedCash: money(sum('countedCash')),
      variance: money(sum('variance')),
      over: money(rows.filter((r) => r.variance.paise > 0).reduce((a, r) => a + r.variance.paise, 0)),
      short: money(rows.filter((r) => r.variance.paise < 0).reduce((a, r) => a + r.variance.paise, 0)),
      closings: rows.length,
      withDifference: rows.filter((r) => r.variance.paise !== 0).length,
      unclosedDays: expectedDays.length,
    },
    basis: {
      cash: `DayClose.businessDate — the trading day in ${settings.timezone}, not a UTC day`,
    },
    meta: { unclosedDays: expectedDays },
    notes: expectedDays.length
      ? [`${expectedDays.length} store-days in this period have no day close, so they have no counted cash and no difference.`]
      : [],
  });
};

// ---------------------------------------------------------------------------
// Consumption — the one report whose inputs may not exist in this build
// ---------------------------------------------------------------------------

export const buildConsumption = async (ctx) => {
  const { scope, period, capability } = ctx;
  // The maths is proven independently (see reportingConsumption.test.js). What
  // this build cannot do is supply recipes and stock movements, so rather than
  // producing a zero-variance table it says which inputs are absent.
  const missing = [];
  if (!prisma?.recipe) missing.push('recipes');
  if (!prisma?.stockMovement) missing.push('stock movements');
  if (!prisma?.stockCount) missing.push('physical stock counts');

  const soldColumns = [
    col('name', 'Item', 'text'),
    col('qty', 'Sold', 'integer'),
    col('expected', 'Expected usage', 'qty'),
    col('physical', 'Physical depletion', 'qty'),
    col('wastage', 'Recorded wastage', 'qty'),
    col('unexplained', 'Unexplained', 'qty'),
  ];

  const mix = await buildProductMix({ ...ctx, query: { groupBy: 'product' } });
  return envelope({
    key: 'consumption',
    label: 'Ingredient consumption and variance',
    period,
    scope,
    columns: soldColumns,
    rows: [],
    totals: null,
    coverage: {
      ingredients: 0,
      physicallyCounted: 0,
      notCounted: 0,
      costed: 0,
      notCosted: 0,
      countPeriod: null,
      note: `Ingredient consumption needs ${missing.join(', ')}, which are not part of this deployment. Menu quantities sold are shown below because they are measured; expected ingredient usage, physical depletion and unexplained variance are not computed rather than shown as zero.`,
    },
    basis: {
      sales: 'Order.billedAt — the date the invoice was raised',
      consumption: 'Not available: no stock movement or recipe data in this deployment',
    },
    caveats: [
      'A zero variance would claim the shelves agree with the recipes. Nothing here has been counted, so no variance is reported at all.',
    ],
    meta: {
      state: capability?.state ?? 'UNAVAILABLE',
      missingInputs: missing,
      // (1) of the five figures is measurable today, so it is the one that ships.
      soldQuantities: mix.rows.map((r) => ({ name: r.name, qty: r.qty, netSales: r.netSales })),
      figures: [
        { key: 'sold', label: 'Menu quantities sold', measured: true },
        { key: 'expected', label: 'Expected ingredient usage from recipes', measured: false },
        { key: 'physical', label: 'Physical depletion between counts', measured: false },
        { key: 'wastage', label: 'Recorded wastage and other usage', measured: false },
        { key: 'unexplained', label: 'Unexplained variance', measured: false },
      ],
    },
  });
};

export const BUILDERS = Object.freeze({
  sales: buildSales,
  salesByPeriod: buildSalesByPeriod,
  tax: buildTax,
  discounts: buildDiscounts,
  collections: buildCollections,
  dues: buildDues,
  refunds: buildRefunds,
  settlement: buildSettlement,
  locationComparison: buildLocationComparison,
  productMix: buildProductMix,
  cash: buildCash,
  consumption: buildConsumption,
});

export const buildableReports = () => Object.keys(BUILDERS);
