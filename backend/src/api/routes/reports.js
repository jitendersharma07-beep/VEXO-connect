// Sales report — contract §10. BRANCH_MANAGER sees their own branch,
// CUSTOMER_OWNER the whole company (or one branch), ATC read with company
// scope; CASHIER is refused. Sales figures cover PAID+REFUNDED orders billed
// in the window (IST days); collected/refunds follow payment/refund
// timestamps. Aggregation runs in integer paise.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope, isBranchPinned } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { toRupees } from '../../lib/money.js';
import { paiseOf, istDayStartUtc, istDateOf } from '../../lib/orders.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

router.get(
  '/sales',
  requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        branchId: z.string().optional(),
      })
      .parse(req.query);
    const fromUtc = istDayStartUtc(query.from);
    const toExcl = new Date(istDayStartUtc(query.to).getTime() + 86400e3);
    if (!(fromUtc < toExcl)) throw badRequest('from must be on or before to', 'from');

    let branchId = null;
    if (isBranchPinned(req.user)) {
      branchId = req.user.branchId;
    } else if (query.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: query.branchId, companyId: req.companyScope.id },
      });
      if (!branch) throw notFound('Branch not found');
      branchId = branch.id;
    }
    const companyId = req.companyScope.id;
    const branchWhere = branchId ? { branchId } : {};
    const window = { gte: fromUtc, lt: toExcl };

    const [salesOrders, statusCounts, payments, refunds] = await Promise.all([
      prisma.order.findMany({
        where: { companyId, ...branchWhere, status: { in: ['PAID', 'REFUNDED'] }, billedAt: window },
        include: {
          items: {
            where: { status: 'ACTIVE' },
            include: {
              product: { select: { categoryId: true, category: { select: { name: true } } } },
            },
          },
        },
      }),
      prisma.order.groupBy({
        by: ['status'],
        where: { companyId, ...branchWhere, createdAt: window },
        _count: { _all: true },
      }),
      prisma.payment.findMany({
        where: { createdAt: window, order: { companyId, ...branchWhere } },
        select: { amount: true, method: true, channel: true, createdAt: true },
      }),
      prisma.refund.findMany({
        where: { createdAt: window, order: { companyId, ...branchWhere } },
        select: { amount: true, createdAt: true },
      }),
    ]);

    let grossItems = 0;
    let discounts = 0;
    let tax = 0;
    let netSales = 0;
    const byCategory = new Map();
    const byDay = new Map();
    const dayRow = (date) => {
      let row = byDay.get(date);
      if (!row) {
        row = { date, orders: 0, netSales: 0, collected: 0 };
        byDay.set(date, row);
      }
      return row;
    };

    for (const o of salesOrders) {
      for (const i of o.items) {
        grossItems += paiseOf(i.unitPrice) * i.qty;
        discounts += paiseOf(i.lineDiscount);
        const cat = byCategory.get(i.product.categoryId) || {
          categoryId: i.product.categoryId,
          name: i.product.category.name,
          qty: 0,
          amount: 0,
        };
        cat.qty += i.qty;
        cat.amount += paiseOf(i.lineSubtotal);
        byCategory.set(i.product.categoryId, cat);
      }
      discounts += paiseOf(o.discountAmount);
      tax += paiseOf(o.taxAmount);
      netSales += paiseOf(o.total);
      const day = dayRow(istDateOf(o.billedAt));
      day.orders += 1;
      day.netSales += paiseOf(o.total);
    }

    let collected = 0;
    let refundsTotal = 0;
    const byMethod = new Map();
    for (const p of payments) {
      const amount = paiseOf(p.amount);
      collected += amount;
      const m = byMethod.get(p.method) || { method: p.method, channel: p.channel, amount: 0, count: 0 };
      m.amount += amount;
      m.count += 1;
      byMethod.set(p.method, m);
      dayRow(istDateOf(p.createdAt)).collected += amount;
    }
    for (const r of refunds) refundsTotal += paiseOf(r.amount);

    const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    res.json({
      report: {
        from: query.from,
        to: query.to,
        branchId,
        currency: 'INR',
        sales: {
          grossItems: toRupees(grossItems),
          discounts: toRupees(discounts),
          tax: toRupees(tax),
          netSales: toRupees(netSales),
          refunds: toRupees(refundsTotal),
          collected: toRupees(collected),
        },
        orders: {
          total: statusCounts.reduce((a, s) => a + s._count._all, 0),
          open: counts.OPEN ?? 0,
          billed: counts.BILLED ?? 0,
          paid: counts.PAID ?? 0,
          refunded: counts.REFUNDED ?? 0,
          voided: counts.VOID ?? 0,
        },
        byMethod: [...byMethod.values()]
          .sort((a, b) => b.amount - a.amount)
          .map((m) => ({ ...m, amount: toRupees(m.amount) })),
        byCategory: [...byCategory.values()]
          .sort((a, b) => b.amount - a.amount)
          .map((c) => ({ ...c, amount: toRupees(c.amount) })),
        byDay: [...byDay.values()]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((d) => ({ ...d, netSales: toRupees(d.netSales), collected: toRupees(d.collected) })),
        note: 'All payments are manual records; gateway payments arrive in a later phase.',
      },
    });
  }),
);

export default router;
