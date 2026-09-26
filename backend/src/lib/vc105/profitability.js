// VC-105 Menu Profitability — calculation engine.
//
// Pure functions over already-loaded rows: no Prisma, no clock, no env. Every
// money value is integer paise, as it is everywhere else in this codebase.
//
// This file does NOT price ingredients. It consumes per-line costs that the
// costing system struck at sale time (SaleConsumption.costPaise) and reports
// them. Re-deriving cost from recipes here would be a second costing
// implementation competing with the inventory lane's, which VC-105 must not
// create. See docs/VC105-API-CONTRACT.md §6.
//
// The definitions of net sales and discount allocation are not new policy:
// they are read out of lib/money.js `computeOrderTotals`, which wrote the
// stored columns this engine reads. See contract §4.

import { distributeProportional } from '../money.js';

// round-half-up(a × n / d) in exact integer arithmetic. BigInt because a
// month of takings times a line's net sales passes 2^53 easily.
export const mulDivRoundHalfUp = (a, n, d) => {
  if (d === 0) return 0;
  const A = BigInt(a);
  const N = BigInt(n);
  const D = BigInt(d);
  return Number((A * N * 2n + D) / (D * 2n));
};

// The engine's single definition of a sold line's net sales: what the customer
// was charged for it, after its own discount and after its share of the
// order-level discount, and BEFORE tax.
//
// `discountShare` is read, never recomputed. It was allocated at bill time by
// distributeProportional and is on the bill the customer holds; re-deriving it
// here could disagree with that by a paisa and would make this report wrong
// rather than the bill.
export const lineNetSales = (item) => item.lineSubtotal - item.discountShare;

// Refunds are order-level in the committed schema: no orderItemId, no
// quantity. So which dish came back is genuinely unknown, and this is a stated
// allocation rather than a discovered fact (contract §5).
//
// Returns paise per line, summing EXACTLY to the order's tax-exclusive refund.
export const allocateOrderRefund = (order) => {
  const lines = order.items;
  const netByLine = lines.map(lineNetSales);
  const netTotal = netByLine.reduce((a, n) => a + n, 0);

  const refundedGross = Math.min(
    order.refunds.reduce((a, r) => a + r.amount, 0),
    order.total,
  );
  if (refundedGross <= 0 || netTotal <= 0) return lines.map(() => 0);

  // Money returned is tax-inclusive; net sales is tax-exclusive. Convert on
  // the order's own ratio rather than a nominal tax rate, because lines in one
  // order can sit at different rates.
  const refundNetTotal = order.total > 0
    ? mulDivRoundHalfUp(refundedGross, order.total - order.taxAmount, order.total)
    : 0;

  // Same largest-remainder helper the bill used, so the shares sum exactly and
  // no paisa is created or destroyed by the allocation.
  return distributeProportional(Math.min(refundNetTotal, netTotal), netByLine);
};

const GROUPERS = {
  item: (order, item) => ({ key: item.productId, label: item.name, productId: item.productId }),
  store: (order) => ({ key: order.branchId, label: order.branchName ?? order.branchId, branchId: order.branchId }),
  channel: (order) => ({ key: order.type, label: order.type, channel: order.type }),
  period: (order) => ({ key: order.businessDate, label: order.businessDate, period: order.businessDate }),
};

const emptyRow = (id) => ({
  ...id,
  qty: 0,
  grossSalesPaise: 0,
  discountPaise: 0,
  netSalesPaise: 0,
  refundNetPaise: 0,
  netSalesAfterRefundPaise: 0,
  cogsPaise: 0,
  costedNetSalesPaise: 0,
  costedQty: 0,
  lines: 0,
  linesCosted: 0,
  costStatuses: new Set(),
  costReasons: new Set(),
  recipeVersions: new Set(),
  // Keyed by recipe version: if a recipe changed mid-period the drilldown has
  // to show both, not silently pick one.
  breakdowns: new Map(),
});

// Worst-of, so a group holding one uncosted line cannot report ACTUAL.
const RANK = { ACTUAL: 0, ESTIMATED: 1, STALE: 2, MISSING: 3 };
const worstStatus = (statuses) => {
  let worst = null;
  for (const s of statuses) if (worst === null || RANK[s] > RANK[worst]) worst = s;
  return worst;
};

// A cost is stale when it was struck longer ago than the inventory settings
// allow. The threshold is not invented here: InventorySettings.staleCostDays
// already defaults to 90 in the inventory lane's schema, and the caller passes
// it through so the UI never hardcodes a number either.
export const costStatusOf = (cost, { asOf, staleCostDays }) => {
  if (!cost || cost.costPaise === null || cost.costPaise === undefined) return 'MISSING';
  if (cost.costStatus === 'MISSING') return 'MISSING';
  if (cost.costBasisAt && staleCostDays > 0) {
    const ageDays = (asOf.getTime() - new Date(cost.costBasisAt).getTime()) / 86400e3;
    if (ageDays > staleCostDays) return 'STALE';
  }
  return cost.costStatus === 'ESTIMATED' ? 'ESTIMATED' : 'ACTUAL';
};

// A STALE cost is still a real number that was really struck, so it counts
// toward coverage and margin — flagged, not discarded. A MISSING one does not
// exist and must never be read as zero.
const isCosted = (status) => status !== 'MISSING';

/**
 * @param orders  rows shaped by the route: paise integers, ACTIVE items only,
 *                SUCCEEDED refunds only, `businessDate` as an IST YYYY-MM-DD.
 * @param costs   Map orderItemId -> { costPaise, costStatus, costBasisAt,
 *                recipeVersionId, uncostedReason } — the SaleConsumption shape.
 */
export const buildProfitability = (orders, costs, { groupBy = 'item', asOf, staleCostDays = 90 } = {}) => {
  const grouper = GROUPERS[groupBy];
  if (!grouper) throw new Error(`unknown groupBy: ${groupBy}`);

  const groups = new Map();
  const totals = {
    qty: 0,
    grossSalesPaise: 0,
    discountPaise: 0,
    netSalesPaise: 0,
    refundNetPaise: 0,
    netSalesAfterRefundPaise: 0,
    cogsPaise: 0,
    costedNetSalesPaise: 0,
    costedQty: 0,
  };
  const coverage = { lines: 0, linesCosted: 0, linesMissing: 0, byStatus: { ACTUAL: 0, ESTIMATED: 0, STALE: 0, MISSING: 0 } };

  for (const order of orders) {
    const refundShares = allocateOrderRefund(order);

    order.items.forEach((item, i) => {
      const id = grouper(order, item);
      let row = groups.get(id.key);
      if (!row) {
        row = emptyRow(id);
        groups.set(id.key, row);
      }

      const net = lineNetSales(item);
      const refundNet = refundShares[i];
      const cost = costs.get(item.id);
      const status = costStatusOf(cost, { asOf, staleCostDays });

      row.qty += item.qty;
      row.grossSalesPaise += item.unitPrice * item.qty;
      row.discountPaise += item.lineDiscount + item.discountShare;
      row.netSalesPaise += net;
      row.refundNetPaise += refundNet;
      row.netSalesAfterRefundPaise += net - refundNet;
      row.lines += 1;
      row.costStatuses.add(status);

      if (isCosted(status)) {
        row.cogsPaise += cost.costPaise;
        row.costedNetSalesPaise += net - refundNet;
        row.costedQty += item.qty;
        row.linesCosted += 1;
        if (cost.recipeVersionId) row.recipeVersions.add(cost.recipeVersionId);
        if (cost.breakdown) row.breakdowns.set(String(cost.breakdown.recipeVersion), cost.breakdown);
      } else if (cost?.uncostedReason) {
        row.costReasons.add(cost.uncostedReason);
      } else {
        row.costReasons.add('NO_COST_SOURCE');
      }

      totals.qty += item.qty;
      totals.grossSalesPaise += item.unitPrice * item.qty;
      totals.discountPaise += item.lineDiscount + item.discountShare;
      totals.netSalesPaise += net;
      totals.refundNetPaise += refundNet;
      totals.netSalesAfterRefundPaise += net - refundNet;
      coverage.lines += 1;
      coverage.byStatus[status] += 1;
      if (isCosted(status)) {
        totals.cogsPaise += cost.costPaise;
        totals.costedNetSalesPaise += net - refundNet;
        totals.costedQty += item.qty;
        coverage.linesCosted += 1;
      } else {
        coverage.linesMissing += 1;
      }
    });
  }

  const rows = [...groups.values()].map((row) => {
    const costed = row.linesCosted > 0;
    // An uncosted group has NO margin — not a zero one. Zero would read as
    // "this dish breaks even", which is a fabricated conclusion.
    const contributionMarginPaise = costed ? row.costedNetSalesPaise - row.cogsPaise : null;
    const marginPercent = costed && row.costedNetSalesPaise > 0
      ? Math.round((contributionMarginPaise / row.costedNetSalesPaise) * 10000) / 100
      : null;
    const marginPerUnitPaise = costed && row.costedQty > 0
      ? Math.round(contributionMarginPaise / row.costedQty)
      : null;

    return {
      key: row.key,
      label: row.label,
      productId: row.productId ?? null,
      branchId: row.branchId ?? null,
      channel: row.channel ?? null,
      period: row.period ?? null,
      qty: row.qty,
      costedQty: row.costedQty,
      grossSalesPaise: row.grossSalesPaise,
      discountPaise: row.discountPaise,
      netSalesPaise: row.netSalesPaise,
      refundNetPaise: row.refundNetPaise,
      netSalesAfterRefundPaise: row.netSalesAfterRefundPaise,
      cogsPaise: costed ? row.cogsPaise : null,
      costStatus: worstStatus(row.costStatuses) ?? 'MISSING',
      costStatusReason: costed ? null : ([...row.costReasons][0] ?? 'NO_COST_SOURCE'),
      contributionMarginPaise,
      marginPercent,
      marginPerUnitPaise,
      recipeVersionIds: [...row.recipeVersions],
      // Only an item row has one recipe to explain; a store/channel/period row
      // spans many products, so a single breakdown there would be a fiction.
      costBreakdowns: groupBy === 'item' ? [...row.breakdowns.values()] : null,
      popularityShare: null,
      segment: null,
      coverage: {
        lines: row.lines,
        linesCosted: row.linesCosted,
        partial: row.linesCosted > 0 && row.linesCosted < row.lines,
        costedNetSalesPaise: row.costedNetSalesPaise,
      },
    };
  });

  const segments = classify(rows, totals);

  return {
    rows: rows.sort((a, b) => b.netSalesAfterRefundPaise - a.netSalesAfterRefundPaise || String(a.key).localeCompare(String(b.key))),
    totals: {
      ...totals,
      cogsPaise: coverage.linesCosted > 0 ? totals.cogsPaise : null,
      contributionMarginPaise: coverage.linesCosted > 0 ? totals.costedNetSalesPaise - totals.cogsPaise : null,
      marginPercent:
        coverage.linesCosted > 0 && totals.costedNetSalesPaise > 0
          ? Math.round(((totals.costedNetSalesPaise - totals.cogsPaise) / totals.costedNetSalesPaise) * 10000) / 100
          : null,
      basis: 'COSTED_LINES_ONLY',
      excludedLines: coverage.linesMissing,
    },
    coverage: {
      ...coverage,
      netSalesPaise: totals.netSalesAfterRefundPaise,
      costedNetSalesPaise: totals.costedNetSalesPaise,
      coveragePercent: coverage.lines > 0 ? Math.round((coverage.linesCosted / coverage.lines) * 10000) / 100 : 0,
    },
    segments,
  };
};

// Menu-engineering quadrants. Both thresholds are returned, not just the
// verdict, so the UI can show the line it drew rather than restate the rule.
export const classify = (rows, totals) => {
  const counted = rows.filter((r) => r.qty > 0);
  const n = counted.length;
  // The "70 % rule": an item carries its weight if it takes at least 70 % of
  // an even share of the volume.
  const popularityShare = n > 0 ? 0.7 * (1 / n) : null;

  // Quantity-weighted, so one costed line of a rare dish cannot move the line
  // that a high-volume dish is judged against.
  const costedRows = rows.filter((r) => r.contributionMarginPaise !== null && r.costedQty > 0);
  const cmSum = costedRows.reduce((a, r) => a + r.contributionMarginPaise, 0);
  const qtySum = costedRows.reduce((a, r) => a + r.costedQty, 0);
  const marginPerUnitPaise = costedRows.length > 0 && qtySum > 0 ? Math.round(cmSum / qtySum) : null;

  const counts = { STAR: 0, PLOUGHHORSE: 0, PUZZLE: 0, DOG: 0, UNCLASSIFIED: 0 };

  for (const row of rows) {
    row.popularityShare = totals.qty > 0 ? Math.round((row.qty / totals.qty) * 1e6) / 1e6 : 0;

    // No cost means no verdict. Calling an uncosted dish a DOG invents the
    // very conclusion the operator is asking this report to establish.
    if (row.marginPerUnitPaise === null || marginPerUnitPaise === null) {
      row.segment = 'UNCLASSIFIED';
      counts.UNCLASSIFIED += 1;
      continue;
    }
    const popular = popularityShare !== null && row.popularityShare >= popularityShare;
    const profitable = row.marginPerUnitPaise >= marginPerUnitPaise;
    row.segment = popular ? (profitable ? 'STAR' : 'PLOUGHHORSE') : (profitable ? 'PUZZLE' : 'DOG');
    counts[row.segment] += 1;
  }

  return {
    thresholds: {
      popularityShare: popularityShare === null ? null : Math.round(popularityShare * 1e6) / 1e6,
      marginPerUnitPaise,
      rule: 'popularity: share >= 0.70 x (1/N); margin: contribution margin per unit >= quantity-weighted mean of costed rows',
    },
    counts,
  };
};

// The report carries the proof that its own net sales tie back to the stored
// order totals. Returned on every call, not just in tests: if this ever says
// false, the bug is in this report and the UI should treat it as an error.
export const reconcile = (orders, totals) => {
  let orderTotalPaise = 0;
  let orderTaxPaise = 0;
  let lineNetSalesPaise = 0;
  for (const o of orders) {
    orderTotalPaise += o.total;
    orderTaxPaise += o.taxAmount;
    for (const i of o.items) lineNetSalesPaise += lineNetSales(i);
  }
  const derivedNetSalesPaise = orderTotalPaise - orderTaxPaise;
  return {
    orderCount: orders.length,
    orderTotalPaise,
    orderTaxPaise,
    derivedNetSalesPaise,
    lineNetSalesPaise,
    reportNetSalesPaise: totals.netSalesPaise,
    agrees: derivedNetSalesPaise === lineNetSalesPaise && lineNetSalesPaise === totals.netSalesPaise,
  };
};
