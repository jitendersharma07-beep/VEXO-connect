import { prisma } from './prisma.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { resolveStoreInScope } from '../middleware/permissions.js';
import { ROLES, baselineFor, isDefaultOff, isStorePinnedRole } from './permissions.js';

// The rules that decide WHO may hand out WHAT, and WHERE the resulting account
// sits. They live here rather than in a route because there are now two ways to
// create a staff account — direct creation and an emailed invitation — and a
// second copy of these checks is a privilege escalation waiting for the two to
// drift apart. One definition, both callers.

// Every role except the platform's own. A tenant screen must never offer to
// create VEXO staff, and the API must not accept it either.
export const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== 'POS_SUPER_ADMIN');

// What an account of this role can do on day one: the baseline minus the
// entries that ship switched off. This — not the raw baseline — is the honest
// measure of what creating the account hands out.
export const defaultEffective = (role) => baselineFor(role).filter((a) => !isDefaultOff(role, a));

// Nobody mints authority they do not hold. Without this, "create a colleague,
// sign in as them" is a privilege escalation with extra steps.
export const requireRoleWithinReach = (req, role) => {
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
export const requireOwnerAuthority = (req) => {
  if (req.user.role !== 'CUSTOMER_OWNER' && req.user.role !== 'POS_SUPER_ADMIN') {
    throw forbidden('Only the account owner can create or change an owner account');
  }
};

// A tenant with no active owner can never again grant support access or
// restore what a DENY rule took away — a lockout only database surgery undoes.
export const requireAnotherActiveOwner = async (req, targetId) => {
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

// The same reasoning one level up, and the stakes are the whole platform
// rather than one tenant. Platform administrators are the only accounts that
// can create customer companies, issue licences and — via this very guard —
// appoint more of themselves. Disabling the last active one is not a recoverable
// mistake: there is no screen left that can undo it, and the bootstrap script
// deliberately refuses to promote an existing account, so the way back is
// database surgery.
//
// Counted with companyId: null in the WHERE. A POS_SUPER_ADMIN row that somehow
// carried a company would not be a platform administrator, and letting one stand
// in for the real thing is how "there is another admin" becomes false while
// reading as true.
export const requireAnotherActivePlatformAdmin = async (targetId) => {
  const others = await prisma.posUser.count({
    where: { role: 'POS_SUPER_ADMIN', companyId: null, status: 'ACTIVE', id: { not: targetId } },
  });
  if (!others) {
    throw conflict(
      'This is the only active platform administrator. Invite and activate another one first — ' +
        'disabling this account would leave nobody able to create companies, issue licences or restore access.',
    );
  }
};

// Which roles this caller may actually offer. Gated on user.write first: an
// auditor holds every *.read action and would otherwise "cover" every
// read-only role despite being unable to mint anything.
export const assignableRolesFor = (req) => {
  if (!req.perm.can('user.write')) return [];
  const ownerAuthority = req.user.role === 'CUSTOMER_OWNER' || req.user.role === 'POS_SUPER_ADMIN';
  return ASSIGNABLE_ROLES.filter(
    (role) =>
      (role !== 'CUSTOMER_OWNER' || ownerAuthority) &&
      defaultEffective(role).every((a) => req.perm.can(a)),
  );
};

// Where an account of `role` sits. Store-pinned roles take a store — which
// must be inside the caller's OWN scope, so a scoped admin cannot place staff
// where they themselves cannot go. A regional manager takes a region. Company
// -wide roles take neither, and handing out company-wide or region-wide reach
// needs company-wide reach to give.
export const resolvePlacement = async (req, role, { branchId, regionId }) => {
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
