// Split bill — turning one cheque into several. LANE tables; spec §B "Tables
// (Pro): ... transfer/merge table, split bill", the split half.
//
// UNLIKE service.js AND transfer.js, THIS FILE MOVES MONEY, and that is the
// only reason it is difficult. It still does not *evaluate* money:
// recomputeOrder() in lib/orders.js decides every total, here as everywhere,
// and this file's job is to move lines and then ask it twice. What this file
// adds is a guarantee that the two answers add up to the one answer that was
// true before — asserted below, inside the transaction, so a split that would
// lose a paise rolls back instead of printing.
//
// WHY A SPLIT DOES NOT NEED A NEW OrderStatus. Merge is blocked because it
// empties a bill, and an emptied bill needs a terminal status that OrderStatus
// does not have (see WINDOW-1-HANDOFF-TABLES §6.1). A split empties nothing:
// the original order KEEPS ITS ID and becomes the first cheque, and the other
// cheques are new orders. Nothing reaches a terminal state. Keeping the
// original id is also independently right — payments, KOTs, audit rows and
// PaymentIntents already pointing at that order all still resolve afterwards.
//
// WHY A DISCOUNTED BILL IS REFUSED RATHER THAN APPORTIONED. Measured, not
// assumed, against the real computeOrderTotals over 4000 randomised baskets per
// policy (the probe is pure arithmetic and needs no database):
//
//   no order-level discount, any policy ......  0/4000 wrong   — EXACT
//   copy a FLAT discount to both cheques .... 4000/4000 wrong  — worst −₹10,016
//   keep the discount on the first cheque ... 3980/4000 wrong  — worst +₹34,055
//   apportion the whole's final shares ......   ~40/4000 wrong — worst ±1 paise
//
// Copying a FLAT discount gives the money away twice; in the worst basket the
// two cheques summed to ZERO against an ₹8,414 bill. Keeping it on the first
// cheque overcharges instead, because recomputeOrder clamps FLAT to
// min(value, subtotal) and the shrunken cheque can no longer absorb it. Even
// the best policy leaves ±1 paise, because distributeProportional is exact
// only within one order and a shifted paise drags per-line GST with it.
//
// A requirement that says "to the paisa" is therefore met by REFUSING the
// cases that cannot meet it, not by redefining it as "within a paise". Same
// move as refusing to transfer a BILLED party, and for the same reason: the
// alternative is a till that does not balance and nobody knowing why.
//
// WHAT STAYS BEHIND, and the principle behind it:
//
//   MOVES   OrderItem.orderId              the line, and therefore the money
//   MOVES   KitchenItem.orderId            denormalised, would go stale
//   STAYS   OrderItem.kotId                the ticket the kitchen really cooked
//   STAYS   Order.pax                       the party's covers, counted once
//   COPIES  Order.waiterId                  the server really did sell both
//
// History stays where it happened; only live attribution moves. That is the
// same rule transfer.js applies when it leaves the QR card glued to the table.

import { badRequest, conflict } from '../errors.js';
import { paiseOf, recomputeOrder } from '../orders.js';
import { nextChangeSeq } from '../kitchen.js';

/**
 * Loads the bill and refuses every shape that cannot be split exactly.
 *
 * Called with the order row already LOCKED (see splitBill). Each refusal is a
 * sentence a floor screen can show, and each one exists because the alternative
 * is silently wrong rather than merely awkward.
 */
export const assertSplittable = async (tx, { orderId, itemIds }) => {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, companyId: true, branchId: true, status: true, type: true,
      tableId: true, visitId: true, source: true, channel: true,
      waiterId: true, waiterSetAt: true, waiterSetById: true,
      discountType: true, pax: true, total: true,
      items: {
        select: { id: true, status: true, kotId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!order) throw conflict('That bill no longer exists');

  // OPEN only. A BILLED cheque has been printed with its lines on it, and a
  // PAID one has been settled against a total that splitting would change —
  // the same printed-paper argument assertServiceEditable and assertTransferable
  // both make, so it has to be the same answer here too.
  if (order.status !== 'OPEN') {
    throw conflict(
      `This bill is already ${order.status.toLowerCase()} and can no longer be split`,
    );
  }

  // A part-settled bill has no unambiguous division: the money already taken
  // belongs to no particular cheque, and guessing would put a customer's
  // payment against food they did not order.
  const paid = await tx.payment.count({ where: { orderId: order.id } });
  if (paid > 0) {
    throw conflict('Money has already been taken against this bill; it can no longer be split');
  }

  // See the header. This is the refusal that keeps "to the paisa" literally
  // true, and the message has to tell staff what to actually do instead.
  if (order.discountType) {
    throw conflict(
      'Remove the discount before splitting this bill, then apply it to each cheque. ' +
        'A discount cannot be divided across cheques without changing the total.',
    );
  }

  // Promotions are a promise, not a rounding problem. reevaluatePromotions()
  // re-runs on every money change, so a "spend ₹500 get ₹50 off" benefit the
  // guest has already earned would be REVERSED against both smaller cheques and
  // Promotion.redemptionCount decremented on the way out. Splitting would take
  // back something already given.
  const applied = await tx.promotionRedemption.count({
    where: { orderId: order.id, status: 'APPLIED' },
  });
  if (applied > 0) {
    throw conflict(
      'This bill has an offer applied to the whole basket and cannot be split. ' +
        'Remove the offer first, then split, then re-apply it per cheque.',
    );
  }

  // An aggregator bill is not a cheque at a table, and splitting one breaks a
  // structure rather than merely a convention. AggregatorOrder.orderId is
  // `String? @unique`, so the second cheque could never carry a provider record;
  // Order.channelProvider and .externalOrderId are written in ONE place
  // (lib/integrations/aggregatorOrders.js) together with channel, so copying
  // channel alone would leave an AGGREGATOR cheque whose provider is null —
  // lib/integrations/accounting.js interpolates that field straight into a Tally
  // narration and would post "null order". Copying it instead would be worse: two
  // bills would claim to be the same Swiggy order.
  //
  // This costs the dine-in path nothing. channel is @default(POS) and nothing
  // else in src/ ever sets it, so QR, phone, till, dine-in and takeaway bills are
  // all POS and all still splittable.
  if (order.channel !== 'POS') {
    throw conflict('An online or aggregator order is settled by the provider and cannot be split');
  }

  const active = order.items.filter((i) => i.status === 'ACTIVE');
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw badRequest('Choose the lines to move to the new cheque', 'itemIds');
  }
  const wanted = new Set(itemIds);
  if (wanted.size !== itemIds.length) {
    throw badRequest('The same line was listed twice', 'itemIds');
  }
  const activeIds = new Set(active.map((i) => i.id));
  for (const id of wanted) {
    // One message for "not on this bill", "already voided" and "does not
    // exist", so a caller cannot use the difference to enumerate other bills'
    // line ids — the same reasoning loadTableInScope and resolveDestination use.
    if (!activeIds.has(id)) throw badRequest('That line is not on this bill', 'itemIds');
  }
  // A split that moves EVERY line is not a split: it leaves an empty original
  // behind, which is exactly the emptied-bill problem that blocks merge, and it
  // would need the terminal status OrderStatus does not have. Refused here so
  // split never backs into merge's blocker by accident.
  if (wanted.size === active.length) {
    throw badRequest(
      'Leave at least one line on the original cheque — moving everything is not a split',
      'itemIds',
    );
  }

  return { order, moving: active.filter((i) => wanted.has(i.id)) };
};

/**
 * Builds the new cheque's columns from the original's.
 *
 * Exported for its own sake: which columns a split copies is a policy, and a
 * policy that lives in a named function can be read and argued with instead of
 * being buried in an object literal.
 */
export const chequeFrom = (order, actorId) => ({
  companyId: order.companyId,
  branchId: order.branchId,
  type: order.type,
  status: 'OPEN',
  // Same party, same furniture, same visit. A split does not move anybody, so
  // all three carry unchanged — and sharing visitId is how the system already
  // models one party holding several bills (see transfer.js partyAt).
  tableId: order.tableId,
  visitId: order.visitId,
  source: order.source,
  channel: order.channel,
  // The server served the whole party and really did sell both cheques, so
  // waiter attribution copies. Order has @@index([companyId, waiterId,
  // billedAt]) precisely so sales-per-waiter can be asked, and that number is
  // right only if both cheques carry them.
  waiterId: order.waiterId,
  waiterSetAt: order.waiterSetAt,
  waiterSetById: order.waiterSetById,
  // pax deliberately NOT copied. Covers belong to the party, not to each
  // cheque: copying 4 onto both halves would report 8 people at a table of 4
  // the first time anything SUMs it, and splitting it 2/2 would invent a fact
  // nobody observed. Leaving it on the original keeps SUM(pax) correct at 4.
  pax: null,
  // Whoever pressed split opened this cheque. The original's opener stays on
  // the original.
  openedById: actorId,
  // invoiceNumber stays NULL — it is allocated at billing, and @@unique([
  // companyId, invoiceNumber]) would refuse a copy anyway. terminalId and
  // deviceId stay null too: no till rang this cheque up, a split created it,
  // and a payment taken on it will carry its own terminal.
});

/**
 * Splits the bill. Call inside a transaction, with `order` already resolved
 * through the caller's scope by the route.
 *
 * LOCK ORDER: the order row first, then KitchenCursor via nextChangeSeq(). That
 * direction matters — nextChangeSeq holds its row lock to commit, so a writer
 * that took the cursor before the order would invert the pair against every
 * other kitchen writer. lib/kitchen.js takes the cursor last; so does this.
 */
export const splitBill = async (tx, { orderId, itemIds, actorId }) => {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

  // Everything is read and checked AFTER the lock. There is deliberately no
  // pre-lock read to re-check against: unlike a transfer, nothing here needs a
  // scope decision made from an unlocked row, so the simplest correct thing is
  // to look exactly once, under the lock.
  const { order, moving } = await assertSplittable(tx, { orderId, itemIds });

  // The number the whole split has to add up to, captured before anything
  // moves. Read from the stored total rather than recomputed, because the
  // stored total is what the guest has been quoted and what a printed bill
  // would say.
  const totalBefore = paiseOf(order.total);

  const cheque = await tx.order.create({
    data: chequeFrom(order, actorId),
    select: { id: true },
  });

  const movingIds = moving.map((i) => i.id);
  await tx.orderItem.updateMany({
    where: { id: { in: movingIds } },
    // orderId is the ONLY column written. Not kotId: the kitchen ticket is a
    // record of a send that really happened as one ticket, and rewriting it
    // would falsify the past to tidy the present. Not any amount column either
    // — recomputeOrder is about to decide all of those.
    data: { orderId: cheque.id },
  });

  // KitchenItem.orderId is a denormalised String with no foreign key, so
  // nothing in the database would have caught it going stale — a live QUEUED
  // item would have kept pointing at the bill it is no longer on, and the
  // kitchen screen would have named the wrong cheque. changeSeq is bumped per
  // row so a connected KDS re-reads them instead of trusting its cache.
  const kitchenItems = await tx.kitchenItem.findMany({
    where: { orderItemId: { in: movingIds } },
    select: { id: true },
  });
  for (const ki of kitchenItems) {
    const seq = await nextChangeSeq(tx, order.branchId);
    await tx.kitchenItem.update({
      where: { id: ki.id },
      data: { orderId: cheque.id, changeSeq: seq },
    });
  }

  // The single evaluator, asked once per cheque. Nothing in this file computes
  // a total, a tax or a share; lib/orders.js does, exactly as it does for every
  // other money change in the system.
  await recomputeOrder(tx, order.id);
  await recomputeOrder(tx, cheque.id);

  const after = await tx.order.findMany({
    where: { id: { in: [order.id, cheque.id] } },
    select: { id: true, subtotal: true, taxAmount: true, total: true },
  });
  const sum = after.reduce((a, o) => a + paiseOf(o.total), 0);

  // THE ASSERTION THE WHOLE FEATURE RESTS ON, and it lives in the code rather
  // than only in a test, because a test proves it for the baskets someone
  // thought of and this proves it for the basket actually in front of the
  // guest. Inside the transaction, so a split that does not balance rolls back
  // and the bill is left exactly as it was.
  //
  // It is reachable: every refusal in assertSplittable removes a KNOWN way to
  // break conservation, and this catches an unknown one. If it ever fires, the
  // right response is to find out why — not to widen it to a tolerance.
  if (sum !== totalBefore) {
    throw conflict(
      `Refusing to split: the cheques would come to ${(sum / 100).toFixed(2)} ` +
        `but the bill is ${(totalBefore / 100).toFixed(2)}. Nothing has been changed.`,
    );
  }

  const byId = new Map(after.map((o) => [o.id, o]));
  return {
    originalId: order.id,
    chequeId: cheque.id,
    movedItemIds: movingIds,
    kitchenItemsRepointed: kitchenItems.length,
    totalBefore,
    original: byId.get(order.id) ?? null,
    cheque: byId.get(cheque.id) ?? null,
    splitById: actorId,
  };
};
