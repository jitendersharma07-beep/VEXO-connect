// ENTITLEMENT(CORE)
//
// Who may do what, and where. The rules here can only ever narrow the role
// baseline in lib/permissions.js, and the guards below exist because "cannot
// exceed the baseline" is not by itself enough: a delegated admin who could
// write rules about themselves, or about an action they do not hold, would have
// found a way round it without ever exceeding anything.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound, conflict } from '../../lib/errors.js';
import { audit, auditRequired } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  resolveStoreInScope,
  isStoreAction,
} from '../../middleware/permissions.js';
import {
  ACTIONS,
  ROLES,
  EXTENSION_POINTS,
  baselineFor,
  isKnownAction,
  isDefaultOff,
  scopeKeyFor,
  resolveRules,
  can,
} from '../../lib/permissions.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// The catalogue the permission screen renders. Sent rather than duplicated in
// the frontend, so a screen can never offer a toggle the API does not know
// about, and the extension points are labelled as not implemented instead of
// looking like features that are switched off.
router.get(
  '/catalog',
  requireAction('permission.read'),
  asyncHandler(async (req, res) => {
    res.json({
      actions: ACTIONS,
      roles: ROLES.map((role) => ({
        role,
        baseline: baselineFor(role),
        defaultOff: baselineFor(role).filter((a) => isDefaultOff(role, a)),
      })),
      extensionPoints: EXTENSION_POINTS,
    });
  }),
);

// What the CALLER may currently do. The screens read this and hide what they
// must not offer — presentation only; every one of these actions is enforced
// again on the request that uses it.
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({
      role: req.user.role,
      actions: req.perm.actions(),
      scope: req.perm.scope,
    });
  }),
);

const publicRule = (r) => ({
  id: r.id,
  level: r.level,
  branchId: r.branchId,
  branchName: r.branch?.name ?? null,
  userId: r.userId,
  userEmail: r.user?.email ?? null,
  action: r.action,
  effect: r.effect,
  note: r.note,
  updatedAt: r.updatedAt,
});

const ruleInclude = {
  branch: { select: { id: true, name: true } },
  user: { select: { id: true, email: true, fullName: true, role: true } },
};

router.get(
  '/rules',
  requireAction('permission.read'),
  asyncHandler(async (req, res) => {
    const rules = await prisma.permissionRule.findMany({
      where: { companyId: req.companyScope.id },
      include: ruleInclude,
      orderBy: [{ level: 'asc' }, { action: 'asc' }],
    });
    res.json({ rules: rules.map(publicRule) });
  }),
);

const ruleSchema = z.object({
  level: z.enum(['COMPANY', 'BRANCH', 'USER']),
  branchId: z.string().trim().min(1).optional(),
  userId: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1),
  effect: z.enum(['ALLOW', 'DENY']),
  note: z.string().trim().max(200).optional(),
});

// The caller's effective permission with one rule out of the picture — the
// exact permission state the removal being vetted would produce for them.
// Rebuilds the same principal context loadPermissionContext builds, from the
// same rows, minus the one rule.
const canWithoutRule = async (req, ruleId, action) => {
  let branchIds = [];
  if (req.perm.scope.kind === 'LIST') {
    branchIds = req.perm.scope.branchIds;
  } else if (req.perm.scope.kind === 'REGION') {
    const inRegion = await prisma.branch.findMany({
      where: { companyId: req.companyScope.id, regionId: req.perm.scope.regionId },
      select: { id: true },
    });
    branchIds = inRegion.map((b) => b.id);
  }
  const rules = await prisma.permissionRule.findMany({
    where: { companyId: req.companyScope.id, id: { not: ruleId } },
    select: { level: true, branchId: true, userId: true, action: true, effect: true },
  });
  const resolved = resolveRules(rules, { userId: req.user.id, branchIds });
  return can({ role: req.user.role, resolved }, action);
};

// Everything that stops a rule write from becoming an escalation. Each refusal
// is a rule somebody would otherwise reach for.
const vetRule = async (req, data, { excludeRuleId = null } = {}) => {
  if (!isKnownAction(data.action)) {
    // Not silently ignored: a rule for an action nothing enforces is a promise
    // to whoever set it that something is restricted when it is not.
    throw badRequest(`${data.action} is not a permission this system enforces`, 'action');
  }

  // You cannot hand out what you do not hold. Without this, a Company Admin with
  // permission.write could grant a colleague the two actions the owner
  // deliberately kept from them, and then be granted them back in turn.
  //
  // Removal is judged on the permission state it PRODUCES, not the live one:
  // the rule under removal is part of the caller's live permissions, so a
  // company-wide DENY would bind everyone it denies — the owner included —
  // into never being able to remove it. Re-evaluating with just that one rule
  // excluded frees exactly the people the rule itself was binding, while a
  // caller still denied the action by some OTHER rule keeps being refused —
  // their own DENY survives the removal, so they would be handing out an
  // action they do not hold. (The role baseline is deliberately NOT the
  // yardstick here: it would pass that second case, and it plays no part in
  // authorising a DELETE — the route's permission.write gate, the tenant-
  // scoped row lookup and the store/person checks below all still apply.)
  const holds = excludeRuleId
    ? await canWithoutRule(req, excludeRuleId, data.action)
    : req.perm.can(data.action);
  if (!holds) {
    throw forbidden(`You cannot change rules for "${data.action}" because you do not hold it yourself`);
  }

  if (data.level === 'BRANCH') {
    if (!data.branchId) throw badRequest('A store rule needs a store', 'branchId');
    if (!isStoreAction(data.action)) {
      throw badRequest(`"${data.action}" is company-wide, so it cannot be set per store`, 'action');
    }
    await resolveStoreInScope(req, data.branchId);
  }

  if (data.level === 'USER') {
    if (!data.userId) throw badRequest('A person rule needs a person', 'userId');
    // The one that matters most: nobody writes rules about themselves. A cashier
    // who somehow reached this route still cannot restore anything a broader
    // DENY took away from them.
    if (data.userId === req.user.id) {
      throw forbidden('You cannot change your own permissions');
    }
    const subject = await prisma.posUser.findFirst({
      where: { id: data.userId, companyId: req.companyScope.id },
      select: { id: true, role: true, email: true },
    });
    // A platform operator has companyId null and is therefore never found here,
    // which is deliberate: ATC accounts are not members of a customer's tenant
    // and must not be configurable from inside it.
    if (!subject) throw notFound('Person not found');
    if (subject.role === 'CUSTOMER_OWNER' && req.user.role !== 'CUSTOMER_OWNER' && req.user.role !== 'POS_SUPER_ADMIN') {
      throw forbidden('Only the account owner can change the owner’s permissions');
    }
    return subject;
  }
  return null;
};

// A company-wide DENY is a prohibition, and resolveRules will not let a narrower
// ALLOW lift it. Storing one anyway would leave a row on the screen that reads
// "allowed" and changes nothing — the exact lie this file exists to prevent.
//
// Checked only when STORING a rule. Deleting stays possible whatever the company
// has since decided, or a company DENY added later would strand every narrower
// ALLOW written before it, unremovable.
const assertNotHardDenied = async (req, data) => {
  if (data.level === 'COMPANY' || data.effect !== 'ALLOW') return;
  const companyDeny = await prisma.permissionRule.findFirst({
    where: { companyId: req.companyScope.id, level: 'COMPANY', action: data.action, effect: 'DENY' },
    select: { id: true },
  });
  if (companyDeny) {
    throw conflict(
      `"${data.action}" is denied for the whole company, and a store or person rule cannot lift that. ` +
        'Remove the company-wide rule first if this should be allowed anywhere.',
    );
  }
};

// Upsert, keyed by (tenant, scope, action) — the same shape DiscountPolicy uses,
// so setting the same rule twice corrects it instead of stacking duplicates that
// resolve unpredictably.
router.put(
  '/rules',
  requireAction('permission.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = ruleSchema.parse(req.body);
    await vetRule(req, data);
    await assertNotHardDenied(req, data);

    const scopeKey = scopeKeyFor(data.level, data);
    const payload = {
      companyId: req.companyScope.id,
      level: data.level,
      branchId: data.level === 'BRANCH' ? data.branchId : null,
      userId: data.level === 'USER' ? data.userId : null,
      scopeKey,
      action: data.action,
      effect: data.effect,
      note: data.note ?? null,
      updatedById: req.user.id,
    };

    // Rule and evidence on one transaction. Who widened whose permissions is
    // the first question asked after an incident, and a rule that took effect
    // without leaving that answer behind is worse than one that was refused.
    const rule = await prisma.$transaction(async (tx) => {
      const saved = await tx.permissionRule.upsert({
        where: {
          companyId_scopeKey_action: {
            companyId: req.companyScope.id,
            scopeKey,
            action: data.action,
          },
        },
        create: payload,
        update: { effect: payload.effect, note: payload.note, updatedById: req.user.id },
        include: ruleInclude,
      });
      await auditRequired(tx, req, {
        action: 'PERMISSION_RULE_SET',
        entity: 'PermissionRule',
        entityId: saved.id,
        companyId: req.companyScope.id,
        meta: { level: saved.level, scopeKey, action: saved.action, effect: saved.effect },
      });
      return saved;
    });

    await auditPlatformWrite(req);
    res.json({ rule: publicRule(rule) });
  }),
);

// Removing a rule reverts that scope to the baseline — which may be stricter or
// looser than the rule was. The audit row records which action stopped being
// overridden, so "why can they suddenly do that" has an answer.
router.delete(
  '/rules/:id',
  requireAction('permission.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const existing = await prisma.permissionRule.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
    });
    if (!existing) throw notFound('Rule not found');
    await vetRule(req, {
      level: existing.level,
      branchId: existing.branchId ?? undefined,
      userId: existing.userId ?? undefined,
      action: existing.action,
      effect: existing.effect,
    }, { excludeRuleId: existing.id });

    await prisma.$transaction(async (tx) => {
      await tx.permissionRule.delete({ where: { id: existing.id } });
      await auditRequired(tx, req, {
        action: 'PERMISSION_RULE_CLEAR',
        entity: 'PermissionRule',
        entityId: existing.id,
        companyId: req.companyScope.id,
        meta: { level: existing.level, scopeKey: existing.scopeKey, action: existing.action, effect: existing.effect },
      });
    });
    await auditPlatformWrite(req);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Store assignments — the organisational half of the contract
// ---------------------------------------------------------------------------

router.get(
  '/assignments',
  requireAction('user.read'),
  asyncHandler(async (req, res) => {
    const rows = await prisma.userStoreAssignment.findMany({
      where: { branch: { companyId: req.companyScope.id } },
      select: { userId: true, branchId: true },
    });
    res.json({ assignments: rows });
  }),
);

const assignmentSchema = z.object({ storeIds: z.array(z.string().trim().min(1)).max(200) });

// Replaces the whole list for one person. Assignments REPLACE the scope the
// subject's role implies (the authoritative rule is stated once, on
// storeScopeFor in lib/permissions.js), so for a store-pinned role this WIDENS
// reach — which is why it needs user.write, why every store must already be
// inside the caller's OWN scope, and why nobody may edit their own. A regional
// manager cannot post a store id from another region to give somebody access to
// it. Scope changes where actions apply; it never adds one.
router.put(
  '/assignments/:userId',
  requireAction('user.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const { storeIds } = assignmentSchema.parse(req.body);
    if (req.params.userId === req.user.id) {
      throw forbidden('You cannot change which stores you are assigned to');
    }
    const subject = await prisma.posUser.findFirst({
      where: { id: req.params.userId, companyId: req.companyScope.id },
      select: { id: true, email: true, role: true },
    });
    if (!subject) throw notFound('Person not found');
    // Assignments REPLACE the reach a role implies — for the owner, "every
    // store". Without this, a delegated admin with user.write could pin the
    // owner to one store and narrow their reach company-wide. Same standing
    // as the owner guard in vetRule above.
    if (subject.role === 'CUSTOMER_OWNER' && req.user.role !== 'CUSTOMER_OWNER' && req.user.role !== 'POS_SUPER_ADMIN') {
      throw forbidden('Only the account owner can change the owner’s store assignments');
    }

    const unique = [...new Set(storeIds)];
    for (const id of unique) await resolveStoreInScope(req, id);

    await prisma.$transaction(async (tx) => {
      await tx.userStoreAssignment.deleteMany({ where: { userId: subject.id } });
      if (unique.length) {
        await tx.userStoreAssignment.createMany({
          // The tenant is taken from the resolved scope, never from the body.
          // It is the column both the user and the store are checked against,
          // so it is what makes "this person, this store, one company" a
          // database fact rather than a hope about the route above it.
          data: unique.map((branchId) => ({
            userId: subject.id,
            branchId,
            companyId: req.companyScope.id,
            createdById: req.user.id,
          })),
        });
      }
      await auditRequired(tx, req, {
        action: 'USER_STORES_SET',
        entity: 'PosUser',
        entityId: subject.id,
        companyId: req.companyScope.id,
        meta: { email: subject.email, role: subject.role, storeIds: unique },
      });
    });

    await auditPlatformWrite(req);
    res.json({ userId: subject.id, storeIds: unique });
  }),
);

// ---------------------------------------------------------------------------
// VEXO support access — explicit, named, time-boxed, audited
// ---------------------------------------------------------------------------

const publicGrant = (g) => ({
  id: g.id,
  userId: g.userId,
  operatorEmail: g.user?.email ?? null,
  operatorName: g.user?.fullName ?? null,
  reason: g.reason,
  grantedByEmail: g.grantedBy?.email ?? null,
  grantedAt: g.grantedAt,
  expiresAt: g.expiresAt,
  revokedAt: g.revokedAt,
  active: !g.revokedAt && g.expiresAt > new Date(),
});

const grantInclude = {
  user: { select: { id: true, email: true, fullName: true } },
  grantedBy: { select: { id: true, email: true } },
};

router.get(
  '/support-grants',
  requireAction('support.grant.read'),
  asyncHandler(async (req, res) => {
    const grants = await prisma.supportAccessGrant.findMany({
      where: { companyId: req.companyScope.id },
      include: grantInclude,
      orderBy: { grantedAt: 'desc' },
      take: 100,
    });
    res.json({ grants: grants.map(publicGrant) });
  }),
);

const grantSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  reason: z.string().trim().min(4).max(200),
  // Capped at a week. An access window measured in months is standing access
  // with a consent label on it.
  hours: z.coerce.number().int().min(1).max(168).default(24),
});

// Only a member of the tenant can grant. A platform operator is explicitly
// refused, because a support grant a platform operator can write for themselves
// records consent that was never given — and it is the credential that unlocks
// permission.write on this customer's account.
const requireTenantPrincipal = (req) => {
  if (req.user.role === 'POS_SUPER_ADMIN' || req.user.companyId !== req.companyScope.id) {
    throw forbidden('Only someone inside this account can grant or revoke VEXO support access');
  }
};

router.post(
  '/support-grants',
  requireAction('support.grant.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    requireTenantPrincipal(req);
    const data = grantSchema.parse(req.body);

    const operator = await prisma.posUser.findUnique({
      where: { email: data.email },
      select: { id: true, email: true, fullName: true, role: true, status: true },
    });
    if (!operator || operator.role !== 'POS_SUPER_ADMIN' || operator.status !== 'ACTIVE') {
      // Recorded even when it fails: a tenant probing for VEXO staff addresses
      // is worth knowing about, and the reply says nothing about which of the
      // three conditions missed.
      await audit(req, {
        action: 'SUPPORT_GRANT_TARGET_REJECTED',
        entity: 'Company',
        entityId: req.companyScope.id,
        companyId: req.companyScope.id,
        meta: { email: data.email },
      });
      throw badRequest('That is not an active VEXO support account', 'email');
    }

    const live = await prisma.supportAccessGrant.findFirst({
      where: {
        companyId: req.companyScope.id,
        userId: operator.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, expiresAt: true },
    });
    if (live) {
      throw conflict(
        `${operator.email} already has access until ${live.expiresAt.toISOString()}. Revoke it first to change the window.`,
      );
    }

    const grant = await prisma.$transaction(async (tx) => {
      const made = await tx.supportAccessGrant.create({
        data: {
          companyId: req.companyScope.id,
          userId: operator.id,
          reason: data.reason,
          grantedById: req.user.id,
          expiresAt: new Date(Date.now() + data.hours * 3600_000),
        },
        include: grantInclude,
      });
      await auditRequired(tx, req, {
        action: 'SUPPORT_GRANT_CREATE',
        entity: 'SupportAccessGrant',
        entityId: made.id,
        companyId: req.companyScope.id,
        meta: { operatorEmail: operator.email, hours: data.hours, reason: data.reason },
      });
      return made;
    });
    res.status(201).json({ grant: publicGrant(grant) });
  }),
);

router.post(
  '/support-grants/:id/revoke',
  requireAction('support.grant.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    requireTenantPrincipal(req);
    const existing = await prisma.supportAccessGrant.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id },
      include: grantInclude,
    });
    if (!existing) throw notFound('Grant not found');
    if (existing.revokedAt) throw conflict('That access has already been revoked');

    const grant = await prisma.$transaction(async (tx) => {
      const updated = await tx.supportAccessGrant.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedById: req.user.id },
        include: grantInclude,
      });
      await auditRequired(tx, req, {
        action: 'SUPPORT_GRANT_REVOKE',
        entity: 'SupportAccessGrant',
        entityId: updated.id,
        companyId: req.companyScope.id,
        meta: { operatorEmail: updated.user?.email },
      });
      return updated;
    });
    res.json({ grant: publicGrant(grant) });
  }),
);

export default router;
