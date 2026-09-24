// ENTITLEMENT(INVENTORY)
// Batches: what is on the shelf, when it dies, and how to stop it moving.
//
// Nothing here writes stock. Quarantine and recall change a batch's STATE,
// and eligibility is recomputed from that state and the expiry date every
// time anyone asks — so a containment decision takes effect on the next
// query, with no job to run and nothing to catch up on.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter } from '../../../lib/inventory/permissions.js';
import { batchBlockReason, batchPositionsAt } from '../../../lib/inventory/stock.js';
import { milliToQty, qtyToMilli } from '../../../lib/inventory/units.js';
import { loadItem, publicBatch, qtyString, reasonString } from './shared.js';

const router = Router();

router.get(
  '/batches',
  requireInventoryAction('inventory.batch.view'),
  asyncHandler(async (req, res) => {
    const { itemId, state, expiringInDays, locationId } = req.query;

    // Batch rows are company-wide, but a caller only gets to see the ones that
    // actually sit somewhere they can reach.
    const scope = await locationScopeFilter(prisma, req);
    const visibleLocations = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    let locationIds = visibleLocations.map((l) => l.id);
    if (locationId) {
      const location = await loadLocationInScope(prisma, req, String(locationId));
      locationIds = [location.id];
    }

    const where = {
      companyId: req.companyScope.id,
      ...(itemId ? { itemId: String(itemId) } : {}),
      ...(state ? { state: String(state) } : {}),
      ...(expiringInDays
        ? { expiryDate: { not: null, lte: new Date(Date.now() + Number(expiringInDays) * 86400000) } }
        : {}),
      balances: { some: { locationId: { in: locationIds }, qty: { not: 0 } } },
    };

    const batches = await prisma.stockBatch.findMany({
      where,
      include: {
        item: { select: { id: true, name: true, baseUnit: true } },
        balances: { where: { locationId: { in: locationIds } }, include: { location: { select: { id: true, name: true, code: true } } } },
      },
      orderBy: [{ expiryDate: 'asc' }, { batchCode: 'asc' }],
      take: 500,
    });

    const asOf = new Date();
    res.json({
      batches: batches.map((b) => ({
        ...publicBatch(b),
        item: b.item,
        blockReason: batchBlockReason(b, asOf),
        positions: b.balances.map((bb) => ({ location: bb.location, qty: String(bb.qty) })),
      })),
    });
  }),
);

// The traceability trail for one batch: every movement it has ever been part
// of, at every location. This is the answer to a recall notice.
router.get(
  '/batches/:batchId/trail',
  requireInventoryAction('inventory.batch.view'),
  asyncHandler(async (req, res) => {
    const batch = await prisma.stockBatch.findUnique({
      where: { id: req.params.batchId },
      include: { item: { select: { id: true, name: true, baseUnit: true } }, supplier: { select: { id: true, name: true } } },
    });
    if (!batch || batch.companyId !== req.companyScope.id) throw notFound('Batch not found');

    const movements = await prisma.stockMovement.findMany({
      where: { batchId: batch.id },
      include: { location: { select: { id: true, name: true, code: true } } },
      orderBy: { seq: 'asc' },
    });
    const openings = await prisma.stockBatchOpening.findMany({
      where: { batchId: batch.id },
      include: { location: { select: { id: true, name: true } } },
      orderBy: { openedAt: 'asc' },
    });

    res.json({
      batch: { ...publicBatch(batch), item: batch.item, supplier: batch.supplier },
      blockReason: batchBlockReason(batch),
      movements: movements.map((m) => ({
        id: m.id,
        seq: String(m.seq),
        type: m.type,
        location: m.location,
        qty: String(m.qty),
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        occurredAt: m.occurredAt,
        note: m.note,
      })),
      openings: openings.map((o) => ({
        id: o.id,
        location: o.location,
        openedAt: o.openedAt,
        useByAt: o.useByAt,
        qty: String(o.qty),
        closedAt: o.closedAt,
      })),
    });
  }),
);

const stateSchema = z.object({ reason: reasonString });

// Containment. A manager who finds a bad crate stops it here and now; only an
// owner can decide it is fine after all.
router.post(
  '/batches/:batchId/quarantine',
  requireInventoryAction('inventory.batch.quarantine'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { reason } = stateSchema.parse(req.body);
    const batch = await prisma.stockBatch.findUnique({ where: { id: req.params.batchId } });
    if (!batch || batch.companyId !== req.companyScope.id) throw notFound('Batch not found');
    if (batch.state === 'RECALLED') throw conflict('That batch is already recalled');

    const updated = await prisma.stockBatch.update({
      where: { id: batch.id },
      data: { state: 'QUARANTINED', stateReason: reason, stateChangedAt: new Date(), stateChangedById: req.user.id },
    });
    await audit(req, {
      action: 'INVENTORY_BATCH_QUARANTINE',
      entity: 'StockBatch',
      entityId: batch.id,
      companyId: req.companyScope.id,
      meta: { batchCode: batch.batchCode, reason },
    });
    res.json({ batch: publicBatch(updated) });
  }),
);

router.post(
  '/batches/:batchId/recall',
  requireInventoryAction('inventory.batch.quarantine'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { reason } = stateSchema.parse(req.body);
    const batch = await prisma.stockBatch.findUnique({ where: { id: req.params.batchId } });
    if (!batch || batch.companyId !== req.companyScope.id) throw notFound('Batch not found');

    const updated = await prisma.stockBatch.update({
      where: { id: batch.id },
      data: { state: 'RECALLED', stateReason: reason, stateChangedAt: new Date(), stateChangedById: req.user.id },
    });
    await audit(req, {
      action: 'INVENTORY_BATCH_RECALL',
      entity: 'StockBatch',
      entityId: batch.id,
      companyId: req.companyScope.id,
      meta: { batchCode: batch.batchCode, reason },
    });
    res.json({ batch: publicBatch(updated) });
  }),
);

router.post(
  '/batches/:batchId/release',
  requireInventoryAction('inventory.batch.release'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { reason } = stateSchema.parse(req.body);
    const batch = await prisma.stockBatch.findUnique({ where: { id: req.params.batchId } });
    if (!batch || batch.companyId !== req.companyScope.id) throw notFound('Batch not found');
    if (batch.state === 'AVAILABLE') throw conflict('That batch is not held');

    const updated = await prisma.stockBatch.update({
      where: { id: batch.id },
      data: { state: 'AVAILABLE', stateReason: reason, stateChangedAt: new Date(), stateChangedById: req.user.id },
    });
    // Releasing does NOT un-expire anything: if the date has passed, the batch
    // is still refused, because release is about the hold, not the calendar.
    await audit(req, {
      action: 'INVENTORY_BATCH_RELEASE',
      entity: 'StockBatch',
      entityId: batch.id,
      companyId: req.companyScope.id,
      meta: { batchCode: batch.batchCode, reason, from: batch.state },
    });
    res.json({ batch: publicBatch(updated), stillExpired: batchBlockReason(updated) === 'EXPIRED' });
  }),
);

/* ------------------------------------------------------- opened containers */

const openSchema = z.object({
  locationId: z.string().cuid(),
  batchId: z.string().cuid(),
  qty: qtyString,
  note: z.string().trim().max(300).optional(),
});

// Opening a container starts a second, shorter clock beside the batch's own
// expiry. It never touches expiryDate: the sealed tins next to it are fine.
router.post(
  '/batches/open',
  requireInventoryAction('inventory.batch.open'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = openSchema.parse(req.body);
    const location = await loadLocationInScope(prisma, req, data.locationId, 'dispatch');

    const batch = await prisma.stockBatch.findUnique({ where: { id: data.batchId }, include: { item: true } });
    if (!batch || batch.companyId !== req.companyScope.id) throw notFound('Batch not found');
    const item = batch.item;
    if (!item.openedShelfLifeHours) {
      throw badRequest(`${item.name} does not track opened-container life; set it on the item first`);
    }

    const blocked = batchBlockReason(batch);
    if (blocked) throw conflict(`That batch cannot be opened: it is ${blocked.toLowerCase()}`);

    const held = await prisma.stockBatchBalance.findUnique({
      where: { locationId_itemId_batchId: { locationId: location.id, itemId: item.id, batchId: batch.id } },
    });
    const qtyMilli = qtyToMilli(data.qty);
    if (!held || qtyToMilli(held.qty) < qtyMilli) {
      throw conflict(`Only ${held ? String(held.qty) : '0'} of that batch is at ${location.name}`);
    }

    const opening = await prisma.stockBatchOpening.create({
      data: {
        companyId: req.companyScope.id,
        locationId: location.id,
        batchId: batch.id,
        openedAt: new Date(),
        useByAt: new Date(Date.now() + item.openedShelfLifeHours * 3600000),
        qty: milliToQty(qtyMilli),
        openedById: req.user.id,
        note: data.note ?? null,
      },
    });
    await audit(req, {
      action: 'INVENTORY_BATCH_OPEN',
      entity: 'StockBatchOpening',
      entityId: opening.id,
      companyId: req.companyScope.id,
      meta: { batchCode: batch.batchCode, locationId: location.id, qty: String(opening.qty) },
    });
    res.status(201).json({
      opening: { id: opening.id, openedAt: opening.openedAt, useByAt: opening.useByAt, qty: String(opening.qty) },
      batchExpiryDate: batch.expiryDate,
    });
  }),
);

router.post(
  '/batches/openings/:openingId/close',
  requireInventoryAction('inventory.batch.open'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const opening = await prisma.stockBatchOpening.findUnique({ where: { id: req.params.openingId } });
    if (!opening || opening.companyId !== req.companyScope.id) throw notFound('Opening not found');
    await loadLocationInScope(prisma, req, opening.locationId, 'dispatch');
    if (opening.closedAt) throw conflict('That container is already closed off');

    const closed = await prisma.stockBatchOpening.update({
      where: { id: opening.id },
      data: { closedAt: new Date() },
    });
    res.json({ opening: { id: closed.id, closedAt: closed.closedAt } });
  }),
);

/* -------------------------------------------------- batch positions at a place */

router.get(
  '/locations/:locationId/items/:itemId/batches',
  requireInventoryAction('inventory.batch.view'),
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const item = await loadItem(prisma, req.companyScope.id, req.params.itemId);
    const positions = await batchPositionsAt(prisma, { locationId: location.id, itemId: item.id });
    res.json({
      location: { id: location.id, name: location.name, code: location.code },
      item: { id: item.id, name: item.name, baseUnit: item.baseUnit },
      // Already in FEFO order: this is the order stock will actually leave in.
      positions: positions.map((p) => ({
        batchId: p.batchId,
        batchCode: p.batchCode,
        supplierBatchCode: p.supplierBatchCode,
        expiryDate: p.expiryDate,
        state: p.state,
        qty: milliToQty(p.qtyMilli),
        eligible: milliToQty(p.eligibleMilli),
        blocked: milliToQty(p.blockedMilli),
        blockReason: p.blockReason,
      })),
    });
  }),
);

export default router;
