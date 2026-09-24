// VC-103 kitchen domain logic. Schema: KitchenStation / KitchenRoute /
// KitchenItem / KitchenCursor (this lane's design, adopted 2026-09-24).
// Whole-order readiness is derived per query, never stored.

export const KITCHEN_STATES = ['QUEUED', 'IN_PREP', 'READY', 'SERVED', 'CANCELLED'];

// Forward-only. CANCELLED reachable from QUEUED/IN_PREP only — a READY item
// is a till void, which already exists and stays authoritative.
const NEXT = {
  QUEUED: ['IN_PREP', 'CANCELLED'],
  IN_PREP: ['READY', 'CANCELLED'],
  READY: ['SERVED'],
  SERVED: [],
  CANCELLED: [],
};

export const canTransition = (from, to) => (NEXT[from] || []).includes(to);

// Timestamp column entered with each state — three DISTINCT prep timestamps
// plus the cancellation one; a state alone cannot say when.
export const TIMESTAMP_FOR = {
  IN_PREP: 'startedAt',
  READY: 'readyAt',
  SERVED: 'servedAt',
  CANCELLED: 'cancelledAt',
};

// An order is kitchen-READY when every non-cancelled routed line is READY or
// later. No routed lines ⇒ not kitchen-ready (nothing to be ready).
export const orderKitchenReady = (items) => {
  const active = items.filter((i) => i.state !== 'CANCELLED');
  return active.length > 0 && active.every((i) => ['READY', 'SERVED'].includes(i.state));
};

// Per-store change cursor — InvoiceCounter pattern: the UPDATE takes the row
// lock and holds it to commit, so seq numbers become visible in order and a
// reader that has seen N has seen everything up to N.
export const nextChangeSeq = async (tx, branchId) => {
  await tx.$executeRaw`INSERT INTO "KitchenCursor" ("branchId", "lastSeq", "updatedAt")
    VALUES (${branchId}, 0, now()) ON CONFLICT ("branchId") DO NOTHING`;
  const rows = await tx.$queryRaw`UPDATE "KitchenCursor"
    SET "lastSeq" = "lastSeq" + 1, "updatedAt" = now()
    WHERE "branchId" = ${branchId} RETURNING "lastSeq"`;
  return rows[0].lastSeq;
};

// Rule resolution: product rule beats category rule beats the store default.
// Returns the stationId, or null when the store has no stations at all.
export const resolveStation = (line, routesByKey, defaultStationId) =>
  routesByKey.get(`product:${line.productId}`)
  ?? routesByKey.get(`category:${line.categoryId}`)
  ?? defaultStationId
  ?? null;

// Orders.js touchpoint, called inside the KOT-creation transaction.
// Zero ACTIVE stations ⇒ no rows, no behaviour change: feature dormant.
// One row per order line, unique on orderItemId — a replayed routing step
// can never make a second ticket line.
export const routeKotItems = async (tx, { companyId, branchId, order, kot, items }) => {
  const stations = await tx.kitchenStation.findMany({
    where: { branchId, status: 'ACTIVE' },
  });
  if (stations.length === 0) return [];
  const defaultStation =
    stations.find((s) => s.defaultForBranch === branchId)
    ?? [...stations].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))[0];
  const routes = await tx.kitchenRoute.findMany({ where: { branchId } });
  const routesByKey = new Map(routes.map((r) => [r.matchKey, r.stationId]));
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const products = await tx.product.findMany({
    where: { id: { in: items.map((i) => i.productId).filter(Boolean) } },
    select: { id: true, categoryId: true },
  });
  const categoryOf = new Map(products.map((p) => [p.id, p.categoryId]));

  const created = [];
  for (const line of items) {
    let stationId = resolveStation(
      { productId: line.productId, categoryId: categoryOf.get(line.productId) },
      routesByKey,
      defaultStation.id,
    );
    // A route may point at an archived station; that line falls back to the
    // default — a ticket must never vanish because mapping went stale.
    if (!stationById.has(stationId)) stationId = defaultStation.id;
    const seq = await nextChangeSeq(tx, branchId);
    created.push(await tx.kitchenItem.create({
      data: {
        companyId,
        branchId,
        orderId: order.id,
        kotId: kot.id,
        orderItemId: line.id,
        stationId,
        changeSeq: seq,
        targetSeconds: stationById.get(stationId).targetPrepSeconds,
        queuedAt: new Date(),
      },
    }));
  }
  return created;
};
