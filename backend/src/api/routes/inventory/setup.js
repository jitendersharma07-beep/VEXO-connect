// ENTITLEMENT(INVENTORY)
// Locations, location access grants, items, item units, suppliers, settings.
//
// The reference data everything else hangs off. Owner-only to change; visible
// to anyone with inventory.view, filtered to what they may actually reach.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import {
  requireInventoryAction,
  loadLocationInScope,
  locationScopeFilter,
} from '../../../lib/inventory/permissions.js';
import {
  normaliseUnitName,
  resolveFactorMilli,
  baseUnitChangeBlockers,
  qtyToMilli,
} from '../../../lib/inventory/units.js';
import { publicItem, publicLocation } from './shared.js';

const router = Router();

/* ---------------------------------------------------------------- locations */

const locationCreate = z.object({
  kind: z.enum(['WAREHOUSE', 'STORE', 'CENTRAL_KITCHEN']),
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,16}$/, 'Code must be 2-16 letters, digits or dashes'),
  branchId: z.string().cuid().nullish(),
  parentId: z.string().cuid().nullish(),
  storageKind: z.enum(['AMBIENT', 'DRY', 'CHILLED', 'FROZEN', 'KITCHEN', 'BAR']).optional(),
  capacityBaseQty: z.string().regex(/^\d+(\.\d{1,3})?$/).nullish(),
  isSaleSource: z.boolean().optional(),
});

router.get(
  '/locations',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const where = await locationScopeFilter(prisma, req);
    const locations = await prisma.inventoryLocation.findMany({ where, orderBy: [{ kind: 'asc' }, { code: 'asc' }] });
    res.json({ locations: locations.map(publicLocation) });
  }),
);

router.post(
  '/locations',
  requireInventoryAction('inventory.location.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = locationCreate.parse(req.body);
    const companyId = req.companyScope.id;

    let branchId = data.branchId ?? null;
    let kind = data.kind;

    // A sublocation is a place inside a place. It inherits what it is and
    // whose it is, so the two can never drift apart and leave a freezer that
    // claims to belong to a different store than the room it stands in.
    if (data.parentId) {
      const parent = await prisma.inventoryLocation.findUnique({ where: { id: data.parentId } });
      if (!parent || parent.companyId !== companyId) throw notFound('Parent location not found');
      if (parent.parentId) throw badRequest('A sublocation cannot contain another sublocation');
      branchId = parent.branchId;
      kind = parent.kind;
    }

    if (branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: branchId } });
      if (!branch || branch.companyId !== companyId) throw notFound('Branch not found');
    }
    if (kind === 'STORE' && !branchId) throw badRequest('A store stock location must belong to a store');

    const clash = await prisma.inventoryLocation.findUnique({
      where: { companyId_code: { companyId, code: data.code } },
    });
    if (clash) throw conflict(`Location code ${data.code} is already used`);

    // The one location a store's sales consume from. Held unique at the
    // database, so two locations cannot both claim a store's tills.
    let saleSourceBranchId = null;
    if (data.isSaleSource) {
      if (!branchId) throw badRequest('Only a location inside a store can be its sale source');
      if (data.parentId) throw badRequest('A sublocation cannot be the sale source; set it on the room itself');
      const existing = await prisma.inventoryLocation.findUnique({ where: { saleSourceBranchId: branchId } });
      if (existing) throw conflict(`${existing.name} is already the sale source for this store`);
      saleSourceBranchId = branchId;
    }

    const location = await prisma.inventoryLocation.create({
      data: {
        companyId,
        kind,
        name: data.name,
        code: data.code,
        branchId,
        parentId: data.parentId ?? null,
        storageKind: data.storageKind ?? 'AMBIENT',
        capacityBaseQty: data.capacityBaseQty ?? null,
        saleSourceBranchId,
      },
    });
    await audit(req, {
      action: 'INVENTORY_LOCATION_CREATE',
      entity: 'InventoryLocation',
      entityId: location.id,
      companyId,
      meta: { code: location.code, kind: location.kind, parentId: location.parentId },
    });
    res.status(201).json({ location: publicLocation(location) });
  }),
);

const locationUpdate = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  storageKind: z.enum(['AMBIENT', 'DRY', 'CHILLED', 'FROZEN', 'KITCHEN', 'BAR']).optional(),
  capacityBaseQty: z.string().regex(/^\d+(\.\d{1,3})?$/).nullish(),
});

router.patch(
  '/locations/:locationId',
  requireInventoryAction('inventory.location.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const data = locationUpdate.parse(req.body);

    if (data.status === 'ARCHIVED') {
      // Archiving a location that still holds stock would hide the stock, not
      // dispose of it. The stock has to go somewhere first.
      const held = await prisma.stockBalance.count({ where: { locationId: location.id, qty: { not: 0 } } });
      if (held > 0) throw conflict(`${location.name} still holds stock in ${held} item(s); move or write it off first`);
    }

    const updated = await prisma.inventoryLocation.update({ where: { id: location.id }, data });
    await audit(req, {
      action: 'INVENTORY_LOCATION_UPDATE',
      entity: 'InventoryLocation',
      entityId: location.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ location: publicLocation(updated) });
  }),
);

/* ------------------------------------------------------------------ grants */

const grantSchema = z.object({
  userId: z.string().cuid(),
  canDispatch: z.boolean().optional(),
  canReceive: z.boolean().optional(),
  canApprove: z.boolean().optional(),
});

router.get(
  '/locations/:locationId/access',
  requireInventoryAction('inventory.location.grant'),
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const grants = await prisma.inventoryLocationAccess.findMany({
      where: { locationId: location.id },
      include: { user: { select: { id: true, fullName: true, email: true, role: true, branchId: true } } },
    });
    res.json({
      grants: grants.map((g) => ({
        id: g.id,
        user: g.user,
        canDispatch: g.canDispatch,
        canReceive: g.canReceive,
        canApprove: g.canApprove,
      })),
    });
  }),
);

router.put(
  '/locations/:locationId/access',
  requireInventoryAction('inventory.location.grant'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const data = grantSchema.parse(req.body);

    const user = await prisma.posUser.findUnique({ where: { id: data.userId } });
    if (!user || user.companyId !== req.companyScope.id) throw notFound('User not found');
    // A cashier has no inventory rights to widen: the action check would
    // refuse every one of these verbs anyway, and a grant row that grants
    // nothing is a grant row someone will later mistake for access.
    if (user.role === 'CASHIER' || user.role === 'POS_SUPER_ADMIN') {
      throw badRequest(`${user.role} cannot be granted inventory access at a location`);
    }

    const flags = {
      canDispatch: data.canDispatch ?? false,
      canReceive: data.canReceive ?? false,
      canApprove: data.canApprove ?? false,
    };
    const grant = await prisma.inventoryLocationAccess.upsert({
      where: { userId_locationId: { userId: user.id, locationId: location.id } },
      update: { ...flags, grantedById: req.user.id },
      create: { companyId: req.companyScope.id, userId: user.id, locationId: location.id, ...flags, grantedById: req.user.id },
    });
    await audit(req, {
      action: 'INVENTORY_LOCATION_GRANT',
      entity: 'InventoryLocationAccess',
      entityId: grant.id,
      companyId: req.companyScope.id,
      meta: { userId: user.id, locationId: location.id, ...flags },
    });
    res.json({ grant: { id: grant.id, ...flags } });
  }),
);

router.delete(
  '/locations/:locationId/access/:userId',
  requireInventoryAction('inventory.location.grant'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const existing = await prisma.inventoryLocationAccess.findUnique({
      where: { userId_locationId: { userId: req.params.userId, locationId: location.id } },
    });
    if (!existing) throw notFound('Grant not found');
    await prisma.inventoryLocationAccess.delete({ where: { id: existing.id } });
    await audit(req, {
      action: 'INVENTORY_LOCATION_GRANT_REVOKE',
      entity: 'InventoryLocationAccess',
      entityId: existing.id,
      companyId: req.companyScope.id,
      meta: { userId: req.params.userId, locationId: location.id },
    });
    res.json({ revoked: true });
  }),
);

/* ---------------------------------------------------------------------- items */

const itemCreate = z.object({
  kind: z.enum(['RAW', 'SEMI_FINISHED', 'FINISHED', 'PACKAGING']),
  name: z.string().trim().min(2).max(160),
  sku: z.string().trim().max(60).nullish(),
  baseUnit: z.enum(['G', 'ML', 'PCS']),
  trackBatches: z.boolean().optional(),
  trackExpiry: z.boolean().optional(),
  variableWeight: z.boolean().optional(),
  weightUnit: z.enum(['G', 'ML']).nullish(),
  minShelfLifeDaysAtReceipt: z.number().int().min(0).max(3650).nullish(),
  openedShelfLifeHours: z.number().int().min(1).max(8760).nullish(),
});

router.get(
  '/items',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const { kind, status, q } = req.query;
    const items = await prisma.inventoryItem.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(kind ? { kind: String(kind) } : {}),
        ...(status ? { status: String(status) } : {}),
        ...(q ? { name: { contains: String(q), mode: 'insensitive' } } : {}),
      },
      include: { units: true },
      orderBy: { name: 'asc' },
    });
    res.json({ items: items.map(publicItem) });
  }),
);

router.post(
  '/items',
  requireInventoryAction('inventory.item.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = itemCreate.parse(req.body);
    if (data.variableWeight) {
      if (data.baseUnit !== 'PCS') throw badRequest('A variable-weight item is counted in pieces and weighed separately');
      if (!data.weightUnit) throw badRequest('A variable-weight item needs the unit its weight is measured in');
    }
    if (data.trackExpiry && !data.trackBatches) {
      // An expiry date belongs to a batch. Without batches there is nothing
      // for the date to be true of.
      throw badRequest('Expiry tracking requires batch tracking');
    }

    const clash = await prisma.inventoryItem.findFirst({
      where: { companyId: req.companyScope.id, name: data.name },
    });
    if (clash) throw conflict(`An item called ${data.name} already exists`);

    const item = await prisma.inventoryItem.create({
      data: { ...data, companyId: req.companyScope.id, sku: data.sku || null },
      include: { units: true },
    });
    await audit(req, {
      action: 'INVENTORY_ITEM_CREATE',
      entity: 'InventoryItem',
      entityId: item.id,
      companyId: req.companyScope.id,
      meta: { name: item.name, baseUnit: item.baseUnit, kind: item.kind },
    });
    res.status(201).json({ item: publicItem(item) });
  }),
);

const itemUpdate = itemCreate.partial().extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() });

router.patch(
  '/items/:itemId',
  requireInventoryAction('inventory.item.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.companyId !== req.companyScope.id) throw notFound('Item not found');
    const data = itemUpdate.parse(req.body);

    // Rewriting the base unit under existing movements would silently restate
    // every historical quantity. Refuse, and say exactly what is in the way.
    if (data.baseUnit && data.baseUnit !== item.baseUnit) {
      const [movementCount, balanceCount, recipeLineCount] = await Promise.all([
        prisma.stockMovement.count({ where: { itemId: item.id } }),
        prisma.stockBalance.count({ where: { itemId: item.id, qty: { not: 0 } } }),
        prisma.recipeLine.count({ where: { itemId: item.id } }),
      ]);
      const blockers = baseUnitChangeBlockers({ movementCount, balanceCount, recipeLineCount });
      if (blockers.length) {
        throw conflict(`The stock unit of ${item.name} cannot be changed: ${blockers.join('; ')}`);
      }
    }

    const updated = await prisma.inventoryItem.update({
      where: { id: item.id },
      data: { ...data, ...(data.sku === '' ? { sku: null } : {}) },
      include: { units: true },
    });
    await audit(req, {
      action: 'INVENTORY_ITEM_UPDATE',
      entity: 'InventoryItem',
      entityId: item.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ item: publicItem(updated) });
  }),
);

/* ----------------------------------------------------------------- item units */

const unitSchema = z.object({
  name: z.string().trim().min(1).max(40),
  // How many of the item's base unit are in ONE of these. A box of 12 pieces
  // is 12; a 5 kg bag of flour is 5000.
  quantityInBaseUnit: z.string().regex(/^\d+(\.\d{1,3})?$/),
});

router.post(
  '/items/:itemId/units',
  requireInventoryAction('inventory.unit.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.itemId }, include: { units: true } });
    if (!item || item.companyId !== req.companyScope.id) throw notFound('Item not found');
    const data = unitSchema.parse(req.body);
    const name = normaliseUnitName(data.name);

    // Standard units are code, not rows. Letting someone define "kg" as
    // anything but a kilogram would corrupt every historical line reading kg.
    let shadowsStandard = false;
    try {
      resolveFactorMilli(item, name, []);
      shadowsStandard = true;
    } catch {
      shadowsStandard = false;
    }
    if (shadowsStandard) throw conflict(`${name} is a standard unit and cannot be redefined`);

    const factorMilli = qtyToMilli(data.quantityInBaseUnit, 'pack size');
    if (factorMilli <= 0) throw badRequest('A pack must contain more than nothing');

    const existing = item.units.find((u) => u.name === name);
    if (existing) {
      // Changing a factor must not restate history. Lines that already used
      // this unit stored their own factor, so this only affects the next one.
      const unit = await prisma.inventoryItemUnit.update({ where: { id: existing.id }, data: { factorMilli } });
      await audit(req, {
        action: 'INVENTORY_UNIT_UPDATE',
        entity: 'InventoryItemUnit',
        entityId: unit.id,
        companyId: req.companyScope.id,
        meta: { itemId: item.id, name, from: existing.factorMilli, to: factorMilli },
      });
      return res.json({ unit: { id: unit.id, name: unit.name, factorMilli: unit.factorMilli }, restated: false });
    }

    const unit = await prisma.inventoryItemUnit.create({ data: { itemId: item.id, name, factorMilli } });
    await audit(req, {
      action: 'INVENTORY_UNIT_CREATE',
      entity: 'InventoryItemUnit',
      entityId: unit.id,
      companyId: req.companyScope.id,
      meta: { itemId: item.id, name, factorMilli },
    });
    res.status(201).json({ unit: { id: unit.id, name: unit.name, factorMilli: unit.factorMilli } });
  }),
);

router.delete(
  '/items/:itemId/units/:unitId',
  requireInventoryAction('inventory.unit.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.companyId !== req.companyScope.id) throw notFound('Item not found');
    const unit = await prisma.inventoryItemUnit.findUnique({ where: { id: req.params.unitId } });
    if (!unit || unit.itemId !== item.id) throw notFound('Unit not found');
    await prisma.inventoryItemUnit.delete({ where: { id: unit.id } });
    await audit(req, {
      action: 'INVENTORY_UNIT_DELETE',
      entity: 'InventoryItemUnit',
      entityId: unit.id,
      companyId: req.companyScope.id,
      meta: { itemId: item.id, name: unit.name },
    });
    res.json({ deleted: true });
  }),
);

/* ------------------------------------------------------------------ suppliers */

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().max(40).nullish(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'That is not a valid GSTIN')
    .nullish(),
  contactName: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(20).nullish(),
  email: z.string().trim().email().max(160).nullish(),
  address: z.string().trim().max(400).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
});

router.get(
  '/suppliers',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const suppliers = await prisma.supplier.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: { name: 'asc' },
    });
    res.json({ suppliers });
  }),
);

router.post(
  '/suppliers',
  requireInventoryAction('inventory.supplier.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = supplierSchema.parse(req.body);
    const clash = await prisma.supplier.findFirst({ where: { companyId: req.companyScope.id, name: data.name } });
    if (clash) throw conflict(`A supplier called ${data.name} already exists`);
    const supplier = await prisma.supplier.create({ data: { ...data, companyId: req.companyScope.id } });
    await audit(req, {
      action: 'INVENTORY_SUPPLIER_CREATE',
      entity: 'Supplier',
      entityId: supplier.id,
      companyId: req.companyScope.id,
      meta: { name: supplier.name },
    });
    res.status(201).json({ supplier });
  }),
);

router.patch(
  '/suppliers/:supplierId',
  requireInventoryAction('inventory.supplier.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.supplierId } });
    if (!supplier || supplier.companyId !== req.companyScope.id) throw notFound('Supplier not found');
    const data = supplierSchema.partial().extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).parse(req.body);
    const updated = await prisma.supplier.update({ where: { id: supplier.id }, data });
    await audit(req, {
      action: 'INVENTORY_SUPPLIER_UPDATE',
      entity: 'Supplier',
      entityId: supplier.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ supplier: updated });
  }),
);

/* ------------------------------------------------------------------- settings */

router.get(
  '/settings',
  requireInventoryAction('inventory.view'),
  asyncHandler(async (req, res) => {
    const settings = await prisma.inventorySettings.findUnique({ where: { companyId: req.companyScope.id } });
    res.json({
      settings: settings ?? { companyId: req.companyScope.id, purchaseTaxIsCost: true, staleCostDays: 90 },
    });
  }),
);

router.put(
  '/settings',
  requireInventoryAction('inventory.item.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = z
      .object({ purchaseTaxIsCost: z.boolean().optional(), staleCostDays: z.number().int().min(1).max(3650).optional() })
      .parse(req.body);
    const settings = await prisma.inventorySettings.upsert({
      where: { companyId: req.companyScope.id },
      update: { ...data, updatedById: req.user.id },
      create: { companyId: req.companyScope.id, ...data, updatedById: req.user.id },
    });
    await audit(req, {
      action: 'INVENTORY_SETTINGS_UPDATE',
      entity: 'InventorySettings',
      entityId: req.companyScope.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ settings });
  }),
);

export default router;
