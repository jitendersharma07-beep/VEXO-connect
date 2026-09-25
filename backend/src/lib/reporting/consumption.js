// LANE reporting — ingredient consumption, and the five figures that must stay apart.
//
// "How much milk did we use?" has five different answers and a report that prints
// one of them as if it were the others is how a kitchen ends up chasing a theft
// that was actually a recipe change:
//
//   1. sold        — menu quantities that left the till
//   2. expected    — what those sales should have drawn, per the recipe in force
//   3. physical    — what the shelves actually lost between two counts
//   4. accounted   — wastage and other documented usage
//   5. unexplained — physical minus expected minus accounted
//
// Only (1), (3) and (4) are observed. (2) is a calculation and (5) is a residue.
// The residue is the only number worth acting on, and it is meaningless unless the
// other four are each honest about where they came from.
//
// Physical depletion needs two counts. Where counts are weekly, the variance is a
// weekly figure and saying otherwise invents precision:
//
//   physical    = opening + receipts + transfersIn - transfersOut - returns - closing
//   unexplained = physical - expected - wastage - otherUsage
//
// Everything here is a pure function over integer base units. The inventory models
// may be absent from a deployment — see capability.js — but the arithmetic is the
// same arithmetic either way, so it is proven independently of whether this build
// can supply the inputs.

import { fromBase, quantity, displayUnitFor, toBase, UnitMismatchError, familyOf } from './units.js';

export const MEASURED = 'MEASURED';
export const NOT_COUNTED = 'NOT_COUNTED';
export const PARTIAL_COUNT = 'PARTIAL_COUNT';

/**
 * Expected usage for one sold line, at the recipe version that applied when it sold.
 *
 * `perUnitBase` is the recipe's quantity for one sale of the product, already in
 * base units, taken from the version in force at the time of sale rather than the
 * version in force now. A recipe edited on Thursday does not change what Monday
 * should have used, and a report that recalculates history with today's recipe
 * will show a variance that is really an edit.
 */
export const expectedForLine = ({ soldQty, perUnitBase, yieldFactor = 1 }) => {
  const qty = Number(soldQty);
  const per = Number(perUnitBase);
  if (!Number.isFinite(qty) || !Number.isFinite(per)) return 0;
  // Yield is a loss, not a gain: a 0.9 yield means 10% never reaches the plate, so
  // more is drawn from stock than the plate contains.
  const y = Number(yieldFactor);
  const factor = Number.isFinite(y) && y > 0 ? y : 1;
  return Math.round((qty * per) / factor);
};

/**
 * Physical depletion between two counts.
 *
 * Returns `measured: false` when either count is missing. A book balance computed
 * from movements alone is a different claim — it is what the system believes, not
 * what the shelf shows — and presenting it as a count is exactly the substitution
 * this function exists to prevent.
 */
export const physicalDepletion = ({
  openingBase = null,
  closingBase = null,
  receiptsBase = 0,
  transfersInBase = 0,
  transfersOutBase = 0,
  returnsBase = 0,
  countPeriod = null,
}) => {
  const counted = openingBase !== null && closingBase !== null;
  if (!counted) {
    return {
      measured: false,
      state: openingBase === null && closingBase === null ? NOT_COUNTED : PARTIAL_COUNT,
      base: null,
      countPeriod,
      note:
        openingBase === null && closingBase === null
          ? 'No opening or closing count, so physical depletion cannot be measured.'
          : 'Only one of the two counts exists, so physical depletion cannot be measured.',
    };
  }
  const base =
    openingBase + receiptsBase + transfersInBase - transfersOutBase - returnsBase - closingBase;
  return { measured: true, state: MEASURED, base, countPeriod, note: null };
};

/**
 * The five figures for one ingredient, reconciled.
 *
 * `unexplained` is null — not zero — whenever physical depletion was not measured.
 * Zero unexplained variance is a finding: it says the shelves agree with the
 * recipes. "Nobody counted" says nothing at all, and the two must never render
 * the same.
 */
export const reconcileIngredient = ({
  ingredientId,
  name,
  unit,
  family,
  expectedBase = 0,
  wastageBase = 0,
  otherUsageBase = 0,
  physical,
  costPerBase = null,
  soldLines = [],
}) => {
  const fam = family ?? familyOf(unit);
  const accountedBase = wastageBase + otherUsageBase;
  const unexplainedBase = physical.measured ? physical.base - expectedBase - accountedBase : null;

  const at = (base) => (base === null ? null : quantity(base, fam, unit ?? null));
  const costOf = (base) =>
    base === null || costPerBase === null ? null : Math.round(base * costPerBase);

  return {
    ingredientId,
    name,
    family: fam,
    unit: unit ?? displayUnitFor(fam, expectedBase),
    sold: soldLines,
    expected: at(expectedBase),
    physical: {
      measured: physical.measured,
      state: physical.state,
      countPeriod: physical.countPeriod ?? null,
      note: physical.note ?? null,
      ...(physical.measured ? { quantity: at(physical.base) } : { quantity: null }),
    },
    wastage: at(wastageBase),
    otherUsage: at(otherUsageBase),
    accounted: at(accountedBase),
    unexplained: at(unexplainedBase),
    // Variance as a share of what was expected, so a 1 L gap on 15 L reads
    // differently from a 1 L gap on 1500 L.
    unexplainedPercent:
      unexplainedBase !== null && expectedBase > 0
        ? Math.round((unexplainedBase / expectedBase) * 10000) / 100
        : null,
    cost: {
      expectedPaise: costOf(expectedBase),
      wastagePaise: costOf(wastageBase),
      unexplainedPaise: costOf(unexplainedBase),
      measured: costPerBase !== null,
      note: costPerBase === null ? 'No cost is recorded for this ingredient in this period.' : null,
    },
  };
};

/**
 * Turn sold order lines into expected ingredient usage.
 *
 * `recipeFor(productId, variantId, at)` must return the version that applied at
 * that moment. Modifiers add their own components: an extra shot is extra coffee
 * and the recipe for the base drink does not know about it.
 *
 * A semi-finished item is skipped when its output is itself a component of the
 * dish being counted, because the dish's recipe already draws the raw ingredient.
 * Counting both is the classic double-count: 15 L of milk becomes 30.
 */
export const expectedUsageFromSales = ({ lines, recipeFor, skipProducedBy = () => false }) => {
  const byIngredient = new Map();
  const missingRecipe = [];

  const add = (component, soldQty, line) => {
    const perUnitBase =
      component.perUnitBase ?? toBase(component.qty, component.unit);
    const base = expectedForLine({ soldQty, perUnitBase, yieldFactor: component.yieldFactor });
    if (!base) return;
    const key = component.ingredientId;
    let row = byIngredient.get(key);
    if (!row) {
      row = {
        ingredientId: key,
        name: component.name ?? key,
        unit: component.unit ?? null,
        family: component.family ?? familyOf(component.unit),
        expectedBase: 0,
        costPerBase: component.costPerBase ?? null,
        soldLines: [],
      };
      byIngredient.set(key, row);
    }
    const fam = component.family ?? familyOf(component.unit);
    if (row.family && fam && row.family !== fam) throw new UnitMismatchError(row.family, fam);
    row.expectedBase += base;
    row.soldLines.push({
      productId: line.productId,
      productName: line.productName ?? null,
      variantId: line.variantId ?? null,
      soldQty,
      viaModifier: component.viaModifier ?? null,
      contributionBase: base,
    });
  };

  for (const line of lines) {
    if (skipProducedBy(line)) continue;
    const recipe = recipeFor(line.productId, line.variantId ?? null, line.at ?? null);
    if (!recipe) {
      missingRecipe.push({
        productId: line.productId,
        productName: line.productName ?? null,
        variantId: line.variantId ?? null,
        soldQty: line.qty,
      });
      continue;
    }
    for (const c of recipe.components ?? []) add(c, line.qty, line);
    for (const m of line.modifiers ?? []) {
      for (const c of m.components ?? []) {
        add({ ...c, viaModifier: m.name ?? m.id ?? null }, line.qty * (m.qty ?? 1), line);
      }
    }
  }

  return { rows: [...byIngredient.values()], missingRecipe };
};

/**
 * Coverage for a consumption report.
 *
 * Says plainly how much of the report is measured. An owner reading a variance
 * table needs to know whether the blank rows mean "nothing missing" or "nobody
 * counted 40 of these", and the answer changes what they should do next.
 */
export const consumptionCoverage = (rows, { countPeriod = null } = {}) => {
  const total = rows.length;
  const counted = rows.filter((r) => r.physical.measured).length;
  const costed = rows.filter((r) => r.cost.measured).length;
  return {
    ingredients: total,
    physicallyCounted: counted,
    notCounted: total - counted,
    costed,
    notCosted: total - costed,
    countPeriod,
    // The period the physical figures belong to, stated separately from the report
    // period, because they are frequently not the same period.
    note:
      counted === 0
        ? 'No stock counts cover this period, so physical depletion and unexplained variance are not measured. Expected usage is a calculation from recipes.'
        : counted < total
          ? `${total - counted} of ${total} ingredients have no stock count in this period, so their variance is not measured.`
          : null,
  };
};

/**
 * Totals across ingredients — in money only.
 *
 * Quantities are deliberately not summed. Adding 17 L of milk to 4 kg of coffee
 * produces 21 of nothing; see units.js. Cost is the one dimension in which
 * different ingredients are genuinely commensurable, and even then only the rows
 * that carry a recorded cost may contribute.
 */
export const consumptionTotals = (rows) => {
  const t = {
    expectedPaise: 0,
    wastagePaise: 0,
    unexplainedPaise: 0,
    costedIngredients: 0,
    uncostedIngredients: 0,
  };
  for (const r of rows) {
    if (!r.cost.measured) {
      t.uncostedIngredients += 1;
      continue;
    }
    t.costedIngredients += 1;
    t.expectedPaise += r.cost.expectedPaise ?? 0;
    t.wastagePaise += r.cost.wastagePaise ?? 0;
    t.unexplainedPaise += r.cost.unexplainedPaise ?? 0;
  }
  return t;
};

/**
 * A single ingredient's reconciliation, from raw quantities in display units.
 *
 * Convenience for callers holding figures the way a stock-keeper wrote them down
 * — "20 L", "150 ml" — rather than in base units. Conversion happens once, here,
 * and every subtraction after it is integer.
 */
export const reconcileFromQuantities = ({
  ingredientId,
  name,
  unit,
  opening = null,
  closing = null,
  receipts = 0,
  transfersIn = 0,
  transfersOut = 0,
  returns = 0,
  expected = 0,
  wastage = 0,
  otherUsage = 0,
  countPeriod = null,
  costPerBase = null,
}) => {
  const b = (v) => (v === null || v === undefined ? null : toBase(v, unit));
  const physical = physicalDepletion({
    openingBase: b(opening),
    closingBase: b(closing),
    receiptsBase: b(receipts) ?? 0,
    transfersInBase: b(transfersIn) ?? 0,
    transfersOutBase: b(transfersOut) ?? 0,
    returnsBase: b(returns) ?? 0,
    countPeriod,
  });
  return reconcileIngredient({
    ingredientId,
    name,
    unit,
    expectedBase: b(expected) ?? 0,
    wastageBase: b(wastage) ?? 0,
    otherUsageBase: b(otherUsage) ?? 0,
    physical,
    costPerBase,
  });
};

export const displayQty = (base, unit) => fromBase(base, unit);
