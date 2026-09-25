// LANE reporting — unit conversion for consumption figures.
//
// Quantities are held as integers in the smallest unit of their family —
// milligrams, microlitres, thousandths of a count — so 150 ml × 100 is exact and
// a recipe calling for 2.5 g does not need a float. Rounding once, at the edge,
// is the difference between a variance of 1 L and a variance of 0.9999999 L.
//
// Adding across families is refused, not coerced. There is no honest sum of
// "3 kg and 2 litres", and a report that prints 5 of something is worse than a
// report that refuses: oil bought by weight and dispensed by volume is exactly
// where a food-cost figure goes quietly wrong.

export const MASS = 'MASS';
export const VOLUME = 'VOLUME';
export const COUNT = 'COUNT';

// perUnit = how many base units one of this unit is worth.
const UNITS = new Map(
  Object.entries({
    MG: { family: MASS, perUnit: 1, label: 'mg' },
    G: { family: MASS, perUnit: 1000, label: 'g' },
    KG: { family: MASS, perUnit: 1000000, label: 'kg' },
    ML: { family: VOLUME, perUnit: 1000, label: 'ml' },
    L: { family: VOLUME, perUnit: 1000000, label: 'L' },
    UNIT: { family: COUNT, perUnit: 1000, label: 'unit' },
    PIECE: { family: COUNT, perUnit: 1000, label: 'piece' },
    DOZEN: { family: COUNT, perUnit: 12000, label: 'dozen' },
  }),
);

const ALIASES = new Map(
  Object.entries({
    MILLIGRAM: 'MG',
    MILLIGRAMS: 'MG',
    GRAM: 'G',
    GRAMS: 'G',
    GM: 'G',
    GMS: 'G',
    KILOGRAM: 'KG',
    KILOGRAMS: 'KG',
    KGS: 'KG',
    MILLILITER: 'ML',
    MILLILITRE: 'ML',
    MILLILITERS: 'ML',
    MILLILITRES: 'ML',
    LITER: 'L',
    LITRE: 'L',
    LITERS: 'L',
    LITRES: 'L',
    LTR: 'L',
    LT: 'L',
    EACH: 'UNIT',
    EA: 'UNIT',
    NOS: 'UNIT',
    NO: 'UNIT',
    PC: 'PIECE',
    PCS: 'PIECE',
    PIECES: 'PIECE',
    DOZENS: 'DOZEN',
    DOZ: 'DOZEN',
  }),
);

export const canonicalUnit = (unit) => {
  if (typeof unit !== 'string') return null;
  const key = unit.trim().toUpperCase();
  if (UNITS.has(key)) return key;
  const alias = ALIASES.get(key);
  return alias ?? null;
};

export const unitMeta = (unit) => {
  const key = canonicalUnit(unit);
  return key ? { key, ...UNITS.get(key) } : null;
};

export const familyOf = (unit) => unitMeta(unit)?.family ?? null;

export class UnitMismatchError extends Error {
  constructor(a, b) {
    super(`Cannot combine ${a} with ${b}: different measures`);
    this.name = 'UnitMismatchError';
    this.statusCode = 400;
    this.units = [a, b];
  }
}

export class UnknownUnitError extends Error {
  constructor(unit) {
    super(`Unknown unit: ${unit}`);
    this.name = 'UnknownUnitError';
    this.statusCode = 400;
    this.unit = unit;
  }
}

/** Quantity → integer base units. Rejects unknown units rather than guessing. */
export const toBase = (qty, unit) => {
  const meta = unitMeta(unit);
  if (!meta) throw new UnknownUnitError(unit);
  const n = Number(qty);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`Not a quantity: ${qty}`), { statusCode: 400 });
  return Math.round(n * meta.perUnit);
};

export const fromBase = (base, unit) => {
  const meta = unitMeta(unit);
  if (!meta) throw new UnknownUnitError(unit);
  return Math.round((base / meta.perUnit) * 1e6) / 1e6;
};

export const convert = (qty, fromUnit, toUnit) => {
  const a = unitMeta(fromUnit);
  const b = unitMeta(toUnit);
  if (!a) throw new UnknownUnitError(fromUnit);
  if (!b) throw new UnknownUnitError(toUnit);
  if (a.family !== b.family) throw new UnitMismatchError(a.key, b.key);
  return fromBase(toBase(qty, a.key), b.key);
};

/** Sums quantities that share a family. Refuses anything else. */
export const sumQuantities = (entries, targetUnit = null) => {
  if (!entries.length) return { base: 0, unit: targetUnit ? canonicalUnit(targetUnit) : null, qty: 0 };
  const first = unitMeta(entries[0].unit);
  if (!first) throw new UnknownUnitError(entries[0].unit);
  let base = 0;
  for (const e of entries) {
    const meta = unitMeta(e.unit);
    if (!meta) throw new UnknownUnitError(e.unit);
    if (meta.family !== first.family) throw new UnitMismatchError(first.key, meta.key);
    base += toBase(e.qty, meta.key);
  }
  const out = targetUnit ? unitMeta(targetUnit) : null;
  if (out && out.family !== first.family) throw new UnitMismatchError(first.key, out.key);
  const unit = out?.key ?? displayUnitFor(first.family, base);
  return { base, unit, qty: fromBase(base, unit) };
};

// Picks the unit a human would read the figure in: 17 L rather than 17000000 µl,
// 250 g rather than 0.25 kg.
export const displayUnitFor = (family, base) => {
  const abs = Math.abs(base);
  if (family === MASS) return abs >= 1000000 ? 'KG' : 'G';
  if (family === VOLUME) return abs >= 1000000 ? 'L' : 'ML';
  return 'UNIT';
};

export const quantity = (base, family, unit = null) => {
  const chosen = unit ? canonicalUnit(unit) : displayUnitFor(family, base);
  if (!chosen) throw new UnknownUnitError(unit);
  const meta = UNITS.get(chosen);
  if (meta.family !== family) throw new UnitMismatchError(family, chosen);
  return { base, family, unit: chosen, unitLabel: meta.label, qty: fromBase(base, chosen) };
};

export const SUPPORTED_UNITS = Object.freeze(
  [...UNITS.entries()].map(([key, v]) => ({ key, family: v.family, label: v.label, perUnit: v.perUnit })),
);
