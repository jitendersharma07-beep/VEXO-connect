// Dining tables — contract §5.2. Reads: every role (pinned roles see their
// own branch). Writes: CUSTOMER_OWNER anywhere, BRANCH_MANAGER in their own
// branch; ATC is read-only here. DELETE retires; a table with an open or
// billed order can neither be retired nor renamed away from under it.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  isBranchPinned,
  branchIdFilterFor,
} from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { num } from '../../lib/orders.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

const canWrite = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'), requireUsableLicense];

const OPEN_STATUSES = ['OPEN', 'BILLED'];
const CURRENT_ORDER_INCLUDE = {
  orders: {
    where: { status: { in: OPEN_STATUSES } },
    select: { id: true, status: true, type: true, total: true },
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

export default router;
