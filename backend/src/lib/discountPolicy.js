// Discount authority — the single place that decides whether a discount is
// allowed, and on whose say-so.
//
// Four rules, and every route that can move a discount goes through them:
//
//   1. PERMISSION. Introducing or increasing a discount needs the flag for
//      that kind (line or order). Merely editing an order that already
//      carries one does not.
//   2. CEILING. After the change, the COMBINED discount — every line
//      discount plus the order-level discount — must sit inside the actor's
//      resolved ceiling. Exception: a change that increases neither the cash
//      amount nor the percentage always passes, so anybody may clean up a
//      discount they are not allowed to grant.
//   3. APPROVAL. A refusal under 1 or 2 can be lifted by a named approver who
//      authenticates with their OWN password, is in scope for the order's
//      branch, and whose own delegated approval ceiling covers the result.
//   4. RECORD. The order keeps who approved it, when, and why.
//
// Why COMBINED, and not each kind separately: the two discounts compose.
// money.js computes subtotal = Σ(gross − lineDiscount) and then applies the
// order discount to THAT. So 50% off every line under a 50% order discount is
// 75% off the bill, and a rule that looked at either number alone would have
// called it two legal 50%s. Everything here measures one figure — the total
// amount taken off — against the gross the customer would otherwise pay.
//
// There is no number in this file that says how much a cashier may discount.
// The ceilings are rows in DiscountPolicy, written by the customer's own
// admin. What IS here is the floor that applies when nothing has been
// configured: nobody may discount, except the company's owner, who is already
// the tenant's unlimited principal everywhere else in this product and is the
// person who grants the permissions in the first place.

import { pctToMilli } from './money.js';

export const DISCOUNT_POLICY_FIELDS = [
  'allowLineDiscount',
  'allowOrderDiscount',
  'maxPercent',
  'maxFlatPaise',
  'canApprove',
  'maxApprovalPercent',
  'maxApprovalFlatPaise',
];

// 'company' | 'branch:<id>' | 'user:<id>' — see the migration for why a
// nullable column pair could not carry this uniquely.
export const scopeKeyFor = ({ level, branchId, userId }) => {
  if (level === 'COMPANY') return 'company';
  if (level === 'BRANCH') return `branch:${branchId}`;
  if (level === 'USER') return `user:${userId}`;
  throw new Error(`unknown discount policy level: ${level}`);
};

// Applied last, to whatever the stored rows left unanswered. A null ceiling
// on a resolved policy means "no ceiling", which only ever matters where the
// matching allow flag is true.
const DENY = {
  allowLineDiscount: false,
  allowOrderDiscount: false,
  maxPctMilli: 0,
  maxFlatPaise: 0,
  canApprove: false,
  maxApprovalPctMilli: 0,
  maxApprovalFlatPaise: 0,
};

const UNLIMITED = {
  allowLineDiscount: true,
  allowOrderDiscount: true,
  maxPctMilli: null,
  maxFlatPaise: null,
  canApprove: true,
  maxApprovalPctMilli: null,
  maxApprovalFlatPaise: null,
};

export const ROLE_FLOOR = {
  // ATC operators are read-only on orders anyway; saying so here as well
  // means the resolver never hands them an authority the routes then refuse.
  POS_SUPER_ADMIN: DENY,
  // The tenant's own owner. Narrowable — an explicit COMPANY or USER row for
  // them wins over this — but not something they have to grant themselves
  // before the product will discount anything at all.
  CUSTOMER_OWNER: UNLIMITED,
  BRANCH_MANAGER: DENY,
  CASHIER: DENY,
};

const milliOf = (decimalOrNull) =>
  decimalOrNull === null || decimalOrNull === undefined ? null : pctToMilli(String(decimalOrNull));

// Most-specific-first, field by field: a USER row overrides a BRANCH row
// overrides the COMPANY default. Null in a stored row means "inherit", which
// is why this merges per field rather than picking one winning row — a branch
// that only raises the cash cap should not silently drop the company's
// percentage cap.
const mergeField = (rows, field) => {
  for (const row of rows) {
    const v = row?.[field];
    if (v !== null && v !== undefined) return v;
  }
  return null;
};

// The two ceilings on a discount are one decision, so they resolve together.
// If the admin wrote either of them, the one they left blank means "no limit
// from this side" — NOT the deny floor's zero. Falling back per field would
// turn "cashiers may give 10%" into a 10%-and-also-zero-rupees ceiling: an
// explicit grant that refuses everything, and reports a ₹0.00 limit nobody
// typed. The floor still applies in full when the admin has written neither,
// which is the un-configured state deny-by-default exists for.
const pickCeilingPair = (rows, pctField, flatField, floorPct, floorFlat) => {
  const pct = mergeField(rows, pctField);
  const flat = mergeField(rows, flatField);
  if (pct === null && flat === null) return [floorPct, floorFlat];
  return [pct === null ? null : milliOf(pct), flat];
};

export const mergeDiscountPolicyRows = (rows, role) => {
  const floor = ROLE_FLOOR[role] ?? DENY;
  const pick = (field, floorValue) => {
    const v = mergeField(rows, field);
    return v === null ? floorValue : v;
  };
  const [maxPctMilli, maxFlatPaise] = pickCeilingPair(
    rows,
    'maxPercent',
    'maxFlatPaise',
    floor.maxPctMilli,
    floor.maxFlatPaise,
  );
  const [maxApprovalPctMilli, maxApprovalFlatPaise] = pickCeilingPair(
    rows,
    'maxApprovalPercent',
    'maxApprovalFlatPaise',
    floor.maxApprovalPctMilli,
    floor.maxApprovalFlatPaise,
  );
  return {
    allowLineDiscount: pick('allowLineDiscount', floor.allowLineDiscount),
    allowOrderDiscount: pick('allowOrderDiscount', floor.allowOrderDiscount),
    maxPctMilli,
    maxFlatPaise,
    canApprove: pick('canApprove', floor.canApprove),
    maxApprovalPctMilli,
    maxApprovalFlatPaise,
  };
};

// Reads the three candidate rows in one query. `branchId` is the branch the
// discount is being taken on — for a branch-pinned user that is their own
// branch, but an owner working across branches picks up that branch's
// override, which is the point of having branch overrides at all.
export const resolveDiscountPolicy = async (db, { companyId, userId, role, branchId }) => {
  const keys = ['company'];
  if (branchId) keys.push(`branch:${branchId}`);
  if (userId) keys.push(`user:${userId}`);

  const rows = await db.discountPolicy.findMany({
    where: { companyId, scopeKey: { in: keys } },
  });
  const byKey = new Map(rows.map((r) => [r.scopeKey, r]));
  const ordered = [
    userId ? byKey.get(`user:${userId}`) : null,
    branchId ? byKey.get(`branch:${branchId}`) : null,
    byKey.get('company'),
  ].filter(Boolean);

  return {
    ...mergeDiscountPolicyRows(ordered, role),
    // Which levels actually contributed, so the settings screen can say
    // "inherited from the company default" instead of showing a blank.
    sources: ordered.map((r) => r.level),
  };
};

// --- what a discount actually costs -----------------------------------------

// lines: ACTIVE lines only, in paise — { unitPrice, qty, lineDiscount }.
// discount: null | { type:'FLAT', value: paise } | { type:'PERCENT', value: pctMilli }
//
// Mirrors money.js and lib/orders.js exactly, including the FLAT clamp to the
// subtotal, so the figure a limit is checked against is the figure that will
// be charged — not a second, slightly different sum computed here.
export const exposureOf = (lines, discount = null) => {
  let grossPaise = 0;
  let lineDiscountPaise = 0;
  for (const l of lines) {
    grossPaise += l.unitPrice * l.qty;
    lineDiscountPaise += l.lineDiscount ?? 0;
  }
  const subtotalPaise = grossPaise - lineDiscountPaise;

  let orderDiscountPaise = 0;
  if (discount && subtotalPaise > 0) {
    orderDiscountPaise =
      discount.type === 'FLAT'
        ? Math.min(discount.value, subtotalPaise)
        : // percentOf, inlined to avoid importing a rounding rule that could
          // drift from money.js: round-half-up(base × pct / 100), pct in milli.
          Math.floor((subtotalPaise * discount.value + 50000) / 100000);
  }

  const combinedPaise = lineDiscountPaise + orderDiscountPaise;
  return { grossPaise, lineDiscountPaise, subtotalPaise, orderDiscountPaise, combinedPaise };
};

// combined/gross × 100 ≤ maxPercent, without ever dividing. BigInt because a
// large order times 1e5 leaves the safe-integer range, the same reason
// distributeProportional uses it.
const withinPercent = (combinedPaise, grossPaise, maxPctMilli) => {
  if (maxPctMilli === null) return true;
  if (grossPaise <= 0) return combinedPaise <= 0;
  return BigInt(combinedPaise) * 100000n <= BigInt(maxPctMilli) * BigInt(grossPaise);
};

// The percentage a combined discount represents, in milli-percent, for
// messages and audit rows. Rounded half-up. BigInt for the same reason as
// above — this is also the figure that ends up in an audit row, and a silently
// wrong number there is worse than no number. Never used for a limit
// decision: those compare by cross-multiplication and never divide.
export const combinedPctMilli = (combinedPaise, grossPaise) => {
  if (grossPaise <= 0) return 0;
  const g = BigInt(grossPaise);
  return Number((BigInt(combinedPaise) * 100000n + g / 2n) / g);
};

// Returns null when the exposure fits, or the breach that stopped it.
export const ceilingBreach = (exposure, { maxPctMilli, maxFlatPaise }) => {
  const { combinedPaise, grossPaise } = exposure;
  if (combinedPaise <= 0) return null;
  if (!withinPercent(combinedPaise, grossPaise, maxPctMilli)) {
    return {
      kind: 'PERCENT',
      limitPctMilli: maxPctMilli,
      actualPctMilli: combinedPctMilli(combinedPaise, grossPaise),
      actualPaise: combinedPaise,
    };
  }
  if (maxFlatPaise !== null && combinedPaise > maxFlatPaise) {
    return {
      kind: 'FLAT',
      limitPaise: maxFlatPaise,
      actualPaise: combinedPaise,
      actualPctMilli: combinedPctMilli(combinedPaise, grossPaise),
    };
  }
  return null;
};

// Did the discount grow as a SHARE of the bill? Cross-multiplied rather than
// comparing two rounded percentages: at three decimal places two different
// fractions round to the same figure, and the comparison would then wave
// through a discount that really did grow.
export const shareWorsened = (before, after) => {
  if (after.combinedPaise <= 0) return false;
  if (after.grossPaise <= 0) return true;
  if (before.combinedPaise <= 0) return true;
  if (before.grossPaise <= 0) return false;
  return (
    BigInt(after.combinedPaise) * BigInt(before.grossPaise) >
    BigInt(before.combinedPaise) * BigInt(after.grossPaise)
  );
};

// Did it grow in cash?
export const cashWorsened = (before, after) => after.combinedPaise > before.combinedPaise;

// --- the decision ------------------------------------------------------------

// shape: which kinds of discount this request is introducing or increasing.
// Derived from before/after by the caller, because only the caller knows
// which field it touched.
//
// A ceiling only refuses a change that makes ITS OWN measure worse. That
// distinction matters at the counter: an order a manager approved 30% on is
// already past a cashier's 10% ceiling, and the cashier still has to be able
// to add the customer's second coffee to it. Adding an item leaves the share
// at 30%, so the percentage ceiling has nothing to say; voiding half the
// order under a fixed ₹100 discount pushes the share to 50%, and that it does
// refuse. Same rule the other way round for a cash ceiling, which is there to
// bound rupees and so watches the rupees.
//
// Returns { ok: true } or { ok: false, breach } where breach carries enough
// for both an honest counter-side message and an audit row.
export const authorizeDiscount = ({ policy, before, after, shape }) => {
  if (shape.raisesLineDiscount && !policy.allowLineDiscount) {
    return { ok: false, breach: { kind: 'LINE_NOT_ALLOWED' } };
  }
  if (shape.raisesOrderDiscount && !policy.allowOrderDiscount) {
    return { ok: false, breach: { kind: 'ORDER_NOT_ALLOWED' } };
  }
  const breach = ceilingBreach(after, policy);
  if (!breach) return { ok: true };
  const worsened = breach.kind === 'FLAT' ? cashWorsened(before, after) : shareWorsened(before, after);
  return worsened ? { ok: false, breach } : { ok: true };
};

// An approver is judged on canApprove plus their own approval ceiling. The
// allow flags are not consulted: granting authority and exercising it at the
// till are different things, and a manager who never touches a keyboard
// should still be able to authorise a cashier's discount.
export const authorizeApproval = ({ policy, after }) => {
  if (!policy.canApprove) return { ok: false, breach: { kind: 'APPROVER_NOT_PERMITTED' } };
  const breach = ceilingBreach(after, {
    maxPctMilli: policy.maxApprovalPctMilli,
    maxFlatPaise: policy.maxApprovalFlatPaise,
  });
  if (breach) return { ok: false, breach: { ...breach, kind: `APPROVER_OVER_${breach.kind}` } };
  return { ok: true };
};

// --- saying so in words ------------------------------------------------------

const rupees = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (milli) => {
  const n = milli / 1000;
  return `${Number.isInteger(n) ? n : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
};

export const describeCeiling = ({ maxPctMilli, maxFlatPaise }) => {
  if (maxPctMilli === null && maxFlatPaise === null) return 'no limit';
  if (maxPctMilli !== null && maxFlatPaise !== null) {
    return `${pct(maxPctMilli)} or ${rupees(maxFlatPaise)}, whichever is lower`;
  }
  return maxPctMilli !== null ? pct(maxPctMilli) : rupees(maxFlatPaise);
};

// Counter-side wording. Says what the limit is and what the discount came to,
// because "not permitted" alone leaves a queue standing there guessing.
export const describeBreach = (breach) => {
  switch (breach.kind) {
    case 'LINE_NOT_ALLOWED':
      return 'You are not permitted to apply item discounts. A manager can approve this one.';
    case 'ORDER_NOT_ALLOWED':
      return 'You are not permitted to apply order discounts. A manager can approve this one.';
    case 'PERCENT':
      return `That takes the total discount to ${pct(breach.actualPctMilli)} of the bill (${rupees(
        breach.actualPaise,
      )}). Your limit is ${pct(breach.limitPctMilli)}. A manager can approve it.`;
    case 'FLAT':
      return `That takes the total discount to ${rupees(breach.actualPaise)}. Your limit is ${rupees(
        breach.limitPaise,
      )}. A manager can approve it.`;
    case 'APPROVER_NOT_PERMITTED':
      return 'That account is not permitted to approve discounts.';
    case 'APPROVER_OVER_PERCENT':
      return `This discount is ${pct(breach.actualPctMilli)} of the bill. That approver may authorise up to ${pct(
        breach.limitPctMilli,
      )}.`;
    case 'APPROVER_OVER_FLAT':
      return `This discount is ${rupees(breach.actualPaise)}. That approver may authorise up to ${rupees(
        breach.limitPaise,
      )}.`;
    default:
      return 'This discount is not permitted.';
  }
};

// The slice of a breach worth keeping forever. Paise and milli-percent, not
// rendered strings, so a later report can do arithmetic on it.
export const breachForAudit = (breach) =>
  breach
    ? {
        kind: breach.kind,
        ...(breach.limitPctMilli !== undefined ? { limitPctMilli: breach.limitPctMilli } : {}),
        ...(breach.limitPaise !== undefined ? { limitPaise: breach.limitPaise } : {}),
        ...(breach.actualPctMilli !== undefined ? { actualPctMilli: breach.actualPctMilli } : {}),
        ...(breach.actualPaise !== undefined ? { actualPaise: breach.actualPaise } : {}),
      }
    : null;
