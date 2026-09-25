// What a sale takes off the shelf.
//
// Stock leaves for a sale at exactly ONE moment: the OPEN→BILLED transition,
// inside that transition's own transaction. Not when the kitchen ticket
// prints, not when the money arrives, not on both. A KOT is a message to a
// chef and can be reprinted; a payment can be split across four tenders and
// retried by a flaky gateway. Deducting at either would take the ingredients
// once per print or once per card swipe.
//
// Idempotence is structural, not hopeful: SaleConsumption.orderItemId is
// UNIQUE, so a second hook on the same line cannot write a second row even if
// two requests race, and the movement keys are derived from the same line id
// so the ledger refuses the duplicate independently.
//
// A sale is never blocked by stock. The customer is holding the coffee; the
// ledger's opinion about whether the milk existed is a reporting problem, not
// a reason to refuse the bill. Movements post with allowNegative and the
// position is allowed to go negative, which is visible, auditable and true.
//
// Nothing here returns stock. A void, a refund and a credit note are all
// financial events — the food has been eaten. Stock comes back only through
// returnSaleStock(), which someone has to call deliberately with a reason.

import { postMovementsOnce } from './ledger.js';
import { batchPositionsAt, selectFefo, reservedByBatchAt } from './stock.js';
import { milliToQty, qtyToMilli } from './units.js';

// Worst wins. A line whose milk was costed and whose sugar was not is not an
// ACTUAL cost — reporting it as one is how a missing cost becomes invisible.
const COST_RANK = { ACTUAL: 0, ESTIMATED: 1, MISSING: 2 };
const worseStatus = (a, b) => (COST_RANK[b] > COST_RANK[a] ? b : a);

const abs = (n) => (n < 0n ? -n : n);
const divRound = (a, b) => {
  if (b === 0n) return 0n;
  const neg = a < 0n !== b < 0n;
  const q = (abs(a) * 2n + abs(b)) / (abs(b) * 2n);
  return neg ? -q : q;
};

export const UNCOSTED = Object.freeze({
  NO_STOCK_LOCATION: 'NO_STOCK_LOCATION',
  NO_RECIPE: 'NO_RECIPE',
  NO_ACTIVE_VERSION: 'NO_ACTIVE_VERSION',
  EMPTY_RECIPE: 'EMPTY_RECIPE',
});

// The one location a branch's sales consume from, or null. A branch without
// one sells exactly as it did before inventory existed: the lines are recorded
// UNCOSTED and the till is untouched.
export const saleLocationFor = (tx, branchId) =>
  tx.inventoryLocation.findFirst({ where: { saleSourceBranchId: branchId, status: 'ACTIVE' } });

// Which recipe a sold line uses. A variant's own link wins over its product's,
// because "Large Latte" having its own recipe is the entire reason variants
// exist; falling back to the product is what makes the common case — one
// recipe, several sizes priced differently — need no extra rows.
export const resolveRecipeLink = async (tx, { productId, variantId }) => {
  if (variantId) {
    const own = await tx.recipeProductLink.findUnique({
      where: { productId_variantKey: { productId, variantKey: variantId } },
    });
    if (own) return own;
  }
  return tx.recipeProductLink.findUnique({ where: { productId_variantKey: { productId, variantKey: '' } } });
};

// The requirement for one sold line, in base-unit milli per item.
//
// Three multipliers, in this order and all in integers:
//   × qtySold        three lattes need three lattes' worth;
//   ÷ outputQty      a recipe that yields 4 portions lists inputs for 4;
//   ÷ yieldPercent   80% yield means every input is divided by 0.8, because
//                    the trim and the evaporation come out of the store too.
//
// Modifier deltas are added AFTER the scaling and are themselves per portion,
// so "extra shot" on three lattes is three extra shots. A delta may be
// negative — "oat milk" removes 150 ml of dairy and adds 150 ml of oat — and a
// net negative requirement is clamped to zero rather than posted as a receipt:
// a sale cannot put stock on the shelf, whatever the modifier arithmetic says.
// The scaling itself, shared by sales and by production runs, because there is
// only one correct answer to "what does this recipe need" and two copies of it
// would drift the first time someone fixed a rounding bug in one of them.
//
// producedMilli is the output quantity asked for, in thousandths of the
// recipe's output unit. A sale passes qtySold portions as qtySold × 1000; a
// production run passes a measured quantity that need not be whole.
const requirementCore = ({ lines, producedMilli, yieldPercent, outputQty }) => {
  const yieldMilli = qtyToMilli(yieldPercent ?? 100);
  const outputMilli = qtyToMilli(outputQty ?? 1);
  if (yieldMilli <= 0) throw new Error('A recipe version cannot have a zero or negative yield');
  if (outputMilli <= 0) throw new Error('A recipe version cannot have a zero or negative output quantity');

  const need = new Map();
  for (const l of lines) {
    // One division, not two. Dividing by the output and then by the yield
    // rounds twice, and on a line like 3 g of spice across a 4-portion recipe
    // the second rounding is applied to an already-rounded number.
    const perBatch = BigInt(qtyToMilli(l.qtyBase));
    const milli = divRound(
      perBatch * BigInt(producedMilli) * 100000n,
      BigInt(outputMilli) * BigInt(yieldMilli),
    );
    need.set(l.itemId, (need.get(l.itemId) ?? 0n) + milli);
  }
  return need;
};

// Clamp, drop the empties, order deterministically. A net negative requirement
// is clamped rather than posted as a receipt: neither a sale nor a production
// run may put an input back on the shelf, whatever the modifier arithmetic
// says. The sort is by item id so two callers with the same requirement write
// their movements in the same order and the idempotency keys line up.
const finishRequirement = (need) =>
  [...need.entries()]
    .map(([itemId, milli]) => ({ itemId, qtyMilli: Number(milli > 0n ? milli : 0n) }))
    .filter((r) => r.qtyMilli > 0)
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

export const requirementFor = ({ lines, qtySold, yieldPercent, outputQty, adjustments = [] }) => {
  const need = requirementCore({
    lines,
    producedMilli: BigInt(qtySold) * 1000n,
    yieldPercent,
    outputQty,
  });
  // Deltas are added AFTER the scaling and are themselves per portion, so
  // "extra shot" on three lattes is three extra shots — the modifier is not
  // divided by the recipe's yield, because the barista pulls a whole shot.
  for (const a of adjustments) {
    const milli = BigInt(qtyToMilli(a.qtyDelta)) * BigInt(qtySold);
    need.set(a.itemId, (need.get(a.itemId) ?? 0n) + milli);
  }
  return finishRequirement(need);
};

// The requirement for a production run, in base-unit milli per item.
//
// Production asks for the quantity it INTENDS to make, not the quantity it
// actually got. A run that plans 10 kg and yields 9.4 still consumed 10 kg of
// inputs — the missing 600 g is the yield variance, and scaling the inputs down
// to match the output would hide it by construction.
export const requirementForProduction = ({ lines, producedMilli, yieldPercent, outputQty }) =>
  finishRequirement(requirementCore({ lines, producedMilli, yieldPercent, outputQty }));

// Modifier deltas that apply to this line. A row keyed to the recipe wins over
// a generic one for the same item, so "extra shot" can mean one thing on a
// latte and another on a filter coffee without two modifier ids.
const adjustmentsFor = async (tx, { companyId, recipeId, modifierIds }) => {
  if (!modifierIds?.length) return [];
  const rows = await tx.recipeModifierAdjustment.findMany({
    where: { companyId, modifierId: { in: modifierIds }, recipeKey: { in: [recipeId, ''] } },
  });
  const chosen = new Map();
  for (const r of rows) {
    const key = `${r.modifierId}:${r.itemId}`;
    const prev = chosen.get(key);
    if (!prev || (prev.recipeKey === '' && r.recipeKey === recipeId)) chosen.set(key, r);
  }
  return [...chosen.values()];
};

// FEFO picks which batch leaves; it never picks a blocked one. Whatever the
// eligible batches cannot cover is posted WITHOUT a batch, so the quantity is
// still recorded in full and the shortfall is visible as a negative position
// rather than as stock that quietly never left.
const movementsForItem = async (tx, { companyId, locationId, itemId, qtyMilli, orderItemId, occurredAt, userId, terminalId, note }) => {
  const positions = await batchPositionsAt(tx, { locationId, itemId, asOf: occurredAt });
  const reserved = await reservedByBatchAt(tx, { locationId, itemId });
  const { picks, shortMilli } = selectFefo(positions, qtyMilli, reserved);

  const movements = picks.map((p) => ({
    locationId,
    itemId,
    batchId: p.batchId,
    type: 'SALE_CONSUMPTION',
    qtyMilli: -p.qtyMilli,
    sourceType: 'ORDER_ITEM',
    sourceId: orderItemId,
    sourceLineId: null,
    idempotencyKey: `sale:${orderItemId}:${itemId}:${p.batchId}`,
    occurredAt,
    createdById: userId ?? null,
    terminalId: terminalId ?? null,
    allowNegative: true,
    note: note ?? null,
  }));

  if (shortMilli > 0) {
    movements.push({
      locationId,
      itemId,
      batchId: null,
      type: 'SALE_CONSUMPTION',
      qtyMilli: -shortMilli,
      sourceType: 'ORDER_ITEM',
      sourceId: orderItemId,
      sourceLineId: null,
      idempotencyKey: `sale:${orderItemId}:${itemId}:short`,
      occurredAt,
      createdById: userId ?? null,
      terminalId: terminalId ?? null,
      allowNegative: true,
      note: note ?? 'No eligible batch covered this quantity',
    });
  }
  return movements;
};

// Consume for one billed order. Call ONLY from the OPEN→BILLED transition,
// with that transition's `tx`, so a bill that rolls back takes its stock
// movements with it.
//
// Returns a summary; it never throws for a stock condition. It will propagate
// a genuine database error, which is correct: a bill whose consumption could
// not be written must not commit half-recorded.
// `terminalId` is the ORDER's till, not the device that happened to press
// "bill". Order.terminalId is what the day's takings are attributed to, and a
// ledger that named a different till for the same sale would leave the sales
// report and the stock report disagreeing about one event with nothing to say
// which was right. In the ordinary case they are the same till anyway, because
// a device may only touch an order in its own store; the case where they differ
// — an order opened at one counter and settled at another — is exactly the one
// where following the order is the answer that means something.
export const consumeForOrder = async (tx, { companyId, branchId, orderId, userId, terminalId = null, occurredAt = new Date() }) => {
  const items = await tx.orderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!items.length) return { consumptions: [], movements: 0, skipped: 0 };

  // Already done? The unique index would refuse anyway, but finding out by
  // catching a constraint violation would also roll back the bill.
  const done = await tx.saleConsumption.findMany({
    where: { orderItemId: { in: items.map((i) => i.id) } },
    select: { orderItemId: true },
  });
  const alreadyDone = new Set(done.map((d) => d.orderItemId));

  const location = await saleLocationFor(tx, branchId);
  const out = { consumptions: [], movements: 0, skipped: alreadyDone.size };

  for (const item of items) {
    if (alreadyDone.has(item.id)) continue;

    const base = {
      companyId,
      branchId,
      orderId,
      orderItemId: item.id,
      qtySold: item.qty,
      occurredAt,
    };

    const uncosted = async (reason, locationId = null, recipeVersionId = null) => {
      const row = await tx.saleConsumption.create({
        data: {
          ...base,
          locationId,
          recipeVersionId,
          status: 'UNCOSTED',
          uncostedReason: reason,
          costPaise: 0n,
          costStatus: 'MISSING',
        },
      });
      out.consumptions.push(row);
      return row;
    };

    if (!location) {
      await uncosted(UNCOSTED.NO_STOCK_LOCATION);
      continue;
    }

    const link = await resolveRecipeLink(tx, { productId: item.productId, variantId: item.variantId });
    if (!link) {
      await uncosted(UNCOSTED.NO_RECIPE, location.id);
      continue;
    }

    const version = await tx.recipeVersion.findFirst({
      where: { recipeId: link.recipeId, status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      include: { lines: true },
    });
    if (!version) {
      await uncosted(UNCOSTED.NO_ACTIVE_VERSION, location.id);
      continue;
    }

    // INTEGRATION(promotions): sold modifiers have no model on the order line
    // yet. When the promotions lane lands one, read the ids here and the
    // adjustment arithmetic below is already in place and tested.
    const modifierIds = [];
    const adjustments = await adjustmentsFor(tx, {
      companyId,
      recipeId: link.recipeId,
      modifierIds,
    });

    const required = requirementFor({
      lines: version.lines,
      qtySold: item.qty,
      yieldPercent: version.yieldPercent,
      outputQty: version.outputQty,
      adjustments,
    });
    if (!required.length) {
      await uncosted(UNCOSTED.EMPTY_RECIPE, location.id, version.id);
      continue;
    }

    const movements = [];
    for (const r of required) {
      movements.push(
        ...(await movementsForItem(tx, {
          companyId,
          locationId: location.id,
          itemId: r.itemId,
          qtyMilli: r.qtyMilli,
          orderItemId: item.id,
          occurredAt,
          userId,
          terminalId,
          note: `Sale ${item.name}`,
        })),
      );
    }

    const { movements: posted } = await postMovementsOnce(tx, { companyId, movements });

    let costPaise = 0n;
    let costStatus = 'ACTUAL';
    let costBasisAt = null;
    for (const m of posted) {
      costPaise -= BigInt(m.valuePaise);
      costStatus = worseStatus(costStatus, m.costStatus);
      if (m.costBasisAt && (!costBasisAt || m.costBasisAt > costBasisAt)) costBasisAt = m.costBasisAt;
    }

    const row = await tx.saleConsumption.create({
      data: {
        ...base,
        locationId: location.id,
        recipeVersionId: version.id,
        status: 'POSTED',
        uncostedReason: null,
        costPaise,
        costStatus,
        costBasisAt,
      },
    });
    out.consumptions.push(row);
    out.movements += posted.length;
  }

  return out;
};

// Put sold stock back, deliberately.
//
// `qty` is a number of sold portions, not ingredients: "two of the four
// lattes came back". The ingredients follow proportionally from the movements
// the sale actually posted, so a return reverses what was taken rather than
// what a recipe says should have been taken — if the batch that left was a
// different one this month, the batch that comes back is that one.
//
// Stock returns to the batch it came from. That keeps expiry attached: the
// alternative — untracked stock with no expiry date — would let a batch that
// expires on Friday come back as stock that never expires at all.
export const returnSaleStock = async (tx, { consumption, qty, reason, idempotencyKey, userId, occurredAt = new Date() }) => {
  if (qty <= 0) throw new Error('A stock return must be for at least one');
  const remaining = consumption.qtySold - consumption.returnedQty;
  if (qty > remaining) {
    const err = new Error(`Only ${remaining} of ${consumption.qtySold} can still be returned`);
    err.code = 'RETURN_EXCEEDS_SOLD';
    throw err;
  }

  // The write that makes this idempotent. Unique on (consumption, key), so a
  // retried request lands here and stops before any movement is posted.
  const existing = await tx.saleStockReturn.findUnique({
    where: { saleConsumptionId_idempotencyKey: { saleConsumptionId: consumption.id, idempotencyKey } },
  });
  if (existing) return { stockReturn: existing, movements: [], posted: false };

  const original = await tx.stockMovement.findMany({
    where: { sourceType: 'ORDER_ITEM', sourceId: consumption.orderItemId, type: 'SALE_CONSUMPTION' },
    orderBy: { seq: 'asc' },
  });

  const movements = [];
  let valuePaise = 0n;
  for (const m of original) {
    const backMilli = Number(divRound(BigInt(-qtyToMilli(m.qty)) * BigInt(qty), BigInt(consumption.qtySold)));
    if (backMilli <= 0) continue;
    // A consumption that could not be costed returns uncosted too. Handing
    // the ledger a zero here instead of a null would stamp this position with
    // a cost basis of nothing per unit and quietly make the next report
    // confident about a number nobody ever knew.
    const share =
      m.costStatus === 'MISSING'
        ? null
        : String(divRound(BigInt(-m.valuePaise) * BigInt(qty), BigInt(consumption.qtySold)));
    if (share !== null) valuePaise += BigInt(share);
    movements.push({
      locationId: m.locationId,
      itemId: m.itemId,
      batchId: m.batchId,
      type: 'SALE_REVERSAL',
      qtyMilli: backMilli,
      valuePaise: share,
      sourceType: 'SALE_RETURN',
      sourceId: consumption.id,
      sourceLineId: null,
      idempotencyKey: `salereturn:${consumption.id}:${idempotencyKey}:${m.id}`,
      occurredAt,
      createdById: userId ?? null,
      // The till the sale was rung on, copied from the movement being
      // reversed rather than taken from whoever is processing the return.
      // A reversal is an undoing of a specific posting, so the pair has to
      // net to zero on the same till: attribute it to the returns counter
      // instead and both tills end the month wrong by the same amount.
      terminalId: m.terminalId,
      note: reason,
    });
  }

  const { movements: posted } = await postMovementsOnce(tx, { companyId: consumption.companyId, movements });

  const stockReturn = await tx.saleStockReturn.create({
    data: {
      companyId: consumption.companyId,
      saleConsumptionId: consumption.id,
      qty,
      reason,
      valuePaise,
      idempotencyKey,
      createdById: userId,
    },
  });
  await tx.saleConsumption.update({
    where: { id: consumption.id },
    data: { returnedQty: { increment: qty } },
  });

  return { stockReturn, movements: posted, posted: true, qtyReturned: movements.map((m) => milliToQty(m.qtyMilli)) };
};
