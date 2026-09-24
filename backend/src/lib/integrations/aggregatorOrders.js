// Aggregator order ingestion (LANE providers).
//
// Turns a provider callback into an AggregatorOrder row, and — when it is
// acceptable — into an ordinary POS Order that flows through the existing
// lifecycle: KOT, kitchen states, day close, reports. Reusing that lifecycle
// rather than building a parallel one is the whole point. An aggregator order
// that does not appear in the day's sales is a hole in the books.
//
// The four things that must never happen, and where each is prevented:
//
//   duplicate ORDER     — AggregatorOrder(connectionId, externalOrderId) unique,
//                         and AggregatorOrder.orderId unique. One provider order
//                         can produce at most one bill, enforced by the database
//                         and not by a check-then-insert.
//   duplicate KOT       — materialisation happens once, inside the transaction
//                         that claims the AggregatorOrder by setting orderId.
//                         A second attempt loses the unique constraint.
//   duplicate CALLBACK  — IntegrationEvent(connectionId, externalEventId) unique,
//                         handled in events.js before we get here.
//   out-of-order EVENT  — isStale() plus a closed backward state machine.
//
// And the thing that must never happen quietly: an order we cannot fully
// understand is HELD and made visible, never approximated. An unmapped outlet, an
// unmapped menu item or an unreadable total each stop materialisation and record
// a discrepancy. A wrong kitchen ticket costs more than a late one.

import { prisma } from '../prisma.js';
import { recomputeOrder, istDateOf } from '../orders.js';
import { routeKotItems } from '../kitchen.js';
import { toPaise } from '../money.js';
import { canTransition, isStale, recordDiscrepancy } from './events.js';

// Provider state → what it means for the POS order underneath.
const STATE_STAMP = Object.freeze({
  ACCEPTED: 'acceptedAt',
  REJECTED: 'rejectedAt',
  READY: 'readyAt',
  PICKED_UP: 'pickedUpAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
});

// --- outlet resolution -------------------------------------------------------

// Which of our branches does this provider outlet id mean? Answered from the
// operator's explicit mapping and nowhere else. No name matching, no "there is
// only one branch so it must be that one" — a guess here sends food to the wrong
// kitchen, and the IntegrationOutlet unique indexes exist in both directions
// precisely so the answer can never be ambiguous.
export const resolveOutlet = async (client, { connectionId, externalOutletId }) => {
  if (!externalOutletId) return null;
  return client.integrationOutlet.findUnique({
    where: { connectionId_externalOutletId: { connectionId, externalOutletId } },
  });
};

// --- upsert the aggregator order ---------------------------------------------

// Record what the provider said, verbatim, before deciding anything about it.
// Even an order for an outlet nobody has mapped gets a row: the operator's first
// symptom of a mapping mistake should be a visible held order, not a customer
// ringing to ask where their food is.
export const upsertAggregatorOrder = async (client, { companyId, connectionId, provider, envelope, outlet }) => {
  const money = envelope.money ?? {};
  const base = {
    provider,
    outletId: outlet?.id ?? null,
    branchId: outlet?.branchId ?? null,
    externalOrderDisplayId: envelope.externalOrderDisplayId ?? null,
    // Provider money is stored exactly as reported. Ours lives on the Order.
    // Two columns disagreeing is information; one column that has been reconciled
    // into agreement is a lost defect.
    grossAmount: money.grossAmount ?? null,
    providerDiscountAmount: money.providerDiscountAmount ?? null,
    restaurantDiscountAmount: money.restaurantDiscountAmount ?? null,
    commissionAmount: money.commissionAmount ?? null,
    taxAmount: money.taxAmount ?? null,
    deliveryFeeAmount: money.deliveryFeeAmount ?? null,
    packagingFeeAmount: money.packagingFeeAmount ?? null,
    netPayoutAmount: money.netPayoutAmount ?? null,
    paymentMode: envelope.paymentMode ?? null,
    normalised: envelope,
    placedAt: envelope.placedAt ?? null,
  };

  return client.aggregatorOrder.upsert({
    where: { connectionId_externalOrderId: { connectionId, externalOrderId: envelope.externalOrderId } },
    create: { companyId, connectionId, externalOrderId: envelope.externalOrderId, ...base },
    // On a repeat, the identity fields are NOT rewritten and neither is `state`
    // — state is only ever moved by applyState() through the state machine. An
    // upsert that reset state would let a redelivered "placed" un-cancel an
    // order, which is the exact bug the state machine exists to stop.
    update: {
      outletId: base.outletId,
      branchId: base.branchId,
      normalised: base.normalised,
    },
  });
};

// --- materialisation ---------------------------------------------------------

// Aggregators echo back the POS item reference we gave them when we pushed the
// menu — Zomato's order items carry pos_item_id for exactly this. So the mapping
// from a provider line to our catalog is our own product id, and there is no
// separate mapping table to drift. A line we cannot resolve means the menu at the
// provider is out of step with our catalog, which is a real condition the
// operator has to fix rather than something to paper over.
const resolveLines = async (client, companyId, items) => {
  const ids = [...new Set(items.map((i) => i.externalItemId).filter(Boolean))];
  const products = ids.length
    ? await client.product.findMany({
        where: { id: { in: ids }, companyId, status: 'ACTIVE' },
        include: { taxRate: true },
      })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const resolved = [];
  const unresolved = [];
  for (const item of items) {
    const product = item.externalItemId ? byId.get(item.externalItemId) : null;
    if (!product) {
      unresolved.push({ externalItemId: item.externalItemId, name: item.name, quantity: item.quantity });
      continue;
    }
    resolved.push({ item, product });
  }
  return { resolved, unresolved };
};

// Reasons an order is held rather than materialised. Each is a sentence an
// operator can act on, because the alternative is a support call that starts
// "it says error".
export const holdReasonFor = (aggOrder, envelope, unresolved) => {
  if (!aggOrder.branchId) {
    return `Outlet "${envelope.externalOutletId ?? 'unknown'}" is not mapped to a store. Map it on the integration screen, then retry this order.`;
  }
  if (unresolved.length > 0) {
    const names = unresolved.map((u) => u.name || u.externalItemId || 'unnamed item').slice(0, 5).join(', ');
    return `${unresolved.length} item(s) on this order are not in the catalogue: ${names}. Re-sync the menu, then retry.`;
  }
  if (envelope.unreadable?.length) {
    return `The provider's totals could not be read (${envelope.unreadable.join(', ')}). The order is recorded but not billed.`;
  }
  return null;
};

// Create the POS order. Called inside a transaction; the caller owns the
// transaction so that the Order, its items, its KOT and the AggregatorOrder.orderId
// claim all commit together or not at all.
export const materialise = async (tx, { companyId, connection, aggOrder, envelope, actorUserId }) => {
  const { resolved, unresolved } = await resolveLines(tx, companyId, envelope.items ?? []);
  const hold = holdReasonFor(aggOrder, envelope, unresolved);
  if (hold) return { held: true, reason: hold, unresolved };

  if (resolved.length === 0) {
    return { held: true, reason: 'The provider sent an order with no recognisable items.', unresolved };
  }

  const order = await tx.order.create({
    data: {
      companyId,
      branchId: aggOrder.branchId,
      // An aggregator order leaves the premises. TAKEAWAY is the existing type
      // that means that; `channel` carries the fact that a platform sent it, so
      // the Orders screen can tell a walk-in takeaway from a Zomato order without
      // a new OrderType and without touching the existing tax and reporting
      // paths that branch on type.
      type: 'TAKEAWAY',
      channel: 'AGGREGATOR',
      channelProvider: connection.provider,
      externalOrderId: aggOrder.externalOrderId,
      openedById: actorUserId,
      note: `${connection.provider} order ${aggOrder.externalOrderDisplayId ?? aggOrder.externalOrderId}`,
      items: {
        create: resolved.map(({ item, product }) => ({
          productId: product.id,
          name: product.name,
          // The AGGREGATOR's price, not ours. The customer has already paid the
          // platform the platform's price; charging our catalogue price here
          // would make the bill disagree with what was actually collected. Our
          // catalogue price is still visible — it is what a discrepancy compares
          // against. Falls back to the catalogue price only when the provider
          // sent no unit price at all.
          unitPrice: item.unitPrice != null ? String(item.unitPrice) : product.price,
          qty: item.quantity,
          taxRateName: product.taxRate?.name ?? null,
          taxRatePercent: product.taxRate?.percent ?? null,
        })),
      },
    },
    include: { items: true },
  });

  await recomputeOrder(tx, order.id);

  // Straight to the kitchen. An aggregator order is accepted business by the
  // time it reaches here — there is no "review the basket" step at a till that
  // nobody is standing at.
  const kot = await tx.kot.create({ data: { orderId: order.id, seq: 1 } });
  await tx.orderItem.updateMany({ where: { id: { in: order.items.map((i) => i.id) } }, data: { kotId: kot.id } });
  await routeKotItems(tx, {
    companyId,
    branchId: aggOrder.branchId,
    order,
    kot,
    items: order.items,
  });

  // The claim. Unique on AggregatorOrder.orderId, so if two callbacks race to
  // materialise the same provider order, exactly one commits and the other's
  // transaction fails on the constraint — which is what we want a duplicate
  // kitchen ticket to cost.
  await tx.aggregatorOrder.update({
    where: { id: aggOrder.id },
    data: { orderId: order.id },
  });

  const fresh = await tx.order.findUnique({ where: { id: order.id } });

  // Our total against theirs. Recorded, never corrected — this is the line the
  // user's constraint draws, and it is also just good sense: if our tax rules and
  // the platform's disagree by two rupees, somebody needs to know which is right,
  // and neither of us gets to decide that silently.
  if (aggOrder.grossAmount != null && fresh) {
    const theirs = toPaise(String(aggOrder.grossAmount));
    const ours = toPaise(String(fresh.total));
    if (theirs !== ours) {
      await recordDiscrepancy(tx, {
        companyId,
        connectionId: connection.id,
        kind: 'ORDER_TOTAL_MISMATCH',
        externalRef: aggOrder.externalOrderId,
        orderId: order.id,
        expectedAmount: aggOrder.grossAmount,
        observedAmount: fresh.total,
        detail: {
          note: 'Provider gross and POS total differ. Neither has been altered.',
          providerGross: String(aggOrder.grossAmount),
          posTotal: String(fresh.total),
        },
      });
    }
  }

  return { held: false, orderId: order.id, kotId: kot.id };
};

// --- state transitions -------------------------------------------------------

// Apply a provider state change. Refuses to go backwards, refuses to leave a
// terminal state, and refuses an event the order has already seen — each for a
// different reason, and each reported distinctly so a support conversation can
// tell "we ignored a duplicate" from "we ignored a contradiction".
export const applyState = async (client, { aggOrder, state, envelope }) => {
  if (!state) return { applied: false, reason: `unrecognised provider state "${envelope.rawState ?? ''}"` };
  if (isStale(aggOrder, envelope)) return { applied: false, reason: 'event is older than what this order has already seen' };
  if (!canTransition(aggOrder.state, state)) {
    return { applied: false, reason: `${aggOrder.state} -> ${state} is not a permitted transition` };
  }

  const stamp = STATE_STAMP[state];
  return {
    applied: true,
    order: await client.aggregatorOrder.update({
      where: { id: aggOrder.id },
      data: {
        state,
        ...(stamp ? { [stamp]: envelope.providerEventAt ?? new Date() } : {}),
        ...(state === 'CANCELLED' && envelope.cancelReason ? { cancelReason: envelope.cancelReason } : {}),
        lastSequence: envelope.providerSequence ?? aggOrder.lastSequence,
        lastEventAt: envelope.providerEventAt ?? new Date(),
      },
    }),
  };
};

// --- reconciliation ----------------------------------------------------------

// What the operator is shown for a day. Every number here is counted, not
// estimated, and the provider's totals are summed separately from ours rather
// than netted — a single "variance" figure hides whether it came from one order
// or a hundred.
export const reconcileDay = async ({ companyId, connectionId, isoDate }) => {
  const start = new Date(`${isoDate}T00:00:00.000+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const orders = await prisma.aggregatorOrder.findMany({
    where: { companyId, connectionId, placedAt: { gte: start, lt: end } },
    include: { order: { select: { total: true, status: true } } },
  });

  const sum = (pick) =>
    orders.reduce((acc, o) => {
      const v = pick(o);
      return v == null ? acc : acc + toPaise(String(v));
    }, 0);

  const mismatched = orders.filter(
    (o) => o.order && o.grossAmount != null && toPaise(String(o.grossAmount)) !== toPaise(String(o.order.total)),
  );

  return {
    date: isoDate,
    orderCount: orders.length,
    // Held orders are the headline, not a footnote: these are orders the
    // restaurant may have served and not billed.
    heldCount: orders.filter((o) => !o.orderId && !['CANCELLED', 'REJECTED'].includes(o.state)).length,
    cancelledCount: orders.filter((o) => o.state === 'CANCELLED').length,
    providerGrossPaise: sum((o) => o.grossAmount),
    providerCommissionPaise: sum((o) => o.commissionAmount),
    providerNetPayoutPaise: sum((o) => o.netPayoutAmount),
    posTotalPaise: sum((o) => o.order?.total),
    mismatchedOrderCount: mismatched.length,
    mismatchedExternalIds: mismatched.map((o) => o.externalOrderId).slice(0, 100),
    // Stated explicitly because it is the question this report will be asked to
    // answer and cannot: neither Zomato nor Swiggy publishes a settlement API on
    // the surface available to us, so payout reconciliation needs a labelled
    // statement import and is not derivable from these callbacks alone.
    settlementSource: 'NOT_AVAILABLE_FROM_PROVIDER_API',
  };
};

export const businessDateOf = (when) => istDateOf(when ?? new Date());
