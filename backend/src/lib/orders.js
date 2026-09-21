// Order-domain helpers shared by the phase-2 routes: recompute-and-store of
// the §6 money math, the §4 serializers, the §9 receipt builder and IST day
// helpers. DB columns are DECIMAL(10,2) rupees; all arithmetic is integer
// paise via money.js, written back as exact 2dp strings.

import { toPaise, toRupees, pctToMilli, computeOrderTotals } from './money.js';

export const MANUAL_PAYMENT_LABEL = 'MANUAL PAYMENT RECORD — not gateway-verified';
export const GATEWAY_PAYMENT_LABEL = 'GATEWAY PAYMENT — confirmed by the provider';

// Printed on the customer's receipt, so it has to be true of the payment in
// front of it. Printing the manual label on a gateway-settled payment would
// tell the customer in writing that verified money was not verified.
export const paymentLabelFor = (channel) =>
  channel === 'GATEWAY' ? GATEWAY_PAYMENT_LABEL : MANUAL_PAYMENT_LABEL;

// The same rule for refunds, where getting it wrong is worse: telling a
// customer their money is back when the provider has not sent it is the one
// statement this system must never make.
export const refundLabelFor = (r) => {
  if (r.channel !== 'GATEWAY') return 'REFUND HANDED BACK — recorded by staff';
  if (r.status === 'SUCCEEDED') return 'REFUND PAID OUT — confirmed by the provider';
  if (r.status === 'FAILED') return 'REFUND FAILED — the provider did not pay this out';
  // Sent, but the provider never answered. Saying "requested" here would claim
  // more than is known, and the customer may in fact already have the money.
  if (!r.providerRef) return 'REFUND SENT — awaiting confirmation from the provider';
  return 'REFUND REQUESTED — not yet paid out by the provider';
};

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const istDayStartUtc = (yyyyMmDd) => new Date(`${yyyyMmDd}T00:00:00.000+05:30`);
export const istDateOf = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export const num = (d) => (d === null || d === undefined ? null : Number(d));
export const paiseOf = (d) => toPaise(String(d));
const r2 = (paise) => (paise / 100).toFixed(2);

// Recomputes every stored money field of an order from its ACTIVE lines and
// persists them, inside the caller's transaction. VOIDED lines keep their own
// historical lineSubtotal but leave every order total.
export const recomputeOrder = async (tx, orderId) => {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  const active = order.items.filter((i) => i.status === 'ACTIVE');
  const lines = active.map((i) => ({
    unitPrice: paiseOf(i.unitPrice),
    qty: i.qty,
    lineDiscount: paiseOf(i.lineDiscount),
    taxPctMilli: i.taxRatePercent === null ? 0 : pctToMilli(String(i.taxRatePercent)),
  }));
  let discount = null;
  if (order.discountType) {
    const sub = lines.reduce((a, l) => a + l.unitPrice * l.qty - l.lineDiscount, 0);
    discount =
      order.discountType === 'FLAT'
        ? // Clamp: deleting/voiding lines may shrink the subtotal below a FLAT
          // discount that was valid when it was set.
          { type: 'FLAT', value: Math.min(paiseOf(order.discountValue), sub) }
        : { type: 'PERCENT', value: pctToMilli(String(order.discountValue)) };
  }
  const r = computeOrderTotals(lines, discount);
  for (let k = 0; k < active.length; k += 1) {
    const l = r.lines[k];
    await tx.orderItem.update({
      where: { id: active[k].id },
      data: {
        lineSubtotal: r2(l.lineSubtotal),
        discountShare: r2(l.discountShare),
        lineTax: r2(l.lineTax),
        lineTotal: r2(l.lineTotal),
      },
    });
  }
  for (const v of order.items) {
    if (v.status !== 'VOIDED') continue;
    await tx.orderItem.update({
      where: { id: v.id },
      data: { discountShare: 0, lineTax: 0, lineTotal: 0 },
    });
  }
  return tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: r2(r.subtotal),
      discountAmount: r2(r.discountAmount),
      taxAmount: r2(r.taxAmount),
      total: r2(r.total),
    },
  });
};

export const ORDER_INCLUDE = {
  branch: { select: { id: true, name: true, code: true } },
  table: { select: { id: true, name: true } },
  openedBy: { select: { id: true, fullName: true } },
  items: {
    include: { kot: { select: { seq: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  payments: {
    include: { receivedBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
  },
  refunds: {
    include: { by: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
  },
};

export const SUMMARY_INCLUDE = {
  table: { select: { name: true } },
  openedBy: { select: { fullName: true } },
  payments: { select: { amount: true } },
  _count: { select: { items: { where: { status: 'ACTIVE' } } } },
};

const publicItem = (i) => ({
  id: i.id,
  productId: i.productId,
  variantId: i.variantId,
  name: i.name,
  unitPrice: num(i.unitPrice),
  qty: i.qty,
  lineDiscount: num(i.lineDiscount),
  lineSubtotal: num(i.lineSubtotal),
  taxRate: i.taxRateName ? { name: i.taxRateName, percent: num(i.taxRatePercent) } : null,
  lineTax: num(i.lineTax),
  lineTotal: num(i.lineTotal),
  kotSeq: i.kot?.seq ?? null,
  status: i.status,
  voidReason: i.voidReason,
});

export const publicPayment = (p) => ({
  id: p.id,
  method: p.method,
  channel: p.channel,
  amount: num(p.amount),
  tendered: p.tendered === null ? null : num(p.tendered),
  changeDue: p.tendered === null ? null : toRupees(paiseOf(p.tendered) - paiseOf(p.amount)),
  note: p.note,
  // Which attempt this payment settled, so a screen watching for its own
  // intent can tell that the webhook landed. Null on manual records, which
  // settle no attempt. The provider's charge reference stays server-side —
  // the refund route is its only reader.
  intentId: p.intentId ?? null,
  receivedBy: p.receivedBy ? { id: p.receivedBy.id, fullName: p.receivedBy.fullName } : null,
  createdAt: p.createdAt,
});

// idempotencyKey is deliberately absent: it is the token that makes a retried
// create return the first attempt, so it stays between us and the provider.
export const publicIntent = (i) => ({
  id: i.id,
  orderId: i.orderId,
  provider: i.provider,
  providerRef: i.providerRef,
  amount: num(i.amount),
  currency: i.currency,
  status: i.status,
  failureReason: i.failureReason,
  createdAt: i.createdAt,
  closedAt: i.closedAt,
});

export const publicRefund = (r) => ({
  id: r.id,
  amount: num(r.amount),
  reason: r.reason,
  channel: r.channel,
  status: r.status,
  failureReason: r.failureReason,
  // Whether the provider acknowledged the request at all. A PENDING refund
  // that is not acknowledged is in an unknown state, not a queued one, and
  // the two must not read alike on screen.
  providerConfirmed: r.channel === 'GATEWAY' ? Boolean(r.providerRef) : null,
  label: refundLabelFor(r),
  by: r.by ? { id: r.by.id, fullName: r.by.fullName } : null,
  createdAt: r.createdAt,
  settledAt: r.settledAt ?? null,
});

// Two different sums, and confusing them is how a gateway refund would be
// reported as money returned before the provider moved any.
//
//   settled  — the provider paid it out, or a person handed the cash back.
//              This is the only figure that may be shown as "refunded".
//   reserved — settled plus still-pending requests. This is the figure the
//              cap is checked against, so the same money cannot be requested
//              back twice while the first request is in flight.
export const settledRefundPaise = (refunds) =>
  refunds.filter((r) => r.status === 'SUCCEEDED').reduce((a, r) => a + paiseOf(r.amount), 0);

export const reservedRefundPaise = (refunds) =>
  refunds
    .filter((r) => r.status === 'SUCCEEDED' || r.status === 'PENDING')
    .reduce((a, r) => a + paiseOf(r.amount), 0);

const holdsMoney = (r) => r.status === 'SUCCEEDED' || r.status === 'PENDING';

// A refund has to come back out of the leg that took the money in. Provider-
// collected money can only be returned by the provider, and cash can only be
// handed back from the till, so an order paid in two parts has two separate
// pools — each capped by what that part actually collected. Netting them into
// one figure is how a ₹500 refund gets sent against a ₹250 charge.
//
// Every gateway payment is its own leg, keyed by intent, because two intents
// on one order are two distinct charges the provider knows separately.
export const refundLegs = (order) => {
  const held = (pred) =>
    order.refunds.filter((r) => holdsMoney(r) && pred(r)).reduce((a, r) => a + paiseOf(r.amount), 0);

  const gateway = order.payments
    .filter((p) => p.channel === 'GATEWAY' && p.intentId && p.intent?.providerRef)
    .map((p) => ({
      channel: 'GATEWAY',
      intentId: p.intentId,
      intentProviderRef: p.intent.providerRef,
      // The provider's id for the charge itself. Razorpay refunds post to it
      // and cannot use the attempt's id; null means this payment predates the
      // column, and the adapter refuses rather than guessing a reference.
      chargeProviderRef: p.providerRef ?? null,
      available: paiseOf(p.amount) - held((r) => r.intentId === p.intentId),
    }));

  const manualCollected = order.payments
    .filter((p) => p.channel !== 'GATEWAY')
    .reduce((a, p) => a + paiseOf(p.amount), 0);

  const manual = {
    channel: 'MANUAL',
    intentId: null,
    intentProviderRef: null,
    chargeProviderRef: null,
    available: manualCollected - held((r) => r.channel === 'MANUAL'),
  };

  return { gateway, manual };
};

// Provider money first: it is the leg that cannot be settled across the
// counter, so leaving it for last would strand it. Returns null when no single
// leg can cover the amount — the caller must refuse rather than split the
// request across legs on the customer's behalf.
export const pickRefundLeg = (legs, amountPaise) =>
  legs.gateway.find((l) => l.available >= amountPaise) ??
  (legs.manual.available >= amountPaise ? legs.manual : null);

export const largestRefundablePaise = (legs) =>
  Math.max(0, legs.manual.available, ...legs.gateway.map((l) => l.available));

// Reserved here, never confirmed by the provider. The request may already be
// paying out, so it keeps holding its amount and must be reconciled with its
// original idempotency key rather than raised again.
export const isUnconfirmedGatewayRefund = (r) =>
  r.channel === 'GATEWAY' && r.status === 'PENDING' && !r.providerRef;

export const serializeOrder = (o) => {
  const collected = o.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
  const refunded = settledRefundPaise(o.refunds);
  const refundPending = reservedRefundPaise(o.refunds) - refunded;
  const total = paiseOf(o.total);
  return {
    id: o.id,
    branchId: o.branchId,
    branch: o.branch,
    type: o.type,
    status: o.status,
    table: o.table ?? null,
    invoiceNumber: o.invoiceNumber,
    items: o.items.map(publicItem),
    discount: o.discountType
      ? { type: o.discountType, value: num(o.discountValue), amount: num(o.discountAmount) }
      : null,
    subtotal: num(o.subtotal),
    discountAmount: num(o.discountAmount),
    taxAmount: num(o.taxAmount),
    total: num(o.total),
    payments: o.payments.map(publicPayment),
    refunds: o.refunds.map(publicRefund),
    amountPaid: toRupees(collected),
    amountDue: o.status === 'VOID' ? 0 : toRupees(Math.max(0, total - collected)),
    amountRefunded: toRupees(refunded),
    // Requested from the provider and not yet paid out. Kept apart from
    // amountRefunded so no screen can add the two together by accident.
    amountRefundPending: toRupees(refundPending),
    openedBy: o.openedBy,
    note: o.note,
    createdAt: o.createdAt,
    billedAt: o.billedAt,
    closedAt: o.closedAt,
  };
};

export const serializeOrderSummary = (o) => ({
  id: o.id,
  invoiceNumber: o.invoiceNumber,
  type: o.type,
  status: o.status,
  branchId: o.branchId,
  tableName: o.table?.name ?? null,
  itemCount: o._count.items,
  total: num(o.total),
  amountPaid: toRupees(o.payments.reduce((a, p) => a + paiseOf(p.amount), 0)),
  openedBy: o.openedBy.fullName,
  createdAt: o.createdAt,
  billedAt: o.billedAt,
});

// o must be loaded with ORDER_INCLUDE; company/branch carry name+address.
export const buildReceipt = (company, branch, o) => {
  const activeItems = o.items.filter((i) => i.status === 'ACTIVE');
  const breakup = new Map();
  for (const i of activeItems) {
    if (!i.taxRateName) continue;
    const key = `${i.taxRateName}|${num(i.taxRatePercent)}`;
    const cur = breakup.get(key) || {
      name: i.taxRateName,
      percent: num(i.taxRatePercent),
      taxable: 0,
      tax: 0,
    };
    cur.taxable += paiseOf(i.lineSubtotal) - paiseOf(i.discountShare);
    cur.tax += paiseOf(i.lineTax);
    breakup.set(key, cur);
  }
  const collected = o.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
  const total = paiseOf(o.total);
  return {
    invoiceNumber: o.invoiceNumber,
    isDemo: Boolean(company.isDemo || branch.isDemo),
    company: { name: company.name },
    branch: {
      name: branch.name,
      code: branch.code,
      addressLine: branch.addressLine,
      city: branch.city,
    },
    order: {
      id: o.id,
      type: o.type,
      tableName: o.table?.name ?? null,
      billedAt: o.billedAt,
      cashier: o.openedBy.fullName,
    },
    items: activeItems.map((i) => ({
      name: i.name,
      qty: i.qty,
      unitPrice: num(i.unitPrice),
      lineDiscount: num(i.lineDiscount),
      amount: num(i.lineSubtotal),
    })),
    subtotal: num(o.subtotal),
    discountAmount: num(o.discountAmount),
    taxBreakup: [...breakup.values()].map((b) => ({
      name: b.name,
      percent: b.percent,
      taxable: toRupees(b.taxable),
      tax: toRupees(b.tax),
    })),
    total: num(o.total),
    payments: o.payments.map((p) => ({
      method: p.method,
      channel: p.channel,
      amount: num(p.amount),
      tendered: p.tendered === null ? null : num(p.tendered),
      changeDue: p.tendered === null ? null : toRupees(paiseOf(p.tendered) - paiseOf(p.amount)),
      label: paymentLabelFor(p.channel),
    })),
    amountPaid: toRupees(collected),
    amountDue: toRupees(Math.max(0, total - collected)),
    // A pending gateway refund is printed as REQUESTED, never as a refund.
    // The customer is holding this paper as evidence of what happened to their
    // money, so it must not say returned when nothing has been returned yet.
    refunds: o.refunds
      .filter((r) => r.status !== 'FAILED')
      .map((r) => ({
        amount: num(r.amount),
        reason: r.reason,
        status: r.status,
        channel: r.channel,
        label: refundLabelFor(r),
        createdAt: r.createdAt,
      })),
  };
};
