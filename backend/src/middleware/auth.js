import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { unauthorized, forbidden, badRequest, notFound, asyncHandler } from '../lib/errors.js';
import { hashSecret } from '../lib/crypto.js';
import { currentLicense } from '../lib/license.js';

const readToken = (req) => {
  const cookieToken = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
};

// Verifies the POS JWT *and* that its session row is still live, so revoking a
// session or disabling a user takes effect immediately. Tokens minted by any
// other ATC product fail signature verification here — POS has its own secret.
export const requirePosAuth = asyncHandler(async (req, _res, next) => {
  const token = readToken(req);
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, env.POS_JWT_SECRET, { issuer: 'atc-pos' });
  } catch {
    throw unauthorized('Your session has expired, please sign in again');
  }

  const session = await prisma.posSession.findUnique({
    where: { tokenHash: hashSecret(token) },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthorized('Your session has expired, please sign in again');
  }

  const user = await prisma.posUser.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      companyId: true,
      branchId: true,
      // LANE foundation — a REGIONAL_MANAGER is scoped by region, not branch,
      // so the scope resolver needs it on every request.
      regionId: true,
      mustChangePassword: true,
      company: { select: { id: true, name: true, slug: true, status: true, isDemo: true } },
    },
  });
  if (!user || session.userId !== user.id) throw unauthorized('Account no longer exists');
  if (user.status === 'DISABLED') throw forbidden('This account has been disabled');
  if (user.role !== 'POS_SUPER_ADMIN') {
    if (!user.company) throw forbidden('This account is not attached to a POS customer company');
    if (user.company.status === 'SUSPENDED') {
      throw forbidden('Your company account is suspended. Please contact VEXO support.');
    }
  }

  req.user = user;
  req.sessionId = session.id;
  next();
});

// The company a request is allowed to operate on. Customer principals ALWAYS
// act on their own company — any client-supplied companyId is ignored for
// them. Only POS_SUPER_ADMIN selects a company explicitly.
export const resolveCompanyScope = asyncHandler(async (req, _res, next) => {
  if (req.user.role === 'POS_SUPER_ADMIN') {
    const companyId = req.query.companyId || req.headers['x-pos-company'] || null;
    if (!companyId) throw badRequest('companyId is required for VEXO operators on this route');
    const company = await prisma.company.findUnique({ where: { id: String(companyId) } });
    if (!company) throw notFound('Company not found');
    req.companyScope = company;
  } else {
    req.companyScope = req.user.company;
  }
  req.license = await currentLicense(req.companyScope.id);
  next();
});

const BRANCH_PINNED_ROLES = new Set(['BRANCH_MANAGER', 'CASHIER']);

// Loads :branchId and proves, server-side, that it belongs to the scoped
// company AND that branch-pinned roles only ever see their own branch. A
// branch outside the caller's company answers exactly like a branch that does
// not exist — cross-tenant probing learns nothing.
export const requireBranchAccess = asyncHandler(async (req, _res, next) => {
  const branch = await prisma.branch.findUnique({ where: { id: req.params.branchId } });
  if (!branch || branch.companyId !== req.companyScope.id) throw notFound('Branch not found');
  // LANE foundation — when the route has loaded a permission context, the store
  // scope it resolved is the authority: it already accounts for explicit
  // multi-store assignments and for a regional manager's region, neither of
  // which the single branchId pin below can express. Routes that have not been
  // migrated keep the original pinning exactly as it was.
  if (req.perm?.scope) {
    const { kind, branchIds, regionId } = req.perm.scope;
    const permitted =
      kind === 'ALL' ||
      kind === 'COMPANY' ||
      (kind === 'REGION' && branch.regionId === regionId) ||
      (kind === 'LIST' && branchIds.includes(branch.id));
    if (!permitted) throw forbidden('Your role is limited to your own branch');
  } else if (BRANCH_PINNED_ROLES.has(req.user.role) && req.user.branchId !== branch.id) {
    throw forbidden('Your role is limited to your own branch');
  }
  req.branch = branch;
  next();
});

export const branchFilterFor = (user) =>
  BRANCH_PINNED_ROLES.has(user.role) ? { id: user.branchId ?? '__none__' } : {};

export const isBranchPinned = (user) => BRANCH_PINNED_ROLES.has(user.role);

// Same pinning as branchFilterFor, but for models that carry a branchId
// column (orders, tables, ...) instead of being the Branch itself.
export const branchIdFilterFor = (user) =>
  BRANCH_PINNED_ROLES.has(user.role) ? { branchId: user.branchId ?? '__none__' } : {};
