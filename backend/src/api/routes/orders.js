// Orders — contract §5.3/§7/§8/§9. Cashier flow: create → items/KOT/discount
// → bill (invoice number, freeze) → manual payment records → receipt; refunds
// and voids are manager+. ATC operators are read-only here (403 on writes).
// Cross-company ids answer 404, indistinguishable from absent. Every mutation
// responds with the full recalculated order.

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
import { toPaise, toRupees } from '../../lib/money.js';
import { nextInvoiceNumber } from '../../lib/invoice.js';
import {
  ORDER_INCLUDE,
  SUMMARY_INCLUDE,
  recomputeOrder,
  serializeOrder,
  serializeOrderSummary,
  publicPayment,
  publicRefund,
  buildReceipt,
  paiseOf,
  istDayStartUtc,
} from '../../lib/orders.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

const operate = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'), requireUsableLicense];
const managerUp = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'), requireUsableLicense];

const money2 = z
  .number()
  .gt(0)
  .max(99999999)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Amounts allow at most 2 decimals');
const reasonSchema = z.string().trim().min(3).max(200);

const loadOrder = async (req, include = undefined) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
    include,
  });
  if (!order) throw notFound('Order not found');
  if (isBranchPinned(req.user) && order.branchId !== req.user.branchId) {
    throw forbidden('Your role is limited to your own branch');
  }
  return order;
};

const fullOrder = async (id) =>
  serializeOrder(await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE }));

const assertOpen = (order) => {
  if (order.status !== 'OPEN') throw conflict('Order is not open');
};

// Snapshots product/variant/tax at add time — later catalog edits never touch
// an existing order line.
const resolveCatalogLine = async (companyId, { productId, variantId, qty }) => {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId, status: 'ACTIVE' },
    include: { taxRate: true, variants: true },
  });
  if (!product) throw badRequest('Unknown or archived product', 'productId');
  let variant = null;
  if (variantId) {
    variant = product.variants.find((v) => v.id === variantId && v.status === 'ACTIVE') ?? null;
    if (!variant) throw badRequest('Unknown or archived variant', 'variantId');
  }
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    name: variant ? `${product.name} (${variant.name})` : product.name,
    unitPrice: variant ? variant.price : product.basePrice,
    qty,
    taxRateName: product.taxRate?.name ?? null,
    taxRatePercent: product.taxRate?.ratePercent ?? null,
  };
};

// --- create -----------------------------------------------------------------

const createSchema = z.object({
  type: z.enum(['DINE_IN', 'TAKEAWAY']),
  tableId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  note: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        qty: z.number().int().min(1).max(999).default(1),
      }),
    )
    .min(1),
});

router.post(
  '/',
  ...operate,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    const branchId = isBranchPinned(req.user) ? req.user.branchId : data.branchId;
    if (!branchId) throw badRequest('branchId is required', 'branchId');
    const branch = await prisma.branch.findFirst({
      where: { id: branchId, companyId: req.companyScope.id },
    });
    if (!branch) throw notFound('Branch not found');
    if (branch.status !== 'ACTIVE') throw conflict('Branch is closed');

    if (data.type === 'TAKEAWAY' && data.tableId) {
      throw badRequest('tableId is not allowed for TAKEAWAY orders', 'tableId');
    }
    if (data.type === 'DINE_IN') {
      if (!data.tableId) throw badRequest('tableId is required for DINE_IN orders', 'tableId');
      const table = await prisma.diningTable.findFirst({
        where: { id: data.tableId, branchId: branch.id },
      });
      if (!table) throw notFound('Table not found');
      if (table.status !== 'ACTIVE') throw conflict('Table is retired');
      const occupied = await prisma.order.findFirst({
        where: { tableId: table.id, status: { in: ['OPEN', 'BILLED'] } },
        select: { id: true },
      });
      if (occupied) throw conflict(`Table "${table.name}" already has an open order`);
    }

    // Merge duplicate product+variant entries into one line.
    const merged = new Map();
    for (const item of data.items) {
      const key = `${item.productId}|${item.variantId ?? ''}`;
      const cur = merged.get(key);
      if (cur) cur.qty += item.qty;
      else merged.set(key, { ...item });
    }
    const lines = [];
    for (const item of merged.values()) {
      lines.push(await resolveCatalogLine(req.companyScope.id, item));
    }

    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          companyId: req.companyScope.id,
          branchId: branch.id,
          type: data.type,
          tableId: data.type === 'DINE_IN' ? data.tableId : null,
          note: data.note ?? null,
          openedById: req.user.id,
        },
      });
      await tx.orderItem.createMany({
        data: lines.map((l) => ({ orderId: order.id, ...l })),
      });
      await recomputeOrder(tx, order.id);
      return order;
    });

    await audit(req, {
      action: 'ORDER_CREATE',
      entity: 'Order',
      entityId: created.id,
      companyId: req.companyScope.id,
      meta: { type: data.type, branchId: branch.id, lines: lines.length },
    });
    res.status(201).json({ order: await fullOrder(created.id) });
  }),
);

// --- items ------------------------------------------------------------------

router.post(
  '/:id/items',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        productId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        qty: z.number().int().min(1).max(999).default(1),
      })
      .parse(req.body);
    const order = await loadOrder(req);
    assertOpen(order);
    const line = await resolveCatalogLine(req.companyScope.id, body);

    await prisma.$transaction(async (tx) => {
      const existing = await tx.orderItem.findFirst({
        where: {
          orderId: order.id,
          productId: line.productId,
          variantId: line.variantId,
          status: 'ACTIVE',
          kotId: null,
        },
      });
      if (existing) {
        const qty = Math.min(existing.qty + line.qty, 999);
        await tx.orderItem.update({ where: { id: existing.id }, data: { qty } });
      } else {
        await tx.orderItem.create({ data: { orderId: order.id, ...line } });
      }
      await recomputeOrder(tx, order.id);
    });

    await audit(req, {
      action: 'ORDER_ITEM_ADD',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { productId: line.productId, variantId: line.variantId, qty: line.qty },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

const loadItem = async (req, order) => {
  const item = await prisma.orderItem.findFirst({
    where: { id: req.params.itemId, orderId: order.id },
  });
  if (!item) throw notFound('Order line not found');
  return item;
};

router.patch(
  '/:id/items/:itemId',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        qty: z.number().int().min(1).max(999).optional(),
        lineDiscount: z
          .number()
          .min(0)
          .max(99999999)
          .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Amounts allow at most 2 decimals')
          .optional(),
      })
      .refine((b) => (b.qty === undefined) !== (b.lineDiscount === undefined), {
        message: 'Send exactly one of qty or lineDiscount',
      })
      .parse(req.body);
    const order = await loadOrder(req);
    assertOpen(order);
    const item = await loadItem(req, order);
    if (item.status !== 'ACTIVE') throw conflict('Line is voided');

    if (body.qty !== undefined && item.kotId) {
      throw conflict('Line is already sent to the kitchen; void it instead');
    }
    const qty = body.qty ?? item.qty;
    if (body.lineDiscount !== undefined) {
      const gross = paiseOf(item.unitPrice) * qty;
      if (toPaise(body.lineDiscount) > gross) {
        throw badRequest('Line discount cannot exceed the line amount', 'lineDiscount');
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          ...(body.qty !== undefined ? { qty: body.qty } : {}),
          ...(body.lineDiscount !== undefined ? { lineDiscount: body.lineDiscount.toFixed(2) } : {}),
        },
      });
      await recomputeOrder(tx, order.id);
    });

    await audit(req, {
      action: 'ORDER_ITEM_UPDATE',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { itemId: item.id, ...body },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.delete(
  '/:id/items/:itemId',
  ...operate,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req);
    assertOpen(order);
    const item = await loadItem(req, order);
    if (item.status !== 'ACTIVE') throw conflict('Line is voided');
    if (item.kotId) throw conflict('Line is already sent to the kitchen; void it instead');

    await prisma.$transaction(async (tx) => {
      await tx.orderItem.delete({ where: { id: item.id } });
      await recomputeOrder(tx, order.id);
    });

    await audit(req, {
      action: 'ORDER_ITEM_REMOVE',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { itemId: item.id, name: item.name },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.post(
  '/:id/items/:itemId/void',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
    const order = await loadOrder(req);
    assertOpen(order);
    const item = await loadItem(req, order);
    if (item.status !== 'ACTIVE') throw conflict('Line is already voided');
    if (!item.kotId) throw conflict('Line was never sent to the kitchen; delete it instead');

    await prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { status: 'VOIDED', voidReason: reason, voidedById: req.user.id },
      });
      await recomputeOrder(tx, order.id);
    });

    await audit(req, {
      action: 'ORDER_ITEM_VOID',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { itemId: item.id, name: item.name, reason },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

// --- KOT --------------------------------------------------------------------

const publicKot = (kot, order) => ({
  id: kot.id,
  seq: kot.seq,
  orderId: kot.orderId,
  type: order.type,
  tableName: order.table?.name ?? null,
  items: kot.items.map((i) => ({ name: i.name, qty: i.qty })),
  createdAt: kot.createdAt,
});

router.post(
  '/:id/kot',
  ...operate,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, { table: { select: { name: true } } });
    assertOpen(order);

    const kot = await prisma.$transaction(async (tx) => {
      const unsent = await tx.orderItem.findMany({
        where: { orderId: order.id, status: 'ACTIVE', kotId: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (unsent.length === 0) throw conflict('No new items to send to the kitchen');
      const seq = (await tx.kot.count({ where: { orderId: order.id } })) + 1;
      const created = await tx.kot.create({ data: { orderId: order.id, seq } });
      await tx.orderItem.updateMany({
        where: { id: { in: unsent.map((i) => i.id) } },
        data: { kotId: created.id },
      });
      return { ...created, items: unsent };
    });

    await audit(req, {
      action: 'ORDER_KOT',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { seq: kot.seq, items: kot.items.length },
    });
    res.status(201).json({ kot: publicKot(kot, order), order: await fullOrder(order.id) });
  }),
);

router.get(
  '/:id/kots',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, { table: { select: { name: true } } });
    const kots = await prisma.kot.findMany({
      where: { orderId: order.id },
      include: { items: { select: { name: true, qty: true } } },
      orderBy: { seq: 'asc' },
    });
    res.json({ kots: kots.map((k) => publicKot(k, order)) });
  }),
);

// --- order-level discount ---------------------------------------------------

router.post(
  '/:id/discount',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ type: z.enum(['FLAT', 'PERCENT']), value: money2 })
      .parse(req.body);
    const order = await loadOrder(req);
    assertOpen(order);
    if (body.type === 'PERCENT' && body.value > 100) {
      throw badRequest('PERCENT discount cannot exceed 100', 'value');
    }
    if (body.type === 'FLAT' && toPaise(body.value) > paiseOf(order.subtotal)) {
      throw badRequest('FLAT discount cannot exceed the subtotal', 'value');
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { discountType: body.type, discountValue: body.value.toFixed(2) },
      });
      await recomputeOrder(tx, order.id);
    });

    await audit(req, {
      action: 'ORDER_DISCOUNT_SET',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: body,
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.delete(
  '/:id/discount',
  ...operate,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req);
    assertOpen(order);
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { discountType: null, discountValue: null },
      });
      await recomputeOrder(tx, order.id);
    });
    await audit(req, {
      action: 'ORDER_DISCOUNT_CLEAR',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

// --- bill -------------------------------------------------------------------

router.post(
  '/:id/bill',
  ...operate,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, { branch: true, items: { select: { status: true } } });
    assertOpen(order);
    if (!order.items.some((i) => i.status === 'ACTIVE')) {
      throw conflict('Order has no active items to bill');
    }

    await prisma.$transaction(async (tx) => {
      // Guarded transition: a concurrent bill of the same order loses here.
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: 'OPEN' },
        data: { status: 'BILLED', billedAt: new Date() },
      });
      if (moved.count === 0) throw conflict('Order is not open');
      await recomputeOrder(tx, order.id);
      const invoiceNumber = await nextInvoiceNumber(tx, order.branch);
      await tx.order.update({ where: { id: order.id }, data: { invoiceNumber } });
    });

    const full = await prisma.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE });
    await audit(req, {
      action: 'ORDER_BILL',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { invoiceNumber: full.invoiceNumber, total: String(full.total) },
    });
    res.json({
      order: serializeOrder(full),
      receipt: buildReceipt(req.companyScope, order.branch, full),
    });
  }),
);

// --- payments ---------------------------------------------------------------

router.post(
  '/:id/payments',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        method: z.enum(['CASH', 'CARD', 'UPI', 'OTHER']),
        amount: money2.optional(),
        tendered: money2.optional(),
        note: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    if (body.method === 'CASH') {
      if ((body.amount === undefined) === (body.tendered === undefined)) {
        throw badRequest('For CASH send exactly one of tendered or amount');
      }
    } else {
      if (body.amount === undefined) throw badRequest('amount is required', 'amount');
      if (body.tendered !== undefined) throw badRequest('tendered is only for CASH', 'tendered');
    }
    const order = await loadOrder(req);

    const result = await prisma.$transaction(async (tx) => {
      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: { select: { amount: true } } },
      });
      if (cur.status !== 'BILLED') throw conflict('Payments are recorded on billed orders only');
      const total = paiseOf(cur.total);
      const collected = cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      const due = total - collected;
      if (due <= 0) throw conflict('Order has no amount due');

      let applied;
      let tendered = null;
      if (body.tendered !== undefined) {
        tendered = toPaise(body.tendered);
        applied = Math.min(tendered, due);
      } else {
        applied = toPaise(body.amount);
        if (applied > due) throw badRequest('Amount exceeds the amount due', 'amount');
      }

      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          method: body.method,
          amount: (applied / 100).toFixed(2),
          tendered: tendered === null ? null : (tendered / 100).toFixed(2),
          note: body.note ?? null,
          receivedById: req.user.id,
        },
        include: { receivedBy: { select: { id: true, fullName: true } } },
      });
      if (collected + applied >= total) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAID', closedAt: new Date() },
        });
      }
      return { payment, changeDue: tendered === null ? null : toRupees(tendered - applied) };
    });

    await audit(req, {
      action: 'ORDER_PAYMENT',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { method: body.method, amount: String(result.payment.amount), channel: 'MANUAL' },
    });
    res.status(201).json({
      order: await fullOrder(order.id),
      payment: publicPayment(result.payment),
      changeDue: result.changeDue,
    });
  }),
);

// --- refunds ----------------------------------------------------------------

router.post(
  '/:id/refunds',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const body = z.object({ amount: money2, reason: reasonSchema }).parse(req.body);
    const order = await loadOrder(req);

    const refund = await prisma.$transaction(async (tx) => {
      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: { select: { amount: true } }, refunds: { select: { amount: true } } },
      });
      if (!['BILLED', 'PAID'].includes(cur.status)) {
        throw conflict('Refunds apply to billed or paid orders only');
      }
      const collected = cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      const refunded = cur.refunds.reduce((a, r) => a + paiseOf(r.amount), 0);
      const amount = toPaise(body.amount);
      if (amount > collected - refunded) {
        throw badRequest('Refund exceeds the amount collected', 'amount');
      }
      const created = await tx.refund.create({
        data: {
          orderId: order.id,
          amount: (amount / 100).toFixed(2),
          reason: body.reason,
          byId: req.user.id,
        },
        include: { by: { select: { id: true, fullName: true } } },
      });
      if (cur.status === 'PAID' && refunded + amount === collected) {
        await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      }
      return created;
    });

    await audit(req, {
      action: 'ORDER_REFUND',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { amount: String(refund.amount), reason: body.reason },
    });
    res.status(201).json({ order: await fullOrder(order.id), refund: publicRefund(refund) });
  }),
);

// --- void -------------------------------------------------------------------

router.post(
  '/:id/void',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
    const order = await loadOrder(req);

    await prisma.$transaction(async (tx) => {
      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: { select: { amount: true } }, refunds: { select: { amount: true } } },
      });
      if (!['OPEN', 'BILLED'].includes(cur.status)) {
        throw conflict('Only open or billed orders can be voided');
      }
      const collected = cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      const refunded = cur.refunds.reduce((a, r) => a + paiseOf(r.amount), 0);
      if (collected - refunded !== 0) {
        throw conflict('Refund recorded payments first; net collected must be zero');
      }
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: { in: ['OPEN', 'BILLED'] } },
        data: { status: 'VOID', voidReason: reason, voidedById: req.user.id, closedAt: new Date() },
      });
      if (moved.count === 0) throw conflict('Only open or billed orders can be voided');
    });

    await audit(req, {
      action: 'ORDER_VOID',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { reason, invoiceNumber: order.invoiceNumber },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

// --- reads ------------------------------------------------------------------

const STATUSES = ['OPEN', 'BILLED', 'PAID', 'VOID', 'REFUNDED'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        status: z.string().optional(),
        branchId: z.string().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    let statuses;
    if (query.status) {
      statuses = query.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      for (const s of statuses) {
        if (!STATUSES.includes(s)) throw badRequest(`Unknown status ${s}`, 'status');
      }
    }
    const where = {
      companyId: req.companyScope.id,
      ...branchIdFilterFor(req.user),
      ...(!isBranchPinned(req.user) && query.branchId ? { branchId: query.branchId } : {}),
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: istDayStartUtc(query.from) } : {}),
              ...(query.to ? { lt: new Date(istDayStartUtc(query.to).getTime() + 86400e3) } : {}),
            },
          }
        : {}),
    };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    res.json({
      orders: orders.map(serializeOrderSummary),
      page: query.page,
      pageSize: query.pageSize,
      total,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, ORDER_INCLUDE);
    res.json({ order: serializeOrder(order) });
  }),
);

router.get(
  '/:id/receipt',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, ORDER_INCLUDE);
    if (!['BILLED', 'PAID', 'REFUNDED'].includes(order.status)) {
      throw conflict('Receipts exist only after billing');
    }
    const branch = await prisma.branch.findUnique({ where: { id: order.branchId } });
    res.json({ receipt: buildReceipt(req.companyScope, branch, order) });
  }),
);

export default router;
