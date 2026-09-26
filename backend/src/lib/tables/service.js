// Floor service — covers (pax) and server attribution. LANE tables; spec §B
// "Tables (Pro): floor/table layout, pax, waiter, transfer/merge table, split
// bill", the pax and waiter half.
//
// NEITHER FIELD IS MONEY, and that is why they live here rather than anywhere
// near the pricing path. Recording that four people sat down, or that Meera is
// serving them, must never change what the party owes — so nothing in this file
// calls recomputeOrder() and nothing in it writes an amount column. The single
// money evaluator in lib/orders.js stays the only thing that computes a total.

import { prisma } from '../prisma.js';
import { badRequest, conflict } from '../errors.js';
import { branchWhereForScope } from '../permissions.js';
// Imported from the middleware on purpose. permissionContextFor() is the single
// resolution of "what may this person do, and where", and its own comment says
// the one thing that must not exist is a second implementation — the day the two
// disagree, a shift report credits a store the screen would have refused.
import { permissionContextFor } from '../../middleware/permissions.js';

// Covers a party can plausibly number. A typo guard, not a policy: a banquet of
// 400 on one bill is legal and passes, a fat-fingered 4000 on a table of four
// does not.
export const MAX_PAX = 999;

/**
 * Proves a person may be credited with serving a table in this store, and
 * returns them. Four conditions, and why each is here:
 *
 *   - in this tenant. The composite (waiterId, companyId) foreign key would
 *     refuse a stranger anyway, but a constraint violation is a 500, not an
 *     answer. One message covers both "no such person" and "another company's
 *     person", so an id cannot be probed to learn whether it exists elsewhere.
 *   - ACTIVE. A suspended or departed account must stop accruing sales the
 *     moment it is suspended; otherwise "whose table was this?" has an answer
 *     that nobody can put a question to.
 *   - may take orders. Crediting someone who cannot open an order in this store
 *     makes the shift report fiction. Resolved through the tenant's own
 *     permission rules rather than the role baseline, so a business that has
 *     turned order.create off for a role has that decision honoured here too.
 *   - works in THIS store. Resolved with branchWhereForScope — the same
 *     function the permission middleware uses — so an explicit multi-outlet
 *     assignment widens eligibility exactly as far as it widens everything
 *     else, and a regional manager's region is expanded the same way.
 */
export const resolveWaiter = async ({ companyId, branchId, waiterId }) => {
  const user = await prisma.posUser.findFirst({
    where: { id: waiterId, companyId },
    select: {
      id: true,
      companyId: true,
      fullName: true,
      role: true,
      status: true,
      branchId: true,
      regionId: true,
    },
  });
  // Identical reply for absent and for another tenant's. See above.
  if (!user) throw badRequest('That member of staff is not in this business', 'waiterId');
  if (user.status !== 'ACTIVE') {
    throw conflict(
      `${user.fullName}'s account is ${user.status.toLowerCase()} and cannot be credited with a table`,
    );
  }
  const ctx = await permissionContextFor(user, companyId);
  if (!ctx.can('order.create')) {
    throw badRequest(
      `${user.fullName} is not allowed to take orders, so cannot be a table's server`,
      'waiterId',
    );
  }
  // AND, never a spread. branchWhereForScope returns `{ id: { in: [...] } }` for
  // a store-scoped user, so `{ id: branchId, ...fragment }` DELETES the
  // `id: branchId` it was meant to narrow and asks instead "is there any branch
  // in this person's scope?" — which, for anybody who has a store at all, is
  // always yes. The check silently becomes a no-op and credits a colleague from
  // another outlet. The suite caught precisely that: Alpha Two's captain was
  // accepted on an Alpha One table until this became an AND.
  const inStore = await prisma.branch.findFirst({
    where: { id: branchId, companyId, AND: [branchWhereForScope(ctx.scope)] },
    select: { id: true },
  });
  if (!inStore) throw badRequest(`${user.fullName} does not work in this store`, 'waiterId');
  return user;
};

/**
 * Builds the `data` for a covers/server change on one order.
 *
 * `undefined` leaves a field alone, `null` clears it — the distinction matters
 * because "don't touch the server" and "there is no server" are different
 * instructions and a floor screen sends both.
 *
 * waiterId, waiterSetAt and waiterSetById move together, in both directions,
 * because Order_waiter_attribution_complete refuses any other combination. The
 * constraint is the authority; this function is merely the thing that agrees
 * with it.
 */
export const serviceUpdateData = ({ pax, waiterId, actorId, now = new Date() }) => {
  const data = {};
  if (pax !== undefined) data.pax = pax;
  if (waiterId !== undefined) {
    if (waiterId === null) {
      data.waiterId = null;
      data.waiterSetAt = null;
      data.waiterSetById = null;
    } else {
      data.waiterId = waiterId;
      data.waiterSetAt = now;
      data.waiterSetById = actorId;
    }
  }
  return data;
};

// What a floor screen shows against a table, and what a shift report reads per
// bill. Kept next to the writer so the two cannot drift apart.
export const publicService = (order) =>
  order
    ? {
        orderId: order.id,
        pax: order.pax ?? null,
        waiterId: order.waiterId ?? null,
        waiterName: order.waiter?.fullName ?? null,
        waiterSetAt: order.waiterSetAt ?? null,
        waiterSetById: order.waiterSetById ?? null,
      }
    : null;

// Only an order still being built may have its covers or its server changed.
// Once the bill is issued it carries an invoice number and a billing snapshot,
// and the covers and the server printed on it are part of what was handed to the
// customer — correcting those afterwards would leave the printed copy disagreeing
// with the record, silently. The refusal names the status so the till can say
// why rather than just going grey.
export const assertServiceEditable = (order) => {
  if (!order) {
    throw conflict('This table has no open bill; open one before recording covers or a server');
  }
  if (order.status !== 'OPEN') {
    throw conflict(
      `This bill is already ${order.status.toLowerCase()}; covers and server are part of it now`,
    );
  }
  return order;
};
