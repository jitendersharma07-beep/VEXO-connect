// Table merge — putting two tables' parties on one bill. LANE tables; spec §B
// "Tables (Pro): ... transfer/merge table, split bill", the merge half, and the
// last of the four.
//
// THIS IS THE FILE splitBill.js AND transfer.js BOTH SAID COULD NOT BE WRITTEN
// YET. Both headers state the blocker in the same words: merging empties a bill,
// an emptied bill needs a terminal status, and OrderStatus did not have one.
// VOID was the only candidate and it is the wrong one — lib/reporting/metrics.js
// counts status 'VOID' into voidedOrders, so every merge would have read as a
// cancelled sale and corrupted the void rate an owner uses to spot till fraud. A
// merge is the opposite of a cancellation: the money did not go away, it moved
// onto the other cheque.
//
// OrderStatus.MERGED (migration 20260926091200_order_status_merged) is that
// terminal status, and the reason it was cheap to add rather than a reporting
// project is that every Order-status filter in src/ is an ALLOWLIST. MERGED is
// outside all of them without one of them being edited: SALES_STATUSES keeps it
// out of net sales, tax, discounts and the AOV denominator; OPEN_STATUSES keeps
// it off the floor and frees the table; the dues query asks for BILLED alone. The
// status GUARDS run the other way — `!== 'OPEN'` — so a merged bill refuses new
// lines, payments, billing, splitting and transferring by default. Exactly two
// places in src/ needed a word added, and both are denylists rather than
// allowlists: display.js (a merged bill must not sit on the customer screen
// emptying itself to zero) and the `GET /orders?status=` filter list.
//
// LIKE splitBill.js, THIS FILE MOVES MONEY AND DOES NOT EVALUATE IT.
// recomputeOrder() in lib/orders.js decides every total, here as everywhere. What
// this file adds is the guarantee that one answer afterwards equals the two
// answers before — asserted below, inside the transaction, in both directions.
//
// WHY CONSERVATION IS EXACT HERE AND NOT MERELY CLOSE. It is the same equation
// splitBill.js measured, read backwards: split compared computeOrderTotals(whole)
// against computeOrderTotals(A) + computeOrderTotals(B), which is what a merge
// compares too. Its probe over 4000 randomised baskets found that equation EXACT
// (0/4000 wrong) when no order-level discount is involved, and wrong by up to
// ₹34,055 when one is. The arithmetic says why: with discount null and no
// promotion, computeOrderTotals gives every line a zero discountShare, so lineTax
// is percentOf(lineSubtotal) computed per line and total is a plain sum of line
// totals. Summing is associative; there is no order-level rounding step to
// disagree about. Merge therefore inherits split's measurement rather than
// needing its own, and the discount and promotion refusals below are what keep it
// inside the case that was measured.
//
// WHAT MOVES, WHAT STAYS, AND WHAT IS ADDED UP:
//
//   MOVES   OrderItem.orderId (ACTIVE lines)  the line, and therefore the money
//   MOVES   KitchenItem.orderId               denormalised, would go stale
//   ADDS    Order.pax                         two parties became one party
//   STAYS   OrderItem.kotId                   the ticket the kitchen really cooked
//   STAYS   OrderItem.guestId                 which seat asked for no onion
//   STAYS   Kot                               a send that really happened there
//   STAYS   VOIDED lines                      cancelled on the bill it happened on
//   STAYS   Order.tableId on the merged bill  where it was rung up, historically
//   STAYS   Order.waiterId on the survivor    see mergedPaxOf's neighbour note
//   CLOSES  DiningVisit (source)              the table is free; it has nobody at it
//
// History stays where it happened and only live attribution moves. That is the
// same rule transfer.js applies when it leaves the QR card glued to the table and
// splitBill.js applies when it leaves kotId alone.

import { badRequest, conflict } from '../errors.js';
import { paiseOf, recomputeOrder } from '../orders.js';
import { nextChangeSeq } from '../kitchen.js';
import { MAX_PAX } from './service.js';
import { resolveDestination } from './transfer.js';

// What "occupied" means to the floor, and the same two statuses transfer.js and
// tables.js use. Both are fetched and the refusals below decide between them, so
// that "this table has a printed bill on it" and "this table is empty" can be
// told apart in the message a floor screen shows.
const OCCUPIED_STATUSES = ['OPEN', 'BILLED'];

// An intent that may still turn into money. Deliberately WIDER than the
// ['CREATED','PENDING'] list orders.js:1610 uses to refuse a second payment page,
// because this is a different question: UNCERTAIN means the attempt reached the
// provider and the outcome could not be established, so a human settles it later
// from evidence. Zeroing the bill underneath that human is what this excludes.
const LIVE_INTENT_STATUSES = ['CREATED', 'PENDING', 'UNCERTAIN'];

/**
 * The bills a table is running, OLDEST FIRST, with every column the refusals and
 * the arithmetic below need.
 *
 * Ordered for the same reason openBillsOf is: a table can hold more than one open
 * bill since split shipped, and "the oldest is the party's anchor" is the rule the
 * rest of the lane already follows.
 */
export const billsAt = async (tx, { tableId }) =>
  tx.order.findMany({
    where: { tableId, status: { in: OCCUPIED_STATUSES } },
    select: {
      id: true, companyId: true, branchId: true, status: true, type: true,
      tableId: true, visitId: true, channel: true, discountType: true,
      pax: true, total: true, waiterId: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

/**
 * Decides whether these two tables may be merged at all, from their bills alone.
 *
 * Every refusal is a sentence a floor screen can show, and every one of them
 * exists because the alternative is silently wrong rather than merely awkward.
 */
export const assertMergeable = ({ from, to, sourceBills, targetBills }) => {
  if (sourceBills.length === 0) {
    throw conflict(`Table "${from.name}" has no open bill to merge`);
  }

  // The destination being EMPTY is not an error the staff made, it is the wrong
  // verb — and saying so is more useful than refusing. A party joining an empty
  // table is a transfer, which already exists, already moves the bill without
  // touching a single amount, and does not need a terminal status at all.
  if (targetBills.length === 0) {
    throw conflict(
      `Table "${to.name}" has no open bill to merge into. Move the party there instead.`,
    );
  }

  // More than one cheque on the DESTINATION has no correct answer, so it is
  // refused rather than guessed. Joining the oldest would put one party's food
  // onto a cheque another guest specifically asked to have separated, and joining
  // the newest would do the same to the other one. Only the staff standing there
  // know which cheque the arriving party is joining, so they settle or merge the
  // destination's own cheques first and the till stops pretending to know.
  if (targetBills.length > 1) {
    throw conflict(
      `Table "${to.name}" has ${targetBills.length} separate cheques, so there is no single bill ` +
        'to merge into. Settle or combine them first.',
    );
  }
  const target = targetBills[0];

  // Both sides must be unissued, and for the printed-paper reason the whole lane
  // gives: assertTransferable, assertSplittable and assertServiceEditable all draw
  // the line here, and it has to be the same line because it is the same piece of
  // paper. A bill handed to a customer with a total on it cannot quietly acquire
  // another table's food, and a merged-away bill cannot be one somebody has
  // already been asked to pay.
  const issued = [...sourceBills, target].find((o) => o.status !== 'OPEN');
  if (issued) {
    throw conflict(
      `This bill is already ${issued.status.toLowerCase()}; settle it before merging the tables`,
    );
  }

  // Merging across order types would silently reclassify the money: `type` is what
  // the receipt prints, what the reports break revenue down by, and for delivery
  // what the charge model is. One bill cannot be both.
  const mismatched = sourceBills.find((o) => o.type !== target.type);
  if (mismatched) {
    throw conflict(
      `A ${mismatched.type.toLowerCase().replace(/_/g, ' ')} bill cannot be merged into a ` +
        `${target.type.toLowerCase().replace(/_/g, ' ')} one`,
    );
  }

  return { target, sources: sourceBills };
};

/**
 * The per-bill refusals: everything that would make conservation unprovable or
 * move food away from money that has already been committed to it.
 *
 * `side` only shapes the wording. The checks are identical on both sides on
 * purpose — a discount is exactly as undividable when it is the survivor's as
 * when it is the merged-away bill's, and writing one list for both is what stops
 * the two drifting apart.
 */
export const assertBillMergeable = async (tx, { order, side }) => {
  const which = side === 'target' ? 'the bill being merged into' : 'the bill being merged';

  // A part-settled bill has no unambiguous merge: money already taken belongs to
  // the basket it was taken against, and after a merge that basket is one bill
  // larger or one bill emptier than the customer agreed to pay for.
  const paid = await tx.payment.count({ where: { orderId: order.id } });
  if (paid > 0) {
    throw conflict(`Money has already been taken against ${which}; the tables can no longer be merged`);
  }

  // See the header: this is the refusal that keeps "to the paisa" literally true
  // rather than "within a paise", and the message has to tell staff what to do
  // instead. A FLAT discount clamped to min(value, subtotal) on two small bills
  // does not add up to the same discount on one big one, and a PERCENT discount
  // re-shares across every line it can now reach.
  if (order.discountType) {
    throw conflict(
      `Remove the discount from ${which} before merging, then apply it to the combined bill. ` +
        'A discount cannot be carried across a merge without changing the total.',
    );
  }

  // Promotions are a promise, not a rounding problem. reevaluatePromotions() runs
  // on every money change, so a basket-level benefit would be re-decided against
  // a basket the guest never agreed to — growing on the survivor, and REVERSED on
  // the bill being emptied with Promotion.redemptionCount decremented on the way
  // out. Either direction changes what somebody was already given.
  const applied = await tx.promotionRedemption.count({
    where: { orderId: order.id, status: 'APPLIED' },
  });
  if (applied > 0) {
    throw conflict(
      `${which[0].toUpperCase()}${which.slice(1)} has an offer applied to the whole basket and ` +
        'cannot be merged. Remove the offer first, merge, then re-apply it.',
    );
  }

  // An aggregator bill is not a cheque at a table. AggregatorOrder.orderId is
  // `String? @unique` and Order.channelProvider/.externalOrderId are written in
  // one place together with channel, so a merge would either strand a provider
  // record on a zero-total bill or leave two bills claiming to be one Swiggy
  // order. Costs the dine-in path nothing: channel is @default(POS) and nothing
  // else in src/ sets it, so QR, phone, till, dine-in and takeaway are all POS.
  if (order.channel !== 'POS') {
    throw conflict('An online or aggregator order is settled by the provider and cannot be merged');
  }

  // GUARD, NOT A LIVE HOLE, and worth being honest about which. An intent is only
  // opened on a BILLED order (orders.js:1602) and no route returns a bill to OPEN,
  // so this state is currently unreachable through the API — the check is here
  // because the day somebody adds an un-bill route, the failure would otherwise be
  // a customer's online payment landing on a bill with nothing on it and no total
  // to pay. Cheap to hold, expensive to discover later.
  const live = await tx.paymentIntent.count({
    where: { orderId: order.id, status: { in: LIVE_INTENT_STATUSES } },
  });
  if (live > 0) {
    throw conflict(
      `An online payment is still open against ${which}; settle or cancel it before merging`,
    );
  }

  // Points spent against a basket must keep the basket they were spent against.
  // A loyalty REDEEM is performed inline at the till with the customer standing
  // there (lib/integrations/loyalty.js), and a PENDING one may already have cost
  // them points; moving the food onto another cheque afterwards means the guest
  // paid points for food billed elsewhere. When the redemption also landed as an
  // order discount the check above catches it too — that overlap is deliberate,
  // because only one of the two is guaranteed to be present.
  const loyalty = await tx.loyaltyOperation.count({ where: { orderId: order.id } });
  if (loyalty > 0) {
    throw conflict(
      `Loyalty points have been used against ${which}; the tables can no longer be merged`,
    );
  }
};

/**
 * The covers policy, in a named function so it can be read and argued with rather
 * than buried in an update payload.
 *
 * Covers are added, because two parties sitting down together are one party and a
 * sales-per-cover report divides by this column: leaving the survivor at 4 when 6
 * people are eating overstates spend per head by half. Nulls are not zeros — an
 * unstated cover count stays unstated, and a merge of two bills nobody counted
 * produces a bill nobody has counted rather than a confident 0, which
 * Order_pax_positive would refuse anyway.
 *
 * The neighbouring decision, deliberately NOT symmetrical: waiterId is left on
 * the survivor untouched. Covers are a fact about the guests and survive the
 * move; the server is a fact about who is looking after them, the survivor's
 * table has its own, and overwriting it would credit one member of staff with
 * another's sale in the very report Order's [companyId, waiterId, billedAt] index
 * exists to answer.
 */
export const mergedPaxOf = (bills) => {
  const stated = bills.map((b) => b.pax).filter((p) => p !== null && p !== undefined);
  if (stated.length === 0) return null;
  const sum = stated.reduce((a, p) => a + p, 0);
  // Refused rather than clamped or written through. MAX_PAX is what serviceSchema
  // accepts, so a larger value here would be a number no member of staff could
  // have typed and no later edit through POST /tables/:id/service could correct.
  if (sum > MAX_PAX) {
    throw conflict(`That would put ${sum} covers on one bill, which is more than a table can seat`);
  }
  return sum;
};

/**
 * Merges the source table's bill(s) into the destination table's single bill.
 * Call inside a transaction, with `from` already resolved through the caller's
 * scope by the route.
 *
 * LOCK ORDER MATTERS AND IS NOT ARBITRARY. DiningVisit, then DiningTable, then
 * Order, then KitchenCursor — the union of the two orders this lane already
 * established, taken in the one sequence that is consistent with both.
 * transfer.js takes the visit before the table because lib/qr/visits.js takes the
 * visit first and says in writing that "every caller takes this lock first, so the
 * ordering is consistent and cannot deadlock against itself". splitBill.js takes
 * the order before the kitchen cursor because nextChangeSeq holds its row lock to
 * commit. The order rows are locked in sorted id order so that two merges racing
 * over the same pair of tables queue instead of deadlocking.
 */
export const mergeBills = async (tx, { from, toTableId, actorId }) => {
  if (toTableId === from.id) {
    throw badRequest('A table cannot be merged into itself', 'toTableId');
  }

  // Unlocked, and only to learn which rows to lock. Everything it says is a guess
  // until re-read under the locks below — the same two-pass shape transferParty
  // uses, and for the same reason: at READ COMMITTED the first read is already
  // stale by the time the lock is taken.
  const preVisit = await tx.diningVisit.findFirst({
    where: { openTableId: from.id },
    select: { id: true },
  });
  await resolveDestination(tx, { from, toTableId });
  const preIds = [...(await billsAt(tx, { tableId: from.id })), ...(await billsAt(tx, { tableId: toTableId }))]
    .map((o) => o.id)
    .sort();

  if (preVisit) {
    await tx.$queryRaw`SELECT id FROM "DiningVisit" WHERE id = ${preVisit.id} FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${toTableId} FOR UPDATE`;
  for (const id of preIds) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
  }

  // Re-read and re-resolve after the locks, rather than trusting the copies
  // above. Re-resolving the destination is what makes "retired between the check
  // and the write" impossible to slip past a merge already in flight; re-reading
  // the bills is what makes "billed by the till while the manager pressed merge"
  // fall out of the merge instead of being dragged into it.
  const to = await resolveDestination(tx, { from, toTableId });
  const sourceBills = await billsAt(tx, { tableId: from.id });
  const targetBills = await billsAt(tx, { tableId: to.id });
  const { target, sources } = assertMergeable({ from, to, sourceBills, targetBills });

  // A bill locked after preIds was computed is a bill nobody locked. That happens
  // when a second party's order was created between the two reads, and it is a
  // reason to abandon the merge rather than to proceed with an unlocked row whose
  // total this function is about to assert on.
  const nowIds = [...sources, target].map((o) => o.id).sort();
  if (nowIds.join(',') !== preIds.join(',')) {
    throw conflict('The bills on these tables changed while the merge was starting; nothing has been changed');
  }

  for (const o of sources) await assertBillMergeable(tx, { order: o, side: 'source' });
  await assertBillMergeable(tx, { order: target, side: 'target' });

  // A guest basket nobody has accepted or rejected yet would be orphaned by the
  // visit closing under it — the same refusal closeVisit makes, for the same
  // reason, and it has to be made here because closeVisit opens its own
  // transaction and cannot be called from inside this one.
  if (preVisit) {
    const pending = await tx.qrSubmission.count({
      where: { visitId: preVisit.id, status: 'SUBMITTED' },
    });
    if (pending > 0) {
      throw conflict(
        `Table "${from.name}" has ${pending} submission(s) nobody has accepted or rejected yet`,
      );
    }
  }

  // The number the whole merge has to add up to, captured before anything moves.
  // Read from the STORED totals, because the stored total is what each party has
  // been quoted and what a printed bill would have said.
  const totalsBefore = new Map([...sources, target].map((o) => [o.id, paiseOf(o.total)]));
  const sumBefore = [...totalsBefore.values()].reduce((a, t) => a + t, 0);

  const sourceIds = sources.map((o) => o.id);

  // ACTIVE only. A VOIDED line is a record of something cancelled on the bill it
  // was cancelled on, and dragging it onto the survivor would put another party's
  // cancellation in front of this party's cashier. It also carries no money —
  // recomputeOrder zeroes a voided line's shares — so leaving it behind cannot
  // affect conservation.
  const moving = await tx.orderItem.findMany({
    where: { orderId: { in: sourceIds }, status: 'ACTIVE' },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const movingIds = moving.map((i) => i.id);

  let kitchenItemsRepointed = 0;
  if (movingIds.length > 0) {
    await tx.orderItem.updateMany({
      where: { id: { in: movingIds } },
      // orderId is the ONLY column written. Not kotId: the kitchen ticket records
      // a send that really happened as one ticket, and rewriting it would falsify
      // the past to tidy the present. Not guestId either — "Guest 2, no onion" is
      // true of the person who asked, whichever bill now carries the line. And no
      // amount column, because recomputeOrder is about to decide all of those.
      data: { orderId: target.id },
    });

    // KitchenItem.orderId is a denormalised String with no foreign key, so nothing
    // in the database would have caught it going stale: a live QUEUED item would
    // have kept pointing at a bill that now totals zero, and the kitchen screen
    // would have named a cheque nobody can pay. changeSeq is bumped per row so a
    // connected KDS re-reads them instead of trusting its cache.
    const kitchenItems = await tx.kitchenItem.findMany({
      where: { orderItemId: { in: movingIds } },
      select: { id: true },
    });
    for (const ki of kitchenItems) {
      const seq = await nextChangeSeq(tx, target.branchId);
      await tx.kitchenItem.update({
        where: { id: ki.id },
        data: { orderId: target.id, changeSeq: seq },
      });
    }
    kitchenItemsRepointed = kitchenItems.length;
  }

  // Covers before the recompute only because it is not money and the order does
  // not matter; computed from the rows read under the lock.
  const pax = mergedPaxOf([...sources, target]);

  // The single evaluator, asked once per bill. Nothing in this file computes a
  // total, a tax or a share; lib/orders.js does, exactly as it does for every
  // other money change in the system. The survivor first, so that if a source
  // recompute throws, the transaction rolls back with neither written.
  await recomputeOrder(tx, target.id);
  for (const id of sourceIds) await recomputeOrder(tx, id);

  const after = await tx.order.findMany({
    where: { id: { in: [...sourceIds, target.id] } },
    select: { id: true, subtotal: true, taxAmount: true, total: true },
  });
  const byId = new Map(after.map((o) => [o.id, o]));

  // THE TWO ASSERTIONS THE WHOLE FEATURE RESTS ON, in the code and not only in a
  // test, because a test proves it for the baskets somebody thought of and this
  // proves it for the basket actually in front of the guest. Inside the
  // transaction, so a merge that does not balance rolls back and both bills are
  // left exactly as they were.
  //
  // They are deliberately a PAIR, and checking only the total would be weaker
  // than it looks: `sum of everything afterwards === sum before` also passes when
  // money stayed behind on the source and the survivor came out short, which is
  // the exact failure a merge is prone to. So the survivor is asserted to carry
  // the whole amount, AND every merged-away bill is asserted to carry nothing.
  const targetAfter = paiseOf(byId.get(target.id).total);
  if (targetAfter !== sumBefore) {
    throw conflict(
      `Refusing to merge: the combined bill would come to ${(targetAfter / 100).toFixed(2)} ` +
        `but the two bills are ${(sumBefore / 100).toFixed(2)}. Nothing has been changed.`,
    );
  }
  for (const id of sourceIds) {
    const left = paiseOf(byId.get(id).total);
    if (left !== 0) {
      throw conflict(
        `Refusing to merge: ${(left / 100).toFixed(2)} would be left behind on a merged bill. ` +
          'Nothing has been changed.',
      );
    }
  }

  // Covers move only once the money has been proved. Two writes, because the
  // survivor gains what the sources give up and SUM(pax) across the estate has to
  // keep equalling the number of people who actually ate — a source still
  // claiming 2 while the survivor now says 6 reports 8 diners for 6 the moment any
  // report stops filtering by status. What each bill held before is in the audit
  // meta, which is where "what it was" belongs.
  if (pax !== null) {
    await tx.order.update({ where: { id: target.id }, data: { pax } });
    await tx.order.updateMany({ where: { id: { in: sourceIds } }, data: { pax: null } });
  }

  // Guarded on the status that was proved under the lock, and the count is
  // asserted rather than assumed: a bill that slipped out of OPEN between the
  // assertion and this statement must fail the merge, not be quietly skipped and
  // left holding lines it no longer has.
  const merged = await tx.order.updateMany({
    where: { id: { in: sourceIds }, status: 'OPEN' },
    // status is the only column written. tableId STAYS — the bill really was rung
    // up at that table, and it no longer makes the table look occupied because
    // every floor query filters on OPEN_STATUSES, which MERGED is outside.
    data: { status: 'MERGED' },
  });
  if (merged.count !== sourceIds.length) {
    throw conflict('A bill changed while the tables were being merged; nothing has been changed');
  }

  // The source table now has nobody at it, so its visit closes and the table's
  // unique slot is freed. status, openTableId and closedAt are written together
  // because the DiningVisit_status_matches_lifecycle CHECK refuses any other
  // combination — and writing one without the others would leave the old table
  // looking occupied for ever with no code path ever noticing.
  //
  // The party's guest tokens stop resolving, which is correct and is also the
  // known limitation: guests who were ordering from their phones at the source
  // table re-scan the destination table's card. Moving DiningVisitGuest rows
  // across would be a QR-lane change to a second party's live session, and
  // silently re-pointing somebody's phone at another table's basket is worse than
  // asking them to scan again.
  let closedVisitId = null;
  if (preVisit) {
    const current = await tx.diningVisit.findUnique({
      where: { id: preVisit.id },
      select: { id: true, status: true },
    });
    if (current && current.status === 'OPEN') {
      await tx.diningVisit.update({
        where: { id: current.id },
        data: {
          status: 'CLOSED',
          openTableId: null,
          closedAt: new Date(),
          closedById: actorId ?? null,
          closedReason: 'MERGE',
        },
      });
      closedVisitId = current.id;
    }
  }

  return {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    targetOrderId: target.id,
    mergedOrderIds: sourceIds,
    movedItemIds: movingIds,
    kitchenItemsRepointed,
    closedVisitId,
    // Per-bill, not just the sum: a shift report reconstructing a disputed merge
    // needs to know what each party owed before they were combined.
    totalsBeforePaise: Object.fromEntries(totalsBefore),
    totalBeforePaise: sumBefore,
    paxBefore: Object.fromEntries([...sources, target].map((o) => [o.id, o.pax ?? null])),
    pax,
    target: byId.get(target.id) ?? null,
    mergedById: actorId,
  };
};
