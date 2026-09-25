// Authorisation as ACTION + ORGANISATIONAL SCOPE.
//
// Two independent questions, both of which must answer yes:
//
//   1. May this role do this thing at all?      → the action baseline below
//   2. May it do it HERE?                       → the store scope, resolved
//                                                 from the user's pin, their
//                                                 explicit assignments or
//                                                 their region
//
// The baseline is a ceiling, not a default. A PermissionRule row can only ever
// take an action away or put back one a broader rule took away — there is no
// code path by which a rule grants an action the role never had. That is why
// "a cashier cannot grant themselves more permission" is a property of this
// file rather than a check somebody has to remember to write on every route: a
// cashier who somehow reached the rules table could write ALLOW rows all day
// and still be unable to bill a refund, because `can()` consults the ceiling
// first and the rules afterwards.
//
// THREE KINDS OF LIMIT, and telling them apart is the whole authorisation model:
//
//   1. Role ceiling (hard)      — ROLE_ACTIONS below. Nothing overrides it. No
//                                 rule at any level grants an action the role
//                                 does not hold.
//   2. Company DENY (hard)      — a COMPANY-level DENY row is the tenant saying
//                                 "not in this business, by anyone". A narrower
//                                 ALLOW does NOT lift it; see resolveRules.
//   3. Inherited default (soft) — DEFAULT_OFF below, and the plain baseline. A
//                                 rule may switch these either way, which is
//                                 what rules are FOR.
//
// The difference matters because the two read identically on a screen ("this is
// off") and behave oppositely when somebody writes a narrower ALLOW.
//
// Discount authority is deliberately absent. It already has an engine —
// DiscountPolicy, resolved COMPANY → BRANCH → USER with real money ceilings —
// and a second opinion about who may take 10% off a bill is worse than none.

// ---------------------------------------------------------------------------
// Actions
//
// Only what Phase 1 and the existing Core actually enforce. An action listed
// here is enforced somewhere; there is no aspirational entry, because a
// permission screen that offers a toggle which changes nothing is a lie told
// to whoever sets it. Future modules register through EXTENSION_POINTS.
// ---------------------------------------------------------------------------

// scope: 'PLATFORM' = outside any tenant. 'COMPANY' = tenant-wide.
// 'STORE' = needs a specific store, and the caller's scope must contain it.
const A = (key, group, label, scope) => ({ key, group, label, scope });

export const ACTIONS = Object.freeze([
  // Organisation and identity
  A('org.legalEntity.read', 'Organisation', 'View legal entities', 'COMPANY'),
  A('org.legalEntity.write', 'Organisation', 'Create and edit legal entities', 'COMPANY'),
  A('org.gst.read', 'Organisation', 'View GST registrations', 'COMPANY'),
  A('org.gst.write', 'Organisation', 'Create and edit GST registrations', 'COMPANY'),
  A('org.store.read', 'Organisation', 'View stores', 'COMPANY'),
  A('org.store.write', 'Organisation', 'Create and edit stores', 'COMPANY'),
  A('org.brand.read', 'Organisation', 'View brands', 'COMPANY'),
  A('org.brand.write', 'Organisation', 'Create and edit brands', 'COMPANY'),
  A('org.region.read', 'Organisation', 'View regions', 'COMPANY'),
  A('org.region.write', 'Organisation', 'Create and edit regions', 'COMPANY'),

  // Terminals and devices
  A('terminal.read', 'Devices', 'View tills', 'STORE'),
  A('terminal.write', 'Devices', 'Create and edit tills', 'STORE'),
  A('device.read', 'Devices', 'View devices', 'STORE'),
  A('device.enrol', 'Devices', 'Enrol a device', 'STORE'),
  A('device.activate', 'Devices', 'Issue a device credential', 'STORE'),
  A('device.revoke', 'Devices', 'Revoke a device credential', 'STORE'),

  // People and authority
  A('user.read', 'People', 'View staff accounts', 'COMPANY'),
  A('user.write', 'People', 'Create and edit staff accounts', 'COMPANY'),
  A('user.resetPassword', 'People', 'Reset a staff password', 'COMPANY'),
  A('permission.read', 'People', 'View permission rules', 'COMPANY'),
  A('permission.write', 'People', 'Change permission rules', 'COMPANY'),
  A('support.grant.read', 'People', 'View VEXO support access', 'COMPANY'),
  A('support.grant.write', 'People', 'Grant or revoke VEXO support access', 'COMPANY'),

  // Catalog and floor
  A('catalog.read', 'Catalog', 'View the menu', 'COMPANY'),
  A('catalog.write', 'Catalog', 'Edit the menu', 'COMPANY'),
  A('table.read', 'Catalog', 'View tables', 'STORE'),
  A('table.write', 'Catalog', 'Edit tables', 'STORE'),

  // Selling
  A('order.read', 'Selling', 'View orders', 'STORE'),
  A('order.create', 'Selling', 'Open an order', 'STORE'),
  A('order.item.void', 'Selling', 'Void a line', 'STORE'),
  A('order.void', 'Selling', 'Void an order', 'STORE'),
  A('order.bill', 'Selling', 'Issue a bill', 'STORE'),
  A('kot.read', 'Selling', 'View kitchen tickets', 'STORE'),
  A('payment.record', 'Selling', 'Record a payment', 'STORE'),
  A('refund.issue', 'Selling', 'Issue a refund', 'STORE'),
  A('dayclose.read', 'Selling', 'View day closes', 'STORE'),
  A('dayclose.perform', 'Selling', 'Close the day', 'STORE'),

  // Payments — LANE payments. Configuring which merchant account a store's
  // money settles into is a separate authority from taking the money: a
  // cashier collects, a manager reads the configuration, and only the tenant's
  // own administration may point the settlements somewhere else.
  A('payment.account.read', 'Payments', 'View merchant accounts', 'COMPANY'),
  A('payment.account.write', 'Payments', 'Configure merchant accounts', 'COMPANY'),

  // Drawer — LANE payments. Opening the till WITH a sale is part of taking
  // cash and belongs to whoever may record a payment; opening it WITHOUT one
  // is the interesting case and gets its own key, off by default for a
  // cashier. That is the whole reason there are two.
  A('drawer.open', 'Payments', 'Open the cash drawer with a cash sale or refund', 'STORE'),
  A('drawer.open.manual', 'Payments', 'Open the cash drawer without a sale', 'STORE'),

  // Promotions — VC-102. Four separate checks by design (spec §2): editing a
  // campaign, publishing it, applying a published offer at the till, and
  // approving a manual exception are different authorities. The fourth —
  // exception approval — already exists as DiscountPolicy.canApprove and is
  // deliberately NOT duplicated here.
  A('promo.read', 'Promotions', 'View promotions', 'COMPANY'),
  A('promo.write', 'Promotions', 'Create and edit promotions', 'COMPANY'),
  A('promo.publish', 'Promotions', 'Publish, pause or archive a promotion', 'COMPANY'),
  A('promo.apply', 'Promotions', 'Apply a published offer to an order', 'STORE'),

  // Reporting
  A('report.sales.read', 'Reports', 'Sales reports', 'COMPANY'),
  A('report.tax.read', 'Reports', 'Tax reports', 'COMPANY'),
  A('report.audit.read', 'Reports', 'Audit trail', 'COMPANY'),

  // Platform
  A('platform.tenant.manage', 'Platform', 'Manage tenants and licences', 'PLATFORM'),
]);

export const ACTION_KEYS = Object.freeze(ACTIONS.map((a) => a.key));
const ACTION_BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]));

export const actionMeta = (key) => ACTION_BY_KEY.get(key) ?? null;
export const isKnownAction = (key) => ACTION_BY_KEY.has(key);

// Modules that will add actions later. Declared so the permission screen can
// show an honest "not available yet" instead of the module silently appearing
// to be configurable — and so a future lane adds its keys in one place rather
// than inventing a parallel scheme. Nothing here is implemented; nothing here
// is enforced.
export const EXTENSION_POINTS = Object.freeze([
  { module: 'INVENTORY', prefix: 'inventory.', note: 'Stock, transfers and inventory locations — inventory lane' },
  { module: 'PURCHASE', prefix: 'purchase.', note: 'Vendors and purchase orders' },
  { module: 'KITCHEN', prefix: 'kitchen.', note: 'KDS routing and station rules — kitchen lane' },
  { module: 'DELIVERY', prefix: 'delivery.', note: 'Aggregator channels and rider handover — orders lane' },
]);

// ---------------------------------------------------------------------------
// Role baselines — the ceiling for each role
// ---------------------------------------------------------------------------

const ALL = ACTION_KEYS.filter((k) => actionMeta(k).scope !== 'PLATFORM');

// promo.apply is till work: the offer itself was authorised when the owner
// published it, so applying it needs no discount authority — the cashier still
// cannot create, edit or publish one.
// drawer.open rides with payment.record on purpose: a cashier taking notes has
// to be able to open the till to put them in, and a permission model that says
// otherwise is one the store works around by wedging the drawer open. What a
// cashier does NOT get is drawer.open.manual — opening the till with no sale
// behind it is the movement worth authorising separately.
const SELL = ['order.read', 'order.create', 'order.bill', 'kot.read', 'payment.record', 'drawer.open', 'table.read', 'catalog.read', 'promo.apply'];

const ROLE_ACTIONS = Object.freeze({
  // The platform role. Every action including the platform-only ones; what it
  // may do INSIDE a tenant is a separate question answered by scope and, for
  // the sensitive actions below, by a support grant the tenant issued.
  POS_SUPER_ADMIN: Object.freeze([...ACTION_KEYS]),

  // Owns the tenant. Everything except the platform's own controls.
  CUSTOMER_OWNER: Object.freeze([...ALL]),

  // Everything the owner can do, but the two actions that could be used to
  // become the owner are default-off until the owner switches them on.
  COMPANY_ADMIN: Object.freeze([...ALL]),

  // Money and tax across the company; sells nothing, so no order or payment
  // action at all — a Finance login cannot open a till.
  FINANCE: Object.freeze([
    'org.legalEntity.read', 'org.legalEntity.write', 'org.gst.read', 'org.gst.write',
    'org.store.read', 'org.brand.read', 'org.region.read',
    'catalog.read', 'order.read', 'dayclose.read',
    'report.sales.read', 'report.tax.read', 'report.audit.read',
    'user.read', 'permission.read', 'support.grant.read',
    'terminal.read', 'device.read', 'promo.read',
    // Reads the merchant configuration, because reconciling settlements means
    // knowing which account they landed in. Cannot change it, and still
    // cannot open a till.
    'payment.account.read',
  ]),

  // The stores of one region. Store-level authority over them, no company
  // configuration: a regional manager may run an outlet, not re-register the
  // business it trades as.
  REGIONAL_MANAGER: Object.freeze([
    'org.store.read', 'org.brand.read', 'org.region.read', 'org.gst.read', 'org.legalEntity.read',
    'catalog.read', 'table.read', 'table.write',
    'order.read', 'order.create', 'order.bill', 'order.void', 'order.item.void', 'kot.read',
    'payment.record', 'refund.issue', 'dayclose.read', 'dayclose.perform',
    'report.sales.read', 'report.tax.read', 'promo.read', 'promo.apply',
    'user.read', 'terminal.read', 'terminal.write', 'device.read', 'device.enrol', 'device.activate', 'device.revoke',
    'payment.account.read', 'drawer.open', 'drawer.open.manual',
  ]),

  // One store (or the stores explicitly assigned). The spec's Store Manager.
  BRANCH_MANAGER: Object.freeze([
    'org.store.read', 'org.brand.read', 'org.gst.read',
    'catalog.read', 'table.read', 'table.write',
    'order.read', 'order.create', 'order.bill', 'order.void', 'order.item.void', 'kot.read',
    'payment.record', 'refund.issue', 'dayclose.read', 'dayclose.perform',
    'report.sales.read', 'promo.read', 'promo.apply',
    'user.read', 'terminal.read', 'device.read',
    'payment.account.read', 'drawer.open', 'drawer.open.manual',
  ]),

  // Takes money. Cannot void an order, cannot refund, cannot close the day,
  // and — the point of the whole file — cannot change any of that.
  CASHIER: Object.freeze([...SELL, 'order.item.void']),

  // Takes orders, sends them to the kitchen, hands the bill to someone who can
  // collect. No payment action.
  CAPTAIN: Object.freeze(['order.read', 'order.create', 'order.item.void', 'kot.read', 'table.read', 'catalog.read']),

  KITCHEN: Object.freeze(['kot.read', 'order.read', 'catalog.read']),

  // Reach is decided by assignment: a company stock controller gets none, a
  // store storekeeper gets one. Stock actions themselves arrive with the
  // inventory lane (see EXTENSION_POINTS).
  INVENTORY: Object.freeze(['catalog.read', 'org.store.read', 'order.read']),

  PURCHASE: Object.freeze(['catalog.read', 'org.store.read', 'org.legalEntity.read', 'org.gst.read', 'report.sales.read']),

  DELIVERY: Object.freeze(['order.read', 'kot.read', 'table.read', 'catalog.read']),

  // Reads. Writes nothing, anywhere, ever — which is what makes it safe to
  // give to someone outside the business.
  AUDITOR: Object.freeze(ALL.filter((k) => /\.(read)$/.test(k))),
});

// In the ceiling, but off until somebody with the authority to says otherwise.
// Both of these are the actions by which a delegated admin could promote
// themselves, so the owner has to grant them deliberately — "explicitly
// authorized Company Admin", not "Company Admin".
const DEFAULT_OFF = Object.freeze({
  COMPANY_ADMIN: Object.freeze(['permission.write', 'support.grant.write']),
});

// A platform operator needs a live, tenant-issued SupportAccessGrant for these
// even though the role's ceiling allows them. Rewriting a customer's authority
// model is not something VEXO should be able to do unasked.
export const SUPPORT_GRANT_REQUIRED = Object.freeze(['permission.write', 'support.grant.read']);

export const ROLES = Object.freeze(Object.keys(ROLE_ACTIONS));

const BASELINE = new Map(
  Object.entries(ROLE_ACTIONS).map(([role, keys]) => [role, new Set(keys)]),
);

export const baselineAllows = (role, action) => BASELINE.get(role)?.has(action) ?? false;

export const baselineFor = (role) => Object.freeze([...(BASELINE.get(role) ?? [])]);

export const isDefaultOff = (role, action) => (DEFAULT_OFF[role] ?? []).includes(action);

// ---------------------------------------------------------------------------
// Rule resolution — most specific wins, same order DiscountPolicy uses
// ---------------------------------------------------------------------------

export const scopeKeyFor = (level, { branchId, userId } = {}) => {
  if (level === 'USER') return `user:${userId}`;
  if (level === 'BRANCH') return `branch:${branchId}`;
  return 'company';
};

const RANK = { COMPANY: 1, BRANCH: 2, USER: 3 };

// A COMPANY-level DENY that no narrower row may lift. Carries `hard` so a
// caller — the rules screen, the write-time refusal in routes/permissions.js —
// can say WHY an ALLOW would not take effect instead of silently storing one.
export const HARD_DENY_LEVEL = 'COMPANY';
const hardDenyRow = (action) => ({
  level: HARD_DENY_LEVEL,
  effect: 'DENY',
  action,
  branchId: null,
  userId: null,
  hard: true,
});

// `rules` is every PermissionRule row for the tenant. Rows that do not apply to
// this subject are dropped, then the narrowest surviving row per action wins —
// EXCEPT that a company-wide DENY outranks everything.
//
// Narrowest-wins is right for a permission the tenant merely leaves at its
// default: "everyone except this person", "this store only". It is wrong for a
// prohibition. A company DENY on refund.issue means the business does not issue
// refunds; if a branch or user ALLOW could lift it, the prohibition would be
// advisory, and whoever holds permission.write at one store could quietly undo a
// decision taken for the whole company. So the company DENY is applied LAST and
// overwrites the narrower winner.
//
// The cost is deliberate: "deny everywhere except Priya" cannot be written as a
// company DENY plus a user ALLOW. It is written the other way round — leave the
// company at its baseline and DENY the people who must not — which states the
// same intent without making a prohibition overridable.
export const resolveRules = (rules, { userId = null, branchIds = [] } = {}) => {
  const ids = new Set(branchIds.filter(Boolean));
  const winner = new Map();
  const hardDenied = new Set();
  for (const rule of rules) {
    if (rule.level === 'USER' && rule.userId !== userId) continue;
    if (rule.level === 'BRANCH' && !ids.has(rule.branchId)) continue;
    if (rule.level === 'COMPANY' && rule.effect === 'DENY') hardDenied.add(rule.action);
    const held = winner.get(rule.action);
    if (!held || RANK[rule.level] > RANK[held.level]) winner.set(rule.action, rule);
  }
  for (const action of hardDenied) winner.set(action, hardDenyRow(action));
  return winner;
};

// Whether a company-wide prohibition is what is stopping this action. Read by
// the rules route, which refuses to store an ALLOW that would do nothing.
export const isHardDenied = (resolved, action) => Boolean(resolved?.get(action)?.hard);

// The one authorisation decision. `resolved` is the Map from resolveRules.
//
// Order matters and is the security property: the ceiling is consulted BEFORE
// the rules, so an ALLOW row can only ever restore something a DENY row took
// away. There is no argument by which this function returns true for an action
// the role does not hold, and none by which it returns true for an action the
// company has denied outright — resolveRules has already replaced any narrower
// winner with the company DENY by the time the Map gets here.
export const can = ({ role, resolved } = {}, action) => {
  if (!role || !isKnownAction(action)) return false;
  if (!baselineAllows(role, action)) return false;
  const rule = resolved?.get(action);
  if (rule) return rule.effect === 'ALLOW';
  return !isDefaultOff(role, action);
};

// Everything this principal may currently do. Drives the admin screens, which
// must never offer a control the API would refuse.
export const effectiveActions = (ctx) => ACTION_KEYS.filter((k) => can(ctx, k));

// ---------------------------------------------------------------------------
// Organisational scope
// ---------------------------------------------------------------------------

// Roles pinned to the single store on PosUser.branchId when they have no
// explicit assignments. BRANCH_MANAGER and CASHIER are listed to match the
// pinning auth.js has always applied, so nothing about the existing four roles
// changes.
const STORE_PINNED_ROLES = new Set(['BRANCH_MANAGER', 'CASHIER', 'CAPTAIN', 'KITCHEN', 'DELIVERY']);

export const isStorePinnedRole = (role) => STORE_PINNED_ROLES.has(role);

// { kind: 'ALL' }      — the platform role, no tenant boundary
// { kind: 'COMPANY' }  — every store in the tenant
// { kind: 'LIST', branchIds } — exactly these
// { kind: 'REGION', regionId } — the stores pointing at this region
//
// THE ASSIGNMENT RULE, stated once and authoritative. UserStoreAssignment rows
// REPLACE the scope the role would otherwise imply. They are neither "only
// narrowing" nor "only widening" — which of the two they do depends on the role:
//
//   BRANCH_MANAGER, CASHIER, CAPTAIN, KITCHEN, DELIVERY (store-pinned)
//       no rows  → the one store on PosUser.branchId (the legacy fallback, how
//                  every account created before assignments existed still works)
//       rows     → exactly those stores. For a manager covering two outlets this
//                  WIDENS, which is the point of the table.
//   REGIONAL_MANAGER
//       no rows  → every store in PosUser.regionId
//       rows     → exactly those stores, region ignored. Either direction.
//   COMPANY_ADMIN, FINANCE, AUDITOR, ... (company-wide)
//       no rows  → the whole tenant
//       rows     → exactly those stores, which NARROWS.
//
// Because assignments can widen, writing them is an authority question, not a
// convenience: PUT /permissions/assignments/:userId demands `user.write`, every
// store named must already be inside the CALLER's own scope, and nobody may
// edit their own. Those three checks are what keep "replace" from meaning
// "help yourself". The action ceiling is untouched either way — a wider scope
// never adds an action, it only changes where the actions already held apply.
//
// A role whose scope cannot be established resolves to an empty LIST, never to
// COMPANY — a regional manager with no region is scoped to nothing, because
// failing open here would hand them the whole tenant.
export const storeScopeFor = (user, assignments = []) => {
  if (user.role === 'POS_SUPER_ADMIN') return { kind: 'ALL' };
  const assigned = assignments.map((a) => a.branchId ?? a).filter(Boolean);
  if (assigned.length) return { kind: 'LIST', branchIds: assigned };
  if (STORE_PINNED_ROLES.has(user.role)) {
    return { kind: 'LIST', branchIds: user.branchId ? [user.branchId] : [] };
  }
  if (user.role === 'REGIONAL_MANAGER') {
    return user.regionId ? { kind: 'REGION', regionId: user.regionId } : { kind: 'LIST', branchIds: [] };
  }
  return { kind: 'COMPANY' };
};

// A Prisma `where` fragment for models that ARE the Branch.
export const branchWhereForScope = (scope) => {
  if (scope.kind === 'ALL' || scope.kind === 'COMPANY') return {};
  if (scope.kind === 'REGION') return { regionId: scope.regionId };
  return { id: { in: scope.branchIds.length ? scope.branchIds : ['__none__'] } };
};

// The same fragment for models that carry a branchId column.
export const branchIdWhereForScope = (scope) => {
  if (scope.kind === 'ALL' || scope.kind === 'COMPANY') return {};
  if (scope.kind === 'REGION') return { branch: { regionId: scope.regionId } };
  return { branchId: { in: scope.branchIds.length ? scope.branchIds : ['__none__'] } };
};
