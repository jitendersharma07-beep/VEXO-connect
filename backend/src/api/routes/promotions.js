// VC-102 — promotion campaigns. Owner/admin surface: create, edit, target,
// publish. Applying a promotion to an order lives in routes/orders.js, next
// to the money it moves.
//
// Authority split (spec §2 "Owner/admin authorization"): promo.write edits,
// promo.publish makes a campaign live, promo.apply uses one at the till.
// Cashiers hold only promo.apply — there is no route here they can pass.
//
// Versioning: the first publish freezes nothing; instead every subsequent
// edit of a once-published promotion bumps `version`, and redemptions
// snapshot the version they were computed under. That is what lets a bill
// keep meaning what it meant after the campaign is edited.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
} from '../../middleware/permissions.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicPromotion = (p) => ({
  id: p.id,
  name: p.name,
  code: p.code,
  status: p.status,
  version: p.version,
  benefitType: p.benefitType,
  percent: p.percent === null ? null : Number(p.percent),
  flatPaise: p.flatPaise,
  minSpendPaise: p.minSpendPaise,
  maxBenefitPaise: p.maxBenefitPaise,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  weekdayMask: p.weekdayMask,
  startMinute: p.startMinute,
  endMinute: p.endMinute,
  channel: p.channel,
  stackable: p.stackable,
  precedence: p.precedence,
  totalLimit: p.totalLimit,
  redemptionCount: p.redemptionCount,
  perCustomerLimit: p.perCustomerLimit,
  publishedAt: p.publishedAt,
  stores: (p.storeLinks ?? []).map((s) => ({ branchId: s.branchId, branchName: s.branch?.name })),
  rules: (p.itemRules ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    categoryId: r.categoryId,
    productId: r.productId,
  })),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const include = {
  storeLinks: { include: { branch: { select: { name: true } } } },
  itemRules: true,
};

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{3,20}$/, 'Code must be 3-20 letters, digits or dashes')
      .nullish(),
    benefitType: z.enum(['FLAT', 'PERCENT']),
    percent: z.number().gt(0).max(100).nullish(),
    flatPaise: z.number().int().gt(0).max(99999999_00).nullish(),
    minSpendPaise: z.number().int().gt(0).nullish(),
    maxBenefitPaise: z.number().int().gt(0).nullish(),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    weekdayMask: z.number().int().min(1).max(127).nullish(),
    startMinute: z.number().int().min(0).max(1439).nullish(),
    endMinute: z.number().int().min(1).max(1440).nullish(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY']).nullish(),
    stackable: z.boolean().optional(),
    precedence: z.number().int().min(0).max(1000).optional(),
    totalLimit: z.number().int().gt(0).nullish(),
    perCustomerLimit: z.number().int().gt(0).nullish(),
  })
  .superRefine((b, ctx) => {
    if (b.benefitType === 'FLAT' && !b.flatPaise)
      ctx.addIssue({ code: 'custom', path: ['flatPaise'], message: 'FLAT benefit needs flatPaise' });
    if (b.benefitType === 'PERCENT' && !b.percent)
      ctx.addIssue({ code: 'custom', path: ['percent'], message: 'PERCENT benefit needs percent' });
    if (b.benefitType === 'FLAT' && b.percent)
      ctx.addIssue({ code: 'custom', path: ['percent'], message: 'FLAT benefit must not carry percent' });
    if (b.benefitType === 'PERCENT' && b.flatPaise)
      ctx.addIssue({ code: 'custom', path: ['flatPaise'], message: 'PERCENT benefit must not carry flatPaise' });
    if (b.startsAt && b.endsAt && b.startsAt >= b.endsAt)
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
    if (b.startMinute != null && b.endMinute != null && b.startMinute >= b.endMinute)
      ctx.addIssue({
        code: 'custom',
        path: ['endMinute'],
        message: 'Time window must not wrap midnight — create two promotions instead',
      });
    if ((b.startMinute == null) !== (b.endMinute == null))
      ctx.addIssue({ code: 'custom', path: ['startMinute'], message: 'Set both minutes or neither' });
  });

const toData = (b) => ({
  name: b.name,
  code: b.code ?? null,
  benefitType: b.benefitType,
  percent: b.benefitType === 'PERCENT' ? b.percent.toFixed(3) : null,
  flatPaise: b.benefitType === 'FLAT' ? b.flatPaise : null,
  minSpendPaise: b.minSpendPaise ?? null,
  maxBenefitPaise: b.maxBenefitPaise ?? null,
  startsAt: b.startsAt ?? null,
  endsAt: b.endsAt ?? null,
  weekdayMask: b.weekdayMask ?? null,
  startMinute: b.startMinute ?? null,
  endMinute: b.endMinute ?? null,
  channel: b.channel ?? null,
  stackable: b.stackable ?? false,
  precedence: b.precedence ?? 100,
  totalLimit: b.totalLimit ?? null,
  perCustomerLimit: b.perCustomerLimit ?? null,
});

const loadPromotion = async (req) => {
  const promo = await prisma.promotion.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
    include,
  });
  if (!promo) throw notFound('Promotion not found');
  return promo;
};

// Editing a promotion the public has seen changes what the campaign means, so
// the version moves; redemptions keep the version they were computed under.
const versionBump = (promo) => (promo.publishedAt ? { version: { increment: 1 } } : {});

router.get(
  '/',
  requireAction('promo.read'),
  asyncHandler(async (req, res) => {
    const promotions = await prisma.promotion.findMany({
      where: { companyId: req.companyScope.id },
      include,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ promotions: promotions.map(publicPromotion) });
  }),
);

router.post(
  '/',
  requireAction('promo.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = bodySchema.parse(req.body);
    if (body.code) {
      const dup = await prisma.promotion.findUnique({
        where: { companyId_code: { companyId: req.companyScope.id, code: body.code } },
        select: { id: true },
      });
      if (dup) throw conflict(`Code ${body.code} is already in use`);
    }
    const promo = await prisma.promotion.create({
      data: { ...toData(body), companyId: req.companyScope.id, createdById: req.user.id },
      include,
    });
    await audit(req, {
      action: 'PROMO_CREATE',
      entity: 'Promotion',
      entityId: promo.id,
      companyId: req.companyScope.id,
      meta: { name: promo.name, code: promo.code },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ promotion: publicPromotion(promo) });
  }),
);

router.patch(
  '/:id',
  requireAction('promo.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const existing = await loadPromotion(req);
    if (existing.status === 'ARCHIVED') throw conflict('An archived promotion cannot be edited');
    const body = bodySchema.parse(req.body);
    if (body.code && body.code !== existing.code) {
      const dup = await prisma.promotion.findUnique({
        where: { companyId_code: { companyId: req.companyScope.id, code: body.code } },
        select: { id: true },
      });
      if (dup) throw conflict(`Code ${body.code} is already in use`);
    }
    const promo = await prisma.promotion.update({
      where: { id: existing.id },
      data: { ...toData(body), ...versionBump(existing) },
      include,
    });
    await audit(req, {
      action: 'PROMO_UPDATE',
      entity: 'Promotion',
      entityId: promo.id,
      companyId: req.companyScope.id,
      meta: { name: promo.name, version: promo.version },
    });
    await auditPlatformWrite(req);
    res.json({ promotion: publicPromotion(promo) });
  }),
);

// Replace-in-full semantics, like the brand↔store links route.
router.put(
  '/:id/stores',
  requireAction('promo.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const existing = await loadPromotion(req);
    if (existing.status === 'ARCHIVED') throw conflict('An archived promotion cannot be edited');
    const { branchIds } = z.object({ branchIds: z.array(z.string().min(1)).max(500) }).parse(req.body);
    const unique = [...new Set(branchIds)];
    const found = await prisma.branch.count({
      where: { id: { in: unique }, companyId: req.companyScope.id },
    });
    if (found !== unique.length) throw badRequest('One or more stores do not exist');
    const promo = await prisma.$transaction(async (tx) => {
      await tx.promotionStore.deleteMany({ where: { promotionId: existing.id } });
      if (unique.length) {
        await tx.promotionStore.createMany({
          data: unique.map((branchId) => ({
            promotionId: existing.id,
            companyId: req.companyScope.id,
            branchId,
          })),
        });
      }
      return tx.promotion.update({ where: { id: existing.id }, data: versionBump(existing), include });
    });
    await audit(req, {
      action: 'PROMO_STORES_SET',
      entity: 'Promotion',
      entityId: existing.id,
      companyId: req.companyScope.id,
      meta: { branchIds: unique, version: promo.version },
    });
    await auditPlatformWrite(req);
    res.json({ promotion: publicPromotion(promo) });
  }),
);

const ruleSchema = z
  .object({
    kind: z.enum(['INCLUDE_CATEGORY', 'EXCLUDE_CATEGORY', 'INCLUDE_PRODUCT', 'EXCLUDE_PRODUCT']),
    categoryId: z.string().min(1).nullish(),
    productId: z.string().min(1).nullish(),
  })
  .superRefine((r, ctx) => {
    const wantsCategory = r.kind.endsWith('CATEGORY');
    if (wantsCategory && (!r.categoryId || r.productId))
      ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'Category rules carry categoryId only' });
    if (!wantsCategory && (!r.productId || r.categoryId))
      ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Product rules carry productId only' });
  });

router.put(
  '/:id/rules',
  requireAction('promo.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const existing = await loadPromotion(req);
    if (existing.status === 'ARCHIVED') throw conflict('An archived promotion cannot be edited');
    const { rules } = z.object({ rules: z.array(ruleSchema).max(200) }).parse(req.body);
    const categoryIds = [...new Set(rules.map((r) => r.categoryId).filter(Boolean))];
    const productIds = [...new Set(rules.map((r) => r.productId).filter(Boolean))];
    if (categoryIds.length) {
      const n = await prisma.category.count({
        where: { id: { in: categoryIds }, companyId: req.companyScope.id },
      });
      if (n !== categoryIds.length) throw badRequest('One or more categories do not exist');
    }
    if (productIds.length) {
      const n = await prisma.product.count({
        where: { id: { in: productIds }, companyId: req.companyScope.id },
      });
      if (n !== productIds.length) throw badRequest('One or more products do not exist');
    }
    const promo = await prisma.$transaction(async (tx) => {
      await tx.promotionItemRule.deleteMany({ where: { promotionId: existing.id } });
      if (rules.length) {
        await tx.promotionItemRule.createMany({
          data: rules.map((r) => ({
            promotionId: existing.id,
            companyId: req.companyScope.id,
            kind: r.kind,
            categoryId: r.categoryId ?? null,
            productId: r.productId ?? null,
          })),
        });
      }
      return tx.promotion.update({ where: { id: existing.id }, data: versionBump(existing), include });
    });
    await audit(req, {
      action: 'PROMO_RULES_SET',
      entity: 'Promotion',
      entityId: existing.id,
      companyId: req.companyScope.id,
      meta: { ruleCount: rules.length, version: promo.version },
    });
    await auditPlatformWrite(req);
    res.json({ promotion: publicPromotion(promo) });
  }),
);

const transition = (action, from, to, auditAction) =>
  router.post(
    `/:id/${action}`,
    requireAction('promo.publish'),
    requireUsableLicense,
    asyncHandler(async (req, res) => {
      const existing = await loadPromotion(req);
      if (!from.includes(existing.status)) {
        throw conflict(`A ${existing.status.toLowerCase()} promotion cannot be ${action}d`);
      }
      const promo = await prisma.promotion.update({
        where: { id: existing.id },
        data: { status: to, ...(to === 'PUBLISHED' && !existing.publishedAt ? { publishedAt: new Date() } : {}) },
        include,
      });
      await audit(req, {
        action: auditAction,
        entity: 'Promotion',
        entityId: promo.id,
        companyId: req.companyScope.id,
        meta: { name: promo.name, from: existing.status, version: promo.version },
      });
      await auditPlatformWrite(req);
      res.json({ promotion: publicPromotion(promo) });
    }),
  );

transition('publish', ['DRAFT', 'PAUSED'], 'PUBLISHED', 'PROMO_PUBLISH');
transition('pause', ['PUBLISHED'], 'PAUSED', 'PROMO_PAUSE');
transition('archive', ['DRAFT', 'PUBLISHED', 'PAUSED'], 'ARCHIVED', 'PROMO_ARCHIVE');

export default router;
