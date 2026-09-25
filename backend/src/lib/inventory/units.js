// Unit conversion for the stock ledger.
//
// Every quantity in the ledger is in the item's BASE unit (g, ml or pcs) at
// exactly three decimals, which this module handles as integer thousandths —
// "milli" — for the same reason money.js handles rupees as paise: 0.1 + 0.2
// is not 0.3 in binary floating point, and a stock figure that drifts by a
// millionth per movement is a stock figure that stops matching the shelf.
//
// Two rules the kitchen depends on:
//
//   A litre is not a kilogram. Base units carry a dimension and a conversion
//   may never cross it. Honey is 1.4 kg to the litre and oil is 0.9, so a
//   system that treats l and kg as interchangeable is wrong by 40% on one and
//   10% on the other, in opposite directions.
//
//   A factor is frozen where it was used. A PO line, a recipe line and a
//   request line each store the factorMilli they converted with. Re-reading
//   them next year runs no conversion at all, so redefining "case" from 12 to
//   24 changes what the next order means and nothing about what the last one
//   meant.

export const MILLI = 1000;

// Standard units are code, not rows: they are the same for every item, and a
// per-item row for "kg" is a per-item chance to get it wrong.
const STANDARD = {
  G: { mg: 1, g: MILLI, gram: MILLI, grams: MILLI, kg: 1000 * MILLI, kilogram: 1000 * MILLI, kilograms: 1000 * MILLI },
  ML: { ml: MILLI, millilitre: MILLI, milliliter: MILLI, l: 1000 * MILLI, litre: 1000 * MILLI, liter: 1000 * MILLI, litres: 1000 * MILLI, liters: 1000 * MILLI },
  PCS: { pc: MILLI, pcs: MILLI, piece: MILLI, pieces: MILLI, unit: MILLI, units: MILLI, dozen: 12 * MILLI },
};

export const BASE_UNIT_NAME = { G: 'g', ML: 'ml', PCS: 'pcs' };

export class UnitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UnitError';
    this.code = code;
  }
}

export const normaliseUnitName = (name) => String(name ?? '').trim().toLowerCase();

// The full set of units an item may be transacted in: the standards for its
// dimension plus its own rows. Custom names cannot shadow a standard one —
// a "kg" that means 25 kg because someone named a sack after it would corrupt
// every historical line that read "kg" and meant a kilogram.
export const unitTableFor = (item, customUnits = []) => {
  const table = { ...STANDARD[item.baseUnit] };
  for (const u of customUnits) {
    const name = normaliseUnitName(u.name);
    if (table[name] !== undefined) continue;
    table[name] = Number(u.factorMilli);
  }
  return table;
};

export const resolveFactorMilli = (item, unitName, customUnits = []) => {
  const name = normaliseUnitName(unitName);
  if (!name) throw new UnitError('A unit is required', 'UNIT_REQUIRED');
  const table = unitTableFor(item, customUnits);
  const factor = table[name];
  if (factor === undefined) {
    // Say which dimension it belongs to when it is a real unit in the wrong
    // place. "kg is not valid for a millilitre item" is actionable; "unknown
    // unit" sends someone to create a bad custom unit.
    for (const [base, units] of Object.entries(STANDARD)) {
      if (base !== item.baseUnit && units[name] !== undefined) {
        throw new UnitError(
          `${name} measures ${base === 'G' ? 'weight' : base === 'ML' ? 'volume' : 'count'}, but ${item.name} is stocked in ${BASE_UNIT_NAME[item.baseUnit]}`,
          'UNIT_DIMENSION_MISMATCH',
        );
      }
    }
    throw new UnitError(`${unitName} is not a valid unit for ${item.name}`, 'UNIT_UNKNOWN');
  }
  if (!Number.isSafeInteger(factor) || factor <= 0) {
    throw new UnitError(`${unitName} has an unusable conversion factor`, 'UNIT_BAD_FACTOR');
  }
  return factor;
};

// Decimal string/number with at most 3 decimals → integer thousandths.
// Rejects anything finer rather than rounding it away silently: a recipe that
// needs 0.0005 g of something is a data entry error, not a rounding problem.
export const qtyToMilli = (qty, label = 'quantity') => {
  const s = String(qty).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new UnitError(`${label} must be a number`, 'QTY_NOT_NUMERIC');
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  if (frac.length > 3) {
    throw new UnitError(`${label} allows at most 3 decimals`, 'QTY_TOO_PRECISE');
  }
  const milli = Number(whole) * MILLI + Number((frac + '000').slice(0, 3));
  if (!Number.isSafeInteger(milli)) throw new UnitError(`${label} is out of range`, 'QTY_RANGE');
  return neg ? -milli : milli;
};

export const milliToQty = (milli) => {
  const n = BigInt(milli);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
};

// Entered quantity in `unitName` → base-unit milli. Round-half-up, and the
// caller is told whether rounding happened so a route can refuse or record it
// instead of pretending the number was exact.
export const convertToBaseMilli = (item, qty, unitName, customUnits = []) => {
  const factorMilli = resolveFactorMilli(item, unitName, customUnits);
  const enteredMilli = qtyToMilli(qty);
  const product = BigInt(enteredMilli) * BigInt(factorMilli);
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  const baseMilli = sign * ((abs + 500n) / 1000n);
  const exact = abs % 1000n === 0n;
  if (!Number.isSafeInteger(Number(baseMilli))) {
    throw new UnitError('quantity is out of range', 'QTY_RANGE');
  }
  return { baseMilli: Number(baseMilli), factorMilli, rounded: !exact, unit: normaliseUnitName(unitName) };
};

// The reverse, using the factor that was STORED on the historical line rather
// than looking it up again. This is the function reports must use.
export const displayInStoredUnit = (baseMilli, storedFactorMilli) => {
  if (!storedFactorMilli) return null;
  const q = (BigInt(baseMilli) * 1000n) / BigInt(storedFactorMilli);
  return milliToQty(Number(q));
};

// Whether changing an item's base unit is safe. It is safe only when the item
// has never been transacted: rewriting the base unit under existing movements
// would silently restate every historical quantity by a factor of a thousand.
export const baseUnitChangeBlockers = ({ movementCount, balanceCount, recipeLineCount }) => {
  const blockers = [];
  if (movementCount > 0) blockers.push(`${movementCount} stock movements already reference it`);
  if (balanceCount > 0) blockers.push(`${balanceCount} stock balances already reference it`);
  if (recipeLineCount > 0) blockers.push(`${recipeLineCount} recipe lines already reference it`);
  return blockers;
};
