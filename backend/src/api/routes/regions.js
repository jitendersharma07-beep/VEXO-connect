// ENTITLEMENT(REGIONS)
//
// Regions and clusters. Like brands, a dimension rather than a level: a region
// owns no money and issues no invoice. Its only operational effect is that a
// REGIONAL_MANAGER's store scope is "the stores pointing at my region", which is
// resolved in lib/permissions.js and enforced on every request.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction, auditPlatformWrite } from '../../middleware/permissions.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicRegion = (r) => ({
  id: r.id,
  name: r.name,
  code: r.code,
  parentId: r.parentId,
  status: r.status,
  storeCount: r._count?.branches,
  managerCount: r._count?.users,
  createdAt: r.createdAt,
});

router.get(
  '/',
  requireAction('org.region.read'),
  asyncHandler(async (req, res) => {
    const regions = await prisma.region.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: { name: 'asc' },
      include: { _count: { select: { branches: true, users: true } } },
    });
    res.json({ regions: regions.map(publicRegion) });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, 'Code must be 2-12 letters, digits or dashes'),
  parentId: z.string().trim().min(1).optional(),
});

// Walks up from `parentId` to make sure the chain does not come back to `id`. A
// cycle would make the scope resolver and every "stores in this region" read
// loop for ever, and Postgres will not stop it — a self-referencing FK is
// perfectly happy with A→B→A.
const assertNoCycle = async (companyId, id, parentId) => {
  let cursor = parentId;
  const seen = new Set(id ? [id] : []);
  while (cursor) {
    if (seen.has(cursor)) throw badRequest('That would make a region its own parent', 'parentId');
    seen.add(cursor);
    const row = await prisma.region.findFirst({
      where: { id: cursor, companyId },
      select: { parentId: true },
    });
    if (!row) throw badRequest('Parent region not found', 'parentId');
    cursor = row.parentId;
  }
};

router.post(
  '/',
  requireAction('org.region.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const clash = await prisma.region.findFirst({
      where: { companyId: req.companyScope.id, OR: [{ code: data.code }, { name: data.name }] },
      select: { name: true, code: true },
    });
    if (clash) throw conflict(`${clash.name} (${clash.code}) already uses that name or code`);
    if (data.parentId) await assertNoCycle(req.companyScope.id, null, data.parentId);

    const region = await prisma.region.create({
      data: { ...data, companyId: req.companyScope.id },
      include: { _count: { select: { branches: true, users: true } } },
    });
    await audit(req, {
      action: 'REGION_CREATE',
      entity: 'Region',
      entityId: region.id,
      companyId: req.companyScope.id,
      meta: { name: region.name, code: region.code, parentId: region.parentId },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ region: publicRegion(region) });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  parentId: z.string().trim().min(1).nullish(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

router.patch(
  '/:id',
  requireAction('org.region.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const existing = await prisma.region.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
      include: { _count: { select: { branches: true, users: true, children: true } } },
    });
    if (!existing) throw badRequest('Region not found');

    if (data.parentId) await assertNoCycle(req.companyScope.id, existing.id, data.parentId);

    // Archiving a region that still scopes a manager would silently widen that
    // manager to nothing (the resolver fails closed), so it is refused with the
    // reason rather than applied quietly.
    if (data.status === 'ARCHIVED' && existing.status !== 'ARCHIVED') {
      const { branches, users, children } = existing._count;
      if (branches || users || children) {
        throw badRequest(
          'Move its stores, managers and child regions elsewhere before archiving this region',
        );
      }
    }

    if (data.name && data.name !== existing.name) {
      const clash = await prisma.region.findFirst({
        where: { companyId: req.companyScope.id, name: data.name, id: { not: existing.id } },
        select: { id: true },
      });
      if (clash) throw conflict('Another region already uses that name');
    }

    const region = await prisma.region.update({
      where: { id: existing.id },
      data,
      include: { _count: { select: { branches: true, users: true } } },
    });
    await audit(req, {
      action: 'REGION_UPDATE',
      entity: 'Region',
      entityId: region.id,
      companyId: req.companyScope.id,
      meta: {
        before: { name: existing.name, parentId: existing.parentId, status: existing.status },
        after: { name: region.name, parentId: region.parentId, status: region.status },
      },
    });
    await auditPlatformWrite(req);
    res.json({ region: publicRegion(region) });
  }),
);

export default router;
