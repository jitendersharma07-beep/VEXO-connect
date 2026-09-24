// VC-105 Menu Profitability — docs/VC105-API-CONTRACT.md.
//
// Reports contribution margin (net sales after refunds − ingredient COGS) by
// item, store, channel or period. It is NOT net business profit: labour, rent,
// utilities, packaging, wastage and delivery commission are all outside it,
// and the payload says so in meta.marginLabel.
//
// Order selection matches /reports/sales exactly — PAID+REFUNDED, windowed on
// billedAt in IST days, ACTIVE items, SUCCEEDED refunds — so the two reports
// cannot drift. Every response carries the reconciliation that proves it.
//
// Costing is BLOCKED at this base: nothing in the repository computes a cost.
// Uncosted lines report MISSING and null, never zero. See contract §3.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope, isBranchPinned } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { paiseOf, istDayStartUtc, istDateOf } from '../../lib/orders.js';
import { buildProfitability, reconcile } from '../../lib/vc105/profitability.js';
import { resolveCostProvider } from '../../lib/vc105/costProvider.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

export const CONTRACT_VERSION = '1.1.1';
export const BASE_SHA = '489b66a3b89febaf72361705eea08eef8331bb17';
export const MARGIN_LABEL =
  'Contribution margin (net sales after refunds − ingredient COGS). Not net business profit.';

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.string().optional(),
  channel: z.enum(['DINE_IN', 'TAKEAWAY']).optional(),
  groupBy: z.enum(['item', 'store', 'channel', 'period']).optional(),
});

router.get(
  '/',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const fromUtc = istDayStartUtc(query.from);
    const toExcl = new Date(istDayStartUtc(query.to).getTime() + 86400e3);
    if (!(fromUtc < toExcl)) throw badRequest('from must be on or before to', 'from');

    // Store scope is resolved server-side. A pinned role is forced to its own
    // store rather than refused, and another tenant's store is a 404 —
    // indistinguishable from one that does not exist.
    let branchId = null;
    if (isBranchPinned(req.user)) {
      branchId = req.user.branchId;
    } else if (query.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: query.branchId, companyId: req.companyScope.id },
        select: { id: true },
      });
      if (!branch) throw notFound('Branch not found');
      branchId = branch.id;
    }

    const companyId = req.companyScope.id;
    const groupBy = query.groupBy ?? 'item';

    const orderRows = await prisma.order.findMany({
      where: {
        companyId,
        ...(branchId ? { branchId } : {}),
        ...(query.channel ? { type: query.channel } : {}),
        status: { in: ['PAID', 'REFUNDED'] },
        billedAt: { gte: fromUtc, lt: toExcl },
      },
      include: {
        branch: { select: { name: true } },
        items: {
          where: { status: 'ACTIVE' },
          include: { product: { select: { sku: true } } },
        },
        refunds: { where: { status: 'SUCCEEDED' }, select: { amount: true } },
      },
    });

    // Everything crosses into integer paise here, once, at the edge.
    const orders = orderRows.map((o) => ({
      id: o.id,
      branchId: o.branchId,
      branchName: o.branch?.name ?? o.branchId,
      type: o.type,
      businessDate: o.billedAt ? istDateOf(o.billedAt) : istDateOf(o.createdAt),
      subtotal: paiseOf(o.subtotal),
      discountAmount: paiseOf(o.discountAmount),
      taxAmount: paiseOf(o.taxAmount),
      total: paiseOf(o.total),
      refunds: o.refunds.map((r) => ({ amount: paiseOf(r.amount) })),
      items: o.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        sku: i.product?.sku ?? null,
        name: i.name,
        qty: i.qty,
        unitPrice: paiseOf(i.unitPrice),
        lineDiscount: paiseOf(i.lineDiscount),
        lineSubtotal: paiseOf(i.lineSubtotal),
        discountShare: paiseOf(i.discountShare),
        // OrderItemModifier is not in this base, so no line carries modifiers
        // yet. The engine and the provider both handle them; the data does not
        // exist to feed them. Contract §1.
        modifierIds: [],
      })),
    }));

    const provider = resolveCostProvider({ prisma });
    const lines = orders.flatMap((o) => o.items.map((i) => ({
      id: i.id, productId: i.productId, sku: i.sku, qty: i.qty, modifierIds: i.modifierIds,
    })));
    const costs = await provider.lookup(lines);

    const asOf = new Date();
    const result = buildProfitability(orders, costs, {
      groupBy,
      asOf,
      staleCostDays: provider.staleCostDays,
    });

    res.json({
      meta: {
        contractVersion: CONTRACT_VERSION,
        baseSha: BASE_SHA,
        generatedAt: asOf.toISOString(),
        period: { from: query.from, to: query.to, timezone: 'Asia/Kolkata' },
        scope: { companyId, branchId, channel: query.channel ?? null, groupBy },
        costing: {
          dependency: provider.dependency,
          source: provider.source,
          method: provider.method,
          methodStatus: provider.methodStatus,
          staleCostDays: provider.staleCostDays,
          refundPolicy: provider.refundPolicy,
          historicalReproducibility: provider.historicalReproducibility,
          missingCapabilities: provider.missingCapabilities,
          ...(provider.warning ? { warning: provider.warning } : {}),
        },
        marginLabel: MARGIN_LABEL,
      },
      coverage: result.coverage,
      totals: result.totals,
      segments: result.segments,
      rows: result.rows,
      reconciliation: reconcile(orders, result.totals),
    });
  }),
);

export default router;
