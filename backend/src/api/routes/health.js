import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: 'atc-pos-api' });
  }),
);

export default router;
