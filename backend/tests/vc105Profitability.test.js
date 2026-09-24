// VC-105 Menu Profitability — engine and endpoint.
//
// Every money assertion below is hand-calculated in the comment above it, in
// paise, from the same arithmetic docs/VC105-API-CONTRACT.md publishes. A test
// that only re-runs the implementation proves nothing about whether the
// implementation is right; these state the expected number independently.
//
// Runs ONLY against a database whose name ends in _test — it truncates.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('vc105Profitability.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const {
  buildProfitability, reconcile, lineNetSales, allocateOrderRefund, mulDivRoundHalfUp,
} = await import('../src/lib/vc105/profitability.js');
const { costFromRecipe, resolveCostProvider } = await import('../src/lib/vc105/costProvider.js');

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/vc105-synthetic-costs.json');
const app = createApp();

// Consolidation note (merge/a406-consolidate): this lane branched before the
// phone-order, promotion, print and modifier tables existed. Their rows point
// at Order / OrderItem / Kot / Branch, so a wipe that skips them fails on the
// FK, not on anything this suite did. Delete children first, in FK order.
const wipe = async () => {
  await prisma.phoneOrderEvent.deleteMany();
  await prisma.phoneOrder.deleteMany();
  await prisma.customerAddress.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.branchServiceArea.deleteMany();
  await prisma.branchHours.deleteMany();
  await prisma.branchPrepCapacity.deleteMany();

  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.printJob.deleteMany();
  await prisma.printTarget.deleteMany();
  await prisma.printAgent.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.modifierOption.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

// ---------------------------------------------------------------------------
// Engine: pure arithmetic, no database.
// ---------------------------------------------------------------------------

const line = (over = {}) => ({
  id: 'li1', productId: 'p1', sku: 'SKU-COFFEE', name: 'Filter Coffee',
  qty: 2, unitPrice: 5000, lineDiscount: 0, lineSubtotal: 10000, discountShare: 0,
  modifierIds: [], ...over,
});

const order = (over = {}) => ({
  id: 'o1', branchId: 'b1', branchName: 'One', type: 'DINE_IN', businessDate: '2026-09-10',
  subtotal: 10000, discountAmount: 0, taxAmount: 500, total: 10500,
  refunds: [], items: [line()], ...over,
});

const ASOF = new Date('2026-09-24T00:00:00.000Z');
const run = (orders, costs = new Map(), opts = {}) =>
  buildProfitability(orders, costs, { asOf: ASOF, staleCostDays: 90, ...opts });

describe('VC-105 engine: net sales', () => {
  it('net sales is tax-exclusive and after both discounts', () => {
    // unitPrice 5000 x qty 2 = 10000 gross; no line discount; no order
    // discount. Net sales = 10000. The 500 paise of tax is NOT in it.
    const r = run([order()]);
    expect(r.totals.netSalesPaise).toBe(10000);
    expect(r.totals.grossSalesPaise).toBe(10000);
    expect(r.rows[0].netSalesPaise).toBe(10000);
  });

  it('reads the order discount already allocated to the line, and reconciles', () => {
    // Two lines, subtotal 13000, order FLAT discount 1000.
    // distributeProportional(1000, [10000, 3000]):
    //   L1 floor(10,000,000/13000) = 769 rem 3,000
    //   L2 floor( 3,000,000/13000) = 230 rem 10,000
    //   assigned 999, leftover 1 -> largest remainder is L2 -> 231
    // shares [769, 231] sum exactly 1000.
    // net: L1 10000-769 = 9231, L2 3000-231 = 2769, total 12000 = 13000-1000.
    const o = order({
      subtotal: 13000, discountAmount: 1000, taxAmount: 0, total: 12000,
      items: [
        line({ id: 'la', discountShare: 769 }),
        line({ id: 'lb', productId: 'p2', sku: 'SKU-LATTE', name: 'Latte', qty: 1, unitPrice: 3000, lineSubtotal: 3000, discountShare: 231 }),
      ],
    });
    const r = run([o]);
    expect(lineNetSales(o.items[0])).toBe(9231);
    expect(lineNetSales(o.items[1])).toBe(2769);
    expect(r.totals.netSalesPaise).toBe(12000);

    const rec = reconcile([o], r.totals);
    expect(rec.derivedNetSalesPaise).toBe(12000); // total 12000 - tax 0
    expect(rec.agrees).toBe(true);
  });
});

describe('VC-105 engine: refunds', () => {
  it('a partial refund is allocated across lines and sums exactly', () => {
    // Order net 12000 (no tax), refund 3000.
    // refundNetTotal = 3000 x (12000-0)/12000 = 3000.
    // distributeProportional(3000, [9231, 2769]):
    //   L1 floor(27,693,000/12000) = 2307 rem 9,000
    //   L2 floor( 8,307,000/12000) =  692 rem 3,000
    //   assigned 2999, leftover 1 -> L1 -> 2308
    // net after refund: L1 9231-2308 = 6923, L2 2769-692 = 2077, sum 9000.
    const o = order({
      subtotal: 13000, discountAmount: 1000, taxAmount: 0, total: 12000,
      refunds: [{ amount: 3000 }],
      items: [
        line({ id: 'la', discountShare: 769 }),
        line({ id: 'lb', productId: 'p2', name: 'Latte', qty: 1, unitPrice: 3000, lineSubtotal: 3000, discountShare: 231 }),
      ],
    });
    expect(allocateOrderRefund(o)).toEqual([2308, 692]);
    const r = run([o]);
    expect(r.totals.refundNetPaise).toBe(3000);
    expect(r.totals.netSalesAfterRefundPaise).toBe(9000);
  });

  it('a refund is converted off the tax-inclusive total before it is allocated', () => {
    // Order: net 10000, tax 500, total 10500. Full refund of 10500.
    // refundNetTotal = 10500 x (10500-500)/10500 = 10000 — the tax comes out,
    // so a full refund zeroes net sales exactly rather than overshooting by
    // the tax and driving net sales negative.
    const o = order({ refunds: [{ amount: 10500 }] });
    expect(allocateOrderRefund(o)).toEqual([10000]);
    const r = run([o]);
    expect(r.totals.netSalesAfterRefundPaise).toBe(0);
    // Margin percent on zero net sales is undefined, not 0 and not Infinity.
    expect(r.totals.marginPercent).toBeNull();
  });

  it('a refund larger than the order cannot drive net sales below zero', () => {
    const o = order({ refunds: [{ amount: 99999 }] });
    const r = run([o]);
    expect(r.totals.netSalesAfterRefundPaise).toBe(0);
  });
});

describe('VC-105 engine: cost coverage', () => {
  const costs = (over) => new Map([['li1', { costPaise: 1620, costStatus: 'ACTUAL', costBasisAt: '2026-09-01T00:00:00.000Z', recipeVersionId: '3', ...over }]]);

  it('a costed line yields contribution margin and margin percent', () => {
    // net 10000, cogs 1620 -> CM 8380, margin 83.8%.
    const r = run([order()], costs());
    expect(r.rows[0].cogsPaise).toBe(1620);
    expect(r.rows[0].contributionMarginPaise).toBe(8380);
    expect(r.rows[0].marginPercent).toBe(83.8);
    expect(r.rows[0].costStatus).toBe('ACTUAL');
  });

  it('an uncosted line reports MISSING and null — never zero', () => {
    const r = run([order()], new Map());
    expect(r.rows[0].cogsPaise).toBeNull();
    expect(r.rows[0].contributionMarginPaise).toBeNull();
    expect(r.rows[0].marginPercent).toBeNull();
    expect(r.rows[0].costStatus).toBe('MISSING');
    expect(r.rows[0].segment).toBe('UNCLASSIFIED');
    // The sales side is still fully reported — only the cost side is unknown.
    expect(r.rows[0].netSalesPaise).toBe(10000);
    expect(r.totals.cogsPaise).toBeNull();
    expect(r.totals.contributionMarginPaise).toBeNull();
  });

  it('totals cover costed lines only, and say how many they left out', () => {
    // Two lines, one costed (cogs 1620 on net 10000), one not.
    const o = order({
      subtotal: 13000, discountAmount: 0, taxAmount: 0, total: 13000,
      items: [line(), line({ id: 'li2', productId: 'p2', name: 'Latte', qty: 1, unitPrice: 3000, lineSubtotal: 3000 })],
    });
    const r = run([o], costs());
    expect(r.totals.netSalesPaise).toBe(13000);          // all sales counted
    expect(r.totals.cogsPaise).toBe(1620);
    expect(r.totals.contributionMarginPaise).toBe(8380); // costed line only
    expect(r.totals.basis).toBe('COSTED_LINES_ONLY');
    expect(r.totals.excludedLines).toBe(1);
    expect(r.coverage.linesCosted).toBe(1);
    expect(r.coverage.lines).toBe(2);
    expect(r.coverage.coveragePercent).toBe(50);
  });

  it('a cost struck longer ago than the stale window is STALE but still counts', () => {
    const r = run([order()], costs({ costBasisAt: '2025-01-01T00:00:00.000Z' }));
    expect(r.rows[0].costStatus).toBe('STALE');
    expect(r.rows[0].cogsPaise).toBe(1620);             // flagged, not discarded
    expect(r.coverage.byStatus.STALE).toBe(1);
  });

  it('a group holding one uncosted line cannot report ACTUAL', () => {
    const o = order({
      subtotal: 20000, discountAmount: 0, taxAmount: 0, total: 20000,
      items: [line(), line({ id: 'li2', lineSubtotal: 10000 })], // same product
    });
    const r = run([o], costs());
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].costStatus).toBe('MISSING');        // worst-of
    expect(r.rows[0].coverage.partial).toBe(true);
  });
});

describe('VC-105 engine: historical reproducibility', () => {
  it('re-running a past period later returns the same cost', () => {
    // The cost was struck at sale time and is read, not recomputed, so the
    // only thing a later "today" can change is the staleness flag.
    const costs = new Map([['li1', { costPaise: 1620, costStatus: 'ACTUAL', costBasisAt: '2026-09-01T00:00:00.000Z' }]]);
    const march = run([order()], costs, { asOf: new Date('2026-09-05T00:00:00Z') });
    const september = run([order()], costs, { asOf: new Date('2026-09-20T00:00:00Z') });
    expect(september.rows[0].cogsPaise).toBe(march.rows[0].cogsPaise);
    expect(september.rows[0].contributionMarginPaise).toBe(march.rows[0].contributionMarginPaise);
    expect(march.rows[0].costStatus).toBe('ACTUAL');
  });
});

describe('VC-105 engine: zero sales and empty periods', () => {
  it('no orders is an empty report, not a crash or a zero margin', () => {
    const r = run([]);
    expect(r.rows).toEqual([]);
    expect(r.totals.qty).toBe(0);
    expect(r.totals.netSalesPaise).toBe(0);
    expect(r.totals.cogsPaise).toBeNull();
    expect(r.totals.marginPercent).toBeNull();
    expect(r.segments.thresholds.popularityShare).toBeNull();
    expect(r.coverage.coveragePercent).toBe(0);
    expect(reconcile([], r.totals).agrees).toBe(true);
  });

  it('a negative contribution margin is reported as negative, not clamped', () => {
    // net 10000, cogs 12000 -> CM -2000, margin -20%.
    const costs = new Map([['li1', { costPaise: 12000, costStatus: 'ACTUAL' }]]);
    const r = run([order()], costs);
    expect(r.rows[0].contributionMarginPaise).toBe(-2000);
    expect(r.rows[0].marginPercent).toBe(-20);
  });
});

describe('VC-105 engine: segments', () => {
  it('classifies on the documented thresholds and leaves uncosted items out', () => {
    // Four products, qty 10/10/1/1 -> total 22. N = 4, popularity line is
    // 0.70 x 1/4 = 0.175. Shares: 0.4545, 0.4545, 0.04545, 0.04545.
    // So the two qty-10 items are popular, the two qty-1 items are not.
    //
    // Costs: A margin/unit high, B low, C high, D uncosted.
    //   A: net 10000 cogs 2000 -> CM 8000 over qty 10 -> 800/unit
    //   B: net 10000 cogs 9000 -> CM 1000 over qty 10 -> 100/unit
    //   C: net  1000 cogs  200 -> CM  800 over qty  1 -> 800/unit
    // weighted mean over costed = (8000+1000+800) / (10+10+1) = 9800/21 = 467 (rounded)
    //   A 800 >= 467 high, popular   -> STAR
    //   B 100 <  467 low,  popular   -> PLOUGHHORSE
    //   C 800 >= 467 high, unpopular -> PUZZLE
    //   D uncosted                   -> UNCLASSIFIED (never DOG)
    const mk = (id, product, qty, net) => line({
      id, productId: product, name: product, qty, unitPrice: Math.round(net / qty), lineSubtotal: net,
    });
    const o = order({
      subtotal: 22000, discountAmount: 0, taxAmount: 0, total: 22000,
      items: [mk('a', 'A', 10, 10000), mk('b', 'B', 10, 10000), mk('c', 'C', 1, 1000), mk('d', 'D', 1, 1000)],
    });
    const costs = new Map([
      ['a', { costPaise: 2000, costStatus: 'ACTUAL' }],
      ['b', { costPaise: 9000, costStatus: 'ACTUAL' }],
      ['c', { costPaise: 200, costStatus: 'ACTUAL' }],
    ]);
    const r = run([o], costs);
    const seg = Object.fromEntries(r.rows.map((x) => [x.key, x.segment]));

    expect(r.segments.thresholds.popularityShare).toBe(0.175);
    expect(r.segments.thresholds.marginPerUnitPaise).toBe(467);
    expect(seg).toEqual({ A: 'STAR', B: 'PLOUGHHORSE', C: 'PUZZLE', D: 'UNCLASSIFIED' });
    expect(r.segments.counts.DOG).toBe(0);
  });
});

describe('VC-105 engine: grouping', () => {
  it('groups by store, channel and period from the same rows', () => {
    const o1 = order({ id: 'o1', branchId: 'b1', type: 'DINE_IN', businessDate: '2026-09-10' });
    const o2 = order({
      id: 'o2', branchId: 'b2', branchName: 'Two', type: 'TAKEAWAY', businessDate: '2026-09-11',
      items: [line({ id: 'li2' })],
    });
    expect(run([o1, o2], new Map(), { groupBy: 'store' }).rows.map((r) => r.key).sort()).toEqual(['b1', 'b2']);
    expect(run([o1, o2], new Map(), { groupBy: 'channel' }).rows.map((r) => r.key).sort()).toEqual(['DINE_IN', 'TAKEAWAY']);
    expect(run([o1, o2], new Map(), { groupBy: 'period' }).rows.map((r) => r.key).sort()).toEqual(['2026-09-10', '2026-09-11']);
  });
});

// ---------------------------------------------------------------------------
// Cost provider: recipe arithmetic, yields, conversions, modifiers.
// ---------------------------------------------------------------------------

describe('VC-105 cost provider: recipe arithmetic', () => {
  it('costs a simple recipe: 18 g at 45 paise/g, x2 sold', () => {
    // 18000 milli-g x 45 = 810,000 milli-paise = 810 paise per unit.
    // x 2 sold = 1620 paise.
    const r = costFromRecipe(
      { yieldPercent: 100, lines: [{ qtyBaseMilli: 18000, unitCostPaise: 45 }] },
      { qty: 2 },
    );
    expect(r.costPaise).toBe(1620);
    expect(r.costStatus).toBe('ACTUAL');
  });

  it('applies a yield: 95% makes the plate cost 1/0.95 of the recipe', () => {
    // 810,000 milli-paise / 0.95 = 852,631.6 -> 852,632 milli-paise
    // x 1 sold, /1000 -> 853 paise (vs 810 at full yield).
    const r = costFromRecipe(
      { yieldPercent: 95, lines: [{ qtyBaseMilli: 18000, unitCostPaise: 45 }] },
      { qty: 1 },
    );
    expect(r.costPaise).toBe(853);
  });

  it('converts a named unit: 0.15 L of milk at 6 paise/ml is 900 paise', () => {
    // factorMilli 1,000,000 milli-ml per litre -> 0.15 L = 150,000 milli-ml.
    // 150,000 x 6 = 900,000 milli-paise = 900 paise.
    const r = costFromRecipe(
      { yieldPercent: 100, lines: [{ qty: 0.15, unit: 'L', factorMilli: 1000000, unitCostPaise: 6 }] },
      { qty: 1 },
    );
    expect(r.costPaise).toBe(900);
  });

  it('adds modifier cost outside the yield adjustment', () => {
    // base 810,000 -> yield 100% -> 810,000; extra shot 9000 x 45 = 405,000.
    // total 1,215,000 milli-paise -> 1215 paise for one sold.
    const recipe = {
      yieldPercent: 100,
      lines: [{ qtyBaseMilli: 18000, unitCostPaise: 45 }],
      modifiers: { 'mod-extra-shot': { qtyBaseMilli: 9000, unitCostPaise: 45 } },
    };
    expect(costFromRecipe(recipe, { qty: 1, modifierIds: ['mod-extra-shot'] }).costPaise).toBe(1215);
    // An unknown modifier id is ignored rather than guessed at.
    expect(costFromRecipe(recipe, { qty: 1, modifierIds: ['nope'] }).costPaise).toBe(810);
  });

  it('a whole latte: two ingredients and a 95% yield', () => {
    // 18000x45 = 810,000 plus 150,000x6 = 900,000 -> 1,710,000
    // / 0.95 = 1,800,000 milli-paise -> 1800 paise.
    const r = costFromRecipe(
      {
        yieldPercent: 95,
        lines: [
          { qtyBaseMilli: 18000, unitCostPaise: 45 },
          { qty: 0.15, unit: 'L', factorMilli: 1000000, unitCostPaise: 6 },
        ],
      },
      { qty: 1 },
    );
    expect(r.costPaise).toBe(1800);
  });

  it('an incomplete or empty recipe is MISSING, not free', () => {
    expect(costFromRecipe(null, { qty: 1 }).costStatus).toBe('MISSING');
    expect(costFromRecipe({ lines: [] }, { qty: 1 }).costStatus).toBe('MISSING');
    expect(costFromRecipe({ lines: [{ qtyBaseMilli: 1 }] }, { qty: 1 }).costPaise).toBeNull();
    expect(costFromRecipe({ yieldPercent: 0, lines: [{ qtyBaseMilli: 1, unitCostPaise: 1 }] }, { qty: 1 }).costPaise).toBeNull();
  });

  it('rounds to paise exactly once, at the end', () => {
    // Two lines that each round badly on their own: 1 milli-unit at 1 paise
    // is 1 milli-paise, and 1 sold would be 0.001 paise. Three of them is
    // still 0 after one round-half-up, but rounding each line first would
    // also give 0 — so use a case where the difference shows: 1667 milli-paise
    // x 3 sold = 5001 milli-paise -> 5 paise. Rounding per line (2 paise each)
    // would give 6.
    const r = costFromRecipe(
      { yieldPercent: 100, lines: [{ qtyBaseMilli: 1667, unitCostPaise: 1 }] },
      { qty: 3 },
    );
    expect(r.costPaise).toBe(5);
  });
});

describe('VC-105 cost breakdown (contract 1.1.0)', () => {
  it('explains a latte: two ingredients, the yield, and the exact per-unit cost', () => {
    // 18000x45 = 810,000 and 150,000x6 = 900,000 -> 1,710,000 pre-yield.
    // /0.95 = 1,800,000, so the yield itself added 90,000 milli-paise.
    const r = costFromRecipe(
      {
        recipeVersion: 2,
        yieldPercent: 95,
        lines: [
          { item: 'Coffee powder', qtyBaseMilli: 18000, unitCostPaise: 45 },
          { item: 'Milk', qty: 0.15, unit: 'L', factorMilli: 1000000, unitCostPaise: 6 },
        ],
      },
      { qty: 1 },
    );
    const b = r.breakdown;
    expect(b.recipeVersion).toBe(2);
    expect(b.yieldPercent).toBe(95);
    expect(b.ingredients.map((i) => i.costMilliPaise)).toEqual([810000, 900000]);
    expect(b.preYieldMilliPaise).toBe(1710000);
    expect(b.yieldAdjustmentMilliPaise).toBe(90000);
    expect(b.unitCostMilliPaise).toBe(1800000);
    // The conversion is carried so the drilldown can show "0.15 L" and not
    // only the converted milli figure.
    expect(b.ingredients[1].unit).toBe('L');
    expect(b.ingredients[1].qtyBaseMilli).toBe(150000);
  });

  it('carries modifiers separately from the recipe', () => {
    const r = costFromRecipe(
      {
        recipeVersion: 3,
        yieldPercent: 100,
        lines: [{ item: 'Coffee powder', qtyBaseMilli: 18000, unitCostPaise: 45 }],
        modifiers: { 'mod-extra-shot': { item: 'Extra shot', qtyBaseMilli: 9000, unitCostPaise: 45 } },
      },
      { qty: 1, modifierIds: ['mod-extra-shot'] },
    );
    expect(r.breakdown.modifiers).toEqual([
      { modifierId: 'mod-extra-shot', item: 'Extra shot', qtyBaseMilli: 9000, unitCostPaise: 45, costMilliPaise: 405000 },
    ]);
    expect(r.breakdown.unitCostMilliPaise).toBe(1215000);
  });

  it('the authoritative cogs is the row total, not the sum of displayed parts', () => {
    // unitCost 1,800,000 milli-paise x 3 sold / 1000 = 5400 paise, rounded once.
    const r = costFromRecipe(
      { recipeVersion: 2, yieldPercent: 95, lines: [{ qtyBaseMilli: 18000, unitCostPaise: 45 }, { qtyBaseMilli: 150000, unitCostPaise: 6 }] },
      { qty: 3 },
    );
    expect(r.costPaise).toBe(5400);
    expect(mulDivRoundHalfUp(r.breakdown.unitCostMilliPaise, 3, 1000)).toBe(5400);
  });

  it('attaches breakdowns to item rows only, keyed by recipe version', () => {
    const costs = new Map([['li1', {
      costPaise: 1620, costStatus: 'ACTUAL',
      breakdown: { recipeVersion: 3, yieldPercent: 100, ingredients: [], preYieldMilliPaise: 810000, yieldAdjustmentMilliPaise: 0, modifiers: [], unitCostMilliPaise: 810000 },
    }]]);
    const byItem = run([order()], costs);
    expect(byItem.rows[0].costBreakdowns).toHaveLength(1);
    expect(byItem.rows[0].costBreakdowns[0].recipeVersion).toBe(3);

    // A store row spans products, so a single recipe breakdown would be a
    // fiction: null, not an empty array.
    const byStore = run([order()], costs, { groupBy: 'store' });
    expect(byStore.rows[0].costBreakdowns).toBeNull();
  });

  it('an uncosted item row has an empty breakdown list, not a fabricated one', () => {
    const r = run([order()], new Map());
    expect(r.rows[0].costBreakdowns).toEqual([]);
    expect(r.rows[0].cogsPaise).toBeNull();
  });
});

describe('VC-105 cost provider: which provider answers', () => {
  it('defaults to NONE, and NONE costs nothing at all', async () => {
    const p = resolveCostProvider({ prisma: {}, env: {} });
    expect(p.source).toBe('NONE');
    expect(p.dependency).toBe('BLOCKED');
    expect(await p.lookup([{ id: 'x' }])).toEqual(new Map());
  });

  it('refuses the synthetic provider when NODE_ENV is production', () => {
    const p = resolveCostProvider({
      prisma: {},
      env: { NODE_ENV: 'production', VC105_SYNTHETIC_COSTS: '1', VC105_SYNTHETIC_COST_FILE: FIXTURE },
    });
    expect(p.source).toBe('NONE');
  });

  it('refuses the synthetic provider without the explicit flag', () => {
    const p = resolveCostProvider({ prisma: {}, env: { VC105_SYNTHETIC_COST_FILE: FIXTURE } });
    expect(p.source).toBe('NONE');
  });

  it('states whether a past period can be reproduced, per provider', () => {
    // Measured, not assumed: doubling the coffee price in the fixture moved a
    // past window's COGS from 12960 to 25920 paise. The fixture provider
    // prices at query time, so it cannot hold history still — and the payload
    // has to say so rather than let a reader assume March is still March.
    expect(resolveCostProvider({ prisma: {}, env: {} }).historicalReproducibility)
      .toBe('NOT_APPLICABLE_NO_COSTS');

    expect(resolveCostProvider({
      prisma: {},
      env: { NODE_ENV: 'test', VC105_SYNTHETIC_COSTS: '1', VC105_SYNTHETIC_COST_FILE: FIXTURE },
    }).historicalReproducibility).toBe('NOT_GUARANTEED_SYNTHETIC');

    // The live provider reads a cost struck at sale time, so a later purchase
    // price cannot reach back into it.
    const live = resolveCostProvider({ prisma: { saleConsumption: { findMany: async () => [] } } });
    expect(live.source).toBe('LIVE');
    expect(live.historicalReproducibility).toBe('GUARANTEED_BY_STORED_COST');
  });

  it('serves fixtures when both conditions hold, and labels them', async () => {
    const p = resolveCostProvider({
      prisma: {},
      env: { NODE_ENV: 'test', VC105_SYNTHETIC_COSTS: '1', VC105_SYNTHETIC_COST_FILE: FIXTURE },
    });
    expect(p.source).toBe('SYNTHETIC');
    expect(p.dependency).toBe('BLOCKED');
    expect(p.warning).toMatch(/SYNTHETIC/);
    const got = await p.lookup([
      { id: 'l1', productId: 'p1', sku: 'SKU-COFFEE', qty: 2, modifierIds: [] },
      { id: 'l2', productId: 'p2', sku: 'SKU-UNKNOWN', qty: 1, modifierIds: [] },
    ]);
    expect(got.get('l1').costPaise).toBe(1620);
    // A product with no fixture entry is missing, not free.
    expect(got.get('l2').costPaise).toBeNull();
    expect(got.get('l2').uncostedReason).toBe('NO_RECIPE');
  });
});

// ---------------------------------------------------------------------------
// Endpoint: scoping, roles, reconciliation against stored orders.
// ---------------------------------------------------------------------------

describe('VC-105 endpoint', () => {
  const PW = 'vc105-password-1';
  let companyA, companyB, branchA1, branchA2, branchB1, coffee, latte;
  const tokens = {};
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const login = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PW });
    expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body.token;
  };

  // Bills an order through stored columns the way computeOrderTotals would
  // have written them, so the endpoint reads exactly what a real bill leaves.
  const bill = async ({ branchId, companyId, type = 'DINE_IN', billedAt, items, discountAmount = 0, refund = 0, status = 'PAID' }) => {
    const subtotal = items.reduce((a, i) => a + i.lineSubtotal, 0);
    const taxAmount = items.reduce((a, i) => a + (i.lineTax ?? 0), 0);
    const total = subtotal - discountAmount + taxAmount;
    const o = await prisma.order.create({
      data: {
        companyId, branchId, type, status,
        openedById: tokens.ownerAId,
        billedAt, discountAmount: discountAmount / 100, subtotal: subtotal / 100,
        taxAmount: taxAmount / 100, total: total / 100,
        items: {
          create: items.map((i) => ({
            productId: i.productId, name: i.name, qty: i.qty,
            unitPrice: i.unitPrice / 100, lineDiscount: (i.lineDiscount ?? 0) / 100,
            lineSubtotal: i.lineSubtotal / 100, discountShare: (i.discountShare ?? 0) / 100,
            lineTax: (i.lineTax ?? 0) / 100,
            lineTotal: (i.lineSubtotal - (i.discountShare ?? 0) + (i.lineTax ?? 0)) / 100,
            status: 'ACTIVE',
          })),
        },
      },
    });
    if (refund > 0) {
      await prisma.refund.create({
        data: { orderId: o.id, amount: refund / 100, reason: 'test', status: 'SUCCEEDED', byId: tokens.ownerAId },
      });
    }
    return o;
  };

  beforeAll(async () => {
    await wipe();
    const passwordHash = await hashPassword(PW);
    const day = 86400e3;

    companyA = await prisma.company.create({
      data: { name: 'VC105 Alpha', slug: 'vc105-alpha', licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + day) } } },
    });
    companyB = await prisma.company.create({
      data: { name: 'VC105 Bravo', slug: 'vc105-bravo', licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + day) } } },
    });
    // publicId is required and unique since the foundation lane landed, and
    // CHECK Branch_publicId_shape pins the format to ^VC-[A-Z]{2}-[0-9]{4,}$ —
    // a lane tag of digits ("VC-105-…") is rejected at the database, not by
    // Prisma. PF = profitability; it is unused by every other suite.
    branchA1 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-PF-0001', name: 'Alpha One', code: 'A1' } });
    branchA2 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-PF-0002', name: 'Alpha Two', code: 'A2' } });
    branchB1 = await prisma.branch.create({ data: { companyId: companyB.id, publicId: 'VC-PF-0003', name: 'Bravo One', code: 'B1' } });

    const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
    const ownerA = await mk({ email: 'owner.a@vc105.test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
    tokens.ownerAId = ownerA.id;
    await mk({ email: 'mgr.a1@vc105.test.local', fullName: 'Mgr A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id });
    await mk({ email: 'cashier.a1@vc105.test.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id });
    await mk({ email: 'owner.b@vc105.test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });

    const cat = await prisma.category.create({ data: { companyId: companyA.id, name: 'Drinks' } });
    coffee = await prisma.product.create({ data: { companyId: companyA.id, categoryId: cat.id, name: 'Filter Coffee', sku: 'SKU-COFFEE', basePrice: 50 } });
    latte = await prisma.product.create({ data: { companyId: companyA.id, categoryId: cat.id, name: 'Latte', sku: 'SKU-LATTE', basePrice: 30 } });

    // Store A1, 2026-09-10: coffee x2 at 5000, FLAT 1000 order discount
    // allocated 769/231 across the two lines, no tax, partial refund 3000.
    await bill({
      companyId: companyA.id, branchId: branchA1.id, billedAt: new Date('2026-09-10T06:00:00.000Z'),
      discountAmount: 1000, refund: 3000, status: 'REFUNDED',
      items: [
        { productId: coffee.id, name: 'Filter Coffee', qty: 2, unitPrice: 5000, lineSubtotal: 10000, discountShare: 769 },
        { productId: latte.id, name: 'Latte', qty: 1, unitPrice: 3000, lineSubtotal: 3000, discountShare: 231 },
      ],
    });
    // Store A2, takeaway, next day, clean sale of one coffee.
    await bill({
      companyId: companyA.id, branchId: branchA2.id, type: 'TAKEAWAY', billedAt: new Date('2026-09-11T06:00:00.000Z'),
      items: [{ productId: coffee.id, name: 'Filter Coffee', qty: 1, unitPrice: 5000, lineSubtotal: 5000 }],
    });
    // Outside the window — must never appear.
    await bill({
      companyId: companyA.id, branchId: branchA1.id, billedAt: new Date('2026-08-01T06:00:00.000Z'),
      items: [{ productId: coffee.id, name: 'Filter Coffee', qty: 9, unitPrice: 5000, lineSubtotal: 45000 }],
    });

    tokens.ownerA = await login('owner.a@vc105.test.local');
    tokens.mgrA1 = await login('mgr.a1@vc105.test.local');
    tokens.cashierA1 = await login('cashier.a1@vc105.test.local');
    tokens.ownerB = await login('owner.b@vc105.test.local');
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  const get = (token, qs) => request(app).get(`/api/reports/menu-profitability?${qs}`).set(auth(token));
  const WINDOW = 'from=2026-09-01&to=2026-09-30';

  it('reports net sales that reconcile to the stored order totals', async () => {
    // In window: order 1 net 12000 (13000 - 1000 discount), order 2 net 5000.
    // Total net 17000. Refund 3000 -> 14000 after refunds.
    const res = await get(tokens.ownerA, WINDOW);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totals.netSalesPaise).toBe(17000);
    expect(res.body.totals.refundNetPaise).toBe(3000);
    expect(res.body.totals.netSalesAfterRefundPaise).toBe(14000);
    expect(res.body.reconciliation.agrees).toBe(true);
    expect(res.body.reconciliation.orderCount).toBe(2); // the August order is out
  });

  it('states that costing is blocked and reports no cost at all', async () => {
    const res = await get(tokens.ownerA, WINDOW);
    expect(res.body.meta.costing.dependency).toBe('BLOCKED');
    expect(res.body.meta.costing.source).toBe('NONE');
    expect(res.body.meta.costing.methodStatus).toBe('DECLARED_NOT_IMPLEMENTED');
    expect(res.body.meta.costing.missingCapabilities).toContain('recipe_versions');
    expect(res.body.totals.cogsPaise).toBeNull();
    expect(res.body.totals.contributionMarginPaise).toBeNull();
    for (const row of res.body.rows) {
      expect(row.cogsPaise).toBeNull();
      expect(row.segment).toBe('UNCLASSIFIED');
    }
  });

  it('labels the margin as contribution margin, not net profit', async () => {
    const res = await get(tokens.ownerA, WINDOW);
    expect(res.body.meta.marginLabel).toMatch(/Contribution margin/);
    expect(res.body.meta.marginLabel).toMatch(/Not net business profit/);
    expect(JSON.stringify(res.body)).not.toMatch(/net business profit(?!\.)/i);
  });

  it('scopes a branch-pinned manager to their own store, whatever they ask for', async () => {
    const own = await get(tokens.mgrA1, WINDOW);
    expect(own.body.meta.scope.branchId).toBe(branchA1.id);
    expect(own.body.totals.netSalesPaise).toBe(12000); // A1 only, not A2's 5000
    // Asking for the sibling store is overridden, not obeyed.
    const other = await get(tokens.mgrA1, `${WINDOW}&branchId=${branchA2.id}`);
    expect(other.body.meta.scope.branchId).toBe(branchA1.id);
    expect(other.body.totals.netSalesPaise).toBe(12000);
  });

  it("another tenant's store reads exactly like a store that does not exist", async () => {
    const cross = await get(tokens.ownerA, `${WINDOW}&branchId=${branchB1.id}`);
    const absent = await get(tokens.ownerA, `${WINDOW}&branchId=nope`);
    expect(cross.status).toBe(absent.status);
    expect(cross.body.error.code).toBe(absent.body.error.code);
    expect(cross.status).toBe(404);
    // Control: company B sees its own store fine.
    expect((await get(tokens.ownerB, `${WINDOW}&branchId=${branchB1.id}`)).status).toBe(200);
  });

  it('refuses a cashier', async () => {
    const res = await get(tokens.cashierA1, WINDOW);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('POS_FORBIDDEN');
  });

  it('filters by channel and groups by store, channel and period', async () => {
    const takeaway = await get(tokens.ownerA, `${WINDOW}&channel=TAKEAWAY`);
    expect(takeaway.body.totals.netSalesPaise).toBe(5000);

    const byStore = await get(tokens.ownerA, `${WINDOW}&groupBy=store`);
    expect(byStore.body.rows.map((r) => r.key).sort()).toEqual([branchA1.id, branchA2.id].sort());

    const byPeriod = await get(tokens.ownerA, `${WINDOW}&groupBy=period`);
    expect(byPeriod.body.rows.map((r) => r.key).sort()).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('an empty period is an empty report, not an error', async () => {
    const res = await get(tokens.ownerA, 'from=2026-07-01&to=2026-07-31');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.totals.netSalesPaise).toBe(0);
    expect(res.body.totals.marginPercent).toBeNull();
    expect(res.body.reconciliation.agrees).toBe(true);
  });

  it('rejects a reversed date range', async () => {
    const res = await get(tokens.ownerA, 'from=2026-09-30&to=2026-09-01');
    expect(res.status).toBe(400);
  });

  it('agrees with /reports/sales on the bridging identity', async () => {
    // VC105.netSales (tax-exclusive) = SalesReport.netSales - SalesReport.tax.
    const mine = await get(tokens.ownerA, WINDOW);
    const sales = await request(app)
      .get('/api/reports/sales?from=2026-09-01&to=2026-09-30')
      .set(auth(tokens.ownerA));
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    const salesNetPaise = Math.round(sales.body.report.sales.netSales * 100);
    const salesTaxPaise = Math.round(sales.body.report.sales.tax * 100);
    expect(mine.body.totals.netSalesPaise).toBe(salesNetPaise - salesTaxPaise);
  });
});
