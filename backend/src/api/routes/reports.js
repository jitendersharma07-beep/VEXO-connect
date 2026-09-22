// Sales report — contract §10. BRANCH_MANAGER sees their own branch,
// CUSTOMER_OWNER the whole company (or one branch), ATC read with company
// scope; CASHIER is refused. Sales figures cover PAID+REFUNDED orders billed
// in the window (IST days); collected/refunds follow payment/refund
// timestamps. Aggregation runs in integer paise.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope, isBranchPinned } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { toPaise, toRupees } from '../../lib/money.js';
import { paiseOf, istDayStartUtc, istDateOf } from '../../lib/orders.js';
import { gatewayAvailable } from '../../lib/gateway/index.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

router.get(
  '/sales',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        branchId: z.string().optional(),
      })
      .parse(req.query);
    const fromUtc = istDayStartUtc(query.from);
    const toExcl = new Date(istDayStartUtc(query.to).getTime() + 86400e3);
    if (!(fromUtc < toExcl)) throw badRequest('from must be on or before to', 'from');

    let branchId = null;
    if (isBranchPinned(req.user)) {
      branchId = req.user.branchId;
    } else if (query.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: query.branchId, companyId: req.companyScope.id },
      });
      if (!branch) throw notFound('Branch not found');
      branchId = branch.id;
    }
    const companyId = req.companyScope.id;
    const branchWhere = branchId ? { branchId } : {};
    const window = { gte: fromUtc, lt: toExcl };

    const [salesOrders, statusCounts, payments, refunds] = await Promise.all([
      prisma.order.findMany({
        where: { companyId, ...branchWhere, status: { in: ['PAID', 'REFUNDED'] }, billedAt: window },
        include: {
          items: {
            where: { status: 'ACTIVE' },
            include: {
              product: { select: { categoryId: true, category: { select: { name: true } } } },
            },
          },
        },
      }),
      prisma.order.groupBy({
        by: ['status'],
        where: { companyId, ...branchWhere, createdAt: window },
        _count: { _all: true },
      }),
      prisma.payment.findMany({
        where: { createdAt: window, order: { companyId, ...branchWhere } },
        select: { amount: true, method: true, channel: true, createdAt: true },
      }),
      // SUCCEEDED only. A gateway refund the provider has not paid out yet is
      // not money that left the business, and totalling it here would
      // under-report takings by an amount nobody has actually returned.
      prisma.refund.findMany({
        where: { createdAt: window, status: 'SUCCEEDED', order: { companyId, ...branchWhere } },
        select: { amount: true, createdAt: true },
      }),
    ]);

    let grossItems = 0;
    let discounts = 0;
    let tax = 0;
    let netSales = 0;
    const byCategory = new Map();
    const byDay = new Map();
    const dayRow = (date) => {
      let row = byDay.get(date);
      if (!row) {
        row = { date, orders: 0, netSales: 0, collected: 0 };
        byDay.set(date, row);
      }
      return row;
    };

    for (const o of salesOrders) {
      for (const i of o.items) {
        grossItems += paiseOf(i.unitPrice) * i.qty;
        discounts += paiseOf(i.lineDiscount);
        const cat = byCategory.get(i.product.categoryId) || {
          categoryId: i.product.categoryId,
          name: i.product.category.name,
          qty: 0,
          amount: 0,
        };
        cat.qty += i.qty;
        cat.amount += paiseOf(i.lineSubtotal);
        byCategory.set(i.product.categoryId, cat);
      }
      discounts += paiseOf(o.discountAmount);
      tax += paiseOf(o.taxAmount);
      netSales += paiseOf(o.total);
      const day = dayRow(istDateOf(o.billedAt));
      day.orders += 1;
      day.netSales += paiseOf(o.total);
    }

    let collected = 0;
    let refundsTotal = 0;
    const byMethod = new Map();
    const byChannel = new Map();
    for (const p of payments) {
      const amount = paiseOf(p.amount);
      collected += amount;
      // Keyed on method AND channel: the same method can arrive both ways, and
      // collapsing them would label provider-verified money as hand-recorded,
      // or the reverse.
      const key = `${p.method}|${p.channel}`;
      const m = byMethod.get(key) || { method: p.method, channel: p.channel, amount: 0, count: 0 };
      m.amount += amount;
      m.count += 1;
      byMethod.set(key, m);
      const c = byChannel.get(p.channel) || { channel: p.channel, amount: 0, count: 0 };
      c.amount += amount;
      c.count += 1;
      byChannel.set(p.channel, c);
      dayRow(istDateOf(p.createdAt)).collected += amount;
    }
    for (const r of refunds) refundsTotal += paiseOf(r.amount);

    const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    res.json({
      report: {
        from: query.from,
        to: query.to,
        branchId,
        currency: 'INR',
        sales: {
          grossItems: toRupees(grossItems),
          discounts: toRupees(discounts),
          tax: toRupees(tax),
          netSales: toRupees(netSales),
          refunds: toRupees(refundsTotal),
          collected: toRupees(collected),
        },
        orders: {
          total: statusCounts.reduce((a, s) => a + s._count._all, 0),
          open: counts.OPEN ?? 0,
          billed: counts.BILLED ?? 0,
          paid: counts.PAID ?? 0,
          refunded: counts.REFUNDED ?? 0,
          voided: counts.VOID ?? 0,
        },
        byMethod: [...byMethod.values()]
          .sort((a, b) => b.amount - a.amount)
          .map((m) => ({ ...m, amount: toRupees(m.amount) })),
        byCategory: [...byCategory.values()]
          .sort((a, b) => b.amount - a.amount)
          .map((c) => ({ ...c, amount: toRupees(c.amount) })),
        byDay: [...byDay.values()]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((d) => ({ ...d, netSales: toRupees(d.netSales), collected: toRupees(d.collected) })),
        byChannel: [...byChannel.values()]
          .sort((a, b) => b.amount - a.amount)
          .map((c) => ({ ...c, amount: toRupees(c.amount) })),
        note: gatewayAvailable()
          ? 'MANUAL figures are hand-recorded by staff and are not provider-verified; GATEWAY figures were settled by the provider and confirmed by a signature-verified webhook.'
          : 'All payments are manual records: no payment provider is configured on this deployment.',
      },
    });
  }),
);

// --- gateway reconciliation -------------------------------------------------

// Puts "what we asked for" beside "what arrived", and lists everything that
// does not line up. Manager and above; a cashier cannot see it.
//
// Webhook events carry no company of their own, so they are attributed
// through their intent's order. An event that matched no intent cannot be
// attributed to anyone, and showing it to a customer would disclose that
// another tenant's traffic exists — so those are visible to ATC only.
router.get(
  '/gateway-reconciliation',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        branchId: z.string().optional(),
      })
      .parse(req.query);
    const fromUtc = istDayStartUtc(query.from);
    const toExcl = new Date(istDayStartUtc(query.to).getTime() + 86400e3);
    if (!(fromUtc < toExcl)) throw badRequest('from must be on or before to', 'from');

    let branchId = null;
    if (isBranchPinned(req.user)) {
      branchId = req.user.branchId;
    } else if (query.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: query.branchId, companyId: req.companyScope.id },
      });
      if (!branch) throw notFound('Branch not found');
      branchId = branch.id;
    }
    const companyId = req.companyScope.id;
    const orderScope = { companyId, ...(branchId ? { branchId } : {}) };
    const window = { gte: fromUtc, lt: toExcl };
    const isAtc = req.user.role === 'POS_SUPER_ADMIN';

    const [
      openIntents,
      settledIntents,
      orphanPayments,
      skippedEvents,
      unprocessed,
      rejections,
      pendingRefunds,
      unconfirmedRefunds,
      failedRefunds,
    ] = await Promise.all([
        // Asked for, never answered. The customer may have paid and the
        // delivery never arrived, so these are the ones to chase.
        prisma.paymentIntent.findMany({
          where: { createdAt: window, status: { in: ['CREATED', 'PENDING'] }, order: orderScope },
          include: { order: { select: { id: true, invoiceNumber: true, status: true } } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        // Settled intents, so their payment row can be checked below.
        prisma.paymentIntent.findMany({
          where: { createdAt: window, status: 'SUCCEEDED', order: orderScope },
          include: {
            payment: { select: { id: true, amount: true } },
            order: { select: { id: true, invoiceNumber: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
        // A GATEWAY payment with no intent behind it should be impossible.
        prisma.payment.findMany({
          where: { createdAt: window, channel: 'GATEWAY', intentId: null, order: orderScope },
          select: { id: true, amount: true, orderId: true, createdAt: true },
          take: 200,
        }),
        // Verified deliveries that deliberately changed nothing.
        prisma.gatewayWebhookEvent.findMany({
          where: {
            receivedAt: window,
            skippedReason: { not: null },
            ...(isAtc ? {} : { intent: { order: orderScope } }),
          },
          orderBy: { receivedAt: 'desc' },
          take: 200,
        }),
        // processedAt null means a delivery was recorded and never applied.
        // The insert and the settlement share one transaction, so this should
        // stay empty; if it does not, that assumption has broken.
        prisma.gatewayWebhookEvent.count({
          where: {
            receivedAt: window,
            processedAt: null,
            ...(isAtc ? {} : { intent: { order: orderScope } }),
          },
        }),
        // Signature failures are never stored as events, only audited. A
        // rejected payload was never verified, so nothing inside it — least of
        // all any tenant reference — can be believed; the audit row carries no
        // company either. So this is a deployment-wide figure and only ATC is
        // given it. Answering a customer "0" would state as fact something we
        // cannot know.
        isAtc
          ? prisma.posAuditLog.count({ where: { action: 'GATEWAY_WEBHOOK_REJECTED', at: window } })
          : null,
        // Money the customer was promised back and has not received. These are
        // the ones that turn into complaints, so they are exceptions from the
        // moment they are raised, not only once they age.
        //
        // providerRef set: the provider has the request and owes the payout.
        prisma.refund.findMany({
          where: {
            createdAt: window,
            channel: 'GATEWAY',
            status: 'PENDING',
            providerRef: { not: null },
            order: orderScope,
          },
          include: { order: { select: { id: true, invoiceNumber: true } } },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
        // providerRef null: the request went out and nothing came back, so
        // nobody knows whether this money is moving. Worse than pending and
        // listed apart from it — these need a human and the same idempotency
        // key, never a fresh refund.
        prisma.refund.findMany({
          where: {
            createdAt: window,
            channel: 'GATEWAY',
            status: 'PENDING',
            providerRef: null,
            order: orderScope,
          },
          include: { order: { select: { id: true, invoiceNumber: true } } },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
        // The provider declined to pay it out. The customer is still owed.
        prisma.refund.findMany({
          where: { createdAt: window, channel: 'GATEWAY', status: 'FAILED', order: orderScope },
          include: { order: { select: { id: true, invoiceNumber: true } } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
      ]);

    const settledWithoutPayment = settledIntents.filter((i) => !i.payment);
    const amountMismatches = settledIntents
      .filter((i) => i.payment && paiseOf(i.payment.amount) !== paiseOf(i.amount))
      .map((i) => ({
        intentId: i.id,
        orderId: i.orderId,
        invoiceNumber: i.order.invoiceNumber,
        intentAmount: Number(i.amount),
        paidAmount: Number(i.payment.amount),
      }));

    const exceptionCount =
      openIntents.length +
      settledWithoutPayment.length +
      orphanPayments.length +
      amountMismatches.length +
      skippedEvents.length +
      unprocessed +
      pendingRefunds.length +
      unconfirmedRefunds.length +
      failedRefunds.length;

    const refundRow = (r) => ({
      refundId: r.id,
      orderId: r.orderId,
      invoiceNumber: r.order.invoiceNumber,
      amount: Number(r.amount),
      reason: r.reason,
      failureReason: r.failureReason,
      requestedAt: r.createdAt,
    });

    res.json({
      report: {
        from: query.from,
        to: query.to,
        branchId,
        currency: 'INR',
        gateway: {
          configured: gatewayAvailable(),
          // Named so the operator can tell which provider these figures came
          // from; null on a deployment with none, which is every one today.
          provider: gatewayAvailable() ? env.POS_GATEWAY_PROVIDER : null,
        },
        summary: {
          settledIntents: settledIntents.length,
          openIntents: openIntents.length,
          exceptions: exceptionCount,
          // null, not 0, for a customer: unknowable is not the same as none.
          signatureFailures: rejections,
          unattributedVisible: isAtc,
          refundsAwaitingProvider: pendingRefunds.length,
          refundsUnconfirmedByProvider: unconfirmedRefunds.length,
          refundsRejectedByProvider: failedRefunds.length,
        },
        exceptions: {
          openIntents: openIntents.map((i) => ({
            intentId: i.id,
            orderId: i.orderId,
            invoiceNumber: i.order.invoiceNumber,
            orderStatus: i.order.status,
            amount: Number(i.amount),
            status: i.status,
            createdAt: i.createdAt,
          })),
          settledWithoutPayment: settledWithoutPayment.map((i) => ({
            intentId: i.id,
            orderId: i.orderId,
            invoiceNumber: i.order.invoiceNumber,
            amount: Number(i.amount),
          })),
          gatewayPaymentsWithoutIntent: orphanPayments.map((p) => ({
            paymentId: p.id,
            orderId: p.orderId,
            amount: Number(p.amount),
            createdAt: p.createdAt,
          })),
          amountMismatches,
          verifiedButNotApplied: skippedEvents.map((e) => ({
            eventId: e.eventId,
            kind: e.kind,
            intentId: e.intentId,
            reason: e.skippedReason,
            receivedAt: e.receivedAt,
          })),
          unprocessedEvents: unprocessed,
          // Requested from the provider, not yet paid out. The customer is
          // still waiting for this money.
          refundsAwaitingProvider: pendingRefunds.map(refundRow),
          // Sent to the provider with no answer. Reconcile with the stored
          // idempotency key; raising a new refund here pays the customer twice.
          refundsUnconfirmedByProvider: unconfirmedRefunds.map(refundRow),
          // The provider refused. Somebody has to make this right by hand.
          refundsRejectedByProvider: failedRefunds.map(refundRow),
        },
        note: isAtc
          ? 'Signature failures are counted, never stored as events: the event id comes from the payload, so recording unverified deliveries would let a forged id block the genuine one. The count and any unattributable events are deployment-wide, not this company only.'
          : 'Signature failures are not reported here: a rejected delivery was never verified, so it cannot be attributed to any company. Ask VEXO for the deployment-wide figure.',
      },
    });
  }),
);

// --- daily closing ----------------------------------------------------------

// The end-of-day cash count.
//
// Everything else in this file reports what the POS believes. This is the one
// place the POS is told something it did not compute — how much cash is
// actually in the drawer — and the value of the whole exercise is the
// disagreement between the two numbers. Without it a till can be short every
// evening and no report will ever say so, because every report is derived
// from the same records that are missing the money.
//
// Cash only. Card, UPI and gateway takings are shown for the day but not
// declared: the bank settles those, and asking a cashier to certify them
// invites a guess to be recorded as a measurement.

// Which branch this closing is for. A pinned role gets their own and may not
// name another; an owner must name one, because "the company's drawer" is not
// a thing that exists — cash sits in a specific till at a specific branch.
const closingBranch = async (req, wanted) => {
  if (isBranchPinned(req.user)) {
    if (wanted && wanted !== req.user.branchId) throw forbidden('You can only close your own branch');
    return prisma.branch.findFirst({ where: { id: req.user.branchId, companyId: req.companyScope.id } });
  }
  if (!wanted) throw badRequest('branchId is required: a cash drawer belongs to one branch', 'branchId');
  const branch = await prisma.branch.findFirst({ where: { id: wanted, companyId: req.companyScope.id } });
  if (!branch) throw notFound('Branch not found');
  return branch;
};

// What the system believes the day held. Shared by the preview and the commit
// so the figures a person sees are the figures that get stored — recomputing
// them separately at commit time is how a preview and a record come to
// disagree about the same day.
const dayFigures = async (companyId, branchId, businessDate) => {
  const fromUtc = istDayStartUtc(businessDate);
  const window = { gte: fromUtc, lt: new Date(fromUtc.getTime() + 86400e3) };
  const orderScope = { companyId, branchId };

  const [payments, refunds, billedCount, openOrders] = await Promise.all([
    prisma.payment.findMany({
      where: { createdAt: window, order: orderScope },
      select: { amount: true, method: true, channel: true },
    }),
    // SUCCEEDED only, matching /sales: a refund the provider has not paid out
    // has not left the drawer, and subtracting it here would manufacture a
    // shortfall the cashier would then be asked to explain.
    prisma.refund.findMany({
      where: { createdAt: window, status: 'SUCCEEDED', order: orderScope },
      select: { amount: true, channel: true },
    }),
    prisma.order.count({ where: { ...orderScope, billedAt: window } }),
    // Unbilled orders still on the floor. Not an error — a café can close its
    // books while a table is still eating — but the person counting should be
    // told, because those takings will land on tomorrow.
    prisma.order.count({ where: { ...orderScope, status: 'OPEN', createdAt: window } }),
  ]);

  let cashSales = 0;
  let cardSales = 0;
  let upiSales = 0;
  let otherSales = 0;
  let gatewaySales = 0;
  for (const p of payments) {
    const amount = paiseOf(p.amount);
    // Channel first: a GATEWAY payment with method CARD never touched this
    // drawer, and counting it as card cash-in-hand would be wrong in the one
    // direction that matters.
    if (p.channel === 'GATEWAY') { gatewaySales += amount; continue; }
    if (p.method === 'CASH') cashSales += amount;
    else if (p.method === 'CARD') cardSales += amount;
    else if (p.method === 'UPI') upiSales += amount;
    else otherSales += amount;
  }

  // Only a MANUAL refund comes out of the till. A gateway refund is returned
  // by the provider from money it already holds.
  let cashRefunds = 0;
  for (const r of refunds) if (r.channel !== 'GATEWAY') cashRefunds += paiseOf(r.amount);

  return {
    cashSales,
    cashRefunds,
    cardSales,
    upiSales,
    otherSales,
    gatewaySales,
    ordersBilled: billedCount,
    openOrders,
    expectedCash: cashSales - cashRefunds,
  };
};

const publicClose = (c) => ({
  id: c.id,
  businessDate: c.businessDate,
  branchId: c.branchId,
  countedCash: toRupees(c.countedCashPaise),
  openingFloat: toRupees(c.openingFloatPaise),
  expectedCash: toRupees(c.expectedCashPaise),
  cashSales: toRupees(c.cashSalesPaise),
  cashRefunds: toRupees(c.cashRefundsPaise),
  cardSales: toRupees(c.cardSalesPaise),
  upiSales: toRupees(c.upiSalesPaise),
  otherSales: toRupees(c.otherSalesPaise),
  gatewaySales: toRupees(c.gatewaySalesPaise),
  variance: toRupees(c.variancePaise),
  ordersBilled: c.ordersBilled,
  note: c.note,
  closedAt: c.closedAt,
  closedBy: c.closedBy ? { id: c.closedBy.id, fullName: c.closedBy.fullName } : null,
  supersededById: c.supersededById,
  isCorrection: Boolean(c.supersededById),
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Preview — what the drawer should hold, before anyone counts it.
//
// A cashier may see this: they are the one with their hands in the till, and
// a count made without knowing the expected figure is the only kind worth
// having. They may not commit one; that is the manager's signature.
router.get(
  '/day-close/preview',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'),
  asyncHandler(async (req, res) => {
    const query = z.object({ date: dateSchema.optional(), branchId: z.string().optional() }).parse(req.query);
    const branch = await closingBranch(req, query.branchId);
    if (!branch) throw notFound('Branch not found');
    const businessDate = query.date ?? istDateOf(new Date());
    if (businessDate > istDateOf(new Date())) throw badRequest('That day has not happened yet', 'date');

    const figures = await dayFigures(req.companyScope.id, branch.id, businessDate);
    const existing = await prisma.dayClose.findFirst({
      where: { branchId: branch.id, businessDate },
      orderBy: { closedAt: 'desc' },
      include: { closedBy: { select: { id: true, fullName: true } } },
    });

    res.json({
      preview: {
        businessDate,
        branchId: branch.id,
        branchName: branch.name,
        cashSales: toRupees(figures.cashSales),
        cashRefunds: toRupees(figures.cashRefunds),
        expectedCash: toRupees(figures.expectedCash),
        cardSales: toRupees(figures.cardSales),
        upiSales: toRupees(figures.upiSales),
        otherSales: toRupees(figures.otherSales),
        gatewaySales: toRupees(figures.gatewaySales),
        ordersBilled: figures.ordersBilled,
        openOrders: figures.openOrders,
        // Stated rather than implied. "Add your opening float to this before
        // comparing" is the single most likely place for an honest count to
        // look like a surplus.
        note: 'Expected cash excludes the opening float. Count everything in the drawer, including the float, and enter the float separately.',
      },
      // Present if the day already has one. The UI uses this to make a second
      // closing an explicit correction rather than something that happens by
      // accident to someone who pressed the button twice.
      existingClose: existing ? publicClose(existing) : null,
    });
  }),
);

// Commit the count.
//
// Manager and above. ATC is refused outright: an ATC operator declaring a
// customer's cash would put ATC's name on a figure only the café can know,
// and every other ATC capability in this system is read-only for the same
// reason.
router.post(
  '/day-close',
  requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        date: dateSchema.optional(),
        branchId: z.string().optional(),
        countedCash: z.union([z.number(), z.string()]),
        openingFloat: z.union([z.number(), z.string()]).optional(),
        note: z.string().trim().max(500).optional(),
        // Set deliberately by the UI when the day already has a closing.
        // Without it a repeat POST is refused, so a double-click cannot file
        // a second, contradictory record of the same evening.
        correctsId: z.string().optional(),
      })
      .parse(req.body);

    const branch = await closingBranch(req, body.branchId);
    if (!branch) throw notFound('Branch not found');
    const businessDate = body.date ?? istDateOf(new Date());
    if (businessDate > istDateOf(new Date())) throw badRequest('That day has not happened yet', 'date');

    const countedCashPaise = toPaise(String(body.countedCash));
    const openingFloatPaise = body.openingFloat === undefined ? 0 : toPaise(String(body.openingFloat));
    if (countedCashPaise < 0) throw badRequest('Counted cash cannot be negative', 'countedCash');
    if (openingFloatPaise < 0) throw badRequest('Opening float cannot be negative', 'openingFloat');

    const figures = await dayFigures(req.companyScope.id, branch.id, businessDate);
    const variancePaise = countedCashPaise - openingFloatPaise - figures.expectedCash;

    // A variance nobody explained is the one an owner most needs explained,
    // and the moment to ask is now — while the person who counted is standing
    // at the till, not next week when the report is read.
    if (variancePaise !== 0 && !body.note) {
      throw badRequest(
        `The count is off by ${toRupees(Math.abs(variancePaise)).toFixed(2)} (${variancePaise > 0 ? 'over' : 'short'}). Add a note explaining it.`,
        'note',
      );
    }

    const close = await prisma.$transaction(async (tx) => {
      const existing = await tx.dayClose.findFirst({
        where: { branchId: branch.id, businessDate },
        orderBy: { closedAt: 'desc' },
      });
      if (existing && body.correctsId !== existing.id) {
        throw conflict(
          body.correctsId
            ? 'That closing is not the current one for this day — reload and try again'
            : 'This day is already closed. To change it, file a correction against the existing closing.',
        );
      }
      if (!existing && body.correctsId) throw conflict('There is no closing for this day to correct');

      return tx.dayClose.create({
        data: {
          companyId: req.companyScope.id,
          branchId: branch.id,
          businessDate,
          countedCashPaise,
          openingFloatPaise,
          expectedCashPaise: figures.expectedCash,
          cashSalesPaise: figures.cashSales,
          cashRefundsPaise: figures.cashRefunds,
          cardSalesPaise: figures.cardSales,
          upiSalesPaise: figures.upiSales,
          otherSalesPaise: figures.otherSales,
          gatewaySalesPaise: figures.gatewaySales,
          variancePaise,
          ordersBilled: figures.ordersBilled,
          note: body.note ?? null,
          closedById: req.user.id,
          supersededById: existing ? existing.id : null,
        },
        include: { closedBy: { select: { id: true, fullName: true } } },
      });
    });

    await audit(req, {
      action: 'DAY_CLOSE',
      entity: 'DayClose',
      entityId: close.id,
      companyId: req.companyScope.id,
      meta: {
        businessDate,
        branchId: branch.id,
        variance: String(toRupees(variancePaise)),
        corrects: close.supersededById,
      },
    });

    res.status(201).json({ close: publicClose(close), openOrders: figures.openOrders });
  }),
);

// Closing history. Only the current record per day by default — the
// superseded ones are still there and are returned when asked for, because a
// correction that hides what it corrected is not an audit trail.
router.get(
  '/day-close',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: dateSchema,
        to: dateSchema,
        branchId: z.string().optional(),
        includeSuperseded: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    if (query.from > query.to) throw badRequest('from must be on or before to', 'from');

    let branchId = null;
    if (isBranchPinned(req.user)) {
      branchId = req.user.branchId;
    } else if (query.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: query.branchId, companyId: req.companyScope.id },
      });
      if (!branch) throw notFound('Branch not found');
      branchId = branch.id;
    }

    const rows = await prisma.dayClose.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(branchId ? { branchId } : {}),
        businessDate: { gte: query.from, lte: query.to },
      },
      orderBy: [{ businessDate: 'desc' }, { closedAt: 'desc' }],
      include: { closedBy: { select: { id: true, fullName: true } }, correctedBy: { select: { id: true } } },
      take: 500,
    });

    // A row that something else corrects is superseded. Derived from the
    // relation rather than a flag, so it cannot fall out of step with it.
    const visible = query.includeSuperseded === 'true' ? rows : rows.filter((r) => !r.correctedBy);

    res.json({
      closes: visible.map((c) => ({ ...publicClose(c), superseded: Boolean(c.correctedBy) })),
      totals: {
        days: new Set(visible.map((c) => `${c.branchId}|${c.businessDate}`)).size,
        variance: toRupees(visible.reduce((a, c) => a + c.variancePaise, 0)),
        shortDays: visible.filter((c) => c.variancePaise < 0).length,
        overDays: visible.filter((c) => c.variancePaise > 0).length,
      },
    });
  }),
);

export default router;
