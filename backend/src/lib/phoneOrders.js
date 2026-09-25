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

export const slotBoundsFor = (when, slotMinutes) => {
  const size = slotMinutes * 60000;
  const start = new Date(Math.floor(when.getTime() / size) * size);
  return { start, end: new Date(start.getTime() + size) };
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
      reasons.push(
        reason(REASON.AT_CAPACITY, `Kitchen is full for that time (${booked}/${cap.maxOrdersPerSlot})`),
      );
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
