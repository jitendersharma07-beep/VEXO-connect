// THE stock ledger. Every quantity change in the product passes through
// postMovements() and nothing else writes StockMovement, StockBalance or
// StockBatchBalance.
//
// Append-only. A posted movement is never updated and never deleted; a
// mistake is corrected by posting its reverse, which is why a stock report
// from last March still reads the same today.
//
// Costing is perpetual WEIGHTED AVERAGE per location per item. FEFO decides
// which physical batch leaves the shelf; it does NOT decide what that batch
// cost, because mixing physical selection with cost selection is how a
// business ends up with two different answers for the same margin. Batch
// quantities are tracked per batch (StockBatchBalance); value is tracked per
// location+item (StockBalance) and only there.
//
// Issue rule, in order:
//   1. Against stock on hand, value leaves PROPORTIONALLY — issuing half the
//      quantity takes half the value. Issuing all of it takes all of it, so a
//      position that empties lands on exactly zero value with no rounding
//      residue left behind to haunt the next receipt's average.
//   2. Beyond stock on hand, the excess is valued at the last known average
//      and the movement is flagged ESTIMATED.
//   3. With no last known average at all, the excess is valued at zero and
//      flagged MISSING. Zero here means "we do not know", and every report
//      that touches it has to say so rather than show a 100% margin.
//
// Negative stock is a per-caller decision, never a global one. A sale must
// never be blocked by the ledger — the customer is holding the coffee — so
// the POS hook posts with allowNegative. Transfers, wastage and production
// refuse, because those are moments when a human can still go and look.

import { Prisma } from '@prisma/client';
import { milliToQty, qtyToMilli } from './units.js';

// Namespace for pg_advisory_xact_lock, so a stock lock cannot collide with a
// lock some other subsystem takes on a numerically equal key.
const LOCK_NAMESPACE = 5653849;

export class LedgerError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.detail = detail;
  }
}

const abs = (n) => (n < 0n ? -n : n);

// Round-half-up on BigInt, sign-aware: -0.5 goes to -1, not 0.
const divRound = (a, b) => {
  if (b === 0n) return 0n;
  const neg = a < 0n !== b < 0n;
  const q = (abs(a) * 2n + abs(b)) / (abs(b) * 2n);
  return neg ? -q : q;
};

// Paise per ONE base unit, at 6 decimals, as a string Prisma stores into
// Decimal(20,6). qtyMilli is thousandths of a base unit.
const unitCostString = (valuePaise, qtyMilli) => {
  if (qtyMilli === 0n) return null;
  const scaled = divRound(valuePaise * 1000n * 1000000n, qtyMilli);
  const neg = scaled < 0n;
  const a = abs(scaled);
  return `${neg ? '-' : ''}${a / 1000000n}.${(a % 1000000n).toString().padStart(6, '0')}`;
};

const unitCostToBigIntPer1000Milli = (decimalStr) => {
  // Decimal(20,6) paise-per-base-unit → paise per 1000 milli (= per base
  // unit), kept in micro-paise so the multiply below stays integral.
  const [w, f = ''] = String(decimalStr).split('.');
  const neg = w.startsWith('-');
  const micro = BigInt((neg ? w.slice(1) : w) || '0') * 1000000n + BigInt((f + '000000').slice(0, 6));
  return neg ? -micro : micro;
};

// Serialises everything that competes for one (location, item) shelf.
//
// Exported because posting a movement is not the only way to commit stock:
// reserving it commits it too, and a reservation decided from a stale read
// oversells exactly as badly as a movement would. Postgres runs READ
// COMMITTED by default, so two allocations that each read "nothing is
// reserved here" will both reserve the whole shelf and the warehouse promises
// the same sack of sugar to two stores. Any transaction that decides how much
// of a position is free must take THIS lock, not one of its own.
//
// Selected FROM the function rather than as a column: it returns void, which
// the client cannot deserialise as a result column.
export const lockPosition = async (tx, locationId, itemId) => {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${`${locationId}:${itemId}`})::int)`;
};

const loadBalance = async (tx, companyId, locationId, itemId) => {
  const existing = await tx.stockBalance.findUnique({ where: { locationId_itemId: { locationId, itemId } } });
  if (existing) return existing;
  return tx.stockBalance.create({
    data: { companyId, locationId, itemId, qty: '0.000', valuePaise: 0n },
  });
};

// One movement's effect on one position. Pure: takes the position, returns the
// row to write and the position that follows it. Tested directly.
export const applyMovement = (position, m) => {
  const onHandMilli = BigInt(qtyToMilli(position.qty));
  const onHandValue = BigInt(position.valuePaise);
  const qtyMilli = BigInt(m.qtyMilli);

  if (qtyMilli === 0n) throw new LedgerError('A movement cannot be for zero quantity', 'ZERO_QTY');

  let valuePaise;
  let costStatus;
  let costBasisAt = position.costBasisAt ?? null;
  let lastUnitCostPaise = position.lastUnitCostPaise ?? null;

  if (qtyMilli > 0n) {
    if (m.valuePaise === null || m.valuePaise === undefined) {
      valuePaise = 0n;
      costStatus = 'MISSING';
    } else {
      valuePaise = BigInt(m.valuePaise);
      if (valuePaise < 0n) throw new LedgerError('A receipt cannot carry a negative value', 'NEGATIVE_RECEIPT_VALUE');
      costStatus = 'ACTUAL';
      costBasisAt = m.occurredAt;
    }
  } else {
    const wantMilli = -qtyMilli;
    const fromStockMilli = onHandMilli > 0n ? (wantMilli < onHandMilli ? wantMilli : onHandMilli) : 0n;
    const excessMilli = wantMilli - fromStockMilli;

    // Proportional, not unit-cost × quantity: taking the whole position must
    // take the whole value and leave exactly zero.
    const fromStockValue =
      fromStockMilli === 0n
        ? 0n
        : fromStockMilli === onHandMilli
          ? onHandValue
          : divRound(onHandValue * fromStockMilli, onHandMilli);

    let excessValue = 0n;
    if (excessMilli > 0n) {
      if (lastUnitCostPaise !== null && lastUnitCostPaise !== undefined) {
        const micro = unitCostToBigIntPer1000Milli(lastUnitCostPaise);
        excessValue = divRound(micro * excessMilli, 1000n * 1000000n);
        costStatus = 'ESTIMATED';
      } else {
        costStatus = 'MISSING';
      }
    }
    // Zero value is not the same fact as zero cost. A position that has never
    // taken a valued receipt has costBasisAt null, and issuing from it is
    // MISSING however much quantity is on the shelf — otherwise the report
    // downstream shows the sale as pure margin.
    if (excessMilli === 0n) costStatus = costBasisAt ? 'ACTUAL' : 'MISSING';
    valuePaise = -(fromStockValue + excessValue);
  }

  const afterMilli = onHandMilli + qtyMilli;
  const afterValue = onHandValue + valuePaise;

  // Only a position with a real cost basis carries a "last known average"
  // forward; otherwise the ESTIMATED path above would estimate at zero and
  // launder a missing cost into a confident one.
  if (costBasisAt) {
    if (afterMilli > 0n) {
      lastUnitCostPaise = unitCostString(afterValue, afterMilli);
    } else if (qtyMilli > 0n) {
      lastUnitCostPaise = unitCostString(valuePaise, qtyMilli);
    }
  }

  return {
    valuePaise,
    costStatus,
    costBasisAt,
    unitCostPaise: qtyMilli === 0n ? null : unitCostString(valuePaise, qtyMilli),
    afterMilli,
    afterValue,
    lastUnitCostPaise,
  };
};

// Post a batch of movements atomically inside the caller's transaction.
//
// Movements are applied in the order given. Two movements on the same
// position chain correctly because each reads the position the previous one
// left — balanceQtyAfter on the ledger is therefore a true running total and
// can be used to audit the cache without trusting it.
export const postMovements = async (tx, { companyId, movements }) => {
  if (!movements.length) return [];
  const written = [];
  const positions = new Map();

  for (const m of movements) {
    const key = `${m.locationId}:${m.itemId}`;
    if (!positions.has(key)) {
      await lockPosition(tx, m.locationId, m.itemId);
      positions.set(key, await loadBalance(tx, companyId, m.locationId, m.itemId));
    }
    const position = positions.get(key);
    const result = applyMovement(position, m);

    if (result.afterMilli < 0n && !m.allowNegative) {
      throw new LedgerError(
        `Not enough stock: ${milliToQty(-m.qtyMilli)} requested, ${position.qty} on hand`,
        'INSUFFICIENT_STOCK',
        { locationId: m.locationId, itemId: m.itemId, onHand: String(position.qty), requested: milliToQty(-m.qtyMilli) },
      );
    }

    const row = await tx.stockMovement.create({
      data: {
        companyId,
        locationId: m.locationId,
        itemId: m.itemId,
        batchId: m.batchId ?? null,
        type: m.type,
        qty: milliToQty(m.qtyMilli),
        valuePaise: result.valuePaise,
        unitCostPaise: result.unitCostPaise,
        costStatus: result.costStatus,
        costBasisAt: result.costBasisAt,
        balanceQtyAfter: milliToQty(Number(result.afterMilli)),
        balanceValueAfter: result.afterValue,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        sourceLineId: m.sourceLineId ?? null,
        idempotencyKey: m.idempotencyKey,
        occurredAt: m.occurredAt,
        createdById: m.createdById ?? null,
        note: m.note ?? null,
      },
    });

    const updated = await tx.stockBalance.update({
      where: { id: position.id },
      data: {
        qty: milliToQty(Number(result.afterMilli)),
        valuePaise: result.afterValue,
        lastUnitCostPaise: result.lastUnitCostPaise,
        costBasisAt: result.costBasisAt,
        lastSeq: row.seq,
      },
    });
    positions.set(key, updated);

    if (m.batchId) {
      await tx.$executeRaw`
        INSERT INTO "StockBatchBalance" ("id", "companyId", "locationId", "itemId", "batchId", "qty", "updatedAt")
        VALUES (gen_random_uuid()::text, ${companyId}, ${m.locationId}, ${m.itemId}, ${m.batchId},
                ${new Prisma.Decimal(milliToQty(m.qtyMilli))}, now())
        ON CONFLICT ("locationId", "itemId", "batchId")
        DO UPDATE SET "qty" = "StockBatchBalance"."qty" + EXCLUDED."qty", "updatedAt" = now()`;

      if (!m.allowNegative) {
        const [bb] = await tx.$queryRaw`
          SELECT "qty" FROM "StockBatchBalance"
          WHERE "locationId" = ${m.locationId} AND "itemId" = ${m.itemId} AND "batchId" = ${m.batchId}`;
        if (bb && qtyToMilli(bb.qty) < 0) {
          throw new LedgerError(
            `Not enough stock in that batch: it would go to ${bb.qty}`,
            'INSUFFICIENT_BATCH_STOCK',
            { locationId: m.locationId, itemId: m.itemId, batchId: m.batchId, wouldBe: String(bb.qty) },
          );
        }
      }
    }

    written.push(row);
  }

  return written;
};

// Idempotent posting: movements whose key is already in the ledger are
// skipped, and the existing rows are returned instead. A retried GRN, a
// double-clicked dispatch and a replayed webhook all land here and post once.
export const postMovementsOnce = async (tx, { companyId, movements }) => {
  const keys = movements.map((m) => m.idempotencyKey);
  const existing = await tx.stockMovement.findMany({ where: { idempotencyKey: { in: keys } } });
  if (existing.length === keys.length) return { movements: existing, posted: false };
  if (existing.length > 0) {
    // A partial match means a previous attempt committed some of an atomic
    // set — impossible inside one transaction, so it means two different
    // callers built the same key for different work. Refuse rather than
    // half-post.
    throw new LedgerError(
      'Some of these movements were already posted under the same key',
      'PARTIAL_IDEMPOTENCY_COLLISION',
      { matched: existing.map((e) => e.idempotencyKey) },
    );
  }
  return { movements: await postMovements(tx, { companyId, movements }), posted: true };
};

// Proves the cache equals the ledger. Returns the positions where it does not.
export const verifyBalances = async (client, companyId) => {
  const rows = await client.$queryRaw`
    SELECT b."locationId", b."itemId",
           b."qty"::text        AS cache_qty,
           b."valuePaise"::text AS cache_value,
           COALESCE(SUM(m."qty"), 0)::text        AS ledger_qty,
           COALESCE(SUM(m."valuePaise"), 0)::text AS ledger_value
    FROM "StockBalance" b
    LEFT JOIN "StockMovement" m
      ON m."locationId" = b."locationId" AND m."itemId" = b."itemId"
    WHERE b."companyId" = ${companyId}
    GROUP BY b."locationId", b."itemId", b."qty", b."valuePaise"`;
  const mismatches = rows.filter(
    (r) => qtyToMilli(r.cache_qty) !== qtyToMilli(r.ledger_qty) || BigInt(r.cache_value) !== BigInt(r.ledger_value),
  );
  return { checked: rows.length, mismatches };
};

// Rewrites the caches from the ledger. Never invents a movement — if the
// ledger is right and the cache drifted, this fixes the cache; if the ledger
// itself is wrong, this changes nothing and the difference stays visible.
export const rebuildBalances = async (tx, companyId) => {
  await tx.$executeRaw`
    UPDATE "StockBalance" b
    SET "qty" = COALESCE(s.q, 0), "valuePaise" = COALESCE(s.v, 0), "updatedAt" = now()
    FROM (
      SELECT "locationId", "itemId", SUM("qty") AS q, SUM("valuePaise") AS v
      FROM "StockMovement" WHERE "companyId" = ${companyId}
      GROUP BY "locationId", "itemId"
    ) s
    WHERE b."locationId" = s."locationId" AND b."itemId" = s."itemId" AND b."companyId" = ${companyId}`;
  await tx.$executeRaw`
    UPDATE "StockBatchBalance" b
    SET "qty" = COALESCE(s.q, 0), "updatedAt" = now()
    FROM (
      SELECT "locationId", "itemId", "batchId", SUM("qty") AS q
      FROM "StockMovement" WHERE "companyId" = ${companyId} AND "batchId" IS NOT NULL
      GROUP BY "locationId", "itemId", "batchId"
    ) s
    WHERE b."locationId" = s."locationId" AND b."itemId" = s."itemId" AND b."batchId" = s."batchId"
      AND b."companyId" = ${companyId}`;
  return verifyBalances(tx, companyId);
};
