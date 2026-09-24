// ENTITLEMENT(MULTI_GST)
//
// GST registrations under a tenant's legal entities. A store maps to exactly one
// of these, and that mapping decides the GSTIN, the state and the invoice series
// a bill is issued under. Several stores may share one registration — a chain
// with four outlets in Delhi bills all four under one Delhi GSTIN — which is why
// the mapping lives on the store rather than being implied by geography.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction, auditPlatformWrite } from '../../middleware/permissions.js';
import { GSTIN_RE, panFromGstin, stateNameFor } from '../../lib/identity.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicRegistration = (r) => ({
  id: r.id,
  legalEntityId: r.legalEntityId,
  legalEntityName: r.legalEntity?.legalName,
  gstin: r.gstin,
  tradeName: r.tradeName,
  stateCode: r.stateCode,
  stateName: r.stateName,
  addressLine: r.addressLine,
  city: r.city,
  pincode: r.pincode,
  status: r.status,
  storeCount: r._count?.branches ?? undefined,
  createdAt: r.createdAt,
});

router.get(
  '/',
  requireAction('org.gst.read'),
  asyncHandler(async (req, res) => {
    const registrations = await prisma.gstRegistration.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: [{ stateCode: 'asc' }, { createdAt: 'asc' }],
      include: {
        legalEntity: { select: { legalName: true } },
        _count: { select: { branches: true } },
      },
    });
    res.json({ gstRegistrations: registrations.map(publicRegistration) });
  }),
);

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_RE, 'GSTIN must be 15 characters: 2 state digits, a PAN, an entity digit, Z and a check character');

const createSchema = z.object({
  legalEntityId: z.string().trim().min(1),
  gstin,
  tradeName: z.string().trim().max(160).optional(),
  addressLine: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').optional(),
});

router.post(
  '/',
  requireAction('org.gst.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    const entity = await prisma.legalEntity.findFirst({
      where: { id: data.legalEntityId, companyId: req.companyScope.id },
      select: { id: true, legalName: true, pan: true, status: true },
    });
    if (!entity) throw badRequest('Legal entity not found', 'legalEntityId');
    if (entity.status !== 'ACTIVE') {
      throw badRequest('That legal entity is archived', 'legalEntityId');
    }

    // The PAN sits inside the GSTIN at characters 3-12. Comparing it to the
    // entity's PAN catches a registration filed under the wrong company — a
    // real mistake, and one nothing else would notice until an invoice had
    // already been issued with the wrong seller on it.
    const embeddedPan = panFromGstin(data.gstin);
    if (entity.pan && embeddedPan && entity.pan !== embeddedPan) {
      throw badRequest(
        `This GSTIN belongs to PAN ${embeddedPan}, but ${entity.legalName} is ${entity.pan}`,
        'gstin',
      );
    }

    const stateCode = data.gstin.slice(0, 2);
    const stateName = stateNameFor(stateCode);
    // Refused rather than stored blank: an unknown state code means the GSTIN is
    // wrong, and a registration with no state cannot decide a place of supply.
    if (!stateName) throw badRequest(`${stateCode} is not a valid GST state code`, 'gstin');

    const exists = await prisma.gstRegistration.findUnique({
      where: { companyId_gstin: { companyId: req.companyScope.id, gstin: data.gstin } },
      select: { id: true },
    });
    if (exists) throw conflict('That GSTIN is already registered in this account');

    const registration = await prisma.gstRegistration.create({
      data: { ...data, stateCode, stateName, companyId: req.companyScope.id },
      include: { legalEntity: { select: { legalName: true } } },
    });
    await audit(req, {
      action: 'GST_REGISTRATION_CREATE',
      entity: 'GstRegistration',
      entityId: registration.id,
      companyId: req.companyScope.id,
      meta: { gstin: registration.gstin, stateCode, legalEntityId: entity.id },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ gstRegistration: publicRegistration(registration) });
  }),
);

// gstin, stateCode and stateName are absent on purpose. The GSTIN *is* the
// identity of this row — editing it would silently move every store mapped here
// onto a different registration, and every invoice already issued would have
// been issued under the old one. A corrected GSTIN is a new registration and a
// remap, which leaves both facts in the record.
const updateSchema = z.object({
  tradeName: z.string().trim().max(160).nullish(),
  addressLine: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(80).nullish(),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').nullish(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

router.patch(
  '/:id',
  requireAction('org.gst.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const existing = await prisma.gstRegistration.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
    });
    if (!existing) throw badRequest('GST registration not found');

    if (data.status === 'ARCHIVED' && existing.status !== 'ARCHIVED') {
      const mapped = await prisma.branch.findMany({
        where: { gstRegistrationId: existing.id },
        select: { name: true },
        take: 5,
      });
      if (mapped.length) {
        // Named, not counted: "3 stores" makes the owner go looking, and the
        // whole point of the refusal is to tell them where to look.
        throw badRequest(
          `Remap ${mapped.map((b) => b.name).join(', ')} to another GST registration before archiving this one`,
        );
      }
    }

    const registration = await prisma.gstRegistration.update({
      where: { id: existing.id },
      data,
      include: { legalEntity: { select: { legalName: true } } },
    });
    await audit(req, {
      action: 'GST_REGISTRATION_UPDATE',
      entity: 'GstRegistration',
      entityId: registration.id,
      companyId: req.companyScope.id,
      meta: {
        gstin: registration.gstin,
        before: { status: existing.status, tradeName: existing.tradeName, addressLine: existing.addressLine },
        after: { status: registration.status, tradeName: registration.tradeName, addressLine: registration.addressLine },
      },
    });
    await auditPlatformWrite(req);
    res.json({ gstRegistration: publicRegistration(registration) });
  }),
);

// No DELETE — see the archive refusal above. A registration under which invoices
// were issued is part of the tax record.

export default router;
