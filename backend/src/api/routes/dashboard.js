import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope, branchFilterFor } from '../../middleware/auth.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope);

// Dashboard: every figure is a real count from this company's own rows.
// Money is deliberately absent here — the sales report computes it over an
// explicit date range and branch scope, and a second set of totals on this
// page would be a second set to reconcile.
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
      // `available` describes THIS payload, not the product: selling, payments,
      // refunds and the sales report are all live. It stays false because the
      // summary carries no money, and the note says where the money is.
      sales: { available: false, note: 'Sales figures are in the sales report' },
    });
  }),
);

export default router;
