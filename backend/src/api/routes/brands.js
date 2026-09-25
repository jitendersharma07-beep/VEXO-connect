// ENTITLEMENT(BRANDS)
//
// Brands are a dimension a store is tagged with, not a level above it. A food
// court unit selling under two names is one store with two brands — one till,
// one drawer, one day close — so the link is many-to-many and nothing about
// billing or scope reads from it.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  resolveStoreInScope,
} from '../../middleware/permissions.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicBrand = (b) => ({
  id: b.id,
  name: b.name,
  code: b.code,
  status: b.status,
  storeIds: b.storeLinks?.map((l) => l.branchId),
  storeCount: b._count?.storeLinks ?? b.storeLinks?.length,
  createdAt: b.createdAt,
});

router.get(
  '/',
  requireAction('org.brand.read'),
  asyncHandler(async (req, res) => {
    const brands = await prisma.brand.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: { name: 'asc' },
      include: { storeLinks: { select: { branchId: true } } },
    });
    res.json({ brands: brands.map(publicBrand) });
  }),
);

const codeField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,12}$/, 'Code must be 2-12 letters, digits or dashes');

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: codeField,
});

router.post(
  '/',
  requireAction('org.brand.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const clash = await prisma.brand.findFirst({
      where: { companyId: req.companyScope.id, OR: [{ code: data.code }, { name: data.name }] },
      select: { name: true, code: true },
    });
    if (clash) throw conflict(`${clash.name} (${clash.code}) already uses that name or code`);

    const brand = await prisma.brand.create({
      data: { ...data, companyId: req.companyScope.id },
      include: { storeLinks: { select: { branchId: true } } },
    });
    await audit(req, {
      action: 'BRAND_CREATE',
      entity: 'Brand',
      entityId: brand.id,
      companyId: req.companyScope.id,
      meta: { name: brand.name, code: brand.code },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ brand: publicBrand(brand) });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

router.patch(
  '/:id',
  requireAction('org.brand.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const existing = await prisma.brand.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
    });
    if (!existing) throw badRequest('Brand not found');
    if (data.name && data.name !== existing.name) {
      const clash = await prisma.brand.findFirst({
        where: { companyId: req.companyScope.id, name: data.name, id: { not: existing.id } },
        select: { id: true },
      });
      if (clash) throw conflict('Another brand already uses that name');
    }

    const brand = await prisma.brand.update({
      where: { id: existing.id },
      data,
      include: { storeLinks: { select: { branchId: true } } },
    });
    await audit(req, {
      action: 'BRAND_UPDATE',
      entity: 'Brand',
      entityId: brand.id,
      companyId: req.companyScope.id,
      meta: { before: { name: existing.name, status: existing.status }, after: { name: brand.name, status: brand.status } },
    });
    await auditPlatformWrite(req);
    res.json({ brand: publicBrand(brand) });
  }),
);

// The store list is replaced wholesale, which is how the screen works: the owner
// ticks the outlets a brand trades at and saves. Both halves are checked against
// the tenant AND the caller's own store scope, so a regional manager cannot
// attach a brand to an outlet outside their region by posting its id.
const storesSchema = z.object({ storeIds: z.array(z.string().trim().min(1)).max(500) });

router.put(
  '/:id/stores',
  requireAction('org.brand.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { storeIds } = storesSchema.parse(req.body);
    const brand = await prisma.brand.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
    });
    if (!brand) throw badRequest('Brand not found');
    if (brand.status !== 'ACTIVE') throw badRequest('That brand is archived');

    const unique = [...new Set(storeIds)];
    for (const id of unique) await resolveStoreInScope(req, id);

    const links = await prisma.$transaction(async (tx) => {
      await tx.branchBrand.deleteMany({ where: { brandId: brand.id } });
      if (unique.length) {
        await tx.branchBrand.createMany({
          data: unique.map((branchId) => ({
            brandId: brand.id,
            branchId,
            companyId: brand.companyId,
          })),
        });
      }
      return tx.branchBrand.findMany({ where: { brandId: brand.id }, select: { branchId: true } });
    });

    await audit(req, {
      action: 'BRAND_STORES_SET',
      entity: 'Brand',
      entityId: brand.id,
      companyId: req.companyScope.id,
      meta: { storeIds: unique },
    });
    await auditPlatformWrite(req);
    res.json({ brand: publicBrand({ ...brand, storeLinks: links }) });
  }),
);

export default router;
