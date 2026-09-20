import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope, branchFilterFor } from '../../middleware/auth.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope);

// Foundation dashboard: every figure is a real count from this company's own
// rows. Sales/billing do not exist yet, so the API says so explicitly instead
// of inventing numbers.
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const branchWhere = { companyId, ...branchFilterFor(req.user) };

    const [activeBranches, totalBranches, activeUsers] = await Promise.all([
      prisma.branch.count({ where: { ...branchWhere, status: 'ACTIVE' } }),
      prisma.branch.count({ where: branchWhere }),
      prisma.posUser.count({ where: { companyId, status: 'ACTIVE' } }),
    ]);

    const license = req.license;
    res.json({
      company: {
        id: req.companyScope.id,
        name: req.companyScope.name,
        isDemo: req.companyScope.isDemo,
      },
      branches: { active: activeBranches, total: totalBranches },
      users: { active: activeUsers },
      license: license
        ? {
            plan: license.plan,
            status: license.effectiveStatus,
            expiresAt: license.expiresAt,
            branchLimit: license.branchLimit,
            branchesUsed: activeBranches,
          }
        : null,
      sales: { available: false, note: 'Billing goes live in a later phase' },
    });
  }),
);

export default router;
