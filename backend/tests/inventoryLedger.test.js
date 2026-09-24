// The stock ledger's arithmetic, proven against the real database.
//
// These are the facts every screen, report and POS hook downstream assumes.
// If one of them breaks, a restaurant's stock figure stops matching its shelf
// or its margin stops matching its bank, so they are asserted directly on the
// ledger rather than through a route that might paper over them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('inventoryLedger.test.js requires a DATABASE_URL ending in _test');
}

const { prisma } = await import('../src/lib/prisma.js');
const { postMovements, postMovementsOnce, applyMovement, verifyBalances, rebuildBalances, LedgerError } =
  await import('../src/lib/inventory/ledger.js');
const { batchPositionsAt, selectFefo, stockStateFor, batchBlockReason, BLOCKED_REASONS } =
  await import('../src/lib/inventory/stock.js');
const {
  convertToBaseMilli,
  displayInStoredUnit,
  resolveFactorMilli,
  qtyToMilli,
  milliToQty,
  baseUnitChangeBlockers,
  UnitError,
} = await import('../src/lib/inventory/units.js');
const { wipeAll, buildBaseFixture, makeItem, makeBatch, daysFromNow } = await import('./helpers/inventory.js');

let fx;
let item;

const at = (n = 0) => new Date(Date.UTC(2026, 8, 24, 10, 0, 0) + n * 60000);

// Every movement needs a unique idempotency key; tests that care about
// idempotency pass their own.
let keySeq = 0;
const move = (over = {}) => ({
  locationId: fx.warehouse.id,
  itemId: item.id,
  type: 'GRN',
  sourceType: 'GRN',
  sourceId: 'src-1',
  idempotencyKey: `k-${++keySeq}-${Math.random().toString(36).slice(2)}`,
  occurredAt: at(),
  ...over,
});

const post = (movements) =>
  prisma.$transaction((tx) => postMovements(tx, { companyId: fx.company.id, movements }));

const balance = (locationId = fx.warehouse.id, itemId = item.id) =>
  prisma.stockBalance.findUnique({ where: { locationId_itemId: { locationId, itemId } } });

// Prisma hands back a Decimal whose toString drops trailing zeros, so
// quantities are compared at the ledger's own three decimals.
const q3 = (d) => d.toFixed(3);

beforeAll(async () => {
  await wipeAll();
});

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await wipeAll();
  fx = await buildBaseFixture();
  item = await makeItem(fx.company.id, { name: 'Sugar', baseUnit: 'G' });
});

describe('units: a litre is not a kilogram', () => {
  it('converts within a dimension and refuses to cross one', () => {
    const grams = { baseUnit: 'G', name: 'Sugar' };
    expect(convertToBaseMilli(grams, '2', 'kg').baseMilli).toBe(2000000);
    expect(convertToBaseMilli(grams, '0.5', 'kg').baseMilli).toBe(500000);
    expect(() => resolveFactorMilli(grams, 'litre')).toThrow(UnitError);
    try {
      resolveFactorMilli(grams, 'litre');
    } catch (e) {
      expect(e.code).toBe('UNIT_DIMENSION_MISMATCH');
      // The message has to say which dimension, or the operator "fixes" it by
      // inventing a custom unit called litre.
      expect(e.message).toMatch(/volume/);
      expect(e.message).toMatch(/stocked in g/);
    }
  });

  it('refuses a quantity finer than the ledger can hold rather than rounding it away', () => {
    expect(qtyToMilli('1.234')).toBe(1234);
    expect(() => qtyToMilli('1.2345')).toThrow(/at most 3 decimals/);
    expect(milliToQty(-1234)).toBe('-1.234');
  });

  it('reports rounding instead of hiding it', () => {
    const pcs = { baseUnit: 'PCS', name: 'Napkin' };
    const exact = convertToBaseMilli(pcs, '2', 'dozen');
    expect(exact).toMatchObject({ baseMilli: 24000, rounded: false, factorMilli: 12000 });
    // Half a milligram is finer than three decimals of a gram, so it rounds —
    // and the caller is told, rather than the difference vanishing.
    const grams = { baseUnit: 'G', name: 'Saffron' };
    const inexact = convertToBaseMilli(grams, '0.5', 'mg');
    expect(inexact.rounded).toBe(true);
    expect(inexact.baseMilli).toBe(1);
  });

  it('cannot let a custom unit shadow a standard one', () => {
    const grams = { baseUnit: 'G', name: 'Flour' };
    // Someone names a 25 kg sack "kg". Every historical line that says kg must
    // keep meaning a kilogram.
    const factor = resolveFactorMilli(grams, 'kg', [{ name: 'KG', factorMilli: 25000000 }]);
    expect(factor).toBe(1000000);
  });

  it('reads a historical line with the factor stored on it, not today’s table', () => {
    // A case was 12 when this line was written; it is 24 now. The line still
    // means 12.
    expect(displayInStoredUnit(12000, 1000)).toBe('12.000');
    expect(displayInStoredUnit(12000, 12000)).toBe('1.000');
  });

  it('blocks a base-unit change once the item has been transacted', () => {
    expect(baseUnitChangeBlockers({ movementCount: 0, balanceCount: 0, recipeLineCount: 0 })).toEqual([]);
    const blockers = baseUnitChangeBlockers({ movementCount: 3, balanceCount: 1, recipeLineCount: 0 });
    expect(blockers).toHaveLength(2);
    expect(blockers[0]).toMatch(/3 stock movements/);
  });
});

describe('ledger: weighted average', () => {
  it('averages two receipts and issues proportionally', async () => {
    await post([
      move({ qtyMilli: 1000000, valuePaise: 50000n, occurredAt: at(0) }), // 1 kg @ ₹500
      move({ qtyMilli: 1000000, valuePaise: 70000n, occurredAt: at(1) }), // 1 kg @ ₹700
    ]);
    let b = await balance();
    expect(q3(b.qty)).toBe('2000.000');
    expect(b.valuePaise).toBe(120000n);
    // The average is ₹600/kg, carried as paise per BASE unit: 60 paise a gram.
    expect(b.lastUnitCostPaise.toString()).toBe('60');

    const [issue] = await post([
      move({ type: 'SALE_CONSUMPTION', sourceType: 'ORDER_ITEM', qtyMilli: -500000, occurredAt: at(2) }),
    ]);
    expect(issue.valuePaise).toBe(-30000n);
    expect(issue.costStatus).toBe('ACTUAL');
    b = await balance();
    expect(q3(b.qty)).toBe('1500.000');
    expect(b.valuePaise).toBe(90000n);
  });

  it('empties a position to exactly zero value, leaving no residue', async () => {
    // Deliberately awkward: 3 receipts whose average does not divide evenly.
    await post([
      move({ qtyMilli: 1000, valuePaise: 1n, occurredAt: at(0) }),
      move({ qtyMilli: 1000, valuePaise: 2n, occurredAt: at(1) }),
      move({ qtyMilli: 1000, valuePaise: 100n, occurredAt: at(2) }),
    ]);
    await post([move({ type: 'WASTAGE', sourceType: 'WASTAGE', qtyMilli: -1000, occurredAt: at(3) })]);
    await post([move({ type: 'WASTAGE', sourceType: 'WASTAGE', qtyMilli: -1000, occurredAt: at(4) })]);
    await post([move({ type: 'WASTAGE', sourceType: 'WASTAGE', qtyMilli: -1000, occurredAt: at(5) })]);
    const b = await balance();
    expect(q3(b.qty)).toBe('0.000');
    // The whole point: no stray paise left to distort the next receipt.
    expect(b.valuePaise).toBe(0n);
  });

  it('flags stock issued beyond what the ledger holds as ESTIMATED', async () => {
    await post([move({ qtyMilli: 1000000, valuePaise: 60000n, occurredAt: at(0) })]);
    const [issue] = await post([
      move({
        type: 'SALE_CONSUMPTION',
        sourceType: 'ORDER_ITEM',
        qtyMilli: -1500000,
        allowNegative: true,
        occurredAt: at(1),
      }),
    ]);
    expect(issue.costStatus).toBe('ESTIMATED');
    // 1 kg actual at ₹600 plus 0.5 kg estimated at the same average.
    expect(issue.valuePaise).toBe(-90000n);
    const b = await balance();
    expect(q3(b.qty)).toBe('-500.000');
  });

  it('never presents an unknown cost as zero-cost profit', async () => {
    // A receipt with no price behind it at all.
    const [receipt] = await post([move({ qtyMilli: 1000000, valuePaise: null, occurredAt: at(0) })]);
    expect(receipt.costStatus).toBe('MISSING');
    expect(receipt.valuePaise).toBe(0n);

    const [issue] = await post([
      move({ type: 'SALE_CONSUMPTION', sourceType: 'ORDER_ITEM', qtyMilli: -500000, occurredAt: at(1) }),
    ]);
    // Zero value AND flagged MISSING. If this said ACTUAL, every report
    // downstream would show the sale as pure margin.
    expect(issue.valuePaise).toBe(0n);
    expect(issue.costStatus).toBe('MISSING');

    const b = await balance();
    expect(b.lastUnitCostPaise).toBeNull();
  });

  it('keeps a genuinely free receipt distinct from an unknown one', async () => {
    // A supplier sample at ₹0 is a known cost that happens to be zero.
    await post([move({ qtyMilli: 1000, valuePaise: 0n, occurredAt: at(0) })]);
    const [issue] = await post([
      move({ type: 'WASTAGE', sourceType: 'WASTAGE', qtyMilli: -500, occurredAt: at(1) }),
    ]);
    expect(issue.valuePaise).toBe(0n);
    expect(issue.costStatus).toBe('ACTUAL');
  });

  it('refuses to oversell when the caller did not opt into negative stock', async () => {
    await post([move({ qtyMilli: 1000, valuePaise: 100n, occurredAt: at(0) })]);
    await expect(
      post([move({ type: 'TRANSFER_OUT', sourceType: 'TRANSFER', qtyMilli: -2000, occurredAt: at(1) })]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    // And the refusal left nothing behind.
    const b = await balance();
    expect(q3(b.qty)).toBe('1.000');
    expect(await prisma.stockMovement.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
  });

  it('chains two movements on one position inside a single post', async () => {
    const rows = await post([
      move({ qtyMilli: 1000, valuePaise: 100n, occurredAt: at(0) }),
      move({ qtyMilli: 1000, valuePaise: 300n, occurredAt: at(1) }),
      move({ type: 'WASTAGE', sourceType: 'WASTAGE', qtyMilli: -1000, occurredAt: at(2) }),
    ]);
    // balanceQtyAfter is a true running total, auditable without the cache.
    expect(rows.map((r) => q3(r.balanceQtyAfter))).toEqual(['1.000', '2.000', '1.000']);
    expect(rows.map((r) => r.balanceValueAfter)).toEqual([100n, 400n, 200n]);
  });

  it('is pure enough to reason about without a database', () => {
    const r = applyMovement({ qty: '2.000', valuePaise: 400n, costBasisAt: at(0) }, { qtyMilli: -1000 });
    expect(r.valuePaise).toBe(-200n);
    expect(r.afterMilli).toBe(1000n);
    expect(r.afterValue).toBe(200n);
  });

  it('rejects a zero-quantity movement', () => {
    expect(() => applyMovement({ qty: '0.000', valuePaise: 0n }, { qtyMilli: 0 })).toThrow(LedgerError);
  });
});

describe('ledger: idempotency and self-audit', () => {
  it('posts once however many times a retry arrives', async () => {
    const m = move({ qtyMilli: 5000, valuePaise: 500n, idempotencyKey: 'grn:line:fixed', occurredAt: at(0) });

    const first = await prisma.$transaction((tx) =>
      postMovementsOnce(tx, { companyId: fx.company.id, movements: [m] }),
    );
    expect(first.posted).toBe(true);

    const second = await prisma.$transaction((tx) =>
      postMovementsOnce(tx, { companyId: fx.company.id, movements: [m] }),
    );
    expect(second.posted).toBe(false);
    expect(second.movements[0].id).toBe(first.movements[0].id);

    expect(await prisma.stockMovement.count()).toBe(1);
    const b = await balance();
    expect(q3(b.qty)).toBe('5.000');
  });

  it('refuses a half-matching key set rather than posting part of it', async () => {
    const shared = move({ qtyMilli: 1000, valuePaise: 100n, idempotencyKey: 'shared:key', occurredAt: at(0) });
    await prisma.$transaction((tx) => postMovementsOnce(tx, { companyId: fx.company.id, movements: [shared] }));

    await expect(
      prisma.$transaction((tx) =>
        postMovementsOnce(tx, {
          companyId: fx.company.id,
          movements: [shared, move({ qtyMilli: 1000, valuePaise: 100n, occurredAt: at(1) })],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PARTIAL_IDEMPOTENCY_COLLISION' });
    expect(await prisma.stockMovement.count()).toBe(1);
  });

  it('proves the balance cache equals the ledger, and repairs it if it drifts', async () => {
    await post([
      move({ qtyMilli: 4000, valuePaise: 400n, occurredAt: at(0) }),
      move({ type: 'WASTAGE', sourceType: 'WASTAGE', qtyMilli: -1000, occurredAt: at(1) }),
    ]);
    expect((await verifyBalances(prisma, fx.company.id)).mismatches).toHaveLength(0);

    // Corrupt the cache the way a bad hand-written UPDATE would.
    await prisma.stockBalance.updateMany({ where: { itemId: item.id }, data: { qty: '99.000' } });
    expect((await verifyBalances(prisma, fx.company.id)).mismatches).toHaveLength(1);

    await prisma.$transaction((tx) => rebuildBalances(tx, fx.company.id));
    expect((await verifyBalances(prisma, fx.company.id)).mismatches).toHaveLength(0);
    expect(q3((await balance()).qty)).toBe('3.000');
  });
});

describe('batches: FEFO, expiry and containment', () => {
  const receiveBatch = (batchId, qtyMilli, valuePaise, t = 0) =>
    post([move({ batchId, qtyMilli, valuePaise, occurredAt: at(t) })]);

  it('orders first-expiring first and puts undated batches last', async () => {
    const soon = await makeBatch(fx.company.id, item.id, { batchCode: 'B-SOON', expiryDate: daysFromNow(2) });
    const later = await makeBatch(fx.company.id, item.id, { batchCode: 'B-LATER', expiryDate: daysFromNow(30) });
    const never = await makeBatch(fx.company.id, item.id, { batchCode: 'B-NEVER', expiryDate: null });
    await receiveBatch(never.id, 1000, 100n, 0);
    await receiveBatch(later.id, 1000, 100n, 1);
    await receiveBatch(soon.id, 1000, 100n, 2);

    const positions = await batchPositionsAt(prisma, { locationId: fx.warehouse.id, itemId: item.id });
    expect(positions.map((p) => p.batchCode)).toEqual(['B-SOON', 'B-LATER', 'B-NEVER']);

    // An undated batch does not expire, so consuming it first would strand the
    // stock that actually has a deadline.
    const picked = selectFefo(positions, 1500);
    expect(picked.picks.map((p) => p.batchCode)).toEqual(['B-SOON', 'B-LATER']);
    expect(picked.picks.map((p) => p.qtyMilli)).toEqual([1000, 500]);
    expect(picked.short).toBe(false);
  });

  it('refuses expired stock with no scheduler having run', async () => {
    const expired = await makeBatch(fx.company.id, item.id, { batchCode: 'B-OLD', expiryDate: daysFromNow(-1) });
    const good = await makeBatch(fx.company.id, item.id, { batchCode: 'B-OK', expiryDate: daysFromNow(10) });
    await receiveBatch(expired.id, 5000, 500n, 0);
    await receiveBatch(good.id, 1000, 100n, 1);

    // Nothing was asked to mark it. Eligibility is computed from the date.
    expect(await prisma.inventoryReminder.count()).toBe(0);

    const positions = await batchPositionsAt(prisma, { locationId: fx.warehouse.id, itemId: item.id });
    const old = positions.find((p) => p.batchCode === 'B-OLD');
    expect(old.blockReason).toBe(BLOCKED_REASONS.EXPIRED);
    expect(old.eligibleMilli).toBe(0);

    const picked = selectFefo(positions, 3000);
    // It never substitutes the expired batch to make the number work.
    expect(picked.picks.map((p) => p.batchCode)).toEqual(['B-OK']);
    expect(picked.short).toBe(true);
    expect(picked.shortMilli).toBe(2000);
    expect(picked.blockedMilli).toBe(5000);
  });

  it('treats the expiry date itself as still good, and the next day as not', async () => {
    const today = new Date(Date.UTC(2026, 8, 24, 0, 0, 0));
    const batch = { state: 'AVAILABLE', expiryDate: today };
    expect(batchBlockReason(batch, new Date(Date.UTC(2026, 8, 24, 23, 0, 0)))).toBeNull();
    expect(batchBlockReason(batch, new Date(Date.UTC(2026, 8, 25, 1, 0, 0)))).toBe(BLOCKED_REASONS.EXPIRED);
  });

  it('blocks quarantined and recalled batches without touching their quantity', async () => {
    const q = await makeBatch(fx.company.id, item.id, { batchCode: 'B-Q', expiryDate: daysFromNow(30) });
    await receiveBatch(q.id, 2000, 200n, 0);
    await prisma.stockBatch.update({
      where: { id: q.id },
      data: { state: 'QUARANTINED', stateReason: 'Crate damaged in transit', stateChangedAt: at(1) },
    });

    const positions = await batchPositionsAt(prisma, { locationId: fx.warehouse.id, itemId: item.id });
    expect(positions[0].blockReason).toBe(BLOCKED_REASONS.QUARANTINED);
    // Still physically there: quarantine is not a write-off.
    expect(positions[0].qtyMilli).toBe(2000);
    expect(positions[0].eligibleMilli).toBe(0);

    await prisma.stockBatch.update({ where: { id: q.id }, data: { state: 'RECALLED' } });
    const after = await batchPositionsAt(prisma, { locationId: fx.warehouse.id, itemId: item.id });
    expect(after[0].blockReason).toBe(BLOCKED_REASONS.RECALLED);
  });

  it('blocks only what is left in an opened container, not the batch beside it', async () => {
    const b = await makeBatch(fx.company.id, item.id, { batchCode: 'B-OPEN', expiryDate: daysFromNow(60) });
    await receiveBatch(b.id, 5000, 500n, 0);
    await prisma.stockBatchOpening.create({
      data: {
        companyId: fx.company.id,
        locationId: fx.warehouse.id,
        batchId: b.id,
        openedAt: daysFromNow(-3),
        useByAt: daysFromNow(-1),
        qty: '1.000',
      },
    });

    const positions = await batchPositionsAt(prisma, { locationId: fx.warehouse.id, itemId: item.id });
    expect(positions[0].qtyMilli).toBe(5000);
    expect(positions[0].blockedMilli).toBe(1000);
    expect(positions[0].eligibleMilli).toBe(4000);
    expect(positions[0].blockReason).toBe(BLOCKED_REASONS.OPENED_PAST_USE_BY);
    // The batch's own expiry is untouched — opening one container does not
    // condemn the unopened ones.
    const row = await prisma.stockBatch.findUnique({ where: { id: b.id } });
    expect(row.expiryDate).not.toBeNull();
  });

  it('will not let a batch go negative when the caller did not allow it', async () => {
    const b = await makeBatch(fx.company.id, item.id, { batchCode: 'B-1' });
    await receiveBatch(b.id, 1000, 100n, 0);
    // Enough stock at the position overall, but not in this batch.
    const other = await makeBatch(fx.company.id, item.id, { batchCode: 'B-2' });
    await receiveBatch(other.id, 9000, 900n, 1);

    await expect(
      post([
        move({
          type: 'TRANSFER_OUT',
          sourceType: 'TRANSFER',
          batchId: b.id,
          qtyMilli: -2000,
          occurredAt: at(2),
        }),
      ]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BATCH_STOCK' });
  });

  it('keeps batch identity and expiry through a transfer', async () => {
    const b = await makeBatch(fx.company.id, item.id, { batchCode: 'B-MOVE', expiryDate: daysFromNow(5) });
    await receiveBatch(b.id, 4000, 800n, 0);
    await post([
      move({
        type: 'TRANSFER_OUT',
        sourceType: 'TRANSFER',
        batchId: b.id,
        qtyMilli: -3000,
        occurredAt: at(1),
      }),
      move({
        locationId: fx.roomA.id,
        type: 'TRANSFER_IN',
        sourceType: 'TRANSFER',
        batchId: b.id,
        qtyMilli: 3000,
        valuePaise: 600n,
        occurredAt: at(1),
      }),
    ]);

    const there = await batchPositionsAt(prisma, { locationId: fx.roomA.id, itemId: item.id });
    expect(there).toHaveLength(1);
    expect(there[0].batchCode).toBe('B-MOVE');
    expect(there[0].expiryDate).not.toBeNull();
    // Same batch id on both sides is what makes a recall traceable.
    const trail = await prisma.stockMovement.findMany({ where: { batchId: b.id }, orderBy: { seq: 'asc' } });
    expect(trail.map((t) => t.type)).toEqual(['GRN', 'TRANSFER_OUT', 'TRANSFER_IN']);
    expect((await verifyBalances(prisma, fx.company.id)).mismatches).toHaveLength(0);
  });
});

describe('stock state: the six figures', () => {
  it('reports physical, blocked, usable, reserved, available and in-transit separately', async () => {
    const good = await makeBatch(fx.company.id, item.id, { batchCode: 'S-OK', expiryDate: daysFromNow(20) });
    const dead = await makeBatch(fx.company.id, item.id, { batchCode: 'S-DEAD', expiryDate: daysFromNow(-2) });
    await post([
      move({ batchId: good.id, qtyMilli: 10000, valuePaise: 1000n, occurredAt: at(0) }),
      move({ batchId: dead.id, qtyMilli: 4000, valuePaise: 400n, occurredAt: at(1) }),
    ]);

    const reservation = await prisma.stockReservation.create({
      data: {
        companyId: fx.company.id,
        locationId: fx.warehouse.id,
        itemId: item.id,
        qty: '2.000',
        state: 'HELD',
        sourceType: 'STORE_REQUEST',
        sourceId: 'req-1',
        idempotencyKey: 'res-1',
      },
    });
    await prisma.stockReservationLine.create({
      data: { reservationId: reservation.id, batchId: good.id, qty: '2.000' },
    });

    const s = await stockStateFor(prisma, {
      companyId: fx.company.id,
      locationId: fx.warehouse.id,
      itemId: item.id,
    });
    expect(s.physical).toBe('14.000');
    expect(s.blocked).toBe('4.000');
    expect(s.usable).toBe('10.000');
    expect(s.reserved).toBe('2.000');
    expect(s.available).toBe('8.000');
    expect(s.untracked).toBe('0.000');
    expect(s.valuePaise).toBe('1400');
    // Every figure comes from its own source, so none of them can silently
    // disagree with the shelf.
    expect(s.batches).toHaveLength(2);
  });

  it('never hides a negative available behind a clamp', async () => {
    await post([move({ qtyMilli: 1000, valuePaise: 100n, occurredAt: at(0) })]);
    await prisma.stockReservation.create({
      data: {
        companyId: fx.company.id,
        locationId: fx.warehouse.id,
        itemId: item.id,
        qty: '3.000',
        state: 'HELD',
        sourceType: 'STORE_REQUEST',
        sourceId: 'req-2',
        idempotencyKey: 'res-2',
      },
    });
    const s = await stockStateFor(prisma, {
      companyId: fx.company.id,
      locationId: fx.warehouse.id,
      itemId: item.id,
    });
    expect(s.available).toBe('0.000');
    expect(s.availableRaw).toBe('-2.000');
  });

  it('reports untracked stock separately from blocked stock', async () => {
    const loose = await makeItem(fx.company.id, { name: 'Salt', baseUnit: 'G', trackBatches: false });
    await post([move({ itemId: loose.id, qtyMilli: 7000, valuePaise: 700n, occurredAt: at(0) })]);
    const s = await stockStateFor(prisma, {
      companyId: fx.company.id,
      locationId: fx.warehouse.id,
      itemId: loose.id,
    });
    expect(s.physical).toBe('7.000');
    expect(s.untracked).toBe('7.000');
    expect(s.blocked).toBe('0.000');
    expect(s.usable).toBe('7.000');
  });
});
