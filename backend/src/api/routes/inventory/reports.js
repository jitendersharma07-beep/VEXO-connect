// ENTITLEMENT(INVENTORY)
// What the business asks the ledger.
//
// Every figure here is read from StockMovement or from the balance caches the
// ledger writes in the same transaction — nothing is recomputed by a second
// method that could disagree. Where a cost is not known, the report says so
// in the row rather than printing a zero that reads as free stock.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter } from '../../../lib/inventory/permissions.js';
import { rebuildBalances, verifyBalances } from '../../../lib/inventory/ledger.js';
import { batchBlockReason, stockStateFor } from '../../../lib/inventory/stock.js';
import { milliToQty, qtyToMilli } from '../../../lib/inventory/units.js';
import { actorOut, loadItem, resolveActors } from './shared.js';

const router = Router();

const reachableLocationIds = async (req) => {
  const scope = await locationScopeFilter(prisma, req);
  const rows = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
  return rows.map((r) => r.id);
};

/* ----------------------------------------------------- stock by location */

router.get(
  '/stock',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const { locationId, itemId, belowMin, q } = req.query;
    let ids = await reachableLocationIds(req);
    if (locationId) {
      const loc = await loadLocationInScope(prisma, req, String(locationId));
      ids = [loc.id];
    }

    const balances = await prisma.stockBalance.findMany({
      where: {
        companyId: req.companyScope.id,
        locationId: { in: ids },
        ...(itemId ? { itemId: String(itemId) } : {}),
        ...(q ? { item: { name: { contains: String(q), mode: 'insensitive' } } } : {}),
      },
      include: {
        item: { select: { id: true, name: true, sku: true, baseUnit: true, kind: true, trackBatches: true } },
        location: { select: { id: true, name: true, code: true, kind: true } },
      },
      orderBy: [{ locationId: 'asc' }, { itemId: 'asc' }],
      take: 2000,
    });

    // Reservations and plan minimums, fetched once and joined in memory
    // rather than per row.
    const reservations = await prisma.stockReservation.findMany({
      where: { companyId: req.companyScope.id, locationId: { in: ids }, state: 'HELD' },
      select: { locationId: true, itemId: true, qty: true },
    });
    const reservedBy = new Map();
    for (const r of reservations) {
      const k = `${r.locationId}:${r.itemId}`;
      reservedBy.set(k, (reservedBy.get(k) ?? 0) + qtyToMilli(r.qty));
    }

    const planLines = await prisma.replenishmentPlanLine.findMany({
      where: { plan: { companyId: req.companyScope.id, destinationLocationId: { in: ids }, status: 'ACTIVE' }, active: true },
      select: { itemId: true, minQty: true, targetQty: true, plan: { select: { destinationLocationId: true } } },
    });
    const minBy = new Map();
    for (const l of planLines) minBy.set(`${l.plan.destinationLocationId}:${l.itemId}`, l);

    // Blocked stock per location+item, from the batch cache.
    const batchBalances = await prisma.stockBatchBalance.findMany({
      where: { locationId: { in: ids }, qty: { not: 0 } },
      include: { batch: { select: { state: true, expiryDate: true } } },
    });
    const asOf = new Date();
    const blockedBy = new Map();
    for (const bb of batchBalances) {
      if (!batchBlockReason(bb.batch, asOf)) continue;
      const k = `${bb.locationId}:${bb.itemId}`;
      blockedBy.set(k, (blockedBy.get(k) ?? 0) + qtyToMilli(bb.qty));
    }

    const rows = balances.map((b) => {
      const k = `${b.locationId}:${b.itemId}`;
      const physical = qtyToMilli(b.qty);
      const blocked = blockedBy.get(k) ?? 0;
      const reserved = reservedBy.get(k) ?? 0;
      const usable = physical - blocked;
      const plan = minBy.get(k);
      return {
        location: b.location,
        item: b.item,
        physical: milliToQty(physical),
        blocked: milliToQty(blocked),
        usable: milliToQty(usable),
        reserved: milliToQty(reserved),
        available: milliToQty(usable - reserved),
        valuePaise: String(b.valuePaise),
        // Null, not zero: a position that has never taken a valued receipt has
        // no average, and printing 0.000000 would read as free stock.
        unitCostPaise: b.lastUnitCostPaise === null ? null : String(b.lastUnitCostPaise),
        costBasisAt: b.costBasisAt,
        minQty: plan ? String(plan.minQty) : null,
        targetQty: plan ? String(plan.targetQty) : null,
        belowMin: plan ? usable - reserved < qtyToMilli(plan.minQty) : false,
      };
    });

    res.json({
      asOf,
      rows: belowMin === 'true' ? rows.filter((r) => r.belowMin) : rows,
      totalValuePaise: String(rows.reduce((a, r) => a + BigInt(r.valuePaise), 0n)),
    });
  }),
);

router.get(
  '/stock/:locationId/:itemId',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const item = await loadItem(prisma, req.companyScope.id, req.params.itemId);
    const state = await stockStateFor(prisma, {
      companyId: req.companyScope.id,
      locationId: location.id,
      itemId: item.id,
    });
    res.json({
      location: { id: location.id, name: location.name, code: location.code },
      item: { id: item.id, name: item.name, baseUnit: item.baseUnit },
      state,
    });
  }),
);

/* ----------------------------------------------------------- the ledger */

const ledgerQuery = z.object({
  locationId: z.string().cuid().optional(),
  itemId: z.string().cuid().optional(),
  batchId: z.string().cuid().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// Every stock change, newest first, with the position it left behind.
//
// This is the audit answer: "why is there 6 kg here" is read off in one
// screen, and each row names what caused it.
router.get(
  '/ledger',
  requireInventoryAction('inventory.ledger.view'),
  asyncHandler(async (req, res) => {
    const q = ledgerQuery.parse(req.query);
    let ids = await reachableLocationIds(req);
    if (q.locationId) {
      const loc = await loadLocationInScope(prisma, req, q.locationId);
      ids = [loc.id];
    }

    const movements = await prisma.stockMovement.findMany({
      where: {
        companyId: req.companyScope.id,
        locationId: { in: ids },
        ...(q.itemId ? { itemId: q.itemId } : {}),
        ...(q.batchId ? { batchId: q.batchId } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.from || q.to
          ? {
              occurredAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
        ...(q.cursor ? { seq: { lt: BigInt(q.cursor) } } : {}),
      },
      include: {
        item: { select: { id: true, name: true, baseUnit: true } },
        location: { select: { id: true, name: true, code: true } },
        batch: { select: { id: true, batchCode: true, expiryDate: true } },
      },
      orderBy: { seq: 'desc' },
      take: q.limit,
    });

    // Who posted it. StockMovement holds the id but carries no relation to
    // PosUser on purpose — the ledger must survive a user row being removed,
    // and a foreign key would either block that or cascade the movement away.
    // So the name is resolved here, through the same helper the request
    // lifecycle uses, and a deleted account degrades to the bare id rather
    // than to a blank, which would read as "nobody did this".
    const actorById = await resolveActors(prisma, movements.map((m) => m.createdById));

    res.json({
      movements: movements.map((m) => ({
        id: m.id,
        seq: String(m.seq),
        occurredAt: m.occurredAt,
        postedAt: m.postedAt,
        type: m.type,
        location: m.location,
        item: m.item,
        batch: m.batch,
        qty: String(m.qty),
        valuePaise: String(m.valuePaise),
        unitCostPaise: m.unitCostPaise === null ? null : String(m.unitCostPaise),
        costStatus: m.costStatus,
        costBasisAt: m.costBasisAt,
        balanceQtyAfter: String(m.balanceQtyAfter),
        balanceValueAfter: String(m.balanceValueAfter),
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        note: m.note,
        // null means the posting had no signed-in actor (a scheduler pass, or
        // a consumption posted by the till on a sale). That is a different
        // fact from "we did not record it", and the screen says so.
        createdBy: actorOut(m.createdById, actorById),
      })),
      nextCursor: movements.length === q.limit ? String(movements[movements.length - 1].seq) : null,
    });
  }),
);

// Proves the balance caches equal the ledger. Read-only and safe to run at
// any time: it is the check, not the repair.
router.get(
  '/ledger/verify',
  requireInventoryAction('inventory.ledger.view'),
  asyncHandler(async (req, res) => {
    const result = await verifyBalances(prisma, req.companyScope.id);
    res.json({
      checked: result.checked,
      ok: result.mismatches.length === 0,
      mismatches: result.mismatches,
    });
  }),
);

router.post(
  '/ledger/rebuild',
  requireInventoryAction('inventory.ledger.rebuild'),
  asyncHandler(async (req, res) => {
    const before = await verifyBalances(prisma, req.companyScope.id);
    const result = await prisma.$transaction((tx) => rebuildBalances(tx, req.companyScope.id));
    const after = await verifyBalances(prisma, req.companyScope.id);
    await audit(req, {
      action: 'INVENTORY_LEDGER_REBUILD',
      entity: 'Company',
      entityId: req.companyScope.id,
      companyId: req.companyScope.id,
      meta: { mismatchesBefore: before.mismatches.length, mismatchesAfter: after.mismatches.length },
    });
    res.json({ rebuilt: result, mismatchesBefore: before.mismatches.length, mismatchesAfter: after.mismatches.length });
  }),
);

/* ------------------------------------------------------------- valuation */

// Stock value as at an instant, replayed from the ledger rather than read
// from the cache, so a valuation taken for last month is reproducible today.
router.get(
  '/valuation',
  requireInventoryAction('inventory.report.view'),
  asyncHandler(async (req, res) => {
    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
    if (Number.isNaN(asOf.getTime())) throw badRequest('asOf must be a date');
    let ids = await reachableLocationIds(req);
    if (req.query.locationId) {
      const loc = await loadLocationInScope(prisma, req, String(req.query.locationId));
      ids = [loc.id];
    }

    // The last movement at or before asOf for each position carries the
    // position that movement left behind — that IS the balance at that time.
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT ON (m."locationId", m."itemId")
             m."locationId", m."itemId", m."balanceQtyAfter" AS qty, m."balanceValueAfter" AS value,
             m."costStatus" AS "costStatus"
        FROM "StockMovement" m
       WHERE m."companyId" = ${req.companyScope.id}
         AND m."locationId" = ANY(${ids})
         AND m."postedAt" <= ${asOf}
       ORDER BY m."locationId", m."itemId", m."seq" DESC
    `;

    const itemIds = [...new Set(rows.map((r) => r.itemId))];
    const locIds = [...new Set(rows.map((r) => r.locationId))];
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, name: true, sku: true, baseUnit: true },
    });
    const locations = await prisma.inventoryLocation.findMany({
      where: { id: { in: locIds } },
      select: { id: true, name: true, code: true },
    });
    const itemBy = new Map(items.map((i) => [i.id, i]));
    const locBy = new Map(locations.map((l) => [l.id, l]));

    const lines = rows
      .filter((r) => qtyToMilli(r.qty) !== 0)
      .map((r) => ({
        location: locBy.get(r.locationId),
        item: itemBy.get(r.itemId),
        qty: String(r.qty),
        valuePaise: String(r.value),
        // Carried from the movement that set this position: a position last
        // touched by a MISSING-cost issue is not a confident valuation.
        costStatus: r.costStatus,
      }));

    res.json({
      asOf,
      lines,
      totalValuePaise: String(lines.reduce((a, l) => a + BigInt(l.valuePaise), 0n)),
      // Stated separately and never folded into the total, so a report with
      // unknown costs cannot be read as a complete one.
      linesWithUnknownCost: lines.filter((l) => l.costStatus === 'MISSING').length,
    });
  }),
);

/* ------------------------------------------------------------- dashboard */

router.get(
  '/dashboard',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const ids = await reachableLocationIds(req);
    const companyId = req.companyScope.id;
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 86400000);

    const [balances, expiring, expired, openRequests, pendingApproval, inTransit, issues, reminders] = await Promise.all([
      prisma.stockBalance.aggregate({
        where: { companyId, locationId: { in: ids } },
        _sum: { valuePaise: true },
        _count: true,
      }),
      prisma.stockBatch.count({
        where: { companyId, expiryDate: { gt: now, lte: soon }, state: 'AVAILABLE', balances: { some: { locationId: { in: ids }, qty: { gt: 0 } } } },
      }),
      prisma.stockBatch.count({
        where: { companyId, expiryDate: { lte: now }, balances: { some: { locationId: { in: ids }, qty: { gt: 0 } } } },
      }),
      prisma.storeRequest.count({
        where: { companyId, status: { in: ['SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'IN_FULFILMENT'] }, OR: [{ destinationLocationId: { in: ids } }, { sourceLocationId: { in: ids } }] },
      }),
      prisma.storeRequest.count({
        where: { companyId, status: 'SUBMITTED', OR: [{ destinationLocationId: { in: ids } }, { sourceLocationId: { in: ids } }] },
      }),
      prisma.stockTransfer.count({ where: { companyId, status: 'DISPATCHED', OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }] } }),
      prisma.storeRequestIssue.count({ where: { companyId, resolvedAt: null } }),
      prisma.inventoryReminder.count({ where: { companyId, state: { in: ['PENDING', 'NOTIFIED', 'ESCALATED'] }, dueAt: { lte: now } } }),
    ]);

    // Positions the ledger cannot value. Surfaced on the dashboard because a
    // missing cost that nobody sees becomes a profit figure nobody questions.
    const unknownCost = await prisma.stockBalance.count({
      where: { companyId, locationId: { in: ids }, qty: { not: 0 }, lastUnitCostPaise: null },
    });

    res.json({
      asOf: now,
      locations: ids.length,
      positions: balances._count,
      totalValuePaise: String(balances._sum.valuePaise ?? 0n),
      positionsWithUnknownCost: unknownCost,
      batchesExpiringIn7Days: expiring,
      batchesExpired: expired,
      openRequests,
      requestsAwaitingApproval: pendingApproval,
      transfersInTransit: inTransit,
      unresolvedIssues: issues,
      remindersOverdue: reminders,
    });
  }),
);

/* -------------------------------------------------------- reconciliation */

// Quantity and value across a transfer, both sides on one page.
//
// Dispatched, accepted, damaged and short are four separately stored numbers,
// and this report is where they are proved to add up.
router.get(
  '/reports/transfer-reconciliation',
  requireInventoryAction('inventory.report.view'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const ids = await reachableLocationIds(req);
    const transfers = await prisma.stockTransfer.findMany({
      where: {
        companyId: req.companyScope.id,
        OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }],
        ...(from || to
          ? { dispatchedAt: { ...(from ? { gte: new Date(String(from)) } : {}), ...(to ? { lte: new Date(String(to)) } : {}) } }
          : {}),
      },
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        lines: { include: { item: { select: { id: true, name: true, baseUnit: true } } } },
      },
      orderBy: { dispatchedAt: 'desc' },
      take: 200,
    });

    res.json({
      transfers: transfers.map((t) => {
        const lines = t.lines.map((l) => {
          const dispatched = qtyToMilli(l.dispatchedQty ?? 0);
          const accepted = qtyToMilli(l.acceptedQty ?? 0);
          const damaged = qtyToMilli(l.damagedQty ?? 0);
          const short = qtyToMilli(l.shortageQty ?? 0);
          return {
            item: l.item,
            dispatched: milliToQty(dispatched),
            accepted: milliToQty(accepted),
            damaged: milliToQty(damaged),
            shortage: milliToQty(short),
            // Zero on a settled transfer. Anything else is an arithmetic
            // failure and is shown as one rather than being rounded away.
            unaccounted: milliToQty(dispatched - accepted - damaged - short),
            dispatchValuePaise: l.dispatchValuePaise === null ? null : String(l.dispatchValuePaise),
            acceptedValuePaise: l.acceptedValuePaise === null ? null : String(l.acceptedValuePaise),
            damagedValuePaise: l.damagedValuePaise === null ? null : String(l.damagedValuePaise),
            shortageValuePaise: l.shortageValuePaise === null ? null : String(l.shortageValuePaise),
          };
        });
        const valueOut = t.lines.reduce((a, l) => a + BigInt(l.dispatchValuePaise ?? 0n), 0n);
        const valueSettled = t.lines.reduce(
          (a, l) => a + BigInt(l.acceptedValuePaise ?? 0n) + BigInt(l.damagedValuePaise ?? 0n) + BigInt(l.shortageValuePaise ?? 0n),
          0n,
        );
        return {
          id: t.id,
          number: t.number,
          status: t.status,
          from: t.fromLocation,
          to: t.toLocation,
          dispatchedAt: t.dispatchedAt,
          receivedAt: t.receivedAt,
          lines,
          valueDispatchedPaise: String(valueOut),
          valueSettledPaise: String(valueSettled),
          valueUnaccountedPaise: String(valueOut - valueSettled),
          balanced: valueOut === valueSettled && lines.every((l) => l.unaccounted === '0.000'),
        };
      }),
    });
  }),
);

// One batch, everywhere it has been. The answer to a recall notice, by code
// rather than by internal id.
router.get(
  '/reports/traceability',
  requireInventoryAction('inventory.batch.view'),
  asyncHandler(async (req, res) => {
    const code = String(req.query.batchCode ?? '').trim();
    if (!code) throw badRequest('Give a batch code to trace');
    const batches = await prisma.stockBatch.findMany({
      where: {
        companyId: req.companyScope.id,
        OR: [{ batchCode: { equals: code, mode: 'insensitive' } }, { supplierBatchCode: { equals: code, mode: 'insensitive' } }],
      },
      include: { item: { select: { id: true, name: true } }, supplier: { select: { id: true, name: true } } },
    });
    if (!batches.length) throw notFound('No batch with that code');

    const out = [];
    for (const b of batches) {
      const movements = await prisma.stockMovement.findMany({
        where: { batchId: b.id },
        include: { location: { select: { id: true, name: true, kind: true } } },
        orderBy: { seq: 'asc' },
      });
      out.push({
        batch: {
          id: b.id,
          batchCode: b.batchCode,
          supplierBatchCode: b.supplierBatchCode,
          item: b.item,
          supplier: b.supplier,
          expiryDate: b.expiryDate,
          state: b.state,
          blockReason: batchBlockReason(b),
        },
        touchedLocations: [...new Map(movements.map((m) => [m.location.id, m.location])).values()],
        movements: movements.map((m) => ({
          seq: String(m.seq),
          type: m.type,
          location: m.location,
          qty: String(m.qty),
          occurredAt: m.occurredAt,
          sourceType: m.sourceType,
          sourceId: m.sourceId,
        })),
      });
    }
    res.json({ traces: out });
  }),
);

export default router;
