// VC-104 Central phone-order centre — shared rules.
//
// Everything in this file answers one of three questions: may this caller do
// this, may this store take this order, and what does the caller owe. Nothing
// here writes order money — recomputeOrder() in lib/orders.js stays the single
// evaluator, and the delivery charge deliberately never reaches it (see the
// quote builder at the bottom, and docs/VC104-API-CONTRACT.md §12).

import { IST_OFFSET_MS } from './orders.js';
import { toPaise, toRupees } from './money.js';

// --- entitlement -------------------------------------------------------------

// ENTITLEMENT(PHONE_ORDERS)
export const MODULE_KEY = 'PHONE_ORDERS';
// Central routing to a store other than the operator's own is the Enterprise
// half of this module.
export const HQ_ROUTING_KEY = 'HQ_ROUTING';

// INTEGRATION(firstlogin): requireModule(key) belongs to that lane. Until it
// exists there is no module/tier entitlement to read — LicensePlan is only
// FREE_TRIAL | SINGLE_STORE | MULTI_STORE — so cross-store routing is gated on
// the honest proxy: central routing is inherently multi-store. Replace this
// with requireModule(HQ_ROUTING_KEY) and delete the plan check.
export const hqRoutingEntitled = (license) => license?.plan === 'MULTI_STORE';

// --- permissions -------------------------------------------------------------

// ONE map, so integration can graft these onto the foundation permission
// matrix mechanically instead of re-deriving them from route handlers.
// Scope mirrors lib/permissions.js: COMPANY = tenant-wide, STORE = needs a
// specific store the caller's scope contains.
export const PHONE_ORDER_ACTIONS = Object.freeze({
  'phone.customer.read': { scope: 'COMPANY', roles: ['CUSTOMER_OWNER', 'BRANCH_MANAGER'] },
  'phone.customer.write': { scope: 'COMPANY', roles: ['CUSTOMER_OWNER', 'BRANCH_MANAGER'] },
  'phone.order.read': { scope: 'COMPANY', roles: ['CUSTOMER_OWNER', 'BRANCH_MANAGER'] },
  'phone.order.create': { scope: 'COMPANY', roles: ['CUSTOMER_OWNER', 'BRANCH_MANAGER'] },
  'phone.order.accept': { scope: 'STORE', roles: ['CUSTOMER_OWNER', 'BRANCH_MANAGER'] },
  'phone.order.reassign': { scope: 'COMPANY', roles: ['CUSTOMER_OWNER'] },
});

export const rolesFor = (action) => PHONE_ORDER_ACTIONS[action].roles;

// A branch-pinned principal may only ever act on its own store; the check
// itself is middleware/auth.js's isBranchPinned, reused rather than restated.
// POS_SUPER_ADMIN is excluded from every action above on purpose: it repairs
// licences, it does not take orders for a tenant.

// --- opening hours -----------------------------------------------------------

// Minutes since midnight IST, and the IST weekday, for an instant. The business
// day this product runs on is IST everywhere else (istDateOf), so hours are too.
export const istParts = (when) => {
  const shifted = new Date(when.getTime() + IST_OFFSET_MS);
  return {
    dayOfWeek: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
};

// A store with no configured hours is treated as OPEN. The alternative — a
// silent closure the owner never asked for — would make every store
// unserviceable the moment this feature ships, which is a worse default than
// trusting the existing Branch.status.
export const isOpenAt = (hoursRows, when) => {
  if (!hoursRows || hoursRows.length === 0) return true;
  const { dayOfWeek, minute } = istParts(when);

  const today = hoursRows.find((h) => h.dayOfWeek === dayOfWeek);
  if (today && !today.closed && withinRow(today, minute)) return true;

  // A store trading past midnight is stored as closesMinute > 1440 on the day
  // it OPENED, so 00:30 has to be tested against yesterday's row as well.
  const yesterday = hoursRows.find((h) => h.dayOfWeek === (dayOfWeek + 6) % 7);
  if (yesterday && !yesterday.closed && withinRow(yesterday, minute + 1440)) return true;

  return false;
};

const withinRow = (row, minute) => minute >= row.opensMinute && minute < row.closesMinute;

const pad2 = (n) => String(n).padStart(2, '0');
export const clockOf = (minute) => `${pad2(Math.floor((minute % 1440) / 60))}:${pad2(minute % 60)}`;

// --- preparation capacity ----------------------------------------------------

// Slots are a fixed grid floored on the UNIX EPOCH, not on local midnight, and
// they are half-open: [start, end). An instant exactly on a boundary belongs to
// the later slot, which is what stops two adjacent slots both claiming it.
//
// TIMEZONE. The arithmetic is on epoch milliseconds, so the answer does not
// depend on the server's timezone — but whether a slot boundary lands on a
// round IST wall-clock time does. IST is UTC+05:30, i.e. 330 minutes, so a slot
// size S lines up with the IST clock exactly when 330 % S === 0. That holds for
// 5, 10, 15 and 30; it fails for 60, where "the 10 o'clock hour" is really
// 09:30–10:30 IST. slotMinutes defaults to 15, so every store configured today
// is IST-aligned and nothing has ever shown this. Pinned as current behaviour,
// deliberately not changed: whether a kitchen's "hour" should follow the IST
// clock is an owner's question, not one to settle from inside a capacity fix.
export const slotBoundsFor = (when, slotMinutes) => {
  const size = slotMinutes * 60000;
  const start = new Date(Math.floor(when.getTime() / size) * size);
  return { start, end: new Date(start.getTime() + size) };
};

// THE CAPACITY RULE. An order occupies the slot in which the store that
// currently holds it was asked to produce it. Capacity models kitchen
// throughput, so the question is always "when did work arrive at THIS store",
// never "when did the customer telephone".
//
//   SCHEDULED (scheduledFor set) -> the slot containing scheduledFor. A move
//     does not change it: the food is still due at the same time.
//   ASAP submitted here          -> the slot containing createdAt.
//   ASAP moved in                -> the slot containing THE MOVE, because that
//     is the moment this kitchen was asked. Its createdAt belongs to the call,
//     which may be hours old and was answered at another store.
//
// The third arm is the one that was missing, and it is what let a back-dated
// transfer land in a store while occupying a slot in the past (D-2's late
// transfer hole: measured at cap 2, three late transfers left four live orders
// reporting booked = 1, available = true).
//
// NO NEW COLUMN IS NEEDED, and that is the whole reason this is a read change.
// The move time is already persisted: every reassign writes a PhoneOrderEvent
// with action REASSIGNED, toBranchId and at, in the SAME transaction as the
// phoneOrder.update, so it cannot be absent for a moved order. Re-stamping
// createdAt or scheduledFor was the alternative and both are destructive —
// createdAt is "when the customer called", and Boolean(scheduledFor) is the
// only source of truth for whether an order is scheduled at all.
//
// A -> B -> A is handled by taking the LATEST reassign into the current branch.
const SLOT_ANCHOR = `
  COALESCE(
    po."scheduledFor",
    (SELECT max(e."at")
       FROM "PhoneOrderEvent" e
      WHERE e."phoneOrderId" = po.id
        AND e.action = 'REASSIGNED'
        AND e."toBranchId" = po."routedBranchId"),
    po."createdAt")`;

// Raw SQL rather than prisma.phoneOrder.count because the anchor is a
// correlated subquery, which the query builder cannot express. Takes a client
// so that one counting rule serves both the read path (prisma) and the re-check
// inside a transaction (tx) — two counting rules would be exactly the drift
// that caused this defect.
export const countBookedInSlot = async (client, { companyId, branchId, start, end }) => {
  const rows = await client.$queryRawUnsafe(
    `SELECT count(*)::int AS n
       FROM "PhoneOrder" po
       CROSS JOIN LATERAL (SELECT ${SLOT_ANCHOR} AS anchor) a
      WHERE po."companyId" = $1
        AND po."routedBranchId" = $2
        AND po.status IN ('SUBMITTED','ACCEPTED')
        AND a.anchor >= $3
        AND a.anchor < $4`,
    companyId,
    branchId,
    start,
    end,
  );
  return rows[0].n;
};

// Advisory-lock namespace for "one (store, slot) at a time". MUST stay non-zero:
// tests/globalSetup.js holds the single-argument form, which Postgres records as
// classid = 0, so any non-zero namespace here is disjoint from it by
// construction rather than by having picked a different number.
const SLOT_LOCK_NS = 5653849;

// Serializes check-and-reserve for one store's slot.
//
// Without this the guard is advisory only: a plain SELECT count(*) at READ
// COMMITTED does not block a concurrent insert or move, so two callers taking
// the last free place both read booked = n-1 and both commit. Taking the lock
// before counting makes the count and the write that follows it atomic with
// respect to any other caller aiming at the same (store, slot).
//
// pg_advisory_XACT_lock, not the session form: it releases on COMMIT or
// ROLLBACK, so a refused transfer or a crashed request cannot wedge a store.
// It is also why the capacity check must come FIRST in the transaction and the
// transaction must stay short — every other caller for that slot waits behind
// it.
//
// hashtext() collisions are possible in int4. The consequence is that two
// unrelated slots serialize against each other: a small loss of concurrency,
// never a wrong answer.
export const lockSlot = async (tx, { companyId, branchId, start }) => {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)`,
    SLOT_LOCK_NS,
    `${companyId}:${branchId}:${start.toISOString()}`,
  );
};

// --- unavailability ----------------------------------------------------------

// Closed set. The UI keys its copy off these, so adding one is a contract
// change (docs/VC104-API-CONTRACT.md §5.6).
export const REASON = Object.freeze({
  NOT_SERVICEABLE: 'NOT_SERVICEABLE',
  CLOSED_AT_FULFILMENT: 'CLOSED_AT_FULFILMENT',
  AT_CAPACITY: 'AT_CAPACITY',
  MENU_UNAVAILABLE: 'MENU_UNAVAILABLE',
  BELOW_MIN_ORDER: 'BELOW_MIN_ORDER',
  BRANCH_INACTIVE: 'BRANCH_INACTIVE',
  NOT_ENTITLED: 'NOT_ENTITLED',
});

const reason = (code, message) => ({ code, message });

// One phrasing of "full", used by the advisory read in evaluateBranches AND by
// the binding re-check inside the submit/reassign transactions. A caller
// refused by the transaction must get the same code and the same sentence as
// one refused by the screen, or the race looks like a different defect.
export const capacityReason = (booked, maxOrdersPerSlot) =>
  reason(REASON.AT_CAPACITY, `Kitchen is full for that time (${booked}/${maxOrdersPerSlot})`);

// --- the quote ---------------------------------------------------------------

// C-6 is open: nobody has established who supplies the delivery or whether the
// charge is separate consideration. Until that is answered the charge is
// QUOTED beside the order and never folded into it — the only position that can
// still move to either answer, and the only one that cannot poison an immutable
// invoice. docs/VC104-API-CONTRACT.md §12 states what closing C-6 requires.
export const DELIVERY_CHARGE_BILLABLE = false;

export const buildQuote = (order, deliveryChargeRupees) => {
  const orderPaise = toPaise(String(order.total));
  const deliveryPaise = toPaise(String(deliveryChargeRupees ?? 0));
  return {
    order: {
      id: order.id,
      status: order.status,
      subtotal: Number(order.subtotal),
      taxAmount: Number(order.taxAmount),
      total: Number(order.total),
      invoiceNumber: order.invoiceNumber ?? null,
    },
    deliveryCharge: toRupees(deliveryPaise),
    deliveryChargeBillable: DELIVERY_CHARGE_BILLABLE,
    // What the operator reads to the caller. A quote, not a bill: while the
    // charge is not billable no invoice may present it as the restaurant's
    // supply, so this number exists only on this API and never in Order.
    payableQuote: toRupees(orderPaise + deliveryPaise),
  };
};

// --- branch evaluation -------------------------------------------------------

/**
 * Scores every store in the tenant and says, per store, whether it can take
 * this order and why not. Every candidate is returned — the operator has to be
 * able to tell the caller WHY the nearest store cannot help, which a filtered
 * list cannot do.
 */
export const evaluateBranches = ({
  branches,
  serviceAreas,
  hoursByBranch,
  capacityByBranch,
  bookedByBranch,
  fulfilment,
  pincode,
  when,
  basketPaise,
  unavailableProductNames,
  operatorBranchId,
  hqEntitled,
}) =>
  branches.map((branch) => {
    const reasons = [];

    if (branch.status !== 'ACTIVE') {
      reasons.push(reason(REASON.BRANCH_INACTIVE, `${branch.name} is not an active store`));
    }

    // Entitlement is evaluated per candidate, not once for the request: on a
    // single-store licence the operator's OWN store stays usable, and only the
    // others are refused. Refusing the whole call would disable phone orders
    // for every single-store tenant.
    if (!hqEntitled && operatorBranchId && branch.id !== operatorBranchId) {
      reasons.push(
        reason(REASON.NOT_ENTITLED, 'Central routing to another store needs a multi-store licence'),
      );
    }

    const area = serviceAreas.find((a) => a.branchId === branch.id && a.pincode === pincode);
    let deliveryCharge = null;
    let minOrder = null;

    if (fulfilment === 'DELIVERY') {
      if (!area || !area.active) {
        reasons.push(reason(REASON.NOT_SERVICEABLE, `Does not deliver to ${pincode}`));
      } else {
        deliveryCharge = Number(area.deliveryCharge);
        minOrder = area.minOrder === null ? null : Number(area.minOrder);
        if (minOrder !== null && basketPaise !== null && basketPaise < toPaise(String(minOrder))) {
          reasons.push(
            reason(REASON.BELOW_MIN_ORDER, `Minimum order for delivery here is ₹${minOrder.toFixed(2)}`),
          );
        }
      }
    }

    const hours = hoursByBranch.get(branch.id) ?? [];
    const open = isOpenAt(hours, when);
    if (!open) {
      reasons.push(reason(REASON.CLOSED_AT_FULFILMENT, closedMessage(hours, when)));
    }

    const cap = capacityByBranch.get(branch.id) ?? null;
    const booked = bookedByBranch.get(branch.id) ?? 0;
    if (cap && booked >= cap.maxOrdersPerSlot) {
      reasons.push(capacityReason(booked, cap.maxOrdersPerSlot));
    }

    if (unavailableProductNames.length > 0) {
      reasons.push(
        reason(REASON.MENU_UNAVAILABLE, `Not on the menu: ${unavailableProductNames.join(', ')}`),
      );
    }

    return {
      branchId: branch.id,
      branchName: branch.name,
      branchCode: branch.code ?? null,
      available: reasons.length === 0,
      deliveryCharge,
      minOrder,
      hours: hoursSummary(hours, when, open),
      capacity: cap
        ? { slotMinutes: cap.slotMinutes, maxOrdersPerSlot: cap.maxOrdersPerSlot, booked }
        : null,
      unavailableReasons: reasons,
    };
  });

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const closedMessage = (hours, when) => {
  const { dayOfWeek, minute } = istParts(when);
  const row = hours.find((h) => h.dayOfWeek === dayOfWeek);
  if (!row || row.closed) return `Closed on ${dayNames[dayOfWeek]}`;
  return `Closed at ${clockOf(minute)} on ${dayNames[dayOfWeek]}`;
};

const hoursSummary = (hours, when, open) => {
  const { dayOfWeek } = istParts(when);
  const row = hours.find((h) => h.dayOfWeek === dayOfWeek);
  if (!row) return { opensAt: null, closesAt: null, openAtFulfilment: open };
  return {
    opensAt: row.closed ? null : clockOf(row.opensMinute),
    closesAt: row.closed ? null : clockOf(row.closesMinute),
    openAtFulfilment: open,
  };
};
