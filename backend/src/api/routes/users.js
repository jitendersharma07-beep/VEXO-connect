// ENTITLEMENT(CORE)
//
// Staff accounts. Three rules carry this file:
//
//   1. Authority to manage people is an ACTION (user.read / user.write /
//      user.resetPassword), not a role list — so a delegated Company Admin can
//      run the team without owning the tenant, and a DENY rule can take the
//      ability away again without a code change.
//   2. Nobody mints authority they do not hold. Creating (or promoting to) a
//      role is refused unless every action that role would wake up with is one
//      the caller currently has — otherwise "create a colleague, sign in as
//      them" is a privilege escalation with extra steps.
//   3. Nobody but the account holder ever knows the account's password. Both
//      write paths below used to mint a temporary one and return it to the
//      caller; they now create the account with a credential no string
//      satisfies and email the PERSON a code. An administrator can grant an
//      account and cut a lost credential, and at no point holds one.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound, AppError } from '../../lib/errors.js';
import { unusableCredential } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { mailEnabled } from '../../config/env.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction, auditPlatformWrite } from '../../middleware/permissions.js';
import { isStorePinnedRole } from '../../lib/permissions.js';
import { CHALLENGE_POLICY, ChallengeThrottled, issuePasswordCode } from '../../lib/accounts.js';
import { staffPasswordCodeEmail } from '../../lib/mail/templates.js';
import { logger } from '../../lib/logger.js';
import {
  ASSIGNABLE_ROLES,
  assignableRolesFor,
  requireAnotherActiveOwner,
  requireOwnerAuthority,
  requireRoleWithinReach,
  resolvePlacement,
} from '../../lib/userAuthority.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// The people inside the caller's organisational reach. Company-wide callers see
// the whole tenant; a narrower caller sees the people who work where they do —
// pinned there, assigned there, or (for a region) managing that same region.
const scopeUserWhere = async (req) => {
  const scope = req.perm.scope;
  if (scope.kind === 'ALL' || scope.kind === 'COMPANY') return {};
  let branchIds;
  const regionOr = [];
  if (scope.kind === 'REGION') {
    const rows = await prisma.branch.findMany({
      where: { companyId: req.companyScope.id, regionId: scope.regionId },
      select: { id: true },
    });
    branchIds = rows.map((b) => b.id);
    regionOr.push({ regionId: scope.regionId });
  } else {
    branchIds = scope.branchIds;
  }
  const ids = branchIds.length ? branchIds : ['__none__'];
  return {
    OR: [
      { branchId: { in: ids } },
      { storeAssignments: { some: { branchId: { in: ids } } } },
      ...regionOr,
      // Whatever else the scope resolves to, you exist on your own screen.
      { id: req.user.id },
    ],
  };
};

// Same reply for "another tenant's user", "outside your stores" and "no such
// id" — probing ids maps nothing.
const findTargetInScope = async (req, userId) => {
  const target = await prisma.posUser.findFirst({
    where: { id: String(userId), companyId: req.companyScope.id, ...(await scopeUserWhere(req)) },
  });
  if (!target) throw notFound('User not found');
  return target;
};

const userInclude = {
  branch: { select: { id: true, name: true, code: true } },
  region: { select: { id: true, name: true, code: true } },
};

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  role: u.role,
  status: u.status,
  branch: u.branch ? { id: u.branch.id, name: u.branch.name, code: u.branch.code } : null,
  region: u.region ? { id: u.region.id, name: u.region.name, code: u.region.code } : null,
  mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

router.get(
  '/',
  requireAction('user.read'),
  asyncHandler(async (req, res) => {
    const users = await prisma.posUser.findMany({
      where: { companyId: req.companyScope.id, ...(await scopeUserWhere(req)) },
      include: userInclude,
      orderBy: { createdAt: 'asc' },
    });
    // Computed here, not in the client: the role picker must offer exactly
    // what a POST would accept, and the reach rule lives on this side.
    res.json({ users: users.map(publicUser), assignableRoles: assignableRolesFor(req) });
  }),
);

// --- how a staff account gets its first password ---------------------------
//
// It does not get one from here. Both write paths below create or cut a
// credential and then mail the PERSON an 8-digit code — the same code, with
// the same expiry and attempt ceiling, that self-service recovery uses, so it
// is redeemed on the same screen and there is only one such flow to get right.

// An account nobody can sign into is not a grant, so a deployment with no mail
// is refused at the point of asking rather than left as a row the person can
// never reach.
const requireMailConfigured = () => {
  if (!mailEnabled) {
    throw new AppError(
      503,
      'POS_MAIL_NOT_CONFIGURED',
      'Email is not configured on this deployment, so a password cannot be set. Please contact your administrator.',
    );
  }
};

// Mails the code and reports whether it went. Deliberately does not throw.
//
// Both callers have ALREADY committed their database change by the time this
// runs — the account exists, or the old credential is already dead — so
// turning a delivery failure into a 500 would tell the administrator nothing
// happened when something did. sendMail records the failure in the outbox; the
// response carries `sent: false` so the screen can say what to do next, and
// the person can always recover the account themselves.
const mailPasswordCode = async (req, user, { isNewAccount }) => {
  try {
    await issuePasswordCode(req, user, {
      template: isNewAccount ? 'staff-password-setup' : 'staff-password-reset',
      // A builder, not a returned code: the plaintext never enters this scope,
      // so it cannot reach the response, the audit row or a log line by slip.
      build: ({ code, ttlMinutes, maxAttempts }) =>
        staffPasswordCodeEmail({
          code,
          ttlMinutes,
          maxAttempts,
          email: user.email,
          companyName: req.companyScope?.name ?? null,
          byName: req.user.fullName,
          isNewAccount,
        }),
    });
    return { sent: true };
  } catch (err) {
    const reason = err instanceof ChallengeThrottled ? 'throttled' : 'delivery-failed';
    logger.warn({ userId: user.id, reason }, 'staff password code not delivered');
    return { sent: false, reason };
  }
};

const codeDetails = (user, outcome) => ({
  ...outcome,
  sentTo: user.email,
  expiresInMinutes: CHALLENGE_POLICY.ttlMinutes,
  codeLength: CHALLENGE_POLICY.codeLength,
});

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
  role: z.enum(ASSIGNABLE_ROLES),
  branchId: z.string().trim().min(1).optional(),
  regionId: z.string().trim().min(1).optional(),
});

router.post(
  '/',
  requireAction('user.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    requireMailConfigured();
    const data = createSchema.parse(req.body);
    if (data.role === 'CUSTOMER_OWNER') requireOwnerAuthority(req);
    requireRoleWithinReach(req, data.role);
    const placement = await resolvePlacement(req, data.role, data);

    const exists = await prisma.posUser.findUnique({ where: { email: data.email } });
    if (exists) throw conflict('A POS account with this email already exists');

    // Created with a credential no string satisfies, and mustChangePassword
    // standing for "has not chosen one yet" rather than "must rotate the one
    // we gave them" — there is nothing to rotate. The flag clears the moment
    // they set their own, which is the only event that gives this account a
    // password at all.
    const user = await prisma.posUser.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        role: data.role,
        companyId: req.companyScope.id,
        passwordHash: await unusableCredential(),
        mustChangePassword: true,
        ...placement,
      },
      include: userInclude,
    });
    await audit(req, {
      action: 'USER_CREATE',
      entity: 'PosUser',
      entityId: user.id,
      companyId: req.companyScope.id,
      meta: { email: user.email, role: user.role, branchId: user.branchId, regionId: user.regionId },
    });
    await auditPlatformWrite(req);
    const outcome = await mailPasswordCode(req, user, { isNewAccount: true });
    res.status(201).json({ user: publicUser(user), passwordSetup: codeDetails(user, outcome) });
  }),
);

const updateSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  role: z.enum(ASSIGNABLE_ROLES).optional(),
  branchId: z.string().trim().min(1).optional(),
  regionId: z.string().trim().min(1).optional(),
});

router.patch(
  '/:userId',
  requireAction('user.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const target = await findTargetInScope(req, req.params.userId);

    const wantsPlacement =
      data.role !== undefined || data.branchId !== undefined || data.regionId !== undefined;
    if (target.id === req.user.id && wantsPlacement) {
      throw forbidden('You cannot change your own role or where it applies');
    }
    if (target.role === 'CUSTOMER_OWNER') requireOwnerAuthority(req);

    const nextRole = data.role ?? target.role;
    if (nextRole !== target.role) {
      if (nextRole === 'CUSTOMER_OWNER') requireOwnerAuthority(req);
      requireRoleWithinReach(req, nextRole);
      if (target.role === 'CUSTOMER_OWNER') await requireAnotherActiveOwner(req, target.id);
    }

    let placement = {};
    if (wantsPlacement) {
      // Inherit only the field the new role can use: a manager moved between
      // store roles keeps their store unless a new one is given, but nothing
      // carries a store pin into a region role or either into a company role.
      placement = await resolvePlacement(req, nextRole, {
        branchId: data.branchId ?? (isStorePinnedRole(nextRole) ? target.branchId ?? undefined : undefined),
        regionId: data.regionId ?? (nextRole === 'REGIONAL_MANAGER' ? target.regionId ?? undefined : undefined),
      });
    }

    const user = await prisma.posUser.update({
      where: { id: target.id },
      data: {
        ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...placement,
      },
      include: userInclude,
    });
    await audit(req, {
      action: 'USER_UPDATE',
      entity: 'PosUser',
      entityId: target.id,
      companyId: req.companyScope.id,
      meta: {
        email: target.email,
        ...(nextRole !== target.role ? { roleFrom: target.role, roleTo: nextRole } : {}),
        ...(wantsPlacement ? { branchId: user.branchId, regionId: user.regionId } : {}),
      },
    });
    await auditPlatformWrite(req);
    res.json({ user: publicUser(user) });
  }),
);

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });

// No licence gate on status or password reset: disabling a leaver and cutting
// a lost credential are security operations, and they must not wait for a
// renewal payment the way feature writes do.
router.patch(
  '/:userId/status',
  requireAction('user.write'),
  asyncHandler(async (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const target = await findTargetInScope(req, req.params.userId);
    if (target.id === req.user.id) throw badRequest('You cannot disable your own account');
    if (target.role === 'CUSTOMER_OWNER') {
      requireOwnerAuthority(req);
      if (status === 'DISABLED') await requireAnotherActiveOwner(req, target.id);
    }

    const user = await prisma.posUser.update({
      where: { id: target.id },
      data: { status },
      include: userInclude,
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
    await auditPlatformWrite(req);
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  '/:userId/reset-password',
  requireAction('user.resetPassword'),
  asyncHandler(async (req, res) => {
    requireMailConfigured();
    const target = await findTargetInScope(req, req.params.userId);
    if (target.id === req.user.id) {
      throw badRequest('Change your own password from the account menu instead');
    }
    if (target.role === 'CUSTOMER_OWNER') requireOwnerAuthority(req);
    // A disabled account cannot complete a recovery — the verify step refuses
    // it, and rightly, since resetting a password is not a way back in for
    // somebody who was deliberately shut out. Issuing a code that could never
    // be spent would leave an administrator waiting for a sign-in that is
    // never coming, so say what the real next step is.
    if (target.status !== 'ACTIVE') {
      throw badRequest('This account is disabled. Enable it first if this person should get back in.');
    }

    // The cut and the session revocation land together: a reset that leaves
    // the old sessions alive has not actually taken the credential back.
    // What replaces the hash satisfies no string, so this is a cut and not a
    // handover — the administrator ends the lost or shared credential without
    // ever holding its replacement.
    const passwordHash = await unusableCredential();
    await prisma.$transaction([
      prisma.posUser.update({
        where: { id: target.id },
        data: { passwordHash, mustChangePassword: true },
      }),
      prisma.posSession.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await audit(req, {
      action: 'USER_PASSWORD_RESET',
      entity: 'PosUser',
      entityId: target.id,
      companyId: req.companyScope.id,
      meta: { email: target.email },
    });
    await auditPlatformWrite(req);
    // After the cut, not before: if the mail fails the credential is still
    // gone, which is the half an administrator asked for when they pressed a
    // button labelled "their current password stops working immediately".
    const outcome = await mailPasswordCode(req, target, { isNewAccount: false });
    res.json({ email: target.email, passwordReset: codeDetails(target, outcome) });
  }),
);

export default router;
