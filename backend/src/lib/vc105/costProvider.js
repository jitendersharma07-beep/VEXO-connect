// VC-105 — where a sold line's ingredient cost comes from.
//
// Three providers, chosen in this order:
//
//   LIVE       reads SaleConsumption, the inventory lane's per-sale cost row.
//              Structurally unreachable at the pinned base: that model does
//              not exist, so `prisma.saleConsumption` is undefined. This arm
//              is written now so integration later is a provider swap rather
//              than a rewrite.
//   SYNTHETIC  development only, opt-in twice over, reads a fixture file.
//              Produces made-up numbers and says so in every response.
//   NONE       the default. Every line is MISSING. Not zero — missing.
//
// The ordering matters: SYNTHETIC can never shadow LIVE, and NONE is what you
// get unless someone deliberately asked for fixtures on a non-production box.

import { readFileSync } from 'node:fs';
import { mulDivRoundHalfUp } from './profitability.js';

export const MISSING_CAPABILITIES = [
  'recipe_versions',
  'yields',
  'unit_conversions',
  'modifier_costs',
  'purchase_valuation',
  'historical_cost_snapshots',
];

// Declared in the inventory lane's schema comment ("perpetual WEIGHTED AVERAGE
// per location per item"), pointing at src/lib/inventory/ledger.js — a file
// that does not exist. VC-105 reports the declaration and its status; it does
// not choose a valuation policy.
export const DECLARED_METHOD = 'WEIGHTED_AVERAGE';

// InventorySettings.staleCostDays defaults to 90 in the draft schema. Adopted,
// not invented.
export const DEFAULT_STALE_COST_DAYS = 90;

/**
 * Cost one sold line from a synthetic recipe fixture.
 *
 * All intermediate arithmetic is in MILLI-PAISE and rounds to paise exactly
 * once, at the end, so yield and conversion cannot each contribute their own
 * rounding error.
 *
 *   qtyBaseMilli   quantity in thousandths of the item's base unit (g/ml/pcs),
 *                  matching the inventory schema's stated "milli" convention.
 *                  Either given directly, or derived as qty x factorMilli.
 *   unitCostPaise  paise per ONE base unit.
 */
export const costFromRecipe = (recipe, { qty, modifierIds = [] }) => {
  if (!recipe || !Array.isArray(recipe.lines) || recipe.lines.length === 0) {
    return { costPaise: null, costStatus: 'MISSING', uncostedReason: recipe ? 'EMPTY_RECIPE' : 'NO_RECIPE' };
  }

  const qtyBaseMilliOf = (line) => {
    if (line.qtyBaseMilli !== undefined) return line.qtyBaseMilli;
    // Unit conversion: factorMilli is milli-base-units per one named unit, so
    // 1 kg against a base unit of g is 1_000_000.
    if (line.qty !== undefined && line.factorMilli !== undefined) {
      return Math.round(line.qty * line.factorMilli);
    }
    return null;
  };

  let milliPaise = 0;
  const ingredients = [];
  for (const line of recipe.lines) {
    const q = qtyBaseMilliOf(line);
    if (q === null || line.unitCostPaise === undefined || line.unitCostPaise === null) {
      return { costPaise: null, costStatus: 'MISSING', uncostedReason: 'INCOMPLETE_RECIPE_LINE' };
    }
    const componentMilliPaise = q * line.unitCostPaise;
    milliPaise += componentMilliPaise;
    // Carried for the drilldown, which has to be able to explain the number
    // rather than just show it. Exact, in milli-paise: the row's cogsPaise
    // stays the authoritative figure, because it rounds once at the end.
    ingredients.push({
      item: line.item ?? null,
      qtyBaseMilli: q,
      unit: line.unit ?? null,
      factorMilli: line.factorMilli ?? null,
      unitCostPaise: line.unitCostPaise,
      costMilliPaise: componentMilliPaise,
    });
  }
  const preYieldMilliPaise = milliPaise;

  // Yield: a 95% yield means the plate consumes 1/0.95 of what the recipe
  // lists, because trim and loss are paid for too.
  const yieldMilliPct = Math.round((recipe.yieldPercent ?? 100) * 1000);
  if (yieldMilliPct <= 0) {
    return { costPaise: null, costStatus: 'MISSING', uncostedReason: 'INVALID_YIELD' };
  }
  milliPaise = mulDivRoundHalfUp(milliPaise, 100000, yieldMilliPct);

  const yieldAdjustmentMilliPaise = milliPaise - preYieldMilliPaise;

  // Modifier deltas are ingredient changes, so they sit outside the yield
  // adjustment: an extra shot is an extra shot, not 1/0.95 of one.
  const modifiers = [];
  for (const id of modifierIds) {
    const mod = recipe.modifiers?.[id];
    if (!mod) continue;
    const q = mod.qtyBaseMilli ?? (mod.qtyDelta !== undefined && mod.factorMilli !== undefined
      ? Math.round(mod.qtyDelta * mod.factorMilli)
      : null);
    if (q === null || mod.unitCostPaise === undefined) continue;
    const componentMilliPaise = q * mod.unitCostPaise;
    milliPaise += componentMilliPaise;
    modifiers.push({
      modifierId: id,
      item: mod.item ?? null,
      qtyBaseMilli: q,
      unitCostPaise: mod.unitCostPaise,
      costMilliPaise: componentMilliPaise,
    });
  }

  return {
    costPaise: mulDivRoundHalfUp(milliPaise, qty, 1000),
    costStatus: recipe.costStatus === 'ESTIMATED' ? 'ESTIMATED' : 'ACTUAL',
    costBasisAt: recipe.costBasisAt ?? null,
    recipeVersionId: recipe.recipeVersion !== undefined ? String(recipe.recipeVersion) : null,
    uncostedReason: null,
    // Contract §10.1 — everything the drilldown needs to explain the figure.
    // Per ONE unit sold; the row multiplies by quantity.
    breakdown: {
      recipeVersion: recipe.recipeVersion ?? null,
      yieldPercent: recipe.yieldPercent ?? 100,
      ingredients,
      preYieldMilliPaise,
      yieldAdjustmentMilliPaise,
      modifiers,
      unitCostMilliPaise: milliPaise,
    },
  };
};

const loadFixture = (path) => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed.items !== 'object') {
    throw new Error('VC105 synthetic cost fixture must have an "items" object');
  }
  return parsed;
};

/**
 * @returns { source, method, methodStatus, staleCostDays, missingCapabilities,
 *            lookup(lines) -> Map<orderItemId, costRow> }
 *          where `lines` is [{ id, productId, sku, qty, modifierIds }].
 */
export const resolveCostProvider = ({ prisma, env = process.env } = {}) => {
  const base = {
    dependency: 'BLOCKED',
    method: DECLARED_METHOD,
    methodStatus: 'DECLARED_NOT_IMPLEMENTED',
    staleCostDays: DEFAULT_STALE_COST_DAYS,
    missingCapabilities: MISSING_CAPABILITIES,
    refundPolicy: 'COGS_NOT_REDUCED_ON_REFUND',
    // Contract §7. Reproducing a past period depends entirely on the cost
    // having been STORED at sale time. A provider that re-derives cost from
    // today's prices cannot reproduce March in September, and saying so in the
    // payload is the difference between a documented limitation and a report
    // that quietly rewrites history.
    historicalReproducibility: 'NOT_APPLICABLE_NO_COSTS',
  };

  // LIVE — the moment SaleConsumption exists, this is what answers.
  if (prisma && typeof prisma.saleConsumption?.findMany === 'function') {
    return {
      ...base,
      dependency: 'AVAILABLE',
      methodStatus: 'IMPLEMENTED',
      source: 'LIVE',
      // SaleConsumption.costPaise was written at sale time and is read, never
      // recomputed, so a later purchase-price change cannot move the past.
      historicalReproducibility: 'GUARANTEED_BY_STORED_COST',
      lookup: async (lines) => {
        const rows = await prisma.saleConsumption.findMany({
          where: { orderItemId: { in: lines.map((l) => l.id) } },
        });
        return new Map(rows.map((r) => [r.orderItemId, {
          costPaise: r.status === 'UNCOSTED' ? null : Number(r.costPaise),
          costStatus: r.costStatus,
          costBasisAt: r.costBasisAt,
          recipeVersionId: r.recipeVersionId,
          uncostedReason: r.uncostedReason,
        }]));
      },
    };
  }

  // SYNTHETIC — two independent conditions, both deliberate, neither the
  // default. A production NODE_ENV disqualifies it whatever the flag says.
  const wantsSynthetic = env.VC105_SYNTHETIC_COSTS === '1' && env.NODE_ENV !== 'production';
  if (wantsSynthetic && env.VC105_SYNTHETIC_COST_FILE) {
    const fixture = loadFixture(env.VC105_SYNTHETIC_COST_FILE);
    return {
      ...base,
      source: 'SYNTHETIC',
      warning: 'SYNTHETIC COSTS — these margins are fixture data, not real cost. Not evidence about live data.',
      // Measured, not assumed: doubling an ingredient price in the fixture
      // changed a past period's COGS from 12960 to 25920 paise. The fixture
      // provider prices at query time, so it cannot hold history still.
      historicalReproducibility: 'NOT_GUARANTEED_SYNTHETIC',
      staleCostDays: fixture.staleCostDays ?? DEFAULT_STALE_COST_DAYS,
      lookup: async (lines) => {
        const out = new Map();
        for (const line of lines) {
          const recipe = fixture.items[line.productId] ?? (line.sku ? fixture.items[line.sku] : undefined);
          // No fixture entry is a missing cost, not a free dish.
          if (!recipe) {
            out.set(line.id, { costPaise: null, costStatus: 'MISSING', uncostedReason: 'NO_RECIPE' });
            continue;
          }
          out.set(line.id, costFromRecipe(recipe, { qty: line.qty, modifierIds: line.modifierIds ?? [] }));
        }
        return out;
      },
    };
  }

  // NONE — the honest default.
  return {
    ...base,
    source: 'NONE',
    lookup: async () => new Map(),
  };
};
