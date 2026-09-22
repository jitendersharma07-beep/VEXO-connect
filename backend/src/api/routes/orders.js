// Orders — contract §5.3/§7/§8/§9. Cashier flow: create → items/KOT/discount
// → bill (invoice number, freeze) → manual payment records → receipt; refunds
// and voids are manager+. ATC operators are read-only here (403 on writes).
// Cross-company ids answer 404, indistinguishable from absent. Every mutation
// responds with the full recalculated order.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { getAdapter, gatewayAvailable } from '../../lib/gateway/index.js';
import { asyncHandler, badGateway, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { env } from '../../config/env.js';
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
  publicIntent,
  publicRefund,
  buildReceipt,
  paiseOf,
  settledRefundPaise,
  reservedRefundPaise,
  refundLegs,
  pickRefundLeg,
  largestRefundablePaise,
  isUnconfirmedGatewayRefund,
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
      // Serialises collection on this order, for the same reason the intent
      // and refund routes below do it — but this is the one a café actually
      // hits. READ COMMITTED gives each concurrent request a snapshot without
      // the other's payment row, so both compute the full amount as still due
      // and both insert it: a double-clicked "Record payment" collects the
      // bill twice, at 201 each, and the till only disagrees at day end. The
      // status and due-amount checks below are the guard; they are worth
      // nothing unless the row is held while they are made.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: { select: { amount: true } } },
      });
      // PAID is called out before the general status refusal because it is
      // the one a cashier reaches by accident — the losing half of a
      // double-click lands here every time. Telling them "payments are
      // recorded on billed orders only" about an order they just billed and
      // just paid reads as a fault in the till, and the honest response to a
      // till that looks faulty is to bill it again.
      if (cur.status === 'PAID') throw conflict('Order is already paid in full');
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

// --- gateway payment intents ------------------------------------------------

// Opens one provider-side attempt to collect what is still due. On a
// deployment with no provider configured — which is every deployment today —
// this answers 501 and the cashier records the payment manually instead.
//
// Nothing here records a payment. Only a signature-verified webhook can do
// that, which is the whole distance between "asked for money" and "was paid".
//
// Two phases, for the same reason refunds have two: the provider is reached
// over the network and must not be called with a database transaction open.
// A real provider's round trip can outlast Prisma's transaction timeout, and a
// timeout there would roll back the intent row while the provider keeps the
// payable order it just created — a page the customer can pay against a
// reservation that no longer exists.
router.post(
  '/:id/payment-intents',
  ...operate,
  asyncHandler(async (req, res) => {
    const adapter = getAdapter();
    const order = await loadOrder(req);

    // PHASE 1 — reserve the attempt locally and commit, provider untouched.
    const reservation = await prisma.$transaction(async (tx) => {
      // Serialises intent creation on this order. Without it two concurrent
      // requests each read a state with the other's row invisible, both find
      // no open intent, and both create one — which is the two live payment
      // pages for one bill that the check below exists to prevent.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: { select: { amount: true } } },
      });
      if (cur.status !== 'BILLED') throw conflict('Online payment is offered on billed orders only');
      const due = paiseOf(cur.total) - cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      if (due <= 0) throw conflict('Order has no amount due');

      // One payable session per order at a time. Handing out a second would
      // show the customer two live payment pages for one bill, and both
      // could be paid.
      const open = await tx.paymentIntent.findFirst({
        where: { orderId: order.id, status: { in: ['CREATED', 'PENDING'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (open) {
        if (paiseOf(open.amount) !== due) {
          throw conflict('An online payment for a different amount is already open on this order');
        }
        // An intent with no providerRef never got an answer out of phase 2.
        // Retrying it carries the SAME idempotency key, so the provider
        // returns the attempt it already has instead of opening a second one.
        return { intent: open, due, resume: open.providerRef === null };
      }

      const intent = await tx.paymentIntent.create({
        data: {
          orderId: order.id,
          provider: adapter.name,
          // Null until the provider answers. CREATED, not PENDING: nothing has
          // been asked of anyone yet, and the difference is what phase 2 fills in.
          providerRef: null,
          amount: (due / 100).toFixed(2),
          currency: 'INR',
          status: 'CREATED',
          idempotencyKey: randomUUID(),
          createdById: req.user.id,
        },
      });
      return { intent, due, resume: true, fresh: true };
    });

    // PHASE 2 — now open the session with the provider.
    let intent = reservation.intent;
    let checkoutUrl = null;
    if (reservation.resume) {
      try {
        const session = await adapter.createSession({
          amountPaise: reservation.due,
          currency: 'INR',
          orderId: order.id,
          idempotencyKey: intent.idempotencyKey,
        });
        checkoutUrl = session.checkoutUrl ?? null;
        intent = await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { providerRef: session.providerRef ?? null, status: 'PENDING', failureReason: null },
        });
      } catch (err) {
        // Refused by the provider means no session exists and none is coming,
        // so the intent is closed and the cashier can open a fresh one or take
        // the money manually. Anything else is UNKNOWN: the provider may hold
        // a payable session we never saw the id of, so the row stays open and
        // the next attempt resumes it under the same key rather than creating
        // a second page the customer could also pay.
        const detail = err?.message ? String(err.message).slice(0, 200) : 'no answer from the provider';
        if (err?.providerRefused === true) {
          await prisma.paymentIntent.update({
            where: { id: intent.id },
            data: { status: 'FAILED', failureReason: detail, closedAt: new Date() },
          });
        } else {
          await prisma.paymentIntent.update({ where: { id: intent.id }, data: { failureReason: detail } });
        }
        throw badGateway('The payment provider could not open a payment for this order');
      }
    }

    if (reservation.fresh) {
      await audit(req, {
        action: 'GATEWAY_INTENT_CREATED',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, provider: adapter.name, amount: String(intent.amount) },
      });
    }
    res.status(reservation.fresh ? 201 : 200).json({
      intent: publicIntent(intent),
      checkoutUrl,
      // Razorpay Checkout opens in the browser with the order id and the key
      // id. The key id is the publishable half of the pair and is designed to
      // ship to the client; the secret never leaves this process.
      provider: adapter.name,
      keyId: env.POS_GATEWAY_KEY_ID,
    });
  }),
);

const handoffSchema = z.object({
  paymentId: z.string().min(1).max(120),
  signature: z.string().min(1).max(256),
});

// The browser's report that the customer finished paying — checked, then used
// for nothing but the words on the cashier's screen.
//
// This route settles NOTHING. It creates no payment, closes no intent and
// touches no money; it re-reads the order and hands back whatever the webhook
// has or has not already done. That is the entire design: the customer's
// browser and the provider's webhook are two different claims, and only the
// second one is evidence.
//
// It still verifies, because the cashier acts on the answer. "Customer has
// paid, confirmation coming" and "customer closed the window" lead to
// different things happening at the counter, and an unsigned claim of the
// first is a way to walk out with the goods.
router.post(
  '/:id/payment-intents/:intentId/handoff',
  ...operate,
  asyncHandler(async (req, res) => {
    const adapter = getAdapter();
    const body = handoffSchema.parse(req.body ?? {});
    const order = await loadOrder(req);

    // Found via the order, so an intent belonging to another company or
    // another bill is simply absent rather than probeable.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.intentId, orderId: order.id },
    });
    if (!intent) throw notFound('Payment intent not found');
    if (!intent.providerRef) {
      throw conflict('This payment was never opened with the provider');
    }
    if (typeof adapter.verifyCheckoutHandoff !== 'function') {
      throw badRequest('This payment provider has no browser handoff to verify');
    }

    const verified = adapter.verifyCheckoutHandoff({
      intentProviderRef: intent.providerRef,
      paymentId: body.paymentId,
      signature: body.signature,
    });
    if (!verified) throw badRequest('The payment confirmation could not be verified');

    // Worth recording even though nothing moved: an intent still open minutes
    // after a VERIFIED handoff means the customer paid and the webhook never
    // arrived, which is a far stronger signal than an intent that is merely
    // old. This is the only trace of that distinction.
    await audit(req, {
      action: 'GATEWAY_CHECKOUT_HANDOFF',
      entity: 'PaymentIntent',
      entityId: intent.id,
      companyId: req.companyScope.id,
      meta: { orderId: order.id, provider: adapter.name, chargeRef: body.paymentId },
    });

    // Re-read rather than reuse: the webhook may have landed while we were
    // checking the signature, and the screen should say so.
    const current = await loadOrder(req, ORDER_INCLUDE);
    res.json({
      handoff: 'verified',
      // Whether the webhook has landed yet. False is the normal first answer:
      // the browser usually beats the webhook by a second or two.
      settled: current.payments.some((p) => p.intentId === intent.id),
      order: serializeOrder(current),
    });
  }),
);

// --- refunds ----------------------------------------------------------------

const REFUND_PAYMENT_INCLUDE = {
  select: {
    amount: true,
    channel: true,
    intentId: true,
    // The provider's id for the charge. Without it a gateway refund has no
    // route to post to, so it has to travel with the leg.
    providerRef: true,
    intent: { select: { id: true, providerRef: true, provider: true } },
  },
};

const REFUND_STATE_SELECT = {
  select: { amount: true, status: true, channel: true, intentId: true, providerRef: true },
};

const rupees = (paise) => (paise / 100).toFixed(2);

// Asks the provider to return the money, OUTSIDE any database transaction and
// always with the key already stored on the row.
//
// The three outcomes are not two. Accepted is a providerRef to track. Refused
// is a provider that answered no. Everything else — timeout, socket reset, a
// 500, an answer with no reference in it — is UNKNOWN: the request may be
// paying out this second. Unknown must never be reported as refused, because
// a refused refund frees its money to be requested again, and doing that to a
// request that did go through pays the customer twice.
const sendRefundToProvider = async (refund, leg, orderId) => {
  try {
    const result = await getAdapter().createRefund({
      intentProviderRef: leg.intentProviderRef,
      chargeProviderRef: leg.chargeProviderRef,
      amountPaise: paiseOf(refund.amount),
      currency: 'INR',
      orderId,
      idempotencyKey: refund.idempotencyKey,
    });
    const providerRef = result?.providerRef ?? null;
    if (!providerRef) {
      return { confirmed: false, detail: 'the provider answered without a refund reference' };
    }
    return { confirmed: true, providerRef };
  } catch (err) {
    const detail = err?.message ? String(err.message).slice(0, 200) : 'no answer from the provider';
    // providerRefused is the adapter asserting that the provider received this
    // request, said no, and moved nothing — the one case where releasing the
    // reserved money is safe. It is opt-in precisely so that a thrown Error
    // from anywhere else, which carries no such assertion, stays UNKNOWN.
    return { confirmed: false, refused: err?.providerRefused === true, detail };
  }
};

// Records whichever of the three outcomes we actually got. The row already
// exists and already holds the money; this only fills in what the provider
// told us — and releases the reservation in the single case where the provider
// is known to have moved nothing.
//
// A provider that webhooks faster than this UPDATE lands leaves an event that
// matches no refund. That fails in the safe direction — the event is stored
// with its reason and counted as a reconciliation exception, and the refund
// stays visibly unconfirmed rather than being reported as money returned.
const recordProviderAnswer = async (refundId, answer) => {
  let data;
  if (answer.confirmed) {
    data = { providerRef: answer.providerRef, failureReason: null };
  } else if (answer.refused) {
    // FAILED, not left pending: the provider refused, so this amount was never
    // going to move and holding it would block every later refund on the order
    // behind a reconciliation that has nothing to reconcile.
    data = {
      status: 'FAILED',
      settledAt: new Date(),
      failureReason: `the payment provider refused the refund: ${answer.detail}`,
    };
  } else {
    data = { failureReason: `provider did not confirm the request: ${answer.detail}` };
  }
  return prisma.refund.update({
    where: { id: refundId },
    data,
    include: { by: { select: { id: true, fullName: true } } },
  });
};

router.post(
  '/:id/refunds',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const body = z.object({ amount: money2, reason: reasonSchema }).parse(req.body);
    const order = await loadOrder(req);
    const amount = toPaise(body.amount);

    // PHASE 1 — reserve the money locally, and commit, BEFORE the provider is
    // called. A request that is sent but never answered still holds its amount
    // here, so an unknown outcome can never become a second refund.
    const reservation = await prisma.$transaction(async (tx) => {
      // Serialises every refund on this order. Under READ COMMITTED two
      // concurrent requests otherwise each read a state with the other's row
      // invisible, both clear the cap, and both insert — the customer is
      // refunded twice for one order.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: REFUND_PAYMENT_INCLUDE, refunds: REFUND_STATE_SELECT },
      });
      if (!['BILLED', 'PAID'].includes(cur.status)) {
        throw conflict('Refunds apply to billed or paid orders only');
      }

      // An unanswered request already out with the provider makes every figure
      // on this order provisional. Raising a second one on top would be
      // guessing about money that may already have moved.
      if (cur.refunds.some(isUnconfirmedGatewayRefund)) {
        throw conflict(
          'An earlier refund on this order was sent to the payment provider and never confirmed. ' +
            'Reconcile that request before raising another, or the same money could be returned twice',
        );
      }

      const collected = cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      // Reserved, not settled: a request already in flight with the provider
      // still holds that money, or the same amount could be asked back twice.
      if (amount > collected - reservedRefundPaise(cur.refunds)) {
        throw badRequest('Refund exceeds the amount collected', 'amount');
      }

      // Money collected through the provider can only be returned by the
      // provider, and only out of the charge that took it. Refunding it against
      // the till would hand back cash the shop never received here.
      const legs = refundLegs(cur);
      if (legs.gateway.length > 0 && !gatewayAvailable()) {
        throw conflict(
          'This order was paid through a payment provider that is no longer configured; ' +
            'the refund has to be issued from the provider dashboard and recorded there',
        );
      }

      const leg = pickRefundLeg(legs, amount);
      if (!leg) {
        // Never split a refund across legs on the operator's behalf: which
        // part of a mixed payment to return is their decision, not a default.
        throw badRequest(
          `This order was paid in more than one part and no single payment has ₹${rupees(amount)} ` +
            `left to return. The most that can go back on one payment is ₹${rupees(largestRefundablePaise(legs))}. ` +
            'Refund each payment separately.',
          'amount',
        );
      }

      const viaGateway = leg.channel === 'GATEWAY';
      const created = await tx.refund.create({
        data: {
          orderId: order.id,
          amount: rupees(amount),
          reason: body.reason,
          byId: req.user.id,
          // PENDING is the whole point: nothing has been returned yet, and
          // only a signature-verified webhook may say otherwise.
          channel: viaGateway ? 'GATEWAY' : 'MANUAL',
          status: viaGateway ? 'PENDING' : 'SUCCEEDED',
          settledAt: viaGateway ? null : new Date(),
          intentId: viaGateway ? leg.intentId : null,
          // Minted here and kept, so a retry is the same request rather than
          // a second one. providerRef stays null until the provider answers.
          idempotencyKey: viaGateway ? randomUUID() : null,
          providerRef: null,
        },
        include: { by: { select: { id: true, fullName: true } } },
      });

      // Only settled money closes the order. A pending gateway request leaves
      // it PAID, because as of this instant the customer still has none of it
      // back and the order has not been unwound.
      const settled = settledRefundPaise(cur.refunds) + (viaGateway ? 0 : amount);
      if (cur.status === 'PAID' && settled === collected) {
        await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      }
      return { refund: created, leg };
    });

    // PHASE 2 — now ask the provider. The reservation above survives whatever
    // happens here, including this process dying mid-call.
    let refund = reservation.refund;
    let answer = { confirmed: true };
    if (refund.channel === 'GATEWAY') {
      answer = await sendRefundToProvider(refund, reservation.leg, order.id);
      refund = await recordProviderAnswer(refund.id, answer);
    }

    await audit(req, {
      action: refund.channel === 'GATEWAY' ? 'ORDER_REFUND_REQUESTED' : 'ORDER_REFUND',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        amount: String(refund.amount),
        reason: body.reason,
        channel: refund.channel,
        status: refund.status,
        providerConfirmed: refund.channel === 'GATEWAY' ? answer.confirmed : null,
      },
    });

    // 202, not 201: the refund is on record and holding its money, but whether
    // the provider took it is unknown. Saying 201 would claim it was placed.
    res.status(answer.confirmed ? 201 : 202).json({
      order: await fullOrder(order.id),
      refund: publicRefund(refund),
      ...(answer.confirmed
        ? {}
        : {
            warning:
              'The refund was recorded and its amount is held, but the payment provider did not confirm it. ' +
              'It may still pay out. Reconcile this refund — do not raise a new one.',
          }),
    });
  }),
);

// Re-sends a refund the provider never confirmed, with THE SAME idempotency
// key it was first sent under. That is the whole mechanism: a provider that
// honours the key returns the original refund instead of creating a second,
// so this is safe to call however many times it takes.
router.post(
  '/:id/refunds/:refundId/reconcile',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req);
    const existing = await prisma.refund.findFirst({
      where: { id: req.params.refundId, orderId: order.id },
      // The charge id lives on the Payment the intent settled into, and a
      // refund posts to the charge — so the reconcile leg has to reach through
      // the intent to it, exactly as the original request did.
      include: {
        intent: {
          select: { providerRef: true, payment: { select: { providerRef: true } } },
        },
      },
    });
    if (!existing) throw notFound('Refund not found');
    if (existing.channel !== 'GATEWAY') {
      throw conflict('Only a refund issued through the payment provider can be reconciled');
    }
    if (existing.status !== 'PENDING') {
      throw conflict(`This refund is already ${existing.status.toLowerCase()}`);
    }
    if (existing.providerRef) {
      throw conflict('The provider already has this refund; it is waiting for the provider to pay it out');
    }
    if (!gatewayAvailable()) {
      throw conflict(
        'The payment provider is not configured on this deployment, so this refund cannot be reconciled here',
      );
    }

    const answer = await sendRefundToProvider(
      existing,
      {
        intentProviderRef: existing.intent?.providerRef ?? null,
        chargeProviderRef: existing.intent?.payment?.providerRef ?? null,
      },
      order.id,
    );
    const refund = await recordProviderAnswer(existing.id, answer);

    await audit(req, {
      action: 'ORDER_REFUND_RECONCILED',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        refundId: refund.id,
        amount: String(refund.amount),
        providerConfirmed: answer.confirmed,
      },
    });

    res.status(answer.confirmed ? 200 : 202).json({
      order: await fullOrder(order.id),
      refund: publicRefund(refund),
      ...(answer.confirmed
        ? {}
        : {
            warning:
              'The provider still did not confirm this refund. Its amount stays held. Try again, ' +
              'or settle it from the provider dashboard.',
          }),
    });
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
        include: {
          payments: { select: { amount: true } },
          refunds: { select: { amount: true, status: true } },
        },
      });
      if (!['OPEN', 'BILLED'].includes(cur.status)) {
        throw conflict('Only open or billed orders can be voided');
      }
      const collected = cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      // Settled, not reserved. A gateway refund the provider has not paid out
      // yet leaves the customer still out of pocket, so voiding here would
      // close an order that still owes somebody money.
      const refunded = settledRefundPaise(cur.refunds);
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
