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

// D-5 (docs/VC104-BACKEND-DEFECTS.md). The till path enforces minSelect over
// ACTIVE groups while counting only ACTIVE options
// (orders.js `resolveCatalogLine`), so an ACTIVE group that requires more
// choices than it has available cannot be satisfied by any caller and the
// product stops selling EVERYWHERE — till, phone, all of it. Nothing here used
// to check that, and four ordinary edits reached the state with a 200.
//
// The invariant is one sentence: **an ACTIVE group must have at least
// `minSelect` ACTIVE options.** It is checked against the RESULT of the write,
// not against the payload, because three of the four paths send a body that is
// perfectly valid on its own and only goes wrong in combination with what is
// already stored — which is exactly why a zod `.refine` cannot express it.
//
// 409 and not 400 on purpose: nothing about the input is malformed. The request
// conflicts with the state of the group, which is what 409 is for. Every
// message names the way out, because the remedy is not guessable — archiving
// the GROUP is fine and archiving its last OPTION is not, and nothing in the
// API said so.
//
// Deliberately NOT lenient about pre-existing breakage: a group that is already
// unsatisfiable refuses unrelated edits too (a rename, say). That is the point.
// All three repairs stay open — archive the group, lower minSelect, or restore
// an option — because each of them ends in a state that satisfies the rule.
const assertSatisfiable = ({ name, minSelect, status, activeOptions }, remedy) => {
  if (status !== 'ACTIVE' || minSelect <= activeOptions) return;
  const need = `${minSelect} choice${minSelect === 1 ? '' : 's'}`;
  const have = activeOptions === 1 ? '1 is' : `${activeOptions} are`;
  throw conflict(
    `"${name}" would require ${need} but only ${have} available, so the product could not be sold. ${remedy}`,
  );
};

const countActive = (group) => group.options.filter((m) => m.status === 'ACTIVE').length;

// D-7. The guard above reads the group, decides, and then writes — three
// statements with no transaction around them, which is correct for one caller
// and not for two. Measured 2026-09-24 against an isolated database, not
// inferred: two concurrent archives of the last two options of a minSelect-1
// group each read "2 active", each computed 2-1=1, each passed, and both wrote.
// Result 200/200 and ZERO active options on an ACTIVE required group — the
// exact unsellable product D-5 exists to prevent, reached THROUGH its guard.
// The cross-route pair races the same way: raising minSelect to 2 while the
// last spare option is archived leaves minSelect 2 with 1 option.
//
// The lock is on the ModifierGroup row and BOTH routes take the same one, which
// is what makes the cross-route case serialize too. It is held to commit, so
// the counts read after it cannot be overtaken.
//
// Chosen over an optimistic version column because that needs a migration and a
// retry protocol at every caller, for a contention rate that is — on catalogue
// editing — effectively zero. This is a correctness floor, not a hot path.
const lockGroup = (tx, groupId) =>
  tx.$queryRaw`SELECT id FROM "ModifierGroup" WHERE id = ${groupId} FOR UPDATE`;

// Deliberately NOT countActive(group): that counts the copy loadGroup read
// before the lock existed, which is precisely the stale number the race turned
// on. This one is read inside the transaction, after the lock.
const activeOptionsIn = (tx, groupId) =>
  tx.modifierOption.count({ where: { groupId, status: 'ACTIVE' } });

router.post(
  '/products/:id/modifier-groups',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const product = await loadProduct(req);
    const data = groupCreate.parse(req.body);
    // A group is born with no options, so any minimum above zero is instantly
    // unsatisfiable. Checked before the clash query because it needs no
    // database read at all. This does make a required group a three-step job —
    // create it open, add the options, then set the minimum — and the message
    // says so, because otherwise this reads as "required groups are banned".
    assertSatisfiable(
      { ...data, status: 'ACTIVE', activeOptions: 0 },
      'Create the group with no minimum, add its options, then raise the minimum.',
    );
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
    // Scope and existence FIRST, and outside the transaction: a caller from
    // another company must get 404 without ever reaching the guard, because the
    // guard's message names the group. Taking a lock before that would also let
    // a stranger stall an owner's edit.
    const { product, group } = await loadGroup(req);
    const data = groupUpdate.parse(req.body);

    // D-5, two ways in through this one route: raising minSelect past the
    // options that exist, and re-activating a group whose options were all
    // archived while it was away. `max < min` below was the only cross-field
    // check here, and it is skipped whenever maxSelect is null — the default.
    //
    // D-7: decide and write under the group's row lock, against numbers read
    // after taking it. `group` above is a pre-lock snapshot and is used only for
    // the 404 and for the audit id; every value the decision turns on is
    // re-read inside.
    await prisma.$transaction(async (tx) => {
      await lockGroup(tx, group.id);
      const fresh = await tx.modifierGroup.findUnique({ where: { id: group.id } });
      if (!fresh) throw notFound('Modifier group not found');
      const min = data.minSelect ?? fresh.minSelect;
      const max = data.maxSelect !== undefined ? data.maxSelect : fresh.maxSelect;
      if (max != null && max < min) throw badRequest('maxSelect must be at least minSelect', 'maxSelect');
      assertSatisfiable(
        {
          name: data.name ?? fresh.name,
          minSelect: min,
          status: data.status ?? fresh.status,
          activeOptions: await activeOptionsIn(tx, group.id),
        },
        'Add or restore options first, or lower the minimum, or archive the whole group.',
      );
      if (data.name && data.name !== fresh.name) {
        const clash = await tx.modifierGroup.findFirst({
          where: { productId: product.id, name: data.name },
        });
        if (clash) throw conflict(`Modifier group "${data.name}" already exists on this product`);
      }
      await tx.modifierGroup.update({
        where: { id: group.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.minSelect !== undefined ? { minSelect: data.minSelect } : {}),
          ...(data.maxSelect !== undefined ? { maxSelect: data.maxSelect } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
      });
    });
    // Audited after commit on purpose: a rolled-back edit must leave no audit
    // row claiming it happened.
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
    // Scope and existence first, outside the transaction — see the group route.
    const { product, group } = await loadGroup(req);
    const option = group.options.find((m) => m.id === req.params.optionId);
    if (!option) throw notFound('Modifier option not found');
    const data = optionUpdate.parse(req.body);
    // D-5's commonest way in: retiring the last choice a required group has.
    // Counted both directions, because restoring an archived option is the
    // repair and must never be refused by the rule it repairs.
    //
    // D-7: the same lock as the group route, on the GROUP row rather than the
    // option — two archives of two DIFFERENT options are the race, so a
    // per-option lock would not have serialized them.
    await prisma.$transaction(async (tx) => {
      await lockGroup(tx, group.id);
      const fresh = await tx.modifierGroup.findUnique({ where: { id: group.id } });
      const freshOption = await tx.modifierOption.findUnique({ where: { id: option.id } });
      if (!fresh) throw notFound('Modifier group not found');
      if (!freshOption) throw notFound('Modifier option not found');
      const wasActive = freshOption.status === 'ACTIVE';
      const willBeActive = data.status !== undefined ? data.status === 'ACTIVE' : wasActive;
      assertSatisfiable(
        {
          name: fresh.name,
          minSelect: fresh.minSelect,
          status: fresh.status,
          activeOptions:
            (await activeOptionsIn(tx, group.id)) - (wasActive ? 1 : 0) + (willBeActive ? 1 : 0),
        },
        'Archive the whole group instead, or lower its minimum first.',
      );
      if (data.name && data.name !== freshOption.name) {
        const clash = await tx.modifierOption.findFirst({
          where: { groupId: group.id, name: data.name },
        });
        if (clash) throw conflict(`Option "${data.name}" already exists in this group`);
      }
      await tx.modifierOption.update({
        where: { id: option.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.price !== undefined ? { price: data.price.toFixed(2) } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
      });
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
