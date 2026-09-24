// ENTITLEMENT(INVENTORY)
// Purchase orders, goods receipts and purchase returns — how stock gets in.
//
// A GRN is the only routine way stock enters a location. A receipt with no
// purchase order behind it is allowed, because deliveries genuinely arrive
// that way, but it is owner-only and always demands a written reason.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter, rolesFor } from '../../../lib/inventory/permissions.js';
import { postMovementsOnce, LedgerError } from '../../../lib/inventory/ledger.js';
import { milliToQty, qtyToMilli } from '../../../lib/inventory/units.js';
import { nextDocNumber } from '../../../lib/inventory/docnum.js';
import { idemKey, loadItem, qtyString, reasonString, toBase } from './shared.js';

const router = Router();

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/* -------------------------------------------------------------- purchase orders */

const poLineSchema = z.object({
  itemId: z.string().cuid(),
  unit: z.string().trim().min(1).max(40),
  qty: qtyString,
  unitPricePaise: paise,
  // Integer milli-percent: 5% is 5000, matching the money contract.
  taxPctMilli: z.number().int().min(0).max(100000).optional(),
});

const poSchema = z.object({
  supplierId: z.string().cuid(),
  locationId: z.string().cuid(),
  expectedAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(poLineSchema).min(1).max(200),
});

// Line value in paise from a unit price quoted per ENTERED unit. The price is
// per box, the quantity is in boxes; the base quantity only matters to stock.
const lineMoney = (qtyMilli, unitPricePaise, taxPctMilli) => {
  const goods = (BigInt(qtyMilli) * BigInt(unitPricePaise)) / 1000n;
  const tax = (goods * BigInt(taxPctMilli ?? 0)) / 100000n;
  return { goods, tax };
};

router.get(
  '/purchase-orders',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const scope = await locationScopeFilter(prisma, req);
    const visible = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const orders = await prisma.purchaseOrder.findMany({
      where: {
        companyId: req.companyScope.id,
        locationId: { in: visible.map((v) => v.id) },
        ...(req.query.status ? { status: String(req.query.status) } : {}),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        location: { select: { id: true, name: true, code: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({
      purchaseOrders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        supplier: o.supplier,
        location: o.location,
        expectedAt: o.expectedAt,
        lineCount: o._count.lines,
        totalPaise: String(o.totalPaise),
        approvedAt: o.approvedAt,
        createdAt: o.createdAt,
      })),
    });
  }),
);

router.get(
  '/purchase-orders/:poId',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.poId },
      include: {
        supplier: true,
        location: true,
        lines: { include: { item: { select: { id: true, name: true, baseUnit: true } } }, orderBy: { lineNo: 'asc' } },
      },
    });
    if (!po || po.companyId !== req.companyScope.id) throw notFound('Purchase order not found');
    await loadLocationInScope(prisma, req, po.locationId);
    res.json({
      purchaseOrder: {
        id: po.id,
        number: po.number,
        status: po.status,
        supplier: { id: po.supplier.id, name: po.supplier.name },
        location: { id: po.location.id, name: po.location.name, code: po.location.code },
        expectedAt: po.expectedAt,
        note: po.note,
        subtotalPaise: String(po.subtotalPaise),
        taxPaise: String(po.taxPaise),
        totalPaise: String(po.totalPaise),
        approvedAt: po.approvedAt,
        lines: po.lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          item: l.item,
          unit: l.unit,
          qty: String(l.qty),
          qtyBase: String(l.qtyBase),
          unitPricePaise: l.unitPricePaise,
          taxPctMilli: l.taxPctMilli,
          linePaise: String(l.linePaise),
          taxPaise: String(l.taxPaise),
          receivedQtyBase: String(l.receivedQtyBase),
          outstandingQtyBase: milliToQty(qtyToMilli(l.qtyBase) - qtyToMilli(l.receivedQtyBase)),
        })),
      },
    });
  }),
);

router.post(
  '/purchase-orders',
  requireInventoryAction('inventory.po.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = poSchema.parse(req.body);
    const location = await loadLocationInScope(prisma, req, data.locationId, 'receive');
    const supplier = await prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || supplier.companyId !== req.companyScope.id) throw notFound('Supplier not found');

    const prepared = [];
    let subtotal = 0n;
    let taxTotal = 0n;
    for (const [i, line] of data.lines.entries()) {
      const item = await loadItem(prisma, req.companyScope.id, line.itemId);
      const { baseMilli, factorMilli } = toBase(item, line.qty, line.unit);
      if (baseMilli <= 0) throw badRequest(`Line ${i + 1} must order more than nothing`);
      const { goods, tax } = lineMoney(qtyToMilli(line.qty), line.unitPricePaise, line.taxPctMilli);
      subtotal += goods;
      taxTotal += tax;
      prepared.push({
        lineNo: i + 1,
        itemId: item.id,
        unit: line.unit.trim().toLowerCase(),
        qty: String(line.qty),
        qtyBase: milliToQty(baseMilli),
        unitPricePaise: line.unitPricePaise,
        taxPctMilli: line.taxPctMilli ?? 0,
        linePaise: goods,
        taxPaise: tax,
        factorMilli,
      });
    }

    const po = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.companyScope.id, 'PO');
      return tx.purchaseOrder.create({
        data: {
          companyId: req.companyScope.id,
          number,
          supplierId: supplier.id,
          locationId: location.id,
          expectedAt: data.expectedAt ?? null,
          note: data.note ?? null,
          subtotalPaise: subtotal,
          taxPaise: taxTotal,
          totalPaise: subtotal + taxTotal,
          createdById: req.user.id,
          lines: { create: prepared.map(({ factorMilli, ...l }) => l) },
        },
      });
    });

    await audit(req, {
      action: 'INVENTORY_PO_CREATE',
      entity: 'PurchaseOrder',
      entityId: po.id,
      companyId: req.companyScope.id,
      meta: { number: po.number, supplierId: supplier.id, lines: prepared.length, totalPaise: String(po.totalPaise) },
    });
    res.status(201).json({ purchaseOrder: { id: po.id, number: po.number, status: po.status } });
  }),
);

router.post(
  '/purchase-orders/:poId/approve',
  requireInventoryAction('inventory.po.approve'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.poId } });
    if (!po || po.companyId !== req.companyScope.id) throw notFound('Purchase order not found');
    await loadLocationInScope(prisma, req, po.locationId, 'approve');
    if (po.status !== 'DRAFT') throw conflict(`That purchase order is ${po.status.toLowerCase()}, not a draft`);

    const updated = await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: new Date() },
    });
    await audit(req, {
      action: 'INVENTORY_PO_APPROVE',
      entity: 'PurchaseOrder',
      entityId: po.id,
      companyId: req.companyScope.id,
      meta: { number: po.number, totalPaise: String(po.totalPaise) },
    });
    res.json({ purchaseOrder: { id: updated.id, number: updated.number, status: updated.status } });
  }),
);

router.post(
  '/purchase-orders/:poId/close',
  requireInventoryAction('inventory.po.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: reasonString }).parse(req.body);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.poId } });
    if (!po || po.companyId !== req.companyScope.id) throw notFound('Purchase order not found');
    await loadLocationInScope(prisma, req, po.locationId, 'receive');
    if (po.status === 'CLOSED' || po.status === 'CANCELLED') throw conflict('That purchase order is already closed');

    const status = po.status === 'DRAFT' ? 'CANCELLED' : 'CLOSED';
    const updated = await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status, closedById: req.user.id, closedAt: new Date(), closeReason: reason },
    });
    await audit(req, {
      action: 'INVENTORY_PO_CLOSE',
      entity: 'PurchaseOrder',
      entityId: po.id,
      companyId: req.companyScope.id,
      meta: { number: po.number, status, reason },
    });
    res.json({ purchaseOrder: { id: updated.id, number: updated.number, status: updated.status } });
  }),
);

/* ---------------------------------------------------------------- goods receipt */

const grnLineSchema = z.object({
  itemId: z.string().cuid(),
  poLineId: z.string().cuid().nullish(),
  unit: z.string().trim().min(1).max(40),
  qty: qtyString,
  unitPricePaise: paise,
  taxPctMilli: z.number().int().min(0).max(100000).optional(),
  // Batch details. Required when the item tracks batches — a tracked item
  // received without one would be stock nobody can ever trace or expire.
  batchCode: z.string().trim().max(60).optional(),
  supplierBatchCode: z.string().trim().max(60).optional(),
  expiryDate: z.coerce.date().optional(),
  manufacturedOn: z.coerce.date().optional(),
  // A variable-weight item is counted in pieces and weighed: this is what the
  // scale said, and it is what the ledger records.
  measuredWeight: qtyString.optional(),
});

const landedCostSchema = z.object({
  kind: z.string().trim().min(2).max(40),
  description: z.string().trim().max(200).optional(),
  amountPaise: paise,
});

const grnSchema = z.object({
  supplierId: z.string().cuid(),
  locationId: z.string().cuid(),
  poId: z.string().cuid().nullish(),
  supplierInvoiceNo: z.string().trim().max(60).optional(),
  supplierInvoiceDate: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
  // Required when there is no purchase order behind the delivery.
  directReason: reasonString.optional(),
  lines: z.array(grnLineSchema).min(1).max(200),
  landedCosts: z.array(landedCostSchema).max(20).optional(),
  idempotencyKey: idemKey,
});

router.post(
  '/goods-receipts',
  requireInventoryAction('inventory.grn.post'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = grnSchema.parse(req.body);
    const location = await loadLocationInScope(prisma, req, data.locationId, 'receive');
    const supplier = await prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || supplier.companyId !== req.companyScope.id) throw notFound('Supplier not found');

    let po = null;
    if (data.poId) {
      po = await prisma.purchaseOrder.findUnique({ where: { id: data.poId }, include: { lines: true } });
      if (!po || po.companyId !== req.companyScope.id) throw notFound('Purchase order not found');
      if (po.locationId !== location.id) throw badRequest('That purchase order is for a different location');
      if (po.status === 'DRAFT') throw conflict('That purchase order has not been approved yet');
      if (po.status === 'CANCELLED' || po.status === 'CLOSED') throw conflict('That purchase order is closed');
    } else {
      // Stock with no order behind it. Allowed, owner-only, reason required.
      // Refused as an authorisation failure, not a malformed request: the
      // body was fine, the caller was not.
      if (!rolesFor('inventory.receipt.direct').includes(req.user.role)) {
        throw forbidden('Only an owner can receive stock without a purchase order');
      }
      if (!data.directReason) throw badRequest('A receipt without a purchase order needs a written reason');
    }

    const settings = await prisma.inventorySettings.findUnique({ where: { companyId: req.companyScope.id } });
    const taxIsCost = settings?.purchaseTaxIsCost ?? true;

    // Prepare every line before writing anything, so a bad line fifteen
    // refuses the whole delivery rather than half-receiving it.
    const prepared = [];
    let goodsTotal = 0n;
    let taxTotal = 0n;
    for (const [i, line] of data.lines.entries()) {
      const item = await loadItem(prisma, req.companyScope.id, line.itemId);
      const at = `Line ${i + 1} (${item.name})`;

      let baseMilli;
      if (item.variableWeight) {
        if (!line.measuredWeight) throw badRequest(`${at} is sold by weight; enter what the scale said`);
        baseMilli = qtyToMilli(line.measuredWeight);
      } else {
        baseMilli = toBase(item, line.qty, line.unit).baseMilli;
      }
      if (baseMilli <= 0) throw badRequest(`${at} must receive more than nothing`);

      if (item.trackBatches && !line.batchCode) throw badRequest(`${at} is batch tracked; a batch code is required`);
      if (item.trackExpiry && !line.expiryDate) throw badRequest(`${at} needs an expiry date`);

      // Minimum remaining shelf life. Refusing at the door is the only moment
      // this is cheap — once it is on the shelf it is already a write-off.
      if (line.expiryDate && item.minShelfLifeDaysAtReceipt !== null && item.minShelfLifeDaysAtReceipt !== undefined) {
        const daysLeft = Math.floor((line.expiryDate.getTime() - Date.now()) / 86400000);
        if (daysLeft < item.minShelfLifeDaysAtReceipt) {
          throw conflict(
            `${at} has ${daysLeft} day(s) of life left; ${item.name} needs at least ${item.minShelfLifeDaysAtReceipt}`,
          );
        }
      }

      const { goods, tax } = lineMoney(qtyToMilli(line.qty), line.unitPricePaise, line.taxPctMilli);
      goodsTotal += goods;
      taxTotal += tax;

      let poLine = null;
      if (line.poLineId) {
        poLine = po?.lines.find((l) => l.id === line.poLineId) ?? null;
        if (!poLine) throw badRequest(`${at} references a line that is not on that purchase order`);
        if (poLine.itemId !== item.id) throw badRequest(`${at} does not match the ordered item`);
      }

      prepared.push({ i, item, line, baseMilli, goods, tax, poLine });
    }

    const landed = (data.landedCosts ?? []).reduce((a, c) => a + BigInt(c.amountPaise), 0n);

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const number = await nextDocNumber(tx, req.companyScope.id, 'GRN');
        const stockValue = goodsTotal + (taxIsCost ? taxTotal : 0n) + landed;

        const grn = await tx.goodsReceipt.create({
          data: {
            companyId: req.companyScope.id,
            number,
            poId: po?.id ?? null,
            supplierId: supplier.id,
            locationId: location.id,
            supplierInvoiceNo: data.supplierInvoiceNo ?? null,
            supplierInvoiceDate: data.supplierInvoiceDate ?? null,
            note: data.directReason ? `Direct receipt: ${data.directReason}` : (data.note ?? null),
            goodsPaise: goodsTotal,
            taxPaise: taxTotal,
            landedCostPaise: landed,
            stockValuePaise: stockValue,
            taxIsCost,
            idempotencyKey: data.idempotencyKey ?? null,
            receivedById: req.user.id,
          },
        });

        for (const c of data.landedCosts ?? []) {
          await tx.goodsReceiptLandedCost.create({
            data: { grnId: grn.id, kind: c.kind, description: c.description ?? null, amountPaise: BigInt(c.amountPaise) },
          });
        }

        const movements = [];
        for (const p of prepared) {
          // Landed cost rides on value, so the cheap pallet does not carry the
          // same freight as the expensive one.
          const lineGoodsCost = p.goods + (taxIsCost ? p.tax : 0n);
          const share = goodsTotal === 0n ? 0n : (landed * p.goods) / goodsTotal;
          const lineValue = lineGoodsCost + share;

          let batchId = null;
          if (p.line.batchCode) {
            const batch = await tx.stockBatch.upsert({
              where: { itemId_batchCode: { itemId: p.item.id, batchCode: p.line.batchCode } },
              update: {
                supplierBatchCode: p.line.supplierBatchCode ?? undefined,
                expiryDate: p.line.expiryDate ?? undefined,
                manufacturedOn: p.line.manufacturedOn ?? undefined,
                receivedAt: new Date(),
                supplierId: supplier.id,
              },
              create: {
                companyId: req.companyScope.id,
                itemId: p.item.id,
                batchCode: p.line.batchCode,
                supplierBatchCode: p.line.supplierBatchCode ?? null,
                expiryDate: p.line.expiryDate ?? null,
                manufacturedOn: p.line.manufacturedOn ?? null,
                receivedAt: new Date(),
                supplierId: supplier.id,
              },
            });
            batchId = batch.id;
          }

          const grnLine = await tx.goodsReceiptLine.create({
            data: {
              grnId: grn.id,
              lineNo: p.i + 1,
              poLineId: p.poLine?.id ?? null,
              itemId: p.item.id,
              unit: p.line.unit.trim().toLowerCase(),
              qty: String(p.line.qty),
              qtyBase: milliToQty(p.baseMilli),
              unitPricePaise: p.line.unitPricePaise,
              poUnitPricePaise: p.poLine?.unitPricePaise ?? null,
              outstandingQtyBase: p.poLine
                ? milliToQty(qtyToMilli(p.poLine.qtyBase) - qtyToMilli(p.poLine.receivedQtyBase) - p.baseMilli)
                : null,
              qtyVarianceBase: p.poLine ? milliToQty(p.baseMilli - qtyToMilli(p.poLine.qtyBase)) : null,
              priceVariancePaise: p.poLine ? BigInt(p.line.unitPricePaise - p.poLine.unitPricePaise) : null,
              taxPctMilli: p.line.taxPctMilli ?? 0,
              goodsPaise: p.goods,
              taxPaise: p.tax,
              landedCostPaise: share,
              valuePaise: lineValue,
              batchId,
            },
          });

          if (p.poLine) {
            await tx.purchaseOrderLine.update({
              where: { id: p.poLine.id },
              data: { receivedQtyBase: milliToQty(qtyToMilli(p.poLine.receivedQtyBase) + p.baseMilli) },
            });
          }

          movements.push({
            locationId: location.id,
            itemId: p.item.id,
            batchId,
            type: 'GRN',
            qtyMilli: p.baseMilli,
            valuePaise: lineValue,
            sourceType: 'GRN',
            sourceId: grn.id,
            sourceLineId: grnLine.id,
            idempotencyKey: `grn:${grn.id}:${grnLine.id}`,
            occurredAt: grn.receivedAt,
            createdById: req.user.id,
          });
        }

        await postMovementsOnce(tx, { companyId: req.companyScope.id, movements });

        if (po) {
          const lines = await tx.purchaseOrderLine.findMany({ where: { poId: po.id } });
          const fullyReceived = lines.every((l) => qtyToMilli(l.receivedQtyBase) >= qtyToMilli(l.qtyBase));
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
          });
        }

        return grn;
      });
    } catch (e) {
      if (e instanceof LedgerError) throw conflict(e.message);
      // A replayed request with the same key hits the unique index. That is a
      // success as far as the caller is concerned: the goods are in.
      if (e?.code === 'P2002' && data.idempotencyKey) {
        const existing = await prisma.goodsReceipt.findFirst({
          where: { companyId: req.companyScope.id, idempotencyKey: data.idempotencyKey },
        });
        if (existing) return res.status(200).json({ goodsReceipt: { id: existing.id, number: existing.number }, duplicate: true });
      }
      throw e;
    }

    await audit(req, {
      action: data.poId ? 'INVENTORY_GRN_POST' : 'INVENTORY_GRN_DIRECT',
      entity: 'GoodsReceipt',
      entityId: created.id,
      companyId: req.companyScope.id,
      meta: {
        number: created.number,
        locationId: location.id,
        lines: prepared.length,
        stockValuePaise: String(created.stockValuePaise),
        ...(data.directReason ? { directReason: data.directReason } : {}),
      },
    });
    res.status(201).json({
      goodsReceipt: {
        id: created.id,
        number: created.number,
        stockValuePaise: String(created.stockValuePaise),
        taxIsCost: created.taxIsCost,
      },
    });
  }),
);

router.get(
  '/goods-receipts',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const scope = await locationScopeFilter(prisma, req);
    const visible = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const receipts = await prisma.goodsReceipt.findMany({
      where: { companyId: req.companyScope.id, locationId: { in: visible.map((v) => v.id) } },
      include: {
        supplier: { select: { id: true, name: true } },
        location: { select: { id: true, name: true, code: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 200,
    });
    res.json({
      goodsReceipts: receipts.map((g) => ({
        id: g.id,
        number: g.number,
        supplier: g.supplier,
        location: g.location,
        poId: g.poId,
        direct: g.poId === null,
        supplierInvoiceNo: g.supplierInvoiceNo,
        lineCount: g._count.lines,
        stockValuePaise: String(g.stockValuePaise),
        receivedAt: g.receivedAt,
      })),
    });
  }),
);

/* -------------------------------------------------------------- purchase return */

const returnSchema = z.object({
  grnId: z.string().cuid(),
  reason: reasonString,
  lines: z
    .array(z.object({ grnLineId: z.string().cuid(), qty: qtyString }))
    .min(1)
    .max(200),
  idempotencyKey: idemKey,
});

// Sending goods back to the supplier. Stock leaves at what it is carried at,
// not at what the supplier will credit — the two are different numbers and
// conflating them is how a stock value stops matching a ledger.
router.post(
  '/purchase-returns',
  requireInventoryAction('inventory.grn.post'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = returnSchema.parse(req.body);
    const grn = await prisma.goodsReceipt.findUnique({ where: { id: data.grnId }, include: { lines: true } });
    if (!grn || grn.companyId !== req.companyScope.id) throw notFound('Goods receipt not found');
    const location = await loadLocationInScope(prisma, req, grn.locationId, 'dispatch');

    const prepared = [];
    for (const line of data.lines) {
      const grnLine = grn.lines.find((l) => l.id === line.grnLineId);
      if (!grnLine) throw badRequest('That line is not on this goods receipt');
      const qtyMilli = qtyToMilli(line.qty);
      const already = qtyToMilli(grnLine.returnedQtyBase);
      const received = qtyToMilli(grnLine.qtyBase);
      if (qtyMilli + already > received) {
        throw conflict(`Only ${milliToQty(received - already)} of that line is left to return`);
      }
      // Credit at the price paid; stock leaves at the location's average,
      // which the ledger works out for itself.
      const credit = (BigInt(qtyMilli) * BigInt(grnLine.valuePaise)) / BigInt(qtyToMilli(grnLine.qtyBase) || 1);
      prepared.push({ grnLine, qtyMilli, credit });
    }

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const number = await nextDocNumber(tx, req.companyScope.id, 'PURCHASE_RETURN');
        const ret = await tx.purchaseReturn.create({
          data: {
            companyId: req.companyScope.id,
            number,
            grnId: grn.id,
            supplierId: grn.supplierId,
            locationId: location.id,
            reason: data.reason,
            creditPaise: prepared.reduce((a, p) => a + p.credit, 0n),
            stockValuePaise: 0n,
            idempotencyKey: data.idempotencyKey ?? null,
            createdById: req.user.id,
          },
        });

        const movements = [];
        for (const p of prepared) {
          const rl = await tx.purchaseReturnLine.create({
            data: {
              returnId: ret.id,
              grnLineId: p.grnLine.id,
              itemId: p.grnLine.itemId,
              qtyBase: milliToQty(p.qtyMilli),
              creditPaise: p.credit,
              stockValuePaise: 0n,
            },
          });
          await tx.goodsReceiptLine.update({
            where: { id: p.grnLine.id },
            data: { returnedQtyBase: milliToQty(qtyToMilli(p.grnLine.returnedQtyBase) + p.qtyMilli) },
          });
          movements.push({
            locationId: location.id,
            itemId: p.grnLine.itemId,
            batchId: p.grnLine.batchId,
            type: 'PURCHASE_RETURN',
            qtyMilli: -p.qtyMilli,
            sourceType: 'PURCHASE_RETURN',
            sourceId: ret.id,
            sourceLineId: rl.id,
            idempotencyKey: `prt:${ret.id}:${rl.id}`,
            occurredAt: ret.createdAt,
            createdById: req.user.id,
          });
        }

        const posted = await postMovementsOnce(tx, { companyId: req.companyScope.id, movements });
        const stockValue = posted.movements.reduce((a, m) => a + -BigInt(m.valuePaise), 0n);
        return tx.purchaseReturn.update({ where: { id: ret.id }, data: { stockValuePaise: stockValue } });
      });
    } catch (e) {
      if (e instanceof LedgerError) throw conflict(e.message);
      throw e;
    }

    await audit(req, {
      action: 'INVENTORY_PURCHASE_RETURN',
      entity: 'PurchaseReturn',
      entityId: created.id,
      companyId: req.companyScope.id,
      meta: { number: created.number, grnId: grn.id, reason: data.reason, creditPaise: String(created.creditPaise) },
    });
    res.status(201).json({
      purchaseReturn: {
        id: created.id,
        number: created.number,
        creditPaise: String(created.creditPaise),
        stockValuePaise: String(created.stockValuePaise),
      },
    });
  }),
);

export default router;
