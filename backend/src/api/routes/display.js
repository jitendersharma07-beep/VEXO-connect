// VC-101 customer display — sprint v1.1. The display is a read-only mirror
// of the server-side Order: every figure it shows comes out of serializeOrder
// over rows the §6 contract math already wrote (recomputeOrder maintains
// them). Nothing is recalculated here or in the browser, so the customer
// screen can never disagree with the bill.
//
// Response shaping is an ALLOWLIST. The display never sees: who approved a
// discount or why, void reasons, staff emails, payment methods, policy
// ceilings, or anything else the customer standing at the counter is not
// already entitled to read off the receipt.

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope, isBranchPinned } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { requireDisplayAuth, DISPLAY_AUDIENCE } from '../../middleware/displayAuth.js';
import { ORDER_INCLUDE, serializeOrder } from '../../lib/orders.js';
import {
  PAIR_CODE_TTL_MS,
  stationKeyFor,
  mintPairCode,
  redeemPairCode,
  setPointer,
  getPointer,
  clearPointer,
  clearPointersForCashier,
} from '../../lib/displayState.js';

const router = Router();

const isTest = process.env.NODE_ENV === 'test';

// /pair is the one unauthenticated write in this file, so it gets its own
// limiter (loginLimiter pattern): failures burn the budget, successes don't,
// and a shop pairing two displays with a typo or two never locks itself out.
const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => isTest,
  message: {
    error: { code: 'POS_RATE_LIMITED', message: 'Too many pairing attempts. Try again in a few minutes.' },
  },
});

// The same roles the Sell screen admits. Never POS_SUPER_ADMIN: a customer
// display belongs to a counter, and support has no counter.
const staff = [requirePosAuth, resolveCompanyScope, requireRole('CASHIER', 'BRANCH_MANAGER', 'CUSTOMER_OWNER')];

// Which branch this display stands at. Same shape as reports.js
// closingBranch: a pinned role gets their own branch and may not name
// another; an owner must name one, validated inside their company.
const pairingBranch = async (req, wanted) => {
  if (isBranchPinned(req.user)) {
    if (wanted && wanted !== req.user.branchId) {
      throw forbidden('You can only pair a display at your own branch');
    }
    return prisma.branch.findFirst({
      where: { id: req.user.branchId, companyId: req.companyScope.id },
    });
  }
  if (!wanted) throw badRequest('branchId is required: a display stands at one branch', 'branchId');
  const branch = await prisma.branch.findFirst({
    where: { id: wanted, companyId: req.companyScope.id },
  });
  if (!branch) throw notFound('Branch not found');
  return branch;
};

router.post(
  '/pair-code',
  ...staff,
  asyncHandler(async (req, res) => {
    const body = z.object({ branchId: z.string().min(1).optional() }).parse(req.body ?? {});
    const branch = await pairingBranch(req, body.branchId);
    if (!branch) throw notFound('Branch not found');
    const { code, expiresAt } = mintPairCode({
      companyId: req.companyScope.id,
      branchId: branch.id,
      cashierId: req.user.id,
      sessionId: req.sessionId,
    });
    // The code itself is a short-lived credential and is not audited, for
    // the same reason passwords are not.
    await audit(req, {
      action: 'DISPLAY_PAIR_CODE',
      entity: 'Branch',
      entityId: branch.id,
      companyId: req.companyScope.id,
      meta: { branchId: branch.id },
    });
    res.status(201).json({
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.round(PAIR_CODE_TTL_MS / 1000),
    });
  }),
);

router.post(
  '/pair',
  pairLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ code: z.string().regex(/^\d{6}$/, 'Pairing code is 6 digits') })
      .parse(req.body ?? {});
    const grant = redeemPairCode(body.code);
    // One message for every refusal on this unauthenticated surface, so a
    // guesser learns nothing about which part was wrong.
    const refused = () => badRequest('Invalid or expired pairing code', 'code');
    if (!grant) throw refused();

    // The pairing inherits its life from the cashier's sign-in: a code
    // minted by a session that has since ended must not open a display.
    const now = new Date();
    const session = await prisma.posSession.findUnique({
      where: { id: grant.sessionId },
      select: { id: true, userId: true, revokedAt: true, expiresAt: true },
    });
    if (!session || session.userId !== grant.cashierId || session.revokedAt || session.expiresAt <= now) {
      throw refused();
    }
    const branch = await prisma.branch.findFirst({
      where: { id: grant.branchId, companyId: grant.companyId },
      select: { id: true, name: true, company: { select: { name: true } } },
    });
    if (!branch) throw refused();

    const pairingId = randomBytes(16).toString('hex');
    const ttlMs = Math.min(24 * 3600 * 1000, session.expiresAt.getTime() - now.getTime());
    const displayToken = jwt.sign(
      {
        companyId: grant.companyId,
        branchId: grant.branchId,
        cashierId: grant.cashierId,
        sid: session.id,
        pairingId,
      },
      env.POS_JWT_SECRET,
      {
        issuer: 'atc-pos',
        audience: DISPLAY_AUDIENCE,
        expiresIn: Math.floor(ttlMs / 1000),
        subject: `display:${pairingId}`,
      },
    );
    // A fresh pairing starts on a blank screen — never on whatever order the
    // station showed last shift.
    clearPointer(stationKeyFor(grant.branchId, grant.cashierId));
    await audit(req, {
      action: 'DISPLAY_PAIRED',
      entity: 'Branch',
      entityId: grant.branchId,
      companyId: grant.companyId,
      meta: { pairingId, cashierId: grant.cashierId },
    });
    res.status(201).json({
      displayToken,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      branch: { name: branch.name },
      company: { name: branch.company.name },
    });
  }),
);

// The Sell screen points this cashier's station at the order it is working
// on (or clears it). The display itself can never call this — it holds no
// staff credential.
router.put(
  '/state',
  ...staff,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        orderId: z.string().min(1).nullable(),
        branchId: z.string().min(1).optional(),
      })
      .parse(req.body ?? {});

    if (body.orderId === null) {
      if (isBranchPinned(req.user)) {
        clearPointer(stationKeyFor(req.user.branchId, req.user.id));
      } else if (body.branchId) {
        clearPointer(stationKeyFor(body.branchId, req.user.id));
      } else {
        clearPointersForCashier(req.user.id);
      }
      return res.json({ ok: true, cleared: true });
    }

    // House convention: an order outside the company answers exactly like
    // one that does not exist; an in-company order at someone else's branch
    // is a refusal a pinned role is told about.
    const order = await prisma.order.findFirst({
      where: { id: body.orderId, companyId: req.companyScope.id },
      select: { id: true, branchId: true },
    });
    if (!order) throw notFound('Order not found');
    if (isBranchPinned(req.user) && order.branchId !== req.user.branchId) {
      throw forbidden('Your role is limited to your own branch');
    }
    const pointer = setPointer(stationKeyFor(order.branchId, req.user.id), order.id);
    res.json({ ok: true, version: pointer.version });
  }),
);

router.get(
  '/state',
  requireDisplayAuth,
  asyncHandler(async (req, res) => {
    const { companyId, branchId, cashierId } = req.display;
    const stationKey = stationKeyFor(branchId, cashierId);
    const pointer = getPointer(stationKey);

    let view = { view: 'IDLE' };
    if (pointer?.orderId) {
      // Company and branch come from the token, never from the client, so a
      // pointer can only ever resolve inside its own station's tenancy.
      const order = await prisma.order.findFirst({
        where: { id: pointer.orderId, companyId, branchId },
        include: ORDER_INCLUDE,
      });
      if (
        !order ||
        order.status === 'VOID' ||
        order.status === 'REFUNDED' ||
        order.status === 'MERGED'
      ) {
        // Straight to IDLE — a voided bill is not thanked.
        //
        // MERGED belongs in this list and not in the ACTIVE branch below. It is
        // the one status the customer display would otherwise get wrong by
        // falling through: a bill merged into another one has had its lines
        // moved away, so the guest would watch their order empty itself to a
        // zero total on the screen in front of them while the till rings the
        // whole party up on the surviving cheque. Every other status filter in
        // src/ is an allowlist that excludes MERGED for free; this one runs the
        // other way, so it has to name it.
        clearPointer(stationKey);
      } else if (order.status === 'PAID') {
        const s = serializeOrder(order);
        clearPointer(stationKey);
        view = { view: 'THANKYOU', total: s.total, invoiceNumber: s.invoiceNumber };
      } else {
        const s = serializeOrder(order);
        view = {
          view: 'ACTIVE',
          orderStatus: s.status,
          invoiceNumber: s.invoiceNumber,
          items: s.items
            .filter((i) => i.status === 'ACTIVE')
            .map((i) => ({
              name: i.name,
              qty: i.qty,
              unitPrice: i.unitPrice,
              lineDiscount: i.lineDiscount,
            })),
          subtotal: s.subtotal,
          discountAmount: s.discountAmount,
          taxAmount: s.taxAmount,
          total: s.total,
          due: s.amountDue,
        };
      }
    }

    // ETag on the JSON bytes: an unchanged screen costs the poll loop a 304
    // and the shop's shared-IP rate budget almost nothing.
    const payload = JSON.stringify(view);
    const etag = `"${createHash('sha256').update(payload).digest('base64url')}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('ETag', etag).type('application/json').send(payload);
  }),
);

export default router;
