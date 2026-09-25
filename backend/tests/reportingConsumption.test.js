// LANE reporting — units and consumption reconciliation.
//
// Pure arithmetic, no database and no HTTP, because the claim under test is that
// the five consumption figures stay apart and the sums are exact. Both are
// properties of the functions, and proving them here means they hold in every
// deployment regardless of whether the inventory models are present.

import { describe, it, expect } from 'vitest';
import {
  MASS,
  VOLUME,
  COUNT,
  canonicalUnit,
  unitMeta,
  familyOf,
  toBase,
  fromBase,
  convert,
  sumQuantities,
  displayUnitFor,
  quantity,
  UnitMismatchError,
  UnknownUnitError,
} from '../src/lib/reporting/units.js';
import {
  expectedForLine,
  physicalDepletion,
  reconcileIngredient,
  reconcileFromQuantities,
  expectedUsageFromSales,
  consumptionCoverage,
  consumptionTotals,
  MEASURED,
  NOT_COUNTED,
  PARTIAL_COUNT,
} from '../src/lib/reporting/consumption.js';

describe('units — canonicalisation', () => {
  it('accepts the canonical keys', () => {
    expect(canonicalUnit('KG')).toBe('KG');
    expect(canonicalUnit('ml')).toBe('ML');
    expect(canonicalUnit(' L ')).toBe('L');
  });

  it('accepts the spellings a stock-keeper actually writes', () => {
    expect(canonicalUnit('grams')).toBe('G');
    expect(canonicalUnit('Kilogram')).toBe('KG');
    expect(canonicalUnit('litres')).toBe('L');
    expect(canonicalUnit('millilitre')).toBe('ML');
    expect(canonicalUnit('pcs')).toBe('PIECE');
    expect(canonicalUnit('nos')).toBe('UNIT');
    expect(canonicalUnit('doz')).toBe('DOZEN');
  });

  it('refuses to guess at an unknown unit', () => {
    expect(canonicalUnit('tola')).toBeNull();
    expect(canonicalUnit('')).toBeNull();
    expect(canonicalUnit(null)).toBeNull();
    expect(canonicalUnit(42)).toBeNull();
  });

  it('reports the family of each unit', () => {
    expect(familyOf('kg')).toBe(MASS);
    expect(familyOf('ml')).toBe(VOLUME);
    expect(familyOf('dozen')).toBe(COUNT);
    expect(familyOf('parsec')).toBeNull();
  });
});

describe('units — exact conversion', () => {
  it('holds 150 ml x 100 exactly', () => {
    // The whole reason quantities are integers in base units: this is the figure
    // in the acceptance example and it must be 15 L, not 14.999999999999998.
    const base = toBase(150, 'ml') * 100;
    expect(base).toBe(15000000);
    expect(fromBase(base, 'L')).toBe(15);
  });

  it('holds a fractional recipe quantity without a float', () => {
    expect(toBase(2.5, 'g')).toBe(2500);
    expect(toBase(0.001, 'kg')).toBe(1000);
    expect(fromBase(2500, 'g')).toBe(2.5);
  });

  it('converts within a family', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(2500, 'g', 'kg')).toBe(2.5);
    expect(convert(1, 'L', 'ml')).toBe(1000);
    expect(convert(1, 'dozen', 'unit')).toBe(12);
  });

  it('round-trips a thousand fractional litres without drift', () => {
    let base = 0;
    for (let i = 0; i < 1000; i += 1) base += toBase(0.001, 'L');
    expect(base).toBe(toBase(1, 'L'));
    expect(fromBase(base, 'L')).toBe(1);
  });

  it('refuses an unknown unit rather than treating it as one', () => {
    expect(() => toBase(1, 'tola')).toThrow(UnknownUnitError);
    expect(() => fromBase(1000, 'tola')).toThrow(UnknownUnitError);
    expect(() => convert(1, 'kg', 'tola')).toThrow(UnknownUnitError);
  });

  it('refuses a quantity that is not a number', () => {
    expect(() => toBase('later', 'kg')).toThrow(/Not a quantity/);
  });
});

describe('units — refusing incompatible sums', () => {
  it('will not convert mass to volume', () => {
    expect(() => convert(1, 'kg', 'L')).toThrow(UnitMismatchError);
    try {
      convert(1, 'kg', 'L');
    } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/different measures/);
      expect(e.units).toEqual(['KG', 'L']);
    }
  });

  it('will not sum 3 kg with 2 litres', () => {
    expect(() =>
      sumQuantities([
        { qty: 3, unit: 'kg' },
        { qty: 2, unit: 'L' },
      ]),
    ).toThrow(UnitMismatchError);
  });

  it('will not sum a count with a mass', () => {
    expect(() =>
      sumQuantities([
        { qty: 12, unit: 'unit' },
        { qty: 1, unit: 'g' },
      ]),
    ).toThrow(UnitMismatchError);
  });

  it('sums within a family and picks a readable unit', () => {
    const r = sumQuantities([
      { qty: 1, unit: 'kg' },
      { qty: 500, unit: 'g' },
    ]);
    expect(r.base).toBe(1500000);
    expect(r.unit).toBe('KG');
    expect(r.qty).toBe(1.5);
  });

  it('honours an explicit target unit in the same family', () => {
    const r = sumQuantities([{ qty: 1, unit: 'kg' }], 'g');
    expect(r.unit).toBe('G');
    expect(r.qty).toBe(1000);
  });

  it('refuses a target unit from another family', () => {
    expect(() => sumQuantities([{ qty: 1, unit: 'kg' }], 'L')).toThrow(UnitMismatchError);
  });

  it('sums nothing to zero without inventing a unit', () => {
    expect(sumQuantities([])).toEqual({ base: 0, unit: null, qty: 0 });
  });
});

describe('units — display', () => {
  it('reads figures the way a human would', () => {
    expect(displayUnitFor(VOLUME, 17000000)).toBe('L');
    expect(displayUnitFor(VOLUME, 250000)).toBe('ML');
    expect(displayUnitFor(MASS, 250000)).toBe('G');
    expect(displayUnitFor(MASS, 1000000)).toBe('KG');
    expect(displayUnitFor(COUNT, 12000)).toBe('UNIT');
  });

  it('labels a quantity with its family and unit', () => {
    const q = quantity(17000000, VOLUME);
    expect(q).toEqual({ base: 17000000, family: VOLUME, unit: 'L', unitLabel: 'L', qty: 17 });
  });

  it('refuses a unit that contradicts the family', () => {
    expect(() => quantity(1000, MASS, 'ml')).toThrow(UnitMismatchError);
  });

  it('keeps negative figures readable', () => {
    expect(displayUnitFor(VOLUME, -2000000)).toBe('L');
    expect(quantity(-2000000, VOLUME).qty).toBe(-2);
  });

  it('exposes the supported units for a picker', () => {
    expect(unitMeta('kgs')).toMatchObject({ key: 'KG', family: MASS, perUnit: 1000000 });
  });
});

describe('consumption — the controlled acceptance example', () => {
  // Opening milk 20 L; receipts 10 L; closing physical count 13 L; no transfers,
  // returns or other uses. Physical depletion 17 L. Expected usage 100 coffees
  // x 150 ml = 15 L. Recorded wastage 1 L. Unexplained variance 1 L.
  const milk = () =>
    reconcileFromQuantities({
      ingredientId: 'ing-milk',
      name: 'Milk',
      unit: 'L',
      opening: 20,
      closing: 13,
      receipts: 10,
      expected: 15,
      wastage: 1,
      countPeriod: { from: '2026-09-01', to: '2026-09-07' },
      costPerBase: 0.006, // 60 paise per litre-thousandth => Rs 60/L
    });

  it('measures physical depletion as 17 L', () => {
    const r = milk();
    expect(r.physical.measured).toBe(true);
    expect(r.physical.state).toBe(MEASURED);
    expect(r.physical.quantity.qty).toBe(17);
    expect(r.physical.quantity.unit).toBe('L');
  });

  it('computes expected usage as 15 L from 100 coffees x 150 ml', () => {
    const expectedBase = expectedForLine({ soldQty: 100, perUnitBase: toBase(150, 'ml') });
    expect(expectedBase).toBe(toBase(15, 'L'));
    expect(milk().expected.qty).toBe(15);
  });

  it('reports recorded wastage of 1 L separately', () => {
    const r = milk();
    expect(r.wastage.qty).toBe(1);
    expect(r.otherUsage.qty).toBe(0);
    expect(r.accounted.qty).toBe(1);
  });

  it('leaves exactly 1 L unexplained', () => {
    const r = milk();
    expect(r.unexplained.qty).toBe(1);
    expect(r.unexplained.unit).toBe('L');
  });

  it('reconciles: physical = expected + wastage + unexplained', () => {
    const r = milk();
    expect(r.physical.quantity.base).toBe(
      r.expected.base + r.accounted.base + r.unexplained.base,
    );
  });

  it('states the variance as a share of expected usage', () => {
    expect(milk().unexplainedPercent).toBe(6.67);
  });

  it('carries the count period the physical figure belongs to', () => {
    expect(milk().physical.countPeriod).toEqual({ from: '2026-09-01', to: '2026-09-07' });
  });

  it('values the variance in money when a cost is recorded', () => {
    const r = milk();
    expect(r.cost.measured).toBe(true);
    expect(r.cost.expectedPaise).toBe(90000); // 15 L x Rs 60
    expect(r.cost.wastagePaise).toBe(6000);
    expect(r.cost.unexplainedPaise).toBe(6000);
  });
});

describe('consumption — physical depletion', () => {
  it('includes transfers and returns in the movement identity', () => {
    const p = physicalDepletion({
      openingBase: toBase(20, 'L'),
      closingBase: toBase(13, 'L'),
      receiptsBase: toBase(10, 'L'),
      transfersInBase: toBase(2, 'L'),
      transfersOutBase: toBase(3, 'L'),
      returnsBase: toBase(1, 'L'),
    });
    // 20 + 10 + 2 - 3 - 1 - 13 = 15
    expect(fromBase(p.base, 'L')).toBe(15);
  });

  it('does not count an internal transfer out as consumption', () => {
    const moved = physicalDepletion({
      openingBase: toBase(20, 'L'),
      closingBase: toBase(15, 'L'),
      transfersOutBase: toBase(5, 'L'),
    });
    expect(moved.base).toBe(0);
  });

  it('refuses to measure depletion with no counts', () => {
    const p = physicalDepletion({ receiptsBase: toBase(10, 'L') });
    expect(p.measured).toBe(false);
    expect(p.state).toBe(NOT_COUNTED);
    expect(p.base).toBeNull();
    expect(p.note).toMatch(/cannot be measured/);
  });

  it('refuses to measure depletion from one count only', () => {
    const p = physicalDepletion({ openingBase: toBase(20, 'L') });
    expect(p.measured).toBe(false);
    expect(p.state).toBe(PARTIAL_COUNT);
    expect(p.base).toBeNull();
  });

  it('allows a zero opening count, which is a count', () => {
    const p = physicalDepletion({ openingBase: 0, closingBase: 0, receiptsBase: toBase(4, 'L') });
    expect(p.measured).toBe(true);
    expect(fromBase(p.base, 'L')).toBe(4);
  });
});

describe('consumption — honesty when nothing was counted', () => {
  const uncounted = () =>
    reconcileFromQuantities({
      ingredientId: 'ing-coffee',
      name: 'Coffee beans',
      unit: 'kg',
      expected: 4,
      wastage: 0.1,
    });

  it('still reports expected usage, which is a calculation', () => {
    expect(uncounted().expected.qty).toBe(4);
  });

  it('reports unexplained variance as null, never as zero', () => {
    const r = uncounted();
    expect(r.unexplained).toBeNull();
    expect(r.unexplainedPercent).toBeNull();
    // A zero here would claim the shelves agree with the recipes. Nobody looked.
    expect(r.unexplained).not.toBe(0);
  });

  it('says plainly that physical depletion was not measured', () => {
    const r = uncounted();
    expect(r.physical.measured).toBe(false);
    expect(r.physical.quantity).toBeNull();
    expect(r.physical.note).toMatch(/cannot be measured/);
  });

  it('reports no variance cost when there is no variance figure', () => {
    const r = reconcileFromQuantities({
      ingredientId: 'ing-coffee',
      unit: 'kg',
      expected: 4,
      costPerBase: 0.0005,
    });
    expect(r.cost.expectedPaise).toBe(2000);
    expect(r.cost.unexplainedPaise).toBeNull();
  });

  it('says plainly when no cost is recorded', () => {
    const r = uncounted();
    expect(r.cost.measured).toBe(false);
    expect(r.cost.expectedPaise).toBeNull();
    expect(r.cost.note).toMatch(/No cost is recorded/);
  });
});

describe('consumption — the count period is not the report period', () => {
  it('attributes a weekly variance to the week it was counted over', () => {
    const r = reconcileFromQuantities({
      ingredientId: 'ing-milk',
      unit: 'L',
      opening: 20,
      closing: 13,
      receipts: 10,
      expected: 15,
      wastage: 1,
      countPeriod: { from: '2026-09-01', to: '2026-09-08', cadence: 'WEEKLY' },
    });
    expect(r.physical.countPeriod.cadence).toBe('WEEKLY');
    const coverage = consumptionCoverage([r], { countPeriod: r.physical.countPeriod });
    expect(coverage.countPeriod.cadence).toBe('WEEKLY');
  });

  it('a single day inside a weekly count cannot claim a measured daily actual', () => {
    // The same day, asked for on its own: there is no count on either side of it,
    // so expected usage is all there is and the report must say so.
    const day = reconcileFromQuantities({
      ingredientId: 'ing-milk',
      unit: 'L',
      expected: 2.14,
      wastage: 0.14,
      countPeriod: null,
    });
    expect(day.expected.qty).toBe(2.14);
    expect(day.physical.measured).toBe(false);
    expect(day.unexplained).toBeNull();
    const coverage = consumptionCoverage([day]);
    expect(coverage.physicallyCounted).toBe(0);
    expect(coverage.note).toMatch(/Expected usage is a calculation from recipes/);
  });
});

describe('consumption — expected usage from sales', () => {
  const recipes = {
    'prod-coffee': {
      components: [
        { ingredientId: 'ing-milk', name: 'Milk', unit: 'ML', qty: 150, costPerBase: 0.006 },
        { ingredientId: 'ing-beans', name: 'Beans', unit: 'G', qty: 18, costPerBase: 0.0005 },
      ],
    },
    'prod-coffee|var-large': {
      components: [
        { ingredientId: 'ing-milk', name: 'Milk', unit: 'ML', qty: 220, costPerBase: 0.006 },
        { ingredientId: 'ing-beans', name: 'Beans', unit: 'G', qty: 24, costPerBase: 0.0005 },
      ],
    },
  };
  const recipeFor = (productId, variantId) =>
    recipes[variantId ? `${productId}|${variantId}` : productId] ?? null;

  it('sums 100 coffees into 15 L of milk', () => {
    const { rows } = expectedUsageFromSales({
      lines: [{ productId: 'prod-coffee', productName: 'Coffee', qty: 100 }],
      recipeFor,
    });
    const milk = rows.find((r) => r.ingredientId === 'ing-milk');
    expect(fromBase(milk.expectedBase, 'L')).toBe(15);
    const beans = rows.find((r) => r.ingredientId === 'ing-beans');
    expect(fromBase(beans.expectedBase, 'KG')).toBe(1.8);
  });

  it('uses the variant recipe when the sale carried a variant', () => {
    const { rows } = expectedUsageFromSales({
      lines: [{ productId: 'prod-coffee', variantId: 'var-large', qty: 10 }],
      recipeFor,
    });
    expect(fromBase(rows.find((r) => r.ingredientId === 'ing-milk').expectedBase, 'ML')).toBe(2200);
  });

  it('adds modifier components on top of the base recipe', () => {
    const { rows } = expectedUsageFromSales({
      lines: [
        {
          productId: 'prod-coffee',
          qty: 10,
          modifiers: [
            {
              id: 'mod-extra-shot',
              name: 'Extra shot',
              components: [{ ingredientId: 'ing-beans', unit: 'G', qty: 9 }],
            },
          ],
        },
      ],
      recipeFor,
    });
    const beans = rows.find((r) => r.ingredientId === 'ing-beans');
    expect(fromBase(beans.expectedBase, 'G')).toBe(270); // 10 x (18 + 9)
    expect(beans.soldLines.some((l) => l.viaModifier === 'Extra shot')).toBe(true);
  });

  it('applies yield as a loss, drawing more stock than reaches the plate', () => {
    // 1 kg of onion at 0.85 yield needs ~1.176 kg drawn from stock.
    expect(expectedForLine({ soldQty: 1, perUnitBase: toBase(1, 'kg'), yieldFactor: 0.85 })).toBe(
      1176471,
    );
  });

  it('names the products it has no recipe for instead of treating them as zero', () => {
    const { rows, missingRecipe } = expectedUsageFromSales({
      lines: [
        { productId: 'prod-coffee', qty: 1 },
        { productId: 'prod-mystery', productName: 'Chef special', qty: 4 },
      ],
      recipeFor,
    });
    expect(rows).toHaveLength(2);
    expect(missingRecipe).toEqual([
      { productId: 'prod-mystery', productName: 'Chef special', variantId: null, soldQty: 4 },
    ]);
  });

  it('does not double-count a semi-finished item and the dish that contains it', () => {
    // The sauce batch and the pasta dish both draw tomato. The dish's recipe
    // already accounts for it, so counting the production run as well would
    // report twice the tomato that ever existed.
    const lines = [
      { productId: 'prod-pasta', qty: 10 },
      { productId: 'prod-sauce-batch', qty: 1, producedFor: 'prod-pasta' },
    ];
    const sauceRecipes = {
      'prod-pasta': { components: [{ ingredientId: 'ing-tomato', unit: 'G', qty: 200 }] },
      'prod-sauce-batch': { components: [{ ingredientId: 'ing-tomato', unit: 'KG', qty: 2 }] },
    };
    const { rows } = expectedUsageFromSales({
      lines,
      recipeFor: (p) => sauceRecipes[p] ?? null,
      skipProducedBy: (line) => Boolean(line.producedFor),
    });
    expect(fromBase(rows[0].expectedBase, 'KG')).toBe(2);
    expect(rows).toHaveLength(1);
  });

  it('refuses to accumulate one ingredient across two families', () => {
    const bad = {
      'prod-oil-weighed': { components: [{ ingredientId: 'ing-oil', unit: 'KG', qty: 1 }] },
      'prod-oil-poured': { components: [{ ingredientId: 'ing-oil', unit: 'L', qty: 1 }] },
    };
    expect(() =>
      expectedUsageFromSales({
        lines: [
          { productId: 'prod-oil-weighed', qty: 1 },
          { productId: 'prod-oil-poured', qty: 1 },
        ],
        recipeFor: (p) => bad[p] ?? null,
      }),
    ).toThrow(UnitMismatchError);
  });

  it('keeps the sold lines behind each ingredient figure for drill-down', () => {
    const { rows } = expectedUsageFromSales({
      lines: [
        { productId: 'prod-coffee', productName: 'Coffee', qty: 60 },
        { productId: 'prod-coffee', variantId: 'var-large', productName: 'Coffee', qty: 40 },
      ],
      recipeFor,
    });
    const milk = rows.find((r) => r.ingredientId === 'ing-milk');
    expect(milk.soldLines).toHaveLength(2);
    expect(fromBase(milk.soldLines[0].contributionBase, 'L')).toBe(9);
    expect(fromBase(milk.soldLines[1].contributionBase, 'L')).toBe(8.8);
    expect(fromBase(milk.expectedBase, 'L')).toBe(17.8);
  });

  it('ignores a recipe component of zero rather than emitting an empty row', () => {
    const { rows } = expectedUsageFromSales({
      lines: [{ productId: 'prod-water', qty: 5 }],
      recipeFor: () => ({ components: [{ ingredientId: 'ing-milk', unit: 'ML', qty: 0 }] }),
    });
    expect(rows).toHaveLength(0);
  });
});

describe('consumption — historical recipe versions', () => {
  it('uses the recipe in force at the time of sale, not the current one', () => {
    // The recipe was cut from 150 ml to 120 ml on the 4th. Monday's sales must be
    // measured against 150 or the edit shows up as a variance.
    const versions = [
      { from: new Date('2026-09-01T00:00:00Z'), perMl: 150 },
      { from: new Date('2026-09-04T00:00:00Z'), perMl: 120 },
    ];
    const recipeFor = (_p, _v, at) => {
      const v = [...versions].reverse().find((x) => at >= x.from);
      return { components: [{ ingredientId: 'ing-milk', unit: 'ML', qty: v.perMl }] };
    };
    const { rows } = expectedUsageFromSales({
      lines: [
        { productId: 'prod-coffee', qty: 100, at: new Date('2026-09-02T10:00:00Z') },
        { productId: 'prod-coffee', qty: 100, at: new Date('2026-09-05T10:00:00Z') },
      ],
      recipeFor,
    });
    expect(fromBase(rows[0].expectedBase, 'L')).toBe(27); // 15 + 12, not 30 and not 24
  });
});

describe('consumption — coverage and totals', () => {
  const counted = reconcileFromQuantities({
    ingredientId: 'ing-milk',
    unit: 'L',
    opening: 20,
    closing: 13,
    receipts: 10,
    expected: 15,
    wastage: 1,
    costPerBase: 0.006,
  });
  const notCounted = reconcileFromQuantities({
    ingredientId: 'ing-beans',
    unit: 'kg',
    expected: 1.8,
    costPerBase: 0.0005,
  });
  const notCosted = reconcileFromQuantities({
    ingredientId: 'ing-sugar',
    unit: 'kg',
    opening: 5,
    closing: 4,
    expected: 1,
  });

  it('counts how much of the report is measured', () => {
    const c = consumptionCoverage([counted, notCounted, notCosted]);
    expect(c).toMatchObject({
      ingredients: 3,
      physicallyCounted: 2,
      notCounted: 1,
      costed: 2,
      notCosted: 1,
    });
    expect(c.note).toMatch(/1 of 3 ingredients have no stock count/);
  });

  it('is silent when everything is measured', () => {
    expect(consumptionCoverage([counted]).note).toBeNull();
  });

  it('totals in money only, and only the costed rows', () => {
    const t = consumptionTotals([counted, notCounted, notCosted]);
    expect(t.costedIngredients).toBe(2);
    expect(t.uncostedIngredients).toBe(1);
    expect(t.expectedPaise).toBe(90000 + 900);
    expect(t.wastagePaise).toBe(6000);
    // Only milk has a measured variance; beans were never counted.
    expect(t.unexplainedPaise).toBe(6000);
  });

  it('never sums quantities across ingredients', () => {
    const t = consumptionTotals([counted, notCounted]);
    expect(t).not.toHaveProperty('expectedBase');
    expect(t).not.toHaveProperty('quantity');
  });
});

describe('consumption — a negative variance is reported, not hidden', () => {
  it('reports more stock than expected as a negative variance', () => {
    // Shelves lost less than the recipes say they should have. That is a finding
    // too: usually an over-count, a miskeyed receipt, or a recipe that is wrong.
    const r = reconcileFromQuantities({
      ingredientId: 'ing-milk',
      unit: 'L',
      opening: 20,
      closing: 16,
      receipts: 10,
      expected: 15,
      wastage: 1,
    });
    expect(fromBase(r.physical.quantity.base, 'L')).toBe(14);
    expect(r.unexplained.qty).toBe(-2);
    expect(r.unexplainedPercent).toBe(-13.33);
  });
});
