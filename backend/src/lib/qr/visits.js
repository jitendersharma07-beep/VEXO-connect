// The visit: what makes two parties at one table over one evening separable
// while the card glued to the table never changes.
//
// Three facts are kept deliberately apart here, because collapsing any two of
// them is how a QR ordering system starts lying to a kitchen:
//
//   scanned    — anonymous, read-only, leaves nothing behind. Not a visit.
//   submitted  — order rows exist, the table is honestly occupied, and no KOT
//                has been cut. The kitchen has never heard of it.
//   accepted   — a member of staff took it. THIS is where the KOT is cut, and
//                it goes through the same routeKotItems the till uses, so a QR
//                order reaches the same stations by the same rules.
//
// Everything that writes order money goes through recomputeOrder, and every line
// is built by the till's own resolveCatalogLine / createLineData. There is no
// second pricing path in this file and there must never be one: a guest's phone
// sends product ids and quantities, never prices.

import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../prisma.js';
import { AppError, conflict, notFound } from '../errors.js';
import { auditRequired } from '../audit.js';
import { routeKotItems } from '../kitchen.js';
import { ORDER_INCLUDE, recomputeOrder } from '../orders.js';
import { newJoinCode } from './cards.js';

// The guest's phone has to tell "you need the code" apart from "that code is
// wrong" apart from "stop asking", because each one is a different screen. A
// bare 409 would make all three look the same.
export const JOIN_REQUIRED = 'POS_QR_JOIN_CODE_REQUIRED';
export const JOIN_WRONG = 'POS_QR_JOIN_CODE_WRONG';
export const JOIN_LOCKED = 'POS_QR_JOIN_LOCKED';

// Wrong join-code guesses tolerated for the whole life of a visit. Not a rate
// limit: the code is four digits and a visit is hours long, so a per-minute
// window would let a patient guesser walk the entire space. Past this the visit
// stops accepting joiners and staff read the code out instead.
export const MAX_JOIN_ATTEMPTS = 10;

// A guest's bearer token. Hashed into the row exactly like PosSession's, so a
// database read never yields a usable credential; the plaintext exists only in
// that one browser.
export const newGuestToken = () => randomBytes(32).toString('base64url');
export const hashGuestToken = (token) => createHash('sha256').update(token).digest('hex');

/**
 * sha256 over the normalised basket. Two submissions carrying the same
 * idempotency key must hash equal only if they mean the same order, modifiers
 * included — otherwise a retry of "extra cheese" would be answered with the
 * plain one and the guest told it succeeded.
 */
export const hashSubmission = (lines) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...lines]
          .map((i) => ({
            p: i.productId,
            v: i.variantId ?? null,
            q: i.qty,
            m: [...(i.modifierOptionIds ?? [])].sort(),
          }))
          .sort((a, b) => `${a.p}|${a.v}|${a.m.join(',')}`.localeCompare(`${b.p}|${b.v}|${b.m.join(',')}`)),
      ),
    )
    .digest('hex');

/** The guest-facing view of a visit. Carries no other party's anything. */
export const publicVisitFor = (visit, guest) => ({
  visitId: visit.id,
  status: visit.status,
  openedAt: visit.openedAt,
  guest: { id: guest.id, seq: guest.seq, label: `Guest ${guest.seq}`, isHost: guest.isHost },
  // Only the host is shown the code to read out. A phone that joined with it
  // does not get to re-share it onwards.
  joinCode: guest.isHost && visit.status === 'OPEN' ? visit.joinCode : null,
});

/**
 * Adds a phone to an open visit and returns the plaintext token once.
 *
 * `seq` comes from the visit's own counter rather than from a count of guests,
 * so two phones joining at the same moment cannot both be "Guest 2" — the
 * unique index on (visitId, seq) would refuse the second, and incrementing the
 * counter inside the transaction is what stops it happening at all.
 */
export const addGuest = async (tx, visit, { isHost = false } = {}) => {
  const bumped = await tx.diningVisit.update({
    where: { id: visit.id },
    data: { guestSeq: { increment: 1 } },
    select: { guestSeq: true },
  });
  const token = newGuestToken();
  const guest = await tx.diningVisitGuest.create({
    data: {
      visitId: visit.id,
      tokenHash: hashGuestToken(token),
      seq: bumped.guestSeq,
      isHost,
      lastSeenAt: new Date(),
    },
  });
  return { guest, token };
};

/**
 * The visit for a scanned card, opening one if the table has none.
 *
 * A second phone must present the join code: being within scanning distance of
 * a card is not permission to read what the table has ordered. The first phone
 * to submit becomes the host and is the only one shown the code.
 *
 * `openTableId` is the table while OPEN and NULL once closed, and it is unique —
 * so the database itself holds "at most one open visit per table". A clash on it
 * means another phone opened the visit a moment ago, and the right answer is to
 * use that visit, not to fail.
 */
export const openOrJoinVisit = async (tx, { qr, table, joinCode }) => {
  const existing = await tx.diningVisit.findFirst({
    where: { openTableId: table.id, status: 'OPEN' },
  });

  if (!existing) {
    const visit = await tx.diningVisit.create({
      data: {
        companyId: qr.companyId,
        branchId: qr.branchId,
        tableId: table.id,
        qrCodeId: qr.id,
        status: 'OPEN',
        openTableId: table.id,
        joinCode: newJoinCode(),
      },
    });
    const { guest, token } = await addGuest(tx, visit, { isHost: true });
    return { visit, guest, token, joined: false };
  }

  if (existing.joinAttempts >= MAX_JOIN_ATTEMPTS) {
    throw new AppError(
      409,
      JOIN_LOCKED,
      'This table has had too many wrong join codes. Please ask a member of staff.',
    );
  }
  if (!joinCode) {
    // No attempt counted: the phone has not guessed anything yet, and charging
    // it for asking would let one honest guest lock the table out.
    throw new AppError(
      409,
      JOIN_REQUIRED,
      'Someone at this table has already started an order. Ask them for the 4-digit code.',
    );
  }
  if (joinCode !== existing.joinCode) {
    // Counted through `prisma`, NOT `tx`, and that is the whole point: this
    // request is about to throw, the transaction is about to roll back, and a
    // counter incremented on `tx` would roll back with it — handing the guesser
    // an unlimited number of free attempts at a four-digit code. An independent
    // write commits on its own, so the guess is paid for.
    //
    // Safe from deadlock only because nothing above has locked this row (the
    // read is a plain SELECT). Anything added here that takes a row lock must
    // move this increment out of the transaction instead.
    await prisma.diningVisit.update({
      where: { id: existing.id },
      data: { joinAttempts: { increment: 1 } },
    });
    throw new AppError(409, JOIN_WRONG, 'That join code is not right for this table.');
  }

  const { guest, token } = await addGuest(tx, existing, { isHost: false });
  return { visit: existing, guest, token, joined: true };
};

/**
 * The visit's one open order, created on first submission.
 *
 * One order per visit is the approved shared-order policy: the party gets one
 * bill, guests append to it, and OrderItem.addedByGuestId is what still tells
 * "your items" from "the table's" without splitting the money. openedById is the
 * member of staff who issued the card — Order.openedById is NOT NULL and a QR
 * order genuinely does trace back to whoever put the card on the table, which is
 * a better answer than making the column nullable and breaking every receipt.
 */
export const orderForVisit = async (tx, { visit, qr }) => {
  // The visit row is the lock, and it has to be taken before the read below. Two
  // phones tapping Send at the same instant both find no open order at READ
  // COMMITTED and both create one, and the party ends up with two bills on one
  // table — the exact failure "one order per visit" exists to prevent. Every
  // caller takes this lock first, so the ordering is consistent and cannot
  // deadlock against itself.
  await tx.$queryRaw`SELECT id FROM "DiningVisit" WHERE id = ${visit.id} FOR UPDATE`;
  const open = await tx.order.findFirst({
    where: { visitId: visit.id, status: { in: ['OPEN', 'BILLED'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (open) {
    if (open.status !== 'OPEN') {
      throw conflict('This table has already been billed. Please ask a member of staff.');
    }
    return open;
  }
  return tx.order.create({
    data: {
      companyId: visit.companyId,
      branchId: visit.branchId,
      type: 'DINE_IN',
      tableId: visit.tableId,
      source: 'QR',
      visitId: visit.id,
      qrCodeId: qr.id,
      openedById: qr.issuedById,
    },
  });
};

/**
 * Cuts the KOT for whatever on this order has not been sent yet.
 *
 * Identical in shape to the till's POST /orders/:id/kot, and calls the same
 * routeKotItems in the same transaction, so KOT and ticket lines exist together
 * or not at all. Returns null when there is nothing unsent — accepting a
 * submission whose lines a previous acceptance already sent is not an error.
 */
export const cutKot = async (tx, { order, companyId }) => {
  const unsent = await tx.orderItem.findMany({
    where: { orderId: order.id, status: 'ACTIVE', kotId: null },
    include: { modifiers: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (unsent.length === 0) return null;
  const seq = (await tx.kot.count({ where: { orderId: order.id } })) + 1;
  const kot = await tx.kot.create({ data: { orderId: order.id, seq } });
  await tx.orderItem.updateMany({
    where: { id: { in: unsent.map((i) => i.id) } },
    data: { kotId: kot.id },
  });
  await routeKotItems(tx, {
    companyId,
    branchId: order.branchId,
    order,
    kot,
    items: unsent,
  });
  return { ...kot, items: unsent };
};

/**
 * Acceptance: the moment a guest's basket becomes an order the kitchen may see.
 *
 * Until this runs the order rows exist and the KDS has never heard of them. The
 * status change and the KOT are one transaction, so there is no window in which
 * a submission reads ACCEPTED with nothing sent to a station.
 */
export const acceptSubmission = async ({ submission, req, userId }) => {
  if (submission.status !== 'SUBMITTED') {
    throw conflict(`This submission was already ${submission.status.toLowerCase()}`);
  }
  if (!submission.orderId) throw conflict('This submission has no order to accept');

  return prisma.$transaction(async (tx) => {
    // Claim the submission with a guarded UPDATE, and do it BEFORE cutting the
    // KOT. A re-read followed by an update does not serialise two cashiers: at
    // READ COMMITTED both SELECTs see SUBMITTED, both proceed, and the table gets
    // two KOTs for the same lines — measured, not theorised. An UPDATE with the
    // old status in its WHERE takes the row lock, so the second transaction
    // blocks until the first commits and then matches zero rows.
    const claimed = await tx.qrSubmission.updateMany({
      where: { id: submission.id, status: 'SUBMITTED' },
      data: { status: 'ACCEPTED', decidedById: userId, decidedAt: new Date() },
    });
    if (claimed.count === 0) throw conflict('This submission was already decided');
    const current = await tx.qrSubmission.findUnique({ where: { id: submission.id } });

    const order = await tx.order.findUnique({ where: { id: current.orderId } });
    if (!order) throw notFound('Order not found');
    if (order.status !== 'OPEN') {
      throw conflict(`This order is ${order.status.toLowerCase()} and cannot be sent to the kitchen`);
    }

    const kot = await cutKot(tx, { order, companyId: current.companyId });
    await auditRequired(tx, req, {
      action: 'QR_SUBMISSION_ACCEPT',
      entity: 'QrSubmission',
      entityId: current.id,
      companyId: current.companyId,
      meta: {
        branchId: current.branchId,
        tableId: current.tableId,
        visitId: current.visitId,
        orderId: order.id,
        kotSeq: kot?.seq ?? null,
        items: kot?.items.length ?? 0,
      },
    });
    return {
      order: await tx.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE }),
      kot,
    };
  });
};

/**
 * Rejection. The guest's lines are voided rather than deleted: what a guest
 * asked for, and the fact that a named member of staff refused it with a reason,
 * are both part of the order's history and the §7 requirement to preserve it.
 */
export const rejectSubmission = async ({ submission, req, userId, reason }) => {
  if (submission.status !== 'SUBMITTED') {
    throw conflict(`This submission was already ${submission.status.toLowerCase()}`);
  }

  return prisma.$transaction(async (tx) => {
    // Claimed the same way acceptance is, and for the same reason: a reject and
    // an accept racing each other must not both win.
    const claimed = await tx.qrSubmission.updateMany({
      where: { id: submission.id, status: 'SUBMITTED' },
      data: { status: 'REJECTED', decidedById: userId, decidedAt: new Date(), rejectedReason: reason },
    });
    if (claimed.count === 0) throw conflict('This submission was already decided');
    const current = await tx.qrSubmission.findUnique({ where: { id: submission.id } });

    // Only the lines this submission brought in, and only if the kitchen has not
    // already been told about them. A line that made it onto a KOT is the
    // kitchen's business now and is voided at the till with the normal audit.
    if (current.orderId) {
      const mine = await tx.orderItem.findMany({
        where: { orderId: current.orderId, status: 'ACTIVE', kotId: null, qrSubmissionId: current.id },
        select: { id: true },
      });
      if (mine.length > 0) {
        await tx.orderItem.updateMany({
          where: { id: { in: mine.map((i) => i.id) } },
          data: { status: 'VOIDED', voidReason: reason, voidedById: userId },
        });
        await recomputeOrder(tx, current.orderId);
      }
    }

    const updated = await tx.qrSubmission.findUnique({
      where: { id: current.id },
      include: { table: { select: { name: true } } },
    });
    await auditRequired(tx, req, {
      action: 'QR_SUBMISSION_REJECT',
      entity: 'QrSubmission',
      entityId: current.id,
      companyId: current.companyId,
      meta: {
        branchId: current.branchId,
        tableId: current.tableId,
        visitId: current.visitId,
        orderId: current.orderId,
        reason,
      },
    });
    return updated;
  });
};

/**
 * Closes a visit and isolates the next party.
 *
 * The printed card is untouched and stays usable — that is the whole point of
 * the visit being a row separate from the card. Clearing openTableId is what
 * frees the table's unique slot, and every guest token in the old visit stops
 * resolving the moment the status changes, so the next party cannot read back
 * the last one's basket.
 *
 * status, openTableId and closedAt move together because the migration's
 * DiningVisit_status_matches_lifecycle CHECK refuses any other combination.
 */
export const closeVisit = async ({ visit, req, closedById, reason }) => {
  if (visit.status !== 'OPEN') throw conflict('This visit is already closed');

  return prisma.$transaction(async (tx) => {
    const current = await tx.diningVisit.findUnique({ where: { id: visit.id } });
    if (!current || current.status !== 'OPEN') throw conflict('This visit is already closed');

    // A visit with money still owing is not finished. Refusing here is what
    // stops "close the tab" being a way to make an unpaid bill disappear.
    const unsettled = await tx.order.findFirst({
      where: { visitId: current.id, status: { in: ['OPEN', 'BILLED'] } },
      select: { id: true, status: true },
    });
    if (unsettled) {
      throw conflict(
        `This table still has a ${unsettled.status.toLowerCase()} order. Settle or void it first.`,
      );
    }

    const pending = await tx.qrSubmission.count({
      where: { visitId: current.id, status: 'SUBMITTED' },
    });
    if (pending > 0) {
      throw conflict(`This table has ${pending} submission(s) nobody has accepted or rejected yet`);
    }

    const closed = await tx.diningVisit.update({
      where: { id: current.id },
      data: {
        status: 'CLOSED',
        openTableId: null,
        closedAt: new Date(),
        closedById: closedById ?? null,
        closedReason: reason ?? null,
      },
      include: { guests: { select: { id: true } }, orders: { select: { id: true } } },
    });
    await auditRequired(tx, req, {
      action: 'DINING_VISIT_CLOSE',
      entity: 'DiningVisit',
      entityId: closed.id,
      companyId: closed.companyId,
      meta: {
        branchId: closed.branchId,
        tableId: closed.tableId,
        guests: closed.guests.length,
        orders: closed.orders.length,
        reason: reason ?? null,
      },
    });
    return closed;
  });
};
