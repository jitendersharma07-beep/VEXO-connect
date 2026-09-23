// Where a company's discount authority is actually decided.
//
// This is the screen behind every refusal in discountGuard.js. The product
// ships no opinion about how much a cashier may take off a bill — it ships
// this, and the customer's owner types the numbers. Three levels, most
// specific wins per field: the company default, an override for a branch,
// and an override for one member of staff.
//
// Owner-only, deliberately. A branch manager who could widen their own
// ceiling would not have a ceiling, and ATC operators are not given a way to
// raise a customer's discount limits from outside the tenant — that is the
// customer's money, and the person who answers for it is the owner.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import {
  ROLE_FLOOR,
  describeCeiling,
  mergeDiscountPolicyRows,
  scopeKeyFor,
} from '../../lib/discountPolicy.js';

const router = Router();

// The role gate goes BEFORE the company scope on purpose. resolveCompanyScope
// asks a VEXO operator which company they mean; asking that question here
// would imply there is an answer that gets them in. There isn't, so refuse
// first and let the refusal be the whole reply.
router.use(requirePosAuth, requireRole('CUSTOMER_OWNER'), resolveCompanyScope);

// Decimal columns come back as Prisma Decimal; the wire carries plain
// numbers, and null keeps its meaning — "inherit", not "zero".
const num = (d) => (d === null || d === undefined ? null : Number(d));

const publicPolicy = (p) => ({
  id: p.id,
  level: p.level,
  branchId: p.branchId,
  branchName: p.branch?.name ?? null,
  userId: p.userId,
  userName: p.user?.fullName ?? null,
  userEmail: p.user?.email ?? null,
  userRole: p.user?.role ?? null,
  allowLineDiscount: p.allowLineDiscount,
  allowOrderDiscount: p.allowOrderDiscount,
  maxPercent: num(p.maxPercent),
  maxFlatPaise: p.maxFlatPaise,
  canApprove: p.canApprove,
  maxApprovalPercent: num(p.maxApprovalPercent),
  maxApprovalFlatPaise: p.maxApprovalFlatPaise,
  note: p.note,
  updatedAt: p.updatedAt,
});

const withSubjects = {
  branch: { select: { id: true, name: true, code: true } },
  user: { select: { id: true, fullName: true, email: true, role: true, branchId: true } },
};

const loadRows = (companyId) =>
  prisma.discountPolicy.findMany({
    where: { companyId },
    include: withSubjects,
    orderBy: [{ level: 'asc' }, { createdAt: 'asc' }],
  });

// The chain a row sits in, so the screen can preview what it actually
// resolves to rather than showing seven fields and leaving the owner to do
// the inheritance in their head.
const chainFor = (rows, { level, branchId, userId }) => {
  const byKey = new Map(rows.map((r) => [r.scopeKey, r]));
  const company = byKey.get('company');
  if (level === 'COMPANY') return [company].filter(Boolean);
  if (level === 'BRANCH') return [byKey.get(`branch:${branchId}`), company].filter(Boolean);
  const user = byKey.get(`user:${userId}`);
  const subject = rows.find((r) => r.userId === userId)?.user;
  const homeBranch = subject?.branchId ?? branchId ?? null;
  return [user, homeBranch ? byKey.get(`branch:${homeBranch}`) : null, company].filter(Boolean);
};

const effectiveFor = (rows, target, role) =>
  mergeDiscountPolicyRows(chainFor(rows, target), role);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const [rows, branches, staff] = await Promise.all([
      loadRows(companyId),
      prisma.branch.findMany({
        where: { companyId },
        select: { id: true, name: true, code: true, status: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.posUser.findMany({
        where: { companyId, role: { in: ['CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'] } },
        select: { id: true, fullName: true, email: true, role: true, branchId: true, status: true },
        orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
      }),
    ]);

    // What each member of staff can actually do today, inheritance already
    // applied. This is the column an owner reads to answer "so what CAN
    // Priya give?" without opening four screens.
    const effective = staff.map((u) => {
      const merged = effectiveFor(
        rows,
        { level: 'USER', userId: u.id, branchId: u.branchId },
        u.role,
      );
      return {
        userId: u.id,
        ...merged,
        ceiling: describeCeiling({
          maxPctMilli: merged.maxPctMilli,
          maxFlatPaise: merged.maxFlatPaise,
        }),
        approvalCeiling: describeCeiling({
          maxPctMilli: merged.maxApprovalPctMilli,
          maxFlatPaise: merged.maxApprovalFlatPaise,
        }),
      };
    });

    res.json({
      policies: rows.map(publicPolicy),
      branches,
      staff,
      effective,
      // So the screen can say what happens when the company has configured
      // nothing, instead of showing empty boxes that look like a bug.
      floor: {
        CASHIER: ROLE_FLOOR.CASHIER,
        BRANCH_MANAGER: ROLE_FLOOR.BRANCH_MANAGER,
        CUSTOMER_OWNER: ROLE_FLOOR.CUSTOMER_OWNER,
      },
    });
  }),
);

// null is a real value here and means "inherit from the level above", which
// is different from 0 ("allowed nothing") and different from omitting the
// field. The client always sends all seven.
const nullableBool = z.boolean().nullable();
const nullablePct = z.number().min(0).max(100).nullable();
const nullablePaise = z.number().int().min(0).max(1_000_000_00).nullable();

const upsertSchema = z
  .object({
    level: z.enum(['COMPANY', 'BRANCH', 'USER']),
    branchId: z.string().min(1).nullable().optional(),
    userId: z.string().min(1).nullable().optional(),
    allowLineDiscount: nullableBool.default(null),
    allowOrderDiscount: nullableBool.default(null),
    maxPercent: nullablePct.default(null),
    maxFlatPaise: nullablePaise.default(null),
    canApprove: nullableBool.default(null),
    maxApprovalPercent: nullablePct.default(null),
    maxApprovalFlatPaise: nullablePaise.default(null),
    note: z.string().trim().max(200).nullable().default(null),
  })
  .refine((v) => v.level !== 'BRANCH' || !!v.branchId, {
    message: 'A branch override needs a branch',
    path: ['branchId'],
  })
  .refine((v) => v.level !== 'USER' || !!v.userId, {
    message: 'A staff override needs a member of staff',
    path: ['userId'],
  });

const FIELDS = [
  'allowLineDiscount',
  'allowOrderDiscount',
  'maxPercent',
  'maxFlatPaise',
  'canApprove',
  'maxApprovalPercent',
  'maxApprovalFlatPaise',
];

const isEmpty = (body) => FIELDS.every((f) => body[f] === null);

// A grant that carries no ceiling anywhere in its chain resolves to a ceiling
// of zero, which refuses everything. That is a permission that looks granted
// on this screen and denies at the till, so it is refused at the point the
// owner would have created it rather than discovered at the counter.
//
// Either ceiling at zero is enough. The two apply together ("whichever is
// lower"), so "10% or ₹0" and "0% with no cash cap" refuse every discount just
// as surely as "0% and ₹0" — and a typed 0 beside a ticked permission is the
// same contradiction as an empty chain, arrived at by a different route.
const zeroCeiling = (pctMilli, flatPaise) => pctMilli === 0 || flatPaise === 0;

const assertGrantIsUsable = (merged, subjectRole) => {
  const floor = ROLE_FLOOR[subjectRole] ?? ROLE_FLOOR.CASHIER;
  const unbounded = floor.maxPctMilli === null && floor.maxFlatPaise === null;
  if (
    (merged.allowLineDiscount || merged.allowOrderDiscount) &&
    !unbounded &&
    zeroCeiling(merged.maxPctMilli, merged.maxFlatPaise)
  ) {
    throw badRequest(
      'Set a maximum percentage or a maximum amount. A permission with no limit set refuses every discount — enter 100% if you mean no limit.',
      'maxPercent',
    );
  }
  if (merged.canApprove && !unbounded && zeroCeiling(merged.maxApprovalPctMilli, merged.maxApprovalFlatPaise)) {
    throw badRequest(
      'Set a maximum this person may approve. Approval with no limit set refuses every request — enter 100% if you mean no limit.',
      'maxApprovalPercent',
    );
  }
};

router.put(
  '/',
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const body = upsertSchema.parse(req.body);

    if (isEmpty(body)) {
      throw badRequest(
        'Nothing to save — every setting is set to inherit. Remove the override instead.',
      );
    }

    let subjectRole = 'CASHIER';
    let branchId = null;
    let userId = null;

    if (body.level === 'BRANCH') {
      const branch = await prisma.branch.findFirst({
        where: { id: body.branchId, companyId },
        select: { id: true },
      });
      if (!branch) throw notFound('Branch not found');
      branchId = branch.id;
    }
    if (body.level === 'USER') {
      const user = await prisma.posUser.findFirst({
        where: { id: body.userId, companyId },
        select: { id: true, role: true, branchId: true, fullName: true },
      });
      // Scoped to the company, so this is also what answers a VEXO operator's
      // id: they belong to no company, so they are not in this one. Same
      // reply as any other id from outside the tenant — a 404 here teaches a
      // caller nothing about who exists.
      if (!user) throw notFound('That member of staff is not in this company');
      userId = user.id;
      branchId = user.branchId;
      subjectRole = user.role;
    }

    const scopeKey = scopeKeyFor({ level: body.level, branchId: body.branchId, userId });
    const data = {
      allowLineDiscount: body.allowLineDiscount,
      allowOrderDiscount: body.allowOrderDiscount,
      maxPercent: body.maxPercent === null ? null : body.maxPercent.toFixed(3),
      maxFlatPaise: body.maxFlatPaise,
      canApprove: body.canApprove,
      maxApprovalPercent: body.maxApprovalPercent === null ? null : body.maxApprovalPercent.toFixed(3),
      maxApprovalFlatPaise: body.maxApprovalFlatPaise,
      note: body.note,
      updatedById: req.user.id,
    };

    // Resolve what this row would mean BEFORE writing it, so an unusable
    // grant is refused rather than saved and discovered at a till.
    const existing = await loadRows(companyId);
    const simulated = [
      ...existing.filter((r) => r.scopeKey !== scopeKey),
      { ...body, scopeKey, branchId, userId, level: body.level },
    ];
    const target =
      body.level === 'USER'
        ? { level: 'USER', userId, branchId }
        : body.level === 'BRANCH'
          ? { level: 'BRANCH', branchId: body.branchId }
          : { level: 'COMPANY' };
    assertGrantIsUsable(effectiveFor(simulated, target, subjectRole), subjectRole);

    const before = existing.find((r) => r.scopeKey === scopeKey) ?? null;
    const saved = await prisma.discountPolicy.upsert({
      where: { companyId_scopeKey: { companyId, scopeKey } },
      create: {
        companyId,
        level: body.level,
        scopeKey,
        branchId: body.level === 'COMPANY' ? null : body.level === 'BRANCH' ? body.branchId : null,
        userId,
        ...data,
      },
      update: data,
      include: withSubjects,
    });

    await audit(req, {
      action: 'DISCOUNT_POLICY_SET',
      entity: 'DiscountPolicy',
      entityId: saved.id,
      companyId,
      meta: {
        level: saved.level,
        scopeKey,
        branchId: saved.branchId,
        userId: saved.userId,
        before: before ? publicPolicy(before) : null,
        after: publicPolicy(saved),
      },
    });

    res.json({ policy: publicPolicy(saved) });
  }),
);

router.delete(
  '/:id',
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const row = await prisma.discountPolicy.findFirst({
      where: { id: req.params.id, companyId },
      include: withSubjects,
    });
    if (!row) throw notFound('Discount setting not found');

    await prisma.discountPolicy.delete({ where: { id: row.id } });
    await audit(req, {
      action: 'DISCOUNT_POLICY_CLEARED',
      entity: 'DiscountPolicy',
      entityId: row.id,
      companyId,
      meta: {
        level: row.level,
        scopeKey: row.scopeKey,
        branchId: row.branchId,
        userId: row.userId,
        before: publicPolicy(row),
      },
    });

    res.json({ ok: true });
  }),
);

export default router;
