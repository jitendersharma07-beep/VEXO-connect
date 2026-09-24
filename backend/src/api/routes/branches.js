import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, forbidden, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  requireBranchAccess,
} from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  scopedBranchWhere,
} from '../../middleware/permissions.js';
import { mintStorePublicId, FSSAI_RE } from '../../lib/identity.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicBranch = (b) => ({
  id: b.id,
  // LANE foundation — the VEXO Store ID. Immutable, and the only identifier in
  // this object that is safe to quote anywhere outside the database.
  publicId: b.publicId,
  name: b.name,
  code: b.code,
  status: b.status,
  isDemo: b.isDemo,
  addressLine: b.addressLine,
  city: b.city,
  state: b.state,
  pincode: b.pincode,
  legalEntityId: b.legalEntityId,
  legalEntityName: b.legalEntity?.legalName ?? null,
  gstRegistrationId: b.gstRegistrationId,
  gstin: b.gstRegistration?.gstin ?? null,
  gstStateName: b.gstRegistration?.stateName ?? null,
  regionId: b.regionId,
  regionName: b.region?.name ?? null,
  brandIds: b.brandLinks?.map((l) => l.brandId),
  invoicePrefix: b.invoicePrefix,
  // The series a bill will actually carry, so the screen never has to work out
  // the fallback for itself and get it wrong.
  effectiveInvoicePrefix: b.invoicePrefix ?? b.code,
  fssaiLicenseNo: b.fssaiLicenseNo,
  fssaiValidUpto: b.fssaiValidUpto,
  createdAt: b.createdAt,
});

const include = {
  legalEntity: { select: { id: true, legalName: true } },
  gstRegistration: { select: { id: true, gstin: true, stateName: true, stateCode: true, status: true } },
  region: { select: { id: true, name: true } },
  brandLinks: { select: { brandId: true } },
};

router.get(
  '/',
  requireAction('org.store.read'),
  asyncHandler(async (req, res) => {
    const branches = await prisma.branch.findMany({
      where: { companyId: req.companyScope.id, ...scopedBranchWhere(req) },
      include,
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      branches: branches.map(publicBranch),
      branchLimit: req.license?.branchLimit ?? 0,
    });
  }),
);

const codeField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,12}$/, 'Code must be 2-12 letters, digits or dashes');

const identityFields = {
  addressLine: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').optional(),
  legalEntityId: z.string().trim().min(1).optional(),
  gstRegistrationId: z.string().trim().min(1).optional(),
  regionId: z.string().trim().min(1).optional(),
  invoicePrefix: codeField.optional(),
  fssaiLicenseNo: z.string().trim().regex(FSSAI_RE, 'An FSSAI number is 14 digits').optional(),
  fssaiValidUpto: z.coerce.date().optional(),
};

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: codeField,
  ...identityFields,
});

// A GST registration decides which legal entity a store bills as, so the two
// cannot be set independently: naming both only works when they agree, and naming
// only the registration fills the entity in.
const resolveOrgLinks = async (companyId, data, existing = {}) => {
  const out = {};

  const gstId = data.gstRegistrationId === undefined ? existing.gstRegistrationId : data.gstRegistrationId;
  let registration = null;
  if (gstId) {
    registration = await prisma.gstRegistration.findFirst({
      where: { id: gstId, companyId },
      select: { id: true, legalEntityId: true, stateCode: true, stateName: true, status: true, gstin: true },
    });
    if (!registration) throw badRequest('GST registration not found', 'gstRegistrationId');
    // Only refused when it is being CHANGED — a store already mapped to a
    // registration that was later archived must stay editable, or archiving one
    // registration would make its stores unfixable.
    if (registration.status !== 'ACTIVE' && data.gstRegistrationId !== undefined) {
      throw badRequest('That GST registration is archived', 'gstRegistrationId');
    }
    out.gstRegistrationId = registration.id;
  } else if (data.gstRegistrationId === null) {
    out.gstRegistrationId = null;
  }

  const entityId = data.legalEntityId === undefined ? existing.legalEntityId : data.legalEntityId;
  if (registration && entityId && registration.legalEntityId !== entityId) {
    throw badRequest(
      'That GST registration belongs to a different legal entity',
      'legalEntityId',
    );
  }
  const effectiveEntityId = registration?.legalEntityId ?? entityId ?? null;
  if (effectiveEntityId) {
    const entity = await prisma.legalEntity.findFirst({
      where: { id: effectiveEntityId, companyId },
      select: { id: true, status: true },
    });
    if (!entity) throw badRequest('Legal entity not found', 'legalEntityId');
    if (entity.status !== 'ACTIVE' && data.legalEntityId !== undefined) {
      throw badRequest('That legal entity is archived', 'legalEntityId');
    }
    out.legalEntityId = entity.id;
  } else if (data.legalEntityId === null) {
    out.legalEntityId = null;
  }

  if (data.regionId !== undefined) {
    if (data.regionId === null) {
      out.regionId = null;
    } else {
      const region = await prisma.region.findFirst({
        where: { id: data.regionId, companyId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!region) throw badRequest('Region not found', 'regionId');
      out.regionId = region.id;
    }
  }

  return { patch: out, registration };
};

// Two stores in one tenant producing the same invoice series would collide on
// (companyId, invoiceNumber) at bill time — a failure the cashier would meet
// mid-service, so it is refused here instead. Checked against both `code` and
// `invoicePrefix`, because either is a live series for some store.
const assertPrefixFree = async (companyId, prefix, selfId) => {
  if (!prefix) return;
  const clash = await prisma.branch.findFirst({
    where: {
      companyId,
      id: selfId ? { not: selfId } : undefined,
      OR: [{ code: prefix }, { invoicePrefix: prefix }],
    },
    select: { name: true },
  });
  if (clash) throw conflict(`${clash.name} already issues invoices under ${prefix}`);
};

router.post(
  '/',
  requireAction('org.store.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    // The branch limit is the licence's, counted server-side at write time.
    const license = req.license;
    if (!license) throw badRequest('This company has no licence; VEXO must issue one first');
    const activeBranches = await prisma.branch.count({
      where: { companyId: req.companyScope.id, status: 'ACTIVE' },
    });
    if (activeBranches >= license.branchLimit) {
      throw forbidden(
        `Your licence allows ${license.branchLimit} active branch${license.branchLimit === 1 ? '' : 'es'}. ` +
          'Contact VEXO to add branch licences.',
      );
    }

    const exists = await prisma.branch.findUnique({
      where: { companyId_code: { companyId: req.companyScope.id, code: data.code } },
    });
    if (exists) throw conflict(`Branch code ${data.code} is already used in this company`);

    const { patch, registration } = await resolveOrgLinks(req.companyScope.id, data);
    await assertPrefixFree(req.companyScope.id, data.invoicePrefix ?? data.code, null);

    const { legalEntityId, gstRegistrationId, regionId, ...rest } = data;
    const branch = await prisma.$transaction(async (tx) => {
      // The series letters come from the GST registration's state when there is
      // one and the typed address otherwise. Frozen here for good: this is a
      // mnemonic, not a live claim about where the store is, so a later remap
      // must never rewrite it.
      const publicId = await mintStorePublicId(tx, {
        stateCode: registration?.stateCode,
        stateName: registration?.stateName ?? data.state,
      });
      return tx.branch.create({
        data: {
          ...rest,
          ...patch,
          publicId,
          companyId: req.companyScope.id,
          isDemo: req.companyScope.isDemo,
        },
        include,
      });
    });

    await audit(req, {
      action: 'BRANCH_CREATE',
      entity: 'Branch',
      entityId: branch.id,
      companyId: req.companyScope.id,
      meta: {
        name: branch.name,
        code: branch.code,
        publicId: branch.publicId,
        gstRegistrationId: branch.gstRegistrationId,
      },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ branch: publicBranch(branch) });
  }),
);

router.get(
  '/:branchId',
  requireAction('org.store.read'),
  requireBranchAccess,
  asyncHandler(async (req, res) => {
    const [branch, users] = await Promise.all([
      prisma.branch.findUnique({ where: { id: req.branch.id }, include }),
      prisma.posUser.count({ where: { branchId: req.branch.id, status: 'ACTIVE' } }),
    ]);
    res.json({ branch: publicBranch(branch), activeUsers: users });
  }),
);

// `code` and `publicId` are absent. publicId is the immutable identity; `code`
// is the default invoice series, and a store that has issued bills under it
// cannot quietly start issuing them under another — set `invoicePrefix` instead,
// which relabels future bills while the counter keeps counting.
const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  addressLine: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(80).nullish(),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').nullish(),
  legalEntityId: z.string().trim().min(1).nullish(),
  gstRegistrationId: z.string().trim().min(1).nullish(),
  regionId: z.string().trim().min(1).nullish(),
  invoicePrefix: codeField.nullish(),
  fssaiLicenseNo: z.string().trim().regex(FSSAI_RE, 'An FSSAI number is 14 digits').nullish(),
  fssaiValidUpto: z.coerce.date().nullish(),
});

router.patch(
  '/:branchId',
  requireAction('org.store.write'),
  requireUsableLicense,
  requireBranchAccess,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const before = req.branch;

    const { patch } = await resolveOrgLinks(req.companyScope.id, data, before);
    if (data.invoicePrefix !== undefined) {
      await assertPrefixFree(req.companyScope.id, data.invoicePrefix ?? before.code, before.id);
    }

    const { legalEntityId, gstRegistrationId, regionId, ...rest } = data;
    const branch = await prisma.branch.update({
      where: { id: before.id },
      data: { ...rest, ...patch },
      include,
    });

    await audit(req, {
      action: 'BRANCH_UPDATE',
      entity: 'Branch',
      entityId: branch.id,
      companyId: req.companyScope.id,
      meta: {
        // publicId appears on both sides and is identical on both, which is the
        // evidence that renaming a store did not touch its identity.
        before: {
          publicId: before.publicId,
          name: before.name,
          status: before.status,
          gstRegistrationId: before.gstRegistrationId,
          invoicePrefix: before.invoicePrefix,
        },
        after: {
          publicId: branch.publicId,
          name: branch.name,
          status: branch.status,
          gstRegistrationId: branch.gstRegistrationId,
          invoicePrefix: branch.invoicePrefix,
        },
      },
    });
    await auditPlatformWrite(req);
    res.json({ branch: publicBranch(branch) });
  }),
);

export default router;
