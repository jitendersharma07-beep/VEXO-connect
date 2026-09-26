import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';
import { hashSecret } from './crypto.js';
import { clientIp } from './audit.js';

// A session minted from a TEMPORARY password is only good for replacing that
// password (see requirePosAuth). It still gets a short life of its own: the
// temporary password travelled over WhatsApp, a sticky note or somebody's
// shoulder, and a 12-hour bearer credential that can only change a password is
// a 12-hour window for whoever else read it to get there first. Half an hour
// is ample to type a new one; after that the user signs in again with the same
// temporary password, which still works until it is replaced.
export const restrictedSessionTtlMs = () => env.POS_TEMP_SESSION_TTL_MINUTES * 60 * 1000;
export const fullSessionTtlMs = () => env.SESSION_TTL_HOURS * 3600 * 1000;

export const sessionCookieOptions = (ttlMs) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
  maxAge: ttlMs,
  path: '/',
});

// One place that turns a proven identity into a live session: login, the
// session that replaces a temporary one, and (later) a completed MFA
// challenge all come through here, so the cookie, the JWT and the PosSession
// row can never disagree about how long the session lives.
export const issueSession = async (req, res, user, { ttlMs = fullSessionTtlMs() } = {}) => {
  const expiresAt = new Date(Date.now() + ttlMs);
  const token = jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId, branchId: user.branchId },
    env.POS_JWT_SECRET,
    {
      issuer: 'atc-pos',
      expiresIn: Math.max(1, Math.floor(ttlMs / 1000)),
      // Two sessions minted for one user in the same millisecond (a login and
      // an immediate rotation) must still hash to different rows.
      jwtid: `${user.id}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
    },
  );
  const session = await prisma.posSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSecret(token),
      expiresAt,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    },
  });
  res.cookie(env.SESSION_COOKIE_NAME, token, sessionCookieOptions(ttlMs));
  return { token, session, expiresAt };
};
