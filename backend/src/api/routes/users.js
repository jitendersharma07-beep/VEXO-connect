// ENTITLEMENT(CORE)
//
// Staff accounts. Two rules carry this file:
//
//   1. Authority to manage people is an ACTION (user.read / user.write /
//      user.resetPassword), not a role list — so a delegated Company Admin can
//      run the team without owning the tenant, and a DENY rule can take the
//      ability away again without a code change.
//   2. Nobody mints authority they do not hold. Creating (or promoting to) a
//      role is refused unless every action that role would wake up with is one
//      the caller currently has — otherwise "create a colleague, sign in as
//      them" is a privilege escalation with extra steps.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hashPassword, randomPassword } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  resolveStoreInScope,
} from '../../middleware/permissions.js';
import { ROLES, baselineFor, isDefaultOff, isStorePinnedRole } from '../../lib/permissions.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// Every role except the platform's own. A tenant screen must never offer to
// create VEXO staff, and the API must not accept it either.
const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== 'POS_SUPER_ADMIN');

// What an account of this role can do on day one: the baseline minus the
// entries that ship switched off. This — not the raw baseline — is the honest
// measure of what creating the account hands out.
const defaultEffective = (role) => baselineFor(role).filter((a) => !isDefaultOff(role, a));

const requireRoleWithinReach = (req, role) => {
  const beyond = defaultEffective(role).filter((a) => !req.perm.can(a));
  if (beyond.length) {
    throw forbidden(
      `A ${role} account would hold permissions you do not (for example ${beyond[0]}), so you cannot assign this role`,
    );
  }
};

// Owner accounts have standing beyond their action list — only an owner can
// edit an owner's permissions, only a tenant principal can grant support
// access — so minting or touching one is kept to the owner and to VEXO support
// (whose writes inside a tenant are separately audited).
const requireOwnerAuthority = (req) => {
  if (req.user.role !== 'CUSTOMER_OWNER' && req.user.role !== 'POS_SUPER_ADMIN') {
    throw forbidden('Only the account owner can create or change an owner account');
  }
};

// A tenant with no active owner can never again grant support access or
// restore what a DENY rule took away — a lockout only database surgery undoes.
const requireAnotherActiveOwner = async (req, targetId) => {
  const others = await prisma.posUser.count({
    where: {
      companyId: req.companyScope.id,
      role: 'CUSTOMER_OWNER',
      status: 'ACTIVE',
      id: { not: targetId },
    },
  });
  if (!others) {
    throw conflict('This is the only active owner account. Create or re-enable another owner first.');
  }
};

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

// Where an account of `role` sits. Store-pinned roles take a store — which
// must be inside the caller's OWN scope, so a scoped admin cannot place staff
// where they themselves cannot go. A regional manager takes a region. Company
// -wide roles take neither, and handing out company-wide or region-wide reach
// needs company-wide reach to give.
const resolvePlacement = async (req, role, { branchId, regionId }) => {
  const companyWideCaller = req.perm.scope.kind === 'ALL' || req.perm.scope.kind === 'COMPANY';
  if (isStorePinnedRole(role)) {
    if (regionId) throw badRequest(`A ${role} account is pinned to a store, not a region`, 'regionId');
    if (!branchId) throw badRequest(`${role} accounts must be attached to a store`, 'branchId');
    const branch = await resolveStoreInScope(req, branchId);
    return { branchId: branch.id, regionId: null };
  }
  if (role === 'REGIONAL_MANAGER') {
    if (branchId) {
      throw badRequest('A regional manager is scoped by region; put stores into the region instead', 'branchId');
    }
    if (!regionId) throw badRequest('REGIONAL_MANAGER accounts must be attached to a region', 'regionId');
    if (!companyWideCaller) {
      throw forbidden('Your access is limited to specific stores, so you cannot hand out region-wide access');
    }
    const region = await prisma.region.findFirst({
      where: { id: regionId, companyId: req.companyScope.id, status: 'ACTIVE' },
    });
    if (!region) throw notFound('Region not found');
    return { branchId: null, regionId: region.id };
  }
  if (branchId || regionId) {
    throw badRequest(
      `A ${role} account is company-wide; it does not take a store or region`,
      branchId ? 'branchId' : 'regionId',
    );
  }
  if (!companyWideCaller) {
    throw forbidden('Your access is limited to specific stores, so you can only create store-pinned accounts');
  }
  return { branchId: null, regionId: null };
};

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
    const ownerAuthority = req.user.role === 'CUSTOMER_OWNER' || req.user.role === 'POS_SUPER_ADMIN';
    // Gated on user.write first: POST below refuses a caller without it, and
    // a reader who can never mint — an auditor holds every *.read action and
    // would otherwise "cover" every read-only role — must be offered nothing.
    const assignableRoles = !req.perm.can('user.write')
      ? []
      : ASSIGNABLE_ROLES.filter(
          (role) =>
            (role !== 'CUSTOMER_OWNER' || ownerAuthority) &&
            defaultEffective(role).every((a) => req.perm.can(a)),
        );
    res.json({ users: users.map(publicUser), assignableRoles });
  }),
);

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
    const data = createSchema.parse(req.body);
    if (data.role === 'CUSTOMER_OWNER') requireOwnerAuthority(req);
    requireRoleWithinReach(req, data.role);
    const placement = await resolvePlacement(req, data.role, data);

    const exists = await prisma.posUser.findUnique({ where: { email: data.email } });
    if (exists) throw conflict('A POS account with this email already exists');

    // The temporary password is returned once to the creator and stored only
    // as an argon2 hash; the new user must change it at first sign-in.
    const tempPassword = randomPassword();
    const user = await prisma.posUser.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        role: data.role,
        companyId: req.companyScope.id,
        passwordHash: await hashPassword(tempPassword),
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
    res.status(201).json({ user: publicUser(user), tempPassword });
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
    const target = await findTargetInScope(req, req.params.userId);
    if (target.id === req.user.id) {
      throw badRequest('Change your own password from the account menu instead');
    }
    if (target.role === 'CUSTOMER_OWNER') requireOwnerAuthority(req);

    const tempPassword = randomPassword();
    const passwordHash = await hashPassword(tempPassword);
    // The reset and the session revocation land together: a reset that leaves
    // the old sessions alive has not actually taken the credential back.
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
      // The email and nothing else — the temporary password exists in the
      // response body once and nowhere on the server.
      meta: { email: target.email },
    });
    await auditPlatformWrite(req);
    res.json({ email: target.email, tempPassword });
  }),
);

export default router;
