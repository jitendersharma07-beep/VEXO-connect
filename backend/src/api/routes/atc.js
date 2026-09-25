import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, notFound, badRequest, AppError } from '../../lib/errors.js';
import { audit, auditRequired } from '../../lib/audit.js';
import { mailEnabled } from '../../config/env.js';
import { recipientAllowed } from '../../lib/mail/mailer.js';
import { requirePosAuth } from '../../middleware/auth.js';
import { requireAtc } from '../../middleware/rbac.js';
import { MODULE_KEYS, withDerived } from '../../lib/license.js';
import { roleLabel } from '../../lib/permissions.js';
import { requireAnotherActivePlatformAdmin } from '../../lib/userAuthority.js';
import {
  createInvitation,
  invitationView,
  isOpen,
  resendCooldownRemaining,
  rotateInvitationToken,
  sendInvitationMail,
} from '../../lib/invitations.js';

// ATC-side console: customer onboarding and licence control. Access, expiry
// and branch limits are decided here and only here — nothing a customer can
// reach writes to these tables.
const router = Router();

router.use(requirePosAuth, requireAtc);

const publicCompany = (c) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  status: c.status,
  isDemo: c.isDemo,
  contactName: c.contactName,
  contactEmail: c.contactEmail,
  contactPhone: c.contactPhone,
  city: c.city,
  state: c.state,
  createdAt: c.createdAt,
  branches: c._count?.branches,
  users: c._count?.users,
});

router.get(
  '/companies',
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({
      include: { _count: { select: { branches: true, users: true } }, licenses: { orderBy: { createdAt: 'desc' }, take: 1, include: { addons: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      companies: companies.map((c) => ({
        ...publicCompany(c),
        license: c.licenses[0]
          ? (({ plan, effectiveStatus, expiresAt, branchLimit }) => ({ plan, status: effectiveStatus, expiresAt, branchLimit }))(
              withDerived(c.licenses[0]),
            )
          : null,
      })),
    });
  }),
);

const companySchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, 'Slug must be 2-40 lowercase letters, digits or dashes'),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().toLowerCase().email().optional(),
  contactPhone: z.string().trim().max(20).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  isDemo: z.boolean().optional(),
});

router.post(
  '/companies',
  asyncHandler(async (req, res) => {
    const data = companySchema.parse(req.body);
    const exists = await prisma.company.findUnique({ where: { slug: data.slug } });
    if (exists) throw conflict(`Company slug "${data.slug}" is already taken`);
    const company = await prisma.company.create({ data });
    await audit(req, {
      action: 'COMPANY_CREATE',
      entity: 'Company',
      entityId: company.id,
      companyId: company.id,
      meta: { name: company.name, slug: company.slug, isDemo: company.isDemo },
    });
    res.status(201).json({ company: publicCompany(company) });
  }),
);

const loadCompany = asyncHandler(async (req, _res, next) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
  if (!company) throw notFound('Company not found');
  req.company = company;
  next();
});

router.get(
  '/companies/:companyId',
  loadCompany,
  asyncHandler(async (req, res) => {
    const [branches, users, licenses] = await Promise.all([
      prisma.branch.findMany({ where: { companyId: req.company.id }, orderBy: { createdAt: 'asc' } }),
      prisma.posUser.findMany({
        where: { companyId: req.company.id },
        select: { id: true, email: true, fullName: true, role: true, status: true, branchId: true, lastLoginAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.license.findMany({
        where: { companyId: req.company.id },
        include: { addons: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    res.json({
      company: publicCompany(req.company),
      branches,
      users,
      licenses: licenses.map((l) => {
        const d = withDerived(l);
        return {
          id: l.id,
          plan: l.plan,
          status: d.effectiveStatus,
          storedStatus: l.status,
          startsAt: l.startsAt,
          expiresAt: l.expiresAt,
          baseBranchLimit: l.baseBranchLimit,
          branchLimit: d.branchLimit,
          notes: l.notes,
          createdAt: l.createdAt,
          addons: l.addons,
        };
      }),
    });
  }),
);

const companyStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING']) });

router.patch(
  '/companies/:companyId/status',
  loadCompany,
  asyncHandler(async (req, res) => {
    const { status } = companyStatusSchema.parse(req.body);
    const company = await prisma.company.update({ where: { id: req.company.id }, data: { status } });
    if (status === 'SUSPENDED') {
      // Suspension is immediate: every live session of that company ends now.
      await prisma.posSession.updateMany({
        where: { revokedAt: null, user: { companyId: company.id } },
        data: { revokedAt: new Date() },
      });
    }
    await audit(req, {
      action: 'COMPANY_STATUS',
      entity: 'Company',
      entityId: company.id,
      companyId: company.id,
      meta: { status },
    });
    res.json({ company: publicCompany(company) });
  }),
);

const licenseSchema = z.object({
  plan: z.enum(['FREE_TRIAL', 'SINGLE_STORE', 'MULTI_STORE']),
  expiresAt: z.coerce.date(),
  startsAt: z.coerce.date().optional(),
  baseBranchLimit: z.number().int().min(1).max(500).optional(),
  // Extension modules sold on top of core POS. Validated against the registry
  // rather than accepted as free text, so a mistyped key is a 400 here instead
  // of a customer who has paid for a module and cannot reach it — the column
  // is an array of strings and the database cannot tell a typo from a product.
  //
  // Optional, and absent means none: every licence issued before this column
  // existed says core POS only, and that has to keep being what it says.
  // Issuing is create-only by design — ATC issues a NEW row to change a plan
  // and history stays intact — so granting or withdrawing a module is the same
  // operation as changing a plan, and is audited the same way.
  // Bounded by a constant rather than by the registry size: a caller naming
  // the same module twice is expressing one entitlement, not overflowing the
  // list, and a limit of "however many products exist today" would turn that
  // into a 400 the day it happened. Duplicates are collapsed on the way in.
  modules: z.array(z.enum(MODULE_KEYS)).max(20).optional(),
  notes: z.string().trim().max(500).optional(),
});

router.post(
  '/companies/:companyId/licenses',
  loadCompany,
  asyncHandler(async (req, res) => {
    const data = licenseSchema.parse(req.body);
    if (data.expiresAt <= new Date()) throw badRequest('expiresAt must be in the future', 'expiresAt');
    const license = await prisma.license.create({
      data: {
        companyId: req.company.id,
        plan: data.plan,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
        baseBranchLimit: data.plan === 'SINGLE_STORE' ? 1 : (data.baseBranchLimit ?? 1),
        // Deduplicated: the same module named twice is one entitlement, and
        // storing it twice would show up as two lines on whatever reads the
        // column next.
        modules: data.modules ? [...new Set(data.modules)] : [],
        notes: data.notes,
        createdById: req.user.id,
      },
      include: { addons: true },
    });
    await audit(req, {
      action: 'LICENSE_ISSUE',
      entity: 'License',
      entityId: license.id,
      companyId: req.company.id,
      meta: {
        plan: license.plan,
        expiresAt: license.expiresAt,
        baseBranchLimit: license.baseBranchLimit,
        // What was sold, in the audit trail. A module grant is a commercial
        // act and "who turned Inventory on for this customer, and when" has
        // to be answerable from the record rather than from the current value
        // of a column.
        modules: license.modules,
      },
    });
    const d = withDerived(license);
    res.status(201).json({ license: { ...license, status: d.effectiveStatus, branchLimit: d.branchLimit } });
  }),
);

const addonSchema = z.object({
  quantity: z.number().int().min(1).max(100),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
});

router.post(
  '/licenses/:licenseId/addons',
  asyncHandler(async (req, res) => {
    const data = addonSchema.parse(req.body);
    const license = await prisma.license.findUnique({ where: { id: req.params.licenseId } });
    if (!license) throw notFound('License not found');
    if (license.plan !== 'MULTI_STORE') {
      throw badRequest('Branch add-ons apply to MULTI_STORE licences only');
    }
    const addon = await prisma.licenseAddon.create({
      data: { licenseId: license.id, quantity: data.quantity, expiresAt: data.expiresAt, notes: data.notes },
    });
    await audit(req, {
      action: 'LICENSE_ADDON',
      entity: 'LicenseAddon',
      entityId: addon.id,
      companyId: license.companyId,
      meta: { quantity: addon.quantity, expiresAt: addon.expiresAt },
    });
    res.status(201).json({ addon });
  }),
);

const licenseStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']) });

router.patch(
  '/licenses/:licenseId/status',
  asyncHandler(async (req, res) => {
    const { status } = licenseStatusSchema.parse(req.body);
    const existing = await prisma.license.findUnique({ where: { id: req.params.licenseId } });
    if (!existing) throw notFound('License not found');
    const license = await prisma.license.update({
      where: { id: existing.id },
      data: { status },
      include: { addons: true },
    });
    await audit(req, {
      action: 'LICENSE_STATUS',
      entity: 'License',
      entityId: license.id,
      companyId: license.companyId,
      meta: { status },
    });
    const d = withDerived(license);
    res.json({ license: { ...license, status: d.effectiveStatus, branchLimit: d.branchLimit } });
  }),
);

// ---------------------------------------------------------------------------
// Inviting the customer's owner
// ---------------------------------------------------------------------------
//
// This used to mint a temporary password and return it in the response body.
// That made the owner's first credential something VEXO chose, VEXO saw, and
// VEXO then had to transmit — by whatever channel the operator reached for, to
// an address nobody had proved the customer controlled. It also put a live
// password into an API response, a browser's network tab and any screenshot of
// the onboarding screen.
//
// An invitation removes every one of those. The customer proves the mailbox by
// opening the link, chooses a password nobody else ever knows, and the account
// does not exist until they do. Nothing here can name a password because
// nothing here has one.

const ownerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
});

// Refused at the point of asking rather than written as a PENDING row nobody
// will ever receive — the same rule the tenant-side invitation route applies.
const requireMailConfigured = () => {
  if (!mailEnabled) {
    throw new AppError(
      503,
      'POS_MAIL_NOT_CONFIGURED',
      'Email is not configured on this deployment, so the owner invitation cannot be sent. ' +
        'Configure the sender before onboarding a customer.',
    );
  }
};

router.post(
  '/companies/:companyId/owner',
  loadCompany,
  asyncHandler(async (req, res) => {
    requireMailConfigured();
    const data = ownerSchema.parse(req.body);
    // A suspended or pending company must not gain an owner who can sign in the
    // moment it is reactivated without anyone reconsidering.
    if (req.company.status !== 'ACTIVE') {
      throw badRequest(`${req.company.name} is ${req.company.status}. Activate the company before inviting its owner.`);
    }

    const { invitation, token } = await prisma.$transaction(async (tx) => {
      // Throws conflict('An account with this email already exists') — the
      // caller is a named VEXO operator, so telling them the address is taken
      // is an answer they have earned.
      const created = await createInvitation(tx, {
        companyId: req.company.id,
        email: data.email,
        fullName: data.fullName,
        role: 'CUSTOMER_OWNER',
        createdById: req.user.id,
      });
      // Required-grade: this is the act that hands a company to somebody.
      await auditRequired(tx, req, {
        action: 'CUSTOMER_OWNER_INVITED',
        entity: 'UserInvitation',
        entityId: created.invitation.id,
        companyId: req.company.id,
        // No token, no hash, no link.
        meta: { email: data.email, role: 'CUSTOMER_OWNER', byAtc: true },
      });
      return created;
    });

    // Outside the transaction: an SMTP conversation is not something to hold a
    // database lock through, and a delivery failure leaves a resendable row
    // rather than rolling back an invitation that was correctly authorised.
    await sendInvitationMail({
      invitation,
      token,
      companyName: req.company.name,
      roleLabel: roleLabel('CUSTOMER_OWNER'),
      inviterName: req.user.fullName,
    });

    // The link is NOT in this response. It is a single-use credential and it
    // belongs in the customer's mailbox and nowhere else.
    res.status(201).json({ invitation: invitationView(invitation) });
  }),
);

router.get(
  '/companies/:companyId/invitations',
  loadCompany,
  asyncHandler(async (req, res) => {
    const invitations = await prisma.userInvitation.findMany({
      where: { companyId: req.company.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ invitations: invitations.map((i) => invitationView(i)) });
  }),
);

// Resend and revoke for invitations VEXO issued. The tenant-side routes cannot
// serve these: they scope by req.companyScope, and an operator working across
// customers is not inside any one of them.
const loadInvitation = asyncHandler(async (req, _res, next) => {
  const invitation = await prisma.userInvitation.findUnique({ where: { id: req.params.invitationId } });
  if (!invitation) throw notFound('Invitation not found');
  req.invitation = invitation;
  next();
});

router.post(
  '/invitations/:invitationId/resend',
  loadInvitation,
  asyncHandler(async (req, res) => {
    requireMailConfigured();
    if (!isOpen(req.invitation)) {
      throw badRequest('This invitation is no longer open. Send a new one instead.');
    }
    // The recipient did not ask for this mail, and a resend button is otherwise
    // a one-click way to post a stranger a message per press.
    const wait = resendCooldownRemaining(req.invitation);
    if (wait > 0) {
      throw new AppError(429, 'POS_RATE_LIMITED', 'This invitation was just sent. Please wait a moment before sending it again.', undefined, {
        retryAfterSeconds: wait,
      });
    }

    const rotated = await prisma.$transaction(async (tx) => {
      // A resend mints a NEW token and kills the old one, so a link forwarded
      // by mistake stops working rather than staying live for its full week.
      const result = await rotateInvitationToken(tx, req.invitation.id);
      if (!result) return null;
      await auditRequired(tx, req, {
        action: 'USER_INVITE_RESENT',
        entity: 'UserInvitation',
        entityId: req.invitation.id,
        companyId: req.invitation.companyId,
        meta: { email: req.invitation.email, sentCount: result.invitation.sentCount, byAtc: true },
      });
      return result;
    });
    if (!rotated) throw badRequest('This invitation is no longer open. Send a new one instead.');

    const company = rotated.invitation.companyId
      ? await prisma.company.findUnique({ where: { id: rotated.invitation.companyId }, select: { name: true } })
      : null;
    await sendInvitationMail({
      invitation: rotated.invitation,
      token: rotated.token,
      companyName: company?.name ?? null,
      roleLabel: roleLabel(rotated.invitation.role),
      inviterName: req.user.fullName,
    });
    res.json({ invitation: invitationView(rotated.invitation) });
  }),
);

router.post(
  '/invitations/:invitationId/revoke',
  loadInvitation,
  asyncHandler(async (req, res) => {
    if (req.invitation.status === 'ACCEPTED') {
      throw badRequest('This invitation has already been accepted. Disable the account instead.');
    }
    const invitation = await prisma.$transaction(async (tx) => {
      // Conditional on PENDING so a revoke racing an acceptance loses cleanly
      // rather than marking an existing account's own invitation revoked.
      const claimed = await tx.userInvitation.updateMany({
        where: { id: req.invitation.id, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedById: req.user.id },
      });
      if (claimed.count === 0) return null;
      await auditRequired(tx, req, {
        action: 'USER_INVITE_REVOKED',
        entity: 'UserInvitation',
        entityId: req.invitation.id,
        companyId: req.invitation.companyId,
        meta: { email: req.invitation.email, role: req.invitation.role, byAtc: true },
      });
      return tx.userInvitation.findUnique({ where: { id: req.invitation.id } });
    });
    if (!invitation) throw badRequest('This invitation has already been accepted. Disable the account instead.');
    res.json({ invitation: invitationView(invitation) });
  }),
);

// ---------------------------------------------------------------------------
// Platform administrators
// ---------------------------------------------------------------------------
//
// The accounts that own this console. They are created by invitation here or by
// scripts/bootstrap-platform-admin.mjs, and by nothing else — in particular
// never by registering an email, never by belonging to a domain, and never by
// promoting an account that already exists. Every one of those would make
// holding a mailbox sufficient to own the platform.

const platformAdminView = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  status: u.status,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
  emailVerifiedAt: u.emailVerifiedAt,
});

router.get(
  '/platform-admins',
  asyncHandler(async (_req, res) => {
    const [admins, invitations] = await Promise.all([
      prisma.posUser.findMany({
        where: { role: 'POS_SUPER_ADMIN', companyId: null },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.userInvitation.findMany({
        where: { role: 'POS_SUPER_ADMIN', companyId: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    res.json({
      admins: admins.map(platformAdminView),
      invitations: invitations.map((i) => invitationView(i)),
      // So the screen can grey out the last remaining Disable button for the
      // same reason the server would refuse it, rather than offering an action
      // that always fails.
      activeCount: admins.filter((a) => a.status === 'ACTIVE').length,
    });
  }),
);

router.post(
  '/platform-admins',
  asyncHandler(async (req, res) => {
    requireMailConfigured();
    const data = ownerSchema.parse(req.body);
    if (!recipientAllowed(data.email)) {
      throw badRequest(
        'Outside production this deployment may only mail approved addresses, and this one is not among them.',
        'email',
      );
    }

    const { invitation, token } = await prisma.$transaction(async (tx) => {
      const created = await createInvitation(tx, {
        companyId: null, // platform scope, not a tenant's
        email: data.email,
        fullName: data.fullName,
        role: 'POS_SUPER_ADMIN',
        createdById: req.user.id,
      });
      await auditRequired(tx, req, {
        action: 'PLATFORM_ADMIN_INVITED',
        entity: 'UserInvitation',
        entityId: created.invitation.id,
        meta: { email: data.email, role: 'POS_SUPER_ADMIN' },
      });
      return created;
    });

    await sendInvitationMail({
      invitation,
      token,
      companyName: null,
      roleLabel: roleLabel('POS_SUPER_ADMIN'),
      inviterName: req.user.fullName,
    });
    res.status(201).json({ invitation: invitationView(invitation) });
  }),
);

const adminStatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });

router.patch(
  '/platform-admins/:userId/status',
  asyncHandler(async (req, res) => {
    const { status } = adminStatusSchema.parse(req.body);
    const target = await prisma.posUser.findFirst({
      where: { id: String(req.params.userId), role: 'POS_SUPER_ADMIN', companyId: null },
    });
    if (!target) throw notFound('Platform administrator not found');

    if (status === 'DISABLED') {
      // Two refusals, and the ORDER is the point.
      //
      // Any caller here is themselves an active platform administrator, so
      // whenever the target is somebody else there is by definition another one
      // left and the last-admin check cannot fire. It is reachable only when a
      // caller disables THEMSELVES — which is also what the self-check catches.
      // Running the self-check first would therefore make the last-admin rule
      // permanently unreachable, and would answer the one unrecoverable case
      // ("nobody can administer this platform any more") with a message about
      // asking a colleague who does not exist.
      //
      // So: the permanent mistake is reported first, and the merely annoying
      // one — locking yourself out mid-task while colleagues remain — second.
      await requireAnotherActivePlatformAdmin(target.id);
      if (target.id === req.user.id) {
        throw badRequest('You cannot disable your own platform administrator account. Ask another administrator.');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.posUser.update({ where: { id: target.id }, data: { status } });
      if (status === 'DISABLED') {
        // Immediate: a disabled administrator with a live session is still an
        // administrator until it expires.
        await tx.posSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await auditRequired(tx, req, {
        action: 'PLATFORM_ADMIN_STATUS',
        entity: 'PosUser',
        entityId: user.id,
        meta: { email: user.email, status },
      });
      return user;
    });
    res.json({ admin: platformAdminView(updated) });
  }),
);

export default router;
