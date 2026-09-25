// VC-103 kitchen backend — stations, routing rules, the live board, item
// state transitions and the supervisor overview. Mounted at /api/kitchen.
//
// Duplicate-event protection is the optimistic `version` lock: every
// transition names the version it was decided on. A replay of the SAME
// decision (same version, same target) finds the work already done and
// answers 200 with the current row; a conflicting decision on a stale
// version is a 409. Regressions are 409s, never writes.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import {
  canTransition, TIMESTAMP_FOR, orderKitchenReady, nextChangeSeq,
} from '../../lib/kitchen.js';
// LANE providers — one call, on the single kitchen write, which cannot throw.
import { onKitchenItemState } from '../../lib/integrations/hooks.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

const operate = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'), requireUsableLicense];
const managerUp = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'), requireUsableLicense];

const callerBranchId = async (req, explicit) => {
  const branchId = req.user.branchId ?? explicit;
  if (!branchId) throw badRequest('branchId is required', 'branchId');
  if (req.user.branchId && explicit && explicit !== req.user.branchId) {
    throw notFound('Branch not found');
  }
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, companyId: req.companyScope.id },
  });
  if (!branch) throw notFound('Branch not found');
  return branch.id;
};

const publicStation = (s) => ({
  id: s.id, name: s.name, sortOrder: s.sortOrder, status: s.status,
  targetPrepSeconds: s.targetPrepSeconds, isDefault: s.defaultForBranch !== null,
});

const publicItem = (i) => ({
  id: i.id, orderId: i.orderId, kotId: i.kotId, orderItemId: i.orderItemId,
  stationId: i.stationId, state: i.state, version: i.version, changeSeq: i.changeSeq,
  targetSeconds: i.targetSeconds,
  queuedAt: i.queuedAt, startedAt: i.startedAt, readyAt: i.readyAt,
  servedAt: i.servedAt, cancelledAt: i.cancelledAt,
  delayReason: i.delayReason ?? null,
  name: i.orderItem?.name, qty: i.orderItem?.qty,
  kotSeq: i.kot?.seq,
});

// --- stations & routing (manager+) -----------------------------------------

router.post('/stations', ...managerUp, asyncHandler(async (req, res) => {
  const body = z.object({
    branchId: z.string().optional(),
    name: z.string().trim().min(1).max(80),
    targetPrepSeconds: z.number().int().positive().max(7200).optional(),
    sortOrder: z.number().int().min(0).optional(),
    isDefault: z.boolean().optional(),
  }).parse(req.body);
  const branchId = await callerBranchId(req, body.branchId);
  const station = await prisma.$transaction(async (tx) => {
    // (branchId, name) is unique. Without this the create raises a raw P2002
    // that nothing catches, and adding a station that already exists answers
    // 500 — the same mistake reads as "the system is broken" instead of
    // "you already have one of these".
    const clash = await tx.kitchenStation.findUnique({
      where: { branchId_name: { branchId, name: body.name } },
    });
    if (clash) throw conflict(`Station "${body.name}" already exists in this branch`);
    if (body.isDefault) {
      await tx.kitchenStation.updateMany({
        where: { defaultForBranch: branchId },
        data: { defaultForBranch: null },
      });
    }
    return tx.kitchenStation.create({
      data: {
        companyId: req.companyScope.id,
        branchId,
        name: body.name,
        targetPrepSeconds: body.targetPrepSeconds ?? 600,
        sortOrder: body.sortOrder ?? 0,
        defaultForBranch: body.isDefault ? branchId : null,
      },
    });
  });
  res.status(201).json({ station: publicStation(station) });
}));

router.get('/stations', asyncHandler(async (req, res) => {
  const branchId = await callerBranchId(req, req.query.branchId);
  const stations = await prisma.kitchenStation.findMany({
    where: { branchId, status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json({ stations: stations.map(publicStation) });
}));

router.post('/routes', ...managerUp, asyncHandler(async (req, res) => {
  const body = z.object({
    stationId: z.string(),
    productId: z.string().optional(),
    categoryId: z.string().optional(),
  }).refine((b) => !!b.productId !== !!b.categoryId, {
    message: 'Exactly one of productId or categoryId',
  }).parse(req.body);
  const station = await prisma.kitchenStation.findFirst({
    where: { id: body.stationId, companyId: req.companyScope.id },
  });
  if (!station) throw notFound('Station not found');
  const matchKey = body.productId ? `product:${body.productId}` : `category:${body.categoryId}`;
  const route = await prisma.kitchenRoute.upsert({
    where: { branchId_matchKey: { branchId: station.branchId, matchKey } },
    update: { stationId: station.id },
    create: {
      companyId: req.companyScope.id,
      branchId: station.branchId,
      stationId: station.id,
      matchKey,
      productId: body.productId ?? null,
      categoryId: body.categoryId ?? null,
      createdById: req.user.id,
    },
  });
  res.status(201).json({ route: { id: route.id, stationId: route.stationId, matchKey: route.matchKey } });
}));

// --- the board (K3/K5) ------------------------------------------------------
// Without sinceSeq: full snapshot of live states + the store's cursor.
// With sinceSeq=N: every row whose changeSeq > N (terminal rows included, so
// a reconnect learns about lines that finished while it was away).

router.get('/stations/:id/board', ...operate, asyncHandler(async (req, res) => {
  const station = await prisma.kitchenStation.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!station) throw notFound('Station not found');
  if (req.user.branchId && req.user.branchId !== station.branchId) throw notFound('Station not found');

  const cursor = await prisma.kitchenCursor.findUnique({ where: { branchId: station.branchId } });
  const lastSeq = cursor?.lastSeq ?? 0;
  const include = { orderItem: { select: { name: true, qty: true } }, kot: { select: { seq: true } } };

  const sinceSeq = req.query.sinceSeq !== undefined ? Number(req.query.sinceSeq) : null;
  if (sinceSeq !== null) {
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) throw badRequest('sinceSeq must be a non-negative integer', 'sinceSeq');
    const items = await prisma.kitchenItem.findMany({
      where: { stationId: station.id, changeSeq: { gt: sinceSeq } },
      orderBy: { changeSeq: 'asc' },
      include,
    });
    return res.json({ seq: lastSeq, items: items.map(publicItem) });
  }

  const items = await prisma.kitchenItem.findMany({
    where: { stationId: station.id, state: { in: ['QUEUED', 'IN_PREP', 'READY'] } },
    orderBy: { queuedAt: 'asc' },
    include,
  });
  res.json({ seq: lastSeq, items: items.map(publicItem) });
}));

// --- the ONLY write (K2/K4) -------------------------------------------------

router.post('/items/:id/state', ...operate, asyncHandler(async (req, res) => {
  const body = z.object({
    to: z.enum(['IN_PREP', 'READY', 'SERVED', 'CANCELLED']),
    version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500).optional(),
  }).parse(req.body);
  if (body.to === 'CANCELLED' && !body.reason) {
    throw badRequest('Cancelling a kitchen item requires a reason', 'reason');
  }

  const item = await prisma.kitchenItem.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!item) throw notFound('Kitchen item not found');
  if (req.user.branchId && req.user.branchId !== item.branchId) throw notFound('Kitchen item not found');

  const finish = async (row, replayed) => {
    await audit(req, {
      action: 'KITCHEN_ITEM_STATE',
      entity: 'KitchenItem',
      entityId: row.id,
      companyId: req.companyScope.id,
      meta: { to: body.to, from: item.state, replayed, ...(body.reason ? { reason: body.reason } : {}) },
    });
    res.json({ item: publicItem(row), replayed });
  };

  // Replay of an applied decision: the version it named has been consumed and
  // the row is exactly where that decision put it → 200, no second write.
  if (item.version === body.version + 1 && item.state === body.to) {
    return finish(item, true);
  }
  if (item.version !== body.version) {
    throw conflict(`Kitchen item changed (version ${item.version}, request named ${body.version})`);
  }
  if (!canTransition(item.state, body.to)) {
    throw conflict(`Cannot move a ${item.state} item to ${body.to}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const seq = await nextChangeSeq(tx, item.branchId);
    const { count } = await tx.kitchenItem.updateMany({
      where: { id: item.id, version: body.version },
      data: {
        state: body.to,
        version: { increment: 1 },
        changeSeq: seq,
        [TIMESTAMP_FOR[body.to]]: new Date(),
        // Cancellation attribution: WHO is lastActorId + the audit row's
        // actor; WHY is the audit meta.reason; WHEN is cancelledAt.
        lastActorId: req.user.id,
      },
    });
    if (count === 0) throw conflict('Kitchen item changed underneath this request');
    return tx.kitchenItem.findUnique({
      where: { id: item.id },
      include: { orderItem: { select: { name: true, qty: true } }, kot: { select: { seq: true } } },
    });
  });
  // LANE providers. Tells an aggregator its order is ready — but only once the
  // LAST line is, which is a question about the whole order and so cannot be
  // answered inside the transaction that moved one line.
  await onKitchenItemState(item.id);
  await finish(updated, false);
}));

// --- supervisor overview (K3) — computed from rows, no cache ---------------

router.get('/overview', ...managerUp, asyncHandler(async (req, res) => {
  const branchId = await callerBranchId(req, req.query.branchId);
  const stations = await prisma.kitchenStation.findMany({
    where: { branchId, status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  const now = Date.now();
  const perStation = await Promise.all(stations.map(async (st) => {
    const [queued, inPrep, oldestQueued] = await Promise.all([
      prisma.kitchenItem.count({ where: { stationId: st.id, state: 'QUEUED' } }),
      prisma.kitchenItem.count({ where: { stationId: st.id, state: 'IN_PREP' } }),
      prisma.kitchenItem.findFirst({
        where: { stationId: st.id, state: 'QUEUED' },
        orderBy: { queuedAt: 'asc' },
        select: { queuedAt: true },
      }),
    ]);
    return {
      stationId: st.id, name: st.name, queued, inPrep,
      oldestQueuedAgeSec: oldestQueued
        ? Math.max(0, Math.round((now - oldestQueued.queuedAt.getTime()) / 1000))
        : null,
    };
  }));

  // Whole-order readiness, derived per query, never stored. orderId is not a
  // Prisma relation (kitchen tables sit beside Core), so scope to open orders
  // with a second query.
  const openOrders = await prisma.order.findMany({
    where: { branchId, status: 'OPEN' },
    select: { id: true },
  });
  const liveItems = await prisma.kitchenItem.findMany({
    where: { branchId, orderId: { in: openOrders.map((o) => o.id) } },
    select: { orderId: true, state: true },
  });
  const byOrder = new Map();
  for (const it of liveItems) {
    if (!byOrder.has(it.orderId)) byOrder.set(it.orderId, []);
    byOrder.get(it.orderId).push({ state: it.state });
  }
  const ordersKitchenReady = [...byOrder.values()].filter(orderKitchenReady).length;

  const cursor = await prisma.kitchenCursor.findUnique({ where: { branchId } });
  res.json({
    stations: perStation,
    ordersKitchenReady,
    lastChangeAt: cursor?.updatedAt ?? null,
    seq: cursor?.lastSeq ?? 0,
  });
}));

export default router;
