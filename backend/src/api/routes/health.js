import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';

const router = Router();

// Two keys, deliberately. This route is reachable unauthenticated from the
// public internet (the compose healthcheck and deploy/prod-verify.mjs both need
// it to be), so build provenance does not belong here — it lives behind the
// POS_SUPER_ADMIN gate on /api/version.
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: 'atc-pos-api' });
  }),
);

export default router;
