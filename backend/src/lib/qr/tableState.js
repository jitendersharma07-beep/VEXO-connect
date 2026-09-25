// What a table is actually doing, derived from rows that other people wrote.
//
// The floor plan is the screen a manager looks at to decide where to seat the
// next party and which table needs a server, so every state here has to be a
// consequence of something that really happened. Nothing in this file stores a
// status, and nothing lets one be set: a status column would be a second copy of
// the truth, and the first time a KOT was cut without updating it the plan would
// start lying. Instead each state names the evidence it requires.
//
// The distinction the §6 requirement actually turns on:
//
//   a scan          is not an order      — scanning writes nothing at all, so a
//                                         scanned table is indistinguishable
//                                         from an unscanned one, by construction
//   a submission    is not an acceptance — ORDERING, and it is a state a human
//                                         still has to act on
//   an acceptance   is not served food   — IN_KITCHEN until KitchenItem says
//                                         otherwise
//   a bill          is not a payment     — BILLED until Payment rows cover it
//
// FREE is the only state with no evidence behind it, which is correct: it is the
// absence of everything else.

export const TABLE_STATES = [
  'FREE',
  // A party is seated and has a visit open, but nothing has been sent. Reached
  // when a guest starts a table order and has not submitted, or when staff seat
  // a party from the plan.
  'SEATED',
  // A guest has sent a basket and nobody has accepted or rejected it. The
  // kitchen has NOT been told. This is the state that exists so that "the guest
  // pressed send" can never be mistaken for "the kitchen is cooking".
  'ORDERING',
  // Accepted, at least one KOT cut, and something is still not served.
  'IN_KITCHEN',
  // Every active line has been served and the bill has not been raised.
  'SERVED',
  // Bill raised, money still owed.
  'BILLED',
  // Settled. The table is waiting to be cleared, not waiting for anything else.
  'PAID',
];

// Rows every derivation needs. Exported as a query fragment so a caller cannot
// accidentally derive a state from a partial read — a missing include would
// otherwise silently look like "no evidence", i.e. a free table.
export const TABLE_STATE_INCLUDE = {
  orders: {
    where: { status: { in: ['OPEN', 'BILLED'] } },
    // Oldest first, so "the table's bill" below is a stable choice rather than
    // whichever row Postgres happened to return.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      status: true,
      source: true,
      total: true,
      items: {
        where: { status: 'ACTIVE' },
        select: { id: true, kotId: true, kitchenItem: { select: { state: true } } },
      },
      payments: { select: { amount: true } },
      qrSubmissions: { where: { status: 'SUBMITTED' }, select: { id: true } },
    },
  },
  visits: {
    where: { status: 'OPEN' },
    select: {
      id: true,
      openedAt: true,
      _count: { select: { guests: true } },
      // Settled orders, read through the VISIT rather than added to the list
      // above. A PAID order is the evidence for the last state — the money
      // arrived and the table is waiting to be cleared — but `occupied` on the
      // floor plan is computed from the same `orders` array and has always meant
      // "has an open or billed order". Widening that array would quietly make
      // every settled table read as occupied to callers this file does not own.
      orders: { where: { status: 'PAID' }, select: { id: true }, take: 1 },
    },
    take: 1,
  },
};

const paise = (d) => Math.round(Number(d ?? 0) * 100);

/**
 * Derives one table's state. `table` must have been read with
 * TABLE_STATE_INCLUDE.
 *
 * Order of tests is the order of escalation: the most advanced thing that is
 * true wins, because a table with one line served and one still in the pass is
 * IN_KITCHEN — a server is still owed something. The reverse reading would tell
 * a manager the table was done.
 */
export const tableStateOf = (table) => {
  // A missing include and a genuinely idle table both look like "no rows", and
  // the wrong answer of the two is FREE on a table with four people at it. Prisma
  // omits the key entirely when it was not selected, so the two are in fact
  // distinguishable — and this is the only place that can tell.
  if (!Array.isArray(table.orders) || !Array.isArray(table.visits)) {
    throw new Error('tableStateOf: table was not read with TABLE_STATE_INCLUDE');
  }
  const orders = table.orders;
  const visit = table.visits[0] ?? null;

  const state = {
    state: 'FREE',
    orderId: null,
    visitId: visit?.id ?? null,
    guests: visit?._count?.guests ?? 0,
    seatedAt: visit?.openedAt ?? null,
    // Submissions nobody has decided. Surfaced as its own number because it is
    // an action a human owes the table, not a phase the table is in.
    awaitingStaff: 0,
    amountDue: null,
  };

  if (orders.length === 0) {
    if (!visit) return state;
    // The till moves an order straight to PAID and closes it the instant the
    // money covers the bill, so by the time a manager looks there is no open
    // order left to read. The visit is the thing that says the party has not got
    // up yet, and a settled order under it is the only honest evidence for PAID.
    if ((visit.orders?.length ?? 0) > 0) {
      state.state = 'PAID';
      state.orderId = visit.orders[0].id;
      state.amountDue = 0;
      return state;
    }
    state.state = 'SEATED';
    return state;
  }

  // One order per visit by the shared-order policy, but a table can carry a
  // staff-rung order too. The oldest open one is the table's bill.
  const order = orders[0];
  state.orderId = order.id;
  state.awaitingStaff = orders.reduce((a, o) => a + (o.qrSubmissions?.length ?? 0), 0);

  const due = orders.reduce(
    (a, o) => a + paise(o.total) - o.payments.reduce((b, p) => b + paise(p.amount), 0),
    0,
  );
  state.amountDue = Math.max(0, due) / 100;

  if (order.status === 'BILLED') {
    // Payment is evidence, not intent. A bill with nothing owing is PAID even
    // before the order row closes, because the guest has settled and the only
    // thing left is clearing the table.
    state.state = due <= 0 ? 'PAID' : 'BILLED';
    return state;
  }

  const lines = orders.flatMap((o) => o.items ?? []);
  const sent = lines.filter((l) => l.kotId);

  if (sent.length === 0) {
    // Lines exist and none has reached a kitchen. Either a guest is waiting on
    // staff, or staff are still ringing the order up.
    state.state = state.awaitingStaff > 0 ? 'ORDERING' : 'SEATED';
    return state;
  }

  // A line with no KitchenItem was never routed to a station — zero stations
  // configured is a supported setup — so it cannot be "unserved" and must not
  // hold the whole table in IN_KITCHEN forever.
  const outstanding = sent.filter(
    (l) => l.kitchenItem && l.kitchenItem.state !== 'SERVED' && l.kitchenItem.state !== 'CANCELLED',
  );
  state.state = outstanding.length > 0 ? 'IN_KITCHEN' : 'SERVED';
  return state;
};
