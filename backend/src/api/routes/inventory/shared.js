// Pieces every inventory router needs: quantity parsing that speaks the
// caller's unit, serialisers, and the item loader that carries an item's own
// unit table with it.

import { z } from 'zod';
import { badRequest, notFound } from '../../../lib/errors.js';
import { convertToBaseMilli, milliToQty, qtyToMilli, UnitError } from '../../../lib/inventory/units.js';

// Quantities arrive as strings. A JSON number cannot hold 0.1 exactly, and a
// stock figure that is 0.099999 is a stock figure that stops matching a shelf.
export const qtyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d{1,3})?$/.test(v), 'Quantity must be a positive number with at most 3 decimals');

export const idemKey = z.string().trim().min(8).max(120).optional();

export const loadItem = async (prisma, companyId, itemId) => {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, include: { units: true } });
  if (!item || item.companyId !== companyId) throw notFound('Item not found');
  return item;
};

// Entered quantity + unit → base-unit milli, with the factor that did the
// conversion so the caller can freeze it onto the line it is writing.
export const toBase = (item, qty, unit) => {
  try {
    return convertToBaseMilli(item, qty, unit, item.units ?? []);
  } catch (e) {
    if (e instanceof UnitError) throw badRequest(e.message);
    throw e;
  }
};

export const qty = (milli) => milliToQty(milli);

// Every quantity this API emits is a fixed three-decimal string.
//
// Prisma hands back a Decimal, and Decimal.toString() normalises: a column
// holding 100.000 stringifies to "100", while the same figure routed through
// milliToQty comes out "100.000". Two formats for one number means a client
// comparing or displaying them has to re-parse each one and guess which it
// got, so quantities go out through here and only here.
export const qtyOut = (d) => (d === null || d === undefined ? null : milliToQty(qtyToMilli(String(d))));

export const publicItem = (i) => ({
  id: i.id,
  kind: i.kind,
  name: i.name,
  sku: i.sku,
  baseUnit: i.baseUnit,
  status: i.status,
  trackBatches: i.trackBatches,
  trackExpiry: i.trackExpiry,
  variableWeight: i.variableWeight,
  weightUnit: i.weightUnit,
  minShelfLifeDaysAtReceipt: i.minShelfLifeDaysAtReceipt,
  openedShelfLifeHours: i.openedShelfLifeHours,
  units: (i.units ?? []).map((u) => ({ id: u.id, name: u.name, factorMilli: u.factorMilli })),
});

export const publicLocation = (l) => ({
  id: l.id,
  kind: l.kind,
  name: l.name,
  code: l.code,
  status: l.status,
  branchId: l.branchId,
  parentId: l.parentId,
  storageKind: l.storageKind,
  capacityBaseQty: l.capacityBaseQty === null || l.capacityBaseQty === undefined ? null : String(l.capacityBaseQty),
  saleSourceBranchId: l.saleSourceBranchId,
});

export const publicBatch = (b) => ({
  id: b.id,
  batchCode: b.batchCode,
  supplierBatchCode: b.supplierBatchCode,
  expiryDate: b.expiryDate,
  manufacturedOn: b.manufacturedOn,
  receivedAt: b.receivedAt,
  state: b.state,
  stateReason: b.stateReason,
  itemId: b.itemId,
});

// A reason the operator actually typed. Used wherever the spec demands one:
// direct receipts, adjustments, write-offs, quarantine.
export const reasonString = z.string().trim().min(4).max(500);

// --- who did it --------------------------------------------------------------

// Inventory records store an actor's id but carry NO foreign key to PosUser,
// on purpose: an audit record has to outlive the account that made it, and a
// foreign key would either block the delete or cascade the record away. The
// price of that choice is that a name must be resolved separately, and that
// three genuinely different situations all arrive here as "not a user object":
//
//   id is null      nobody was signed in. A scheduler pass, or the till
//                   posting a sale. That is a fact, not a gap.
//   id, no row      the account has since been removed. The id is still the
//                   truth about who did it, so it is kept and labelled.
//   id, row         a person.
//
// Collapsing any of the three into a blank would read as a missing audit
// trail, which is the one thing this module must never imply. Both the ledger
// and the request lifecycle resolve through here so the rule cannot drift
// apart into two half-answers.
export const resolveActors = async (prisma, ids) => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await prisma.posUser.findMany({
    where: { id: { in: wanted } },
    select: { id: true, fullName: true, email: true, role: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
};

export const actorOut = (id, byId) =>
  id ? (byId.get(id) ?? { id, fullName: null, email: null, role: null }) : null;
