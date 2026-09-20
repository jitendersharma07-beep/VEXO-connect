import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, forbidden, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  requireBranchAccess,
  branchFilterFor,
} from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope);

const publicBranch = (b) => ({
  id: b.id,
  name: b.name,
  code: b.code,
  status: b.status,
  isDemo: b.isDemo,
  addressLine: b.addressLine,
  city: b.city,
  state: b.state,
  createdAt: b.createdAt,
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const branches = await prisma.branch.findMany({
      where: { companyId: req.companyScope.id, ...branchFilterFor(req.user) },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      branches: branches.map(publicBranch),
      branchLimit: req.license?.branchLimit ?? 0,
    });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, 'Code must be 2-12 letters, digits or dashes'),
  addressLine: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
});

router.post(
  '/',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    // The branch limit is the licence's, counted server-side at write time.
    const license = req.license;
    if (!license) throw badRequest('This company has no licence; ATC must issue one first');
    const activeBranches = await prisma.branch.count({
      where: { companyId: req.companyScope.id, status: 'ACTIVE' },
    });
    if (activeBranches >= license.branchLimit) {
      throw forbidden(
        `Your licence allows ${license.branchLimit} active branch${license.branchLimit === 1 ? '' : 'es'}. ` +
          'Contact ATC to add branch licences.',
      );
    }

    const exists = await prisma.branch.findUnique({
      where: { companyId_code: { companyId: req.companyScope.id, code: data.code } },
    });
    if (exists) throw conflict(`Branch code ${data.code} is already used in this company`);

    const branch = await prisma.branch.create({
      data: { ...data, companyId: req.companyScope.id, isDemo: req.companyScope.isDemo },
    });
    await audit(req, {
      action: 'BRANCH_CREATE',
      entity: 'Branch',
      entityId: branch.id,
      companyId: req.companyScope.id,
      meta: { name: branch.name, code: branch.code },
    });
    res.status(201).json({ branch: publicBranch(branch) });
  }),
);

router.get(
  '/:branchId',
  requireBranchAccess,
  asyncHandler(async (req, res) => {
    const users = await prisma.posUser.count({ where: { branchId: req.branch.id, status: 'ACTIVE' } });
    res.json({ branch: publicBranch(req.branch), activeUsers: users });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  addressLine: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(80).nullish(),
});

router.patch(
  '/:branchId',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER'),
  requireUsableLicense,
  requireBranchAccess,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const branch = await prisma.branch.update({ where: { id: req.branch.id }, data });
    await audit(req, {
      action: 'BRANCH_UPDATE',
      entity: 'Branch',
      entityId: branch.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ branch: publicBranch(branch) });
  }),
);

export default router;
