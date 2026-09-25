// ENTITLEMENT(INVENTORY)
// Physical counts, wastage and the corrections they produce.
//
// This is the only route in the module that can make stock appear or vanish
// without a supplier or a store behind it, so it is the one with the most
// rules:
//
//   * nothing is ever edited or deleted. A count that was wrong is corrected
//     by a later count, which posts its own movement;
//   * a count is submitted by one person and approved by another. The route
//     enforces "not you" because a role list cannot express it;
//   * every posting carries a typed reason and free text somebody wrote;
//   * a surplus at a position with no cost basis is MISSING, not free stock,
//     unless the counter states what it is worth.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope } from '../../../lib/inventory/permissions.js';
import { postMovements } from '../../../lib/inventory/ledger.js';
import { batchPositionsAt, selectFefo, reservedByBatchAt, stockStateFor } from '../../../lib/inventory/stock.js';
import { milliToQty, qtyToMilli } from '../../../lib/inventory/units.js';
import { nextDocNumber } from '../../../lib/inventory/docnum.js';
import { idemKey, loadItem, qtyOut, qtyString, reasonString, toBase } from './shared.js';

const router = Router();

// "45.500000" paise per base unit → 45500000 micro-paise. Parsed as integers
// so a six-decimal unit cost times a large quantity stays exact.
const microPaise = (s) => {
  const [whole, frac = ''] = String(s).split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
};

/* --------------------------------------------------------------- counts */

const countSchema = z.object({
  locationId: z.string().cuid(),
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().cuid(),
        countedQty: qtyString,
        unit: z.string().trim().min(1).max(40).optional(),
        // Paise per base unit. Only consulted for a surplus the ledger has no
        // basis to value.
        unitCostPaise: z.string().trim().regex(/^\d+(\.\d{1,6})?$/).optional(),
      }),
    )
    .min(1)
    .max(500),
});

const publicCount = (c) => ({
  id: c.id,
  number: c.number,
  status: c.status,
  location: c.location ? { id: c.location.id, name: c.location.name, code: c.location.code } : undefined,
  note: c.note,
  createdAt: c.createdAt,
  submittedAt: c.submittedAt,
  approvedAt: c.approvedAt,
  rejectedAt: c.rejectedAt,
  rejectReason: c.rejectReason,
  lines: (c.lines ?? []).map((l) => ({
    id: l.id,
    item: l.item,
    itemId: l.itemId,
    enteredQty: qtyOut(l.enteredQty),
    enteredUnit: l.enteredUnit,
    countedQty: qtyOut(l.countedQty),
    systemQty: qtyOut(l.systemQty),
    varianceQty: qtyOut(l.varianceQty),
    postedValuePaise: l.postedValuePaise === null || l.postedValuePaise === undefined ? null : String(l.postedValuePaise),
    costStatus: l.costStatus,
  })),
});

const COUNT_INCLUDE = {
  location: { select: { id: true, name: true, code: true } },
  lines: { include: { item: { select: { id: true, name: true, baseUnit: true } } }, orderBy: { id: 'asc' } },
};

router.get(
  '/counts',
  requireInventoryAction('inventory.count.create'),
  asyncHandler(async (req, res) => {
    const { locationId, status } = req.query;
    if (locationId) await loadLocationInScope(prisma, req, String(locationId));
    const counts = await prisma.stockCount.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(locationId ? { locationId: String(locationId) } : {}),
        ...(status ? { status: String(status) } : {}),
      },
      include: COUNT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // Filter by reach rather than trusting the client to: a count at a
    // location the caller cannot see must not appear in their list.
    const visible = [];
    for (const c of counts) {
      try {
        await loadLocationInScope(prisma, req, c.locationId);
        visible.push(c);
      } catch {
        /* out of scope */
      }
    }
    res.json({ counts: visible.map(publicCount) });
  }),
);

router.get(
  '/counts/:countId',
  requireInventoryAction('inventory.count.create'),
  asyncHandler(async (req, res) => {
    const count = await prisma.stockCount.findUnique({ where: { id: req.params.countId }, include: COUNT_INCLUDE });
    if (!count || count.companyId !== req.companyScope.id) throw notFound('Count not found');
    await loadLocationInScope(prisma, req, count.locationId);
    res.json({ count: publicCount(count) });
  }),
);

// Record what was on the shelf. Nothing moves yet: a count is a claim until
// somebody other than the counter approves it.
router.post(
  '/counts',
  requireInventoryAction('inventory.count.create'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = countSchema.parse(req.body);
    // Counting changes nothing, so reaching the location is enough. The
    // approval that posts the variance is separately owner-gated below.
    const location = await loadLocationInScope(prisma, req, data.locationId);

    const itemIds = [...new Set(data.lines.map((l) => l.itemId))];
    if (itemIds.length !== data.lines.length) throw badRequest('An item appears more than once in this count');

    const prepared = [];
    for (const line of data.lines) {
      const item = await loadItem(prisma, req.companyScope.id, line.itemId);
      const unit = line.unit ?? item.baseUnit;
      const { baseMilli } = toBase(item, line.countedQty, unit);
      const state = await stockStateFor(prisma, {
        companyId: req.companyScope.id,
        locationId: location.id,
        itemId: item.id,
      });
      const systemMilli = qtyToMilli(state.physical);
      prepared.push({
        itemId: item.id,
        enteredQty: line.countedQty,
        enteredUnit: unit,
        countedQty: milliToQty(baseMilli),
        // Frozen at counting time. The variance the approver sees is the one
        // the counter saw, not one recomputed after the shelf moved again.
        systemQty: milliToQty(systemMilli),
        varianceQty: milliToQty(baseMilli - systemMilli),
        unitCostPaise: line.unitCostPaise ?? null,
      });
    }

    const count = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.companyScope.id, 'COUNT');
      return tx.stockCount.create({
        data: {
          companyId: req.companyScope.id,
          number,
          locationId: location.id,
          status: 'SUBMITTED',
          note: data.note ?? null,
          createdById: req.user.id,
          submittedById: req.user.id,
          submittedAt: new Date(),
          lines: { create: prepared },
        },
        include: COUNT_INCLUDE,
      });
    });

    await audit(req, {
      action: 'INVENTORY_COUNT_SUBMIT',
      entity: 'StockCount',
      entityId: count.id,
      companyId: req.companyScope.id,
      meta: { number: count.number, locationId: location.id, lines: prepared.length },
    });
    res.status(201).json({ count: publicCount(count) });
  }),
);

const approveSchema = z.object({ reason: reasonString, idempotencyKey: idemKey });

// Approving a count is what actually posts the corrections.
//
// The variance is posted against the CURRENT position, not the one recorded
// at counting time, because the ledger must end up agreeing with the shelf
// the counter saw. Where they differ, the movement reconciles the difference
// and the frozen systemQty stays on the line as evidence of the gap.
router.post(
  '/counts/:countId/approve',
  requireInventoryAction('inventory.count.approve'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = approveSchema.parse(req.body);
    const count = await prisma.stockCount.findUnique({ where: { id: req.params.countId }, include: COUNT_INCLUDE });
    if (!count || count.companyId !== req.companyScope.id) throw notFound('Count not found');
    await loadLocationInScope(prisma, req, count.locationId);
    if (count.status !== 'SUBMITTED') throw conflict(`That count is ${count.status.toLowerCase()}, not awaiting approval`);
    // A role list cannot say "not you". This can.
    if (count.submittedById === req.user.id) {
      throw forbidden('A count must be approved by someone other than the person who counted it');
    }

    const result = await prisma.$transaction(async (tx) => {
      const movements = [];
      const lineUpdates = [];
      const at = new Date();

      for (const line of count.lines) {
        const countedMilli = qtyToMilli(line.countedQty ?? 0);
        const balance = await tx.stockBalance.findUnique({
          where: { locationId_itemId: { locationId: count.locationId, itemId: line.itemId } },
        });
        const nowMilli = balance ? qtyToMilli(balance.qty) : 0;
        const deltaMilli = countedMilli - nowMilli;
        if (deltaMilli === 0) {
          lineUpdates.push({ id: line.id, data: { postedValuePaise: 0n, costStatus: 'ACTUAL' } });
          continue;
        }

        // A shortfall leaves by FEFO, so the batches written off are the ones
        // that would have gone out next — which is where a miscount usually is.
        let batchPlan = [{ batchId: null, milli: deltaMilli }];
        const item = await tx.inventoryItem.findUnique({ where: { id: line.itemId } });
        if (item?.trackBatches && deltaMilli < 0) {
          const positions = await batchPositionsAt(tx, { locationId: count.locationId, itemId: line.itemId, asOf: at });
          const reserved = await reservedByBatchAt(tx, { locationId: count.locationId, itemId: line.itemId });
          // A count shortfall is physical: it can take from blocked stock too,
          // because the missing crate is missing whatever its state said.
          const pool = positions.map((p) => ({ ...p, eligibleMilli: p.qtyMilli }));
          const picked = selectFefo(pool, -deltaMilli, reserved);
          batchPlan = picked.picks.map((p) => ({ batchId: p.batchId, milli: -p.qtyMilli }));
          // Counted less than any batch can account for. The remainder still
          // has to leave, so it goes against no batch rather than being
          // silently dropped and leaving the ledger disagreeing with the shelf.
          if (picked.shortMilli > 0) batchPlan.push({ batchId: null, milli: -picked.shortMilli });
        }

        for (const [i, part] of batchPlan.entries()) {
          if (part.milli === 0) continue;
          movements.push({
            locationId: count.locationId,
            itemId: line.itemId,
            batchId: part.batchId,
            type: 'COUNT_ADJUSTMENT',
            qtyMilli: BigInt(part.milli),
            // A surplus the ledger cannot value is MISSING unless the counter
            // said what it is worth. It is never valued at zero and presented
            // as free stock.
            valuePaise: part.milli > 0 && line.unitCostPaise
              ? (microPaise(line.unitCostPaise) * BigInt(part.milli)) / 1_000_000_000n
              : undefined,
            sourceType: 'STOCK_COUNT',
            sourceId: count.id,
            sourceLineId: line.id,
            idempotencyKey: `count:${count.id}:${line.id}:${i}`,
            occurredAt: at,
            createdById: req.user.id,
            note: data.reason,
            allowNegative: true,
          });
        }
        lineUpdates.push({ id: line.id, data: {} });
      }

      const posted = movements.length ? await postMovements(tx, { companyId: count.companyId, movements }) : [];

      // Attribute what was actually posted back to the line that caused it.
      const byLine = new Map();
      for (const m of posted) {
        const cur = byLine.get(m.sourceLineId) ?? { value: 0n, status: 'ACTUAL' };
        cur.value += BigInt(m.valuePaise);
        if (m.costStatus === 'MISSING') cur.status = 'MISSING';
        else if (m.costStatus === 'ESTIMATED' && cur.status !== 'MISSING') cur.status = 'ESTIMATED';
        byLine.set(m.sourceLineId, cur);
      }
      for (const u of lineUpdates) {
        const agg = byLine.get(u.id);
        await tx.stockCountLine.update({
          where: { id: u.id },
          data: agg
            ? { postedValuePaise: agg.value, costStatus: agg.status }
            : u.data,
        });
      }

      const updated = await tx.stockCount.update({
        where: { id: count.id },
        data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: at },
        include: COUNT_INCLUDE,
      });
      return { updated, postedCount: posted.length };
    });

    await audit(req, {
      action: 'INVENTORY_COUNT_APPROVE',
      entity: 'StockCount',
      entityId: count.id,
      companyId: req.companyScope.id,
      meta: { number: count.number, reason: data.reason, movements: result.postedCount },
    });
    res.json({ count: publicCount(result.updated), movementsPosted: result.postedCount });
  }),
);

router.post(
  '/counts/:countId/reject',
  requireInventoryAction('inventory.count.approve'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: reasonString }).parse(req.body);
    const count = await prisma.stockCount.findUnique({ where: { id: req.params.countId } });
    if (!count || count.companyId !== req.companyScope.id) throw notFound('Count not found');
    await loadLocationInScope(prisma, req, count.locationId);
    if (count.status !== 'SUBMITTED') throw conflict(`That count is ${count.status.toLowerCase()}, not awaiting approval`);

    const updated = await prisma.stockCount.update({
      where: { id: count.id },
      data: { status: 'REJECTED', rejectedById: req.user.id, rejectedAt: new Date(), rejectReason: reason },
    });
    await audit(req, {
      action: 'INVENTORY_COUNT_REJECT',
      entity: 'StockCount',
      entityId: count.id,
      companyId: req.companyScope.id,
      meta: { number: count.number, reason },
    });
    res.json({ count: { id: updated.id, status: updated.status, rejectReason: updated.rejectReason } });
  }),
);

/* -------------------------------------------------------------- wastage */

const wastageSchema = z.object({
  locationId: z.string().cuid(),
  reason: z.enum(['EXPIRED', 'SPOILED', 'DAMAGED', 'PREP_ERROR', 'OTHER']),
  note: reasonString,
  idempotencyKey: idemKey,
  lines: z
    .array(
      z.object({
        itemId: z.string().cuid(),
        qty: qtyString,
        unit: z.string().trim().min(1).max(40).optional(),
        // Named explicitly when throwing away a specific crate. Omitted, the
        // pick is FEFO — but expired stock is taken FIRST when the reason is
        // EXPIRED, because that is the stock being thrown away.
        batchId: z.string().cuid().optional(),
      }),
    )
    .min(1)
    .max(200),
});

// Writing stock off. Physical, irreversible, and always attributed.
router.post(
  '/wastage',
  requireInventoryAction('inventory.wastage.post'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = wastageSchema.parse(req.body);
    const location = await loadLocationInScope(prisma, req, data.locationId, 'dispatch');
    const at = new Date();

    const prepared = [];
    for (const [idx, line] of data.lines.entries()) {
      const item = await loadItem(prisma, req.companyScope.id, line.itemId);
      const unit = line.unit ?? item.baseUnit;
      const { baseMilli } = toBase(item, line.qty, unit);
      if (baseMilli <= 0) throw badRequest(`Wastage quantity for ${item.name} must be more than zero`);

      let picks = [{ batchId: line.batchId ?? null, milli: baseMilli }];
      if (item.trackBatches && !line.batchId) {
        const positions = await batchPositionsAt(prisma, { locationId: location.id, itemId: item.id, asOf: at });
        const reserved = await reservedByBatchAt(prisma, { locationId: location.id, itemId: item.id });
        // Everything physically present is fair game: wastage is the route by
        // which expired and quarantined stock leaves the building at all.
        const pool = positions
          .map((p) => ({ ...p, eligibleMilli: p.qtyMilli }))
          .sort((a, b) => {
            if (data.reason === 'EXPIRED') {
              const ab = a.blockReason === 'EXPIRED' ? 0 : 1;
              const bb = b.blockReason === 'EXPIRED' ? 0 : 1;
              if (ab !== bb) return ab - bb;
            }
            return 0;
          });
        const chosen = selectFefo(pool, baseMilli, reserved);
        if (chosen.short) {
          throw conflict(`Only ${milliToQty(baseMilli - chosen.shortMilli)} of ${item.name} is at ${location.name}`);
        }
        picks = chosen.picks.map((p) => ({ batchId: p.batchId, milli: p.qtyMilli }));
      }

      prepared.push({ item, unit, enteredQty: line.qty, baseMilli, picks, idx });
    }

    const key = data.idempotencyKey ?? `wastage:${location.id}:${at.getTime()}`;
    let wastage;
    try {
      wastage = await prisma.$transaction(async (tx) => {
        const number = await nextDocNumber(tx, req.companyScope.id, 'WASTAGE');
        const movements = prepared.flatMap((p) =>
          p.picks.map((pick, i) => ({
            locationId: location.id,
            itemId: p.item.id,
            batchId: pick.batchId,
            type: 'WASTAGE',
            qtyMilli: -BigInt(pick.milli),
            sourceType: 'WASTAGE',
            sourceId: key,
            sourceLineId: `${p.idx}`,
            idempotencyKey: `wastage:${key}:${p.idx}:${i}`,
            occurredAt: at,
            createdById: req.user.id,
            note: `${data.reason}: ${data.note}`,
          })),
        );
        const posted = await postMovements(tx, { companyId: req.companyScope.id, movements });

        const byLine = new Map();
        for (const m of posted) {
          const cur = byLine.get(m.sourceLineId) ?? { value: 0n, status: 'ACTUAL' };
          cur.value += BigInt(m.valuePaise);
          if (m.costStatus === 'MISSING') cur.status = 'MISSING';
          else if (m.costStatus === 'ESTIMATED' && cur.status !== 'MISSING') cur.status = 'ESTIMATED';
          byLine.set(m.sourceLineId, cur);
        }
        const total = [...byLine.values()].reduce((a, v) => a + v.value, 0n);

        return tx.stockWastage.create({
          data: {
            companyId: req.companyScope.id,
            number,
            locationId: location.id,
            reason: data.reason,
            note: data.note,
            // Negative: this is value leaving. Reported as a loss, not a cost.
            totalValuePaise: total,
            idempotencyKey: key,
            createdById: req.user.id,
            lines: {
              create: prepared.flatMap((p) =>
                p.picks.map((pick) => ({
                  itemId: p.item.id,
                  enteredQty: p.enteredQty,
                  enteredUnit: p.unit,
                  qtyBase: milliToQty(pick.milli),
                  batchId: pick.batchId,
                  valuePaise: byLine.get(`${p.idx}`)?.value ?? 0n,
                  costStatus: byLine.get(`${p.idx}`)?.status ?? 'MISSING',
                })),
              ),
            },
          },
          include: { lines: true, location: { select: { id: true, name: true } } },
        });
      });
    } catch (e) {
      if (e?.code === 'P2002' && data.idempotencyKey) {
        const existing = await prisma.stockWastage.findFirst({
          where: { companyId: req.companyScope.id, idempotencyKey: data.idempotencyKey },
          include: { lines: true, location: { select: { id: true, name: true } } },
        });
        if (existing) {
          return res.status(200).json({
            wastage: { id: existing.id, number: existing.number, totalValuePaise: String(existing.totalValuePaise) },
            duplicate: true,
          });
        }
      }
      throw e;
    }

    await audit(req, {
      action: 'INVENTORY_WASTAGE_POST',
      entity: 'StockWastage',
      entityId: wastage.id,
      companyId: req.companyScope.id,
      meta: { number: wastage.number, reason: data.reason, note: data.note, valuePaise: String(wastage.totalValuePaise) },
    });
    res.status(201).json({
      wastage: {
        id: wastage.id,
        number: wastage.number,
        reason: wastage.reason,
        location: wastage.location,
        totalValuePaise: String(wastage.totalValuePaise),
        lines: wastage.lines.map((l) => ({
          itemId: l.itemId,
          qtyBase: qtyOut(l.qtyBase),
          batchId: l.batchId,
          valuePaise: String(l.valuePaise),
          costStatus: l.costStatus,
        })),
      },
    });
  }),
);

router.get(
  '/wastage',
  requireInventoryAction('inventory.wastage.post'),
  asyncHandler(async (req, res) => {
    const { locationId, from, to } = req.query;
    if (locationId) await loadLocationInScope(prisma, req, String(locationId));
    const rows = await prisma.stockWastage.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(locationId ? { locationId: String(locationId) } : {}),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: new Date(String(from)) } : {}), ...(to ? { lte: new Date(String(to)) } : {}) } }
          : {}),
      },
      include: { location: { select: { id: true, name: true } }, lines: { include: { item: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({
      wastage: rows.map((w) => ({
        id: w.id,
        number: w.number,
        reason: w.reason,
        note: w.note,
        location: w.location,
        createdAt: w.createdAt,
        totalValuePaise: String(w.totalValuePaise),
        lines: w.lines.map((l) => ({
          item: l.item,
          qtyBase: qtyOut(l.qtyBase),
          valuePaise: String(l.valuePaise),
          costStatus: l.costStatus,
        })),
      })),
    });
  }),
);

export default router;
