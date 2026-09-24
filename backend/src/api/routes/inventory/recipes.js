// ENTITLEMENT(INVENTORY)
// Recipes, what a sale consumed, and the only way sold stock comes back.
//
// A recipe is versioned and a version is frozen the moment it goes ACTIVE.
// Changing what a latte contains is a new version, never an edit, because a
// sale records the version id it consumed and a report run next year has to
// be able to say what that meant at the time. Editing in place would silently
// restate every historical cost.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter } from '../../../lib/inventory/permissions.js';
import { returnSaleStock } from '../../../lib/inventory/consumption.js';
import { milliToQty } from '../../../lib/inventory/units.js';
import { idemKey, loadItem, qtyOut, qtyString, reasonString, toBase } from './shared.js';

const router = Router();

const VERSION_INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' }, include: { item: { select: { id: true, name: true, sku: true, baseUnit: true } } } },
};

const publicVersion = (v) => ({
  id: v.id,
  version: v.version,
  status: v.status,
  yieldPercent: String(v.yieldPercent),
  outputQty: qtyOut(v.outputQty),
  note: v.note,
  createdAt: v.createdAt,
  activatedAt: v.activatedAt,
  retiredAt: v.retiredAt,
  lines: (v.lines ?? []).map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    item: l.item,
    itemId: l.itemId,
    // Both: what somebody typed, and what the ledger will actually take. A
    // screen that shows only qtyBase turns "2 cases" into "48000 g".
    qty: qtyOut(l.qty),
    unit: l.unit,
    qtyBase: qtyOut(l.qtyBase),
  })),
});

const publicRecipe = (r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  outputItemId: r.outputItemId,
  outputItem: r.outputItem ? { id: r.outputItem.id, name: r.outputItem.name, baseUnit: r.outputItem.baseUnit } : null,
  versions: (r.versions ?? []).map(publicVersion),
  links: (r.productLinks ?? []).map((l) => ({
    id: l.id,
    productId: l.productId,
    variantId: l.variantId,
    product: l.product ? { id: l.product.id, name: l.product.name } : undefined,
  })),
  createdAt: r.createdAt,
});

/* ------------------------------------------------------------------ recipes */

router.get(
  '/recipes',
  requireInventoryAction('inventory.recipe.view'),
  asyncHandler(async (req, res) => {
    const recipes = await prisma.recipe.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: { name: 'asc' },
      include: {
        outputItem: { select: { id: true, name: true, baseUnit: true } },
        versions: { where: { status: 'ACTIVE' }, include: VERSION_INCLUDE },
        productLinks: { include: { product: { select: { id: true, name: true } } } },
      },
    });
    res.json({ recipes: recipes.map(publicRecipe) });
  }),
);

router.get(
  '/recipes/:recipeId',
  requireInventoryAction('inventory.recipe.view'),
  asyncHandler(async (req, res) => {
    const recipe = await prisma.recipe.findUnique({
      where: { id: req.params.recipeId },
      include: {
        outputItem: { select: { id: true, name: true, baseUnit: true } },
        versions: { orderBy: { version: 'desc' }, include: VERSION_INCLUDE },
        productLinks: { include: { product: { select: { id: true, name: true } } } },
      },
    });
    if (!recipe || recipe.companyId !== req.companyScope.id) throw notFound('Recipe not found');
    res.json({ recipe: publicRecipe(recipe) });
  }),
);

router.post(
  '/recipes',
  requireInventoryAction('inventory.recipe.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120),
        outputItemId: z.string().cuid().nullish(),
      })
      .parse(req.body);

    if (body.outputItemId) await loadItem(prisma, req.companyScope.id, body.outputItemId);

    const existing = await prisma.recipe.findUnique({
      where: { companyId_name: { companyId: req.companyScope.id, name: body.name } },
    });
    if (existing) throw conflict('A recipe with that name already exists');

    const recipe = await prisma.recipe.create({
      data: { companyId: req.companyScope.id, name: body.name, outputItemId: body.outputItemId ?? null },
      include: { outputItem: { select: { id: true, name: true, baseUnit: true } }, versions: true, productLinks: true },
    });

    await audit(req, {
      action: 'INVENTORY_RECIPE_CREATE',
      entity: 'Recipe',
      entityId: recipe.id,
      companyId: req.companyScope.id,
      meta: { name: recipe.name },
    });
    res.status(201).json({ recipe: publicRecipe(recipe) });
  }),
);

/* ----------------------------------------------------------------- versions */

const versionSchema = z.object({
  // Percent of the nominal output actually obtained. 100 means no loss; it is
  // never 0, which would ask the ledger to divide by nothing.
  yieldPercent: z.string().trim().regex(/^\d+(\.\d{1,3})?$/).optional(),
  outputQty: qtyString.optional(),
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().cuid(),
        qty: qtyString,
        unit: z.string().trim().min(1).max(40),
      }),
    )
    .min(1)
    .max(200),
});

router.post(
  '/recipes/:recipeId/versions',
  requireInventoryAction('inventory.recipe.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = versionSchema.parse(req.body);
    const recipe = await prisma.recipe.findUnique({ where: { id: req.params.recipeId } });
    if (!recipe || recipe.companyId !== req.companyScope.id) throw notFound('Recipe not found');

    if (body.yieldPercent !== undefined && Number(body.yieldPercent) <= 0) {
      throw badRequest('Yield must be greater than zero');
    }
    if (body.outputQty !== undefined && Number(body.outputQty) <= 0) {
      throw badRequest('Output quantity must be greater than zero');
    }

    // Converted here, not at consumption time, and the entered unit is kept
    // beside the base quantity. The factor is applied once and frozen: if
    // "case" is redefined next year this version still means what it meant.
    const lines = [];
    let lineNo = 0;
    for (const l of body.lines) {
      const item = await loadItem(prisma, req.companyScope.id, l.itemId);
      const { baseMilli } = toBase(item, l.qty, l.unit);
      if (baseMilli <= 0) throw badRequest(`${item.name} must be a positive quantity`);
      lines.push({ lineNo: ++lineNo, itemId: item.id, qty: l.qty, unit: l.unit, qtyBase: milliToQty(baseMilli) });
    }

    const version = await prisma.$transaction(async (tx) => {
      const last = await tx.recipeVersion.findFirst({
        where: { recipeId: recipe.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      return tx.recipeVersion.create({
        data: {
          recipeId: recipe.id,
          version: (last?.version ?? 0) + 1,
          status: 'DRAFT',
          yieldPercent: body.yieldPercent ?? '100',
          outputQty: body.outputQty ?? '1',
          note: body.note ?? null,
          createdById: req.user.id,
          lines: { create: lines },
        },
        include: VERSION_INCLUDE,
      });
    });

    await audit(req, {
      action: 'INVENTORY_RECIPE_VERSION_CREATE',
      entity: 'Recipe',
      entityId: recipe.id,
      companyId: req.companyScope.id,
      meta: { version: version.version, lines: lines.length },
    });
    res.status(201).json({ version: publicVersion(version) });
  }),
);

router.post(
  '/recipes/:recipeId/versions/:versionId/activate',
  requireInventoryAction('inventory.recipe.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const recipe = await prisma.recipe.findUnique({ where: { id: req.params.recipeId } });
    if (!recipe || recipe.companyId !== req.companyScope.id) throw notFound('Recipe not found');
    const version = await prisma.recipeVersion.findUnique({ where: { id: req.params.versionId } });
    if (!version || version.recipeId !== recipe.id) throw notFound('Recipe version not found');
    if (version.status === 'RETIRED') throw conflict('A retired version cannot be activated again');
    if (version.status === 'ACTIVE') return res.json({ version: publicVersion(version), changed: false });

    // Exactly one ACTIVE version at a time, swapped in one transaction. Two
    // active versions would make "what does this dish consume" ambiguous, and
    // a gap with none would silently stop deducting stock.
    const activated = await prisma.$transaction(async (tx) => {
      await tx.recipeVersion.updateMany({
        where: { recipeId: recipe.id, status: 'ACTIVE' },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      return tx.recipeVersion.update({
        where: { id: version.id },
        data: { status: 'ACTIVE', activatedById: req.user.id, activatedAt: new Date() },
        include: VERSION_INCLUDE,
      });
    });

    await audit(req, {
      action: 'INVENTORY_RECIPE_VERSION_ACTIVATE',
      entity: 'Recipe',
      entityId: recipe.id,
      companyId: req.companyScope.id,
      meta: { version: activated.version },
    });
    res.json({ version: publicVersion(activated), changed: true });
  }),
);

/* -------------------------------------------------------------------- links */

router.post(
  '/recipes/:recipeId/links',
  requireInventoryAction('inventory.recipe.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ productId: z.string().cuid(), variantId: z.string().cuid().nullish() })
      .parse(req.body);
    const recipe = await prisma.recipe.findUnique({ where: { id: req.params.recipeId } });
    if (!recipe || recipe.companyId !== req.companyScope.id) throw notFound('Recipe not found');

    const product = await prisma.product.findUnique({ where: { id: body.productId } });
    if (!product || product.companyId !== req.companyScope.id) throw notFound('Product not found');
    if (body.variantId) {
      const variant = await prisma.productVariant.findUnique({ where: { id: body.variantId } });
      if (!variant || variant.productId !== product.id) throw notFound('Variant not found');
    }

    // variantKey is '' for "the product itself" so one unique index can hold
    // both rules at once; NULLs compare distinct and would let a product take
    // two default recipes.
    const variantKey = body.variantId ?? '';
    const link = await prisma.recipeProductLink.upsert({
      where: { productId_variantKey: { productId: product.id, variantKey } },
      update: { recipeId: recipe.id },
      create: {
        companyId: req.companyScope.id,
        productId: product.id,
        variantId: body.variantId ?? null,
        variantKey,
        recipeId: recipe.id,
      },
      include: { product: { select: { id: true, name: true } } },
    });

    await audit(req, {
      action: 'INVENTORY_RECIPE_LINK',
      entity: 'Recipe',
      entityId: recipe.id,
      companyId: req.companyScope.id,
      meta: { productId: product.id, variantId: body.variantId ?? null },
    });
    res.status(201).json({
      link: { id: link.id, productId: link.productId, variantId: link.variantId, recipeId: link.recipeId },
    });
  }),
);

/* ---------------------------------------------------------------- modifiers */

router.post(
  '/recipe-modifiers',
  requireInventoryAction('inventory.recipe.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        modifierId: z.string().trim().min(1).max(60),
        // Null/absent = applies to whatever recipe it is sold with.
        recipeId: z.string().cuid().nullish(),
        itemId: z.string().cuid(),
        // Signed: "extra shot" is +, "no cheese" is −.
        qtyDelta: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
        unit: z.string().trim().min(1).max(40),
      })
      .parse(req.body);

    if (!/^-?\d+(\.\d{1,3})?$/.test(body.qtyDelta)) throw badRequest('qtyDelta must be a number with at most 3 decimals');
    if (Number(body.qtyDelta) === 0) throw badRequest('A modifier that changes nothing needs no row');

    const item = await loadItem(prisma, req.companyScope.id, body.itemId);
    const negative = body.qtyDelta.startsWith('-');
    const { baseMilli } = toBase(item, negative ? body.qtyDelta.slice(1) : body.qtyDelta, body.unit);
    const deltaBase = milliToQty(negative ? -baseMilli : baseMilli);

    let recipeKey = '';
    if (body.recipeId) {
      const recipe = await prisma.recipe.findUnique({ where: { id: body.recipeId } });
      if (!recipe || recipe.companyId !== req.companyScope.id) throw notFound('Recipe not found');
      recipeKey = recipe.id;
    }

    const row = await prisma.recipeModifierAdjustment.upsert({
      where: {
        companyId_modifierId_recipeKey_itemId: {
          companyId: req.companyScope.id,
          modifierId: body.modifierId,
          recipeKey,
          itemId: item.id,
        },
      },
      update: { qtyDelta: deltaBase },
      create: {
        companyId: req.companyScope.id,
        modifierId: body.modifierId,
        recipeId: body.recipeId ?? null,
        recipeKey,
        itemId: item.id,
        qtyDelta: deltaBase,
      },
    });

    await audit(req, {
      action: 'INVENTORY_RECIPE_MODIFIER_SET',
      entity: 'Recipe',
      entityId: recipeKey || 'ANY',
      companyId: req.companyScope.id,
      meta: { modifierId: body.modifierId, itemId: item.id, qtyDelta: deltaBase },
    });
    res.status(201).json({
      adjustment: {
        id: row.id,
        modifierId: row.modifierId,
        recipeId: row.recipeId,
        itemId: row.itemId,
        qtyDelta: qtyOut(row.qtyDelta),
      },
    });
  }),
);

/* ------------------------------------------------------- sale consumption */

const publicConsumption = (c) => ({
  id: c.id,
  orderId: c.orderId,
  orderItemId: c.orderItemId,
  branchId: c.branchId,
  locationId: c.locationId,
  recipeVersionId: c.recipeVersionId,
  status: c.status,
  uncostedReason: c.uncostedReason,
  qtySold: c.qtySold,
  returnedQty: c.returnedQty,
  // Paise, as a string. A cost of 0 with costStatus MISSING means "we do not
  // know what this cost", never "this was free" — VC-105 reads both fields.
  costPaise: String(c.costPaise),
  costStatus: c.costStatus,
  costBasisAt: c.costBasisAt,
  occurredAt: c.occurredAt,
});

router.get(
  '/sales/consumptions',
  requireInventoryAction('inventory.report.view'),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        orderId: z.string().cuid().optional(),
        status: z.enum(['POSTED', 'UNCOSTED']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);

    // Scope by the stock location, not the branch: a manager may see what
    // their own store consumed and nothing from a store they cannot reach.
    // Rows with no location (a branch with no sale source) are the owner's.
    const scope = await locationScopeFilter(prisma, req);
    const reachable = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const ids = reachable.map((r) => r.id);
    const where = {
      companyId: req.companyScope.id,
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lt: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(req.user.role === 'CUSTOMER_OWNER' ? {} : { locationId: { in: ids } }),
    };

    const consumptions = await prisma.saleConsumption.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
    });

    // Counted from the rows, not assumed. An uncosted line is a hole in the
    // margin report and the screen has to be able to say how many there are.
    res.json({
      consumptions: consumptions.map(publicConsumption),
      summary: {
        lines: consumptions.length,
        uncostedLines: consumptions.filter((c) => c.status === 'UNCOSTED').length,
        linesWithUnknownCost: consumptions.filter((c) => c.costStatus === 'MISSING').length,
        linesWithEstimatedCost: consumptions.filter((c) => c.costStatus === 'ESTIMATED').length,
        costPaise: String(consumptions.reduce((a, c) => a + BigInt(c.costPaise), 0n)),
      },
    });
  }),
);

// The explicit physical return. A refund does not come here — refunding money
// is a decision about the till, and this is a decision about the shelf. They
// are deliberately two actions, because the overwhelmingly common case is a
// customer who is unhappy with food they have already eaten.
router.post(
  '/sales/consumptions/:consumptionId/return',
  requireInventoryAction('inventory.sale.return'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        qty: z.coerce.number().int().min(1).max(10000),
        reason: reasonString,
        idempotencyKey: idemKey,
      })
      .parse(req.body);

    const consumption = await prisma.saleConsumption.findUnique({ where: { id: req.params.consumptionId } });
    if (!consumption || consumption.companyId !== req.companyScope.id) throw notFound('Sale line not found');
    if (consumption.status !== 'POSTED' || !consumption.locationId) {
      throw conflict('That sale line never took stock, so there is nothing to put back');
    }
    // Returning stock puts goods INTO a location, so it is a receive right at
    // that location — checked on the server, for this request, every time.
    await loadLocationInScope(prisma, req, consumption.locationId, 'receive');

    const key = body.idempotencyKey ?? `${req.user.id}:${Date.now()}`;
    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: returnedQty is the number the limit
      // check depends on, and two returns racing on the last portion must not
      // both read "one left".
      const fresh = await tx.saleConsumption.findUnique({ where: { id: consumption.id } });
      try {
        return await returnSaleStock(tx, {
          consumption: fresh,
          qty: body.qty,
          reason: body.reason,
          idempotencyKey: key,
          userId: req.user.id,
        });
      } catch (e) {
        if (e.code === 'RETURN_EXCEEDS_SOLD') throw conflict(e.message);
        throw e;
      }
    });

    await audit(req, {
      action: 'INVENTORY_SALE_RETURN',
      entity: 'SaleConsumption',
      entityId: consumption.id,
      companyId: req.companyScope.id,
      meta: { qty: body.qty, reason: body.reason, orderId: consumption.orderId, posted: result.posted },
    });

    const after = await prisma.saleConsumption.findUnique({ where: { id: consumption.id } });
    res.status(result.posted ? 201 : 200).json({
      stockReturn: {
        id: result.stockReturn.id,
        qty: result.stockReturn.qty,
        reason: result.stockReturn.reason,
        valuePaise: String(result.stockReturn.valuePaise),
      },
      consumption: publicConsumption(after),
      movements: result.movements.length,
    });
  }),
);

export default router;
