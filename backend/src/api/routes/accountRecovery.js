import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { recoveryLimiter } from '../../middleware/rateLimit.js';
import { badRequest, asyncHandler, AppError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/crypto.js';
import { audit, auditRequired, clientIp } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { mailEnabled } from '../../config/env.js';
import { sendMailBestEffort } from '../../lib/mail/mailer.js';
import { resetCodeEmail, passwordChangedEmail } from '../../lib/mail/templates.js';
import {
  CHALLENGE_POLICY,
  CHALLENGE_RESULT,
  ChallengeThrottled,
  consumeAttempt,
  emailField,
  issuePasswordCode,
  issueResetAuthorization,
  passwordField,
  revokeAllSessions,
  spendResetAuthorization,
} from '../../lib/accounts.js';

// Password recovery by email code. Four steps, each of which can be told
// nothing by an attacker who does not hold the mailbox:
//
//   request → (resend) → verify → reset
//
// The rule that shapes every handler here is that this endpoint must never
// become an account oracle. Whether the address is registered, whether the
// user is disabled, whether the company is suspended, whether a challenge is
// already live — all of it answers the same way. What actually differs is what
// arrives in the mailbox, which is exactly the channel the caller has to prove
// they own.

const router = Router();

// The one public answer. Identical for an unknown address, a disabled user, a
// suspended company and a mailbox that is about to receive a code.
const ACCEPTED = {
  ok: true,
  message: 'If that email is registered, a verification code is on its way.',
  expiresInMinutes: CHALLENGE_POLICY.ttlMinutes,
  codeLength: CHALLENGE_POLICY.codeLength,
};

const requestSchema = z.object({ email: emailField });
const verifySchema = z.object({ email: emailField, code: z.string().trim().min(1).max(16) });
const resetSchema = z.object({
  resetToken: z.string().min(10).max(200),
  password: passwordField,
  confirmPassword: z.string().optional(),
});

const throttled = (retryAfterSeconds) =>
  new AppError(429, 'POS_RATE_LIMITED', 'Too many requests for this account. Please wait a moment.', undefined, {
    retryAfterSeconds,
  });

// Who may recover, and who is silently passed over.
//
// A DISABLED user must not be able to resurrect themselves by resetting a
// password — that is the whole point of disabling one. A SUSPENDED company is
// the same decision one level up. Both are skipped without a word, because
// saying "this account is disabled" to an unauthenticated caller confirms the
// address exists.
//
// An EXPIRED LICENCE is deliberately NOT a reason to skip. The owner whose
// renewal lapsed is precisely the person who needs to get back in to fix it,
// and a recovery flow that refuses them turns a billing problem into a
// lockout.
const recoverable = (user) => {
  if (!user) return false;
  if (user.status !== 'ACTIVE') return false;
  if (user.role === 'POS_SUPER_ADMIN') return true;
  if (!user.company) return false;
  return user.company.status === 'ACTIVE';
};

const findRecoverable = async (email) => {
  const user = await prisma.posUser.findUnique({ where: { email }, include: { company: true } });
  return recoverable(user) ? user : null;
};

// Mints a challenge and mails it. The minting, the mail and the guarantee that
// the plaintext code reaches nothing but the message body are all
// issuePasswordCode's — shared with the two administrator-initiated paths in
// routes/users.js, so a code issued here and a code issued there are the same
// artifact and are verified by the same steps below.
//
// What stays here is the audit action, because "somebody asked to recover
// their own account" is a different event from "an administrator cut a
// credential", and the trail is where that difference has to survive.
const issueCode = async (req, user) => {
  const challenge = await issuePasswordCode(req, user, {
    template: 'password-reset-code',
    build: ({ code, ttlMinutes, maxAttempts }) => resetCodeEmail({ code, ttlMinutes, maxAttempts }),
  });

  await audit(req, {
    action: 'PASSWORD_RESET_REQUESTED',
    entity: 'PosUser',
    entityId: user.id,
    companyId: user.companyId,
    meta: { challengeId: challenge.id },
  });
};

// POST /auth/forgot-password  — and /resend, which is the same thing. A resend
// supersedes the previous code rather than adding a second live one; the
// cooldown and hourly cap live in createChallenge and are counted from rows,
// so a restart does not hand out a fresh budget.
const requestHandler = asyncHandler(async (req, res) => {
  const { email } = requestSchema.parse(req.body);

  // Configuration, not the caller's problem — and a silent success here would
  // leave someone waiting forever for a mail nothing was ever going to send.
  if (!mailEnabled) {
    throw new AppError(
      503,
      'POS_MAIL_NOT_CONFIGURED',
      'Password recovery by email is not available on this deployment. Please contact your administrator.',
    );
  }

  const user = await findRecoverable(email);
  if (!user) {
    // Audited so the trail shows the attempt, answered exactly as a hit is.
    await audit(req, {
      action: 'PASSWORD_RESET_REQUESTED',
      entity: 'PosUser',
      meta: { email, outcome: 'no-eligible-account' },
    });
    return res.json(ACCEPTED);
  }

  try {
    await issueCode(req, user);
  } catch (err) {
    // Throttling is the one condition worth telling the caller about: the
    // person waiting on a code needs to know to wait rather than to keep
    // pressing. It leaks only that this address has been asked about recently,
    // which the attacker already knows — they are the one who asked.
    if (err instanceof ChallengeThrottled) throw throttled(err.retryAfterSeconds);

    // Everything else here is a delivery problem, and it is ours, not the
    // caller's. Letting it surface would answer a registered address with a
    // 500 while an unregistered one gets the 200 returned above — which never
    // reaches this code at all, because there is nobody to mail. That
    // difference is an account oracle, and it opens exactly when a provider is
    // misconfigured or down: the moment the deployment is least able to notice
    // and an attacker is most able to enumerate. So the answer stays identical
    // and the operator is told instead.
    //
    // sendMail writes a FAILED outbox row before it throws, but an allow-list
    // refusal is rejected before that row is ever created — so for that case
    // this line is the only trace there will be. It carries no address: the
    // outbox row holds the recipient, and this log does not need to.
    logger.warn(
      { userId: user.id, reason: err?.name ?? 'delivery-failed' },
      'recovery code not delivered',
    );
  }
  res.json(ACCEPTED);
});

router.post('/forgot-password', recoveryLimiter, requestHandler);
router.post('/forgot-password/resend', recoveryLimiter, requestHandler);

// POST /auth/forgot-password/verify — spends one attempt and, on success,
// returns a reset authorization. Deliberately NOT a session: someone who reads
// a code off a phone screen gets the ability to choose a new password, which
// mails the owner, and not a signed-in tab with the day's takings in it.
router.post(
  '/forgot-password/verify',
  recoveryLimiter,
  asyncHandler(async (req, res) => {
    const { email, code } = verifySchema.parse(req.body);
    const user = await findRecoverable(email);

    // No account, no challenge — answered exactly as a wrong code is, and it
    // costs the same round trip either way.
    if (!user) throw badRequest('That code is not valid or has expired', 'code');

    const outcome = await prisma.$transaction(async (tx) => {
      const attempt = await consumeAttempt(tx, {
        userId: user.id,
        purpose: 'PASSWORD_RESET',
        code,
      });
      if (attempt.result !== CHALLENGE_RESULT.OK) return attempt;
      const authorization = await issueResetAuthorization(tx, attempt.challenge.id);
      await auditRequired(tx, req, {
        action: 'PASSWORD_RESET_CODE_VERIFIED',
        entity: 'PosUser',
        entityId: user.id,
        companyId: user.companyId,
        meta: { challengeId: attempt.challenge.id },
      });
      return { ...attempt, authorization };
    });

    if (outcome.result !== CHALLENGE_RESULT.OK) {
      await audit(req, {
        action: 'PASSWORD_RESET_CODE_REJECTED',
        entity: 'PosUser',
        entityId: user.id,
        companyId: user.companyId,
        meta: { reason: outcome.result },
      });
      // The audit row distinguishes expired from never-existed from
      // out-of-attempts; the caller gets one sentence for all of them, plus a
      // remaining count when there is one, because a form that will not say
      // "two tries left" trains people to keep guessing.
      if (outcome.result === CHALLENGE_RESULT.TOO_MANY_ATTEMPTS) {
        throw new AppError(
          400,
          'POS_BAD_REQUEST',
          'Too many incorrect codes. Request a new one to continue.',
          'code',
        );
      }
      throw new AppError(
        400,
        'POS_BAD_REQUEST',
        'That code is not valid or has expired',
        'code',
        outcome.attemptsRemaining === undefined ? undefined : { attemptsRemaining: outcome.attemptsRemaining },
      );
    }

    res.json({
      ok: true,
      resetToken: outcome.authorization.token,
      expiresAt: outcome.authorization.expiresAt,
    });
  }),
);

// POST /auth/forgot-password/reset — spends the authorization and sets the
// password. Everything that makes this safe happens inside one transaction:
// the authorization is consumed by a conditional UPDATE (so two concurrent
// resets cannot both win), the hash is written, and every session is revoked.
router.post(
  '/forgot-password/reset',
  recoveryLimiter,
  asyncHandler(async (req, res) => {
    const body = resetSchema.parse(req.body);
    if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
      throw badRequest('Passwords do not match', 'confirmPassword');
    }

    const passwordHash = await hashPassword(body.password);

    const user = await prisma.$transaction(async (tx) => {
      const challenge = await spendResetAuthorization(tx, body.resetToken);
      if (!challenge) return null;

      // Re-checked here, not trusted from the verify step: an account can be
      // disabled in the fifteen minutes an authorization is live, and the
      // disable must win.
      const target = await tx.posUser.findUnique({
        where: { id: challenge.userId },
        include: { company: true },
      });
      if (!recoverable(target)) return null;

      await tx.posUser.update({
        where: { id: target.id },
        // Role, company, branch, store assignments, licence and MFA enrolment
        // are all untouched. A reset restores access to the account that
        // existed; it does not re-grant or re-scope anything.
        data: { passwordHash, mustChangePassword: false },
      });
      await revokeAllSessions(tx, target.id);
      await auditRequired(tx, req, {
        action: 'PASSWORD_RESET_COMPLETED',
        entity: 'PosUser',
        entityId: target.id,
        companyId: target.companyId,
        meta: { challengeId: challenge.id },
      });
      return target;
    });

    if (!user) {
      await audit(req, {
        action: 'PASSWORD_RESET_REJECTED',
        entity: 'AuthChallenge',
        meta: { reason: 'authorization-not-spendable' },
      });
      throw badRequest('That reset link has expired. Start again from "Forgot password?".', 'resetToken');
    }

    // Best-effort: the password IS changed, and failing the request now would
    // tell the user their reset did not work when it did. The mail carries no
    // password — it is a warning to somebody who did not do this.
    await sendMailBestEffort({
      to: user.email,
      template: 'password-changed',
      message: passwordChangedEmail({ when: new Date(), ip: clientIp(req) }),
      companyId: user.companyId,
      userId: user.id,
    });

    res.json({
      ok: true,
      message: 'Your password has been updated. Please sign in with your new password.',
    });
  }),
);

export default router;
