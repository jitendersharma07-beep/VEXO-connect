// ENTITLEMENT(INVENTORY)
// Store requests and the transfers that fulfil them.
//
// A request and a transfer are two different things and are kept apart on
// purpose. The request is what a store ASKED for; the transfer is what was
// actually put in the van. Storing them as one record is how "we sent it"
// quietly becomes "they got it".
//
// Each stage does exactly one thing to stock, and no stage does two:
//
//   submit    nothing moves, nothing is held
//   approve   nothing moves, nothing is held — a decision, not a promise
//   allocate  source stock is RESERVED, still physically there
//   dispatch  source DECREASES, in-transit increases, reservation settles
//   receive   in-transit decreases, destination increases by what was ACCEPTED
//
// Damage and shortage are recorded as their own issues and have to be
// resolved explicitly. Dispatch is never treated as receipt.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter } from '../../../lib/inventory/permissions.js';
import { postMovementsOnce, lockPosition, LedgerError } from '../../../lib/inventory/ledger.js';
import { batchPositionsAt, selectFefo, reservedByBatchAt } from '../../../lib/inventory/stock.js';
import { milliToQty, qtyToMilli } from '../../../lib/inventory/units.js';
import { nextDocNumber } from '../../../lib/inventory/docnum.js';
import { idemKey, qtyOut, qtyString, reasonString, loadItem, toBase } from './shared.js';
import { dropObsoleteReminders, raiseReminder } from '../../../lib/inventory/reminders.js';

const router = Router();

const REQUEST_INCLUDE = {
  destinationLocation: { select: { id: true, name: true, code: true, branchId: true } },
  sourceLocation: { select: { id: true, name: true, code: true, branchId: true } },
  lines: { include: { item: { select: { id: true, name: true, baseUnit: true } } } },
  issues: true,
  attachments: true,
};

const serializeRequest = (r) => ({
  id: r.id,
  number: r.number,
  status: r.status,
  priority: r.priority,
  requiredBy: r.requiredBy,
  reason: r.reason,
  note: r.note,
  destination: r.destinationLocation,
  source: r.sourceLocation,
  assignedApproverId: r.assignedApproverId,
  originPlanId: r.originPlanId,
  raisedAt: r.raisedAt,
  submittedAt: r.submittedAt,
  decidedAt: r.decidedAt,
  decisionNote: r.decisionNote,
  closedAt: r.closedAt,
  closeReason: r.closeReason,
  lines: (r.lines ?? []).map((l) => ({
    id: l.id,
    item: l.item,
    enteredQty: qtyOut(l.enteredQty),
    enteredUnit: l.enteredUnit,
    requestedQty: qtyOut(l.requestedQty),
    approvedQty: qtyOut(l.approvedQty),
    allocatedQty: qtyOut(l.allocatedQty),
    dispatchedQty: qtyOut(l.dispatchedQty),
    acceptedQty: qtyOut(l.acceptedQty),
    damagedQty: qtyOut(l.damagedQty),
    shortageQty: qtyOut(l.shortageQty),
    outstandingQty: qtyOut(l.outstandingQty),
    rejectedReason: l.rejectedReason,
    note: l.note,
  })),
  issues: (r.issues ?? []).map((i) => ({
    id: i.id,
    kind: i.kind,
    requestLineId: i.requestLineId,
    qty: String(i.qty),
    valuePaise: String(i.valuePaise),
    note: i.note,
    raisedAt: i.raisedAt,
    resolution: i.resolution,
    resolutionNote: i.resolutionNote,
    resolvedAt: i.resolvedAt,
  })),
  attachments: (r.attachments ?? []).map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    byteSize: a.byteSize,
    url: a.url,
    uploadedAt: a.uploadedAt,
  })),
});

const logEvent = (tx, requestId, action, from, to, actor, detail) =>
  tx.storeRequestEvent.create({
    data: {
      requestId,
      action,
      fromStatus: from ?? null,
      toStatus: to ?? null,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      detail: detail ?? undefined,
    },
  });

// A request the caller is allowed to see at all: either end of it has to be
// in their scope, because a store manager follows their own request into the
// warehouse and a warehouse operator sees what is being asked of them.
const loadRequestInScope = async (req, requestId, { need = 'view' } = {}) => {
  const request = await prisma.storeRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE });
  if (!request || request.companyId !== req.companyScope.id) throw notFound('Request not found');

  const scope = await locationScopeFilter(prisma, req);
  const reachable = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
  const ids = new Set(reachable.map((r) => r.id));
  if (!ids.has(request.destinationLocationId) && !(request.sourceLocationId && ids.has(request.sourceLocationId))) {
    throw notFound('Request not found');
  }
  if (need !== 'view' && request.sourceLocationId) {
    await loadLocationInScope(prisma, req, request.sourceLocationId, need);
  }
  return request;
};

/* ------------------------------------------------------------------- create */

const lineInput = z.object({
  itemId: z.string().cuid(),
  qty: qtyString,
  unit: z.string().trim().min(1).max(40),
  note: z.string().trim().max(300).optional(),
});

const createSchema = z.object({
  destinationLocationId: z.string().cuid(),
  sourceLocationId: z.string().cuid().nullish(),
  requiredBy: z.coerce.date(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).optional(),
  assignedApproverId: z.string().cuid().nullish(),
  lines: z.array(lineInput).min(1).max(200),
  attachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(200),
        url: z.string().trim().url().max(500),
        contentType: z.string().trim().max(120).optional(),
        byteSize: z.number().int().min(0).max(50_000_000).optional(),
      }),
    )
    .max(10)
    .optional(),
  submit: z.boolean().optional(),
  idempotencyKey: idemKey,
  // Set by the replenishment planner so the same requirement cannot be
  // requested twice. Held unique per company at the database.
  requirementKey: z.string().trim().max(200).optional(),
});

router.post(
  '/requests',
  requireInventoryAction('inventory.request.create'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const destination = await loadLocationInScope(prisma, req, data.destinationLocationId, 'receive');

    let source = null;
    if (data.sourceLocationId) {
      // The source need NOT be in the caller's scope: a store manager is
      // allowed to ask the warehouse for stock they cannot themselves touch.
      source = await prisma.inventoryLocation.findUnique({ where: { id: data.sourceLocationId } });
      if (!source || source.companyId !== req.companyScope.id) throw notFound('Source location not found');
      if (source.id === destination.id) throw badRequest('A location cannot request stock from itself');
    }

    const prepared = [];
    const seen = new Set();
    for (const [i, line] of data.lines.entries()) {
      const item = await loadItem(prisma, req.companyScope.id, line.itemId);
      if (seen.has(item.id)) throw badRequest(`${item.name} appears twice; combine the quantities into one line`);
      seen.add(item.id);
      const { baseMilli, factorMilli } = toBase(item, line.qty, line.unit);
      if (baseMilli <= 0) throw badRequest(`Line ${i + 1} must request more than nothing`);
      prepared.push({
        itemId: item.id,
        enteredQty: String(line.qty),
        enteredUnit: line.unit.trim().toLowerCase(),
        // The factor is frozen onto the line. Redefining "case" next year
        // changes the next request and nothing about this one.
        enteredFactorMilli: factorMilli,
        requestedQty: milliToQty(baseMilli),
        outstandingQty: milliToQty(baseMilli),
        note: line.note ?? null,
      });
    }

    const submitting = data.submit !== false;

    let request;
    try {
      request = await prisma.$transaction(async (tx) => {
        const number = await nextDocNumber(tx, req.companyScope.id, 'REQUEST');
        const created = await tx.storeRequest.create({
          data: {
            companyId: req.companyScope.id,
            number,
            destinationLocationId: destination.id,
            sourceLocationId: source?.id ?? null,
            status: submitting ? 'SUBMITTED' : 'DRAFT',
            priority: data.priority ?? 'NORMAL',
            requiredBy: data.requiredBy,
            reason: data.reason ?? null,
            note: data.note ?? null,
            assignedApproverId: data.assignedApproverId ?? null,
            raisedById: req.user.id,
            submittedAt: submitting ? new Date() : null,
            requirementKey: data.requirementKey ?? null,
            idempotencyKey: data.idempotencyKey ?? null,
            lines: { create: prepared },
            ...(data.attachments?.length
              ? { attachments: { create: data.attachments.map((a) => ({ ...a, uploadedById: req.user.id })) } }
              : {}),
          },
          include: REQUEST_INCLUDE,
        });
        await logEvent(tx, created.id, submitting ? 'SUBMIT' : 'CREATE', null, created.status, req.user, {
          lines: prepared.length,
        });
        return created;
      });
    } catch (e) {
      // A double-clicked submit or a retried planner run lands here. Return
      // the request that already exists rather than making a second one.
      if (e?.code === 'P2002') {
        const target = Array.isArray(e.meta?.target) ? e.meta.target.join(',') : String(e.meta?.target ?? '');
        const where = target.includes('requirementKey')
          ? { companyId: req.companyScope.id, requirementKey: data.requirementKey }
          : { companyId: req.companyScope.id, idempotencyKey: data.idempotencyKey };
        const existing = await prisma.storeRequest.findFirst({ where, include: REQUEST_INCLUDE });
        if (existing) return res.status(200).json({ request: serializeRequest(existing), duplicate: true });
      }
      throw e;
    }

    if (submitting) {
      await raiseReminder(prisma, {
        companyId: req.companyScope.id,
        kind: 'PENDING_APPROVAL',
        requestId: request.id,
        locationId: source?.id ?? destination.id,
        dueAt: request.requiredBy,
        assigneeId: request.assignedApproverId,
        subject: `Request ${request.number} is waiting for a decision`,
      });
    }

    await audit(req, {
      action: 'INVENTORY_REQUEST_CREATE',
      entity: 'StoreRequest',
      entityId: request.id,
      companyId: req.companyScope.id,
      meta: { number: request.number, status: request.status, lines: prepared.length },
    });
    res.status(201).json({ request: serializeRequest(request) });
  }),
);

/* --------------------------------------------------------------------- list */

router.get(
  '/requests',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const scope = await locationScopeFilter(prisma, req);
    const reachable = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const ids = reachable.map((r) => r.id);
    const { status, mine } = req.query;

    const requests = await prisma.storeRequest.findMany({
      where: {
        companyId: req.companyScope.id,
        OR: [{ destinationLocationId: { in: ids } }, { sourceLocationId: { in: ids } }],
        ...(status ? { status: { in: String(status).split(',') } } : {}),
        ...(mine === 'true' ? { assignedApproverId: req.user.id } : {}),
      },
      include: REQUEST_INCLUDE,
      orderBy: [{ requiredBy: 'asc' }, { raisedAt: 'desc' }],
      take: 200,
    });
    res.json({ requests: requests.map(serializeRequest) });
  }),
);

// The approval queue: what is waiting on this person, soonest first.
router.get(
  '/requests/queue',
  requireInventoryAction('inventory.request.approve'),
  asyncHandler(async (req, res) => {
    const scope = await locationScopeFilter(prisma, req);
    const reachable = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const ids = reachable.map((r) => r.id);
    const requests = await prisma.storeRequest.findMany({
      where: {
        companyId: req.companyScope.id,
        status: 'SUBMITTED',
        OR: [{ sourceLocationId: { in: ids } }, { sourceLocationId: null, destinationLocationId: { in: ids } }],
      },
      include: REQUEST_INCLUDE,
      orderBy: [{ priority: 'desc' }, { requiredBy: 'asc' }],
      take: 100,
    });
    res.json({ requests: requests.map(serializeRequest) });
  }),
);

router.get(
  '/requests/:requestId',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const request = await loadRequestInScope(req, req.params.requestId);
    const events = await prisma.storeRequestEvent.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: 'asc' },
    });
    const transfers = await prisma.stockTransfer.findMany({
      where: { storeRequestId: request.id },
      include: { lines: { include: { batches: true } } },
    });
    res.json({
      request: serializeRequest(request),
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorId: e.actorId,
        actorRole: e.actorRole,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
      transfers: transfers.map((t) => ({
        id: t.id,
        number: t.number,
        status: t.status,
        dispatchedAt: t.dispatchedAt,
        receivedAt: t.receivedAt,
        lines: t.lines.map((l) => ({
          id: l.id,
          itemId: l.itemId,
          requestedQty: qtyOut(l.requestedQty),
          dispatchedQty: qtyOut(l.dispatchedQty),
          acceptedQty: qtyOut(l.acceptedQty),
          damagedQty: qtyOut(l.damagedQty),
          shortageQty: qtyOut(l.shortageQty),
          batches: l.batches.map((b) => ({ batchId: b.batchId, dispatchedQty: qtyOut(b.dispatchedQty) })),
        })),
      })),
    });
  }),
);

/* ------------------------------------------------------------------- submit */

router.post(
  '/requests/:requestId/submit',
  requireInventoryAction('inventory.request.create'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const request = await loadRequestInScope(req, req.params.requestId);
    if (request.status !== 'DRAFT') throw conflict(`That request is already ${request.status.toLowerCase()}`);

    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.storeRequest.update({
        where: { id: request.id },
        data: { status: 'SUBMITTED', submittedAt: new Date() },
        include: REQUEST_INCLUDE,
      });
      await logEvent(tx, request.id, 'SUBMIT', 'DRAFT', 'SUBMITTED', req.user);
      return r;
    });
    await raiseReminder(prisma, {
      companyId: req.companyScope.id,
      kind: 'PENDING_APPROVAL',
      requestId: request.id,
      locationId: request.sourceLocationId ?? request.destinationLocationId,
      dueAt: request.requiredBy,
      assigneeId: request.assignedApproverId,
      subject: `Request ${request.number} is waiting for a decision`,
    });
    res.json({ request: serializeRequest(updated) });
  }),
);

/* ------------------------------------------------------------------- decide */

const decideSchema = z.object({
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().cuid(),
        // Approving less than was asked for is normal and is recorded as its
        // own number; the requested quantity is never overwritten.
        approvedQty: qtyString,
        rejectedReason: z.string().trim().max(300).optional(),
      }),
    )
    .min(1),
});

router.post(
  '/requests/:requestId/decide',
  requireInventoryAction('inventory.request.approve'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const request = await loadRequestInScope(req, req.params.requestId, { need: 'approve' });
    const data = decideSchema.parse(req.body);
    if (request.status !== 'SUBMITTED') {
      throw conflict(`Only a submitted request can be decided; this one is ${request.status.toLowerCase()}`);
    }
    // Deciding your own request is not a second pair of eyes. A role list
    // cannot express "not you", so it is checked here.
    if (request.raisedById === req.user.id && req.user.role !== 'CUSTOMER_OWNER') {
      throw forbidden('You cannot approve a request you raised yourself');
    }

    const byId = new Map(request.lines.map((l) => [l.id, l]));
    const updates = [];
    let approvedAny = false;
    let reducedAny = false;
    for (const d of data.lines) {
      const line = byId.get(d.lineId);
      if (!line) throw badRequest('That line is not on this request');
      const approvedMilli = qtyToMilli(d.approvedQty);
      const requestedMilli = qtyToMilli(line.requestedQty);
      if (approvedMilli > requestedMilli) {
        throw badRequest(`You cannot approve more than was asked for on ${line.itemId}`);
      }
      if (approvedMilli > 0) approvedAny = true;
      if (approvedMilli < requestedMilli) reducedAny = true;
      updates.push({
        id: line.id,
        approvedQty: milliToQty(approvedMilli),
        outstandingQty: milliToQty(approvedMilli),
        rejectedReason: approvedMilli < requestedMilli ? (d.rejectedReason ?? null) : null,
      });
    }
    if (updates.length !== request.lines.length) {
      throw badRequest('Every line needs a decision; approve a line at zero to refuse it');
    }

    const status = !approvedAny ? 'REJECTED' : reducedAny ? 'PARTIALLY_APPROVED' : 'APPROVED';

    const updated = await prisma.$transaction(async (tx) => {
      for (const u of updates) {
        await tx.storeRequestLine.update({ where: { id: u.id }, data: u });
      }
      const r = await tx.storeRequest.update({
        where: { id: request.id },
        data: { status, decidedById: req.user.id, decidedAt: new Date(), decisionNote: data.note ?? null },
        include: REQUEST_INCLUDE,
      });
      await logEvent(tx, request.id, 'DECIDE', request.status, status, req.user, {
        approved: updates.map((u) => ({ lineId: u.id, approvedQty: u.approvedQty })),
      });
      return r;
    });

    // The approval reminder is now pointless; the dispatch one is not.
    await dropObsoleteReminders(prisma, { requestId: request.id, kinds: ['PENDING_APPROVAL'] });
    if (status !== 'REJECTED') {
      await raiseReminder(prisma, {
        companyId: req.companyScope.id,
        kind: 'DISPATCH_DUE',
        requestId: request.id,
        locationId: request.sourceLocationId ?? request.destinationLocationId,
        dueAt: request.requiredBy,
        subject: `Request ${request.number} is approved and waiting to be dispatched`,
      });
    }

    await audit(req, {
      action: 'INVENTORY_REQUEST_DECIDE',
      entity: 'StoreRequest',
      entityId: request.id,
      companyId: req.companyScope.id,
      meta: { number: request.number, status, lines: updates.length },
    });
    res.json({ request: serializeRequest(updated) });
  }),
);

/* ----------------------------------------------------------------- allocate */

// Reserving holds stock at the source without moving it. The reservation is
// per batch, so the FEFO promise made today is the batch that actually leaves
// tomorrow — not whatever happens to be nearest its expiry by then.
router.post(
  '/requests/:requestId/allocate',
  requireInventoryAction('inventory.transfer.dispatch'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const request = await loadRequestInScope(req, req.params.requestId, { need: 'dispatch' });
    if (!request.sourceLocationId) throw badRequest('That request has no source location to allocate from');
    if (!['APPROVED', 'PARTIALLY_APPROVED', 'IN_FULFILMENT'].includes(request.status)) {
      throw conflict(`A request must be approved before it can be allocated; this one is ${request.status.toLowerCase()}`);
    }

    const results = [];
    await prisma.$transaction(async (tx) => {
      // Lines in a stable order, so two requests covering the same two items
      // take the two position locks the same way round and cannot deadlock by
      // each holding what the other is waiting for.
      const ordered = [...request.lines].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
      for (const line of ordered) {
        const wantMilli = qtyToMilli(line.approvedQty ?? line.requestedQty) - qtyToMilli(line.allocatedQty);
        if (wantMilli <= 0) continue;

        // Held until this transaction commits. Without it a second allocation
        // reads the same "nothing reserved" and the shelf is promised twice.
        await lockPosition(tx, request.sourceLocationId, line.itemId);

        const positions = await batchPositionsAt(tx, {
          locationId: request.sourceLocationId,
          itemId: line.itemId,
        });
        const reserved = await reservedByBatchAt(tx, { locationId: request.sourceLocationId, itemId: line.itemId });
        const picked = selectFefo(positions, wantMilli, reserved);
        const takenMilli = picked.picks.reduce((a, p) => a + p.qtyMilli, 0);

        if (takenMilli > 0) {
          const reservation = await tx.stockReservation.create({
            data: {
              companyId: request.companyId,
              locationId: request.sourceLocationId,
              itemId: line.itemId,
              qty: milliToQty(takenMilli),
              state: 'HELD',
              sourceType: 'STORE_REQUEST_LINE',
              sourceId: line.id,
              // One reservation per line per attempt; a retry that finds the
              // same key reserves nothing further.
              idempotencyKey: `res:${line.id}:${qtyToMilli(line.allocatedQty)}`,
              heldById: req.user.id,
              lines: {
                create: picked.picks.map((p) => ({ batchId: p.batchId, qty: milliToQty(p.qtyMilli) })),
              },
            },
          });
          await tx.storeRequestLine.update({
            where: { id: line.id },
            data: { allocatedQty: milliToQty(qtyToMilli(line.allocatedQty) + takenMilli) },
          });
          results.push({
            lineId: line.id,
            reservationId: reservation.id,
            allocated: milliToQty(takenMilli),
            short: milliToQty(picked.shortMilli),
            blocked: milliToQty(picked.blockedMilli),
          });
        } else {
          results.push({
            lineId: line.id,
            reservationId: null,
            allocated: '0.000',
            short: milliToQty(picked.shortMilli),
            blocked: milliToQty(picked.blockedMilli),
          });
        }
      }
      await logEvent(tx, request.id, 'ALLOCATE', request.status, request.status, req.user, { results });
    });

    await audit(req, {
      action: 'INVENTORY_REQUEST_ALLOCATE',
      entity: 'StoreRequest',
      entityId: request.id,
      companyId: req.companyScope.id,
      meta: { number: request.number, lines: results.length },
    });
    const fresh = await prisma.storeRequest.findUnique({ where: { id: request.id }, include: REQUEST_INCLUDE });
    res.json({ request: serializeRequest(fresh), allocation: results });
  }),
);

/* ----------------------------------------------------------------- dispatch */

const dispatchSchema = z.object({
  note: z.string().trim().max(500).optional(),
  idempotencyKey: idemKey,
  // Omitted means "dispatch everything that is allocated".
  lines: z.array(z.object({ lineId: z.string().cuid(), qty: qtyString })).optional(),
});

router.post(
  '/requests/:requestId/dispatch',
  requireInventoryAction('inventory.transfer.dispatch'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const request = await loadRequestInScope(req, req.params.requestId, { need: 'dispatch' });
    const data = dispatchSchema.parse(req.body);
    if (!request.sourceLocationId) throw badRequest('That request has no source location to dispatch from');
    if (!['APPROVED', 'PARTIALLY_APPROVED', 'IN_FULFILMENT'].includes(request.status)) {
      throw conflict(`That request is ${request.status.toLowerCase()} and cannot be dispatched`);
    }

    const wanted = new Map((data.lines ?? []).map((l) => [l.lineId, qtyToMilli(l.qty)]));

    let transfer;
    try {
      transfer = await prisma.$transaction(async (tx) => {
        const number = await nextDocNumber(tx, request.companyId, 'TRANSFER');
        const created = await tx.stockTransfer.create({
          data: {
            companyId: request.companyId,
            number,
            fromLocationId: request.sourceLocationId,
            toLocationId: request.destinationLocationId,
            status: 'DISPATCHED',
            storeRequestId: request.id,
            note: data.note ?? null,
            requestedById: request.raisedById,
            dispatchedById: req.user.id,
            dispatchedAt: new Date(),
            idempotencyKey: data.idempotencyKey ?? null,
          },
        });

        const movements = [];
        let dispatchedLines = 0;

        for (const line of request.lines) {
          const reservations = await tx.stockReservation.findMany({
            where: { sourceType: 'STORE_REQUEST_LINE', sourceId: line.id, state: 'HELD' },
            include: { lines: true },
          });
          const heldByBatch = new Map();
          for (const r of reservations) {
            for (const rl of r.lines) {
              heldByBatch.set(rl.batchId, (heldByBatch.get(rl.batchId) ?? 0) + qtyToMilli(rl.qty));
            }
          }
          const heldMilli = [...heldByBatch.values()].reduce((a, v) => a + v, 0);
          const askMilli = wanted.has(line.id) ? wanted.get(line.id) : heldMilli;
          if (askMilli <= 0) continue;
          if (askMilli > heldMilli) {
            throw conflict(`Only ${milliToQty(heldMilli)} is allocated on that line; allocate more before dispatching`);
          }

          // Spend the reserved batches in FEFO order, which is the order they
          // were reserved in.
          const positions = await batchPositionsAt(tx, { locationId: request.sourceLocationId, itemId: line.itemId });
          const order = positions.filter((p) => heldByBatch.has(p.batchId));
          let remaining = askMilli;
          const takes = [];
          for (const p of order) {
            if (remaining <= 0) break;
            const take = Math.min(heldByBatch.get(p.batchId), remaining);
            if (take <= 0) continue;
            takes.push({ batchId: p.batchId, qtyMilli: take });
            remaining -= take;
          }
          if (remaining > 0) throw conflict('The reserved batches no longer cover that quantity');

          const transferLine = await tx.stockTransferLine.create({
            data: {
              transferId: created.id,
              itemId: line.itemId,
              storeRequestLineId: line.id,
              requestedQty: line.requestedQty,
              dispatchedQty: milliToQty(askMilli),
              batches: { create: takes.map((t) => ({ batchId: t.batchId, dispatchedQty: milliToQty(t.qtyMilli) })) },
            },
          });
          dispatchedLines += 1;

          for (const t of takes) {
            movements.push({
              locationId: request.sourceLocationId,
              itemId: line.itemId,
              batchId: t.batchId,
              type: 'TRANSFER_OUT',
              qtyMilli: -t.qtyMilli,
              sourceType: 'TRANSFER',
              sourceId: created.id,
              sourceLineId: transferLine.id,
              idempotencyKey: `trf-out:${created.id}:${transferLine.id}:${t.batchId}`,
              occurredAt: created.dispatchedAt,
              createdById: req.user.id,
            });
          }

          await tx.storeRequestLine.update({
            where: { id: line.id },
            data: {
              dispatchedQty: milliToQty(qtyToMilli(line.dispatchedQty) + askMilli),
              allocatedQty: milliToQty(Math.max(qtyToMilli(line.allocatedQty) - askMilli, 0)),
            },
          });
          // The hold has become a real movement; it is no longer a hold.
          await tx.stockReservation.updateMany({
            where: { sourceType: 'STORE_REQUEST_LINE', sourceId: line.id, state: 'HELD' },
            data: { state: 'CONSUMED', settledAt: new Date() },
          });
        }

        if (!dispatchedLines) throw badRequest('Nothing is allocated on this request yet');

        const posted = await postMovementsOnce(tx, { companyId: request.companyId, movements });
        // The value that left the source is what the in-transit stock is
        // worth; the destination will take it in at exactly this figure.
        const byLine = new Map();
        for (const m of posted.movements) {
          byLine.set(m.sourceLineId, (byLine.get(m.sourceLineId) ?? 0n) + -BigInt(m.valuePaise));
        }
        for (const [lineId, value] of byLine) {
          await tx.stockTransferLine.update({ where: { id: lineId }, data: { dispatchValuePaise: value } });
        }

        await tx.storeRequest.update({ where: { id: request.id }, data: { status: 'IN_FULFILMENT' } });
        await logEvent(tx, request.id, 'DISPATCH', request.status, 'IN_FULFILMENT', req.user, {
          transferId: created.id,
          number: created.number,
        });
        return created;
      });
    } catch (e) {
      if (e instanceof LedgerError) throw conflict(e.message);
      if (e?.code === 'P2002' && data.idempotencyKey) {
        const existing = await prisma.stockTransfer.findFirst({
          where: { companyId: request.companyId, idempotencyKey: data.idempotencyKey },
        });
        if (existing) {
          return res.status(200).json({ transfer: { id: existing.id, number: existing.number, status: existing.status }, duplicate: true });
        }
      }
      throw e;
    }

    await dropObsoleteReminders(prisma, { requestId: request.id, kinds: ['DISPATCH_DUE'] });
    await raiseReminder(prisma, {
      companyId: request.companyId,
      kind: 'RECEIPT_PENDING',
      requestId: request.id,
      locationId: request.destinationLocationId,
      dueAt: request.requiredBy,
      subject: `Transfer ${transfer.number} is on its way and needs receiving`,
    });

    await audit(req, {
      action: 'INVENTORY_TRANSFER_DISPATCH',
      entity: 'StockTransfer',
      entityId: transfer.id,
      companyId: request.companyId,
      meta: { number: transfer.number, requestNumber: request.number },
    });
    res.status(201).json({ transfer: { id: transfer.id, number: transfer.number, status: transfer.status } });
  }),
);

/* ------------------------------------------------------------------ receive */

const receiveSchema = z.object({
  note: z.string().trim().max(500).optional(),
  idempotencyKey: idemKey,
  lines: z
    .array(
      z.object({
        transferLineId: z.string().cuid(),
        acceptedQty: qtyString,
        damagedQty: qtyString.optional(),
        // Anything dispatched and neither accepted nor damaged is short: it
        // did not arrive. It is recorded, not quietly forgotten.
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1),
});

router.post(
  '/transfers/:transferId/receive',
  requireInventoryAction('inventory.transfer.receive'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = receiveSchema.parse(req.body);
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: req.params.transferId },
      include: { lines: { include: { batches: true, item: true } }, storeRequest: { include: { lines: true } } },
    });
    if (!transfer || transfer.companyId !== req.companyScope.id) throw notFound('Transfer not found');
    await loadLocationInScope(prisma, req, transfer.toLocationId, 'receive');
    if (transfer.status !== 'DISPATCHED') {
      throw conflict(`That transfer is ${transfer.status.toLowerCase()} and cannot be received`);
    }

    const byId = new Map(transfer.lines.map((l) => [l.id, l]));
    const plans = [];
    for (const d of data.lines) {
      const line = byId.get(d.transferLineId);
      if (!line) throw badRequest('That line is not on this transfer');
      const dispatchedMilli = qtyToMilli(line.dispatchedQty ?? '0');
      const acceptedMilli = qtyToMilli(d.acceptedQty);
      const damagedMilli = d.damagedQty ? qtyToMilli(d.damagedQty) : 0;
      if (acceptedMilli + damagedMilli > dispatchedMilli) {
        throw badRequest(`More was reported on ${line.item.name} than was dispatched`);
      }
      plans.push({
        line,
        acceptedMilli,
        damagedMilli,
        shortageMilli: dispatchedMilli - acceptedMilli - damagedMilli,
        note: d.note ?? null,
      });
    }
    if (plans.length !== transfer.lines.length) throw badRequest('Every dispatched line has to be accounted for');

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const movements = [];
        const issues = [];

        for (const p of plans) {
          const dispatchedMilli = qtyToMilli(p.line.dispatchedQty ?? '0');
          const dispatchValue = BigInt(p.line.dispatchValuePaise ?? 0n);
          // Value follows quantity: the accepted share of what left carries
          // the accepted share of what it was worth.
          const share = (milli) => (dispatchedMilli === 0 ? 0n : (dispatchValue * BigInt(milli)) / BigInt(dispatchedMilli));

          // Accepted stock arrives batch by batch, in the proportion it was
          // sent, so the destination inherits the same batches and expiries.
          let leftToAccept = p.acceptedMilli;
          const batchTakes = [];
          for (const [i, b] of p.line.batches.entries()) {
            const sent = qtyToMilli(b.dispatchedQty);
            const take =
              i === p.line.batches.length - 1
                ? leftToAccept
                : Math.min(Math.round((p.acceptedMilli * sent) / (dispatchedMilli || 1)), leftToAccept);
            if (take > 0) batchTakes.push({ batchId: b.batchId, qtyMilli: take, row: b });
            leftToAccept -= take;
          }

          for (const t of batchTakes) {
            movements.push({
              locationId: transfer.toLocationId,
              itemId: p.line.itemId,
              batchId: t.batchId,
              type: 'TRANSFER_IN',
              qtyMilli: t.qtyMilli,
              valuePaise: share(t.qtyMilli),
              sourceType: 'TRANSFER',
              sourceId: transfer.id,
              sourceLineId: p.line.id,
              idempotencyKey: `trf-in:${transfer.id}:${p.line.id}:${t.batchId}`,
              occurredAt: new Date(),
              createdById: req.user.id,
            });
            await tx.stockTransferLineBatch.update({
              where: { id: t.row.id },
              data: { acceptedQty: milliToQty(t.qtyMilli) },
            });
          }

          await tx.stockTransferLine.update({
            where: { id: p.line.id },
            data: {
              acceptedQty: milliToQty(p.acceptedMilli),
              acceptedValuePaise: share(p.acceptedMilli),
              damagedQty: milliToQty(p.damagedMilli),
              damagedValuePaise: share(p.damagedMilli),
              shortageQty: milliToQty(p.shortageMilli),
              shortageValuePaise: share(p.shortageMilli),
            },
          });

          if (p.line.storeRequestLineId) {
            const rl = transfer.storeRequest?.lines.find((l) => l.id === p.line.storeRequestLineId);
            if (rl) {
              const approved = qtyToMilli(rl.approvedQty ?? rl.requestedQty);
              const accepted = qtyToMilli(rl.acceptedQty) + p.acceptedMilli;
              await tx.storeRequestLine.update({
                where: { id: rl.id },
                data: {
                  acceptedQty: milliToQty(accepted),
                  damagedQty: milliToQty(qtyToMilli(rl.damagedQty) + p.damagedMilli),
                  shortageQty: milliToQty(qtyToMilli(rl.shortageQty) + p.shortageMilli),
                  // What the store is still owed. Damage and shortage stay
                  // outstanding until somebody decides what to do about them.
                  outstandingQty: milliToQty(Math.max(approved - accepted, 0)),
                },
              });
              for (const [kind, milli] of [
                ['DAMAGE', p.damagedMilli],
                ['SHORTAGE', p.shortageMilli],
              ]) {
                if (milli <= 0) continue;
                const issue = await tx.storeRequestIssue.create({
                  data: {
                    companyId: transfer.companyId,
                    requestId: transfer.storeRequestId,
                    requestLineId: rl.id,
                    kind,
                    qty: milliToQty(milli),
                    valuePaise: share(milli),
                    note: p.note,
                    raisedById: req.user.id,
                  },
                });
                issues.push(issue);
              }
            }
          }
        }

        await postMovementsOnce(tx, { companyId: transfer.companyId, movements });

        // Stock that was dispatched and never accepted has left the source and
        // arrived nowhere. It is written off against the in-transit position
        // so the two sides of the ledger still add up, and the issue above is
        // what makes someone deal with it.
        const strandedMovements = [];
        for (const p of plans) {
          const stranded = p.damagedMilli + p.shortageMilli;
          if (stranded <= 0) continue;
          strandedMovements.push({
            locationId: transfer.toLocationId,
            itemId: p.line.itemId,
            type: 'TRANSFER_IN',
            qtyMilli: stranded,
            valuePaise: (BigInt(p.line.dispatchValuePaise ?? 0n) * BigInt(stranded)) /
              BigInt(qtyToMilli(p.line.dispatchedQty ?? '0') || 1),
            sourceType: 'TRANSFER',
            sourceId: transfer.id,
            sourceLineId: p.line.id,
            idempotencyKey: `trf-in-loss:${transfer.id}:${p.line.id}`,
            occurredAt: new Date(),
            createdById: req.user.id,
          });
          strandedMovements.push({
            locationId: transfer.toLocationId,
            itemId: p.line.itemId,
            type: 'WASTAGE',
            qtyMilli: -stranded,
            sourceType: 'TRANSFER',
            sourceId: transfer.id,
            sourceLineId: p.line.id,
            idempotencyKey: `trf-loss:${transfer.id}:${p.line.id}`,
            occurredAt: new Date(),
            createdById: req.user.id,
            note: 'Dispatched but not accepted at receipt',
          });
        }
        if (strandedMovements.length) {
          await postMovementsOnce(tx, { companyId: transfer.companyId, movements: strandedMovements });
        }

        const updatedTransfer = await tx.stockTransfer.update({
          where: { id: transfer.id },
          data: { status: 'RECEIVED', receivedById: req.user.id, receivedAt: new Date() },
        });

        let requestStatus = null;
        if (transfer.storeRequestId) {
          const lines = await tx.storeRequestLine.findMany({ where: { requestId: transfer.storeRequestId } });
          const outstanding = lines.reduce((a, l) => a + qtyToMilli(l.outstandingQty), 0);
          requestStatus = outstanding === 0 ? 'FULFILLED' : 'IN_FULFILMENT';
          await tx.storeRequest.update({
            where: { id: transfer.storeRequestId },
            data: {
              status: requestStatus,
              ...(outstanding === 0 ? { closedAt: new Date(), closedById: req.user.id } : {}),
            },
          });
          await logEvent(tx, transfer.storeRequestId, 'RECEIVE', 'IN_FULFILMENT', requestStatus, req.user, {
            transferId: transfer.id,
            issues: issues.length,
          });
        }

        return { transfer: updatedTransfer, issues, requestStatus };
      });
    } catch (e) {
      if (e instanceof LedgerError) throw conflict(e.message);
      throw e;
    }

    if (transfer.storeRequestId) {
      await dropObsoleteReminders(prisma, { requestId: transfer.storeRequestId, kinds: ['RECEIPT_PENDING', 'DELIVERY_OVERDUE'] });
      if (result.requestStatus === 'FULFILLED') {
        await dropObsoleteReminders(prisma, { requestId: transfer.storeRequestId });
      }
      for (const issue of result.issues) {
        await raiseReminder(prisma, {
          companyId: transfer.companyId,
          kind: 'UNRESOLVED_SHORTAGE',
          requestId: transfer.storeRequestId,
          issueId: issue.id,
          locationId: transfer.toLocationId,
          dueAt: new Date(Date.now() + 86400000),
          subject: `${issue.kind === 'DAMAGE' ? 'Damage' : 'Shortage'} of ${issue.qty} on ${transfer.number} needs resolving`,
        });
      }
    }

    await audit(req, {
      action: 'INVENTORY_TRANSFER_RECEIVE',
      entity: 'StockTransfer',
      entityId: transfer.id,
      companyId: transfer.companyId,
      meta: { number: transfer.number, issues: result.issues.length, requestStatus: result.requestStatus },
    });
    res.json({
      transfer: { id: result.transfer.id, number: result.transfer.number, status: result.transfer.status },
      issues: result.issues.map((i) => ({ id: i.id, kind: i.kind, qty: qtyOut(i.qty) })),
      requestStatus: result.requestStatus,
    });
  }),
);

/* ---------------------------------------------------------------- transfers */

const serializeTransfer = (t) => ({
  id: t.id,
  number: t.number,
  status: t.status,
  fromLocation: t.fromLocation,
  toLocation: t.toLocation,
  storeRequestId: t.storeRequestId,
  note: t.note,
  dispatchedAt: t.dispatchedAt,
  receivedAt: t.receivedAt,
  lines: (t.lines ?? []).map((l) => ({
    id: l.id,
    item: l.item,
    requestedQty: qtyOut(l.requestedQty),
    dispatchedQty: qtyOut(l.dispatchedQty),
    acceptedQty: qtyOut(l.acceptedQty),
    damagedQty: qtyOut(l.damagedQty),
    shortageQty: qtyOut(l.shortageQty),
    batches: (l.batches ?? []).map((b) => ({
      batchId: b.batchId,
      batchCode: b.batch?.batchCode ?? null,
      expiryDate: b.batch?.expiryDate ?? null,
      dispatchedQty: qtyOut(b.dispatchedQty),
      acceptedQty: qtyOut(b.acceptedQty),
    })),
  })),
});

const TRANSFER_INCLUDE = {
  fromLocation: { select: { id: true, name: true, code: true } },
  toLocation: { select: { id: true, name: true, code: true } },
  lines: {
    include: {
      item: { select: { id: true, name: true, baseUnit: true } },
      batches: { include: { batch: { select: { batchCode: true, expiryDate: true } } } },
    },
  },
};

// Either end is enough to see it: the warehouse watches what it sent and the
// store watches what is coming. A transfer neither end can reach is invisible.
const transferScopeFilter = async (req) => {
  const scope = await locationScopeFilter(prisma, req);
  const reachable = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
  const ids = reachable.map((r) => r.id);
  return { companyId: req.companyScope.id, OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }] };
};

router.get(
  '/transfers',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const where = await transferScopeFilter(req);
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    const transfers = await prisma.stockTransfer.findMany({
      where,
      include: TRANSFER_INCLUDE,
      orderBy: { requestedAt: 'desc' },
      take: 200,
    });
    res.json({ transfers: transfers.map(serializeTransfer) });
  }),
);

router.get(
  '/transfers/:transferId',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: req.params.transferId },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer || transfer.companyId !== req.companyScope.id) throw notFound('Transfer not found');
    const where = await transferScopeFilter(req);
    const reachable = await prisma.stockTransfer.count({ where: { ...where, id: transfer.id } });
    if (!reachable) throw notFound('Transfer not found');
    res.json({ transfer: serializeTransfer(transfer) });
  }),
);

/* ------------------------------------------------------------------- issues */

router.get(
  '/issues',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const issues = await prisma.storeRequestIssue.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(req.query.open === 'false' ? {} : { resolvedAt: null }),
      },
      include: {
        request: { select: { id: true, number: true, destinationLocationId: true } },
        requestLine: { include: { item: { select: { id: true, name: true } } } },
      },
      orderBy: { raisedAt: 'asc' },
      take: 200,
    });
    res.json({
      issues: issues.map((i) => ({
        id: i.id,
        kind: i.kind,
        qty: qtyOut(i.qty),
        valuePaise: String(i.valuePaise),
        note: i.note,
        raisedAt: i.raisedAt,
        resolution: i.resolution,
        resolvedAt: i.resolvedAt,
        request: i.request,
        item: i.requestLine.item,
      })),
    });
  }),
);

router.post(
  '/issues/:issueId/resolve',
  requireInventoryAction('inventory.issue.resolve'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        resolution: z.enum(['REPLACED', 'CREDITED', 'WRITTEN_OFF', 'CANCELLED']),
        note: reasonString,
        replacementRequestId: z.string().cuid().nullish(),
      })
      .parse(req.body);

    const issue = await prisma.storeRequestIssue.findUnique({ where: { id: req.params.issueId } });
    if (!issue || issue.companyId !== req.companyScope.id) throw notFound('Issue not found');
    if (issue.resolvedAt) throw conflict('That issue is already resolved');

    const updated = await prisma.storeRequestIssue.update({
      where: { id: issue.id },
      data: {
        resolution: data.resolution,
        resolutionNote: data.note,
        resolvedById: req.user.id,
        resolvedAt: new Date(),
        replacementRequestId: data.replacementRequestId ?? null,
      },
    });
    await dropObsoleteReminders(prisma, { issueId: issue.id });

    await audit(req, {
      action: 'INVENTORY_ISSUE_RESOLVE',
      entity: 'StoreRequestIssue',
      entityId: issue.id,
      companyId: req.companyScope.id,
      meta: { kind: issue.kind, resolution: data.resolution, qty: String(issue.qty) },
    });
    res.json({ issue: { id: updated.id, resolution: updated.resolution, resolvedAt: updated.resolvedAt } });
  }),
);

/* ------------------------------------------------------------ close / cancel */

router.post(
  '/requests/:requestId/close',
  requireInventoryAction('inventory.request.close'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = z.object({ reason: reasonString, cancelOutstanding: z.boolean().optional() }).parse(req.body);
    const request = await loadRequestInScope(req, req.params.requestId, { need: 'approve' });
    if (['CLOSED_SHORT', 'FULFILLED', 'CANCELLED', 'REJECTED'].includes(request.status)) {
      throw conflict(`That request is already ${request.status.toLowerCase()}`);
    }

    const outstanding = request.lines.reduce((a, l) => a + qtyToMilli(l.outstandingQty), 0);
    // Closing a partly fulfilled request silently is how a store ends up
    // waiting forever for something nobody is still sending. Say so.
    if (outstanding > 0 && !data.cancelOutstanding) {
      throw conflict(
        `${milliToQty(outstanding)} is still outstanding. Fulfil it, or close with cancelOutstanding to cancel the rest explicitly.`,
      );
    }

    const status = outstanding > 0 ? 'CLOSED_SHORT' : 'FULFILLED';
    const updated = await prisma.$transaction(async (tx) => {
      if (outstanding > 0) {
        await tx.storeRequestLine.updateMany({ where: { requestId: request.id }, data: { outstandingQty: '0.000' } });
      }
      // Any stock still held for a request nobody is fulfilling goes back.
      await tx.stockReservation.updateMany({
        where: { sourceType: 'STORE_REQUEST_LINE', sourceId: { in: request.lines.map((l) => l.id) }, state: 'HELD' },
        data: { state: 'RELEASED', settledAt: new Date() },
      });
      const r = await tx.storeRequest.update({
        where: { id: request.id },
        data: { status, closedById: req.user.id, closedAt: new Date(), closeReason: data.reason },
        include: REQUEST_INCLUDE,
      });
      await logEvent(tx, request.id, 'CLOSE', request.status, status, req.user, {
        cancelledQty: milliToQty(outstanding),
        reason: data.reason,
      });
      return r;
    });
    await dropObsoleteReminders(prisma, { requestId: request.id });

    await audit(req, {
      action: 'INVENTORY_REQUEST_CLOSE',
      entity: 'StoreRequest',
      entityId: request.id,
      companyId: req.companyScope.id,
      meta: { number: request.number, status, cancelledQty: milliToQty(outstanding), reason: data.reason },
    });
    res.json({ request: serializeRequest(updated) });
  }),
);

router.post(
  '/requests/:requestId/cancel',
  requireInventoryAction('inventory.request.cancel'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: reasonString }).parse(req.body);
    const request = await loadRequestInScope(req, req.params.requestId);
    if (!['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED'].includes(request.status)) {
      throw conflict(`A request that is ${request.status.toLowerCase()} cannot be cancelled`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.stockReservation.updateMany({
        where: { sourceType: 'STORE_REQUEST_LINE', sourceId: { in: request.lines.map((l) => l.id) }, state: 'HELD' },
        data: { state: 'RELEASED', settledAt: new Date() },
      });
      await tx.storeRequestLine.updateMany({
        where: { requestId: request.id },
        data: { outstandingQty: '0.000', allocatedQty: '0.000' },
      });
      const r = await tx.storeRequest.update({
        where: { id: request.id },
        data: { status: 'CANCELLED', cancelledById: req.user.id, cancelledAt: new Date(), cancelReason: reason },
        include: REQUEST_INCLUDE,
      });
      await logEvent(tx, request.id, 'CANCEL', request.status, 'CANCELLED', req.user, { reason });
      return r;
    });
    await dropObsoleteReminders(prisma, { requestId: request.id });

    await audit(req, {
      action: 'INVENTORY_REQUEST_CANCEL',
      entity: 'StoreRequest',
      entityId: request.id,
      companyId: req.companyScope.id,
      meta: { number: request.number, reason },
    });
    res.json({ request: serializeRequest(updated) });
  }),
);

export default router;
