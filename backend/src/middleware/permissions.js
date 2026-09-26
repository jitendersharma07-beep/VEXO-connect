import { prisma } from '../lib/prisma.js';
import { forbidden, notFound, unauthorized, moduleNotLicensed, asyncHandler } from '../lib/errors.js';
import { audit, auditRequired } from '../lib/audit.js';
import { licenseHasModule } from '../lib/license.js';
import {
  can,
  effectiveActions,
  resolveRules,
  storeScopeFor,
  branchWhereForScope,
  branchIdWhereForScope,
  actionMeta,
  requiredModuleFor,
  SUPPORT_GRANT_REQUIRED,
} from '../lib/permissions.js';

// Server-side authorisation. Every gate in this file runs on the request, not
// in the browser: the admin screens read the same effective-action list so they
// do not offer controls the API would refuse, but hiding a button is
// presentation and this is the enforcement.

/**
 * What a principal may do, and where — resolved from stored assignments and
 * rules rather than from anything the caller sent.
 *
 * Separated from the middleware because a request is not the only thing that
 * needs this answer. A scheduled report runs with nobody's session attached and
 * still has to be held to its owner's current authority, and the one thing that
 * must not exist is a second implementation of this resolution: the day the two
 * disagree, the timer delivers a reach the screen would have refused.
 */
export const permissionContextFor = async (user, companyId) => {
  // A platform operator has no assignments and no rules of its own — its reach
  // is the role, narrowed by the support-grant check in requireAction.
  const isPlatform = user.role === 'POS_SUPER_ADMIN';

  const [assignments, rules] = await Promise.all([
    isPlatform
      ? []
      : prisma.userStoreAssignment.findMany({
          where: { userId: user.id, branch: { companyId } },
          select: { branchId: true },
        }),
    companyId
      ? prisma.permissionRule.findMany({
          where: { companyId },
          select: { level: true, branchId: true, userId: true, action: true, effect: true },
        })
      : [],
  ]);

  const scope = storeScopeFor(user, assignments);

  // Which stores a BRANCH-level rule may bind to for this principal.
  //
  // A REGION scope does name stores — just indirectly — so the region is
  // expanded here. Without this a regional manager was the one principal no
  // per-store rule could restrict: "deny refunds at the airport outlet" would
  // silently do nothing to the person most likely to be standing in it.
  //
  // A COMPANY scope genuinely names none. Branch rules do not apply to a
  // company-wide user, because they are not "at" any one store; the tenant
  // restricts those principals with a COMPANY-level rule instead.
  let ruleBranchIds = [];
  if (scope.kind === 'LIST') {
    ruleBranchIds = scope.branchIds;
  } else if (scope.kind === 'REGION') {
    const inRegion = await prisma.branch.findMany({
      where: { companyId, regionId: scope.regionId },
      select: { id: true },
    });
    ruleBranchIds = inRegion.map((b) => b.id);
  }

  const resolved = resolveRules(rules, { userId: user.id, branchIds: ruleBranchIds });

  return {
    role: user.role,
    resolved,
    scope,
    can: (action) => can({ role: user.role, resolved }, action),
    actions: () => effectiveActions({ role: user.role, resolved }),
  };
};

// Builds req.perm. Mount after resolveCompanyScope, which establishes the
// tenant; this adds "and what may they do, where".
export const loadPermissionContext = asyncHandler(async (req, _res, next) => {
  if (!req.user) throw unauthorized();
  req.perm = await permissionContextFor(req.user, req.companyScope?.id ?? null);
  next();
});

// An active, unexpired, tenant-issued grant for this operator.
const hasSupportGrant = async (userId, companyId) => {
  if (!companyId) return false;
  const grant = await prisma.supportAccessGrant.findFirst({
    where: { userId, companyId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return Boolean(grant);
};

// The gate. `requireAction('org.gst.write')` and nothing else — the route does
// not repeat the role list, so adding a role never means auditing every router
// for the ones that forgot.
export const requireAction = (action) =>
  asyncHandler(async (req, _res, next) => {
    if (!req.perm) throw unauthorized();
    if (!req.perm.can(action)) {
      throw forbidden('You do not have permission to perform this action');
    }
    // Entitlement, checked after the permission and before the route. The two
    // are not interchangeable and the order matters: a permission says what this
    // employee may do inside their tenant, and the licence says what the tenant
    // bought. Only the licence can express "this customer did not buy KDS", and
    // no role, rule or custom permission may substitute for it — which is why
    // this is not folded into `can()`.
    //
    // Checked here rather than at each module's router because "refused at the
    // permission layer" is the guarantee `License.modules` is documented to
    // give, and one gate on the path every action already takes cannot be
    // forgotten by the next lane that mounts a router.
    //
    // Fails CLOSED on a missing licence: no licence is not "all modules". The
    // empty default on `License.modules` means core POS only, so every licence
    // sold before that column existed keeps working and none of them silently
    // acquires a module it never paid for.
    const module = requiredModuleFor(action);
    if (module && req.user.role !== 'POS_SUPER_ADMIN' && !licenseHasModule(req.license, module)) {
      throw moduleNotLicensed(module);
    }
    if (req.user.role === 'POS_SUPER_ADMIN' && SUPPORT_GRANT_REQUIRED.includes(action)) {
      const ok = await hasSupportGrant(req.user.id, req.companyScope?.id ?? null);
      // Both arms are REQUIRED audit, and both are written before the route
      // body runs. "Did VEXO touch my account, and when did they try to?" is
      // the question this whole mechanism exists to answer, so an operator
      // proceeding past a failed audit write would defeat it entirely. If the
      // row cannot be stored the request dies here — noisily, and without
      // access, which is the safe direction for both arms.
      if (!ok) {
        await auditRequired(prisma, req, {
          action: 'SUPPORT_ACCESS_DENIED',
          entity: 'Company',
          entityId: req.companyScope?.id,
          companyId: req.companyScope?.id,
          meta: { attemptedAction: action },
        });
        throw forbidden(
          'This action needs support access the customer has granted. Ask the account owner to grant it from Users & Access.',
        );
      }
      await auditRequired(prisma, req, {
        action: 'SUPPORT_ACCESS_USED',
        entity: 'Company',
        entityId: req.companyScope?.id,
        companyId: req.companyScope?.id,
        meta: { grantedAction: action },
      });
    }
    next();
  });

// Every write a platform operator makes inside a customer's tenant leaves a
// row. "VEXO changed something in my account" must always be answerable, and
// before this the only evidence was whatever the individual route happened to
// audit.
//
// Routine grade on purpose, not by oversight. This runs AFTER the route's
// transaction has committed, so a hard failure here could only report an error
// for a change that already happened — inviting a retry that applies it twice.
// It is a backstop; the evidence that has to be durable is written inside the
// change itself (auditRequired) or before it runs (SUPPORT_ACCESS_USED above).
export const auditPlatformWrite = (req) => {
  if (req.user?.role !== 'POS_SUPER_ADMIN') return;
  if (req.method === 'GET' || req.method === 'HEAD') return;
  return audit(req, {
    action: 'PLATFORM_TENANT_WRITE',
    entity: 'Company',
    entityId: req.companyScope?.id,
    companyId: req.companyScope?.id,
    meta: { method: req.method, path: req.originalUrl?.split('?')[0] },
  });
};

// Proves a store id is inside BOTH the tenant and the caller's own scope, and
// returns the row. A store in another tenant and a store outside the caller's
// assignments both answer "Store not found" — identical replies, so probing ids
// cannot map somebody else's estate.
// AND, not a spread, and the distinction is the whole function. For any scope
// narrower than the whole tenant branchWhereForScope returns `{ id: { in: [...] } }`,
// so `{ id: String(branchId), ..., ...fragment }` DELETED the `id` being checked
// and asked instead "is there any store in this caller's scope?" — which is yes
// for everyone who has a store at all. findFirst then returned SOME store the
// caller holds instead of throwing, so:
//
//   - Callers that use the RESOLVED branch.id wrote into the caller's own store
//     while reporting success for the one they were asked about: terminals.js,
//     devices.js, drawer.js, paymentAccounts.js:153, and resolvePlacement() in
//     lib/userAuthority.js:105. A till created in the wrong outlet, quietly.
//     Misfiled data, but the write stayed inside the caller's own reach — and
//     userAuthority's promise ("a scoped admin cannot place staff where they
//     themselves cannot go") therefore held; only the requested store was
//     silently substituted.
//   - Callers that persist the id from the REQUEST BODY after this check passes
//     handed out reach the caller does not have, which is a different kind of
//     failure. PUT /permissions/assignments/:userId (routes/permissions.js:359)
//     assigns immediately. POST /invitations (routes/invitations.js:119) is the
//     same grant DEFERRED: storeIds sit on the invitation and become real
//     UserStoreAssignment rows when it is ACCEPTED, and nothing at acceptance
//     re-checks the inviter's scope. Both routes' own comments promise this is
//     impossible. brands.js:147 is the same shape without the privilege: a brand
//     attached to a store the caller cannot reach.
//   - The gates in orders.js were masked throughout by loadOrder's stricter
//     legacy branch pin, so nothing reachable there changed behaviour.
//
// The tenant boundary was never affected: companyId is a different key and
// survived the spread, so this was never a cross-tenant leak.
export const resolveStoreInScope = async (req, branchId) => {
  if (!branchId) throw notFound('Store not found');
  const branch = await prisma.branch.findFirst({
    where: {
      id: String(branchId),
      companyId: req.companyScope.id,
      AND: [branchWhereForScope(req.perm.scope)],
    },
  });
  if (!branch) throw notFound('Store not found');
  return branch;
};

// Route-param flavour of the same check, for `/:branchId/...` shapes.
export const requireStoreParam = (param = 'branchId') =>
  asyncHandler(async (req, _res, next) => {
    req.branch = await resolveStoreInScope(req, req.params[param]);
    next();
  });

// Prisma `where` fragments for list endpoints, so a scoped caller's list and
// their permitted detail reads can never disagree.
export const scopedBranchWhere = (req) => branchWhereForScope(req.perm.scope);
export const scopedBranchIdWhere = (req) => branchIdWhereForScope(req.perm.scope);

// True when the action needs a store to mean anything. Used by the permission
// screen to group rules, and by the rules route to refuse a BRANCH-level rule
// for a company-wide action.
export const isStoreAction = (action) => actionMeta(action)?.scope === 'STORE';
