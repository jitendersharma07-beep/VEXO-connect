// VC-104 Central phone-order centre (spec A§3 VC-104).
// ENTITLEMENT(PHONE_ORDERS)
//
// A phone order IS an ordinary Order in the routed store from the moment it is
// submitted, so pricing, tax, KOT, payment and refund reuse the existing
// lifecycle untouched and recomputeOrder() stays the only thing that writes
// order money. PhoneOrder is a sidecar carrying who called, where it goes, when
// it is wanted and which store accepted.

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound, AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope, isBranchPinned } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { deviceContext } from '../../middleware/device.js';
import { toPaise } from '../../lib/money.js';
import { recomputeOrder } from '../../lib/orders.js';
import { resolveCatalogLine, mergeCatalogItems, createLineData } from './orders.js';
import {
  rolesFor,
  hqRoutingEntitled,
  evaluateBranches,
  buildQuote,
  slotBoundsFor,
  countBookedInSlot,
  lockSlot,
  capacityReason,
} from '../../lib/phoneOrders.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope, deviceContext);

// Roles come from the ONE action map, never restated inline, so integration can
// graft these onto the foundation permission matrix mechanically.
const can = (action) => [requireRole(...rolesFor(action)), requireUsableLicense];

// --- errors specific to this module -----------------------------------------

const alreadyDecided = () =>
  new AppError(409, 'POS_PHONE_ORDER_ALREADY_DECIDED', 'This phone order has already been decided');
const idempotencyReused = () =>
  new AppError(
    409,
    'POS_IDEMPOTENCY_KEY_REUSED',
    'That submission key was already used for a different order',
  );
const invoiceIssued = () =>
  new AppError(
    409,
    'POS_INVOICE_ISSUED',
    'An invoice has been issued for this order; it cannot be moved to another store',
  );
const branchUnavailable = (reasons) =>
  new AppError(
    409,
    'POS_BRANCH_UNAVAILABLE',
    'That store cannot take this order',
    undefined,
    { unavailableReasons: reasons },
  );
const hqNotEntitled = () =>
  new AppError(
    403,
    'POS_HQ_ROUTING_NOT_ENTITLED',
    'Central routing to another store needs a multi-store licence',
  );

// --- shared helpers ----------------------------------------------------------

const pincodeSchema = z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits');
// D-3 (docs/VC104-BACKEND-DEFECTS.md): the modifier field the phone path was
// missing. Bounds are the till's, deliberately identical — a basket an operator
// can take by phone and a basket a cashier can take at the counter must be the
// same set, or "we can't do that over the phone" becomes a shape of the API
// rather than a decision anyone made.
const itemsSchema = z
  .array(
    z.object({
      productId: z.string().min(1),
      variantId: z.string().min(1).optional(),
      qty: z.number().int().min(1).max(999).default(1),
      modifierOptionIds: z.array(z.string().min(1)).max(30).optional(),
    }),
  )
  .min(1);

// Dedupe + sort, used wherever a set of chosen options has to become a stable
// string: the idempotency hash here, and the line-merge key in orders.js.
const modKeyOf = (item) => [...new Set(item.modifierOptionIds ?? [])].sort();

// The operator's own store, when they have one. A CUSTOMER_OWNER has none and
// may route anywhere in their tenant.
const operatorBranchOf = (user) => (isBranchPinned(user) ? user.branchId : null);

const customerPublic = (c) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email ?? null,
  note: c.note ?? null,
  archivedAt: c.archivedAt ?? null,
});

const addressPublic = (a) => ({
  id: a.id,
  label: a.label,
  line1: a.line1,
  line2: a.line2 ?? null,
  landmark: a.landmark ?? null,
  city: a.city,
  pincode: a.pincode,
  isDefault: a.isDefault,
  archivedAt: a.archivedAt ?? null,
});

const phoneOrderPublic = (po, order) => ({
  id: po.id,
  reference: po.reference,
  status: po.status,
  customerId: po.customerId,
  addressId: po.addressId ?? null,
  fulfilment: po.fulfilment,
  scheduledFor: po.scheduledFor ?? null,
  routedBranchId: po.routedBranchId,
  acceptedBranchId: po.acceptedBranchId ?? null,
  acceptedAt: po.acceptedAt ?? null,
  acceptedById: po.acceptedById ?? null,
  acceptedByName: po.acceptedByName ?? null,
  rejectedAt: po.rejectedAt ?? null,
  rejectedByName: po.rejectedByName ?? null,
  rejectReason: po.rejectReason ?? null,
  // Attribution is the NAME, which is NOT NULL and cannot be orphaned by a user
  // row going away. The id beside it is a convenience join.
  operatorId: po.operatorId ?? null,
  operatorName: po.operatorName,
  note: po.note ?? null,
  deliverySupplier: po.deliverySupplier,
  deliveryChargeTreatment: po.deliveryChargeTreatment,
  ...(order ? buildQuote(order, po.deliveryCharge) : { deliveryCharge: Number(po.deliveryCharge) }),
});

// Scope a read to what this caller may see: a branch-pinned role sees only
// their own store's phone orders, in the list AND on a direct id fetch.
const scopeWhere = (req) => {
  const own = operatorBranchOf(req.user);
  if (!own) return { companyId: req.companyScope.id };
  return {
    companyId: req.companyScope.id,
    OR: [{ routedBranchId: own }, { acceptedBranchId: own }],
  };
};

// Gather everything evaluateBranches needs in one place, so the submit path and
// the branch-options path cannot drift into judging availability differently.
const loadBranchDecision = async ({ req, fulfilment, address, when, items }) => {
  const companyId = req.companyScope.id;
  const pincode = address?.pincode ?? null;

  const branches = await prisma.branch.findMany({
    where: { companyId },
    orderBy: { name: 'asc' },
  });
  const branchIds = branches.map((b) => b.id);

  const [serviceAreas, hours, capacities] = await Promise.all([
    pincode
      ? prisma.branchServiceArea.findMany({ where: { companyId, pincode } })
      : Promise.resolve([]),
    prisma.branchHours.findMany({ where: { companyId } }),
    prisma.branchPrepCapacity.findMany({ where: { companyId } }),
  ]);

  const hoursByBranch = new Map();
  for (const h of hours) {
    if (!hoursByBranch.has(h.branchId)) hoursByBranch.set(h.branchId, []);
    hoursByBranch.get(h.branchId).push(h);
  }
  const capacityByBranch = new Map(capacities.map((c) => [c.branchId, c]));

  // Capacity is counted over phone orders already booked into the same slot at
  // the same store. Only live ones count - a rejected order is not occupying a
  // kitchen. Which slot an order occupies is the anchor rule in
  // lib/phoneOrders.js: a scheduled order by scheduledFor, an ASAP order by the
  // moment THIS store was asked - its createdAt if it was taken here, the time
  // of the move if it was transferred in.
  //
  // This is a read, so it is a forecast and not a reservation. The binding
  // check is the one taken under lockSlot() inside the submit and reassign
  // transactions; this one exists so the operator's screen and the refusal
  // reason agree, and it can be stale by the time they act on it.
  const bookedByBranch = new Map();
  for (const branchId of branchIds) {
    const cap = capacityByBranch.get(branchId);
    if (!cap) continue;
    const { start, end } = slotBoundsFor(when, cap.slotMinutes);
    bookedByBranch.set(
      branchId,
      await countBookedInSlot(prisma, { companyId, branchId, start, end }),
    );
  }

  // Menu availability. NOTE (C-7): Product is company-scoped - there is no
  // per-branch catalog in this schema - so this can only answer "is the item
  // active in the tenant's menu", which is the same answer for every store.
  // It is reported honestly rather than faked per branch.
  let unavailableProductNames = [];
  let basketPaise = null;
  if (items && items.length > 0) {
    const wanted = [...new Set(items.map((i) => i.productId))];
    const found = await prisma.product.findMany({
      where: { id: { in: wanted }, companyId, status: 'ACTIVE' },
      select: { id: true, name: true, basePrice: true },
    });
    const foundIds = new Set(found.map((p) => p.id));
    unavailableProductNames = wanted.filter((id) => !foundIds.has(id)).map((id) => `#${id.slice(-6)}`);
    const priceById = new Map(found.map((p) => [p.id, p.basePrice]));

    // Modifier prices are part of what the caller pays, so they are part of the
    // basket a minimum-order-value rule is judged against. Counting base price
    // alone would under-count every basket with a paid extra on it and refuse
    // deliveries that do clear the minimum — a new wrong answer created by
    // allowing modifiers here at all, so it is fixed in the same change.
    // Company-scoped, so another tenant's option id cannot inflate the basket.
    // Unknown ids contribute zero rather than throwing: this is the pre-flight
    // estimate, the same treatment unknown PRODUCTS already get above, and
    // resolveCatalogLine rejects them properly at submit.
    //
    // Deliberately NOT filtered on ACTIVE. This helper serves two callers: a
    // new basket, where an archived option makes the submit fail anyway so its
    // price here changes nothing; and reassign, which replays an EXISTING
    // order's options, some of which may have been archived since it was taken
    // and are still part of what that caller agreed to pay. Filtering would
    // under-count the second case to protect the first from nothing.
    const chosenOptionIds = [...new Set(items.flatMap((i) => i.modifierOptionIds ?? []))];
    const optionPrice = new Map();
    if (chosenOptionIds.length > 0) {
      const options = await prisma.modifierOption.findMany({
        where: { id: { in: chosenOptionIds }, group: { product: { companyId } } },
        select: { id: true, price: true },
      });
      for (const o of options) optionPrice.set(o.id, o.price);
    }

    basketPaise = items.reduce((a, i) => {
      const price = priceById.get(i.productId);
      if (!price) return a;
      const extras = (i.modifierOptionIds ?? []).reduce(
        (s, id) => (optionPrice.has(id) ? s + toPaise(String(optionPrice.get(id))) : s),
        0,
      );
      return a + (toPaise(String(price)) + extras) * i.qty;
    }, 0);
  }

  return evaluateBranches({
    branches,
    serviceAreas,
    hoursByBranch,
    capacityByBranch,
    bookedByBranch,
    fulfilment,
    pincode,
    when,
    basketPaise,
    unavailableProductNames,
    operatorBranchId: operatorBranchOf(req.user),
    hqEntitled: hqRoutingEntitled(req.license),
  });
};

// The BINDING capacity check. loadBranchDecision's count is taken outside any
// transaction and is therefore a forecast: between reading it and writing,
// another caller can take the last place. This runs inside the caller's
// transaction, behind the (store, slot) advisory lock, and it is the one that
// actually decides.
//
// Must be the FIRST statement in the transaction, before any write:
//   - it holds a lock every other caller for that slot queues behind, so the
//     transaction has to stay short;
//   - throwing rolls the whole transaction back, which is what leaves a refused
//     transfer's source order exactly as it was.
//
// `when` is the instant whose slot is being claimed — scheduledFor for a
// scheduled order, the moment of the action for an ASAP one. The caller must
// pass the SAME instant it will anchor the order to, or the order is checked
// against one slot and lands in another, which is the defect this closes.
//
// No capacity row means the store has not configured a limit, so there is
// nothing to enforce — the same answer evaluateBranches gives, and deliberately
// not a refusal.
// Exported for tests. Two reassign requests fired with Promise.all do NOT
// overlap in here — measured 2026-09-24: they enter 28 ms apart and the first
// has finished counting 25 ms before the second arrives, because each request
// does eight sequential round trips before its transaction opens. So an
// HTTP-level race test passes with or without the lock and proves nothing about
// it. tests/phoneOrders.test.js drives this function directly, in two genuinely
// parallel transactions, to exercise the lock itself.
export const reserveSlot = async (tx, { companyId, branchId, when }) => {
  const cap = await tx.branchPrepCapacity.findFirst({ where: { companyId, branchId } });
  if (!cap) return;
  const { start, end } = slotBoundsFor(when, cap.slotMinutes);
  await lockSlot(tx, { companyId, branchId, start });
  const booked = await countBookedInSlot(tx, { companyId, branchId, start, end });
  if (booked >= cap.maxOrdersPerSlot) {
    throw branchUnavailable([capacityReason(booked, cap.maxOrdersPerSlot)]);
  }
};

const loadCustomer = async (req, id) => {
  const customer = await prisma.customer.findFirst({
    where: { id, companyId: req.companyScope.id },
  });
  if (!customer) throw notFound('Customer not found');
  return customer;
};

// --- customers ---------------------------------------------------------------

router.get(
  '/customers',
  ...can('phone.customer.read'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 3) throw badRequest('Search for at least 3 characters', 'q');
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);

    const customers = await prisma.customer.findMany({
      where: {
        companyId: req.companyScope.id,
        archivedAt: null,
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { startsWith: q } }],
      },
      orderBy: { name: 'asc' },
      take: limit,
      include: { _count: { select: { addresses: true } } },
    });

    res.json({
      customers: customers.map((c) => ({
        ...customerPublic(c),
        addressCount: c._count.addresses,
      })),
    });
  }),
);

router.post(
  '/customers',
  ...can('phone.customer.write'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        phone: z.string().trim().min(6).max(20),
        email: z.string().trim().email().max(160).optional().nullable(),
        note: z.string().trim().max(500).optional().nullable(),
      })
      .parse(req.body);

    const existing = await prisma.customer.findFirst({
      where: { companyId: req.companyScope.id, phone: body.phone },
    });
    // A duplicate is not a failure the operator caused - it is a repeat caller.
    // Hand back the id so the screen can offer to open them instead of dead-ending.
    if (existing) {
      throw new AppError(
        409,
        'POS_CONFLICT',
        'A customer with that phone number already exists',
        'phone',
        { customerId: existing.id },
      );
    }

    const customer = await prisma.customer.create({
      data: {
        companyId: req.companyScope.id,
        name: body.name,
        phone: body.phone,
        email: body.email ?? null,
        note: body.note ?? null,
        createdById: req.user.id,
      },
    });
    await audit(req, {
      action: 'PHONE_CUSTOMER_CREATE',
      entity: 'Customer',
      entityId: customer.id,
      companyId: req.companyScope.id,
      meta: { name: customer.name },
    });
    res.status(201).json({ customer: customerPublic(customer) });
  }),
);

router.get(
  '/customers/:id',
  ...can('phone.customer.read'),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id);
    const own = operatorBranchOf(req.user);

    const addresses = await prisma.customerAddress.findMany({
      where: { customerId: customer.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    // Permitted history: a branch-pinned role sees only orders from their own
    // store. The spec is explicit that history stays tenant-scoped and that
    // address/phone data is for authorized staff only.
    const phoneOrders = await prisma.phoneOrder.findMany({
      where: {
        customerId: customer.id,
        companyId: req.companyScope.id,
        ...(own ? { OR: [{ routedBranchId: own }, { acceptedBranchId: own }] } : {}),
        orderId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { order: true, routedBranch: { select: { name: true } } },
    });

    res.json({
      customer: {
        ...customerPublic(customer),
        addresses: addresses.map(addressPublic),
        history: phoneOrders.map((po) => ({
          phoneOrderId: po.id,
          reference: po.reference,
          orderId: po.orderId,
          invoiceNumber: po.order?.invoiceNumber ?? null,
          branchId: po.routedBranchId,
          branchName: po.routedBranch?.name ?? null,
          total: po.order ? Number(po.order.total) : null,
          status: po.order?.status ?? null,
          billedAt: po.order?.billedAt ?? null,
          fulfilment: po.fulfilment,
        })),
      },
    });
  }),
);

router.post(
  '/customers/:id/addresses',
  ...can('phone.customer.write'),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id);
    const body = z
      .object({
        label: z.string().trim().min(1).max(40),
        line1: z.string().trim().min(1).max(160),
        line2: z.string().trim().max(160).optional().nullable(),
        landmark: z.string().trim().max(120).optional().nullable(),
        city: z.string().trim().min(1).max(80),
        pincode: pincodeSchema,
        isDefault: z.boolean().optional().default(false),
      })
      .parse(req.body);

    const address = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: customer.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: {
          companyId: req.companyScope.id,
          customerId: customer.id,
          label: body.label,
          line1: body.line1,
          line2: body.line2 ?? null,
          landmark: body.landmark ?? null,
          city: body.city,
          pincode: body.pincode,
          isDefault: body.isDefault,
        },
      });
    });

    await audit(req, {
      action: 'PHONE_ADDRESS_CREATE',
      entity: 'CustomerAddress',
      entityId: address.id,
      companyId: req.companyScope.id,
      meta: { customerId: customer.id, pincode: address.pincode },
    });
    res.status(201).json({ address: addressPublic(address) });
  }),
);

router.patch(
  '/customers/:id/addresses/:addressId',
  ...can('phone.customer.write'),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id);
    const body = z
      .object({
        label: z.string().trim().min(1).max(40).optional(),
        line1: z.string().trim().min(1).max(160).optional(),
        line2: z.string().trim().max(160).optional().nullable(),
        landmark: z.string().trim().max(120).optional().nullable(),
        city: z.string().trim().min(1).max(80).optional(),
        pincode: pincodeSchema.optional(),
        isDefault: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);

    const current = await prisma.customerAddress.findFirst({
      where: { id: req.params.addressId, customerId: customer.id },
    });
    if (!current) throw notFound('Address not found');

    const address = await prisma.$transaction(async (tx) => {
      if (body.isDefault === true) {
        await tx.customerAddress.updateMany({
          where: { customerId: customer.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.update({
        where: { id: current.id },
        data: {
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.line1 === undefined ? {} : { line1: body.line1 }),
          ...(body.line2 === undefined ? {} : { line2: body.line2 }),
          ...(body.landmark === undefined ? {} : { landmark: body.landmark }),
          ...(body.city === undefined ? {} : { city: body.city }),
          ...(body.pincode === undefined ? {} : { pincode: body.pincode }),
          ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
          ...(body.archived === undefined
            ? {}
            : { archivedAt: body.archived ? new Date() : null, isDefault: false }),
        },
      });
    });

    await audit(req, {
      action: 'PHONE_ADDRESS_UPDATE',
      entity: 'CustomerAddress',
      entityId: address.id,
      companyId: req.companyScope.id,
      meta: { customerId: customer.id, archived: body.archived ?? null },
    });
    res.json({ address: addressPublic(address) });
  }),
);

// --- branch options ----------------------------------------------------------

const optionsSchema = z.object({
  fulfilment: z.enum(['PICKUP', 'DELIVERY']),
  addressId: z.string().min(1).optional().nullable(),
  scheduledFor: z.string().datetime().optional().nullable(),
  items: itemsSchema.optional(),
});

const resolveAddressFor = async (req, fulfilment, addressId) => {
  if (fulfilment !== 'DELIVERY') return null;
  if (!addressId) throw badRequest('A delivery address is required', 'addressId');
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, companyId: req.companyScope.id },
  });
  if (!address) throw notFound('Address not found');
  if (address.archivedAt) throw badRequest('That address has been archived', 'addressId');
  return address;
};

router.post(
  '/branch-options',
  ...can('phone.order.create'),
  asyncHandler(async (req, res) => {
    const body = optionsSchema.parse(req.body);
    const address = await resolveAddressFor(req, body.fulfilment, body.addressId);
    const when = body.scheduledFor ? new Date(body.scheduledFor) : new Date();

    const options = await loadBranchDecision({
      req,
      fulfilment: body.fulfilment,
      address,
      when,
      items: body.items ?? null,
    });
    res.json({ options });
  }),
);

// --- submission --------------------------------------------------------------

const submitSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(64),
  customerId: z.string().min(1),
  addressId: z.string().min(1).optional().nullable(),
  fulfilment: z.enum(['PICKUP', 'DELIVERY']),
  branchId: z.string().min(1),
  scheduledFor: z.string().datetime().optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  items: itemsSchema,
});

// Everything that defines the submission EXCEPT the key. A replay carrying a
// different body is a caller bug, not a retry, and must not be answered with
// someone else's order.
const hashOf = (body) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        customerId: body.customerId,
        addressId: body.addressId ?? null,
        fulfilment: body.fulfilment,
        branchId: body.branchId,
        scheduledFor: body.scheduledFor ?? null,
        note: body.note ?? null,
        // `m` is part of the hash because it is part of the order. Without it
        // a retry of the same key carrying DIFFERENT toppings hashes equal,
        // passes the replay check, and hands back the first order as though it
        // were the one just asked for — the caller is told "extra cheese"
        // succeeded and receives the plain one. Sorted into the sort key too,
        // so two lines of the same product differing only by modifier cannot
        // swap places between two otherwise identical submissions.
        items: [...body.items]
          .map((i) => ({ p: i.productId, v: i.variantId ?? null, q: i.qty, m: modKeyOf(i) }))
          .sort((a, b) => `${a.p}${a.v}${a.m}`.localeCompare(`${b.p}${b.v}${b.m}`)),
      }),
    )
    .digest('hex');

const orderOf = (orderId) => (orderId ? prisma.order.findUnique({ where: { id: orderId } }) : null);

// The answer a duplicate submission gets, wherever the duplicate is noticed:
// the original order back when the body matches, and a refusal when the same
// key was reused to mean something else. One function for both the pre-check
// and the concurrent path, so the two cannot drift into answering differently.
const answerDuplicate = async (res, prior, requestHash) => {
  if (prior.requestHash !== requestHash) throw idempotencyReused();
  return res.status(200).json({ phoneOrder: phoneOrderPublic(prior, await orderOf(prior.orderId)) });
};

// `meta.target` is the field list, e.g. ["companyId","idempotencyKey"].
const idempotencyClash = (err) =>
  err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('idempotencyKey');

router.post(
  '/',
  ...can('phone.order.create'),
  asyncHandler(async (req, res) => {
    const body = submitSchema.parse(req.body);
    const companyId = req.companyScope.id;
    const requestHash = hashOf(body);

    // Idempotency first: a retry must never reach the order-creation path.
    const prior = await prisma.phoneOrder.findFirst({
      where: { companyId, idempotencyKey: body.idempotencyKey },
    });
    if (prior) return answerDuplicate(res, prior, requestHash);

    const customer = await prisma.customer.findFirst({ where: { id: body.customerId, companyId } });
    if (!customer) throw notFound('Customer not found');
    const address = await resolveAddressFor(req, body.fulfilment, body.addressId);
    if (address && address.customerId !== customer.id) {
      throw badRequest('That address belongs to a different customer', 'addressId');
    }

    // A scheduled order must carry a real future time. The spec requires an
    // explicit fulfilment time rather than a default nobody agreed to.
    let scheduledFor = null;
    if (body.scheduledFor) {
      scheduledFor = new Date(body.scheduledFor);
      if (scheduledFor.getTime() <= Date.now()) {
        throw badRequest('A scheduled time must be in the future', 'scheduledFor');
      }
    }
    // takenAt is captured ONCE and then both checked against and stored, so an
    // ASAP order cannot be judged against one slot and anchored in the next.
    // Letting createdAt default to now() inside the transaction reopens that as
    // a millisecond-wide window on every slot boundary — rare, but the identical
    // shape of bug to the late-transfer hole, and free to close here.
    const takenAt = new Date();
    const when = scheduledFor ?? takenAt;

    const own = operatorBranchOf(req.user);
    if (own && body.branchId !== own) throw forbidden();
    if (!own && !hqRoutingEntitled(req.license)) {
      // A tenant with no multi-store licence has exactly one store to route to;
      // an owner naming another one is refused by entitlement, not by scope.
      const target = await prisma.branch.findFirst({ where: { id: body.branchId, companyId } });
      const count = await prisma.branch.count({ where: { companyId } });
      if (target && count > 1) throw hqNotEntitled();
    }

    // The operator's screen may be stale, so availability is judged again here
    // and the submission is refused with the same reason codes the selector used.
    const options = await loadBranchDecision({
      req,
      fulfilment: body.fulfilment,
      address,
      when,
      items: body.items,
    });
    const chosen = options.find((o) => o.branchId === body.branchId);
    if (!chosen) throw notFound('Branch not found');
    if (!chosen.available) throw branchUnavailable(chosen.unavailableReasons);

    const lines = [];
    for (const item of mergeCatalogItems(body.items)) {
      lines.push(await resolveCatalogLine(companyId, item));
    }

    // The pre-check above cannot see a submission that has not committed yet, so
    // a double-click gets past it and both requests reach the create. Postgres
    // holds the loser's insert until the winner commits, which means a clash on
    // this key is proof the winner is readable NOW — and the loser is owed the
    // answer the pre-check would have given it a moment later, not the 500 a
    // bare P2002 used to produce. The transaction rolled back whole, so there is
    // no half-written order behind this and nothing to undo.
    let created;
    try {
      created = await withReferenceRetry(async (reference) =>
        prisma.$transaction(async (tx) => {
          // Binding capacity check, before anything is written. The check above
          // was advisory; two callers racing for the last place both passed it.
          // `when` is the same instant this order will be anchored to —
          // scheduledFor if it is scheduled, else the submit time, which becomes
          // its createdAt.
          await reserveSlot(tx, { companyId, branchId: body.branchId, when });

          const order = await tx.order.create({
            data: {
              companyId,
              branchId: body.branchId,
              // Pickup and delivery are both TAKEAWAY at the Order level; the real
              // fulfilment mode lives on the sidecar (contract C-2). OrderType
              // belongs to the orders lane and is not extended from here.
              type: 'TAKEAWAY',
              note: body.note ?? null,
              openedById: req.user.id,
            },
          });
          // Was `createMany` with a guard that threw if any line carried
          // modifiers — correct while the API had no modifier field, and the
          // guard is what made D-3's blast radius knowable instead of silent.
          // Now that phone orders can carry them, the nested snapshot rows rule
          // createMany out and this is the till's own per-row writer. Still one
          // transaction, so a half-written order is not reachable.
          for (const l of lines) {
            await tx.orderItem.create({ data: createLineData(l, order.id) });
          }
          await recomputeOrder(tx, order.id);

          const phoneOrder = await tx.phoneOrder.create({
            data: {
              companyId,
              reference,
              customerId: customer.id,
              addressId: address?.id ?? null,
              fulfilment: body.fulfilment,
              scheduledFor,
              // Pinned, not defaulted — see takenAt above. This is the slot
              // anchor for an ASAP order, so it must be the instant reserveSlot
              // just checked.
              createdAt: takenAt,
              status: 'SUBMITTED',
              routedBranchId: body.branchId,
              orderId: order.id,
              operatorId: req.user.id,
              operatorName: req.user.fullName ?? req.user.email,
              deliveryCharge: chosen.deliveryCharge ?? 0,
              note: body.note ?? null,
              idempotencyKey: body.idempotencyKey,
              requestHash,
            },
          });
          await tx.phoneOrderEvent.create({
            data: {
              companyId,
              phoneOrderId: phoneOrder.id,
              action: 'SUBMITTED',
              actorId: req.user.id,
              toBranchId: body.branchId,
            },
          });
          return phoneOrder;
        }),
      );
    } catch (err) {
      if (!idempotencyClash(err)) throw err;
      const winner = await prisma.phoneOrder.findFirst({
        where: { companyId, idempotencyKey: body.idempotencyKey },
      });
      if (!winner) throw err;
      return answerDuplicate(res, winner, requestHash);
    }

    await audit(req, {
      action: 'PHONE_ORDER_SUBMIT',
      entity: 'PhoneOrder',
      entityId: created.id,
      companyId,
      meta: {
        reference: created.reference,
        branchId: body.branchId,
        fulfilment: body.fulfilment,
        scheduled: Boolean(scheduledFor),
      },
    });
    res.status(201).json({ phoneOrder: phoneOrderPublic(created, await orderOf(created.orderId)) });
  }),
);

// The reference is per tenant and human-readable, so it is derived from a count
// rather than a random string. Two operators submitting at the same instant can
// therefore pick the same number - the unique index catches it and we retry,
// which is cheaper and simpler than serialising every submission behind a lock.
const withReferenceRetry = async (run) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const n = await prisma.phoneOrder.count();
    const reference = `PH-${String(n + 1 + attempt).padStart(6, '0')}`;
    try {
      return await run(reference);
    } catch (err) {
      const clash = err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('reference');
      if (!clash) throw err;
    }
  }
  throw conflict('Could not allocate a phone-order reference; please retry');
};

// --- accept / reject ---------------------------------------------------------

const loadForDecision = async (req, id) => {
  const po = await prisma.phoneOrder.findFirst({ where: { id, ...scopeWhere(req) } });
  if (!po) throw notFound('Phone order not found');
  return po;
};

router.post(
  '/:id/accept',
  ...can('phone.order.accept'),
  asyncHandler(async (req, res) => {
    const po = await loadForDecision(req, req.params.id);
    const own = operatorBranchOf(req.user);
    // The accepting store is the caller's store, taken from the token. Never
    // the body: that is the difference between attribution and a claim.
    if (own && own !== po.routedBranchId) throw forbidden();

    const updated = await prisma.$transaction(async (tx) => {
      // FOR UPDATE serialises concurrent accepts on this row, so the guard
      // below is evaluated by one transaction at a time. That is what makes
      // "exactly one accepting store" a database outcome, not a hope.
      await tx.$queryRaw`SELECT id FROM "PhoneOrder" WHERE id = ${po.id} FOR UPDATE`;
      const fresh = await tx.phoneOrder.findUnique({ where: { id: po.id } });
      if (fresh.status !== 'SUBMITTED' || fresh.acceptedBranchId !== null) throw alreadyDecided();

      const row = await tx.phoneOrder.update({
        where: { id: po.id },
        data: {
          status: 'ACCEPTED',
          acceptedBranchId: fresh.routedBranchId,
          acceptedAt: new Date(),
          acceptedById: req.user.id,
          acceptedByName: req.user.fullName ?? req.user.email,
        },
      });
      await tx.phoneOrderEvent.create({
        data: {
          companyId: po.companyId,
          phoneOrderId: po.id,
          action: 'ACCEPTED',
          actorId: req.user.id,
          toBranchId: fresh.routedBranchId,
        },
      });
      return row;
    });

    await audit(req, {
      action: 'PHONE_ORDER_ACCEPT',
      entity: 'PhoneOrder',
      entityId: po.id,
      companyId: po.companyId,
      meta: { reference: po.reference, branchId: updated.acceptedBranchId },
    });
    res.json({ phoneOrder: phoneOrderPublic(updated, await orderOf(updated.orderId)) });
  }),
);

router.post(
  '/:id/reject',
  ...can('phone.order.accept'),
  asyncHandler(async (req, res) => {
    const po = await loadForDecision(req, req.params.id);
    const own = operatorBranchOf(req.user);
    if (own && own !== po.routedBranchId) throw forbidden();
    const { reason } = z
      .object({ reason: z.string().trim().min(3).max(200) })
      .parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PhoneOrder" WHERE id = ${po.id} FOR UPDATE`;
      const fresh = await tx.phoneOrder.findUnique({ where: { id: po.id } });
      if (fresh.status !== 'SUBMITTED') throw alreadyDecided();

      const row = await tx.phoneOrder.update({
        where: { id: po.id },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          rejectedById: req.user.id,
          rejectedByName: req.user.fullName ?? req.user.email,
          rejectReason: reason,
        },
      });
      await tx.phoneOrderEvent.create({
        data: {
          companyId: po.companyId,
          phoneOrderId: po.id,
          action: 'REJECTED',
          actorId: req.user.id,
          fromBranchId: fresh.routedBranchId,
          reason,
        },
      });
      return row;
    });

    await audit(req, {
      action: 'PHONE_ORDER_REJECT',
      entity: 'PhoneOrder',
      entityId: po.id,
      companyId: po.companyId,
      meta: { reference: po.reference, reason },
    });
    res.json({ phoneOrder: phoneOrderPublic(updated, await orderOf(updated.orderId)) });
  }),
);

// --- reassignment ------------------------------------------------------------

router.post(
  '/:id/reassign',
  ...can('phone.order.reassign'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const po = await prisma.phoneOrder.findFirst({ where: { id: req.params.id, companyId } });
    if (!po) throw notFound('Phone order not found');
    const body = z
      .object({
        branchId: z.string().min(1),
        reason: z.string().trim().min(3).max(200),
      })
      .parse(req.body);

    if (po.status !== 'SUBMITTED' && po.status !== 'REJECTED') throw alreadyDecided();
    if (body.branchId === po.routedBranchId) {
      throw badRequest('That is already the routed store', 'branchId');
    }

    const order = await orderOf(po.orderId);
    if (!order) throw conflict('This phone order has no order to move');
    // An issued invoice never moves store (spec A§3 VC-104). Corrections are new
    // rows; a relocated invoice would be a mutated one.
    if (order.invoiceNumber) throw invoiceIssued();
    const payments = await prisma.payment.count({ where: { orderId: order.id } });
    if (payments > 0) throw conflict('Money has already been taken against this order');

    const address = po.addressId
      ? await prisma.customerAddress.findFirst({ where: { id: po.addressId, companyId } })
      : null;
    // movedAt is the moment this store is being asked, and it is used THREE
    // times: to pick the slot to check, to stamp the REASSIGNED event, and
    // therefore — via that event — as the order's slot anchor at its new store.
    // One variable rather than three now() calls is what makes "checked against
    // the slot it lands in" true by construction instead of by luck.
    //
    // For a SCHEDULED order that is still ahead of its due time the anchor stays
    // scheduledFor: the food is due at the same moment wherever it is cooked, so
    // `when` is that, while the event still records the real move time.
    //
    // An OVERDUE one is the opposite case and it is a capacity hole, not a
    // rounding detail. An order due at 18:00 and still unmade at 19:30 does not
    // get cooked at 18:00 — it goes on the pass now. Judging it against 18:00
    // checks a window that has already elapsed and is therefore almost always
    // empty, so a stale scheduledFor walks straight past a destination that is
    // full RIGHT NOW, and the store is handed food it has no room to cook.
    // Nothing stops this happening: submit refuses a scheduledFor in the past,
    // but nothing re-checks it afterwards. An order can therefore sit SUBMITTED
    // straight through its due time — not because the status cannot advance
    // (REJECT is a route and it does release the slot) but because no clock
    // advances it. There is no sweep, no expiry, nothing time-driven at all;
    // only a human pressing accept or reject moves it.
    //
    // The admission rule is therefore the LATER of the two — the same GREATEST
    // that SLOT_ANCHOR applies, so the slot checked here and the slot the order
    // lands in are one rule evaluated in two places rather than two rules that
    // have to be kept in step.
    const movedAt = new Date();
    const when = po.scheduledFor && po.scheduledFor > movedAt ? po.scheduledFor : movedAt;
    // Modifiers come along so the new store's minimum-order-value rule is
    // judged against what this basket actually costs. Nothing is re-priced from
    // them — the line's unitPrice was snapshotted at submit and recomputeOrder
    // works off the stored rows — they only feed the availability estimate.
    const items = await prisma.orderItem.findMany({
      where: { orderId: order.id, status: 'ACTIVE' },
      select: {
        productId: true,
        variantId: true,
        qty: true,
        modifiers: { select: { optionId: true } },
      },
    });

    const options = await loadBranchDecision({
      req,
      fulfilment: po.fulfilment,
      address,
      when,
      items: items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId ?? undefined,
        qty: i.qty,
        modifierOptionIds: i.modifiers.map((m) => m.optionId),
      })),
    });
    const chosen = options.find((o) => o.branchId === body.branchId);
    if (!chosen) throw notFound('Branch not found');
    if (!chosen.available) throw branchUnavailable(chosen.unavailableReasons);

    // The payable is captured too, not just the order. Moving store cannot change
    // food or tax — the catalog is company-wide (C-7) and each line's tax rate was
    // snapshotted at submit — so the delivery charge is the only figure a
    // reassignment actually moves, and it lives outside Order while C-6 is open.
    const before = {
      total: Number(order.total),
      tax: Number(order.taxAmount),
      payable: buildQuote(order, po.deliveryCharge).payableQuote,
    };

    const updated = await prisma.$transaction(async (tx) => {
      // Binding capacity check at the DESTINATION, before anything moves. The
      // options read above is advisory; this is what makes the transfer a
      // reservation rather than a hope. Throwing here rolls back everything
      // below, so a refused transfer leaves the order at its source store with
      // its status, its acceptance and its delivery charge untouched.
      await reserveSlot(tx, { companyId, branchId: body.branchId, when });

      await tx.order.update({ where: { id: order.id }, data: { branchId: body.branchId } });
      // Price and tax are recomputed for the new store BEFORE anything can be
      // billed - the whole point of refusing a silent relocation.
      await recomputeOrder(tx, order.id);

      const row = await tx.phoneOrder.update({
        where: { id: po.id },
        data: {
          routedBranchId: body.branchId,
          status: 'SUBMITTED',
          acceptedBranchId: null,
          acceptedAt: null,
          acceptedById: null,
          acceptedByName: null,
          rejectedAt: null,
          rejectedById: null,
          rejectedByName: null,
          rejectReason: null,
          deliveryCharge: chosen.deliveryCharge ?? 0,
        },
      });
      await tx.phoneOrderEvent.create({
        data: {
          companyId,
          phoneOrderId: po.id,
          // Stamped from movedAt rather than defaulted to now(). For an ASAP
          // order THIS ROW IS THE SLOT ANCHOR at the new store — the capacity
          // count reads max(at) of the latest REASSIGNED into the current
          // branch — so it has to be the instant reserveSlot checked, not a few
          // milliseconds later on the far side of a slot boundary.
          at: movedAt,
          action: 'REASSIGNED',
          actorId: req.user.id,
          fromBranchId: po.routedBranchId,
          toBranchId: body.branchId,
          reason: body.reason,
        },
      });
      return row;
    });

    const after = await orderOf(po.orderId);
    await audit(req, {
      action: 'PHONE_ORDER_REASSIGN',
      entity: 'PhoneOrder',
      entityId: po.id,
      companyId,
      meta: {
        reference: po.reference,
        fromBranchId: po.routedBranchId,
        toBranchId: body.branchId,
        reason: body.reason,
        totalBefore: before.total,
        totalAfter: Number(after.total),
      },
    });

    // Derived from buildQuote rather than re-added here, so that if C-6 closes and
    // the charge folds into the order, this keeps reporting the same number the
    // operator is reading to the caller.
    const afterPayable = buildQuote(after, updated.deliveryCharge).payableQuote;

    res.json({
      phoneOrder: phoneOrderPublic(updated, after),
      priceChanged:
        Number(after.total) !== before.total ||
        Number(after.taxAmount) !== before.tax ||
        afterPayable !== before.payable,
    });
  }),
);

// --- reads -------------------------------------------------------------------

router.get(
  '/',
  ...can('phone.order.read'),
  asyncHandler(async (req, res) => {
    // CANCELLED is deliberately not queryable. The enum carries it, but no route
    // can produce it yet - cancelling a phone order that may already hold money
    // needs the refund/void rules, which wait on C-6.
    //
    // An unknown value is REFUSED rather than dropped. Dropping it empties the
    // status list, an empty list means "no status filter", and the caller who
    // asked for cancelled orders would get every order back - the widest
    // possible answer to the narrowest question.
    const requested = String(req.query.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = requested.filter((s) => !['SUBMITTED', 'ACCEPTED', 'REJECTED'].includes(s));
    if (unknown.length) {
      throw badRequest(`Not a queryable status: ${unknown.join(', ')}`, 'status');
    }
    const statuses = requested;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);

    const rows = await prisma.phoneOrder.findMany({
      where: {
        ...scopeWhere(req),
        ...(statuses.length ? { status: { in: statuses } } : {}),
        ...(req.query.branchId ? { routedBranchId: String(req.query.branchId) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { order: true },
    });
    res.json({ phoneOrders: rows.map((po) => phoneOrderPublic(po, po.order)) });
  }),
);

router.get(
  '/:id',
  ...can('phone.order.read'),
  asyncHandler(async (req, res) => {
    const po = await prisma.phoneOrder.findFirst({
      where: { id: req.params.id, ...scopeWhere(req) },
      include: { order: true, events: { orderBy: { at: 'asc' } } },
    });
    if (!po) throw notFound('Phone order not found');
    res.json({
      phoneOrder: {
        ...phoneOrderPublic(po, po.order),
        events: po.events.map((e) => ({
          at: e.at,
          action: e.action,
          fromBranchId: e.fromBranchId ?? null,
          toBranchId: e.toBranchId ?? null,
          reason: e.reason ?? null,
        })),
      },
    });
  }),
);

export default router;
