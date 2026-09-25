import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { hashSecret } from './crypto.js';
import { clientIp } from './audit.js';
import { sendMail } from './mail/mailer.js';
import {
  CODE_LENGTH,
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MINUTES,
  MAX_CHALLENGES_PER_HOUR,
  RESEND_COOLDOWN_SECONDS,
  codeExpiry,
  newEmailCode,
  secretVerifier,
  newOpaqueToken,
  verifierMatches,
} from './authcodes.js';

// The mechanics shared by every account flow: minting a session, revoking
// them, and the email-code challenge that password recovery and email changes
// both ride on. Routes above this file decide policy; this file decides how.

export const passwordField = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters')
  // Length is the honest lever — a composition rule mostly teaches people to
  // write Password1!. The one thing worth refusing is whitespace-only padding
  // that looks like a password and is not.
  .refine((v) => v.trim().length >= 10, 'Password must contain at least 10 non-space characters');

export const emailField = z.string().trim().toLowerCase().email().max(254);

// --- sessions ---------------------------------------------------------------

// Mints the JWT and its PosSession row. Login and MFA completion both land
// here, so there is exactly one definition of what a signed-in session is.
export const issueSession = async (req, res, user, { cookie = true } = {}) => {
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
  if (cookie) {
    res.cookie(env.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
      path: '/',
    });
  }
  return token;
};

// Every session, including the caller's. A password reset must not leave the
// thief's tab signed in, and "all but mine" is the wrong default when the
// person resetting may be the thief.
export const revokeAllSessions = (tx, userId) =>
  tx.posSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

// --- email-code challenges --------------------------------------------------

export const CHALLENGE_POLICY = {
  ttlMinutes: CODE_TTL_MINUTES,
  maxAttempts: CODE_MAX_ATTEMPTS,
  resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
  maxPerHour: MAX_CHALLENGES_PER_HOUR,
  codeLength: CODE_LENGTH,
};

export class ChallengeThrottled extends Error {
  constructor(retryAfterSeconds) {
    super('Too many requests for this account');
    this.name = 'ChallengeThrottled';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// The live challenge for a user+purpose, if any: not consumed, not superseded,
// not expired. Expiry is evaluated here rather than stored, so a clock that
// jumps cannot resurrect one.
export const activeChallenge = (tx, userId, purpose, now = new Date()) =>
  tx.authChallenge.findFirst({
    where: {
      userId,
      purpose,
      consumedAt: null,
      supersededAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });

// Mints a code and the row that verifies it, superseding any predecessor.
//
// Two ceilings, and they answer different attacks. The cooldown stops a script
// mailing one code a minute at somebody all day; the hourly cap stops that
// same script simply waiting out the cooldown. Both are counted from rows, so
// a restart does not reset them.
//
// Returns { challenge, code } — the plaintext code exists only in this return
// value, is written to nothing, and must go straight into a message body.
export const createChallenge = async (
  tx,
  { userId, purpose, sentTo, ip = null, now = new Date(), enforceThrottle = true },
) => {
  if (enforceThrottle) {
    const since = new Date(now.getTime() - 3600 * 1000);
    const recent = await tx.authChallenge.findMany({
      where: { userId, purpose, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent.length >= CHALLENGE_POLICY.maxPerHour) {
      const oldest = recent[recent.length - 1].createdAt;
      const retry = Math.ceil((oldest.getTime() + 3600 * 1000 - now.getTime()) / 1000);
      throw new ChallengeThrottled(Math.max(retry, 1));
    }
    if (recent.length > 0) {
      const sinceLast = (now.getTime() - recent[0].createdAt.getTime()) / 1000;
      if (sinceLast < CHALLENGE_POLICY.resendCooldownSeconds) {
        throw new ChallengeThrottled(Math.ceil(CHALLENGE_POLICY.resendCooldownSeconds - sinceLast));
      }
    }
  }

  // A resend replaces its predecessor rather than adding to it: two live codes
  // would double an attacker's guessing budget for the same account.
  await tx.authChallenge.updateMany({
    where: { userId, purpose, consumedAt: null, supersededAt: null },
    data: { supersededAt: now },
  });

  const code = newEmailCode();
  const challenge = await tx.authChallenge.create({
    data: {
      userId,
      purpose,
      codeHash: secretVerifier(code),
      sentTo,
      expiresAt: codeExpiry(now.getTime()),
      requestIp: ip,
    },
  });
  return { challenge, code };
};

// Mints a PASSWORD_RESET challenge and mails the code.
//
// ONE definition, because three callers hand out the same artifact: somebody
// recovering their own account, an administrator resetting somebody else's
// password, and the creation of an account that has no password yet. All three
// end at the same /forgot-password code box, so all three must agree on the
// expiry, the attempt ceiling and the purpose the verify step looks for. A
// second copy is how one of them drifts into minting a code nothing accepts.
//
// `build` receives the plaintext code and returns a message. Passing a builder
// rather than returning the code is the point: the code exists in
// createChallenge's return value and in the message body, and never enters the
// caller's scope, so no caller can accidentally put it in a response, a log
// line or an audit row.
//
// Auditing is the caller's, not this function's — "a colleague was hired",
// "an administrator cut a credential" and "somebody asked to recover" are
// three different events, and collapsing them into one action would lose the
// distinction the trail exists to keep. The challenge is returned so each
// caller can name it in its own row.
export const issuePasswordCode = async (req, user, { template, build, meta = {} }) => {
  const { challenge, code } = await prisma.$transaction((tx) =>
    createChallenge(tx, {
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      sentTo: user.email,
      ip: clientIp(req),
    }),
  );

  await sendMail({
    to: user.email,
    template,
    message: build({
      code,
      ttlMinutes: CHALLENGE_POLICY.ttlMinutes,
      maxAttempts: CHALLENGE_POLICY.maxAttempts,
    }),
    companyId: user.companyId,
    userId: user.id,
    meta: { challengeId: challenge.id, ...meta },
  });

  return challenge;
};

export const CHALLENGE_RESULT = {
  OK: 'OK',
  NO_CHALLENGE: 'NO_CHALLENGE',
  EXPIRED: 'EXPIRED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  BAD_CODE: 'BAD_CODE',
};

// Checks a submitted code and burns one attempt doing it.
//
// The conditional UPDATE below is the ONLY attempt ceiling, deliberately. It
// re-asserts every precondition — unconsumed, unsuperseded, unexpired, under
// the ceiling — so two requests racing with the same code cannot both pass:
// the loser's UPDATE matches zero rows rather than acting on a stale read.
// There is no in-memory pre-check in front of it, because a second guard that
// usually fires first would hide whether this one works.
export const consumeAttempt = async (tx, { userId, purpose, code, now = new Date() }) => {
  const challenge = await activeChallenge(tx, userId, purpose, now);
  if (!challenge) {
    // Distinguish "expired" from "never existed" for the audit trail only;
    // callers collapse both into one public answer.
    const stale = await tx.authChallenge.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!stale) return { result: CHALLENGE_RESULT.NO_CHALLENGE };
    if (stale.attempts >= CHALLENGE_POLICY.maxAttempts) {
      return { result: CHALLENGE_RESULT.TOO_MANY_ATTEMPTS };
    }
    return { result: CHALLENGE_RESULT.EXPIRED };
  }
  const spent = await tx.authChallenge.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
      supersededAt: null,
      expiresAt: { gt: now },
      attempts: { lt: CHALLENGE_POLICY.maxAttempts },
    },
    data: { attempts: { increment: 1 } },
  });
  if (spent.count === 0) return { result: CHALLENGE_RESULT.TOO_MANY_ATTEMPTS, challenge };

  if (!verifierMatches(code, challenge.codeHash)) {
    const remaining = CHALLENGE_POLICY.maxAttempts - (challenge.attempts + 1);
    return { result: CHALLENGE_RESULT.BAD_CODE, challenge, attemptsRemaining: Math.max(remaining, 0) };
  }
  return { result: CHALLENGE_RESULT.OK, challenge };
};

// Turns a verified PASSWORD_RESET challenge into a short-lived authorization
// that can do exactly one thing: set a new password.
//
// This is deliberately not a session. Someone who reads a reset code off a
// phone screen gets the ability to choose a new password — which the account's
// owner will see, because the change mails them — and not a signed-in tab with
// access to the day's takings.
export const RESET_TOKEN_TTL_MINUTES = 15;

export const issueResetAuthorization = async (tx, challengeId, now = new Date()) => {
  const token = newOpaqueToken();
  await tx.authChallenge.update({
    where: { id: challengeId },
    data: {
      verifiedAt: now,
      resetTokenHash: secretVerifier(token),
      resetExpiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
    },
  });
  return { token, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000) };
};

// Spends the authorization. The UPDATE is the lock: whichever of two
// concurrent resets lands first sets consumedAt, and the other matches no rows
// and is refused. Nothing here trusts a prior read.
export const spendResetAuthorization = async (tx, token, now = new Date()) => {
  const spent = await tx.authChallenge.updateMany({
    where: {
      resetTokenHash: secretVerifier(token),
      purpose: 'PASSWORD_RESET',
      consumedAt: null,
      resetExpiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (spent.count === 0) return null;
  return tx.authChallenge.findUnique({
    where: { resetTokenHash: secretVerifier(token) },
    include: { user: true },
  });
};
