import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { buildInfo } from '../../lib/buildInfo.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    // Spread after `status` so `status` and `service` keep the keys and values
    // deploy/prod-verify.mjs already asserts on. Provenance is additive here;
    // /api/version is the copy that still answers with the database down.
    res.json({ status: 'ok', ...buildInfo });
  }),
);

export default router;
