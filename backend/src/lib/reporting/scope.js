// LANE reporting — which stores a report is allowed to include.
//
// Resolved on the server from the caller's own scope, then applied as a literal
// branch-id list to every query, export row and scheduled send. Navigation is not
// a control: /api/reporting answers the same set of stores whether the caller
// arrived from a menu, a saved link, a CSV download or a nightly email.
//
// This is also where the legacy /api/reports gate is corrected. That router asks
// requireRole('POS_SUPER_ADMIN','CUSTOMER_OWNER','BRANCH_MANAGER'), so FINANCE,
// REGIONAL_MANAGER, AUDITOR and PURCHASE are refused even though the permission
// catalog grants them report.sales.read. Widening that role list alone would have
// been worse than the bug: branchFilterFor pins only BRANCH_MANAGER and CASHIER,
// so a regional manager would have received the whole company. Authority comes
// from the action, reach comes from the scope, and both are checked here.

import { prisma } from '../prisma.js';
import { badRequest, notFound } from '../errors.js';

const BRANCH_SELECT = {
  id: true,
  name: true,
  code: true,
  publicId: true,
  status: true,
  isDemo: true,
  city: true,
  state: true,
  regionId: true,
  legalEntityId: true,
  gstRegistrationId: true,
  region: { select: { id: true, name: true, code: true } },
  // legalName, not name: the entity's field is the string on the certificate of
  // incorporation. The recognisable brand is a different column on a different
  // model, and a report attributing takings to a legal entity has to name the
  // one that would appear on the invoice.
  legalEntity: { select: { id: true, legalName: true, tradeName: true } },
  gstRegistration: { select: { id: true, gstin: true } },
  brandLinks: { select: { brand: { select: { id: true, name: true, code: true } } } },
};

export const publicStore = (b) => ({
  id: b.id,
  publicId: b.publicId,
  name: b.name,
  code: b.code,
  status: b.status,
  isDemo: b.isDemo,
  city: b.city,
  state: b.state,
  regionId: b.regionId,
  regionName: b.region?.name ?? null,
  legalEntityId: b.legalEntityId,
  legalEntityName: b.legalEntity?.legalName ?? null,
  gstin: b.gstRegistration?.gstin ?? null,
  brands: (b.brandLinks ?? []).map((l) => ({ id: l.brand.id, name: l.brand.name, code: l.brand.code })),
});

/**
 * Resolve the stores a reporting request may read.
 *
 * `storeId` narrows to one store and must already be inside scope — a store in
 * another tenant and a store outside the caller's assignments both answer
 * "Store not found", identically, so probing ids maps nobody's estate.
 *
 * `regionId`, `brandId`, `legalEntityId` and `includeDemo` narrow further. They
 * are filters, never grants: an out-of-scope region simply yields no stores.
 */
export const resolveReportScope = async (req, query = {}) => {
  const companyId = req.companyScope.id;
  const scope = req.perm.scope;

  // The caller's own reach, and the filters they asked for, are kept as two
  // separate objects and combined with AND. They must never be merged into one
  // `where`: a filter names the same Prisma keys the scope does, so a spread
  // silently REPLACES the constraint instead of adding to it. That is not a
  // style point — it was a live authorisation hole. A manager pinned to one
  // store who passed ?storeId= for a sibling store had the scope's own `id`
  // clause overwritten by their own parameter and was served that store's
  // takings; a regional manager could do the same with ?regionId=. The tenant
  // check survived both, so it looked correct from outside the company and was
  // wrong inside it — which is the harder half to notice.
  const reach = { companyId };
  if (scope.kind === 'REGION') reach.regionId = scope.regionId;
  if (scope.kind === 'LIST') reach.id = { in: scope.branchIds.length ? scope.branchIds : ['__none__'] };

  const filters = {};
  if (query.regionId) filters.regionId = String(query.regionId);
  if (query.legalEntityId) filters.legalEntityId = String(query.legalEntityId);
  if (query.brandId) filters.brandLinks = { some: { brandId: String(query.brandId) } };
  // Demo stores exist to be practised on. Counting their takings as company
  // revenue is the quiet way a consolidated figure becomes wrong, so they are
  // out unless explicitly asked for.
  if (!query.includeDemo) filters.isDemo = false;

  if (query.storeId) {
    const inScope = await prisma.branch.findFirst({
      where: { AND: [reach, { id: String(query.storeId) }] },
      select: { id: true },
    });
    if (!inScope) throw notFound('Store not found');
    filters.id = inScope.id;
  }

  const stores = await prisma.branch.findMany({
    where: { AND: [reach, filters] },
    select: BRANCH_SELECT,
    orderBy: [{ name: 'asc' }],
  });

  return {
    companyId,
    kind: scope.kind,
    storeIds: stores.map((s) => s.id),
    stores: stores.map(publicStore),
    // True when the caller could see more but asked for less. Lets a payload say
    // "1 of 6 stores" instead of implying the company only has one.
    narrowed: Boolean(query.storeId || query.regionId || query.brandId || query.legalEntityId),
    filters: {
      storeId: query.storeId ?? null,
      regionId: query.regionId ?? null,
      brandId: query.brandId ?? null,
      legalEntityId: query.legalEntityId ?? null,
      includeDemo: Boolean(query.includeDemo),
    },
  };
};

// Every reporting query funnels through these two so an empty authorised set
// cannot degrade into "no filter" — the single most dangerous failure mode in a
// multi-tenant report. An empty list matches nothing rather than everything.
export const orderScopeWhere = (scope) => ({
  companyId: scope.companyId,
  branchId: { in: scope.storeIds.length ? scope.storeIds : ['__none__'] },
});

export const viaOrderScopeWhere = (scope) => ({
  order: orderScopeWhere(scope),
});

export const assertStoresResolved = (scope) => {
  if (!scope.storeIds.length) {
    throw badRequest('No store in your access matches these filters');
  }
};
