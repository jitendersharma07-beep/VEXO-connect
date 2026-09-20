import { Router } from 'express';
import { asyncHandler } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const license = req.license;
    res.json({
      license: license
        ? {
            id: license.id,
            plan: license.plan,
            status: license.effectiveStatus,
            startsAt: license.startsAt,
            expiresAt: license.expiresAt,
            branchLimit: license.branchLimit,
            baseBranchLimit: license.baseBranchLimit,
            addons: license.addons.map((a) => ({
              id: a.id,
              kind: a.kind,
              quantity: a.quantity,
              expiresAt: a.expiresAt,
              createdAt: a.createdAt,
            })),
          }
        : null,
    });
  }),
);

export default router;
