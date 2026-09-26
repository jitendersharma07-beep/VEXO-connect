// Table transfer — moving a seated party from one table to another. LANE
// tables; spec §B "Tables (Pro): floor/table layout, pax, waiter, transfer/merge
// table, split bill", the transfer half. MERGE IS NOT HERE — it is in
// mergeBill.js, which reuses resolveDestination below rather than re-deriving the
// "same floor, not retired, and answers identically for a table you may not see"
// rules. The two verbs meet at an empty destination: a party joining a table with
// nobody at it is a TRANSFER, and assertMergeable refuses that case by name and
// says so, because moving a bill without touching an amount is always the safer
// of the two.
//
// LIKE service.js, THIS FILE TOUCHES NO MONEY. A party moving from table 5 to
// table 6 owes exactly what it owed before it stood up. Nothing here calls
// recomputeOrder(), nothing writes an amount column, and nothing re-reads a
// price list — lib/orders.js stays the single evaluator of a total. A transfer
// that changed a bill would be a pricing bug wearing a furniture feature's
// clothes.
//
// What a transfer moves, and what it deliberately leaves behind:
//
//   MOVES   DiningVisit.tableId + .openTableId   who is sitting where, now
//   MOVES   Order.tableId for the visit's open bill(s)   where the food goes
//   STAYS   TableQrCode                          the card is glued to the table
//   STAYS   Order.branchId                       same store only, see below
//   STAYS   every amount, tax and discount column
//
// The QR card staying put is not a preference. TableQrCode is pinned by a
// composite (tableId, branchId) foreign key and carries activeTableId @unique —
// "at most one ACTIVE card per table". Re-pointing a card at the destination
// would therefore either violate that unique constraint or leave the laminated
// card on table 5 opening orders for table 6. The database refuses the mistake
// before the policy argument is even reached.

import { badRequest, conflict, notFound } from '../errors.js';

// OPEN and BILLED are what "occupied" means to the floor. The two are treated
// differently below — BILLED blocks a transfer rather than moving with it — but
// both stop a second party being seated on top of the first.
const OCCUPIED_STATUSES = ['OPEN', 'BILLED'];

/**
 * Resolves the table a party is being moved TO, and refuses everything that is
 * not a plain same-store move.
 *
 * `from` is the source table, already resolved through the caller's permission
 * scope by the route. The destination is resolved here against the SOURCE
 * table's branch rather than against the scope a second time, which is the
 * point: a transfer is a move within one floor, so the only branch that can be
 * correct is the one the party is already sitting in. That makes "may this
 * caller touch this floor?" a single question asked once, instead of two
 * questions that can disagree.
 */
export const resolveDestination = async (tx, { from, toTableId }) => {
  if (!toTableId) throw badRequest('toTableId is required', 'toTableId');
  if (toTableId === from.id) {
    throw badRequest('That party is already at that table', 'toTableId');
  }
  const to = await tx.diningTable.findFirst({
    where: { id: toTableId, branchId: from.branchId },
    select: { id: true, branchId: true, name: true, status: true, capacity: true },
  });
  // One reply for "no such table", "another store's table" and "another
  // tenant's table". A manager must not be able to probe ids to learn the shape
  // of an estate they cannot see — the same reasoning as loadTableInScope, and
  // the same words, so the two cannot drift into telling different stories.
  if (!to) throw notFound('Table not found');
  if (to.status !== 'ACTIVE') {
    throw conflict(`Table "${to.name}" is retired and cannot take a party`);
  }
  return to;
};

/**
 * Refuses a destination that already has somebody at it.
 *
 * Must be called with the destination row LOCKED (see transferParty), because
 * at READ COMMITTED two staff transferring two parties onto the same empty
 * table both read "empty" and both succeed, and the second party's items land on
 * the first party's bill. For a visit-backed party DiningVisit.openTableId
 * @unique is a second, structural guard that catches it even if this one is
 * skipped; for a till-rung dine-in order there is no such constraint, because
 * Order.tableId has no uniqueness — so for that case this check plus the row
 * lock is the ONLY thing standing between two parties and one bill.
 */
export const assertDestinationFree = async (tx, { to }) => {
  const visit = await tx.diningVisit.findFirst({
    where: { openTableId: to.id },
    select: { id: true },
  });
  if (visit) throw conflict(`Table "${to.name}" already has a party seated`);
  const order = await tx.order.findFirst({
    where: { tableId: to.id, status: { in: OCCUPIED_STATUSES } },
    select: { id: true, status: true },
  });
  if (order) throw conflict(`Table "${to.name}" already has an open bill`);
};

/**
 * The party sitting at the source table: its visit, if a card or the floor plan
 * opened one, and the bills on the table.
 *
 * A dine-in order rung up at the till has tableId set and visitId NULL, so a
 * party can exist with no visit at all. Both shapes transfer; the visit is the
 * richer record and moves too when it is there.
 */
export const partyAt = async (tx, { from }) => {
  const visit = await tx.diningVisit.findFirst({
    where: { openTableId: from.id },
    select: { id: true, companyId: true, branchId: true, tableId: true },
  });
  const orders = await tx.order.findMany({
    where: { tableId: from.id, status: { in: OCCUPIED_STATUSES } },
    select: { id: true, status: true, visitId: true, total: true },
    orderBy: { createdAt: 'asc' },
  });
  return { visit, orders };
};

/**
 * Decides whether this party may move, and says why not in words a floor screen
 * can show.
 *
 * A BILLED order refuses. The bill has been printed and handed over with the
 * table on it, and moving the party afterwards would leave the customer's copy
 * disagreeing with the record — the identical argument assertServiceEditable
 * makes for covers and the server, and it has to be the same argument, because
 * the printed bill is the same piece of paper. A party that wants to move after
 * being billed settles and starts again, which is also what actually happens on
 * a floor.
 */
export const assertTransferable = ({ from, visit, orders }) => {
  if (!visit && orders.length === 0) {
    throw conflict(`Table "${from.name}" has nobody at it to move`);
  }
  const billed = orders.find((o) => o.status !== 'OPEN');
  if (billed) {
    throw conflict(
      `This table's bill is already ${billed.status.toLowerCase()}; settle it before moving the party`,
    );
  }
  return { visit, orders };
};

/**
 * Moves the party. Call inside a transaction, with `from` already resolved
 * through the caller's scope.
 *
 * LOCK ORDER MATTERS AND IS NOT ARBITRARY. The visit row is taken first because
 * lib/qr/visits.js takes it first too — orderForVisit()'s comment states that
 * "every caller takes this lock first, so the ordering is consistent and cannot
 * deadlock against itself", and a new writer that took the table first would
 * quietly make that sentence false the moment a guest hit Send during a
 * transfer. The destination table is locked second, and it is what serialises
 * two transfers racing for the same empty table.
 *
 * Returns what moved, for the audit row and the response.
 */
export const transferParty = async (tx, { from, toTableId, actorId }) => {
  // Resolved first only to establish that the id names a table on THIS floor;
  // everything it says about the table's state is re-checked under the lock
  // below, because this read is unlocked and therefore already stale.
  const found = await partyAt(tx, { from });
  await resolveDestination(tx, { from, toTableId });

  // Visit first, destination second. See the note above before reordering.
  if (found.visit) {
    await tx.$queryRaw`SELECT id FROM "DiningVisit" WHERE id = ${found.visit.id} FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${toTableId} FOR UPDATE`;

  // Re-read everything after the locks. The reads above were unlocked, so what
  // they said is a guess until confirmed here: the party may have been billed or
  // moved by somebody else, and the destination may have been retired, in
  // between. Re-resolving the destination rather than trusting the first copy is
  // what makes "retired" impossible to slip past a transfer already in flight.
  const to = await resolveDestination(tx, { from, toTableId });
  const party = await partyAt(tx, { from });
  assertTransferable({ from, ...party });
  await assertDestinationFree(tx, { to });

  if (party.visit) {
    await tx.diningVisit.update({
      where: { id: party.visit.id },
      // openTableId moves with tableId because the pair is the invariant: it
      // holds tableId while OPEN and NULL once CLOSED, which is how the database
      // and not the application enforces "at most one open visit per table".
      // Writing one without the other would leave the old table looking occupied
      // for ever, and no code path would ever notice.
      data: { tableId: to.id, openTableId: to.id },
    });
  }

  // updateMany, guarded on the status we just proved, rather than a loop of
  // update() calls: the guard is what makes a bill that was issued between the
  // lock and this statement fall out of the move instead of being dragged into
  // it. tableId is the ONLY column written. branchId is not, because the move is
  // within one store; no amount column is, because a transfer is not a price.
  const moved = await tx.order.updateMany({
    where: { tableId: from.id, status: 'OPEN' },
    data: { tableId: to.id },
  });

  return {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name, capacity: to.capacity ?? null },
    visitId: party.visit?.id ?? null,
    orderIds: party.orders.map((o) => o.id),
    ordersMoved: moved.count,
    movedById: actorId,
  };
};

// Prisma reports a unique-constraint violation as P2002. The only unique column
// this file can collide on is DiningVisit.openTableId, and the only way to
// collide on it is for another transfer to have seated a party on the
// destination between our check and our write. That is a 409 about the floor,
// not a 500 about the database, so the route translates it — and the constraint
// existing at all is why the window is closed rather than merely narrow.
export const isDestinationTaken = (err) =>
  err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('openTableId');
