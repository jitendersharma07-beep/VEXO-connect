// Catalog — tax rates, categories, products, variants. Contract §5.1.
// Reads: every role in the company (+ ATC, company-scoped). Writes:
// CUSTOMER_OWNER and ATC only, licence required for customer principals.
// Deletes archive (orders snapshot but products still reference), except an
// empty category which is hard-deleted.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { num } from '../../lib/orders.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

const canWrite = [requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER'), requireUsableLicense];

const money2 = z
  .number()
  .min(0)
  .max(99999999)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Amounts allow at most 2 decimals');

// --- tax rates --------------------------------------------------------------

const publicTaxRate = (t) => ({
  id: t.id,
  name: t.name,
  ratePercent: num(t.ratePercent),
  status: t.status,
  createdAt: t.createdAt,
});

const taxRateCreate = z.object({
  name: z.string().trim().min(1).max(80),
  ratePercent: z
    .number()
    .min(0)
    .max(100)
    .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'Rates allow at most 3 decimals'),
});
const taxRateUpdate = taxRateCreate.partial().extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

const loadTaxRate = async (req) => {
  const row = await prisma.taxRate.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!row) throw notFound('Tax rate not found');
  return row;
};

router.get(
  '/tax-rates',
  asyncHandler(async (req, res) => {
    const taxRates = await prisma.taxRate.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ taxRates: taxRates.map(publicTaxRate) });
  }),
);

router.post(
  '/tax-rates',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const data = taxRateCreate.parse(req.body);
    const taxRate = await prisma.taxRate.create({
      data: {
        companyId: req.companyScope.id,
        name: data.name,
        ratePercent: data.ratePercent.toFixed(3),
      },
    });
    await audit(req, {
      action: 'TAX_RATE_CREATE',
      entity: 'TaxRate',
      entityId: taxRate.id,
      companyId: req.companyScope.id,
      meta: { name: taxRate.name, ratePercent: num(taxRate.ratePercent) },
    });
    res.status(201).json({ taxRate: publicTaxRate(taxRate) });
  }),
);

router.patch(
  '/tax-rates/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const row = await loadTaxRate(req);
    const data = taxRateUpdate.parse(req.body);
    const taxRate = await prisma.taxRate.update({
      where: { id: row.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.ratePercent !== undefined ? { ratePercent: data.ratePercent.toFixed(3) } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
    await audit(req, {
      action: 'TAX_RATE_UPDATE',
      entity: 'TaxRate',
      entityId: taxRate.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ taxRate: publicTaxRate(taxRate) });
  }),
);

router.delete(
  '/tax-rates/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const row = await loadTaxRate(req);
    const taxRate = await prisma.taxRate.update({
      where: { id: row.id },
      data: { status: 'ARCHIVED' },
    });
    await audit(req, {
      action: 'TAX_RATE_ARCHIVE',
      entity: 'TaxRate',
      entityId: row.id,
      companyId: req.companyScope.id,
    });
    res.json({ taxRate: publicTaxRate(taxRate) });
  }),
);

// --- categories -------------------------------------------------------------

const publicCategory = (c) => ({
  id: c.id,
  name: c.name,
  sortOrder: c.sortOrder,
  createdAt: c.createdAt,
});

const categoryCreate = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const loadCategory = async (req) => {
  const row = await prisma.category.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!row) throw notFound('Category not found');
  return row;
};

router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const categories = await prisma.category.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ categories: categories.map(publicCategory) });
  }),
);

router.post(
  '/categories',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const data = categoryCreate.parse(req.body);
    const exists = await prisma.category.findUnique({
      where: { companyId_name: { companyId: req.companyScope.id, name: data.name } },
    });
    if (exists) throw conflict(`Category "${data.name}" already exists`);
    const category = await prisma.category.create({
      data: { companyId: req.companyScope.id, name: data.name, sortOrder: data.sortOrder ?? 0 },
    });
    await audit(req, {
      action: 'CATEGORY_CREATE',
      entity: 'Category',
      entityId: category.id,
      companyId: req.companyScope.id,
      meta: { name: category.name },
    });
    res.status(201).json({ category: publicCategory(category) });
  }),
);

router.patch(
  '/categories/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const row = await loadCategory(req);
    const data = categoryCreate.partial().parse(req.body);
    if (data.name && data.name !== row.name) {
      const exists = await prisma.category.findUnique({
        where: { companyId_name: { companyId: req.companyScope.id, name: data.name } },
      });
      if (exists) throw conflict(`Category "${data.name}" already exists`);
    }
    const category = await prisma.category.update({ where: { id: row.id }, data });
    await audit(req, {
      action: 'CATEGORY_UPDATE',
      entity: 'Category',
      entityId: category.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ category: publicCategory(category) });
  }),
);

router.delete(
  '/categories/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const row = await loadCategory(req);
    const products = await prisma.product.count({ where: { categoryId: row.id } });
    if (products > 0) {
      throw conflict('Category still has products; move or archive them first');
    }
    await prisma.category.delete({ where: { id: row.id } });
    await audit(req, {
      action: 'CATEGORY_DELETE',
      entity: 'Category',
      entityId: row.id,
      companyId: req.companyScope.id,
      meta: { name: row.name },
    });
    res.json({ ok: true });
  }),
);

// --- products + variants ----------------------------------------------------

const publicVariant = (v) => ({
  id: v.id,
  name: v.name,
  price: num(v.price),
  status: v.status,
});

const publicProduct = (p) => ({
  id: p.id,
  categoryId: p.categoryId,
  name: p.name,
  sku: p.sku,
  basePrice: num(p.basePrice),
  taxRate: p.taxRate
    ? { id: p.taxRate.id, name: p.taxRate.name, ratePercent: num(p.taxRate.ratePercent) }
    : null,
  status: p.status,
  variants: (p.variants ?? []).map(publicVariant),
  modifierGroups: (p.modifierGroups ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    status: g.status,
    options: (g.options ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      price: num(m.price),
      status: m.status,
    })),
  })),
});

const PRODUCT_INCLUDE = {
  taxRate: { select: { id: true, name: true, ratePercent: true } },
  variants: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  modifierGroups: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { options: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  },
};

const productCreate = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().min(1).max(40).optional(),
  basePrice: money2,
  taxRateId: z.string().min(1).optional(),
});
const productUpdate = z.object({
  categoryId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  sku: z.string().trim().min(1).max(40).nullish(),
  basePrice: money2.optional(),
  taxRateId: z.string().min(1).nullish(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

const assertCategory = async (companyId, categoryId) => {
  const category = await prisma.category.findFirst({ where: { id: categoryId, companyId } });
  if (!category) throw badRequest('Unknown category', 'categoryId');
};
const assertTaxRate = async (companyId, taxRateId) => {
  const taxRate = await prisma.taxRate.findFirst({ where: { id: taxRateId, companyId } });
  if (!taxRate) throw badRequest('Unknown tax rate', 'taxRateId');
};
const assertSkuFree = async (companyId, sku, exceptId = null) => {
  const clash = await prisma.product.findFirst({
    where: { companyId, sku, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict(`SKU ${sku} is already used`);
};

const loadProduct = async (req, id = req.params.id) => {
  const row = await prisma.product.findFirst({
    where: { id, companyId: req.companyScope.id },
    include: PRODUCT_INCLUDE,
  });
  if (!row) throw notFound('Product not found');
  return row;
};

router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        categoryId: z.string().optional(),
        q: z.string().trim().max(80).optional(),
        status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
      })
      .parse(req.query);
    const products = await prisma.product.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(query.status !== 'ALL' ? { status: query.status } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      },
      include: PRODUCT_INCLUDE,
      orderBy: [{ name: 'asc' }],
    });
    res.json({ products: products.map(publicProduct) });
  }),
);

router.get(
  '/products/:id',
  asyncHandler(async (req, res) => {
    res.json({ product: publicProduct(await loadProduct(req)) });
  }),
);

router.post(
  '/products',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const data = productCreate.parse(req.body);
    await assertCategory(req.companyScope.id, data.categoryId);
    if (data.taxRateId) await assertTaxRate(req.companyScope.id, data.taxRateId);
    if (data.sku) await assertSkuFree(req.companyScope.id, data.sku);
    const product = await prisma.product.create({
      data: {
        companyId: req.companyScope.id,
        categoryId: data.categoryId,
        name: data.name,
        sku: data.sku ?? null,
        basePrice: data.basePrice.toFixed(2),
        taxRateId: data.taxRateId ?? null,
      },
      include: PRODUCT_INCLUDE,
    });
    await audit(req, {
      action: 'PRODUCT_CREATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { name: product.name, sku: product.sku },
    });
    res.status(201).json({ product: publicProduct(product) });
  }),
);

router.patch(
  '/products/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const row = await loadProduct(req);
    const data = productUpdate.parse(req.body);
    if (data.categoryId) await assertCategory(req.companyScope.id, data.categoryId);
    if (data.taxRateId) await assertTaxRate(req.companyScope.id, data.taxRateId);
    if (data.sku) await assertSkuFree(req.companyScope.id, data.sku, row.id);
    const product = await prisma.product.update({
      where: { id: row.id },
      data: {
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.sku !== undefined ? { sku: data.sku } : {}),
        ...(data.basePrice !== undefined ? { basePrice: data.basePrice.toFixed(2) } : {}),
        ...(data.taxRateId !== undefined ? { taxRateId: data.taxRateId } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
      include: PRODUCT_INCLUDE,
    });
    await audit(req, {
      action: 'PRODUCT_UPDATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ product: publicProduct(product) });
  }),
);

router.delete(
  '/products/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const row = await loadProduct(req);
    const product = await prisma.product.update({
      where: { id: row.id },
      data: { status: 'ARCHIVED' },
      include: PRODUCT_INCLUDE,
    });
    await audit(req, {
      action: 'PRODUCT_ARCHIVE',
      entity: 'Product',
      entityId: row.id,
      companyId: req.companyScope.id,
      meta: { name: row.name },
    });
    res.json({ product: publicProduct(product) });
  }),
);

const variantCreate = z.object({
  name: z.string().trim().min(1).max(60),
  price: money2,
});
const variantUpdate = variantCreate.partial().extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

router.post(
  '/products/:id/variants',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const product = await loadProduct(req);
    const data = variantCreate.parse(req.body);
    const clash = await prisma.productVariant.findFirst({
      where: { productId: product.id, name: data.name },
    });
    if (clash) throw conflict(`Variant "${data.name}" already exists on this product`);
    await prisma.productVariant.create({
      data: { productId: product.id, name: data.name, price: data.price.toFixed(2) },
    });
    await audit(req, {
      action: 'VARIANT_CREATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { variant: data.name, price: data.price },
    });
    res.status(201).json({ product: publicProduct(await loadProduct(req)) });
  }),
);

const loadVariant = async (req) => {
  const product = await loadProduct(req);
  const variant = product.variants.find((v) => v.id === req.params.variantId);
  if (!variant) throw notFound('Variant not found');
  return { product, variant };
};

router.patch(
  '/products/:id/variants/:variantId',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const { product, variant } = await loadVariant(req);
    const data = variantUpdate.parse(req.body);
    if (data.name && data.name !== variant.name) {
      const clash = await prisma.productVariant.findFirst({
        where: { productId: product.id, name: data.name },
      });
      if (clash) throw conflict(`Variant "${data.name}" already exists on this product`);
    }
    await prisma.productVariant.update({
      where: { id: variant.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.price !== undefined ? { price: data.price.toFixed(2) } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
    await audit(req, {
      action: 'VARIANT_UPDATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { variantId: variant.id, ...data },
    });
    res.json({ product: publicProduct(await loadProduct(req)) });
  }),
);

router.delete(
  '/products/:id/variants/:variantId',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const { product, variant } = await loadVariant(req);
    await prisma.productVariant.update({ where: { id: variant.id }, data: { status: 'ARCHIVED' } });
    await audit(req, {
      action: 'VARIANT_ARCHIVE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { variantId: variant.id, name: variant.name },
    });
    res.json({ product: publicProduct(await loadProduct(req)) });
  }),
);

// --- modifier groups + options -----------------------------------------------

const groupCreate = z
  .object({
    name: z.string().trim().min(1).max(60),
    minSelect: z.number().int().min(0).default(0),
    maxSelect: z.number().int().min(1).nullish(),
  })
  .refine((g) => g.maxSelect == null || g.maxSelect >= g.minSelect, {
    message: 'maxSelect must be at least minSelect',
    path: ['maxSelect'],
  });
const groupUpdate = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    minSelect: z.number().int().min(0).optional(),
    maxSelect: z.number().int().min(1).nullish(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  });

router.post(
  '/products/:id/modifier-groups',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const product = await loadProduct(req);
    const data = groupCreate.parse(req.body);
    const clash = await prisma.modifierGroup.findFirst({
      where: { productId: product.id, name: data.name },
    });
    if (clash) throw conflict(`Modifier group "${data.name}" already exists on this product`);
    const group = await prisma.modifierGroup.create({
      data: {
        productId: product.id,
        name: data.name,
        minSelect: data.minSelect,
        maxSelect: data.maxSelect ?? null,
      },
    });
    await audit(req, {
      action: 'MODIFIER_GROUP_CREATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { groupId: group.id, name: group.name },
    });
    res.status(201).json({ product: publicProduct(await loadProduct(req)) });
  }),
);

const loadGroup = async (req) => {
  const product = await loadProduct(req);
  const group = product.modifierGroups.find((g) => g.id === req.params.groupId);
  if (!group) throw notFound('Modifier group not found');
  return { product, group };
};

router.patch(
  '/products/:id/modifier-groups/:groupId',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const { product, group } = await loadGroup(req);
    const data = groupUpdate.parse(req.body);
    const min = data.minSelect ?? group.minSelect;
    const max = data.maxSelect !== undefined ? data.maxSelect : group.maxSelect;
    if (max != null && max < min) throw badRequest('maxSelect must be at least minSelect', 'maxSelect');
    if (data.name && data.name !== group.name) {
      const clash = await prisma.modifierGroup.findFirst({
        where: { productId: product.id, name: data.name },
      });
      if (clash) throw conflict(`Modifier group "${data.name}" already exists on this product`);
    }
    await prisma.modifierGroup.update({
      where: { id: group.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.minSelect !== undefined ? { minSelect: data.minSelect } : {}),
        ...(data.maxSelect !== undefined ? { maxSelect: data.maxSelect } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
    await audit(req, {
      action: 'MODIFIER_GROUP_UPDATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { groupId: group.id, ...data },
    });
    res.json({ product: publicProduct(await loadProduct(req)) });
  }),
);

const optionCreate = z.object({
  name: z.string().trim().min(1).max(60),
  price: money2,
});
const optionUpdate = optionCreate.partial().extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

router.post(
  '/products/:id/modifier-groups/:groupId/options',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const { product, group } = await loadGroup(req);
    const data = optionCreate.parse(req.body);
    const clash = await prisma.modifierOption.findFirst({
      where: { groupId: group.id, name: data.name },
    });
    if (clash) throw conflict(`Option "${data.name}" already exists in this group`);
    await prisma.modifierOption.create({
      data: { groupId: group.id, name: data.name, price: data.price.toFixed(2) },
    });
    await audit(req, {
      action: 'MODIFIER_OPTION_CREATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { groupId: group.id, option: data.name, price: data.price },
    });
    res.status(201).json({ product: publicProduct(await loadProduct(req)) });
  }),
);

router.patch(
  '/products/:id/modifier-groups/:groupId/options/:optionId',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const { product, group } = await loadGroup(req);
    const option = group.options.find((m) => m.id === req.params.optionId);
    if (!option) throw notFound('Modifier option not found');
    const data = optionUpdate.parse(req.body);
    if (data.name && data.name !== option.name) {
      const clash = await prisma.modifierOption.findFirst({
        where: { groupId: group.id, name: data.name },
      });
      if (clash) throw conflict(`Option "${data.name}" already exists in this group`);
    }
    await prisma.modifierOption.update({
      where: { id: option.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.price !== undefined ? { price: data.price.toFixed(2) } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
    await audit(req, {
      action: 'MODIFIER_OPTION_UPDATE',
      entity: 'Product',
      entityId: product.id,
      companyId: req.companyScope.id,
      meta: { groupId: group.id, optionId: option.id, ...data },
    });
    res.json({ product: publicProduct(await loadProduct(req)) });
  }),
);

export default router;
