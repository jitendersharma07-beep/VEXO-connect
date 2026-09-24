// Lifecycle hooks (LANE providers).
//
// The single place the rest of the product touches this lane. Every existing
// route gains exactly ONE line — `await onOrderBilled(id)` — and nothing else:
// no imports of adapters, no knowledge of Tally or Reelo, no branch on whether an
// integration is configured. That is the whole design goal. A lane that spreads
// five call sites through orders.js is a lane that cannot be removed, and the
// integration must be removable, because most deployments will have none of it.
//
// THREE PROPERTIES EVERY HOOK HERE HAS.
//
// 1. It cannot fail the thing that called it. Each is wrapped so that a provider
//    outage, a missing mapping or a bug in this lane logs and returns. A bill
//    prints whether or not Tally is reachable; a refund settles whether or not
//    Reelo answers. An integration that can block a sale is worse than no
//    integration.
//
// 2. It is called AFTER the business transaction has committed, never inside it.
//    Enrolling this work in the till's transaction would hold a row lock open
//    across a queue write for no gain — the queue is durable and the sweeps below
//    are the backstop for a hook that never ran at all.
//
// 3. It is safe to call twice. Everything downstream keys on something stable —
//    the order id, the payment id, the refund id — so a double-fire produces one
//    voucher and one points award, enforced by a unique index rather than by this
//    file remembering anything.
//
// WHAT IS DELIBERATELY NOT HERE: anything that decides money. These hooks read
// what the POS already computed and hand it on. If a hook recalculated a total,
// there would be two answers to what the bill was.

import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { orderKitchenReady } from '../kitchen.js';
import { postOrder, postPayment, postRefund } from './accounting.js';
import { enqueueBillSync, enqueueReversal, billSyncKey } from './loyalty.js';
import { enqueue } from './queue.js';

const safely = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    // warn, not error: the business operation succeeded and this is the
    // notification about it. An error level here would page somebody for a
    // reconcilable condition that the sweeps clear on their own.
    logger.warn({ err, label }, 'integration hook did not complete');
    return null;
  }
};

const enabledConnection = (companyId, provider) =>
  prisma.integrationConnection.findFirst({
    where: { companyId, provider, enabled: true, credentialCiphertext: { not: null } },
  });

// --- loyalty ------------------------------------------------------------------

// Whose bill is this? Answered from the BILL_SYNC operation a cashier created by
// attaching a number at the till (routes/loyalty.js), because a POS order carries
// no customer of its own. Absent, the bill syncs nothing — which is correct for a
// walk-in, and is why this returns null rather than searching for a likely match.
const attachedCustomer = async (connection, orderId) => {
  const op = await prisma.loyaltyOperation.findUnique({
    where: {
      connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey: billSyncKey(orderId) },
    },
    include: { customer: true },
  });
  return op?.customer ?? null;
};

// --- aggregator ---------------------------------------------------------------

// Tell the provider what the kitchen did. Queued rather than called, because the
// cashier pressing READY must not wait on Zomato, and because a push that fails is
// a retry rather than a lost sale.
//
// Dedupe is on (order, kind), so a board that re-fires READY pushes once. The
// aggregator order's own state is NOT moved here: that column records what the
// PROVIDER said, and our telling them something is not them agreeing.
const pushAggregatorState = async (order, kind) => {
  const agg = await prisma.aggregatorOrder.findUnique({
    where: { orderId: order.id },
    include: { connection: true },
  });
  if (!agg?.connection?.enabled) return null;
  return enqueue(prisma, {
    companyId: agg.companyId,
    connectionId: agg.connectionId,
    kind,
    payload: { order_id: agg.externalOrderId, orderId: order.id, externalOrderId: agg.externalOrderId },
    dedupe: [kind, agg.externalOrderId],
  });
};

// --- the hooks ----------------------------------------------------------------

// A bill has been issued. Two consequences, independent of each other: it becomes
// a Tally sales voucher, and it is reported to the loyalty programme so the
// provider can award its own points. Neither is allowed to affect the other.
export const onOrderBilled = (orderId) =>
  safely('order billed', async () => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return null;

    const accounting = await postOrder(order);

    const reelo = await enabledConnection(order.companyId, 'REELO');
    let loyalty = { queued: false, reason: 'no loyalty connection' };
    if (reelo) {
      const customer = await attachedCustomer(reelo, order.id);
      loyalty = customer
        ? await enqueueBillSync(prisma, { connection: reelo, order, customer, source: 'POS' })
        : { queued: false, reason: 'no customer is attached to this bill' };
    }
    return { accounting, loyalty };
  });

// Money was taken. Only ever a Tally receipt — the loyalty programme is told about
// the BILL, not about how it was settled, because points are earned on what was
// spent and not on which tender paid for it.
export const onPaymentRecorded = (orderId, paymentId) =>
  safely('payment recorded', async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!order || !payment) return null;
    return postPayment(order, payment);
  });

// Money went back. A credit note in the books, and — only if the bill actually
// earned something — a sale return at the loyalty provider. enqueueReversal checks
// that for itself and refuses when there is nothing to take back, which is the
// difference between reversing an award and handing out a negative one.
export const onRefundSettled = (orderId, refundId) =>
  safely('refund settled', async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    const refund = await prisma.refund.findUnique({ where: { id: refundId } });
    if (!order || !refund) return null;

    const accounting = await postRefund(order, refund);

    const reelo = await enabledConnection(order.companyId, 'REELO');
    let loyalty = { queued: false, reason: 'no loyalty connection' };
    if (reelo) {
      const customer = await attachedCustomer(reelo, order.id);
      loyalty = customer
        ? await enqueueReversal(prisma, { connection: reelo, order, customer })
        : { queued: false, reason: 'no customer is attached to this bill' };
    }
    return { accounting, loyalty };
  });

// A bill was cancelled outright. The points it earned have to go back, and no
// accounting posting is made: a voided bill that never reached Tally needs no
// credit note, and one that did is corrected by the refund path above.
export const onOrderVoided = (orderId) =>
  safely('order voided', async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return null;
    const reelo = await enabledConnection(order.companyId, 'REELO');
    if (!reelo) return { queued: false, reason: 'no loyalty connection' };
    const customer = await attachedCustomer(reelo, order.id);
    if (!customer) return { queued: false, reason: 'no customer is attached to this bill' };
    return enqueueReversal(prisma, { connection: reelo, order, customer });
  });

// A kitchen line moved. Interesting only when it was the LAST line — an aggregator
// order is ready when every line is, and telling Zomato that the starter is
// plated brings a rider to the door for half an order.
//
// orderKitchenReady is the kitchen lane's own definition, imported rather than
// restated, so a change to what "ready" means does not leave this lane telling a
// provider something the board disagrees with.
export const onKitchenItemState = (kitchenItemId) =>
  safely('kitchen item state', async () => {
    const item = await prisma.kitchenItem.findUnique({ where: { id: kitchenItemId } });
    if (!item) return null;

    const order = await prisma.order.findUnique({
      where: { id: item.orderId },
      select: { id: true, channel: true, companyId: true },
    });
    if (order?.channel !== 'AGGREGATOR') return null;

    const siblings = await prisma.kitchenItem.findMany({
      where: { orderId: item.orderId },
      select: { state: true },
    });
    if (!orderKitchenReady(siblings)) return null;

    return pushAggregatorState(order, 'ZOMATO_ORDER_READY');
  });

// The rider has it. Called from wherever the POS records handover; kept separate
// from READY because they are different claims and a provider that hears them in
// the wrong order will believe the wrong one.
export const onAggregatorHandover = (orderId) =>
  safely('aggregator handover', async () => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, channel: true, companyId: true },
    });
    if (order?.channel !== 'AGGREGATOR') return null;
    return pushAggregatorState(order, 'ZOMATO_ORDER_PICKED_UP');
  });

// The backstop for a hook that never ran — a process killed between the commit
// and the call — is sweepUnposted in accounting.js, reached from the integrations
// screen. It asks the books' question ("which billed orders have no posting?")
// rather than the queue's, because a queue write that never happened leaves the
// queue with nothing to find.
