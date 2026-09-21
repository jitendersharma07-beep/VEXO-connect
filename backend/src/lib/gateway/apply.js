// Applies one signature-verified provider event to its intent and order.
//
// Runs inside the caller's transaction, alongside the GatewayWebhookEvent
// insert, so a crash can never leave an event recorded-but-unapplied: either
// both land or neither does, and the provider's retry redoes both.
//
// Every refusal returns a skippedReason rather than throwing. The delivery
// was genuine, so the provider is told 200 and stops retrying; the reason is
// stored on the event row and surfaced by the reconciliation report. A
// discrepancy a human must judge is not an error the provider can fix.

import { paiseOf } from '../orders.js';

export const EVENT_SUCCEEDED = 'payment.succeeded';
export const EVENT_FAILED = 'payment.failed';
export const EVENT_REFUND_SUCCEEDED = 'refund.succeeded';
export const EVENT_REFUND_FAILED = 'refund.failed';

const REFUND_EVENTS = new Set([EVENT_REFUND_SUCCEEDED, EVENT_REFUND_FAILED]);

// The provider may name the instrument it charged. Anything we do not
// recognise is recorded as OTHER rather than guessed at, because this feeds
// the sales report's payment-method breakdown.
const KNOWN_METHODS = new Set(['CARD', 'UPI', 'OTHER']);
const normaliseMethod = (method) => (KNOWN_METHODS.has(method) ? method : 'OTHER');

// A refund event's providerRef names the REFUND, not the original payment.
// Until one of these arrives the refund is a request and nothing has moved, so
// this is the only place a refund may be marked paid out.
const applyRefundEvent = async (tx, { providerRef, kind, amountPaise }) => {
  const refund = await tx.refund.findUnique({
    where: { providerRef },
    include: { order: { select: { id: true, companyId: true, branchId: true, status: true } } },
  });
  if (!refund) return { skippedReason: 'no refund matches this provider reference' };
  const base = { intentId: refund.intentId ?? null, refundId: refund.id };

  if (refund.status !== 'PENDING') {
    return { ...base, skippedReason: `refund already ${refund.status.toLowerCase()}` };
  }
  // Never settle for an amount we did not request. Accepting the provider's
  // figure would silently alter what the customer got back.
  if (amountPaise !== paiseOf(refund.amount)) {
    return { ...base, skippedReason: 'refunded amount does not match the request' };
  }

  if (kind === EVENT_REFUND_FAILED) {
    await tx.refund.update({
      where: { id: refund.id },
      data: {
        status: 'FAILED',
        failureReason: 'provider reported the refund failed',
        settledAt: new Date(),
      },
    });
    return { ...base, refundFailed: true, orderId: refund.order.id,
             companyId: refund.order.companyId, branchId: refund.order.branchId };
  }

  await tx.refund.update({
    where: { id: refund.id },
    data: { status: 'SUCCEEDED', settledAt: new Date() },
  });

  // Now, and only now, may the order be unwound: the money is actually back.
  const order = await tx.order.findUnique({
    where: { id: refund.orderId },
    include: {
      payments: { select: { amount: true } },
      refunds: { select: { amount: true, status: true } },
    },
  });
  const collected = order.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
  const settled = order.refunds
    .filter((r) => r.status === 'SUCCEEDED')
    .reduce((a, r) => a + paiseOf(r.amount), 0);
  if (order.status === 'PAID' && settled === collected) {
    await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
  }
  return { ...base, refundSettled: true, orderId: order.id,
           companyId: order.companyId, branchId: order.branchId };
};

export const applyGatewayEvent = async (tx, { provider, providerRef, kind, amountPaise, method }) => {
  if (REFUND_EVENTS.has(kind)) {
    return applyRefundEvent(tx, { providerRef, kind, amountPaise });
  }

  const intent = await tx.paymentIntent.findUnique({
    where: { provider_providerRef: { provider, providerRef } },
  });
  if (!intent) return { skippedReason: 'no intent matches this provider reference' };

  if (kind === EVENT_FAILED) {
    if (intent.status === 'SUCCEEDED') {
      return { intentId: intent.id, skippedReason: 'intent already settled; failure ignored' };
    }
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'FAILED', failureReason: 'provider reported the payment failed', closedAt: new Date() },
    });
    return { intentId: intent.id, intentFailed: true };
  }

  if (kind !== EVENT_SUCCEEDED) {
    return { intentId: intent.id, skippedReason: `unhandled event type "${kind}"` };
  }

  if (intent.status === 'SUCCEEDED') {
    return { intentId: intent.id, skippedReason: 'intent already settled' };
  }

  // Never settle for an amount we did not ask for. Recording the intent's
  // figure would falsely close the order; recording the provider's would
  // silently accept an under-payment. Change nothing, assert nothing, and let
  // reconciliation put it in front of a human.
  const expected = paiseOf(intent.amount);
  if (amountPaise !== expected) {
    return { intentId: intent.id, skippedReason: 'settled amount does not match the intent' };
  }

  const order = await tx.order.findUnique({
    where: { id: intent.orderId },
    include: { payments: { select: { amount: true } } },
  });
  if (!order) return { intentId: intent.id, skippedReason: 'order no longer exists' };
  if (order.status !== 'BILLED') {
    return { intentId: intent.id, skippedReason: `order is ${order.status}, not BILLED` };
  }

  const total = paiseOf(order.total);
  const collected = order.payments.reduce((a, p) => a + paiseOf(p.amount), 0);
  const due = total - collected;
  if (due <= 0) return { intentId: intent.id, skippedReason: 'order has no amount due' };
  if (amountPaise > due) {
    return { intentId: intent.id, skippedReason: 'settled amount exceeds the amount due' };
  }

  const payment = await tx.payment.create({
    data: {
      orderId: order.id,
      method: normaliseMethod(method),
      channel: 'GATEWAY',
      amount: (amountPaise / 100).toFixed(2),
      // No tendered and no receiver: the provider settled this, so there was
      // no cash in a drawer and no member of staff to attribute it to.
      tendered: null,
      receivedById: null,
      intentId: intent.id,
    },
  });

  await tx.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'SUCCEEDED', closedAt: new Date() },
  });

  if (collected + amountPaise >= total) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'PAID', closedAt: new Date() },
    });
  }

  return {
    intentId: intent.id,
    orderId: order.id,
    companyId: order.companyId,
    branchId: order.branchId,
    payment,
  };
};
