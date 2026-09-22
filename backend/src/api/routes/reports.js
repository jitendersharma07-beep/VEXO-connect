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

// What happened on a day AFTER someone declared it closed.
//
// A closing is a snapshot taken at a moment; the business day runs to midnight
// IST regardless. So money taken between the count and midnight lands on a day
// that has already been reconciled, and the stored figures — which are frozen
// on purpose, and should be — quietly stop describing the day they name.
//
// The tempting fix is to refuse the write. That is the wrong instinct for a
// till: a cashier who cannot record the payment standing in front of them will
// take the cash anyway and not record it, and unrecorded cash is far worse than
// a stale report. So nothing here blocks anything. The closing is simply made
// to say when it stopped being true, which is the part that was missing.
//
// Derived by comparing timestamps against `closedAt`, so it needs no column, no
// migration, and no change to any write path — and it is correct for closings
// that were filed before this code existed.
//
// Takes all the closings at once and issues three queries for the lot. The
// history endpoint returns up to 500 rows, and per-row queries would be 1500.
const postCloseFor = async (companyId, closings) => {
  const byId = new Map();
  if (!closings.length) return byId;

  const dates = closings.map((c) => c.businessDate).sort();
  const fromUtc = istDayStartUtc(dates[0]);
  const toExcl = new Date(istDayStartUtc(dates[dates.length - 1]).getTime() + 86400e3);
  const window = { gte: fromUtc, lt: toExcl };
  const branchIds = [...new Set(closings.map((c) => c.branchId))];
  const orderScope = { companyId, branchId: { in: branchIds } };

  const [payments, refunds, billed] = await Promise.all([
    prisma.payment.findMany({
      where: { createdAt: window, order: orderScope },
      select: { createdAt: true, amount: true, method: true, channel: true, order: { select: { branchId: true } } },
    }),
    prisma.refund.findMany({
      where: { createdAt: window, status: 'SUCCEEDED', order: orderScope },
      select: { createdAt: true, amount: true, channel: true, order: { select: { branchId: true } } },
    }),
    prisma.order.findMany({
      where: { ...orderScope, billedAt: window },
      select: { billedAt: true, branchId: true },
    }),
  ]);

  // Bucket by the same (branch, IST day) key the closing is filed under, so a
  // payment at 23:55 counts against the evening it was taken.
  const bucket = new Map();
  const put = (branchId, at, kind, row) => {
    const key = `${branchId}|${istDateOf(at)}`;
    if (!bucket.has(key)) bucket.set(key, { payments: [], refunds: [], billed: [] });
    bucket.get(key)[kind].push(row);
  };
  for (const p of payments) put(p.order.branchId, p.createdAt, 'payments', p);
  for (const r of refunds) put(r.order.branchId, r.createdAt, 'refunds', r);
  for (const o of billed) put(o.branchId, o.billedAt, 'billed', o);

  for (const c of closings) {
    const b = bucket.get(`${c.branchId}|${c.businessDate}`);
    if (!b) continue;
    const after = (at) => at > c.closedAt;

    let cashPaise = 0;
    let nonCashPaise = 0;
    let latest = null;
    let paymentCount = 0;
    for (const p of b.payments) {
      if (!after(p.createdAt)) continue;
      paymentCount += 1;
      const amount = paiseOf(p.amount);
      // Same channel-before-method rule as dayFigures: a GATEWAY payment never
      // touched this drawer, whatever method it claims.
      if (p.channel === 'GATEWAY' || p.method !== 'CASH') nonCashPaise += amount;
      else cashPaise += amount;
      if (!latest || p.createdAt > latest) latest = p.createdAt;
    }

    let cashRefundsPaise = 0;
    let refundCount = 0;
    for (const r of b.refunds) {
      if (!after(r.createdAt)) continue;
      refundCount += 1;
      if (r.channel !== 'GATEWAY') cashRefundsPaise += paiseOf(r.amount);
      if (!latest || r.createdAt > latest) latest = r.createdAt;
    }

    let ordersBilled = 0;
    for (const o of b.billed) {
      if (!after(o.billedAt)) continue;
      ordersBilled += 1;
      if (!latest || o.billedAt > latest) latest = o.billedAt;
    }

    if (!paymentCount && !refundCount && !ordersBilled) continue;
    byId.set(c.id, {
      payments: paymentCount,
      refunds: refundCount,
      ordersBilled,
      // The one number a person acts on: how far the drawer is now from what
      // this closing said it should hold. Everything else is context for it.
      expectedCashDelta: toRupees(cashPaise - cashRefundsPaise),
      cashTaken: toRupees(cashPaise),
      cashRefunded: toRupees(cashRefundsPaise),
      nonCashTaken: toRupees(nonCashPaise),
      lastAt: latest,
    });
  }

  return byId;
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
      existingClose: existing
        ? { ...publicClose(existing), postClose: (await postCloseFor(req.companyScope.id, [existing])).get(existing.id) ?? null }
        : null,
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

    // Only for rows nothing has corrected. A superseded closing is already
    // flagged as replaced, and telling an owner that a record they can see has
    // been overtaken is noise twice over.
    const live = visible.filter((r) => !r.correctedBy);
    const post = await postCloseFor(req.companyScope.id, live);

    const closes = visible.map((c) => ({
      ...publicClose(c),
      superseded: Boolean(c.correctedBy),
      postClose: post.get(c.id) ?? null,
    }));

    res.json({
      closes,
      totals: {
        days: new Set(visible.map((c) => `${c.branchId}|${c.businessDate}`)).size,
        variance: toRupees(visible.reduce((a, c) => a + c.variancePaise, 0)),
        shortDays: visible.filter((c) => c.variancePaise < 0).length,
        overDays: visible.filter((c) => c.variancePaise > 0).length,
        // Counted separately from variance on purpose. A day with post-close
        // activity has a variance figure that no longer describes the drawer,
        // so rolling the two together would average a known number with a
        // stale one and report the result as if it were measured.
        staleDays: closes.filter((c) => c.postClose).length,
      },
    });
  }),
);

// Activity — who discounted, voided and refunded, and when.
//
// Everything below already existed in "PosAuditLog"; until this route there was
// simply nothing that read it. That gap was worse than an absent feature: the
// handover pack could truthfully say discounts are recorded against the person
// who applied them, which sounds like a control an owner can check, and no
// owner could check it. The only way to look was for ATC to run
// deploy/audit-queries.sql by hand.
//
// Scope is the money that moves without a sale behind it. Ordinary edits are
// left out deliberately — ORDER_ITEM_REMOVE can only touch a line that has not
// reached the kitchen, so nothing was cooked and nothing left the building.
const DISCOUNT_ACTIONS = ['ORDER_DISCOUNT_SET', 'ORDER_DISCOUNT_CLEAR', 'ORDER_ITEM_UPDATE'];
const VOID_ACTIONS = ['ORDER_VOID', 'ORDER_ITEM_VOID'];

// Refunds match on a PREFIX, never a list. One refund emits a different action
// per channel and per stage — ORDER_REFUND when it is manual, then
// ORDER_REFUND_REQUESTED / _SETTLED / _FAILED / _RECONCILED as a gateway refund
// progresses. deploy/audit-queries.sql enumerated them once and silently missed
// every gateway refund as a result. A prefix also picks up the next stage
// somebody adds without this file having to know about it.
const REFUND_PREFIX = 'ORDER_REFUND';

const kindOf = (row) => {
  if (row.action.startsWith(REFUND_PREFIX)) return 'refund';
  if (VOID_ACTIONS.includes(row.action)) return 'void';
  return 'discount';
};

// Only ever the fields named here. `meta` is written by six different call
// sites and passing it through whole would ship whatever a future one happens
// to put in it to a customer's browser.
const detailOf = (row) => {
  const m = row.meta ?? {};
  switch (true) {
    case row.action === 'ORDER_DISCOUNT_SET':
      return { discountType: m.type ?? null, value: m.value ?? null };
    case row.action === 'ORDER_ITEM_UPDATE':
      return { lineDiscount: m.lineDiscount ?? null };
    case row.action === 'ORDER_VOID':
      return { reason: m.reason ?? null, invoiceNumber: m.invoiceNumber ?? null };
    case row.action === 'ORDER_ITEM_VOID':
      return { item: m.name ?? null, reason: m.reason ?? null };
    case row.action.startsWith(REFUND_PREFIX):
      return {
        amount: m.amount ?? null,
        reason: m.reason ?? null,
        status: m.status ?? null,
        channel: m.channel ?? null,
        // Kept distinct on purpose: a refund a person asserted is not the same
        // fact as one a provider confirmed, and §10 of the owner guide turns on
        // that difference.
        providerConfirmed: m.providerConfirmed ?? null,
      };
    default:
      return {};
  }
};

// Above a café's plausible month. Hitting it is reported rather than hidden,
// because a silently shortened list is how an owner concludes a cashier did
// nothing unusual.
const ACTIVITY_CAP = 1000;

router.get(
  '/activity',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const query = z
      .object({ from: dateSchema, to: dateSchema, branchId: z.string().optional() })
      .parse(req.query);
    if (query.from > query.to) throw badRequest('from must be on or before to', 'from');

    const fromUtc = istDayStartUtc(query.from);
    const toExcl = new Date(istDayStartUtc(query.to).getTime() + 86400e3);

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

    const rows = await prisma.posAuditLog.findMany({
      where: {
        companyId: req.companyScope.id,
        at: { gte: fromUtc, lt: toExcl },
        OR: [
          { action: { in: [...DISCOUNT_ACTIONS, ...VOID_ACTIONS] } },
          { action: { startsWith: REFUND_PREFIX } },
        ],
      },
      orderBy: { at: 'desc' },
      take: ACTIVITY_CAP,
    });

    // ORDER_ITEM_UPDATE is also emitted for a plain quantity change, which is
    // not a discount and must not be counted as one. The two are told apart by
    // the key present in meta, because the route accepts exactly one of them.
    const relevant = rows.filter(
      (r) => r.action !== 'ORDER_ITEM_UPDATE' || r.meta?.lineDiscount !== undefined,
    );

    // "PosAuditLog" carries no branchId, so a branch is reached through the
    // order the row points at. This is the reason a BRANCH_MANAGER can be given
    // this screen at all; without it the only honest options were showing them
    // the whole company or refusing them outright.
    const orderIds = [...new Set(relevant.map((r) => r.entityId).filter(Boolean))];
    const orders = orderIds.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIds }, companyId: req.companyScope.id },
          select: { id: true, branchId: true, invoiceNumber: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // A row whose order cannot be resolved is dropped under a branch filter
    // rather than shown. Unresolvable means unattributable, and an event that
    // might belong to another branch is not one to put in front of a manager.
    const scoped = branchId
      ? relevant.filter((r) => orderById.get(r.entityId)?.branchId === branchId)
      : relevant;

    const actorIds = [...new Set(scoped.map((r) => r.actorId).filter(Boolean))];
    const users = actorIds.length
      ? await prisma.posUser.findMany({
          where: { id: { in: actorIds }, companyId: req.companyScope.id },
          select: { id: true, fullName: true, email: true, role: true, status: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const byActorMap = new Map();
    for (const r of scoped) {
      // Key on actorId, falling back to the email recorded at the time. A
      // deleted or renamed user must still be attributable — the audit row is
      // the record, not the current user table.
      const key = r.actorId ?? r.actorEmail ?? 'unknown';
      if (!byActorMap.has(key)) {
        const u = r.actorId ? userById.get(r.actorId) : null;
        byActorMap.set(key, {
          actorId: r.actorId ?? null,
          actorEmail: r.actorEmail ?? null,
          name: u?.fullName ?? null,
          role: u?.role ?? null,
          // The person may have left since. Saying so beside their name stops
          // an owner going to look for somebody who no longer works there.
          stillActive: u ? u.status === 'ACTIVE' : null,
          discounts: 0,
          voids: 0,
          refunds: 0,
          total: 0,
        });
      }
      const agg = byActorMap.get(key);
      agg[`${kindOf(r)}s`] += 1;
      agg.total += 1;
    }

    const byActor = [...byActorMap.values()].sort((a, b) => b.total - a.total);

    res.json({
      range: { from: query.from, to: query.to, branchId },
      byActor,
      events: scoped.map((r) => {
        const o = orderById.get(r.entityId);
        return {
          id: r.id,
          at: r.at,
          actorEmail: r.actorEmail,
          actorName: r.actorId ? (userById.get(r.actorId)?.fullName ?? null) : null,
          action: r.action,
          kind: kindOf(r),
          orderId: r.entityId,
          invoiceNumber: o?.invoiceNumber ?? null,
          detail: detailOf(r),
        };
      }),
      // Two separate honesty flags, because they mislead in different
      // directions. `truncated` says the window held more than was read.
      // `bestEffort` is permanent: audit() swallows its own write failures so a
      // customer's bill can never fail because of logging, which makes every
      // count here a floor and never a total.
      truncated: rows.length === ACTIVITY_CAP,
      cap: ACTIVITY_CAP,
      bestEffort: true,
    });
  }),
);

export default router;
