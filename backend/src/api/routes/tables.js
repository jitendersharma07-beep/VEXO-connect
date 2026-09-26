// Dining tables — contract §5.2. Reads: every role (pinned roles see their
// own branch). Writes: CUSTOMER_OWNER anywhere, BRANCH_MANAGER in their own
// branch; ATC is read-only here. DELETE retires; a table with an open or
// billed order can neither be retired nor renamed away from under it.
//
// LANE tables adds POST /:id/service — covers and the table's server. That is
// floor work rather than layout work, so it is gated separately (see canServe)
// and resolves the table through the permission scope rather than through
// loadTable's legacy branch pin. Both shapes are deliberate; the note on
// loadTable says why the four original endpoints keep theirs.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit, auditRequired } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  isBranchPinned,
  branchIdFilterFor,
} from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction } from '../../middleware/permissions.js';
import { branchWhereForScope } from '../../lib/permissions.js';
import { num } from '../../lib/orders.js';
import {
  MAX_PAX,
  assertServiceEditable,
  paxAnchorOf,
  publicService,
  resolveWaiter,
  serviceUpdateData,
  waiterTargetsOf,
} from '../../lib/tables/service.js';
import { isDestinationTaken, transferParty } from '../../lib/tables/transfer.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

const canWrite = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'), requireUsableLicense];

// Recording covers and naming the server is not editing the floor plan, so the
// gate is not canWrite. Every role that can work a table is listed, and the
// platform role is NOT — ATC stays read-only in this router, which is the one
// property the role list is here to preserve. requireAction then lets a tenant
// take the capability off a role it does not want doing this.
const canServe = [
  requireRole(
    'CUSTOMER_OWNER',
    'COMPANY_ADMIN',
    'REGIONAL_MANAGER',
    'BRANCH_MANAGER',
    'CASHIER',
    'CAPTAIN',
  ),
  requireUsableLicense,
  loadPermissionContext,
  requireAction('table.service'),
];

// Same list, same reasoning, and separately switchable: a business may well let
// a captain record covers but keep moving parties to a manager, because a
// transfer decides which bill a subsequent round lands on. POS_SUPER_ADMIN is
// absent here for the same reason it is absent everywhere else in this router.
const canTransfer = [
  requireRole(
    'CUSTOMER_OWNER',
    'COMPANY_ADMIN',
    'REGIONAL_MANAGER',
    'BRANCH_MANAGER',
    'CASHIER',
    'CAPTAIN',
  ),
  requireUsableLicense,
  loadPermissionContext,
  requireAction('table.transfer'),
];

const OPEN_STATUSES = ['OPEN', 'BILLED'];
const CURRENT_ORDER_INCLUDE = {
  orders: {
    where: { status: { in: OPEN_STATUSES } },
    select: {
      id: true,
      status: true,
      type: true,
      total: true,
      // LANE tables. Carried on the floor list because "table 6, four covers,
      // Meera" is what the screen is for; a second request per table to learn
      // it would make the 15-second poll on TablesAdmin.jsx cost N+1 queries.
      pax: true,
      waiterId: true,
      waiter: { select: { fullName: true } },
      waiterSetAt: true,
      waiterSetById: true,
    },
    // Oldest first, for the same reason openBillsOf is: `take: 1` with no
    // ordering was right only while a table could hold one open bill. After a
    // split it returns whichever row Postgres happens to hand back, so a floor
    // screen could read the cheque and show `pax: null` for a table of four.
    // Oldest is the anchor — the bill that carries the party's covers.
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
};

const publicTable = (t) => ({
  id: t.id,
  branchId: t.branchId,
  name: t.name,
  capacity: t.capacity,
  status: t.status,
  currentOrder: t.orders?.[0]
    ? {
        id: t.orders[0].id,
        status: t.orders[0].status,
        type: t.orders[0].type,
        total: num(t.orders[0].total),
        // Additive: existing callers read status/type/total and are unaffected.
        service: publicService(t.orders[0]),
      }
    : null,
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const queryBranch = req.query.branchId ? String(req.query.branchId) : null;
    const tables = await prisma.diningTable.findMany({
      where: {
        branch: { companyId: req.companyScope.id },
        ...branchIdFilterFor(req.user),
        ...(!isBranchPinned(req.user) && queryBranch ? { branchId: queryBranch } : {}),
      },
      include: CURRENT_ORDER_INCLUDE,
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
    });
    res.json({ tables: tables.map(publicTable) });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  capacity: z.number().int().min(1).max(99).optional(),
  branchId: z.string().min(1).optional(),
});

router.post(
  '/',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const branchId = isBranchPinned(req.user) ? req.user.branchId : data.branchId;
    if (!branchId) throw badRequest('branchId is required', 'branchId');
    const branch = await prisma.branch.findFirst({
      where: { id: branchId, companyId: req.companyScope.id },
    });
    if (!branch) throw notFound('Branch not found');
    if (branch.status !== 'ACTIVE') throw conflict('Branch is closed');
    const clash = await prisma.diningTable.findUnique({
      where: { branchId_name: { branchId, name: data.name } },
    });
    if (clash) throw conflict(`Table "${data.name}" already exists in this branch`);
    const table = await prisma.diningTable.create({
      data: { branchId, name: data.name, capacity: data.capacity ?? null },
    });
    await audit(req, {
      action: 'TABLE_CREATE',
      entity: 'DiningTable',
      entityId: table.id,
      companyId: req.companyScope.id,
      meta: { name: table.name, branchId },
    });
    res.status(201).json({ table: publicTable({ ...table, orders: [] }) });
  }),
);

// The legacy resolver, and it stays as it is. A pinned caller reaching another
// branch gets 403 rather than 404, which does leak that the table exists — but
// it is the documented behaviour of these four endpoints and other suites assert
// it, so changing it here would be an unrelated contract break smuggled in
// alongside a new feature. loadTableInScope below is the shape new endpoints use.
const loadTable = async (req) => {
  const table = await prisma.diningTable.findFirst({
    where: { id: req.params.id, branch: { companyId: req.companyScope.id } },
    include: CURRENT_ORDER_INCLUDE,
  });
  if (!table) throw notFound('Table not found');
  if (isBranchPinned(req.user) && table.branchId !== req.user.branchId) {
    throw forbidden('Your role is limited to your own branch');
  }
  return table;
};

const updateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  capacity: z.number().int().min(1).max(99).nullish(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});

router.patch(
  '/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const table = await loadTable(req);
    const data = updateSchema.parse(req.body);
    const occupied = table.orders.length > 0;
    if (data.status === 'RETIRED' && occupied) {
      throw conflict('Table has an open order; settle or void it first');
    }
    if (data.name && data.name !== table.name) {
      if (occupied) throw conflict('Table has an open order; settle or void it first');
      const clash = await prisma.diningTable.findUnique({
        where: { branchId_name: { branchId: table.branchId, name: data.name } },
      });
      if (clash) throw conflict(`Table "${data.name}" already exists in this branch`);
    }
    const updated = await prisma.diningTable.update({
      where: { id: table.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.capacity !== undefined ? { capacity: data.capacity } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
      include: CURRENT_ORDER_INCLUDE,
    });
    await audit(req, {
      action: 'TABLE_UPDATE',
      entity: 'DiningTable',
      entityId: table.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ table: publicTable(updated) });
  }),
);

router.delete(
  '/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const table = await loadTable(req);
    if (table.orders.length > 0) {
      throw conflict('Table has an open order; settle or void it first');
    }
    const updated = await prisma.diningTable.update({
      where: { id: table.id },
      data: { status: 'RETIRED' },
      include: CURRENT_ORDER_INCLUDE,
    });
    await audit(req, {
      action: 'TABLE_RETIRE',
      entity: 'DiningTable',
      entityId: table.id,
      companyId: req.companyScope.id,
      meta: { name: table.name },
    });
    res.json({ table: publicTable(updated) });
  }),
);

// ---------------------------------------------------------------------------
// LANE tables — covers and server
// ---------------------------------------------------------------------------

// Proves the table is inside BOTH the tenant and the caller's own scope, and
// answers identically when it is in neither. A store manager probing ids must
// not be able to map the company's other outlets, and "wrong tenant" and "never
// existed" must read the same — hence one notFound() for all three cases rather
// than the forbidden() loadTable throws.
const loadTableInScope = async (req) => {
  const table = await prisma.diningTable.findFirst({
    where: {
      id: req.params.id,
      branch: { companyId: req.companyScope.id, ...branchWhereForScope(req.perm.scope) },
    },
    select: { id: true, branchId: true, name: true },
  });
  if (!table) throw notFound('Table not found');
  return table;
};

// The bills the party is currently running, OLDEST FIRST. OPEN and BILLED both
// count as "occupied" for the floor, and the difference between them is the
// difference between editable and not — assertServiceEditable is what draws that
// line, so both are fetched and it decides.
//
// This returns a LIST rather than findFirst, and the ordering is load-bearing
// rather than decoration. Both are for the same reason: until split shipped, a
// table could hold only ONE open order — POST /orders refuses a second
// (orders.js:371-375) — so a findFirst here was right by construction and its
// `orderBy` chose between nothing. Split made two bills on one table reachable
// for the first time and silently promoted that assumption to a defect, because
// the old `createdAt: 'desc'` resolved to the newer row: the cheque. Covers
// written there are counted twice. paxAnchorOf and waiterTargetsOf decide which
// bill each field actually belongs on.
const openBillsOf = (tableId) =>
  prisma.order.findMany({
    where: { tableId, status: { in: OPEN_STATUSES } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

// `null` clears, absent leaves alone, and the two are different instructions —
// see serviceUpdateData. z.nullish() accepts both, and the refine below is what
// stops a body that says neither from being answered 200 for doing nothing.
const serviceSchema = z
  .object({
    pax: z.number().int().min(1).max(MAX_PAX).nullish(),
    waiterId: z.string().min(1).nullish(),
  })
  .refine((d) => d.pax !== undefined || d.waiterId !== undefined, {
    message: 'Send pax, waiterId, or both',
  });

router.post(
  '/:id/service',
  ...canServe,
  asyncHandler(async (req, res) => {
    const table = await loadTableInScope(req);
    const data = serviceSchema.parse(req.body);
    const bills = await openBillsOf(table.id);

    // Covers go on the anchor, the server goes on every open cheque. Before
    // split those were the same single bill, which is why one findFirst and one
    // update used to be enough here.
    const anchor = paxAnchorOf(bills);
    const waiterTargets = waiterTargetsOf(bills);

    // Both refusals are assertServiceEditable's own, so the messages a till
    // shows are unchanged. Covers may only change while the bill that OWNS them
    // is unissued; the server may change on any cheque still open, which is why
    // the two are checked against different rows. With one bill on the table
    // both reduce to exactly the previous single check.
    if (data.pax !== undefined) assertServiceEditable(anchor);
    if (data.waiterId !== undefined) assertServiceEditable(waiterTargets[0] ?? anchor);

    // Eligibility is proved against the table's OWN store, not the caller's.
    // A regional manager standing in outlet A2 may credit A2's captain, and may
    // not credit A1's — the scope that decides what the caller may touch is a
    // different question from who may be credited with the table they touched.
    let waiter = null;
    if (data.waiterId) {
      waiter = await resolveWaiter({
        companyId: req.companyScope.id,
        branchId: table.branchId,
        waiterId: data.waiterId,
      });
    }

    // One transaction because this is now up to two writes and they are one
    // instruction: a party must never be left with its server changed on one
    // cheque and not the other. Neither field is money and nothing here calls
    // recomputeOrder, so no total can move.
    const updated = await prisma.$transaction(async (tx) => {
      if (data.waiterId !== undefined) {
        // updateMany, because the server belongs on every open cheque. The three
        // waiter columns move together — Order_waiter_attribution_complete
        // refuses any other combination — and serviceUpdateData is what agrees
        // with that constraint, so it builds this payload too.
        await tx.order.updateMany({
          where: { id: { in: waiterTargets.map((b) => b.id) } },
          data: serviceUpdateData({ waiterId: data.waiterId, actorId: req.user.id }),
        });
      }
      if (data.pax !== undefined) {
        // Exactly one row, always the anchor. This is the line the defect was.
        await tx.order.update({
          where: { id: anchor.id },
          data: serviceUpdateData({ pax: data.pax }),
        });
      }

      // Read back the bill that represents the party. Covers live on the anchor
      // and the server is now uniform across every open cheque, so one row
      // answers for both. When the anchor is itself already issued — the
      // original billed while a cheque stays open — the row that just changed is
      // the first open cheque, and that is what the till is asking about.
      // Both branches are total: pax being present proves the anchor is OPEN,
      // and an absent pax with a non-OPEN anchor proves waiterTargets is not
      // empty, because otherwise the check above would have refused.
      const readbackId =
        data.pax !== undefined || anchor.status === 'OPEN' ? anchor.id : waiterTargets[0].id;
      return tx.order.findUnique({
        where: { id: readbackId },
        select: {
          id: true,
          pax: true,
          waiterId: true,
          waiterSetAt: true,
          waiterSetById: true,
          waiter: { select: { fullName: true } },
        },
      });
    });

    // Audited against the Order, because the order is what changed and is what a
    // shift report disputes. The table is in the meta so the floor can be
    // searched by it.
    await audit(req, {
      action: 'TABLE_SERVICE_SET',
      entity: 'Order',
      entityId: updated.id,
      companyId: req.companyScope.id,
      meta: {
        tableId: table.id,
        tableName: table.name,
        branchId: table.branchId,
        // Which bill each field actually landed on. With one bill these are all
        // the same id and say nothing new; with a split party they are the only
        // way to reconstruct afterwards why covers moved on one cheque and the
        // server on two. openBills is here so a shift report can tell a
        // single-bill table from a split one without re-deriving it.
        openBills: bills.length,
        ...(data.pax !== undefined ? { pax: data.pax, paxOrderId: anchor.id } : {}),
        ...(data.waiterId !== undefined
          ? {
              waiterId: data.waiterId,
              waiterName: waiter?.fullName ?? null,
              waiterOrderIds: waiterTargets.map((b) => b.id),
            }
          : {}),
      },
    });

    res.json({ service: publicService(updated) });
  }),
);

// ---------------------------------------------------------------------------
// LANE tables — transfer
// ---------------------------------------------------------------------------

const transferSchema = z.object({ toTableId: z.string().min(1) });

// Only the SOURCE table is resolved through the caller's scope. The destination
// is then resolved against the source's own branch inside transferParty, which
// is what makes "may this person touch this floor?" one question asked once
// instead of two that can disagree. See lib/tables/transfer.js.
router.post(
  '/:id/transfer',
  ...canTransfer,
  asyncHandler(async (req, res) => {
    const from = await loadTableInScope(req);
    const { toTableId } = transferSchema.parse(req.body);

    let moved;
    try {
      moved = await prisma.$transaction(async (tx) => {
        const result = await transferParty(tx, { from, toTableId, actorId: req.user.id });
        // auditRequired, not audit: a party that moved with no record of who
        // moved it is the dispute this row exists to settle, so the row and the
        // move commit together or neither does.
        await auditRequired(tx, req, {
          action: 'TABLE_TRANSFER',
          entity: 'DiningTable',
          entityId: from.id,
          companyId: req.companyScope.id,
          meta: {
            fromTableId: result.from.id,
            fromTableName: result.from.name,
            toTableId: result.to.id,
            toTableName: result.to.name,
            branchId: from.branchId,
            visitId: result.visitId,
            orderIds: result.orderIds,
            ordersMoved: result.ordersMoved,
          },
        });
        return result;
      });
    } catch (err) {
      // The destination was claimed between our check and our write. The unique
      // constraint on DiningVisit.openTableId is what caught it; this turns it
      // into an answer about the floor instead of a 500 about the database.
      if (isDestinationTaken(err)) {
        throw conflict('That table was taken while the party was being moved');
      }
      throw err;
    }

    res.json({ transfer: moved });
  }),
);

export default router;
