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
import { applyGatewayEvent, isAlreadySettled, EVENT_SUCCEEDED } from '../../lib/gateway/apply.js';
import { sha256Hex } from '../../lib/gateway/signature.js';
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
import { deviceContext, assertDeviceStore, deviceStamp } from '../../middleware/device.js';
import { toPaise, toRupees, pctToMilli } from '../../lib/money.js';
import { guardDiscountChange } from '../../lib/discountGuard.js';
import { combinedPctMilli, exposureOf, limitForAudit } from '../../lib/discountPolicy.js';
import { nextInvoiceNumber, sellerOfRecord, billingSnapshot } from '../../lib/invoice.js';
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
  inferRefundMethod,
} from '../../lib/orders.js';

const router = Router();
// deviceContext AFTER resolveCompanyScope — a device token can only be judged
// once the tenant it must belong to is known. It is optional: a browser till
// that sends no token passes straight through and attributes less.
router.use(requirePosAuth, resolveCompanyScope, deviceContext);

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
  // Every route in this file that touches an existing order comes through here,
  // so the device's store scope is enforced once rather than remembered twenty
  // times. A device at one store cannot add items to, bill, collect on, refund
  // or void an order belonging to another — even with a valid user session.
  assertDeviceStore(req, order.branchId);
  return order;
};

const fullOrder = async (id) =>
  serializeOrder(await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE }));

const assertOpen = (order) => {
  if (order.status !== 'OPEN') throw conflict('Order is not open');
};

// --- discount authority ------------------------------------------------------
// Every route below that can move money off a bill measures the order twice —
// as it stands and as the request would leave it — and hands both to the
// guard. Twice, because the question is never "is this discount allowed" on
// its own: a cashier must still be able to add a coffee to an order a manager
// discounted 30%, and must not be able to void half the order under a fixed
// ₹100 discount and turn it into 50% off. Only the before/after pair can tell
// those apart. See src/lib/discountPolicy.js.
//
// Quantities and prices travel in paise here, matching money.js, so the figure
// a limit is checked against is the figure that will be charged.

const activeLines = (items) =>
  items
    .filter((i) => i.status === 'ACTIVE')
    .map((i) => ({
      id: i.id,
      unitPrice: paiseOf(i.unitPrice),
      qty: i.qty,
      lineDiscount: paiseOf(i.lineDiscount),
    }));

const orderDiscountOf = (order) => {
  if (!order.discountType) return null;
  return order.discountType === 'FLAT'
    ? { type: 'FLAT', value: paiseOf(order.discountValue) }
    : { type: 'PERCENT', value: pctToMilli(String(order.discountValue)) };
};

// An approval block is optional on every one of these routes. It is only
// looked at when the actor's own authority falls short, and it is never
// stored — see the note at the top of discountGuard.js.
const approvalSchema = z
  .object({
    approverEmail: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(200),
    reason: reasonSchema,
  })
  .optional();

// Requests that move a discount VALUE always restate who allowed the result:
// the approver who just signed for it, or nobody. Requests that only move
// quantities leave the existing record alone, because it is still true.
const approvalStamp = (approver, reason) =>
  approver
    ? {
        discountApprovedById: approver.id,
        discountApprovedAt: new Date(),
        discountReason: reason,
      }
    : { discountApprovedById: null, discountApprovedAt: null, discountReason: null };

// `policy` is the limit that was in force for this actor at this instant, and
// it is written onto allowed discounts too — not just refused ones. Read back
// months later, "cashier took 30% off" means nothing without it: the policy row
// it was measured against is editable, so reconstructing the limit from today's
// settings would judge a past action by a rule that did not exist yet.
const discountAudit = (policy, before, after, approver, reason) => ({
  actorLimit: limitForAudit(policy),
  before: {
    grossPaise: before.grossPaise,
    combinedDiscountPaise: before.combinedPaise,
    combinedPctMilli: combinedPctMilli(before.combinedPaise, before.grossPaise),
  },
  after: {
    grossPaise: after.grossPaise,
    combinedDiscountPaise: after.combinedPaise,
    combinedPctMilli: combinedPctMilli(after.combinedPaise, after.grossPaise),
  },
  approvedBy: approver
    ? {
        id: approver.id,
        email: approver.email,
        role: approver.role,
        selfApproved: approver.selfApproved,
      }
    : null,
  approvalReason: approver ? reason : null,
});

// Snapshots product/variant/tax at add time — later catalog edits never touch
// an existing order line.
// Exported for LANE vc104-api: the phone-order centre snapshots catalog lines
// the same way the till does. Exporting beats copying - a second copy would
// drift the day this gains modifiers, and both paths must price identically.
export const resolveCatalogLine = async (companyId, { productId, variantId, qty }) => {
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
    // A device credential is scoped to one store. Checked here, server-side,
    // against the branch the route actually resolved — not against whatever the
    // body claimed.
    assertDeviceStore(req, branch.id);

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
          // Where the order was OPENED. Not re-stamped at bill or payment time:
          // each payment carries its own till, so a bill started on a handheld
          // and settled at the counter records both truthfully instead of one
          // overwriting the other.
          ...deviceStamp(req),
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
        approval: approvalSchema,
      })
      .parse(req.body);
    const order = await loadOrder(req, { items: true });
    assertOpen(order);
    const line = await resolveCatalogLine(req.companyScope.id, body);

    // Adding to the order leaves a percentage discount at the same
    // percentage, so a percentage ceiling has nothing to say here. A cash
    // ceiling does: under a percentage discount, a bigger bill is a bigger
    // discount in rupees, and that is the number a cash ceiling exists to
    // bound. Guarded for that case alone, and it passes silently otherwise.
    const measure = (o) => {
      const lines = activeLines(o.items);
      const orderDiscount = orderDiscountOf(o);
      return {
        before: exposureOf(lines, orderDiscount),
        after: exposureOf(
          [...lines, { id: '__new__', unitPrice: paiseOf(line.unitPrice), qty: line.qty, lineDiscount: 0 }],
          orderDiscount,
        ),
      };
    };
    const { policy, before, after, approver, reason } = await guardDiscountChange(req, {
      order,
      measure,
      shape: { raisesLineDiscount: false, raisesOrderDiscount: false },
      approval: body.approval,
      action: 'ORDER_ITEM_ADD',
      apply: async (tx, { approver: signer, reason: signedReason }) => {
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
        // Only written when somebody actually had to sign for this add. An add
        // that stayed inside the operator's own limit leaves any earlier
        // approval standing, because that approval is still the one in force.
        if (signer) {
          await tx.order.update({
            where: { id: order.id },
            data: approvalStamp(signer, signedReason),
          });
        }
        await recomputeOrder(tx, order.id);
      },
    });

    await audit(req, {
      action: 'ORDER_ITEM_ADD',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        productId: line.productId,
        variantId: line.variantId,
        qty: line.qty,
        branchId: order.branchId,
        ...discountAudit(policy, before, after, approver, reason),
      },
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
        approval: approvalSchema,
      })
      .refine((b) => (b.qty === undefined) !== (b.lineDiscount === undefined), {
        message: 'Send exactly one of qty or lineDiscount',
      })
      .parse(req.body);
    const order = await loadOrder(req, { items: true });
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

    // A quantity change moves the gross, which moves what the existing
    // discount is worth as a share of the bill — so this is guarded whether
    // or not the request names a discount at all.
    const newLineDiscount =
      body.lineDiscount !== undefined ? toPaise(body.lineDiscount) : paiseOf(item.lineDiscount);
    const measure = (o) => {
      const lines = activeLines(o.items);
      const orderDiscount = orderDiscountOf(o);
      return {
        before: exposureOf(lines, orderDiscount),
        after: exposureOf(
          lines.map((l) => (l.id === item.id ? { ...l, qty, lineDiscount: newLineDiscount } : l)),
          orderDiscount,
        ),
      };
    };
    const { policy, before, after, approver, reason } = await guardDiscountChange(req, {
      order,
      measure,
      shape: {
        raisesLineDiscount:
          body.lineDiscount !== undefined && newLineDiscount > paiseOf(item.lineDiscount),
        raisesOrderDiscount: false,
      },
      approval: body.approval,
      action: 'ORDER_ITEM_UPDATE',
      apply: async (tx, { approver: signer, reason: signedReason }) => {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            ...(body.qty !== undefined ? { qty: body.qty } : {}),
            ...(body.lineDiscount !== undefined
              ? { lineDiscount: body.lineDiscount.toFixed(2) }
              : {}),
          },
        });
        // Only a request that moved a discount value restates who allowed it.
        // A quantity edit leaves an earlier approval standing, because the
        // approval it recorded is still the one in force.
        if (body.lineDiscount !== undefined) {
          await tx.order.update({
            where: { id: order.id },
            data: approvalStamp(signer, signedReason),
          });
        }
        await recomputeOrder(tx, order.id);
      },
    });

    await audit(req, {
      action: 'ORDER_ITEM_UPDATE',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        itemId: item.id,
        ...(body.qty !== undefined ? { qty: body.qty } : {}),
        ...(body.lineDiscount !== undefined ? { lineDiscount: body.lineDiscount } : {}),
        branchId: order.branchId,
        ...discountAudit(policy, before, after, approver, reason),
      },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.delete(
  '/:id/items/:itemId',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = z.object({ approval: approvalSchema }).parse(req.body ?? {});
    const order = await loadOrder(req, { items: true });
    assertOpen(order);
    const item = await loadItem(req, order);
    if (item.status !== 'ACTIVE') throw conflict('Line is voided');
    if (item.kotId) throw conflict('Line is already sent to the kitchen; void it instead');

    // Taking a line off shrinks the bill the discount is measured against.
    // Under a fixed discount that is how an in-limit 10% becomes an
    // out-of-limit 50% without anybody touching the discount field.
    const measure = (o) => {
      const lines = activeLines(o.items);
      const orderDiscount = orderDiscountOf(o);
      return {
        before: exposureOf(lines, orderDiscount),
        after: exposureOf(
          lines.filter((l) => l.id !== item.id),
          orderDiscount,
        ),
      };
    };
    const { policy, before, after, approver, reason } = await guardDiscountChange(req, {
      order,
      measure,
      shape: { raisesLineDiscount: false, raisesOrderDiscount: false },
      approval: body.approval,
      action: 'ORDER_ITEM_REMOVE',
      apply: async (tx, { approver: signer, reason: signedReason }) => {
        await tx.orderItem.delete({ where: { id: item.id } });
        if (signer) {
          await tx.order.update({
            where: { id: order.id },
            data: approvalStamp(signer, signedReason),
          });
        }
        await recomputeOrder(tx, order.id);
      },
    });

    await audit(req, {
      action: 'ORDER_ITEM_REMOVE',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        itemId: item.id,
        name: item.name,
        branchId: order.branchId,
        ...discountAudit(policy, before, after, approver, reason),
      },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.post(
  '/:id/items/:itemId/void',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: reasonSchema, approval: approvalSchema }).parse(req.body);
    const order = await loadOrder(req, { items: true });
    assertOpen(order);
    const item = await loadItem(req, order);
    if (item.status !== 'ACTIVE') throw conflict('Line is already voided');
    if (!item.kotId) throw conflict('Line was never sent to the kitchen; delete it instead');

    // Same shrinking bill as a line removal, so the same guard.
    const measure = (o) => {
      const lines = activeLines(o.items);
      const orderDiscount = orderDiscountOf(o);
      return {
        before: exposureOf(lines, orderDiscount),
        after: exposureOf(
          lines.filter((l) => l.id !== item.id),
          orderDiscount,
        ),
      };
    };
    const { policy, before, after, approver, reason: approvalReason } = await guardDiscountChange(req, {
      order,
      measure,
      shape: { raisesLineDiscount: false, raisesOrderDiscount: false },
      approval: body.approval,
      action: 'ORDER_ITEM_VOID',
      apply: async (tx, { approver: signer, reason: signedReason }) => {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { status: 'VOIDED', voidReason: body.reason, voidedById: req.user.id },
        });
        if (signer) {
          await tx.order.update({
            where: { id: order.id },
            data: approvalStamp(signer, signedReason),
          });
        }
        await recomputeOrder(tx, order.id);
      },
    });

    await audit(req, {
      action: 'ORDER_ITEM_VOID',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        itemId: item.id,
        name: item.name,
        reason: body.reason,
        branchId: order.branchId,
        ...discountAudit(policy, before, after, approver, approvalReason),
      },
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
      .object({ type: z.enum(['FLAT', 'PERCENT']), value: money2, approval: approvalSchema })
      .parse(req.body);
    const order = await loadOrder(req, { items: true });
    assertOpen(order);
    if (body.type === 'PERCENT' && body.value > 100) {
      throw badRequest('PERCENT discount cannot exceed 100', 'value');
    }
    if (body.type === 'FLAT' && toPaise(body.value) > paiseOf(order.subtotal)) {
      throw badRequest('FLAT discount cannot exceed the subtotal', 'value');
    }

    const measure = (o) => {
      const lines = activeLines(o.items);
      return {
        before: exposureOf(lines, orderDiscountOf(o)),
        after: exposureOf(lines, {
          type: body.type,
          value: body.type === 'FLAT' ? toPaise(body.value) : pctToMilli(body.value),
        }),
      };
    };
    // Whether this request RAISES the order discount is a question about what
    // was asked for, so it is answered against the bill as the route read it.
    // The ceiling is the thing that gets re-checked against fresh state.
    const asked = measure(order);
    const { policy, before, after, approver, reason } = await guardDiscountChange(req, {
      order,
      measure,
      shape: {
        raisesLineDiscount: false,
        raisesOrderDiscount: asked.after.orderDiscountPaise > asked.before.orderDiscountPaise,
      },
      approval: body.approval,
      action: 'ORDER_DISCOUNT_SET',
      apply: async (tx, { approver: signer, reason: signedReason }) => {
        // A request that re-sends the discount already on the bill moves no
        // money, and so must not restate who authorised it. The till's modal
        // opens pre-filled with the current value, which makes pressing
        // "Apply discount" a second time an ordinary thing for a cashier to
        // do — no tampering required. Without this, that second press cleared
        // discountApprovedById/At/Reason, and an approved above-limit discount
        // silently became one that reads as unapproved on the very row billing
        // and reporting trust. Read under the same lock the guard took, so the
        // comparison is against the bill as it actually stands.
        //
        // A signer is still stamped even when nothing moves: approving the
        // same figure again is a real approval, and the trail should say so.
        // The sibling line-discount route already refuses to restate a stamp
        // it did not move; this is that rule for the order-level discount.
        const current = await tx.order.findUnique({
          where: { id: order.id },
          select: { discountType: true, discountValue: true },
        });
        const unchanged =
          current?.discountType === body.type &&
          current?.discountValue != null &&
          Number(current.discountValue).toFixed(2) === body.value.toFixed(2);

        await tx.order.update({
          where: { id: order.id },
          data: {
            discountType: body.type,
            discountValue: body.value.toFixed(2),
            ...(unchanged && !signer ? {} : approvalStamp(signer, signedReason)),
          },
        });
        await recomputeOrder(tx, order.id);
      },
    });

    await audit(req, {
      action: 'ORDER_DISCOUNT_SET',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        type: body.type,
        value: body.value,
        branchId: order.branchId,
        ...discountAudit(policy, before, after, approver, reason),
      },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.delete(
  '/:id/discount',
  ...operate,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, { items: true });
    assertOpen(order);

    // Removing a discount takes nothing further off the bill, so the guard
    // always clears it — but it still runs, so that the trail shows who
    // removed it and what the order looked like on either side.
    const measure = (o) => {
      const lines = activeLines(o.items);
      return {
        before: exposureOf(lines, orderDiscountOf(o)),
        after: exposureOf(lines, null),
      };
    };
    const { policy, before, after } = await guardDiscountChange(req, {
      order,
      measure,
      shape: { raisesLineDiscount: false, raisesOrderDiscount: false },
      approval: undefined,
      action: 'ORDER_DISCOUNT_CLEAR',
      apply: async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { discountType: null, discountValue: null, ...approvalStamp(null, null) },
        });
        await recomputeOrder(tx, order.id);
      },
    });
    await audit(req, {
      action: 'ORDER_DISCOUNT_CLEAR',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { branchId: order.branchId, ...discountAudit(policy, before, after, null, null) },
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

    // Read outside the transaction: master data the bill is about to quote, not
    // something the bill writes. Keeping it out keeps the counter transaction —
    // the one every till contends on — as short as it was before.
    const seller = await sellerOfRecord(prisma, order.branch);

    // One timestamp for the row and the snapshot, so the invoice cannot claim a
    // different billing instant from the order it belongs to.
    const billedAt = new Date();

    await prisma.$transaction(async (tx) => {
      // Guarded transition: a concurrent bill of the same order loses here.
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: 'OPEN' },
        data: { status: 'BILLED', billedAt },
      });
      if (moved.count === 0) throw conflict('Order is not open');
      await recomputeOrder(tx, order.id);
      const { invoiceNumber, seriesPrefix } = await nextInvoiceNumber(tx, order.branch, billedAt);
      await tx.order.update({
        where: { id: order.id },
        data: {
          invoiceNumber,
          // Frozen in the SAME statement that assigns the number. A snapshot
          // written afterwards could be lost to a crash, leaving an invoice
          // number with no record of who issued it.
          billingSnapshot: billingSnapshot({
            branch: order.branch,
            seller,
            invoiceNumber,
            seriesPrefix,
            at: billedAt,
          }),
        },
      });
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
        // One tender, one key, however many retries the network forces. See the
        // column comment on Payment.idempotencyKey: without it a retried PARTIAL
        // payment is collected twice, because the guards below only catch the
        // full-amount case. Optional, so an older till or an existing script
        // still works — but a caller that omits it is not protected, which is
        // why the browser always sends one.
        idempotencyKey: z.string().trim().min(8).max(64).optional(),
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

      // Replay check, and it has to be here: inside the lock, so a concurrent
      // duplicate waits and then sees the first row rather than racing it, and
      // ahead of every guard below, because a retried FULL payment leaves the
      // order PAID and would otherwise be refused with "Order is already paid
      // in full" — a refusal that is true but useless. The cashier asked "did
      // my payment land?", and the answer is the payment itself.
      //
      // This is the half the status guards never covered. They refuse a repeat
      // only once the order is fully collected, so a double-click on a full
      // tender is caught by accident; a retried PARTIAL payment sails straight
      // past them and is written twice. Proven on the deployed build against
      // BSC-CP/26-27/00011: one ₹47.25 card swipe, two payment rows, the order
      // marked PAID, and the drawer ₹47.25 short at day close with nothing on
      // screen to say so.
      if (body.idempotencyKey) {
        const prior = await tx.payment.findUnique({
          where: {
            orderId_idempotencyKey: { orderId: order.id, idempotencyKey: body.idempotencyKey },
          },
          include: { receivedBy: { select: { id: true, fullName: true } } },
        });
        if (prior) {
          // Same key, different money. The caller reused a key across two
          // genuinely different tenders — a till that regenerates on the wrong
          // event, a cloned device — and handing back the first row would
          // report a payment that was never taken while silently dropping one
          // that was. Refuse loudly instead: a replay is only a replay if it
          // is identical.
          const wanted =
            body.tendered !== undefined ? toPaise(body.tendered) : toPaise(body.amount);
          const had = prior.tendered === null ? paiseOf(prior.amount) : paiseOf(prior.tendered);
          if (prior.method !== body.method || wanted !== had) {
            throw conflict('This idempotency key was already used for a different payment');
          }
          return {
            payment: prior,
            replayed: true,
            changeDue:
              prior.tendered === null
                ? null
                : toRupees(paiseOf(prior.tendered) - paiseOf(prior.amount)),
          };
        }
      }

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
          // The store that issued the bill, copied from the order rather than
          // from the request. It is the column the terminal and device
          // references are checked against, so taking it from the caller would
          // hand the caller the power to attribute money to another store.
          branchId: order.branchId,
          method: body.method,
          amount: (applied / 100).toFixed(2),
          tendered: tendered === null ? null : (tendered / 100).toFixed(2),
          note: body.note ?? null,
          // Stored in the same statement that takes the money, so the row and
          // the thing that identifies it can never disagree. Null when the
          // caller sent none, which the unique index permits any number of.
          idempotencyKey: body.idempotencyKey ?? null,
          receivedById: req.user.id,
          // WHERE the money was actually taken. A day close reconciles cash per
          // till, so this has to be the till that took THIS payment, not the one
          // the order happened to be opened on.
          ...deviceStamp(req),
        },
        include: { receivedBy: { select: { id: true, fullName: true } } },
      });
      if (collected + applied >= total) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAID', closedAt: new Date() },
        });
      }
      return {
        payment,
        replayed: false,
        changeDue: tendered === null ? null : toRupees(tendered - applied),
      };
    });

    // A replay collected nothing, so it must not be audited as a collection.
    // ORDER_PAYMENT rows carry an amount and get summed; emitting one per
    // retry would rebuild, in the audit trail, exactly the double-count the
    // key just prevented. It still gets a row of its own — a till retrying is
    // worth seeing — with no amount to add up.
    await audit(req, {
      action: result.replayed ? 'ORDER_PAYMENT_REPLAY' : 'ORDER_PAYMENT',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: result.replayed
        ? { paymentId: result.payment.id, channel: 'MANUAL' }
        : { method: body.method, amount: String(result.payment.amount), channel: 'MANUAL' },
    });
    // 200, not 201: a replay created nothing. The body is otherwise identical
    // so a till that retries blind still renders the right receipt, and
    // `replayed` lets one that cares tell the difference.
    res.status(result.replayed ? 200 : 201).json({
      order: await fullOrder(order.id),
      payment: publicPayment(result.payment),
      changeDue: result.changeDue,
      replayed: result.replayed,
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

// --- pull-based settlement recovery -----------------------------------------

// Asks the provider what actually happened to one attempt, and records the
// payment if it says the money was captured.
//
// WHY THIS EXISTS
//
// Everything else here is push: the provider sends a webhook and the POS
// believes it. That is the right default — a signature over the raw body is
// the strongest evidence available — but it has one failure mode no amount of
// care inside the webhook route can fix. If the delivery never arrives at all
// (tunnel down, endpoint misconfigured, retries exhausted, webhook not
// registered on the account), the customer has paid and the POS shows the bill
// as still due. That is not hypothetical here: a captured sandbox payment from
// 2026-09-22 11:54Z is absent from this database for exactly that reason,
// because the account had no webhook registered at the time.
//
// So this is the pull half. It is deliberately a manager action rather than a
// background sweep: it is the manager who is standing in front of the customer
// with the provider's dashboard open, and a sweep that settles orders on its
// own would be making that judgement unattended.
//
// WHAT IT IS NOT
//
// It is not a second way to record money on weaker evidence. It records a
// payment only where the provider's own API says the charge was CAPTURED, and
// it routes that through applyGatewayEvent — the same function, with the same
// amount, order-state and amount-due checks, that the webhook uses. There is
// exactly one place in this codebase where a GATEWAY payment row is written,
// and this route did not become a second one.

// Said once because it is returned from two different places, and the caller
// must not be able to tell them apart. Which of the two the reconcile hit is
// a detail of transaction timing; the fact reported is the same fact.
const ALREADY_RECORDED = 'this payment was already recorded — the provider’s webhook arrived first';

router.post(
  '/:id/payment-intents/:intentId/reconcile',
  ...managerUp,
  asyncHandler(async (req, res) => {
    const adapter = getAdapter();
    const order = await loadOrder(req);

    // Found via the order, so an intent belonging to another company or
    // another bill is simply absent rather than probeable.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.intentId, orderId: order.id },
    });
    if (!intent) throw notFound('Payment intent not found');

    // Optional on the contract, so its absence is a refusal and never a
    // fallback to something that writes money on a weaker basis.
    if (typeof adapter.fetchSettlement !== 'function') {
      throw conflict('This payment provider cannot be asked what it did, so this payment cannot be reconciled here');
    }
    if (intent.provider !== adapter.name) {
      throw conflict('This payment was opened with a different provider from the one configured now');
    }
    if (!intent.providerRef) {
      throw conflict('This payment was never opened with the provider, so there is nothing to ask about');
    }
    if (intent.status === 'SUCCEEDED') {
      throw conflict('This payment has already been recorded');
    }

    // Reached over the network, so no transaction is open — same rule as
    // createSession and createRefund. A provider round trip that outlasts
    // Prisma's transaction timeout would roll back whatever the transaction
    // held while the provider carried on regardless.
    let answer;
    try {
      answer = await adapter.fetchSettlement({ intentProviderRef: intent.providerRef });
    } catch (err) {
      // Every failure mode of the fetch lands here and changes NOTHING. An
      // unreadable answer, two captures on one order, a network timeout — all
      // of them mean the provider's position could not be established, and
      // none of them is a reason to write a payment or to close the intent.
      const detail = err?.message ? String(err.message).slice(0, 200) : 'no answer from the provider';
      await audit(req, {
        action: 'GATEWAY_SETTLEMENT_RECONCILE_FAILED',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, provider: adapter.name, detail },
      });
      throw badGateway('The payment provider could not be asked what happened to this payment');
    }

    if (!answer?.settled) {
      // A real answer, and the answer is no. The intent is left open on
      // purpose: "not captured yet" is not "will never be captured", and
      // closing it here would stop the customer paying against a page the
      // provider still considers live.
      await audit(req, {
        action: 'GATEWAY_SETTLEMENT_RECONCILED',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, provider: adapter.name, settled: false, reason: answer?.reason ?? null },
      });
      return res.status(200).json({
        settled: false,
        reason: answer?.reason ?? 'the provider reported no captured payment on this attempt',
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    // --- is what we just fetched actually ours? ---
    //
    // Everything above this point trusts the configured key pair to still
    // point at the account the intent was opened on. Nothing guarantees that:
    // keys get rotated, environments get pointed at the wrong account, and a
    // sandbox key and a live key differ by four characters. These are the
    // checks that make the fetch self-proving instead — receipt and
    // pos_order_id are values THIS code sent at createSession, and they are
    // compared against our own row rather than against configuration.
    const mismatch =
      answer.providerRef && answer.providerRef !== intent.providerRef
        ? 'the provider answered about a different payment attempt'
        : answer.posOrderId && answer.posOrderId !== order.id
          ? 'the provider has this payment against a different order'
          : answer.receipt && answer.receipt !== intent.idempotencyKey
            ? 'the provider has this payment under a different reference'
            : !answer.posOrderId && !answer.receipt
              ? 'the provider returned nothing that ties this payment to this order'
              : answer.captured !== true
                // Authorized is money blocked on a card that the shop has not
                // received. Recording it would close an order nobody has been
                // paid for.
                ? 'the provider reports this payment as not captured'
                : !answer.currency
                  // Silence is not agreement. An adapter that stops reporting
                  // currency would otherwise have every capture read as INR.
                  ? 'the provider did not say which currency it settled in'
                  : String(answer.currency).toUpperCase() !== String(intent.currency ?? '').toUpperCase()
                    // The amount is an integer count of minor units, and
                    // integers carry no units: 10500 cents and 10500 paise
                    // compare equal. Only this check can tell them apart.
                    ? 'the provider settled this payment in a different currency'
                    : null;
    if (mismatch) {
      await audit(req, {
        action: 'GATEWAY_SETTLEMENT_REFUSED',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, provider: adapter.name, reason: mismatch, chargeRef: answer.chargeRef ?? null },
      });
      throw conflict(`This payment could not be reconciled: ${mismatch}`);
    }
    if (!answer.chargeRef) {
      throw conflict('This payment could not be reconciled: the provider did not name the charge');
    }

    // The charge id is the event id, which is what makes running this twice
    // harmless: the second run collides on (provider, eventId) rather than
    // settling anything again. A genuine webhook for the same money carries
    // the PROVIDER's event id, which is a different value, so it does not
    // collide here — it collides on Payment.intentId instead, one layer down,
    // and is recorded as the skip it is.
    const eventId = answer.chargeRef;
    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const event = await tx.gatewayWebhookEvent.create({
          data: {
            provider: adapter.name,
            eventId,
            kind: EVENT_SUCCEEDED,
            // Hash of the answer we acted on, not of a delivery: there were no
            // signed bytes here. It is still the record of what this decision
            // was made from.
            payloadHash: sha256Hex(JSON.stringify(answer)),
            // Never WEBHOOK. Nobody delivered this; we went and asked.
            source: 'RECOVERY',
          },
        });

        const applied = await applyGatewayEvent(tx, {
          provider: adapter.name,
          providerRef: intent.providerRef,
          kind: EVENT_SUCCEEDED,
          amountPaise: answer.amountPaise,
          currency: answer.currency,
          method: answer.method,
          chargeRef: answer.chargeRef,
        });

        await tx.gatewayWebhookEvent.update({
          where: { id: event.id },
          data: {
            processedAt: new Date(),
            intentId: applied.intentId ?? null,
            skippedReason: applied.skippedReason ?? null,
          },
        });

        return applied;
      });
    } catch (err) {
      // The race this route is most likely to lose, and the one it must lose
      // safely: the webhook landed while we were asking the provider. The
      // unique index refused the second write, the whole transaction rolled
      // back with it, and the money is recorded exactly once — by the webhook.
      // Nothing to repair, so this is a 200 describing what is true now.
      if (isAlreadySettled(err)) {
        return res.status(200).json({
          settled: true,
          recorded: false,
          alreadyRecorded: true,
          reason: ALREADY_RECORDED,
          order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
        });
      }
      throw err;
    }

    if (!outcome.payment) {
      // Verified, fetched, and still deliberately not applied — the amount
      // disagreed, or the order moved on. Recorded on the event row and
      // surfaced by the reconciliation report for a human to judge.
      //
      // One arrival here is NOT a discrepancy, and it is the likeliest of all:
      // the webhook won the race outright, committing before this transaction
      // read the intent. applyGatewayEvent then found it already SUCCEEDED and
      // skipped, so no unique index was ever touched and nothing threw — the
      // catch above never ran. The money is recorded exactly once either way,
      // but a caller cannot infer that from a reason string, and a manager
      // being told "not applied" about a bill the customer has paid will go
      // looking to pay it again. The payment row settles it: if this intent has
      // one, this attempt is recorded, whichever side of the read it landed.
      const recorded = await prisma.payment.findUnique({
        where: { intentId: intent.id },
        select: { id: true },
      });
      return res.status(200).json({
        settled: true,
        recorded: false,
        ...(recorded ? { alreadyRecorded: true } : {}),
        reason: recorded ? ALREADY_RECORDED : (outcome.skippedReason ?? 'the payment was not applied'),
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    // ORDER_PAYMENT, exactly as the webhook writes it, because this is the
    // same money arriving by a different route and every report that reads
    // takings has to see both. `via` is what tells them apart afterwards.
    await audit(req, {
      action: 'ORDER_PAYMENT',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        method: outcome.payment.method,
        amount: String(outcome.payment.amount),
        channel: 'GATEWAY',
        provider: adapter.name,
        intentId: outcome.intentId,
        via: 'RECOVERY',
        chargeRef: answer.chargeRef,
      },
    });

    res.status(200).json({
      settled: true,
      recorded: true,
      payment: publicPayment(outcome.payment),
      order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
    });
  }),
);

// --- refunds ----------------------------------------------------------------

const REFUND_PAYMENT_INCLUDE = {
  select: {
    amount: true,
    channel: true,
    method: true,
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
    const body = z
      .object({
        amount: money2,
        reason: reasonSchema,
        // How a manual refund goes back. Optional when the bill was settled in
        // one tender, required when it was split. Ignored for money going back
        // through the provider, which only the provider can return.
        method: z.enum(['CASH', 'CARD', 'UPI', 'OTHER']).optional(),
      })
      .parse(req.body);
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
      const method = viaGateway ? null : body.method ?? inferRefundMethod(cur.payments);
      if (!viaGateway && !method) {
        throw badRequest(
          'This bill was paid by more than one method. Say how this refund goes back — cash from the till, ' +
            'a reversal on the card terminal, or UPI — so the day close counts the drawer correctly.',
          'method',
        );
      }
      const created = await tx.refund.create({
        data: {
          orderId: order.id,
          amount: rupees(amount),
          reason: body.reason,
          method,
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
        method: refund.method ?? null,
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
