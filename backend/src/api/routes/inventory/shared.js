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
