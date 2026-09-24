// LANE foundation — the ONE place a PosRole becomes English.
//
// The badge, every role picker and every permission screen read these tables,
// so a role cannot be called two things on two screens. Deliberately free of
// imports: ui.jsx needs it and it needs nothing, which keeps the label map out
// of the component/provider import cycle.
//
// These are labels and hints. Authority lives in the backend's
// lib/permissions.js and is re-checked on every request.

// BRANCH_MANAGER reads as "Store Manager": that is the name the spec gives the
// role (B§5), and the enum value keeps its old spelling because renaming it
// would rewrite every live row for the sake of a label.
export const ROLE_LABELS = Object.freeze({
  POS_SUPER_ADMIN: 'VEXO Admin',
  CUSTOMER_OWNER: 'Owner',
  COMPANY_ADMIN: 'Company Admin',
  FINANCE: 'Finance',
  REGIONAL_MANAGER: 'Regional Manager',
  BRANCH_MANAGER: 'Store Manager',
  CASHIER: 'Cashier',
  CAPTAIN: 'Captain',
  KITCHEN: 'Kitchen',
  INVENTORY: 'Inventory',
  PURCHASE: 'Purchase',
  DELIVERY: 'Delivery',
  AUDITOR: 'Auditor',
});

export const roleLabel = (role) => ROLE_LABELS[role] || role;

// One line per role, shown beside the name wherever somebody is choosing one:
// "Cashier" and "Captain" are indistinguishable from their names alone, and the
// difference — who may touch money — is the whole point of picking correctly.
export const ROLE_NOTES = Object.freeze({
  CUSTOMER_OWNER: 'Everything in this account, including permissions',
  COMPANY_ADMIN: 'Everything except changing permissions and VEXO access, until you grant those',
  FINANCE: 'Tax, invoices and reports across the company — cannot open a till',
  REGIONAL_MANAGER: 'Runs the stores of one region — no company configuration',
  BRANCH_MANAGER: 'Runs one store: bills, refunds, voids and the day close',
  CASHIER: 'Takes orders and payments at one store — no refunds, no day close',
  CAPTAIN: 'Takes orders and sends them to the kitchen — handles no money',
  KITCHEN: 'Reads kitchen tickets only',
  INVENTORY: 'Stock duties; stock actions arrive with the inventory module',
  PURCHASE: 'Purchasing duties; purchase orders arrive with the purchase module',
  DELIVERY: 'Reads orders and tickets for handover — handles no money',
  AUDITOR: 'Reads everything, writes nothing, anywhere',
});

// Roles whose whole authority is "here", so they need one store. Mirrors
// STORE_PINNED_ROLES in the backend's lib/permissions.js — the server refuses
// the write when the two disagree, so this only decides whether the form asks.
export const STORE_PINNED_ROLES = Object.freeze([
  'BRANCH_MANAGER',
  'CASHIER',
  'CAPTAIN',
  'KITCHEN',
  'DELIVERY',
]);

export const isStorePinnedRole = (role) => STORE_PINNED_ROLES.includes(role);

// Roles a tenant may hand out. POS_SUPER_ADMIN is absent on purpose and the API
// refuses it too: a customer minting a platform operator would be minting
// somebody with reach over other tenants.
export const ASSIGNABLE_ROLES = Object.freeze(
  Object.keys(ROLE_LABELS).filter((r) => r !== 'POS_SUPER_ADMIN'),
);
