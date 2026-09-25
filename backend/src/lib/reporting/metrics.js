// LANE reporting — the money figures, in integer paise, per store and per bucket.
//
// Each block declares WHICH date drives it, because an owner asking "why is
// collected below sales" is asking a question about dates: sales are billedAt,
// money in is Payment.createdAt, money back is Refund.createdAt. A bill issued
// on the 23rd and settled on the 24th belongs to both days, in different
// reports, and no single number can say that.
//
// Two definitions here differ from /api/reports/sales on purpose, and the gap is
// the point of this lane rather than an oversight: BILLED counts as a sale (see
// SALES_STATUSES), and netSales excludes tax (see the invoiced/net split in
// accumulate). The legacy router keeps its own inline definitions and its own
// tests. It is the contract §10 report the POS calls and it is not touched.
//
// Every ratio is recomputed from its own numerator and denominator. Averaging six
// stores' average order values gives the mean of the averages, which is not the
// company's average order value unless all six sold the same number of orders —
// and they never do.

import { prisma } from '../prisma.js';
import { toRupees } from '../money.js';
import { paiseOf, refundLeavesDrawer } from '../orders.js';
import { orderScopeWhere, viaOrderScopeWhere } from './scope.js';
import { bucketOf } from './period.js';

// Orders that represent a completed sale. A VOID never sold anything and an OPEN
// order is a table still eating, so neither is revenue. REFUNDED stays in: the
// sale happened and the refund is reported separately, which is what keeps
// "sales" and "money returned" independently explainable.
//
// BILLED is in, and the legacy /api/reports/sales list is deliberately NOT
// changed to match. An invoice that has been issued is a sale whether or not the
// money arrived — it carries a GST liability from the moment it is printed, and
// the dues report already reads exactly these rows. With BILLED excluded the two
// contradicted each other: a part-paid invoice was revenue the dues report
// claimed was owed and the sales report said never happened, and because its
// part-payment still counted as money in, a store could report collecting more
// than it sold. Measured on the lane's own fixture: 1,775.00 collected against
// 1,575.00 sold.
export const SALES_STATUSES = Object.freeze(['BILLED', 'PAID', 'REFUNDED']);

export const emptyTotals = () => ({
  grossItemsPaise: 0,
  itemDiscountsPaise: 0,
  orderDiscountsPaise: 0,
  discountsPaise: 0,
  taxPaise: 0,
  netSalesPaise: 0,
  invoicedPaise: 0,
  finalizedOrders: 0,
  collectedPaise: 0,
  refundsPaise: 0,
  refundsFromDrawerPaise: 0,
  refundsPendingPaise: 0,
  duesPaise: 0,
  dueOrders: 0,
  voidedOrders: 0,
  openOrders: 0,
});

const addInto = (target, src) => {
  for (const k of Object.keys(target)) target[k] += src[k] ?? 0;
  return target;
};

/**
 * Average order value, recomputed rather than averaged.
 *
 * Returned as null, not 0, when there were no finalized orders. A zero AOV is a
 * claim that orders averaged nothing; "no orders" has no average at all.
 */
export const aovPaise = (netSalesPaise, finalizedOrders) =>
  finalizedOrders > 0 ? Math.round(netSalesPaise / finalizedOrders) : null;

export const ratio = (numerator, denominator) =>
  denominator > 0 ? Math.round((numerator / denominator) * 10000) / 100 : null;

/**
 * Read one window's money for a set of stores.
 *
 * Returns per-store and per-bucket breakdowns plus the consolidated total. The
 * caller decides which of those to show; all three come from one pass so a store
 * row and the company row can never be computed from different reads.
 */
export const readMoney = async ({ scope, period, window = null }) => {
  const from = window?.startUtc ?? period.startUtc;
  const to = window?.endUtc ?? period.endUtc;
  const orderScope = orderScopeWhere(scope);
  const viaOrder = viaOrderScopeWhere(scope);
  const range = { gte: from, lt: to };

  const [orders, payments, refunds, statusCounts, dueOrders] = await Promise.all([
    prisma.order.findMany({
      where: { ...orderScope, status: { in: SALES_STATUSES }, billedAt: range },
      select: {
        id: true,
        branchId: true,
        billedAt: true,
        total: true,
        taxAmount: true,
        discountAmount: true,
        subtotal: true,
      },
    }),
    prisma.payment.findMany({
      where: { ...viaOrder, branchId: orderScope.branchId, createdAt: range },
      select: { branchId: true, createdAt: true, amount: true, method: true, channel: true },
    }),
    prisma.refund.findMany({
      where: { ...viaOrder, createdAt: range },
      select: {
        createdAt: true,
        amount: true,
        status: true,
        channel: true,
        method: true,
        order: { select: { branchId: true } },
      },
    }),
    prisma.order.groupBy({
      by: ['branchId', 'status'],
      where: { ...orderScope, createdAt: range },
      _count: { _all: true },
    }),
    // Outstanding is a position, not a flow: it is every bill still short of its
    // total as at the end of the window, whenever it was raised. Filtering it to
    // the window would report today's new dues and hide last month's.
    prisma.order.findMany({
      where: { ...orderScope, status: 'BILLED', billedAt: { lt: to } },
      select: {
        branchId: true,
        total: true,
        payments: { select: { amount: true } },
      },
    }),
  ]);

  const itemAgg = orders.length
    ? await prisma.orderItem.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orders.map((o) => o.id) }, status: 'ACTIVE' },
        _sum: { lineDiscount: true, lineSubtotal: true },
      })
    : [];
  const itemsByOrder = new Map(itemAgg.map((r) => [r.orderId, r._sum]));

  const perStore = new Map();
  const perBucket = new Map();
  const storeRow = (branchId) => {
    let r = perStore.get(branchId);
    if (!r) {
      r = emptyTotals();
      r.lastActivityAt = null;
      perStore.set(branchId, r);
    }
    return r;
  };
  const bucketRow = (key) => {
    if (!key) return null;
    let r = perBucket.get(key);
    if (!r) {
      r = emptyTotals();
      perBucket.set(key, r);
    }
    return r;
  };
  const touch = (row, at) => {
    if (row && at && (!row.lastActivityAt || at > row.lastActivityAt)) row.lastActivityAt = at;
  };

  for (const o of orders) {
    const s = storeRow(o.branchId);
    const b = bucketRow(bucketOf(period, o.billedAt));
    // Two different figures, both wanted, and previously conflated. `invoiced`
    // is the face value of the bill — what the customer owes and what a
    // collection is measured against. `netSales` is the taxable value the
    // business actually earned, which is the invoice less the GST it is only
    // holding on the government's behalf. Reporting the tax-inclusive total as
    // "net sales" overstated turnover by the whole tax rate, and at 5% GST an
    // owner comparing it to last year's books would have found no explanation
    // for the gap.
    const invoiced = paiseOf(o.total);
    const tax = paiseOf(o.taxAmount);
    const net = invoiced - tax;
    const orderDisc = paiseOf(o.discountAmount);
    const sums = itemsByOrder.get(o.id) ?? {};
    const itemDisc = sums.lineDiscount ? paiseOf(sums.lineDiscount) : 0;
    const lineSubtotal = sums.lineSubtotal ? paiseOf(sums.lineSubtotal) : paiseOf(o.subtotal);
    // Gross is what the menu asked for before any reduction: the line subtotals
    // plus everything taken off them.
    const gross = lineSubtotal + itemDisc;
    for (const row of [s, b]) {
      if (!row) continue;
      row.netSalesPaise += net;
      row.invoicedPaise += invoiced;
      row.taxPaise += tax;
      row.orderDiscountsPaise += orderDisc;
      row.itemDiscountsPaise += itemDisc;
      row.discountsPaise += orderDisc + itemDisc;
      row.grossItemsPaise += gross;
      row.finalizedOrders += 1;
    }
    touch(s, o.billedAt);
  }

  const byMethod = new Map();
  for (const p of payments) {
    const amount = paiseOf(p.amount);
    const s = storeRow(p.branchId);
    const b = bucketRow(bucketOf(period, p.createdAt));
    s.collectedPaise += amount;
    if (b) b.collectedPaise += amount;
    touch(s, p.createdAt);
    // Method and channel together: the same method arrives both hand-recorded and
    // provider-settled, and collapsing them would label one as the other.
    const key = `${p.method}|${p.channel}`;
    const m = byMethod.get(key) ?? { method: p.method, channel: p.channel, amountPaise: 0, count: 0 };
    m.amountPaise += amount;
    m.count += 1;
    byMethod.set(key, m);
  }

  for (const r of refunds) {
    const branchId = r.order?.branchId;
    if (!branchId) continue;
    const amount = paiseOf(r.amount);
    const s = storeRow(branchId);
    const b = bucketRow(bucketOf(period, r.createdAt));
    // A PENDING gateway refund has returned nothing to anybody yet. It is held
    // separately so it can be chased without being counted as money out.
    if (r.status === 'SUCCEEDED') {
      s.refundsPaise += amount;
      if (b) b.refundsPaise += amount;
      if (refundLeavesDrawer(r)) s.refundsFromDrawerPaise += amount;
    } else if (r.status === 'PENDING') {
      s.refundsPendingPaise += amount;
      if (b) b.refundsPendingPaise += amount;
    }
    touch(s, r.createdAt);
  }

  for (const c of statusCounts) {
    const s = storeRow(c.branchId);
    if (c.status === 'VOID') s.voidedOrders += c._count._all;
    if (c.status === 'OPEN') s.openOrders += c._count._all;
  }

  for (const o of dueOrders) {
    const paid = o.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
    const outstanding = paiseOf(o.total) - paid;
    if (outstanding <= 0) continue;
    const s = storeRow(o.branchId);
    s.duesPaise += outstanding;
    s.dueOrders += 1;
  }

  const total = emptyTotals();
  for (const row of perStore.values()) addInto(total, row);

  return {
    perStore,
    perBucket,
    total,
    byMethod: [...byMethod.values()].sort((a, b) => b.amountPaise - a.amountPaise),
    basis: {
      sales: 'Order.billedAt — the date the invoice was raised',
      collections: 'Payment.createdAt — the date the money was received',
      refunds: 'Refund.createdAt — the date the refund was made',
      dues: 'Outstanding on every unpaid bill as at the end of the period, whenever it was raised',
    },
  };
};

// Money for display. Paise stay in the payload beside the rupee figure so an
// export and a screen can be compared exactly, without re-deriving anything.
export const money = (paise) => ({ paise, amount: toRupees(paise) });

export const publicTotals = (t) => ({
  grossItems: money(t.grossItemsPaise),
  discounts: money(t.discountsPaise),
  itemDiscounts: money(t.itemDiscountsPaise),
  orderDiscounts: money(t.orderDiscountsPaise),
  tax: money(t.taxPaise),
  netSales: money(t.netSalesPaise),
  invoiced: money(t.invoicedPaise),
  collected: money(t.collectedPaise),
  refunds: money(t.refundsPaise),
  refundsFromDrawer: money(t.refundsFromDrawerPaise),
  refundsPending: money(t.refundsPendingPaise),
  dues: money(t.duesPaise),
  dueOrders: t.dueOrders,
  finalizedOrders: t.finalizedOrders,
  voidedOrders: t.voidedOrders,
  openOrders: t.openOrders,
  averageOrderValue: t.finalizedOrders > 0 ? money(aovPaise(t.netSalesPaise, t.finalizedOrders)) : null,
  discountRatePercent: ratio(t.discountsPaise, t.grossItemsPaise),
  // Against the invoiced face value, not against net sales. Money arrives
  // tax-inclusive, so measuring it against a tax-exclusive figure would put a
  // fully settled day above 100% collected and invite somebody to go looking
  // for the overpayment.
  collectedVsSalesPercent: ratio(t.collectedPaise, t.invoicedPaise),
});

export const deltaOf = (current, previous) => {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? { changePaise: 0, changePercent: 0 } : { changePaise: current, changePercent: null };
  return {
    changePaise: current - previous,
    changePercent: Math.round(((current - previous) / previous) * 10000) / 100,
  };
};
