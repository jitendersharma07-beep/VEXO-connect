// ENTITLEMENT(INVENTORY)
// The central kitchen: making one stocked item out of others.
//
// A production run is the only movement in the module that is not a purchase,
// a sale, a transfer or a correction. Paneer does not arrive from a supplier
// and is not sold as paneer — it is made from milk, and the milk stops
// existing. So the run posts two halves inside one transaction:
//
//   PRODUCTION_OUT  every input leaves, FEFO, at whatever the ledger says it
//                   was worth;
//   PRODUCTION_IN   the output arrives carrying EXACTLY the sum of what left.
//
// The second sentence is the whole point. A production run neither creates nor
// destroys value; it moves value from several positions into one. If the sum
// were recomputed from a price list instead of read back off the movements
// that just posted, a kitchen would quietly mint or burn money on every batch
// and the valuation report would drift away from the ledger that feeds it.
// That is why the inputs are posted FIRST and their written values are read
// back before the output is posted at all.
//
// Inputs scale on the quantity the run was SET UP to make, not on the quantity
// that actually came out. A run planned at 10 kg that yields 9.4 kg still ate
// 10 kg of ingredients; scaling the inputs down to match the output would make
// the variance vanish by construction, which is the one number a kitchen
// manager is actually looking for.
//
// The recipe arithmetic is not reimplemented here. requirementForProduction()
// is the same scaling a sale uses, given a milli-precise output quantity
// instead of a portion count, because there is only one correct answer to
// "what does this recipe need" and two copies of it would drift the first time
// somebody fixed a rounding bug in one of them.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter } from '../../../lib/inventory/permissions.js';
import { postMovementsOnce } from '../../../lib/inventory/ledger.js';
import { requirementForProduction } from '../../../lib/inventory/consumption.js';
import { batchPositionsAt, selectFefo, reservedByBatchAt } from '../../../lib/inventory/stock.js';
import { milliToQty, qtyToMilli } from '../../../lib/inventory/units.js';
import { nextDocNumber } from '../../../lib/inventory/docnum.js';
import { actorOut, idemKey, qtyOut, qtyString, resolveActors } from './shared.js';

const router = Router();

// Worst wins, same rule as everywhere else: a batch of paneer made from one
// costed milk and one uncosted culture is not an ACTUAL cost.
const COST_RANK = { ACTUAL: 0, ESTIMATED: 1, MISSING: 2 };
const worseStatus = (a, b) => (COST_RANK[b] > COST_RANK[a] ? b : a);

const productionSchema = z.object({
  locationId: z.string().cuid(),
  recipeVersionId: z.string().cuid(),
  // What the run was set up to make. Drives the inputs.
  batchQty: qtyString,
  // What actually came out. Omitted, the run went exactly to plan. The gap
  // between the two is the yield variance and it is never hidden.
  outputQty: qtyString.optional(),
  batchCode: z.string().trim().min(1).max(60).optional(),
  expiryDate: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: idemKey,
});

/* ------------------------------------------------------------------ post */

router.post(
  '/production',
  requireInventoryAction('inventory.production.post'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = productionSchema.parse(req.body);

    // A run takes stock off this location's shelf and puts stock back on it,
    // so it needs both rights. Asked separately so the refusal names the one
    // that is missing rather than a vague "not authorised here".
    await loadLocationInScope(prisma, req, data.locationId, 'dispatch');
    const location = await loadLocationInScope(prisma, req, data.locationId, 'receive');

    const version = await prisma.recipeVersion.findUnique({
      where: { id: data.recipeVersionId },
      include: {
        recipe: { include: { outputItem: true } },
        lines: { include: { item: true }, orderBy: { lineNo: 'asc' } },
      },
    });
    if (!version || version.recipe.companyId !== req.companyScope.id) throw notFound('Recipe version not found');
    // Only an ACTIVE version may be produced against. A draft is somebody
    // still thinking, and a retired one is a recipe the company has decided
    // to stop making — producing against either would put stock on the shelf
    // costed by a formula nobody has agreed to.
    if (version.status !== 'ACTIVE') {
      throw conflict(`Recipe version ${version.version} is ${version.status.toLowerCase()}, not active`);
    }
    if (!version.lines.length) throw conflict('That recipe version has no lines, so it makes nothing from nothing');
    // A version can outlive the archiving of the recipe that owns it, so the
    // parent is checked too. The screen already leaves archived recipes out of
    // the picker; that is a convenience, and a convenience is not enforcement.
    if (version.recipe.status !== 'ACTIVE') {
      throw conflict(`"${version.recipe.name}" is archived and is no longer made`);
    }

    const output = version.recipe.outputItem;
    if (!output) {
      throw conflict(
        `"${version.recipe.name}" does not name an output item, so it is a menu recipe: it is consumed by selling it, not by producing it`,
      );
    }
    if (output.status !== 'ACTIVE') throw conflict(`${output.name} is archived and cannot be produced`);

    const batchMilli = qtyToMilli(data.batchQty);
    if (batchMilli <= 0) throw badRequest('A production run must be set up for more than zero');
    // Zero is deliberately allowed here where it is refused above: a run that
    // was set up for nothing is a mistake, but a run that came out to nothing
    // is a disaster somebody has to be able to record.
    const producedMilli = data.outputQty === undefined ? batchMilli : qtyToMilli(data.outputQty);

    const required = requirementForProduction({
      lines: version.lines,
      producedMilli: batchMilli,
      yieldPercent: version.yieldPercent,
      outputQty: version.outputQty,
    });
    if (!required.length) throw conflict('That run works out to nothing at all — check the quantity');

    // A recipe that eats its own output is a loop, and its cost is whatever
    // the loop last happened to leave behind. Refused rather than reasoned
    // about.
    if (required.some((r) => r.itemId === output.id)) {
      throw conflict(`${output.name} is both an input and the output of that recipe`);
    }

    if (output.trackBatches && !data.batchCode) {
      throw badRequest(`${output.name} is batch tracked; the run needs a batch code`);
    }

    const itemById = new Map(version.lines.map((l) => [l.itemId, l.item]));
    const at = new Date();

    // FEFO the inputs before opening the transaction, and refuse a short run
    // here rather than letting the ledger throw. Unlike a sale, nobody is
    // holding the food yet: a kitchen that cannot cover the batch should be
    // told what it is short of, not handed a negative position.
    const prepared = [];
    for (const r of required) {
      const item = itemById.get(r.itemId);
      let picks = [{ batchId: null, milli: r.qtyMilli }];
      if (item.trackBatches) {
        const positions = await batchPositionsAt(prisma, { locationId: location.id, itemId: item.id, asOf: at });
        const reserved = await reservedByBatchAt(prisma, { locationId: location.id, itemId: item.id });
        const chosen = selectFefo(positions, r.qtyMilli, reserved);
        if (chosen.short) {
          throw conflict(
            `${location.name} has ${milliToQty(r.qtyMilli - chosen.shortMilli)} of ${item.name} available; the run needs ${milliToQty(r.qtyMilli)}`,
          );
        }
        picks = chosen.picks.map((p) => ({ batchId: p.batchId, milli: p.qtyMilli }));
      }
      prepared.push({ item, qtyMilli: r.qtyMilli, picks });
    }

    const key = data.idempotencyKey ?? `prd:${location.id}:${version.id}:${at.getTime()}`;

    let batch;
    try {
      batch = await prisma.$transaction(async (tx) => {
        const number = await nextDocNumber(tx, req.companyScope.id, 'PRODUCTION');

        // Half one: everything the run eats. Posted on its own so the values
        // the ledger assigns can be read back before the output is written.
        const outMovements = prepared.flatMap((p) =>
          p.picks.map((pick, i) => ({
            locationId: location.id,
            itemId: p.item.id,
            batchId: pick.batchId,
            type: 'PRODUCTION_OUT',
            qtyMilli: -pick.milli,
            sourceType: 'PRODUCTION',
            sourceId: key,
            sourceLineId: p.item.id,
            idempotencyKey: `prd-out:${key}:${p.item.id}:${i}`,
            occurredAt: at,
            createdById: req.user.id,
            note: `${version.recipe.name} v${version.version}`,
          })),
        );
        const { movements: posted } = await postMovementsOnce(tx, {
          companyId: req.companyScope.id,
          movements: outMovements,
        });

        // Issues carry a negative value. The output's value is the positive
        // of their sum — read off the rows that were just written, never
        // recomputed, so the two halves cannot disagree.
        let inputValue = 0n;
        let inputStatus = 'ACTUAL';
        for (const m of posted) {
          inputValue -= BigInt(m.valuePaise);
          inputStatus = worseStatus(inputStatus, m.costStatus);
        }

        let outBatchId = null;
        if (data.batchCode) {
          const made = await tx.stockBatch.upsert({
            where: { itemId_batchCode: { itemId: output.id, batchCode: data.batchCode } },
            update: { expiryDate: data.expiryDate ?? undefined, manufacturedOn: at, receivedAt: at },
            create: {
              companyId: req.companyScope.id,
              itemId: output.id,
              batchCode: data.batchCode,
              // No supplier: this batch was not bought from anybody. The
              // column is nullable precisely so a made batch can say so
              // rather than borrow the milk's supplier and lie to a recall.
              supplierId: null,
              expiryDate: data.expiryDate ?? null,
              manufacturedOn: at,
              receivedAt: at,
            },
          });
          outBatchId = made.id;
        }

        // Half two. A run that yielded nothing still consumed its inputs —
        // the loss is real and stays booked as the value that left — so the
        // receipt is skipped rather than posted for zero, which the ledger
        // refuses anyway.
        if (producedMilli > 0) {
          await postMovementsOnce(tx, {
            companyId: req.companyScope.id,
            movements: [
              {
                locationId: location.id,
                itemId: output.id,
                batchId: outBatchId,
                type: 'PRODUCTION_IN',
                qtyMilli: producedMilli,
                // null, not zero, when the inputs had no cost basis. Zero
                // would be recorded as a confident ACTUAL zero and the
                // paneer would read as free for the rest of its life.
                valuePaise: inputStatus === 'MISSING' ? null : inputValue,
                sourceType: 'PRODUCTION',
                sourceId: key,
                sourceLineId: output.id,
                idempotencyKey: `prd-in:${key}`,
                occurredAt: at,
                createdById: req.user.id,
                note: `${version.recipe.name} v${version.version}`,
              },
            ],
          });
        }

        return tx.productionBatch.create({
          data: {
            companyId: req.companyScope.id,
            number,
            locationId: location.id,
            recipeVersionId: version.id,
            outputItemId: output.id,
            outputQty: milliToQty(producedMilli),
            // Persisted, not merely returned. The variance is the one figure
            // on this document a person comes back for, and a planned size
            // that lives only in the POST response is visible exactly once —
            // to the person who already knew it.
            plannedQty: milliToQty(batchMilli),
            inputValuePaise: inputValue,
            batchId: outBatchId,
            note: data.note ?? null,
            idempotencyKey: key,
            createdById: req.user.id,
          },
        });
      });
    } catch (e) {
      if (e?.code === 'P2002' && data.idempotencyKey) {
        const existing = await prisma.productionBatch.findFirst({
          where: { companyId: req.companyScope.id, idempotencyKey: data.idempotencyKey },
        });
        if (existing) {
          return res.status(200).json({ production: await present(existing), duplicate: true });
        }
      }
      throw e;
    }

    await audit(req, {
      action: 'INVENTORY_PRODUCTION_POST',
      entity: 'ProductionBatch',
      entityId: batch.id,
      companyId: req.companyScope.id,
      meta: {
        number: batch.number,
        recipe: version.recipe.name,
        recipeVersion: version.version,
        batchQty: milliToQty(batchMilli),
        outputQty: milliToQty(producedMilli),
        inputValuePaise: String(batch.inputValuePaise),
      },
    });

    res.status(201).json({ production: await present(batch) });
  }),
);

/* ------------------------------------------------------------------ read */

// Everything a reader needs about one run, assembled from the ledger rather
// than from denormalised columns. costStatus in particular is derived from the
// movements every time: StockMovement is the only truth, and a copy on
// ProductionBatch would be a second one that could drift.
const present = async (batch) => {
  const [version, outputItem, location, movements] = await Promise.all([
    prisma.recipeVersion.findUnique({
      where: { id: batch.recipeVersionId },
      include: { recipe: { select: { id: true, name: true } } },
    }),
    prisma.inventoryItem.findUnique({
      where: { id: batch.outputItemId },
      select: { id: true, sku: true, name: true, baseUnit: true },
    }),
    prisma.inventoryLocation.findUnique({
      where: { id: batch.locationId },
      select: { id: true, name: true, code: true },
    }),
    prisma.stockMovement.findMany({
      where: { sourceType: 'PRODUCTION', sourceId: batch.idempotencyKey },
      include: { item: { select: { id: true, sku: true, name: true, baseUnit: true } } },
      orderBy: { seq: 'asc' },
    }),
  ]);

  const outRows = movements.filter((m) => m.type === 'PRODUCTION_OUT');
  const inRow = movements.find((m) => m.type === 'PRODUCTION_IN') ?? null;

  // One row per input item, however many batches it was picked from.
  const byItem = new Map();
  for (const m of outRows) {
    const cur = byItem.get(m.itemId) ?? { item: m.item, qtyMilli: 0, valuePaise: 0n, costStatus: 'ACTUAL', batchIds: [] };
    cur.qtyMilli += -qtyToMilli(m.qty);
    cur.valuePaise -= BigInt(m.valuePaise);
    cur.costStatus = worseStatus(cur.costStatus, m.costStatus);
    if (m.batchId) cur.batchIds.push(m.batchId);
    byItem.set(m.itemId, cur);
  }

  let inputStatus = 'ACTUAL';
  for (const v of byItem.values()) inputStatus = worseStatus(inputStatus, v.costStatus);

  const producedMilli = qtyToMilli(batch.outputQty);
  // From the stored column, so the detail a person opens later says the same
  // thing the POST response said. Null only for runs written before the
  // column existed, which really do not know.
  const plannedMilli = batch.plannedQty === null || batch.plannedQty === undefined ? null : qtyToMilli(batch.plannedQty);
  const batchCode = batch.batchId
    ? ((await prisma.stockBatch.findUnique({ where: { id: batch.batchId }, select: { batchCode: true, expiryDate: true } })) ?? null)
    : null;

  const actors = await resolveActors(prisma, [batch.createdById]);

  return {
    id: batch.id,
    number: batch.number,
    location,
    recipe: version ? { id: version.recipe.id, name: version.recipe.name, version: version.version } : null,
    // The recipe's own stated yield, repeated here because the variance below
    // is a variance AGAINST it and a reader cannot judge one without the other.
    yieldPercent: version ? qtyOut(version.yieldPercent) : null,
    outputItem,
    outputQty: milliToQty(producedMilli),
    plannedQty: plannedMilli === null ? null : milliToQty(plannedMilli),
    yieldVarianceQty: plannedMilli === null ? null : milliToQty(producedMilli - plannedMilli),
    batch: batch.batchId ? { id: batch.batchId, ...batchCode } : null,
    inputValuePaise: String(batch.inputValuePaise),
    // What the output is worth per base unit now it is on the shelf. Null on a
    // run that yielded nothing, because dividing by zero is not a cost.
    outputUnitCostPaise: inRow ? inRow.unitCostPaise : null,
    costStatus: inputStatus,
    note: batch.note,
    createdBy: actorOut(batch.createdById, actors),
    createdAt: batch.createdAt,
    inputs: [...byItem.values()]
      .map((v) => ({
        item: v.item,
        qtyBase: milliToQty(v.qtyMilli),
        valuePaise: String(v.valuePaise),
        costStatus: v.costStatus,
        batchIds: v.batchIds,
      }))
      .sort((a, b) => a.item.name.localeCompare(b.item.name)),
  };
};

router.get(
  '/production',
  requireInventoryAction('inventory.production.post'),
  asyncHandler(async (req, res) => {
    const { locationId, from, to } = req.query;
    if (locationId) await loadLocationInScope(prisma, req, String(locationId));
    // Without a location filter the list is still not everything: it is
    // everything the caller may see. Scoping in the query rather than after it
    // means an out-of-scope run never reaches the client for the client to be
    // trusted to hide.
    const scope = await locationScopeFilter(prisma, req);
    const visible = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const rows = await prisma.productionBatch.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(locationId
          ? { locationId: String(locationId) }
          : { locationId: { in: visible.map((v) => v.id) } }),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: new Date(String(from)) } : {}), ...(to ? { lte: new Date(String(to)) } : {}) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const [locations, items, actors] = await Promise.all([
      prisma.inventoryLocation.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.locationId))] } },
        select: { id: true, name: true, code: true },
      }),
      prisma.inventoryItem.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.outputItemId))] } },
        select: { id: true, sku: true, name: true, baseUnit: true },
      }),
      resolveActors(prisma, rows.map((r) => r.createdById)),
    ]);
    const locById = new Map(locations.map((l) => [l.id, l]));
    const itemById = new Map(items.map((i) => [i.id, i]));

    res.json({
      production: rows.map((r) => ({
        id: r.id,
        number: r.number,
        location: locById.get(r.locationId) ?? null,
        outputItem: itemById.get(r.outputItemId) ?? null,
        outputQty: qtyOut(r.outputQty),
        // On the list as well as the detail: a shortfall nobody can see
        // without opening every run one at a time is a shortfall nobody sees.
        plannedQty: r.plannedQty === null ? null : qtyOut(r.plannedQty),
        yieldVarianceQty: r.plannedQty === null ? null : milliToQty(qtyToMilli(r.outputQty) - qtyToMilli(r.plannedQty)),
        inputValuePaise: String(r.inputValuePaise),
        note: r.note,
        createdBy: actorOut(r.createdById, actors),
        createdAt: r.createdAt,
      })),
    });
  }),
);

router.get(
  '/production/:productionId',
  requireInventoryAction('inventory.production.post'),
  asyncHandler(async (req, res) => {
    const batch = await prisma.productionBatch.findUnique({ where: { id: req.params.productionId } });
    if (!batch || batch.companyId !== req.companyScope.id) throw notFound('Production run not found');
    // Scope is proved on the location, not on the document: a run at a kitchen
    // the caller cannot reach answers exactly like one that does not exist.
    await loadLocationInScope(prisma, req, batch.locationId);
    res.json({ production: await present(batch) });
  }),
);

export default router;
