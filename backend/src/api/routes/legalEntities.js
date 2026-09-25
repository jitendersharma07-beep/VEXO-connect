// ENTITLEMENT(CORE)
//
// The registered businesses a tenant trades as. One tenant, several entities is
// ordinary — a group with a restaurant company and a catering company under one
// VEXO login — and the entity is what a tax invoice names as the seller.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction, auditPlatformWrite } from '../../middleware/permissions.js';
import { PAN_RE, CIN_RE } from '../../lib/identity.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicEntity = (e) => ({
  id: e.id,
  legalName: e.legalName,
  tradeName: e.tradeName,
  pan: e.pan,
  cin: e.cin,
  status: e.status,
  gstCount: e._count?.gstRegistrations ?? undefined,
  storeCount: e._count?.branches ?? undefined,
  createdAt: e.createdAt,
});

router.get(
  '/',
  requireAction('org.legalEntity.read'),
  asyncHandler(async (req, res) => {
    const entities = await prisma.legalEntity.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { gstRegistrations: true, branches: true } } },
    });
    res.json({ legalEntities: entities.map(publicEntity) });
  }),
);

// PAN and CIN are uppercased before validation, because a customer typing their
// own PAN in lower case has not made a mistake worth a red field.
const upper = (max) =>
  z.string().trim().toUpperCase().max(max);

const createSchema = z.object({
  legalName: z.string().trim().min(2).max(160),
  tradeName: z.string().trim().max(160).optional(),
  pan: upper(10).regex(PAN_RE, 'PAN must be 5 letters, 4 digits and a letter').optional(),
  cin: upper(21).regex(CIN_RE, 'CIN must be 21 characters').optional(),
});

router.post(
  '/',
  requireAction('org.legalEntity.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    const clash = await prisma.legalEntity.findFirst({
      where: {
        companyId: req.companyScope.id,
        OR: [{ legalName: data.legalName }, ...(data.pan ? [{ pan: data.pan }] : [])],
      },
      select: { legalName: true, pan: true },
    });
    if (clash) {
      throw conflict(
        clash.pan && clash.pan === data.pan
          ? `PAN ${data.pan} is already on ${clash.legalName}`
          : `${data.legalName} already exists in this account`,
      );
    }

    const entity = await prisma.legalEntity.create({
      data: { ...data, companyId: req.companyScope.id },
    });
    await audit(req, {
      action: 'LEGAL_ENTITY_CREATE',
      entity: 'LegalEntity',
      entityId: entity.id,
      companyId: req.companyScope.id,
      meta: { legalName: entity.legalName, pan: entity.pan },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ legalEntity: publicEntity(entity) });
  }),
);

// legalName is editable: a genuine change of name has to be recordable, and the
// invoices already issued keep the name they were issued under because that is
// frozen in Order.billingSnapshot rather than read back from here.
const updateSchema = z.object({
  legalName: z.string().trim().min(2).max(160).optional(),
  tradeName: z.string().trim().max(160).nullish(),
  pan: upper(10).regex(PAN_RE, 'PAN must be 5 letters, 4 digits and a letter').nullish(),
  cin: upper(21).regex(CIN_RE, 'CIN must be 21 characters').nullish(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

router.patch(
  '/:id',
  requireAction('org.legalEntity.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const existing = await prisma.legalEntity.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
      include: { _count: { select: { gstRegistrations: true, branches: true } } },
    });
    // A legal entity in another tenant answers exactly like one that does not
    // exist, so an id cannot be used to confirm somebody else's account.
    if (!existing) throw badRequest('Legal entity not found');

    // Archiving is safe for history — the invoices point at a snapshot, not at
    // this row — but it must not leave live stores pointing at a dead entity.
    if (data.status === 'ARCHIVED' && existing.status !== 'ARCHIVED') {
      const inUse = existing._count.gstRegistrations + existing._count.branches;
      if (inUse > 0) {
        throw badRequest(
          'Move its GST registrations and stores to another legal entity before archiving this one',
        );
      }
    }

    if (data.legalName || data.pan) {
      const clash = await prisma.legalEntity.findFirst({
        where: {
          companyId: req.companyScope.id,
          id: { not: existing.id },
          OR: [
            ...(data.legalName ? [{ legalName: data.legalName }] : []),
            ...(data.pan ? [{ pan: data.pan }] : []),
          ],
        },
        select: { legalName: true },
      });
      if (clash) throw conflict(`${clash.legalName} already uses that name or PAN`);
    }

    const entity = await prisma.legalEntity.update({ where: { id: existing.id }, data });
    await audit(req, {
      action: 'LEGAL_ENTITY_UPDATE',
      entity: 'LegalEntity',
      entityId: entity.id,
      companyId: req.companyScope.id,
      meta: {
        before: { legalName: existing.legalName, pan: existing.pan, cin: existing.cin, status: existing.status },
        after: { legalName: entity.legalName, pan: entity.pan, cin: entity.cin, status: entity.status },
      },
    });
    await auditPlatformWrite(req);
    res.json({ legalEntity: publicEntity(entity) });
  }),
);

// No DELETE. An entity that has ever issued an invoice is part of the tax
// record; archiving is the operation, and it refuses while anything live points
// at the row.

export default router;
