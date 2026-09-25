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
import { resolveAccount, resolveAccountRow, PaymentAccountError } from '../../lib/gateway/accounts.js';
import { sha256Hex } from '../../lib/gateway/signature.js';
import { getConnector } from '../../lib/terminal/index.js';
import {
  asyncHandler,
  badGateway,
  badRequest,
  conflict,
  forbidden,
  notFound,
  terminalUnavailable,
} from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  isBranchPinned,
  branchIdFilterFor,
} from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  resolveStoreInScope,
} from '../../middleware/permissions.js';
import { deviceContext, assertDeviceStore, deviceStamp } from '../../middleware/device.js';
import { evaluatePromotion, stackingRefusal } from '../../lib/promotions.js';
import { toPaise, toRupees, pctToMilli } from '../../lib/money.js';
import { guardDiscountChange } from '../../lib/discountGuard.js';
import { combinedPctMilli, exposureOf, limitForAudit } from '../../lib/discountPolicy.js';
import { nextInvoiceNumber, sellerOfRecord, billingSnapshot } from '../../lib/invoice.js';
import { routeKotItems } from '../../lib/kitchen.js';
// ==== LANE inventory ====
import { consumeForOrder } from '../../lib/inventory/consumption.js';
// ==== END LANE inventory ====
// LANE providers — the whole of this lane's contact with the till, five calls
// that cannot throw. See lib/integrations/hooks.js for why they are shaped that
// way and what runs when none of them fires.
import {
  onOrderBilled,
  onPaymentRecorded,
  onRefundSettled,
  onOrderVoided,
} from '../../lib/integrations/hooks.js';
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
  REFUND_PAYMENT_INCLUDE,
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

// Snapshots product/variant/modifier/tax at add time — later catalog edits
// never touch an existing order line. Chosen modifiers are validated against
// the product's groups (minSelect..maxSelect) and their per-unit prices are
// FOLDED INTO unitPrice, so every downstream reader — totals, taxes, discount
// shares and the promotion eligible base — sees the modifier-inclusive price
// by construction (spec VC-102 modifier treatment). The rows returned in
// `modifiers` are the printed breakdown of that fold.
//
// Exported for LANE vc104-api: the phone-order centre snapshots catalog lines
// the same way the till does. Exporting beats copying — a second copy would
// drift the day this gains modifiers, and both paths must price identically.
// That day was the a406 consolidation, and it drifted exactly as predicted:
// vc104 had written its caller against the pre-modifier signature, so the
// minSelect loop below refused every product with a REQUIRED group on the
// phone path (D-3). Fixed 09-24 — `phoneOrders.js` now passes
// modifierOptionIds, and shares `mergeCatalogItems` and `createLineData` with
// the till below rather than keeping its own copies. The lesson the defect
// actually taught: exporting the PRICING function was not enough, because the
// line-merge key and the row writer encode the same modifier semantics and
// those had been duplicated.
export const resolveCatalogLine = async (companyId, { productId, variantId, qty, modifierOptionIds }) => {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId, status: 'ACTIVE' },
    include: {
      taxRate: true,
      variants: true,
      modifierGroups: { include: { options: true } },
    },
  });
  if (!product) throw badRequest('Unknown or archived product', 'productId');
  let variant = null;
  if (variantId) {
    variant = product.variants.find((v) => v.id === variantId && v.status === 'ACTIVE') ?? null;
    if (!variant) throw badRequest('Unknown or archived variant', 'variantId');
  }

  const chosenIds = [...new Set(modifierOptionIds ?? [])];
  const activeGroups = product.modifierGroups.filter((g) => g.status === 'ACTIVE');
  const optionIndex = new Map();
  for (const g of activeGroups) {
    for (const m of g.options) {
      if (m.status === 'ACTIVE') optionIndex.set(m.id, { group: g, option: m });
    }
  }
  const modifiers = [];
  const perGroup = new Map();
  for (const id of chosenIds) {
    const hit = optionIndex.get(id);
    if (!hit) throw badRequest('Unknown or archived modifier option', 'modifierOptionIds');
    perGroup.set(hit.group.id, (perGroup.get(hit.group.id) ?? 0) + 1);
    modifiers.push({
      optionId: hit.option.id,
      groupName: hit.group.name,
      name: hit.option.name,
      price: hit.option.price,
    });
  }
  for (const g of activeGroups) {
    const count = perGroup.get(g.id) ?? 0;
    if (count < g.minSelect) {
      throw badRequest(`Choose at least ${g.minSelect} from "${g.name}"`, 'modifierOptionIds');
    }
    if (g.maxSelect !== null && count > g.maxSelect) {
      throw badRequest(`Choose at most ${g.maxSelect} from "${g.name}"`, 'modifierOptionIds');
    }
  }

  const basePaise = paiseOf(variant ? variant.price : product.basePrice);
  const modifierPaise = modifiers.reduce((a, m) => a + paiseOf(m.price), 0);
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    name: variant ? `${product.name} (${variant.name})` : product.name,
    unitPrice: ((basePaise + modifierPaise) / 100).toFixed(2),
    qty,
    taxRateName: product.taxRate?.name ?? null,
    taxRatePercent: product.taxRate?.ratePercent ?? null,
    modifiers,
  };
};

// A line only merges with another line carrying the SAME modifier choice.
const modifierKeyOf = (mods) => (mods ?? []).map((m) => m.optionId).sort().join(',');

// The same rule stated over a REQUEST item rather than a resolved line: dedupe
// and sort, because ["a","b"], ["b","a"] and ["a","a","b"] are one basket
// choice and must land on one line. Shared with the phone path — D-3 came from
// the phone centre carrying its own merge key that knew nothing about
// modifiers, so two "same product, different topping" entries would have
// collapsed into one line at whichever topping was seen first.
export const mergeCatalogItems = (items) => {
  const merged = new Map();
  for (const item of items) {
    const modKey = [...new Set(item.modifierOptionIds ?? [])].sort().join(',');
    const key = `${item.productId}|${item.variantId ?? ''}|${modKey}`;
    const cur = merged.get(key);
    if (cur) cur.qty += item.qty;
    else merged.set(key, { ...item });
  }
  return [...merged.values()];
};

// Exported for the same reason: a line's modifier snapshots are nested relation
// rows, which rules out `createMany` on EVERY path that writes order items.
export const createLineData = ({ modifiers, ...line }, orderId) => ({
  ...line,
  orderId,
  ...(modifiers.length
    ? {
        modifiers: {
          create: modifiers.map((m) => ({
            optionId: m.optionId,
            groupName: m.groupName,
            name: m.name,
            price: m.price,
          })),
        },
      }
    : {}),
});

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
        modifierOptionIds: z.array(z.string().min(1)).max(30).optional(),
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

    // Merge duplicate product+variant+modifier entries into one line.
    const lines = [];
    for (const item of mergeCatalogItems(data.items)) {
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
      // Nested modifier snapshots rule out createMany; still one transaction.
      for (const l of lines) {
        await tx.orderItem.create({ data: createLineData(l, order.id) });
      }
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
        modifierOptionIds: z.array(z.string().min(1)).max(30).optional(),
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
        const candidates = await tx.orderItem.findMany({
          where: {
            orderId: order.id,
            productId: line.productId,
            variantId: line.variantId,
            status: 'ACTIVE',
            kotId: null,
          },
          include: { modifiers: true },
        });
        // Same modifier choice merges; a different choice is its own line.
        const existing = candidates.find(
          (c) => modifierKeyOf(c.modifiers) === modifierKeyOf(line.modifiers),
        );
        if (existing) {
          const qty = Math.min(existing.qty + line.qty, 999);
          await tx.orderItem.update({ where: { id: existing.id }, data: { qty } });
        } else {
          await tx.orderItem.create({ data: createLineData(line, order.id) });
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
  items: kot.items.map((i) => ({
    name: i.name,
    qty: i.qty,
    // The kitchen prepares these; prices stay off the KOT.
    modifiers: (i.modifiers ?? []).map((m) => m.name),
  })),
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
        include: { modifiers: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (unsent.length === 0) throw conflict('No new items to send to the kitchen');
      const seq = (await tx.kot.count({ where: { orderId: order.id } })) + 1;
      const created = await tx.kot.create({ data: { orderId: order.id, seq } });
      await tx.orderItem.updateMany({
        where: { id: { in: unsent.map((i) => i.id) } },
        data: { kotId: created.id },
      });
      // Kitchen routing rides the same transaction: KOT and its ticket lines
      // exist together or not at all. Zero stations configured = no-op.
      await routeKotItems(tx, {
        companyId: req.companyScope.id,
        branchId: order.branchId,
        order,
        kot: created,
        items: unsent,
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
      include: { items: { select: { name: true, qty: true, modifiers: true } } },
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

// --- promotions (VC-102) ------------------------------------------------------
// Applying an offer is till work gated by promo.apply, not by discount
// authority: the money was authorised when the owner published the campaign.
// The redemption row snapshots name, code, version and amount; recomputeOrder
// owns the amount from then on and re-decides eligibility on every basket
// change. RECORDED REVERSAL POLICY: benefits reverse in full when the order is
// voided and when the basket stops qualifying; a partial refund does NOT claw
// back a promotion — the audit row on each reversal says which of these fired.

const promoGate = [requireUsableLicense, loadPermissionContext, requireAction('promo.apply')];

const promoLinesOf = (items) =>
  items
    .filter((i) => i.status === 'ACTIVE')
    .map((i) => ({
      productId: i.productId,
      categoryId: i.product?.categoryId ?? null,
      lineSubtotalPaise: paiseOf(i.unitPrice) * i.qty - paiseOf(i.lineDiscount),
    }));

router.post(
  '/:id/promotions',
  ...promoGate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        promotionId: z.string().min(1).optional(),
        code: z.string().trim().toUpperCase().optional(),
        customerPhone: z.string().trim().optional(),
      })
      .refine((b) => Boolean(b.promotionId) !== Boolean(b.code), 'Send promotionId or code, not both')
      .parse(req.body);
    const customerDigits = body.customerPhone ? body.customerPhone.replace(/\D/g, '') : '';
    if (body.customerPhone && customerDigits.length < 7) {
      throw badRequest('customerPhone must carry at least 7 digits');
    }
    const customerKey = customerDigits ? `ph:${customerDigits}` : null;
    const order = await loadOrder(req, {
      items: { include: { product: { select: { categoryId: true } } } },
    });
    assertOpen(order);
    await resolveStoreInScope(req, order.branchId);

    const redemption = await prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.findFirst({
        where: {
          companyId: req.companyScope.id,
          status: 'PUBLISHED',
          ...(body.promotionId ? { id: body.promotionId } : { code: body.code }),
        },
        include: { itemRules: true, storeLinks: { select: { branchId: true } } },
      });
      // One answer for absent, another tenant's, and unpublished: this store
      // has no such offer.
      if (!promo) throw notFound('Promotion not found');
      if (promo.storeLinks.length && !promo.storeLinks.some((s) => s.branchId === order.branchId)) {
        throw conflict('This promotion is not available at this store');
      }

      const applied = await tx.promotionRedemption.findMany({
        where: { orderId: order.id, status: 'APPLIED' },
        include: { promotion: { select: { stackable: true } } },
      });
      if (applied.some((r) => r.promotionId === promo.id)) {
        throw conflict('This promotion is already on the order');
      }
      const stacking = stackingRefusal(promo, applied.map((r) => r.promotion));
      if (stacking === 'NOT_STACKABLE') throw conflict('This promotion cannot combine with others');
      if (stacking === 'BLOCKED_BY_NON_STACKABLE') {
        throw conflict('A promotion already on the order does not combine with others');
      }

      const verdict = evaluatePromotion(promo, {
        lines: promoLinesOf(order.items),
        orderType: order.type,
        at: new Date(),
      });
      if (!verdict.ok) throw conflict(`Promotion does not apply: ${verdict.reason}`);

      // The campaign slot, taken atomically: two tills racing for the last
      // redemption cannot both pass this row count.
      const slot = await tx.promotion.updateMany({
        where: {
          id: promo.id,
          status: 'PUBLISHED',
          ...(promo.totalLimit === null ? {} : { redemptionCount: { lt: promo.totalLimit } }),
        },
        data: { redemptionCount: { increment: 1 } },
      });
      if (slot.count === 0) throw conflict('This promotion has reached its redemption limit');

      // Per-customer cap, counted AFTER the slot update: that update locks the
      // promotion row, so a concurrent apply for the same customer waits here
      // and then sees this transaction's committed row — two racing tills
      // cannot both pass the count.
      if (promo.perCustomerLimit !== null) {
        if (!customerKey) throw badRequest('This promotion needs the customer’s phone number');
        const used = await tx.promotionRedemption.count({
          where: {
            promotionId: promo.id,
            customerKey,
            status: 'APPLIED',
            orderId: { not: order.id },
          },
        });
        if (used >= promo.perCustomerLimit) {
          throw conflict('This customer has reached the redemption limit for this promotion');
        }
      }

      const row = await tx.promotionRedemption.upsert({
        where: { promotionId_orderId: { promotionId: promo.id, orderId: order.id } },
        create: {
          promotionId: promo.id,
          companyId: req.companyScope.id,
          orderId: order.id,
          branchId: order.branchId,
          promotionName: promo.name,
          promotionVersion: promo.version,
          code: promo.code,
          appliedById: req.user.id,
          customerKey,
        },
        // A promotion removed and re-applied revives its own row, with the
        // CURRENT version — the campaign may have been edited in between.
        update: {
          status: 'APPLIED',
          reversedReason: null,
          reversedAt: null,
          promotionName: promo.name,
          promotionVersion: promo.version,
          code: promo.code,
          appliedById: req.user.id,
          customerKey,
        },
      });
      await recomputeOrder(tx, order.id);
      return tx.promotionRedemption.findUnique({ where: { id: row.id } });
    });

    await audit(req, {
      action: 'ORDER_PROMO_APPLY',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        promotionId: redemption.promotionId,
        name: redemption.promotionName,
        version: redemption.promotionVersion,
        amount: String(redemption.amount),
        branchId: order.branchId,
      },
    });
    res.json({ order: await fullOrder(order.id) });
  }),
);

router.delete(
  '/:id/promotions/:promotionId',
  ...promoGate,
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req);
    assertOpen(order);
    await resolveStoreInScope(req, order.branchId);

    const reversed = await prisma.$transaction(async (tx) => {
      const row = await tx.promotionRedemption.findFirst({
        where: { orderId: order.id, promotionId: req.params.promotionId, status: 'APPLIED' },
      });
      if (!row) throw notFound('This promotion is not on the order');
      const out = await tx.promotionRedemption.update({
        where: { id: row.id },
        data: { status: 'REVERSED', reversedReason: 'REMOVED', reversedAt: new Date(), amount: 0 },
      });
      await tx.promotion.update({
        where: { id: row.promotionId },
        data: { redemptionCount: { decrement: 1 } },
      });
      await recomputeOrder(tx, order.id);
      return out;
    });

    await audit(req, {
      action: 'ORDER_PROMO_REMOVE',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { promotionId: reversed.promotionId, name: reversed.promotionName, branchId: order.branchId },
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

      // ==== LANE inventory ====
      // THE single point at which a sale takes stock. It is here and not in
      // the KOT route or the payment route because this is the one transition
      // that happens exactly once per order: the guarded updateMany above has
      // already made a concurrent bill lose, so whoever reaches this line is
      // the only one who will. A KOT can be reprinted and a payment can be
      // split across four tenders; deducting at either would consume the
      // ingredients once per print or once per swipe.
      //
      // Inside this transaction on purpose. A bill that rolls back must take
      // its stock movements with it, or the shelf ends up short of goods that
      // were never sold.
      //
      // Never blocks the bill on stock, and a company that does not use the
      // inventory module has no sale-source location, so every line is simply
      // recorded UNCOSTED and the till behaves exactly as it did before.
      await consumeForOrder(tx, {
        companyId: order.companyId,
        branchId: order.branchId,
        orderId: order.id,
        userId: req.user.id,
        // The order's till, not this request's device. The order is what the
        // day's takings are attributed to, so the stock it consumed has to be
        // attributed the same way or the two reports disagree about one sale.
        // Null when the order was never opened on a till at all.
        terminalId: order.terminalId,
        occurredAt: new Date(),
      });
      // ==== END LANE inventory ====
    });

    const full = await prisma.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE });
    await audit(req, {
      action: 'ORDER_BILL',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { invoiceNumber: full.invoiceNumber, total: String(full.total) },
    });
    // LANE providers. After the commit and after the audit, and unable to throw
    // — a bill prints whether or not an accounting or loyalty provider answers.
    await onOrderBilled(order.id);
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
          // This route is the hand-recorded one, and it says so on the row.
          // A cashier typing "the customer paid by card" is a claim the POS
          // cannot check, and it must stay distinguishable from a payment a
          // provider or a terminal confirmed — which is the whole reason this
          // column exists. Nothing on this path may ever write anything else.
          channel: 'MANUAL',
          entrySource: 'MANUAL_ENTRY',
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
    // LANE providers.
    await onPaymentRecorded(order.id, result.payment.id);
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

// The merchant account THIS ORDER's money must settle into.
//
// Resolved from the order's company and store, never from the process. On a
// deployment serving several companies, credentials held in environment
// variables mean one merchant account for everyone, and every customer's card
// payment landing in whoever's bank account the box was configured with. That
// is not a risk; it is the only behaviour a process-global credential can have.
//
// A misconfiguration answers 409 with the operator's own words, because every
// one of these is something a person can go and fix: no account, wrong store,
// switched off, no key, live keys on a test box. None of them is a server
// fault and none is a reason to fall through to somebody else's account.
const accountForOrder = async (order, provider) => {
  try {
    return await resolveAccount({ companyId: order.companyId, branchId: order.branchId, provider });
  } catch (err) {
    if (err instanceof PaymentAccountError) throw conflict(err.message);
    throw err;
  }
};

// What the adapter needs, and nothing else. The account object carries the
// decrypted secret, so it stays in this file's local scope and what crosses
// into the adapter is the pair it authenticates with.
const credentialsOf = (account) => ({ keyId: account.keyId, keySecret: account.keySecret });

// The account an EXISTING attempt was opened on — which is not always the one
// the order resolves to now. Accounts get switched off, moved from company to
// store, and replaced; a refund or a status enquiry has to go back to the
// account that actually holds the money, and asking a different merchant about
// a charge it never took gets a 404 at best and refunds the wrong customer at
// worst.
//
// Falls back to resolving from the order only where the intent names no
// account, which is every intent created before accounts existed and every one
// on a deployment still using the environment pair.
const accountForIntent = async (intent, order, provider) => {
  if (!intent.accountId) return accountForOrder(order, provider);
  const row = await prisma.paymentProviderAccount.findFirst({
    where: { id: intent.accountId, companyId: order.companyId },
  });
  if (!row) {
    // Deleted out from under a live attempt. Resolving to the current account
    // instead would send this charge's refund to a different merchant, so this
    // stops and says so.
    throw conflict('The merchant account this payment was opened on no longer exists');
  }
  try {
    return resolveAccountRow(row);
  } catch (err) {
    if (err instanceof PaymentAccountError) throw conflict(err.message);
    throw err;
  }
};

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
    // Resolved BEFORE the reservation, so a tenant with no merchant account
    // configured is refused without leaving an intent row behind that nothing
    // will ever be able to open with the provider.
    const account = await accountForOrder(order, adapter.name);

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
          // Denormalised from the order on purpose. The webhook arrives with
          // no session and no company scope, so the intent has to be able to
          // say for itself whose money this is — and it has to keep saying so
          // after the order is archived or the store is reassigned.
          companyId: order.companyId,
          branchId: order.branchId,
          provider: adapter.name,
          // The account this attempt is being opened on, frozen now. A webhook
          // landing months later must credit the account that actually took
          // the money, not whichever one is configured by then.
          accountId: account.accountId,
          flow: 'CHECKOUT_LINK',
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
          credentials: credentialsOf(account),
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
      //
      // From the resolved account, so the till opens Checkout against the same
      // merchant the order was created on. Sending the deployment's key id
      // here would open a payment page belonging to a different company.
      provider: adapter.name,
      keyId: account.keyId,
      capabilities: adapter.capabilities ?? null,
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

    // Signed with the key secret of the account this attempt was opened on, so
    // a handoff from one tenant's Checkout cannot verify against another's.
    const verified = adapter.verifyCheckoutHandoff({
      intentProviderRef: intent.providerRef,
      paymentId: body.paymentId,
      signature: body.signature,
      credentials: credentialsOf(await accountForIntent(intent, order, adapter.name)),
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
    // Outside the try below on purpose. A misconfigured account is not the
    // provider failing to answer, and dressing it as one would write
    // GATEWAY_SETTLEMENT_RECONCILE_FAILED against a provider nobody called.
    const account = await accountForIntent(intent, order, adapter.name);

    let answer;
    try {
      answer = await adapter.fetchSettlement({
        intentProviderRef: intent.providerRef,
        // The account that took the money, not the one configured now.
        credentials: credentialsOf(account),
      });
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
          // Same reason the event row above says RECOVERY: nobody delivered
          // this. The payment lands as RECONCILED, so a report can say which
          // orders were closed by a signed delivery and which by a manager
          // asking the provider afterwards. Both are provider evidence; they
          // are not equally strong, and the row is the only place that survives.
          eventSource: 'RECOVERY',
          accountId: account.accountId,
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

// --- card terminal attempts -------------------------------------------------
//
// The card-present half of §2, and deliberately a different surface from the
// checkout intents above. An online payment is collected in the customer's
// browser; this is collected on a physical reader in the shop, and the two are
// not interchangeable however similar the rows look afterwards.
//
// What they share is everything after the money moves: ONE PaymentIntent, ONE
// applyGatewayEvent, ONE Payment table, one refund path, one day close. What
// differs is two columns and which adapter is asked — see lib/terminal/index.js.
//
// NOTHING in here settles a payment because a cashier said so, because a screen
// timed out, or because a reader stopped answering. Only the device's own
// SUCCEEDED answer, carrying a charge reference, may write a payment row.

// The reader that is to take this card.
//
// Resolved from the ORDER's store, never from the request's idea of which store
// it is in, so a till cannot address a reader in another shop by knowing its
// id. A reader is a Device like any other: same tenancy, same revocation, same
// composite (id, branchId) the database enforces.
const readerForOrder = async (req, order, deviceId) => {
  const reader = await prisma.device.findFirst({
    where: { id: deviceId, branchId: order.branchId, companyId: order.companyId },
    select: { id: true, name: true, type: true, status: true, readerRef: true, terminalId: true },
  });
  // 404 rather than 403 for a reader in another company or another store: it is
  // simply absent from where this order can see, and a different answer would
  // make this an oracle for which device ids exist on the deployment.
  if (!reader) throw notFound('Card reader not found in this store');
  if (reader.type !== 'PAYMENT_TERMINAL') {
    throw badRequest('That device is not a card reader', 'deviceId');
  }
  if (reader.status !== 'ACTIVE') {
    throw conflict('That card reader is not active. Activate it on the devices screen first.');
  }
  // Without this there is nothing for a connector to address. It is a
  // configuration gap a person can close, so it says so rather than failing
  // later inside the connector with the customer already holding their card.
  if (!reader.readerRef) {
    throw conflict(
      'That card reader has no vendor reference recorded, so no connector can address it. ' +
        'Add the reference printed on the device before taking a card on it.',
    );
  }
  // A reader bound to one till may only be driven by that till. Both sides have
  // to name a till for this to mean anything: a store-level reader, or a browser
  // till sending no device token, attributes less and is not refused for it.
  if (req.device?.terminalId && reader.terminalId && req.device.terminalId !== reader.terminalId) {
    throw forbidden('That card reader is registered to a different till');
  }
  return reader;
};

// The vendor reference for the reader an attempt was opened on. Read back from
// the device rather than stored on the intent: the attempt names the device,
// and the device is where the reference lives, so re-pointing a reader's
// reference cannot leave live attempts addressing an id that no longer exists.
const readerRefOf = async (deviceId) => {
  if (!deviceId) return null;
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { readerRef: true },
  });
  return device?.readerRef ?? null;
};

const terminalStartSchema = z.object({
  deviceId: z.string().min(1).max(60),
  // Optional, and the reason it exists is split tenders: ₹500 in cash and the
  // rest on the card is an ordinary restaurant bill, and a route that could
  // only charge the whole balance would force the cashier to record the card
  // leg by hand — which is precisely the manual entry this lane exists to stop
  // being the only option. Omitted means the whole amount still due.
  amount: money2.optional(),
});

// Puts an amount on a reader. Two phases, for the same reason the checkout
// intents have two: the connector is reached over a network or a socket to a
// device, and a database transaction must not be open across it.
//
// Nothing here records a payment. The reader has been ASKED for money; whether
// it got any is the status route's question.
router.post(
  '/:id/terminal-payments',
  ...operate,
  asyncHandler(async (req, res) => {
    // Throws 501 naming the missing dependency when the configured connector is
    // a registered-but-unimplemented vendor — so a till is told "Pine Labs needs
    // its integration pack" rather than being shown a button that does nothing.
    const connector = getConnector();
    const body = terminalStartSchema.parse(req.body);
    const order = await loadOrder(req);
    assertDeviceStore(req, order.branchId);
    const reader = await readerForOrder(req, order, body.deviceId);

    const asked = body.amount === undefined ? null : toPaise(body.amount);

    // PHASE 1 — reserve locally and commit, reader untouched.
    const reservation = await prisma.$transaction(async (tx) => {
      // Serialises every attempt on this order, exactly as the checkout path
      // does. Without it two tills pressing Charge at the same instant each read
      // a state with the other's row invisible and both put the full balance on
      // a reader — two cards, one bill, and both charged.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

      const cur = await tx.order.findUnique({
        where: { id: order.id },
        include: { payments: { select: { amount: true } } },
      });
      if (cur.status !== 'BILLED') throw conflict('Card payment is offered on billed orders only');
      const due = paiseOf(cur.total) - cur.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
      if (due <= 0) throw conflict('Order has no amount due');
      const amountPaise = asked ?? due;
      if (amountPaise > due) {
        throw badRequest('Amount exceeds the amount due', 'amount');
      }

      // One live attempt per order, whatever surface it is on. A checkout page
      // and a reader both holding the same balance is the two-payable-sessions
      // problem with an extra device in it.
      const open = await tx.paymentIntent.findFirst({
        where: { orderId: order.id, status: { in: ['CREATED', 'PENDING'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (open) {
        if (open.flow !== 'TERMINAL') {
          throw conflict('An online payment is already open on this order. Cancel it before using the card reader.');
        }
        if (open.deviceId !== reader.id) {
          throw conflict('A card payment for this order is already open on a different reader');
        }
        if (paiseOf(open.amount) !== amountPaise) {
          throw conflict('A card payment for a different amount is already open on this order');
        }
        // No providerRef means phase 2 never got an answer. Resuming carries
        // the SAME idempotency key, so a connector with idempotency of its own
        // returns the attempt already on the reader rather than stacking a
        // second amount on it.
        return { intent: open, amountPaise, resume: open.providerRef === null };
      }

      const intent = await tx.paymentIntent.create({
        data: {
          orderId: order.id,
          // Denormalised from the order, the same way the checkout path does it
          // and for the same reason: the attempt has to be able to say whose
          // money this is without a session to ask.
          companyId: order.companyId,
          branchId: order.branchId,
          provider: connector.name,
          flow: 'TERMINAL',
          // WHICH reader is holding the card, and which till that reader
          // belongs to. Read off the resolved device row, never off the request.
          deviceId: reader.id,
          terminalId: reader.terminalId ?? req.device?.terminalId ?? null,
          // No merchant account: no terminal connector needs credentials today
          // (perAccountCredentials is false on every one of them). When a vendor
          // connector arrives that does, it resolves through the same
          // PaymentProviderAccount rows the gateway uses, keyed on its own name.
          accountId: null,
          providerRef: null,
          amount: (amountPaise / 100).toFixed(2),
          currency: 'INR',
          status: 'CREATED',
          idempotencyKey: randomUUID(),
          createdById: req.user.id,
        },
      });
      return { intent, amountPaise, resume: true, fresh: true };
    });

    // PHASE 2 — now put the amount on the reader.
    let intent = reservation.intent;
    if (reservation.resume) {
      try {
        const started = await connector.startPayment({
          amountPaise: reservation.amountPaise,
          currency: 'INR',
          orderId: order.id,
          readerRef: reader.readerRef,
          idempotencyKey: intent.idempotencyKey,
          credentials: null,
        });
        intent = await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { providerRef: started.providerRef ?? null, status: 'PENDING', failureReason: null },
        });
      } catch (err) {
        // A reader that refused is an answer: nothing is on the device and the
        // cashier can try another one or take the money another way. Anything
        // else is UNKNOWN — the amount may be sitting on the reader right now —
        // so the row stays open and the next press resumes it under the same
        // key instead of putting a second amount on a device that may already
        // be showing the first.
        const detail = err?.message ? String(err.message).slice(0, 200) : 'the reader did not answer';
        if (err?.providerRefused === true) {
          await prisma.paymentIntent.update({
            where: { id: intent.id },
            data: { status: 'FAILED', failureReason: detail, closedAt: new Date() },
          });
        } else {
          await prisma.paymentIntent.update({ where: { id: intent.id }, data: { failureReason: detail } });
        }
        throw terminalUnavailable('The card reader could not be given this payment');
      }
    }

    if (reservation.fresh) {
      await audit(req, {
        action: 'TERMINAL_INTENT_CREATED',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: {
          orderId: order.id,
          connector: connector.name,
          deviceId: reader.id,
          amount: String(intent.amount),
        },
      });
    }
    res.status(reservation.fresh ? 201 : 200).json({
      intent: publicIntent(intent),
      connector: connector.name,
      // So the till can show the right instruction — "tap, insert or swipe" on a
      // reader that declares contactless, and "insert or swipe" on one that does
      // not. Guessing that wrong tells a customer to tap a device that will not
      // read a tap.
      capabilities: connector.capabilities,
      reader: { id: reader.id, name: reader.name },
      // The reader has the amount. Nothing has been paid, and the till must poll
      // the status route rather than infer anything from this response.
      status: intent.status,
    });
  }),
);

// Asks the READER what happened, and records a payment only if it says one did.
//
// This is the only route that can settle a card-present payment, and it is a
// poll rather than a callback because a reader has no webhook to send: the
// device is on a counter, not on the internet. Everything §3 asks for about
// duplicate, delayed and out-of-order outcomes therefore has to hold here.
//
// The rules it exists to enforce:
//   - a timeout is not a decline. An enquiry that could not reach the device
//     leaves the attempt exactly as it was, and says so.
//   - UNCERTAIN is never resolved into anything. It is reported as UNCERTAIN,
//     the attempt stays open, and the cashier is told in words not to record
//     the payment by hand.
//   - polling twice cannot pay twice. The charge reference is the event id, so
//     a second poll collides on the unique index rather than settling again.
router.post(
  '/:id/terminal-payments/:intentId/status',
  ...operate,
  asyncHandler(async (req, res) => {
    const connector = getConnector();
    const order = await loadOrder(req);

    // Found through the order, so an attempt on another bill or in another
    // company is absent rather than probeable.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.intentId, orderId: order.id, flow: 'TERMINAL' },
    });
    if (!intent) throw notFound('Card payment not found');
    if (intent.provider !== connector.name) {
      throw conflict('This payment was started on a different card connector from the one configured now');
    }
    if (!intent.providerRef) {
      throw conflict('This payment never reached the reader, so there is nothing to ask about');
    }
    // A settled attempt is polled all the time — a till that lost its answer,
    // a second cashier looking at the same bill. It is not an error, and
    // answering 200 with the truth is what stops anyone taking the money again.
    if (intent.status === 'SUCCEEDED') {
      return res.status(200).json({
        status: 'SUCCEEDED',
        recorded: false,
        alreadyRecorded: true,
        reason: 'this card payment has already been recorded',
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    // Counting the asks is how a stuck attempt becomes visible instead of being
    // polled forever in silence. Neither column moves money.
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { lastStatusCheckAt: new Date(), statusCheckCount: { increment: 1 } },
    });

    let answer;
    try {
      answer = await connector.getStatus({
        providerRef: intent.providerRef,
        readerRef: await readerRefOf(intent.deviceId),
        credentials: null,
      });
    } catch (err) {
      // The device could not be asked. That is not a decline, not a success and
      // not a cancellation: it changes NOTHING about the attempt, which stays
      // open and askable. Distinguished from an answer of UNCERTAIN on purpose —
      // "we could not ask" and "we asked and it does not know" are different
      // facts, and a shop chasing a missing payment needs to know which it had.
      const detail = err?.message ? String(err.message).slice(0, 200) : 'the reader did not answer';
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { failureReason: detail },
      });
      await audit(req, {
        action: 'TERMINAL_STATUS_UNAVAILABLE',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, connector: connector.name, detail },
      });
      throw terminalUnavailable('The card reader could not be asked what happened to this payment');
    }

    const detail = typeof answer?.detail === 'string' ? answer.detail.slice(0, 200) : null;

    if (answer.status === 'PENDING') {
      return res.status(200).json({
        status: 'PENDING',
        recorded: false,
        detail,
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    if (answer.status === 'UNCERTAIN') {
      // The attempt is LEFT OPEN and left unresolved. This is the case the
      // whole subsystem exists for: the customer may have been charged, and the
      // two tempting moves — closing it so the till looks tidy, or letting the
      // cashier record a manual card payment "to match" — are the two ways a
      // customer gets charged twice.
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'UNCERTAIN', failureReason: detail },
      });
      await audit(req, {
        action: 'TERMINAL_OUTCOME_UNCERTAIN',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, connector: connector.name, detail },
      });
      return res.status(200).json({
        status: 'UNCERTAIN',
        recorded: false,
        detail,
        // Said in words because the cashier is the one who decides what happens
        // next, and the wrong decision here is the expensive one.
        advice:
          'The reader could not say whether this card was charged. Do NOT record this payment by hand — ' +
          'check the reader or the day’s batch first, then ask again.',
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    if (answer.status === 'FAILED' || answer.status === 'CANCELLED') {
      // An answer, and the answer is no money. Closing the attempt is safe and
      // necessary: it frees the balance so the cashier can present the card
      // again or take it another way.
      const closed = await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: answer.status,
          failureReason: detail,
          failureCode: typeof answer.failureCode === 'string' ? answer.failureCode.slice(0, 60) : null,
          cancelledAt: answer.status === 'CANCELLED' ? new Date() : null,
          closedAt: new Date(),
        },
      });
      await audit(req, {
        action: answer.status === 'CANCELLED' ? 'TERMINAL_INTENT_CANCELLED' : 'TERMINAL_INTENT_FAILED',
        entity: 'PaymentIntent',
        entityId: intent.id,
        companyId: req.companyScope.id,
        meta: { orderId: order.id, connector: connector.name, detail, failureCode: closed.failureCode },
      });
      return res.status(200).json({
        status: answer.status,
        recorded: false,
        detail,
        failureCode: closed.failureCode,
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    if (answer.status !== 'SUCCEEDED') {
      // Unreachable through the simulator, which normalises anything it does not
      // know to UNCERTAIN. Kept because a vendor connector is a separate piece
      // of code and this function must not treat an unrecognised word as
      // approval by falling out of the bottom of the checks above.
      throw terminalUnavailable('The card reader gave an answer this connector could not read');
    }

    // --- the reader says it took the money ---
    //
    // The charge reference is what makes settling exactly-once: it is the event
    // id, so polling twice collides on (provider, eventId) instead of recording
    // a second payment. Without one there is no such key, and no way to tell a
    // repeat poll from a second charge — so this refuses rather than guessing.
    if (!answer.chargeRef) {
      throw conflict('This card payment could not be recorded: the reader did not name the charge');
    }

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const event = await tx.gatewayWebhookEvent.create({
          data: {
            provider: connector.name,
            eventId: answer.chargeRef,
            kind: EVENT_SUCCEEDED,
            payloadHash: sha256Hex(JSON.stringify(answer)),
            // RECOVERY, because nobody delivered this — the till went and asked
            // the device. A reader has no webhook to send, so every terminal
            // settlement is a pull and the event row says so.
            source: 'RECOVERY',
          },
        });

        const applied = await applyGatewayEvent(tx, {
          provider: connector.name,
          providerRef: intent.providerRef,
          kind: EVENT_SUCCEEDED,
          amountPaise: answer.amountPaise,
          currency: answer.currency,
          method: answer.method ?? 'CARD',
          chargeRef: answer.chargeRef,
          eventSource: 'RECOVERY',
          // The same amount, order-state and amount-due checks the webhook
          // runs. eventSource does not decide the payment's entrySource here:
          // the intent's flow does, and a TERMINAL attempt lands as
          // TERMINAL_CONFIRMED. See lib/gateway/apply.js.
          expectCompanyId: order.companyId,
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
      // Two tills polling the same attempt at the same instant. One of them
      // wrote the payment; the unique index refused the other and rolled its
      // whole transaction back. The money is recorded exactly once.
      if (isAlreadySettled(err)) {
        return res.status(200).json({
          status: 'SUCCEEDED',
          recorded: false,
          alreadyRecorded: true,
          reason: 'this card payment was already recorded',
          order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
        });
      }
      throw err;
    }

    if (!outcome.payment) {
      // The reader said yes and the payment was still not written — the amount
      // disagreed with what was asked for, or the order moved on underneath.
      // Recorded on the event row with its reason and surfaced by
      // reconciliation, never silently smoothed over.
      const recorded = await prisma.payment.findUnique({
        where: { intentId: intent.id },
        select: { id: true },
      });
      return res.status(200).json({
        status: 'SUCCEEDED',
        recorded: false,
        ...(recorded ? { alreadyRecorded: true } : {}),
        reason: recorded ? 'this card payment was already recorded' : (outcome.skippedReason ?? 'the payment was not applied'),
        order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
      });
    }

    // ORDER_PAYMENT, the same action the manual route and the webhook write,
    // because every report that reads takings has to see all three. `channel`
    // and `via` are what tell them apart afterwards.
    await audit(req, {
      action: 'ORDER_PAYMENT',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        method: outcome.payment.method,
        amount: String(outcome.payment.amount),
        channel: 'TERMINAL',
        connector: connector.name,
        intentId: outcome.intentId,
        via: 'TERMINAL',
        chargeRef: answer.chargeRef,
        entryMode: typeof answer.entryMode === 'string' ? answer.entryMode : null,
      },
    });

    res.status(200).json({
      status: 'SUCCEEDED',
      recorded: true,
      payment: publicPayment(outcome.payment),
      order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
    });
  }),
);

// Takes the amount back off the reader.
//
// Where the connector declares cancel, this is a real state change on the
// device and the card can no longer be presented against it. Where it does not,
// the POS closes its own row and SAYS SO — because a "cancelled" attempt whose
// amount is still showing on a reader is a lie the next customer can disprove
// by tapping.
router.post(
  '/:id/terminal-payments/:intentId/cancel',
  ...operate,
  asyncHandler(async (req, res) => {
    const connector = getConnector();
    const order = await loadOrder(req);

    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.intentId, orderId: order.id, flow: 'TERMINAL' },
    });
    if (!intent) throw notFound('Card payment not found');
    if (intent.status === 'SUCCEEDED') {
      throw conflict('This card payment has already been recorded and cannot be cancelled');
    }
    if (intent.provider !== connector.name) {
      throw conflict('This payment was started on a different card connector from the one configured now');
    }

    let onDevice = false;
    if (connector.capabilities.cancel && intent.providerRef) {
      try {
        const result = await connector.cancel({
          providerRef: intent.providerRef,
          readerRef: await readerRefOf(intent.deviceId),
          credentials: null,
        });
        onDevice = result?.cancelled === true;
      } catch {
        // The device could not be told. Closing our row anyway would leave an
        // amount live on a reader with nothing in the POS tracking it, which is
        // how a customer pays a bill the till has already written off.
        throw terminalUnavailable(
          'The card reader could not be told to cancel. The amount may still be on the device — clear it there.',
        );
      }
    }

    const closed = await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        closedAt: new Date(),
        failureReason: onDevice ? null : 'cancelled in the POS; the reader was not able to be told',
      },
    });
    await audit(req, {
      action: 'TERMINAL_INTENT_CANCELLED',
      entity: 'PaymentIntent',
      entityId: intent.id,
      companyId: req.companyScope.id,
      meta: { orderId: order.id, connector: connector.name, onDevice },
    });

    res.status(200).json({
      intent: publicIntent(closed),
      // The honest half. False means the POS closed its own row and the reader
      // was never told — so if the customer pays anyway, the money is real and a
      // status enquiry will still find and record it. The attempt being
      // CANCELLED here does not block that, deliberately.
      cancelledOnDevice: onDevice,
      ...(onDevice
        ? {}
        : {
            advice:
              'This connector cannot clear a reader remotely. Cancel the amount on the device itself — ' +
              'until you do, a card presented to it may still be charged.',
          }),
      order: serializeOrder(await loadOrder(req, ORDER_INCLUDE)),
    });
  }),
);

// --- refunds ----------------------------------------------------------------

// REFUND_PAYMENT_INCLUDE now lives in lib/orders.js beside refundLegs and
// pickRefundLeg, which are the only things that consume it — and it carries the
// same [createdAt, id] tie-break as ORDER_INCLUDE, so which charge a refund
// posts against is decided by a declared rule rather than by the query plan.

const REFUND_STATE_SELECT = {
  select: { amount: true, status: true, channel: true, intentId: true, providerRef: true },
};

const rupees = (paise) => (paise / 100).toFixed(2);

// The merchant account a gateway refund has to be posted to: the one that took
// the money, found through the attempt it was taken on. Sending a refund to
// the account configured NOW would ask a merchant to return a charge it never
// received — which fails outright if we are lucky, and takes the money out of
// the wrong company's balance if we are not.
const accountForRefundLeg = async (intentId, order, provider) => {
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: intentId, orderId: order.id },
    select: { accountId: true },
  });
  if (!intent) throw conflict('The payment this refund belongs to could not be found');
  return credentialsOf(await accountForIntent(intent, order, provider));
};

// Asks the provider to return the money, OUTSIDE any database transaction and
// always with the key already stored on the row.
//
// The three outcomes are not two. Accepted is a providerRef to track. Refused
// is a provider that answered no. Everything else — timeout, socket reset, a
// 500, an answer with no reference in it — is UNKNOWN: the request may be
// paying out this second. Unknown must never be reported as refused, because
// a refused refund frees its money to be requested again, and doing that to a
// request that did go through pays the customer twice.
const sendRefundToProvider = async (refund, leg, orderId, credentials) => {
  try {
    const result = await getAdapter().createRefund({
      intentProviderRef: leg.intentProviderRef,
      chargeProviderRef: leg.chargeProviderRef,
      amountPaise: paiseOf(refund.amount),
      currency: 'INR',
      orderId,
      idempotencyKey: refund.idempotencyKey,
      credentials,
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

    // ==== LANE inventory ====
    // A refund moves money and nothing else. There is deliberately no stock
    // call in this route: the overwhelmingly common refund is a customer who
    // was unhappy with food they have already eaten, and auto-restocking it
    // would put a drunk coffee back on the shelf for the next order to sell.
    // Goods come back only through POST /api/inventory/sales/consumptions/
    // :id/return, which somebody has to invoke with a reason.
    // ==== END LANE inventory ====

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
      answer = await sendRefundToProvider(
        refund,
        reservation.leg,
        order.id,
        await accountForRefundLeg(reservation.leg.intentId, order, getAdapter().name),
      );
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

    // LANE providers. Posts a credit note and reverses loyalty ONLY for a
    // SUCCEEDED refund — the hook checks that itself, so an unconfirmed gateway
    // refund reaching here posts nothing and is picked up by the reconcile leg.
    await onRefundSettled(order.id, refund.id);
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
      await accountForRefundLeg(existing.intentId, order, getAdapter().name),
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

    // LANE providers. The second chance at the posting the original request
    // could not make: a refund that has only now settled becomes a credit note
    // here, under the same key, so the pair cannot produce two.
    await onRefundSettled(order.id, refund.id);
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

      // ==== LANE inventory ====
      // Voiding an OPEN order consumed nothing, so there is nothing to undo.
      // Voiding a BILLED one does NOT put the stock back, for the same reason
      // a refund does not: the kitchen has already cooked it. The consumption
      // rows stay and stand as the record of what left, and a deliberate
      // return is the only way back — one rule, no special case to get wrong.
      // ==== END LANE inventory ====

      // VC-102 recorded reversal policy: a void reverses every promotion in
      // full and releases its campaign slot. The row keeps its amount — the
      // benefit that WAS granted is part of what the void undid.
      const promos = await tx.promotionRedemption.findMany({
        where: { orderId: order.id, status: 'APPLIED' },
        select: { id: true, promotionId: true },
      });
      for (const p of promos) {
        await tx.promotionRedemption.update({
          where: { id: p.id },
          data: { status: 'REVERSED', reversedReason: 'ORDER_VOID', reversedAt: new Date() },
        });
        await tx.promotion.update({
          where: { id: p.promotionId },
          data: { redemptionCount: { decrement: 1 } },
        });
      }
    });

    await audit(req, {
      action: 'ORDER_VOID',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { reason, invoiceNumber: order.invoiceNumber },
    });
    // LANE providers. Gives back what the bill earned. No accounting posting: a
    // void that never reached Tally needs no credit note, and one that did is
    // corrected by the refund the void required before it would run.
    await onOrderVoided(order.id);
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

// Viewing a receipt or KOT (the GETs above) is deliberately unaudited; this
// records the explicit Print click. "REQUESTED" because the browser raising
// its print dialog proves nothing about paper — there is no delivery status
// in the browser print path, so the row must not read as "printed".
//
// Reprint marker contract (Window 3, Phase 2): the FIRST print of a document
// writes ORDER_PRINT_REQUESTED; every later print of the SAME document (same
// order, and for KOTs the same kotSeq) writes RECEIPT_REPRINT / KOT_REPRINT
// instead, so an auditor filters reprints by action name alone. The response
// returns { copyNumber, reprint } so the print UI can stamp DUPLICATE on the
// copy it is about to render. Two caveats, both deliberate:
//  - the count comes from the routine audit table, whose writes are
//    fire-and-forget by design (lib/audit.js) — the marker is a display aid,
//    not evidence, and must never be presented as a paper count;
//  - two simultaneous clicks can both read the same prior count and share a
//    copyNumber. Harmless for a display marker; do not "fix" it with a lock
//    on the till's money path.
router.post(
  '/:id/print-events',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        document: z.enum(['RECEIPT', 'KOT']),
        kotSeq: z.number().int().positive().optional(),
      })
      .parse(req.body);
    const order = await loadOrder(req);
    if (body.document === 'RECEIPT' && !['BILLED', 'PAID', 'REFUNDED'].includes(order.status)) {
      throw conflict('Receipts exist only after billing');
    }
    const priorActions =
      body.document === 'RECEIPT'
        ? ['ORDER_PRINT_REQUESTED', 'RECEIPT_REPRINT']
        : ['ORDER_PRINT_REQUESTED', 'KOT_REPRINT'];
    const prior = await prisma.posAuditLog.count({
      where: {
        entityId: order.id,
        action: { in: priorActions },
        AND: [
          { meta: { path: ['document'], equals: body.document } },
          // A KOT print is per ticket: KOT #2's first print is not a reprint
          // of KOT #1. Receipts have no seq and count as one document.
          ...(body.document === 'KOT' && body.kotSeq
            ? [{ meta: { path: ['kotSeq'], equals: body.kotSeq } }]
            : []),
        ],
      },
    });
    const copyNumber = prior + 1;
    const action =
      prior === 0
        ? 'ORDER_PRINT_REQUESTED'
        : body.document === 'RECEIPT'
          ? 'RECEIPT_REPRINT'
          : 'KOT_REPRINT';
    await audit(req, {
      action,
      entity: 'PosOrder',
      entityId: order.id,
      meta: {
        document: body.document,
        copyNumber,
        ...(body.kotSeq ? { kotSeq: body.kotSeq } : {}),
      },
    });
    res.json({
      printEvent: {
        document: body.document,
        ...(body.kotSeq ? { kotSeq: body.kotSeq } : {}),
        copyNumber,
        reprint: copyNumber > 1,
      },
    });
  }),
);

export default router;
