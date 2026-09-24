// ENTITLEMENT(CORE)
//
// Staff accounts that the new colleague creates for themselves.
//
// The tenant names an email, a role and where it applies; the person on the
// other end proves they hold the mailbox and chooses their own password.
// Nothing in this file ever knows that password.
//
// The difference from POST /users, which also creates staff without handing
// anyone a credential, is WHEN the account exists. An invitation creates no
// user row until it is accepted, so a mistyped address lapses into nothing in
// a week; a direct create puts the row in place immediately and mails the
// person a code to set their password. Invitations are also revocable and
// resendable, which is why this is the path the Companies screen uses to seat
// an owner into a brand-new tenant.
//
// Who may invite whom is NOT decided here — it is the same reach rule that
// governs direct creation, imported from lib/userAuthority.js so the two
// cannot drift into disagreeing.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound, AppError } from '../../lib/errors.js';
import { audit, auditRequired } from '../../lib/audit.js';
import { mailEnabled } from '../../config/env.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { recoveryLimiter } from '../../middleware/rateLimit.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  resolveStoreInScope,
} from '../../middleware/permissions.js';
import { roleLabel } from '../../lib/permissions.js';
import { emailField, passwordField } from '../../lib/accounts.js';
import {
  ASSIGNABLE_ROLES,
  assignableRolesFor,
  requireOwnerAuthority,
  requireRoleWithinReach,
  resolvePlacement,
} from '../../lib/userAuthority.js';
import {
  acceptInvitation,
  createInvitation,
  findByToken,
  invitationOffer,
  invitationView,
  isOpen,
  placementNames,
  resendCooldownRemaining,
  rotateInvitationToken,
  sendInvitationMail,
} from '../../lib/invitations.js';

// ---------------------------------------------------------------------------
// Management — inside the tenant, behind user.write
// ---------------------------------------------------------------------------

const router = Router();
router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// An invitation that cannot be delivered is an invitation that will never be
// accepted, so the refusal belongs at the point of asking rather than as a
// PENDING row nobody can act on.
const requireMailConfigured = () => {
  if (!mailEnabled) {
    throw new AppError(
      503,
      'POS_MAIL_NOT_CONFIGURED',
      'Email is not configured on this deployment, so invitations cannot be sent. Please contact your administrator.',
    );
  }
};

router.get(
  '/',
  requireAction('user.read'),
  asyncHandler(async (req, res) => {
    const invitations = await prisma.userInvitation.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({
      invitations: invitations.map((i) => invitationView(i)),
      assignableRoles: assignableRolesFor(req),
    });
  }),
);

const createSchema = z.object({
  email: emailField,
  fullName: z.string().trim().min(2).max(120),
  role: z.enum(ASSIGNABLE_ROLES),
  branchId: z.string().trim().min(1).optional(),
  regionId: z.string().trim().min(1).optional(),
  storeIds: z.array(z.string().trim().min(1)).max(200).optional(),
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

    // Store assignments REPLACE the reach a role implies, so naming stores
    // here is the same authority question PUT /permissions/assignments asks:
    // every one must already be inside the CALLER's own scope, or a regional
    // manager could invite somebody into a region they cannot reach.
    const storeIds = [...new Set(data.storeIds ?? [])];
    for (const id of storeIds) await resolveStoreInScope(req, id);

    const { invitation, token } = await prisma.$transaction(async (tx) => {
      const created = await createInvitation(tx, {
        companyId: req.companyScope.id,
        email: data.email,
        fullName: data.fullName,
        role: data.role,
        storeIds,
        createdById: req.user.id,
        ...placement,
      });
      await auditRequired(tx, req, {
        action: 'USER_INVITED',
        entity: 'UserInvitation',
        entityId: created.invitation.id,
        companyId: req.companyScope.id,
        meta: { email: data.email, role: data.role, ...placement, storeIds },
      });
      return created;
    });

    // Outside the transaction on purpose: an SMTP conversation is not
    // something to hold a database lock through, and a delivery failure is
    // reported as one — the row stays PENDING and can be resent — rather than
    // rolling back an invitation the tenant asked for.
    await sendInvitationMail({
      invitation,
      token,
      companyName: req.companyScope.name,
      roleLabel: roleLabel(data.role),
      inviterName: req.user.fullName,
    });
    await auditPlatformWrite(req);
    res.status(201).json({ invitation: invitationView(invitation) });
  }),
);

const findInvitationInScope = async (req) => {
  const invitation = await prisma.userInvitation.findFirst({
    where: { id: String(req.params.id), companyId: req.companyScope.id },
  });
  if (!invitation) throw notFound('Invitation not found');
  return invitation;
};

router.post(
  '/:id/resend',
  requireAction('user.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    requireMailConfigured();
    const existing = await findInvitationInScope(req);
    if (!isOpen(existing)) {
      throw badRequest('This invitation is no longer open. Send a new one instead.');
    }
    // Same cooldown the email-code challenge uses, for the same reason: the
    // person being invited did not ask for this mail, and a resend button is
    // otherwise a one-click way to post a stranger a message per press.
    const wait = resendCooldownRemaining(existing);
    if (wait > 0) {
      throw new AppError(
        429,
        'POS_RATE_LIMITED',
        'This invitation was just sent. Please wait a moment before sending it again.',
        undefined,
        { retryAfterSeconds: wait },
      );
    }
    // The role may have moved out of the caller's reach since it was issued —
    // a DENY rule, a narrowed scope — and a resend is a fresh act of granting.
    if (existing.role === 'CUSTOMER_OWNER') requireOwnerAuthority(req);
    requireRoleWithinReach(req, existing.role);

    const rotated = await prisma.$transaction(async (tx) => {
      const result = await rotateInvitationToken(tx, existing.id);
      if (!result) return null;
      await auditRequired(tx, req, {
        action: 'USER_INVITE_RESENT',
        entity: 'UserInvitation',
        entityId: existing.id,
        companyId: req.companyScope.id,
        meta: { email: existing.email, sentCount: result.invitation.sentCount },
      });
      return result;
    });
    if (!rotated) throw badRequest('This invitation is no longer open. Send a new one instead.');

    await sendInvitationMail({
      invitation: rotated.invitation,
      token: rotated.token,
      companyName: req.companyScope.name,
      roleLabel: roleLabel(rotated.invitation.role),
      inviterName: req.user.fullName,
    });
    await auditPlatformWrite(req);
    res.json({ invitation: invitationView(rotated.invitation) });
  }),
);

router.post(
  '/:id/revoke',
  requireAction('user.write'),
  // No licence gate: withdrawing an invitation that should not have been sent
  // is a security operation, and it must not wait for a renewal payment.
  asyncHandler(async (req, res) => {
    const existing = await findInvitationInScope(req);
    if (existing.status === 'ACCEPTED') {
      throw badRequest('This invitation has already been accepted. Disable the account instead.');
    }
    const invitation = await prisma.$transaction(async (tx) => {
      // Conditional on PENDING so a revoke racing an acceptance loses cleanly
      // rather than marking an account's own invitation revoked after the fact.
      const claimed = await tx.userInvitation.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedById: req.user.id },
      });
      if (claimed.count === 0) return null;
      await auditRequired(tx, req, {
        action: 'USER_INVITE_REVOKED',
        entity: 'UserInvitation',
        entityId: existing.id,
        companyId: req.companyScope.id,
        meta: { email: existing.email, role: existing.role },
      });
      return tx.userInvitation.findUnique({ where: { id: existing.id } });
    });
    if (!invitation) throw badRequest('This invitation has already been accepted. Disable the account instead.');
    await auditPlatformWrite(req);
    res.json({ invitation: invitationView(invitation) });
  }),
);

// ---------------------------------------------------------------------------
// Acceptance — public, and mounted separately
// ---------------------------------------------------------------------------
//
// The token arrives in the BODY of a POST, never in the path or the query.
// pino-http logs req.url on every request, and a proxy, a browser history and
// a Referer header all carry a URL further than anyone intends; an invitation
// token in any of those is an account waiting to be taken. The emailed link
// puts it in the URL fragment, which no server ever receives, and the page
// reads it from there and posts it here.

export const publicRouter = Router();

const tokenField = z.string().trim().min(10).max(200);

// One answer for every way an invitation can fail to be usable: unknown,
// revoked, expired, already accepted, or belonging to a tenant that has since
// been suspended. Distinguishing them tells an uninvited holder of a link
// which guess was close.
const NOT_USABLE = 'This invitation link is not valid, or it has expired. Ask for a new one.';

const usableInvitation = async (token) => {
  const invitation = await findByToken(prisma, token);
  if (!isOpen(invitation)) return null;
  // A suspended tenant must not gain staff. Platform invitations have no
  // company and are not subject to this.
  if (invitation.companyId && invitation.company?.status !== 'ACTIVE') return null;
  return invitation;
};

// The same per-address ceiling password recovery sits behind. A 256-bit token
// is not guessable, so this is not about the token: it is about an
// unauthenticated endpoint that hits the database, and about not letting one
// client pound it.
publicRouter.use(recoveryLimiter);

publicRouter.post(
  '/lookup',
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: tokenField }).parse(req.body);
    const invitation = await usableInvitation(token);
    if (!invitation) throw badRequest(NOT_USABLE, 'token');
    const names = await placementNames(prisma, invitation);
    res.json({ invitation: { ...invitationOffer(invitation, names), roleLabel: roleLabel(invitation.role) } });
  }),
);

const acceptSchema = z.object({
  token: tokenField,
  password: passwordField,
  confirmPassword: z.string().optional(),
});

publicRouter.post(
  '/accept',
  asyncHandler(async (req, res) => {
    const body = acceptSchema.parse(req.body);
    if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
      throw badRequest('Passwords do not match', 'confirmPassword');
    }
    const invitation = await usableInvitation(body.token);
    if (!invitation) {
      await audit(req, {
        action: 'USER_INVITE_REJECTED',
        entity: 'UserInvitation',
        meta: { reason: 'not-usable' },
      });
      throw badRequest(NOT_USABLE, 'token');
    }

    const user = await prisma.$transaction(async (tx) => {
      const created = await acceptInvitation(tx, invitation, { password: body.password });
      // Thrown rather than returned, so the claim acceptInvitation may already
      // have made on the row rolls back with it. An invitation that loses this
      // race must be left exactly as it was, not burned by the attempt.
      if (!created) throw badRequest(NOT_USABLE, 'token');
      await auditRequired(tx, req, {
        action: 'USER_INVITE_ACCEPTED',
        entity: 'PosUser',
        entityId: created.id,
        companyId: created.companyId,
        meta: { email: created.email, role: created.role, invitationId: invitation.id },
      });
      return created;
    });

    await audit(req, {
      action: 'USER_CREATE',
      entity: 'PosUser',
      entityId: user.id,
      companyId: user.companyId,
      meta: { email: user.email, role: user.role, via: 'invitation' },
    });

    // No session is issued. Accepting proves the mailbox, not the person at
    // the keyboard, and signing them in here would mean an emailed link that
    // opens a till — the same reasoning that keeps password recovery from
    // returning a session. They now have a password; the sign-in page is one
    // click away and is the only thing that mints one.
    res.status(201).json({
      ok: true,
      email: user.email,
      message: 'Your account is ready. Please sign in with your new password.',
    });
  }),
);

export default router;
