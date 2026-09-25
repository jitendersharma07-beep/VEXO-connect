// Server-side authorisation for every inventory route.
//
// Two independent questions, asked in this order and never merged:
//
//   ACTION — may this role do this kind of thing at all? One exported map,
//            below, so the answer for "who can post a GRN" is in one place
//            and a reviewer can read the whole policy in thirty seconds.
//   SCOPE  — may this principal do it HERE, at this location? Answered from
//            the company, the branch pin and the explicit location grants.
//
// Both are enforced on the server for every request including direct API
// calls. The portal hides what a user cannot do, but hiding is a courtesy;
// the check below is the control.
//
// INTEGRATION(foundation): when the permission foundation lands it consumes
// INVENTORY_ACTIONS as the action half of its action/scope model. Until then
// these are role lists, checked with the same requireRole semantics the rest
// of the product uses.

import { forbidden, notFound, unauthorized } from '../errors.js';

export const MODULE_KEY = 'INVENTORY';

const OWNER = 'CUSTOMER_OWNER';
const MANAGER = 'BRANCH_MANAGER';

// POS_SUPER_ADMIN appears nowhere in this map on purpose. A VEXO operator
// repairs licences and looks after tenants; they do not approve a customer's
// purchase orders or write off a customer's stock, and a support login that
// can silently adjust a restaurant's inventory is a liability, not a feature.
//
// CASHIER appears nowhere either. A sale consumes stock through the billing
// hook, which runs as the system on the back of an order the cashier is
// already entitled to bill — it is not an inventory right and must not become
// one, or the till gains the ability to edit what it is selling.
export const INVENTORY_ACTIONS = Object.freeze({
  'inventory.view': [OWNER, MANAGER],
  'inventory.location.manage': [OWNER],
  'inventory.location.grant': [OWNER],
  'inventory.item.manage': [OWNER],
  'inventory.unit.manage': [OWNER],
  'inventory.supplier.manage': [OWNER],

  'inventory.batch.view': [OWNER, MANAGER],
  // Quarantine and recall are containment actions: a manager who finds a bad
  // crate must be able to stop it leaving the building without waiting for
  // the owner to wake up. Releasing it back to AVAILABLE is owner-only.
  'inventory.batch.quarantine': [OWNER, MANAGER],
  'inventory.batch.release': [OWNER],
  'inventory.batch.open': [OWNER, MANAGER],

  'inventory.po.manage': [OWNER, MANAGER],
  'inventory.po.approve': [OWNER],
  'inventory.grn.post': [OWNER, MANAGER],
  // Stock arriving with no purchase order behind it. Allowed, because it
  // genuinely happens, but owner-only and it always demands a written reason.
  'inventory.receipt.direct': [OWNER],

  'inventory.request.create': [OWNER, MANAGER],
  'inventory.request.approve': [OWNER, MANAGER],
  'inventory.request.cancel': [OWNER, MANAGER],
  'inventory.request.close': [OWNER, MANAGER],
  'inventory.issue.resolve': [OWNER, MANAGER],

  'inventory.transfer.dispatch': [OWNER, MANAGER],
  'inventory.transfer.receive': [OWNER, MANAGER],

  // A store manager reads the plan that governs their own store and the
  // suggestions it produces; only the owner changes the numbers in it.
  'inventory.plan.view': [OWNER, MANAGER],
  'inventory.plan.manage': [OWNER],
  'inventory.plan.run': [OWNER, MANAGER],
  'inventory.reminder.view': [OWNER, MANAGER],
  'inventory.reminder.acknowledge': [OWNER, MANAGER],

  // A recipe decides what every sale takes off the shelf, so editing one is
  // editing the cost of every future bill. Owner-only to write; a manager
  // reads it because they are the one who has to explain the variance.
  'inventory.recipe.view': [OWNER, MANAGER],
  'inventory.recipe.manage': [OWNER],

  // A production run is a kitchen operation, not a financial one: the person
  // who makes the paneer records making it. It creates no value — the inputs'
  // value moves to the output — so it needs no second signature the way a
  // count adjustment does.
  'inventory.production.post': [OWNER, MANAGER],

  'inventory.count.create': [OWNER, MANAGER],
  // Never the same person who submitted it — enforced separately in the
  // route, because a role list cannot express "not you".
  'inventory.count.approve': [OWNER],
  'inventory.wastage.post': [OWNER, MANAGER],
  'inventory.adjustment.post': [OWNER, MANAGER],
  'inventory.adjustment.approve': [OWNER],

  'inventory.ledger.view': [OWNER, MANAGER],
  'inventory.ledger.rebuild': [OWNER],
  'inventory.report.view': [OWNER, MANAGER],
  'inventory.sale.return': [OWNER, MANAGER],
});

export const rolesFor = (action) => {
  const roles = INVENTORY_ACTIONS[action];
  if (!roles) throw new Error(`Unknown inventory action: ${action}`);
  return roles;
};

// ENTITLEMENT(INVENTORY)
export const requireInventoryAction = (action) => {
  const roles = rolesFor(action);
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden('Your role cannot perform this inventory action'));
    }
    return next();
  };
};

const SCOPE_FLAG = {
  dispatch: 'canDispatch',
  receive: 'canReceive',
  approve: 'canApprove',
  view: null,
};

// Loads a location and proves the caller may act on it.
//
// A location in another company answers exactly like one that does not exist,
// so probing ids across tenants learns nothing — the same rule
// requireBranchAccess already applies to branches.
export const loadLocationInScope = async (prisma, req, locationId, need = 'view') => {
  const location = await prisma.inventoryLocation.findUnique({ where: { id: locationId } });
  if (!location || location.companyId !== req.companyScope.id) throw notFound('Location not found');

  if (req.user.role === OWNER) return location;

  const grant = await prisma.inventoryLocationAccess.findUnique({
    where: { userId_locationId: { userId: req.user.id, locationId: location.id } },
  });

  // A branch-pinned manager reaches their own branch's locations without a
  // grant, and anything else — a warehouse, another branch's store room —
  // only through one.
  const ownBranch = location.branchId && location.branchId === req.user.branchId;
  if (!ownBranch && !grant) throw notFound('Location not found');

  const flag = SCOPE_FLAG[need];
  if (flag && !ownBranch && !grant?.[flag]) {
    throw forbidden(`You are not authorised to ${need} at ${location.name}`);
  }
  if (flag && ownBranch && grant && grant[flag] === false) {
    // An explicit grant row that says false is a deliberate withdrawal of a
    // right the branch pin would otherwise imply. Honour it.
    throw forbidden(`You are not authorised to ${need} at ${location.name}`);
  }
  return location;
};

// Every location the caller may see, as a `where` fragment. Used by the list
// endpoints so an out-of-scope location never appears in a response the
// client then has to be trusted to filter.
export const locationScopeFilter = async (prisma, req) => {
  if (req.user.role === OWNER) return { companyId: req.companyScope.id };
  const grants = await prisma.inventoryLocationAccess.findMany({
    where: { userId: req.user.id },
    select: { locationId: true },
  });
  const ids = grants.map((g) => g.locationId);
  const or = [];
  if (req.user.branchId) or.push({ branchId: req.user.branchId });
  if (ids.length) or.push({ id: { in: ids } });
  if (!or.length) return { companyId: req.companyScope.id, id: '__none__' };
  return { companyId: req.companyScope.id, OR: or };
};

export const canActAt = async (prisma, req, locationId, need) => {
  try {
    await loadLocationInScope(prisma, req, locationId, need);
    return true;
  } catch {
    return false;
  }
};
