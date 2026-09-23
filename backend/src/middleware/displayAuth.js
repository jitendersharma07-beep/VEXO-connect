import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { unauthorized, asyncHandler } from '../lib/errors.js';

export const DISPLAY_AUDIENCE = 'vexo-customer-display';

const BRANCH_PINNED_ROLES = new Set(['BRANCH_MANAGER', 'CASHIER']);

// Verifies a VC-101 customer-display token. Distinct from requirePosAuth on
// purpose: a display is not a user, and this sets req.display, never
// req.user, so no role gate or discount guard can ever treat one as a
// principal. Staff JWTs are signed WITHOUT an audience, so they fail the
// audience check here; a display token passes requirePosAuth's signature
// check but has no PosSession row under its own hash, so it dies at that
// session lookup. Neither credential is usable in the other's slot.
//
// The token is bound to the minting cashier's session (`sid`), and this is
// the one database read on the poll path: the display lives exactly as long
// as that sign-in. Logout or disabling the user kills the display on its
// next poll — real revocation, not a bearer token running out its clock.
export const requireDisplayAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized('This display is not paired');

  let payload;
  try {
    payload = jwt.verify(token, env.POS_JWT_SECRET, {
      issuer: 'atc-pos',
      audience: DISPLAY_AUDIENCE,
    });
  } catch {
    throw unauthorized('Display pairing has ended — pair again');
  }

  const session = await prisma.posSession.findUnique({
    where: { id: payload.sid },
    select: {
      revokedAt: true,
      expiresAt: true,
      userId: true,
      user: { select: { status: true, role: true, branchId: true, companyId: true } },
    },
  });
  const live =
    session &&
    !session.revokedAt &&
    session.expiresAt > new Date() &&
    session.userId === payload.cashierId &&
    session.user?.status === 'ACTIVE' &&
    session.user.companyId === payload.companyId &&
    // A pinned cashier moved to another branch must not keep lighting up the
    // old counter's screen. An owner's own branchId is null — their pairing
    // branch was validated against the company at mint time instead.
    (!BRANCH_PINNED_ROLES.has(session.user.role) ||
      session.user.branchId === payload.branchId);
  if (!live) throw unauthorized('Display pairing has ended — pair again');

  req.display = {
    companyId: payload.companyId,
    branchId: payload.branchId,
    cashierId: payload.cashierId,
    pairingId: payload.pairingId,
  };
  return next();
});
