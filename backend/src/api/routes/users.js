import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword, randomPassword } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER'));

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  role: u.role,
  status: u.status,
  branch: u.branch ? { id: u.branch.id, name: u.branch.name, code: u.branch.code } : null,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const users = await prisma.posUser.findMany({
      where: { companyId: req.companyScope.id },
      include: { branch: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ users: users.map(publicUser) });
  }),
);

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
  role: z.enum(['CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER']),
  branchId: z.string().trim().optional(),
});

router.post(
  '/',
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    const branchPinned = data.role === 'BRANCH_MANAGER' || data.role === 'CASHIER';
    if (branchPinned && !data.branchId) {
      throw badRequest(`${data.role} accounts must be attached to a branch`, 'branchId');
    }
    if (data.branchId) {
      // The branch must belong to the scoped company — a foreign branchId is
      // indistinguishable from a missing one.
      const branch = await prisma.branch.findUnique({ where: { id: data.branchId } });
      if (!branch || branch.companyId !== req.companyScope.id) throw notFound('Branch not found');
    }

    const exists = await prisma.posUser.findUnique({ where: { email: data.email } });
    if (exists) throw conflict('A POS account with this email already exists');

    // The temporary password is returned once to the creator and stored only
    // as an argon2 hash; the new user must change it at first sign-in.
    const tempPassword = randomPassword();
    const user = await prisma.posUser.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        role: data.role,
        branchId: branchPinned ? data.branchId : null,
        companyId: req.companyScope.id,
        passwordHash: await hashPassword(tempPassword),
        mustChangePassword: true,
      },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    await audit(req, {
      action: 'USER_CREATE',
      entity: 'PosUser',
      entityId: user.id,
      companyId: req.companyScope.id,
      meta: { email: user.email, role: user.role, branchId: user.branchId },
    });
    res.status(201).json({ user: publicUser(user), tempPassword });
  }),
);

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });

router.patch(
  '/:userId/status',
  asyncHandler(async (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const target = await prisma.posUser.findUnique({ where: { id: req.params.userId } });
    if (!target || target.companyId !== req.companyScope.id) throw notFound('User not found');
    if (target.id === req.user.id) throw badRequest('You cannot disable your own account');

    const user = await prisma.posUser.update({
      where: { id: target.id },
      data: { status },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    if (status === 'DISABLED') {
      await prisma.posSession.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit(req, {
      action: status === 'DISABLED' ? 'USER_DISABLE' : 'USER_ENABLE',
      entity: 'PosUser',
      entityId: target.id,
      companyId: req.companyScope.id,
    });
    res.json({ user: publicUser(user) });
  }),
);

export default router;
