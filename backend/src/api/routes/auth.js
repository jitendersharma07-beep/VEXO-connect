import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { unauthorized, badRequest, asyncHandler } from '../../lib/errors.js';
import { verifyPassword, hashPassword } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { currentLicense } from '../../lib/license.js';
import { gatewayAvailable } from '../../lib/gateway/index.js';
import { requirePosAuthForSetup } from '../../middleware/auth.js';
import { issueSession, restrictedSessionTtlMs, fullSessionTtlMs } from '../../lib/session.js';
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
        // What the customer has bought beyond core POS. Published because the
        // portal has to decide whether to show a whole section of navigation,
        // and a sidebar that offers Inventory to a company without it makes
        // every click a 403.
        //
        // Safe to publish: it is the customer's own entitlement, it names no
        // price and no other tenant, and it is not the control — the server
        // refuses the routes whatever the browser believes. Defaulted rather
        // than passed straight through, so a licence row predating the column
        // reads as core POS only instead of as undefined.
        modules: license.modules ?? [],
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

    // Signing in with a temporary password does not buy an ordinary session.
    // The token still authenticates, so the user can reach /me and
    // /change-password, but requirePosAuth refuses it everywhere else and it
    // expires in minutes rather than hours.
    const restricted = user.mustChangePassword;
    const { token, expiresAt } = await issueSession(req, res, user, {
      ttlMs: restricted ? restrictedSessionTtlMs() : fullSessionTtlMs(),
    });
    await prisma.posUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const license = user.companyId ? await currentLicense(user.companyId) : null;
    req.user = user;
    await audit(req, { action: 'LOGIN_SUCCESS', entity: 'PosUser', entityId: user.id });

    res.json({
      token,
      // Published so the client knows the session it just got is the restricted
      // one and can send the user straight to the password screen. It is not the
      // control — the server refuses regardless of what the browser does with
      // this — and `user.mustChangePassword` already says the same thing; this
      // names the consequence rather than the cause.
      passwordChangeRequired: restricted,
      sessionExpiresAt: expiresAt,
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
  requirePosAuthForSetup,
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
  requirePosAuthForSetup,
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
  requirePosAuthForSetup,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.posUser.findUnique({ where: { id: req.user.id } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw badRequest('Current password is incorrect', 'currentPassword');
    }
    // Without this, re-submitting the temporary password as the new one clears
    // mustChangePassword and promotes the session, leaving the account on the
    // credential the whole gate exists to retire.
    if (currentPassword === newPassword) {
      throw badRequest('New password must be different from the current one', 'newPassword');
    }
    const leavingTemporary = user.mustChangePassword;
    await prisma.posUser.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    });
    if (leavingTemporary) {
      // Revoke EVERY session including this one, then mint a fresh full session.
      // The restricted token was minted from a credential that passed through
      // other hands, so if somebody else also used it their session dies here
      // too — which is the point. Promoting the current session instead would
      // keep whichever of the two happened to call this route.
      await prisma.posSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const { token, expiresAt } = await issueSession(req, res, user);
      await audit(req, {
        action: 'PASSWORD_CHANGED',
        entity: 'PosUser',
        entityId: user.id,
        meta: { firstLogin: true, sessionRotated: true },
      });
      return res.json({ ok: true, sessionRotated: true, token, sessionExpiresAt: expiresAt });
    }

    // A voluntary change keeps its own session: a paired customer display hangs
    // off it, and signing the cashier out mid-shift to no security end would
    // just teach them not to change passwords. Every OTHER session for this
    // user stops working immediately.
    await prisma.posSession.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: req.sessionId } },
      data: { revokedAt: new Date() },
    });
    await audit(req, { action: 'PASSWORD_CHANGED', entity: 'PosUser', entityId: user.id });
    res.json({ ok: true, sessionRotated: false });
  }),
);

export default router;
