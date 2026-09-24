// Order money engine — implements docs/PHASE2-CONTRACT.md §6 exactly.
// Everything here is integer paise; routes convert to/from rupee JSON.
// Percent rates travel as integer milli-percent (5% → 5000) so the
// Decimal(6,3) tax rates stay exact.

const assertInt = (n, label) => {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a safe integer: ${n}`);
  return n;
};

export const toPaise = (rupees) => {
  const n = Math.round(Number(rupees) * 100);
  if (!Number.isSafeInteger(n)) throw new Error(`amount out of range: ${rupees}`);
  return n;
};

export const toRupees = (paise) => paise / 100;

export const pctToMilli = (percent) => Math.round(Number(percent) * 1000);

// round-half-up(base × pct / 100), with pct in milli-percent.
export const percentOf = (basePaise, pctMilli) => {
  assertInt(basePaise, 'base');
  assertInt(pctMilli, 'pctMilli');
  return Math.floor((basePaise * pctMilli + 50000) / 100000);
};

// Largest-remainder split of totalPaise across weights; shares sum exactly to
// totalPaise. Equal remainders resolve by lowest index (deterministic).
// BigInt because totalPaise × weight can exceed 2^53 for large orders.
export const distributeProportional = (totalPaise, weights) => {
  assertInt(totalPaise, 'total');
  weights.forEach((w, i) => assertInt(w, `weight[${i}]`));
  const sumW = weights.reduce((a, w) => a + w, 0);
  if (sumW <= 0 || totalPaise === 0) return weights.map(() => 0);
  const T = BigInt(totalPaise);
  const S = BigInt(sumW);
  const shares = new Array(weights.length);
  const rems = new Array(weights.length);
  let assigned = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const raw = T * BigInt(weights[i]);
    shares[i] = Number(raw / S);
    rems[i] = Number(raw % S);
    assigned += shares[i];
  }
  let leftover = totalPaise - assigned;
  const order = rems.map((rem, i) => ({ rem, i })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; leftover > 0; k += 1, leftover -= 1) shares[order[k].i] += 1;
  return shares;
};

// lines: ACTIVE lines only (caller filters), each
//   { unitPrice, qty, lineDiscount?, taxPctMilli? }  — paise / milli-percent.
// discount: null | { type: 'FLAT', value: paise } | { type: 'PERCENT', value: pctMilli }.
// promoFlatPaise: already-computed promotion benefit (VC-102), folded into the
// same discountAmount and distributed identically — one calculation covers
// manual and automatic discounts. Caller clamps combined ≤ subtotal.
// Validation (caps, FLAT ≤ subtotal, PERCENT ≤ 100%) happens in the routes.
export const computeOrderTotals = (lines, discount = null, promoFlatPaise = 0) => {
  const withSubtotals = lines.map((l) => {
    assertInt(l.qty, 'qty');
    const gross = assertInt(l.unitPrice, 'unitPrice') * l.qty;
    const lineDiscount = assertInt(l.lineDiscount ?? 0, 'lineDiscount');
    return { ...l, gross, lineDiscount, lineSubtotal: gross - lineDiscount };
  });
  const subtotal = withSubtotals.reduce((a, l) => a + l.lineSubtotal, 0);
  let discountAmount = 0;
  if (discount && subtotal > 0) {
    discountAmount = discount.type === 'FLAT'
      ? assertInt(discount.value, 'discount value')
      : percentOf(subtotal, discount.value);
  }
  if (subtotal > 0) {
    discountAmount = Math.min(subtotal, discountAmount + assertInt(promoFlatPaise, 'promoFlatPaise'));
  }
  const shares = distributeProportional(discountAmount, withSubtotals.map((l) => l.lineSubtotal));
  const outLines = withSubtotals.map((l, i) => {
    const discountShare = shares[i];
    const taxable = l.lineSubtotal - discountShare;
    const lineTax = l.taxPctMilli ? percentOf(taxable, l.taxPctMilli) : 0;
    return { ...l, discountShare, taxable, lineTax, lineTotal: taxable + lineTax };
  });
  const taxAmount = outLines.reduce((a, l) => a + l.lineTax, 0);
  return {
    subtotal,
    discountAmount,
    taxAmount,
    total: subtotal - discountAmount + taxAmount,
    lines: outLines,
  };
};
