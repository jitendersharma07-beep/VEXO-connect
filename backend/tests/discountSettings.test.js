// The screen where a company's admin types its discount limits.
//
// discounts.test.js proves the till obeys a configuration. This file proves
// the configuration is the one the admin actually typed: that only the owner
// may type it, that the three levels resolve the way the screen claims they
// do, that a grant which would refuse everything is refused at the point of
// entry, and that a row written here changes what the till does.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('discountSettings.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const wipe = async () => {
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  // RESTRICT foreign keys: policies go before the rows they point at.
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
const users = {};
let fox, golf, f1, f2, g1, coffee;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// The seven fields the screen always sends. null means "inherit"; the client
// posts the whole shape every time so a cleared box is distinguishable from a
// box the client forgot about.
const INHERIT = {
  allowLineDiscount: null,
  allowOrderDiscount: null,
  maxPercent: null,
  maxFlatPaise: null,
  canApprove: null,
  maxApprovalPercent: null,
  maxApprovalFlatPaise: null,
};

const putPolicy = (token, body) =>
  request(app).put('/api/discount-policies').set(auth(token)).send({ ...INHERIT, ...body });

const getScreen = async (token) => {
  const res = await request(app).get('/api/discount-policies').set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

const effectiveFor = (screen, userId) => screen.effective.find((e) => e.userId === userId);

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);

  fox = await prisma.company.create({
    data: {
      name: 'Foxtrot Foods',
      slug: 'foxtrot-foods',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inADay } },
    },
  });
  golf = await prisma.company.create({
    data: {
      name: 'Golf Grill',
      slug: 'golf-grill',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  f1 = await prisma.branch.create({ data: { companyId: fox.id, name: 'Foxtrot One', code: 'F1' } });
  f2 = await prisma.branch.create({ data: { companyId: fox.id, name: 'Foxtrot Two', code: 'F2' } });
  g1 = await prisma.branch.create({ data: { companyId: golf.id, name: 'Golf One', code: 'G1' } });

  const mk = async (key, data) => {
    users[key] = await prisma.posUser.create({ data: { passwordHash, ...data } });
    tokens[key] = await login(data.email);
  };
  await mk('ownerF', {
    email: 'owner.f@test.local', fullName: 'Owner F', role: 'CUSTOMER_OWNER', companyId: fox.id,
  });
  await mk('mgrF1', {
    email: 'mgr.f1@test.local', fullName: 'Manager F1', role: 'BRANCH_MANAGER', companyId: fox.id, branchId: f1.id,
  });
  await mk('cashierF1', {
    email: 'cashier.f1@test.local', fullName: 'Cashier F1', role: 'CASHIER', companyId: fox.id, branchId: f1.id,
  });
  await mk('cashierF2', {
    email: 'cashier.f2@test.local', fullName: 'Cashier F2', role: 'CASHIER', companyId: fox.id, branchId: f2.id,
  });
  await mk('ownerG', {
    email: 'owner.g@test.local', fullName: 'Owner G', role: 'CUSTOMER_OWNER', companyId: golf.id,
  });

  users.atc = await prisma.posUser.create({
    data: { passwordHash, email: 'atc@test.local', fullName: 'ATC Operator', role: 'POS_SUPER_ADMIN' },
  });
  tokens.atc = await login('atc@test.local');

  // One product so the last describe can put a real discount on a real bill.
  const tax = await prisma.taxRate.create({
    data: { companyId: fox.id, name: 'GST 5', ratePercent: '5.000' },
  });
  const cat = await prisma.category.create({ data: { companyId: fox.id, name: 'Drinks' } });
  const product = await prisma.product.create({
    data: {
      companyId: fox.id, categoryId: cat.id, taxRateId: tax.id,
      name: 'Filter Coffee', basePrice: '500.00',
    },
  });
  coffee = product.id;
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('who may open the discount settings screen', () => {
  it('lets the company owner in, with the branches and staff to configure', async () => {
    const screen = await getScreen(tokens.ownerF);
    expect(screen.branches.map((b) => b.code).sort()).toEqual(['F1', 'F2']);
    expect(screen.staff.map((s) => s.email)).toContain('cashier.f1@test.local');
    // Only this company's people — never the other tenant's, and never ATC's
    // own operator account.
    expect(screen.staff.map((s) => s.email)).not.toContain('owner.g@test.local');
    expect(screen.staff.map((s) => s.email)).not.toContain('atc@test.local');
  });

  it('refuses a branch manager, who would otherwise set their own ceiling', async () => {
    const res = await request(app).get('/api/discount-policies').set(auth(tokens.mgrF1));
    expect(res.status).toBe(403);
    const write = await putPolicy(tokens.mgrF1, {
      level: 'USER', userId: users.mgrF1.id, canApprove: true, maxApprovalPercent: 100,
    });
    expect(write.status).toBe(403);
    expect(await prisma.discountPolicy.count({ where: { userId: users.mgrF1.id } })).toBe(0);
  });

  it('refuses a cashier', async () => {
    const res = await request(app).get('/api/discount-policies').set(auth(tokens.cashierF1));
    expect(res.status).toBe(403);
  });

  it('refuses ATC own operator — a customer limit is not ours to raise', async () => {
    // Flatly, and without first asking which company they meant: there is no
    // companyId that gets a VEXO operator into this screen.
    const res = await request(app)
      .get('/api/discount-policies')
      .query({ companyId: fox.id })
      .set(auth(tokens.atc));
    expect(res.status).toBe(403);
  });

  it('refuses a request with no token at all', async () => {
    expect((await request(app).get('/api/discount-policies')).status).toBe(401);
  });
});

describe('a company that has configured nothing', () => {
  it('reports every member of staff as allowed no discount, and says what the floor is', async () => {
    const screen = await getScreen(tokens.ownerF);
    expect(screen.policies).toEqual([]);

    const cashier = effectiveFor(screen, users.cashierF1.id);
    expect(cashier.allowLineDiscount).toBe(false);
    expect(cashier.allowOrderDiscount).toBe(false);
    expect(cashier.maxPctMilli).toBe(0);
    expect(cashier.canApprove).toBe(false);

    const manager = effectiveFor(screen, users.mgrF1.id);
    expect(manager.allowOrderDiscount).toBe(false);
    expect(manager.canApprove).toBe(false);

    // The owner is not bounded by a configuration they have not written.
    const owner = effectiveFor(screen, users.ownerF.id);
    expect(owner.allowOrderDiscount).toBe(true);
    expect(owner.maxPctMilli).toBeNull();

    // Published so the screen can explain the empty state instead of showing
    // blank boxes that look like a loading bug.
    expect(screen.floor.CASHIER.allowLineDiscount).toBe(false);
    expect(screen.floor.CUSTOMER_OWNER.canApprove).toBe(true);
  });
});

describe('company default, branch override, staff override', () => {
  it('writes the company default and resolves it for everyone below the owner', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'COMPANY',
      allowLineDiscount: true,
      allowOrderDiscount: true,
      maxPercent: 10,
      note: 'House rule',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.policy.level).toBe('COMPANY');
    expect(res.body.policy.maxPercent).toBe(10);
    expect(res.body.policy.note).toBe('House rule');

    const screen = await getScreen(tokens.ownerF);
    for (const key of ['cashierF1', 'cashierF2', 'mgrF1']) {
      const e = effectiveFor(screen, users[key].id);
      expect(e.allowLineDiscount, key).toBe(true);
      expect(e.maxPctMilli, key).toBe(10000);
      // Still nobody may approve: the admin granted a ceiling, not authority.
      expect(e.canApprove, key).toBe(false);
    }
  });

  it('does not read a ceiling the admin left blank as a ceiling of zero', async () => {
    // The grant above set a percentage and no rupee cap. If the blank box were
    // read as the deny floor's zero, this would resolve to "10% and also ₹0",
    // which refuses every discount while the screen reports a limit.
    const screen = await getScreen(tokens.ownerF);
    const cashier = effectiveFor(screen, users.cashierF1.id);
    expect(cashier.maxFlatPaise).toBeNull();
    expect(cashier.ceiling).toContain('10');
  });

  it('lets one branch be trusted with more than the rest', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'BRANCH', branchId: f2.id, maxPercent: 20,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.policy.branchName).toBe('Foxtrot Two');

    const screen = await getScreen(tokens.ownerF);
    expect(effectiveFor(screen, users.cashierF2.id).maxPctMilli).toBe(20000);
    // F1 is untouched by an override written for F2.
    expect(effectiveFor(screen, users.cashierF1.id).maxPctMilli).toBe(10000);
    // And the branch row inherited the allow flags rather than replacing them.
    expect(effectiveFor(screen, users.cashierF2.id).allowLineDiscount).toBe(true);
  });

  it('lets one member of staff be trusted with more than their branch', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'USER', userId: users.cashierF1.id, maxPercent: 35, maxFlatPaise: 25000,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.policy.userName).toBe('Cashier F1');
    expect(res.body.policy.userRole).toBe('CASHIER');

    const screen = await getScreen(tokens.ownerF);
    const e = effectiveFor(screen, users.cashierF1.id);
    expect(e.maxPctMilli).toBe(35000);
    expect(e.maxFlatPaise).toBe(25000);
    // Their colleague at the same branch did not move.
    expect(effectiveFor(screen, users.cashierF2.id).maxPctMilli).toBe(20000);
  });

  it('delegates approval to a manager, bounded by its own separate ceiling', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'USER', userId: users.mgrF1.id, canApprove: true, maxApprovalPercent: 50,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const screen = await getScreen(tokens.ownerF);
    const e = effectiveFor(screen, users.mgrF1.id);
    expect(e.canApprove).toBe(true);
    expect(e.maxApprovalPctMilli).toBe(50000);
    // Approving to 50% did not also raise what they may take on their own.
    expect(e.maxPctMilli).toBe(10000);
    expect(e.approvalCeiling).toContain('50');
  });

  it('edits a row in place rather than stacking a second one on the same scope', async () => {
    const before = await getScreen(tokens.ownerF);
    const res = await putPolicy(tokens.ownerF, {
      level: 'BRANCH', branchId: f2.id, maxPercent: 15,
    });
    expect(res.status).toBe(200);

    const after = await getScreen(tokens.ownerF);
    expect(after.policies.length).toBe(before.policies.length);
    expect(effectiveFor(after, users.cashierF2.id).maxPctMilli).toBe(15000);
  });
});

describe('a grant that would refuse every discount', () => {
  it('refuses permission with no ceiling anywhere in its chain', async () => {
    // Golf Grill has no company default, so this branch grant inherits
    // nothing: allowed to discount, up to zero. That is a permission that
    // reads as granted here and denies at the counter.
    const res = await putPolicy(tokens.ownerG, {
      level: 'BRANCH', branchId: g1.id, allowLineDiscount: true, allowOrderDiscount: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('maxPercent');
    expect(res.body.error.message).toMatch(/refuses every discount/);
    expect(await prisma.discountPolicy.count({ where: { companyId: golf.id } })).toBe(0);
  });

  it('refuses approval authority with no approval ceiling anywhere', async () => {
    const res = await putPolicy(tokens.ownerG, {
      level: 'COMPANY', allowLineDiscount: true, maxPercent: 10, canApprove: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('maxApprovalPercent');
    expect(await prisma.discountPolicy.count({ where: { companyId: golf.id } })).toBe(0);
  });

  it('accepts the same grant once a ceiling is typed beside it', async () => {
    // The negative control for the two refusals above: the only thing that
    // changed is the number, so the refusals were about the number.
    const res = await putPolicy(tokens.ownerG, {
      level: 'BRANCH', branchId: g1.id, allowLineDiscount: true, allowOrderDiscount: true, maxPercent: 5,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await prisma.discountPolicy.deleteMany({ where: { companyId: golf.id } });
  });

  it('refuses a body where every box says inherit', async () => {
    const res = await putPolicy(tokens.ownerF, { level: 'BRANCH', branchId: f1.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Remove the override instead/);
  });
});

describe('the row has to belong to this company', () => {
  it('will not write an override for another company branch', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'BRANCH', branchId: g1.id, maxPercent: 90,
    });
    expect(res.status).toBe(404);
    expect(await prisma.discountPolicy.count({ where: { branchId: g1.id } })).toBe(0);
  });

  it('will not write an override for another company staff', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'USER', userId: users.ownerG.id, maxPercent: 90,
    });
    expect(res.status).toBe(404);
    expect(await prisma.discountPolicy.count({ where: { userId: users.ownerG.id } })).toBe(0);
  });

  it('will not write an override for a VEXO operator', async () => {
    // Answered exactly like any other id from outside the tenant, because an
    // ATC operator belongs to no company and so is not in this one.
    const res = await putPolicy(tokens.ownerF, {
      level: 'USER', userId: users.atc.id, maxPercent: 90,
    });
    expect(res.status).toBe(404);
    expect(await prisma.discountPolicy.count({ where: { userId: users.atc.id } })).toBe(0);
  });

  it('will not write a branch override with no branch, or a staff override with no staff', async () => {
    const noBranch = await putPolicy(tokens.ownerF, { level: 'BRANCH', maxPercent: 10 });
    expect(noBranch.status).toBe(400);
    const noUser = await putPolicy(tokens.ownerF, { level: 'USER', maxPercent: 10 });
    expect(noUser.status).toBe(400);
  });

  it('will not accept a percentage above 100 or a negative cap', async () => {
    expect((await putPolicy(tokens.ownerF, { level: 'COMPANY', maxPercent: 101 })).status).toBe(400);
    expect((await putPolicy(tokens.ownerF, { level: 'COMPANY', maxFlatPaise: -1 })).status).toBe(400);
    // The company default written earlier is still standing, unedited.
    const screen = await getScreen(tokens.ownerF);
    expect(effectiveFor(screen, users.cashierF2.id).maxPctMilli).toBe(15000);
  });
});

describe('clearing an override', () => {
  it('hands the member of staff back to their branch figure', async () => {
    const screen = await getScreen(tokens.ownerF);
    const row = screen.policies.find((p) => p.userId === users.cashierF1.id && p.maxPercent === 35);
    expect(row, 'staff override should exist by now').toBeTruthy();

    const res = await request(app)
      .delete(`/api/discount-policies/${row.id}`)
      .set(auth(tokens.ownerF));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await getScreen(tokens.ownerF);
    // Falls back to the company default, because F1 has no branch override.
    expect(effectiveFor(after, users.cashierF1.id).maxPctMilli).toBe(10000);
    expect(effectiveFor(after, users.cashierF1.id).allowLineDiscount).toBe(true);
  });

  it('will not clear another company row', async () => {
    const mine = await prisma.discountPolicy.create({
      data: { companyId: golf.id, level: 'COMPANY', scopeKey: 'company', maxPercent: '5.000' },
    });
    const res = await request(app)
      .delete(`/api/discount-policies/${mine.id}`)
      .set(auth(tokens.ownerF));
    expect(res.status).toBe(404);
    expect(await prisma.discountPolicy.findUnique({ where: { id: mine.id } })).toBeTruthy();
    await prisma.discountPolicy.delete({ where: { id: mine.id } });
  });

  it('answers a row that never existed the same way', async () => {
    const res = await request(app)
      .delete('/api/discount-policies/does-not-exist')
      .set(auth(tokens.ownerF));
    expect(res.status).toBe(404);
  });
});

describe('what the audit trail records', () => {
  it('records who changed a limit, and what it was before', async () => {
    await prisma.posAuditLog.deleteMany({ where: { action: 'DISCOUNT_POLICY_SET' } });

    const first = await putPolicy(tokens.ownerF, {
      level: 'BRANCH', branchId: f1.id, maxPercent: 12,
    });
    expect(first.status).toBe(200);
    const second = await putPolicy(tokens.ownerF, {
      level: 'BRANCH', branchId: f1.id, maxPercent: 18,
    });
    expect(second.status).toBe(200);

    const logs = await prisma.posAuditLog.findMany({
      where: { action: 'DISCOUNT_POLICY_SET' },
      orderBy: { at: 'asc' },
    });
    expect(logs.length).toBe(2);

    // A first write has nothing before it, and says so rather than implying a
    // zero somebody once typed.
    expect(logs[0].meta.before).toBeNull();
    expect(logs[0].meta.after.maxPercent).toBe(12);
    expect(logs[0].meta.scopeKey).toBe(`branch:${f1.id}`);

    expect(logs[1].meta.before.maxPercent).toBe(12);
    expect(logs[1].meta.after.maxPercent).toBe(18);
    expect(logs[1].actorId).toBe(users.ownerF.id);
    expect(logs[1].companyId).toBe(fox.id);
  });

  it('records the limit that was in force when an override is cleared', async () => {
    const screen = await getScreen(tokens.ownerF);
    const row = screen.policies.find((p) => p.branchId === f1.id);
    const res = await request(app)
      .delete(`/api/discount-policies/${row.id}`)
      .set(auth(tokens.ownerF));
    expect(res.status).toBe(200);

    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'DISCOUNT_POLICY_CLEARED' },
      orderBy: { at: 'desc' },
    });
    expect(log.meta.before.maxPercent).toBe(18);
    expect(log.meta.scopeKey).toBe(`branch:${f1.id}`);
    expect(log.actorId).toBe(users.ownerF.id);
  });
});

describe('the screen and the till read the same configuration', () => {
  // The whole point of the settings API. Everything above proves the numbers
  // round-trip; this proves they BIND.
  const newOrder = async (token, branchId) => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(token))
      .send({ type: 'TAKEAWAY', branchId, items: [{ productId: coffee, qty: 2 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.order;
  };

  it('a limit typed on the screen is the limit enforced at the counter', async () => {
    // The company default is 10% and F1 has no override of its own any more.
    const order = await newOrder(tokens.cashierF1, f1.id);
    const ok = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierF1))
      .send({ type: 'PERCENT', value: 10 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const over = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierF1))
      .send({ type: 'PERCENT', value: 11 });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('POS_DISCOUNT_NOT_PERMITTED');
    // The refusal quotes back the number the owner typed on the screen — both
    // as the limit that was breached and as the ceiling now in force, which is
    // what the till shows the cashier.
    expect(over.body.error.details.breach.limitPctMilli).toBe(10000);
    expect(over.body.error.details.yourLimit.maxPctMilli).toBe(10000);
    expect(over.body.error.details.approvalRequired).toBe(true);
  });

  it('tightening the limit on the screen tightens the counter on the next sale', async () => {
    const res = await putPolicy(tokens.ownerF, {
      level: 'COMPANY', allowLineDiscount: true, allowOrderDiscount: true, maxPercent: 5,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const order = await newOrder(tokens.cashierF1, f1.id);
    const nowRefused = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierF1))
      .send({ type: 'PERCENT', value: 10 });
    expect(nowRefused.status).toBe(403);
    expect(nowRefused.body.error.details.breach.limitPctMilli).toBe(5000);

    const stillAllowed = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierF1))
      .send({ type: 'PERCENT', value: 5 });
    expect(stillAllowed.status, JSON.stringify(stillAllowed.body)).toBe(200);
  });

  it('approval authority typed on the screen is the authority accepted at the counter', async () => {
    // mgrF1 was delegated 50% approval earlier. Nothing about that delegation
    // was re-stated here — the till reads the same row the screen wrote.
    const order = await newOrder(tokens.cashierF1, f1.id);
    const res = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierF1))
      .send({
        type: 'PERCENT',
        value: 30,
        approval: {
          approverEmail: 'mgr.f1@test.local',
          password: PW,
          reason: 'Spilled the first round',
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const saved = await prisma.order.findUnique({ where: { id: order.id } });
    expect(saved.discountApprovedById).toBe(users.mgrF1.id);
    expect(saved.discountReason).toBe('Spilled the first round');

    // And past their delegated ceiling, the same manager is refused.
    const tooFar = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierF1))
      .send({
        type: 'PERCENT',
        value: 60,
        approval: {
          approverEmail: 'mgr.f1@test.local',
          password: PW,
          reason: 'Spilled the second round',
        },
      });
    expect(tooFar.status).toBe(403);
    expect(tooFar.body.error.code).toBe('POS_DISCOUNT_APPROVAL_REFUSED');
  });

  it('tells the till what this operator may do, so it stops offering what it cannot', async () => {
    // Not enforcement — every discount is still re-decided on the request
    // that moves it. This is so the screen can avoid offering a control whose
    // only outcome was ever a refusal at the counter.
    const res = await request(app).get('/api/auth/me').set(auth(tokens.cashierF1));
    expect(res.status).toBe(200);
    expect(res.body.discountPolicy.allowOrderDiscount).toBe(true);
    expect(res.body.discountPolicy.maxPctMilli).toBe(5000);
    expect(res.body.discountPolicy.canApprove).toBe(false);
    expect(res.body.discountPolicy.ceiling).toContain('5');

    const mgr = await request(app).get('/api/auth/me').set(auth(tokens.mgrF1));
    expect(mgr.body.discountPolicy.canApprove).toBe(true);
    expect(mgr.body.discountPolicy.maxApprovalPctMilli).toBe(50000);

    // A company that configured nothing tells its staff exactly that.
    const golfOwnerView = await request(app).get('/api/auth/me').set(auth(tokens.ownerG));
    expect(golfOwnerView.body.discountPolicy.allowOrderDiscount).toBe(true);

    // And ATC own operator has no company to have a policy in.
    const atc = await request(app).get('/api/auth/me').set(auth(tokens.atc));
    expect(atc.body.discountPolicy).toBeNull();
  });
});
