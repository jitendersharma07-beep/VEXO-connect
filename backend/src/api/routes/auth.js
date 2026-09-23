import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { unauthorized, badRequest, asyncHandler } from '../../lib/errors.js';
import { hashSecret, verifyPassword, hashPassword } from '../../lib/crypto.js';
import { audit, clientIp } from '../../lib/audit.js';
import { currentLicense } from '../../lib/license.js';
import { gatewayAvailable } from '../../lib/gateway/index.js';
import { requirePosAuth } from '../../middleware/auth.js';
import { loginLimiter } from '../../middleware/rateLimit.js';
import { describeCeiling, resolveDiscountPolicy } from '../../lib/discountPolicy.js';

const router = Router();

// A property of the deployment, not of the user, so it rides along with the
// session rather than costing the Sell screen a call of its own. It is false
// on every deployment today. The screen uses it to decide whether to offer
// online payment at all: a button whose only outcome is 501 is worse than no
// button, because the cashier finds out at the counter with a customer
// waiting.
const onlinePayment = () => ({
  available: gatewayAvailable(),
  provider: gatewayAvailable() ? env.POS_GATEWAY_PROVIDER : null,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
  maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  path: '/',
});

const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  role: user.role,
  companyId: user.companyId,
  branchId: user.branchId,
  mustChangePassword: user.mustChangePassword,
});

const publicCompany = (company) =>
  company
    ? { id: company.id, name: company.name, slug: company.slug, status: company.status, isDemo: company.isDemo }
    : null;

const publicLicense = (license) =>
  license
    ? {
        plan: license.plan,
        status: license.effectiveStatus,
        startsAt: license.startsAt,
        expiresAt: license.expiresAt,
        branchLimit: license.branchLimit,
      }
    : null;

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.posUser.findUnique({
      where: { email },
      include: { company: true, branch: true },
    });

    // One indistinct refusal for wrong email, wrong password, disabled user or
    // suspended company: a login form must not confirm which part was right.
    const refuse = async (reason) => {
      await audit(req, {
        action: 'LOGIN_FAILED',
        entity: 'PosUser',
        entityId: user?.id,
        companyId: user?.companyId,
        meta: { email, reason },
      });
      throw unauthorized('Invalid email or password');
    };

    if (!user) return refuse('unknown-email');
    if (!(await verifyPassword(user.passwordHash, password))) return refuse('bad-password');
    if (user.status !== 'ACTIVE') return refuse('user-disabled');
    if (user.role !== 'POS_SUPER_ADMIN') {
      if (!user.company) return refuse('no-company');
      if (user.company.status !== 'ACTIVE') return refuse('company-' + user.company.status.toLowerCase());
    }

    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);
    const token = jwt.sign(
      { sub: user.id, role: user.role, companyId: user.companyId, branchId: user.branchId },
      env.POS_JWT_SECRET,
      { issuer: 'atc-pos', expiresIn: `${env.SESSION_TTL_HOURS}h`, jwtid: `${user.id}.${Date.now()}` },
    );

    await prisma.posSession.create({
      data: {
        userId: user.id,
        tokenHash: hashSecret(token),
        expiresAt,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      },
    });
    await prisma.posUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const license = user.companyId ? await currentLicense(user.companyId) : null;
    req.user = user;
    await audit(req, { action: 'LOGIN_SUCCESS', entity: 'PosUser', entityId: user.id });

    res.cookie(env.SESSION_COOKIE_NAME, token, cookieOptions());
    res.json({
      token,
      user: publicUser(user),
      company: publicCompany(user.company),
      branch: user.branch ? { id: user.branch.id, name: user.branch.name, code: user.branch.code } : null,
      license: publicLicense(license),
      onlinePayment: onlinePayment(),
    });
  }),
);

router.post(
  '/logout',
  requirePosAuth,
  asyncHandler(async (req, res) => {
    await prisma.posSession.update({
      where: { id: req.sessionId },
      data: { revokedAt: new Date() },
    });
    res.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  requirePosAuth,
  asyncHandler(async (req, res) => {
    const license = req.user.companyId ? await currentLicense(req.user.companyId) : null;
    const branch = req.user.branchId
      ? await prisma.branch.findUnique({
          where: { id: req.user.branchId },
          select: { id: true, name: true, code: true },
        })
      : null;

    // What this operator may take off a bill, already resolved through
    // company → branch → staff. The till uses it to decide which controls to
    // offer; it is NOT the enforcement — every discount is re-decided
    // server-side on the request that moves it. Sending it here just stops
    // the screen offering a button that was always going to be refused.
    const discountPolicy = req.user.companyId
      ? await (async () => {
          const merged = await resolveDiscountPolicy(prisma, {
            companyId: req.user.companyId,
            userId: req.user.id,
            role: req.user.role,
            branchId: req.user.branchId,
          });
          return { ...merged, ceiling: describeCeiling(merged), approvalCeiling: describeCeiling({
            maxPctMilli: merged.maxApprovalPctMilli,
            maxFlatPaise: merged.maxApprovalFlatPaise,
          }) };
        })()
      : null;

    res.json({
      user: publicUser(req.user),
      company: publicCompany(req.user.company),
      branch,
      license: publicLicense(license),
      onlinePayment: onlinePayment(),
      discountPolicy,
    });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

router.post(
  '/change-password',
  requirePosAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.posUser.findUnique({ where: { id: req.user.id } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw badRequest('Current password is incorrect', 'currentPassword');
    }
    await prisma.posUser.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    });
    // Every other session for this user stops working immediately.
    await prisma.posSession.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: req.sessionId } },
      data: { revokedAt: new Date() },
    });
    await audit(req, { action: 'PASSWORD_CHANGED', entity: 'PosUser', entityId: user.id });
    res.json({ ok: true });
  }),
);

export default router;
