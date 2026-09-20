import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, notFound, badRequest } from '../../lib/errors.js';
import { hashPassword, randomPassword } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth } from '../../middleware/auth.js';
import { requireAtc } from '../../middleware/rbac.js';
import { withDerived } from '../../lib/license.js';

// ATC-side console: customer onboarding and licence control. Access, expiry
// and branch limits are decided here and only here — nothing a customer can
// reach writes to these tables.
const router = Router();

router.use(requirePosAuth, requireAtc);

const publicCompany = (c) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  status: c.status,
  isDemo: c.isDemo,
  contactName: c.contactName,
  contactEmail: c.contactEmail,
  contactPhone: c.contactPhone,
  city: c.city,
  state: c.state,
  createdAt: c.createdAt,
  branches: c._count?.branches,
  users: c._count?.users,
});

router.get(
  '/companies',
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({
      include: { _count: { select: { branches: true, users: true } }, licenses: { orderBy: { createdAt: 'desc' }, take: 1, include: { addons: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      companies: companies.map((c) => ({
        ...publicCompany(c),
        license: c.licenses[0]
          ? (({ plan, effectiveStatus, expiresAt, branchLimit }) => ({ plan, status: effectiveStatus, expiresAt, branchLimit }))(
              withDerived(c.licenses[0]),
            )
          : null,
      })),
    });
  }),
);

const companySchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, 'Slug must be 2-40 lowercase letters, digits or dashes'),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().toLowerCase().email().optional(),
  contactPhone: z.string().trim().max(20).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  isDemo: z.boolean().optional(),
});

router.post(
  '/companies',
  asyncHandler(async (req, res) => {
    const data = companySchema.parse(req.body);
    const exists = await prisma.company.findUnique({ where: { slug: data.slug } });
    if (exists) throw conflict(`Company slug "${data.slug}" is already taken`);
    const company = await prisma.company.create({ data });
    await audit(req, {
      action: 'COMPANY_CREATE',
      entity: 'Company',
      entityId: company.id,
      companyId: company.id,
      meta: { name: company.name, slug: company.slug, isDemo: company.isDemo },
    });
    res.status(201).json({ company: publicCompany(company) });
  }),
);

const loadCompany = asyncHandler(async (req, _res, next) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
  if (!company) throw notFound('Company not found');
  req.company = company;
  next();
});

router.get(
  '/companies/:companyId',
  loadCompany,
  asyncHandler(async (req, res) => {
    const [branches, users, licenses] = await Promise.all([
      prisma.branch.findMany({ where: { companyId: req.company.id }, orderBy: { createdAt: 'asc' } }),
      prisma.posUser.findMany({
        where: { companyId: req.company.id },
        select: { id: true, email: true, fullName: true, role: true, status: true, branchId: true, lastLoginAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.license.findMany({
        where: { companyId: req.company.id },
        include: { addons: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    res.json({
      company: publicCompany(req.company),
      branches,
      users,
      licenses: licenses.map((l) => {
        const d = withDerived(l);
        return {
          id: l.id,
          plan: l.plan,
          status: d.effectiveStatus,
          storedStatus: l.status,
          startsAt: l.startsAt,
          expiresAt: l.expiresAt,
          baseBranchLimit: l.baseBranchLimit,
          branchLimit: d.branchLimit,
          notes: l.notes,
          createdAt: l.createdAt,
          addons: l.addons,
        };
      }),
    });
  }),
);

const companyStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING']) });

router.patch(
  '/companies/:companyId/status',
  loadCompany,
  asyncHandler(async (req, res) => {
    const { status } = companyStatusSchema.parse(req.body);
    const company = await prisma.company.update({ where: { id: req.company.id }, data: { status } });
    if (status === 'SUSPENDED') {
      // Suspension is immediate: every live session of that company ends now.
      await prisma.posSession.updateMany({
        where: { revokedAt: null, user: { companyId: company.id } },
        data: { revokedAt: new Date() },
      });
    }
    await audit(req, {
      action: 'COMPANY_STATUS',
      entity: 'Company',
      entityId: company.id,
      companyId: company.id,
      meta: { status },
    });
    res.json({ company: publicCompany(company) });
  }),
);

const licenseSchema = z.object({
  plan: z.enum(['FREE_TRIAL', 'SINGLE_STORE', 'MULTI_STORE']),
  expiresAt: z.coerce.date(),
  startsAt: z.coerce.date().optional(),
  baseBranchLimit: z.number().int().min(1).max(500).optional(),
  notes: z.string().trim().max(500).optional(),
});

router.post(
  '/companies/:companyId/licenses',
  loadCompany,
  asyncHandler(async (req, res) => {
    const data = licenseSchema.parse(req.body);
    if (data.expiresAt <= new Date()) throw badRequest('expiresAt must be in the future', 'expiresAt');
    const license = await prisma.license.create({
      data: {
        companyId: req.company.id,
        plan: data.plan,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
        baseBranchLimit: data.plan === 'SINGLE_STORE' ? 1 : (data.baseBranchLimit ?? 1),
        notes: data.notes,
        createdById: req.user.id,
      },
      include: { addons: true },
    });
    await audit(req, {
      action: 'LICENSE_ISSUE',
      entity: 'License',
      entityId: license.id,
      companyId: req.company.id,
      meta: { plan: license.plan, expiresAt: license.expiresAt, baseBranchLimit: license.baseBranchLimit },
    });
    const d = withDerived(license);
    res.status(201).json({ license: { ...license, status: d.effectiveStatus, branchLimit: d.branchLimit } });
  }),
);

const addonSchema = z.object({
  quantity: z.number().int().min(1).max(100),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
});

router.post(
  '/licenses/:licenseId/addons',
  asyncHandler(async (req, res) => {
    const data = addonSchema.parse(req.body);
    const license = await prisma.license.findUnique({ where: { id: req.params.licenseId } });
    if (!license) throw notFound('License not found');
    if (license.plan !== 'MULTI_STORE') {
      throw badRequest('Branch add-ons apply to MULTI_STORE licences only');
    }
    const addon = await prisma.licenseAddon.create({
      data: { licenseId: license.id, quantity: data.quantity, expiresAt: data.expiresAt, notes: data.notes },
    });
    await audit(req, {
      action: 'LICENSE_ADDON',
      entity: 'LicenseAddon',
      entityId: addon.id,
      companyId: license.companyId,
      meta: { quantity: addon.quantity, expiresAt: addon.expiresAt },
    });
    res.status(201).json({ addon });
  }),
);

const licenseStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']) });

router.patch(
  '/licenses/:licenseId/status',
  asyncHandler(async (req, res) => {
    const { status } = licenseStatusSchema.parse(req.body);
    const existing = await prisma.license.findUnique({ where: { id: req.params.licenseId } });
    if (!existing) throw notFound('License not found');
    const license = await prisma.license.update({
      where: { id: existing.id },
      data: { status },
      include: { addons: true },
    });
    await audit(req, {
      action: 'LICENSE_STATUS',
      entity: 'License',
      entityId: license.id,
      companyId: license.companyId,
      meta: { status },
    });
    const d = withDerived(license);
    res.json({ license: { ...license, status: d.effectiveStatus, branchLimit: d.branchLimit } });
  }),
);

// Create the first CUSTOMER_OWNER for a company. Temp password returns once.
const ownerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
});

router.post(
  '/companies/:companyId/owner',
  loadCompany,
  asyncHandler(async (req, res) => {
    const data = ownerSchema.parse(req.body);
    const exists = await prisma.posUser.findUnique({ where: { email: data.email } });
    if (exists) throw conflict('A POS account with this email already exists');
    const tempPassword = randomPassword();
    const user = await prisma.posUser.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        role: 'CUSTOMER_OWNER',
        companyId: req.company.id,
        passwordHash: await hashPassword(tempPassword),
        mustChangePassword: true,
      },
    });
    await audit(req, {
      action: 'USER_CREATE',
      entity: 'PosUser',
      entityId: user.id,
      companyId: req.company.id,
      meta: { email: user.email, role: user.role, byAtc: true },
    });
    res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
      tempPassword,
    });
  }),
);

export default router;
