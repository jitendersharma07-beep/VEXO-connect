// LANE reporting — /api/reporting over HTTP.
//
// The isolation assertions here are made by CALLING THE API, not by inspecting
// the scope resolver. A menu that hides a store proves nothing: the question is
// what the server answers when somebody asks for that store's id directly, with
// a valid token, from a saved link or a script. So every isolation test below
// names a real id belonging to somebody else and checks the answer.
//
// It also pins the defect this lane exists to fix. Legacy /api/reports gates on
// requireRole('POS_SUPER_ADMIN','CUSTOMER_OWNER','BRANCH_MANAGER'), so a FINANCE
// user is refused a sales report the permission catalog grants them. Both
// behaviours are asserted, because the old route still serves the POS and must
// not change.
//
// Runs ONLY against a database whose name ends in _test — this suite truncates.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('reportingApi.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const PW = 'reporting-password-1';
const DAY = 86400e3;
// Distinctive on purpose: an assertion can look for this exact figure in the
// sales report and its absence from yesterday's collections.
const CARRIED_SUBTOTAL = 31700;

let companyA, companyB;
let a1, a2, b1, regionNorth;
let ownerAId;
const tokens = {};

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// Figures are written in paise and stored as the Decimal rupees a real bill
// leaves, so the report reads exactly what the POS would have written.
const bill = async ({
  branchId,
  companyId,
  billedAt,
  status = 'PAID',
  subtotal,
  taxAmount = 0,
  discountAmount = 0,
  paid = null,
  method = 'CASH',
  refund = 0,
  productId,
  productName = 'Filter Coffee',
  qty = 1,
  openedById = null,
  paidAt = null,
  refundedAt = null,
}) => {
  const by = openedById ?? ownerAId;
  const total = subtotal - discountAmount + taxAmount;
  const order = await prisma.order.create({
    data: {
      companyId,
      branchId,
      type: 'DINE_IN',
      status,
      openedById: by,
      billedAt,
      discountAmount: discountAmount / 100,
      subtotal: subtotal / 100,
      taxAmount: taxAmount / 100,
      total: total / 100,
      items: {
        create: [
          {
            productId,
            name: productName,
            qty,
            unitPrice: subtotal / qty / 100,
            lineDiscount: 0,
            lineSubtotal: subtotal / 100,
            discountShare: discountAmount / 100,
            lineTax: taxAmount / 100,
            lineTotal: (subtotal - discountAmount + taxAmount) / 100,
            status: 'ACTIVE',
          },
        ],
      },
    },
  });
  const collected = paid === null ? total : paid;
  if (collected > 0) {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        branchId,
        method,
        amount: collected / 100,
        receivedById: method === 'CASH' ? by : null,
        // Stated, not defaulted. Money dates on its own createdAt, so leaving
        // this to now() would have dated every collection to the moment the
        // fixture ran while the invoice it settles sat on another day. The
        // reports were right to report nothing; the fixture was lying.
        createdAt: paidAt ?? billedAt,
      },
    });
  }
  if (refund > 0) {
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: refund / 100,
        reason: 'reporting test',
        status: 'SUCCEEDED',
        byId: by,
        createdAt: refundedAt ?? paidAt ?? billedAt,
      },
    });
  }
  return order;
};

// Mid-afternoon yesterday: safely inside the business day whichever way the
// cutoff is set, so these fixtures never sit on a boundary by accident.
const yesterdayAfternoon = () => new Date(Date.now() - DAY + 6 * 3600e3);

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Reporting Alpha',
      slug: 'reporting-alpha',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 5, expiresAt: new Date(Date.now() + DAY) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Reporting Bravo',
      slug: 'reporting-bravo',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + DAY) },
      },
    },
  });

  regionNorth = await prisma.region.create({
    data: { companyId: companyA.id, name: 'North', code: 'RPNORTH' },
  });

  // publicId shape is pinned by CHECK Branch_publicId_shape to ^VC-[A-Z]{2}-[0-9]{4,}$.
  // RP = reporting; no other suite uses it.
  a1 = await prisma.branch.create({
    data: {
      companyId: companyA.id,
      publicId: 'VC-RP-0001',
      name: 'Alpha One',
      code: 'RA1',
      regionId: regionNorth.id,
    },
  });
  a2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-RP-0002', name: 'Alpha Two', code: 'RA2' },
  });
  b1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-RP-0003', name: 'Bravo One', code: 'RB1' },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  const ownerA = await mk({
    email: 'owner.a@reporting.test.local',
    fullName: 'Owner A',
    role: 'CUSTOMER_OWNER',
    companyId: companyA.id,
  });
  ownerAId = ownerA.id;
  await mk({
    email: 'finance.a@reporting.test.local',
    fullName: 'Finance A',
    role: 'FINANCE',
    companyId: companyA.id,
  });
  await mk({
    email: 'auditor.a@reporting.test.local',
    fullName: 'Auditor A',
    role: 'AUDITOR',
    companyId: companyA.id,
  });
  await mk({
    email: 'rm.a@reporting.test.local',
    fullName: 'RM A',
    role: 'REGIONAL_MANAGER',
    companyId: companyA.id,
    regionId: regionNorth.id,
  });
  await mk({
    email: 'mgr.a1@reporting.test.local',
    fullName: 'Mgr A1',
    role: 'BRANCH_MANAGER',
    companyId: companyA.id,
    branchId: a1.id,
  });
  await mk({
    email: 'cashier.a1@reporting.test.local',
    fullName: 'Cashier A1',
    role: 'CASHIER',
    companyId: companyA.id,
    branchId: a1.id,
  });
  const ownerB = await mk({
    email: 'owner.b@reporting.test.local',
    fullName: 'Owner B',
    role: 'CUSTOMER_OWNER',
    companyId: companyB.id,
  });

  const cat = await prisma.category.create({ data: { companyId: companyA.id, name: 'Drinks' } });
  const coffee = await prisma.product.create({
    data: {
      companyId: companyA.id,
      categoryId: cat.id,
      name: 'Filter Coffee',
      sku: 'RP-SKU-COFFEE',
      basePrice: 50,
    },
  });
  // Bravo gets its own catalog rather than borrowing Alpha's. Sharing a product
  // across tenants would make a product-mix leak impossible to detect: the row
  // would look correct whichever company it was counted under.
  const catB = await prisma.category.create({ data: { companyId: companyB.id, name: 'Drinks' } });
  const coffeeB = await prisma.product.create({
    data: {
      companyId: companyB.id,
      categoryId: catB.id,
      name: 'Bravo Coffee',
      sku: 'RP-SKU-BRAVO',
      basePrice: 50,
    },
  });

  const at = yesterdayAfternoon();
  // Alpha One: 100000 + 50000 net, 10000 tax, one 5000 refund, one part-paid bill.
  await bill({
    companyId: companyA.id,
    branchId: a1.id,
    billedAt: at,
    subtotal: 100000,
    taxAmount: 5000,
    productId: coffee.id,
    qty: 2,
  });
  await bill({
    companyId: companyA.id,
    branchId: a1.id,
    billedAt: at,
    subtotal: 50000,
    taxAmount: 2500,
    refund: 5000,
    method: 'CARD',
    productId: coffee.id,
  });
  // Invoiced yesterday, collected today. The one fixture that makes "sales" and
  // "collections" provably different reports rather than two names for one
  // number: yesterday's sales must include this and yesterday's collections
  // must not.
  await bill({
    companyId: companyA.id,
    branchId: a1.id,
    billedAt: at,
    subtotal: CARRIED_SUBTOTAL,
    status: 'BILLED',
    paidAt: new Date(),
    method: 'UPI',
    productId: coffee.id,
  });
  // Alpha Two: one bill, deliberately part-paid so dues is not zero.
  await bill({
    companyId: companyA.id,
    branchId: a2.id,
    billedAt: at,
    subtotal: 80000,
    taxAmount: 4000,
    status: 'BILLED',
    paid: 20000,
    productId: coffee.id,
  });
  // Bravo: the other tenant's trade, rung up by Bravo's own owner on Bravo's own
  // product. No assertion may ever include it.
  await bill({
    companyId: companyB.id,
    branchId: b1.id,
    billedAt: at,
    subtotal: 999999,
    openedById: ownerB.id,
    productId: coffeeB.id,
    productName: 'Bravo Coffee',
  });

  tokens.ownerA = await login('owner.a@reporting.test.local');
  tokens.financeA = await login('finance.a@reporting.test.local');
  tokens.auditorA = await login('auditor.a@reporting.test.local');
  tokens.rmA = await login('rm.a@reporting.test.local');
  tokens.mgrA1 = await login('mgr.a1@reporting.test.local');
  tokens.cashierA1 = await login('cashier.a1@reporting.test.local');
  tokens.ownerB = await login('owner.b@reporting.test.local');
});

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

const YESTERDAY = 'preset=YESTERDAY';
const get = (path, token) => request(app).get(path).set(auth(token));
const byKeyOf = (res) => Object.fromEntries(res.body.reports.map((r) => [r.key, r]));

// ---------------------------------------------------------------------------

describe('reporting api: authority comes from the action', () => {
  it('a FINANCE user reads the sales report — the legacy router refuses them', async () => {
    const neu = await get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.financeA);
    expect(neu.status).toBe(200);
    expect(neu.body.report).toBe('sales');

    // Unchanged on purpose: the POS still calls this and the fix is the new path.
    const from = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const legacy = await get(`/api/reports/sales?from=${from}&to=${from}`, tokens.financeA);
    expect(legacy.status).toBe(403);
  });

  it('an AUDITOR reads every report family and writes none', async () => {
    for (const key of ['sales', 'collections', 'consumption']) {
      const res = await get(`/api/reporting/reports/${key}?${YESTERDAY}`, tokens.auditorA);
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const write = await request(app)
      .patch('/api/reporting/settings')
      .set(auth(tokens.auditorA))
      .send({ weekStartDay: 7 });
    expect(write.status).toBe(403);
  });

  it('a cashier holds no reporting action and is refused every report', async () => {
    for (const path of ['dashboard', 'reports/sales', 'reports/cash', 'settings']) {
      const res = await get(`/api/reporting/${path}?${YESTERDAY}`, tokens.cashierA1);
      expect(res.status, path).toBe(403);
    }
  });

  it('each report needs its own action, so one grant does not imply the rest', async () => {
    // FINANCE holds report.inventory.read but not report.dashboard.read is the
    // wrong way round — assert the grants that exist rather than guessing.
    const catalog = await get('/api/reporting/catalog', tokens.financeA);
    expect(catalog.status).toBe(200);
    const actions = new Set(catalog.body.reports.flatMap((r) => r.actions));
    expect(actions.size).toBeGreaterThan(1);
    for (const r of catalog.body.reports) {
      expect(r.actions.length).toBeGreaterThan(0);
      for (const a of r.actions) expect(a).toMatch(/^report\./);
    }
    // Food margin puts turnover and ingredient cost on one line, so it needs
    // both authorities. A single-action gate would have leaked cost to anybody
    // who could read sales.
    expect(byKeyOf(catalog).profitability.actions).toEqual([
      'report.sales.read',
      'report.inventory.read',
    ]);
  });

  it('refuses an unauthenticated caller outright', async () => {
    const res = await request(app).get('/api/reporting/reports/sales');
    expect(res.status).toBe(401);
  });
});

describe('reporting api: tenant isolation, asked directly', () => {
  it('the other tenant never appears in a consolidated total', async () => {
    const res = await get(`/api/reporting/dashboard?${YESTERDAY}`, tokens.ownerA);
    expect(res.status).toBe(200);
    const names = res.body.scope.stores.map((s) => s.name).sort();
    expect(names).toEqual(['Alpha One', 'Alpha Two']);
    expect(JSON.stringify(res.body)).not.toContain('Bravo');
    expect(JSON.stringify(res.body)).not.toContain('9999.99');
  });

  it('naming another tenant store id directly answers "not found", not "forbidden"', async () => {
    // 404 rather than 403 deliberately: a 403 would confirm the id exists, which
    // lets anyone map a competitor's estate one guess at a time.
    const res = await get(
      `/api/reporting/reports/sales?${YESTERDAY}&storeId=${b1.id}`,
      tokens.ownerA,
    );
    expect(res.status).toBe(404);
    expect(res.body.message ?? res.body.error?.message ?? '').toMatch(/not found/i);
  });

  it('an id that does not exist at all answers identically', async () => {
    const real = await get(`/api/reporting/reports/sales?${YESTERDAY}&storeId=${b1.id}`, tokens.ownerA);
    const fake = await get(
      `/api/reporting/reports/sales?${YESTERDAY}&storeId=ckxxxxxxxxxxxxxxxxxxxxxx`,
      tokens.ownerA,
    );
    expect(fake.status).toBe(real.status);
    expect(fake.body.message ?? fake.body.error?.message).toBe(
      real.body.message ?? real.body.error?.message,
    );
  });

  it('the other tenant asking for our store gets the same refusal', async () => {
    const res = await get(
      `/api/reporting/reports/sales?${YESTERDAY}&storeId=${a1.id}`,
      tokens.ownerB,
    );
    expect(res.status).toBe(404);
  });

  it('a tenant with no trade gets an honest empty, not our figures', async () => {
    const res = await get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.ownerB);
    expect(res.status).toBe(200);
    expect(res.body.scope.stores.map((s) => s.name)).toEqual(['Bravo One']);
    expect(JSON.stringify(res.body)).not.toContain('Alpha');
  });
});

describe('reporting api: store scope, asked directly', () => {
  it('a store-pinned manager sees only their store without asking', async () => {
    const res = await get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.mgrA1);
    expect(res.status).toBe(200);
    expect(res.body.scope.stores.map((s) => s.name)).toEqual(['Alpha One']);
  });

  it('a store-pinned manager naming a sibling store is refused, not widened', async () => {
    const res = await get(
      `/api/reporting/reports/sales?${YESTERDAY}&storeId=${a2.id}`,
      tokens.mgrA1,
    );
    expect(res.status).toBe(404);
  });

  it('a regional manager sees their region and not the rest of the company', async () => {
    const res = await get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.rmA);
    expect(res.status).toBe(200);
    // The legacy branchFilterFor pins only BRANCH_MANAGER and CASHIER, so a
    // regional manager there would have received the whole company.
    expect(res.body.scope.stores.map((s) => s.name)).toEqual(['Alpha One']);
  });

  it('the scope holds on the EXPORT, not only on the screen', async () => {
    const res = await request(app)
      .get(`/api/reporting/reports/sales/export?${YESTERDAY}&format=csv`)
      .set(auth(tokens.mgrA1));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alpha One');
    expect(res.text).not.toContain('Alpha Two');
    expect(res.text).not.toContain('Bravo');
  });

  it('a filter narrows but never grants', async () => {
    const res = await get(
      `/api/reporting/reports/sales?${YESTERDAY}&regionId=${regionNorth.id}`,
      tokens.ownerA,
    );
    expect(res.status).toBe(200);
    expect(res.body.scope.stores.map((s) => s.name)).toEqual(['Alpha One']);
    expect(res.body.scope.narrowed).toBe(true);
  });

  // The same clobber that let a manager name a sibling store also lived on
  // regionId: a region filter overwrote the region the caller was pinned to.
  // Asserted separately because the two are different Prisma keys and fixing one
  // does not fix the other.
  it('a region-pinned manager naming a region they do not hold sees no stores, not another region', async () => {
    const other = await prisma.region.create({
      data: { companyId: companyA.id, name: 'South', code: 'RPSOUTH' },
    });
    const moved = await prisma.branch.update({
      where: { id: a2.id },
      data: { regionId: other.id },
    });
    try {
      const res = await get(
        `/api/reporting/reports/sales?${YESTERDAY}&regionId=${other.id}`,
        tokens.rmA,
      );
      expect(res.status).toBe(200);
      // North ∩ South is empty. Before the fix this answered with Alpha Two.
      expect(res.body.scope.stores).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('Alpha Two');
    } finally {
      await prisma.branch.update({ where: { id: moved.id }, data: { regionId: null } });
      await prisma.region.delete({ where: { id: other.id } });
    }
  });
});

describe('reporting api: the figures reconcile', () => {
  it('the consolidated total equals the sum of the store rows', async () => {
    const res = await get(`/api/reporting/dashboard?${YESTERDAY}`, tokens.ownerA);
    expect(res.status).toBe(200);
    const rows = res.body.rows.filter((r) => r.storeId);
    expect(rows.length).toBe(2);
    const summed = rows.reduce((a, r) => a + r.netSales.paise, 0);
    expect(res.body.totals.netSales.paise).toBe(summed);
  });

  it('sales, collections and refunds are separately explainable', async () => {
    const [sales, collections, refunds] = await Promise.all([
      get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.ownerA),
      get(`/api/reporting/reports/collections?${YESTERDAY}`, tokens.ownerA),
      get(`/api/reporting/reports/refunds?${YESTERDAY}`, tokens.ownerA),
    ]);
    for (const r of [sales, collections, refunds]) expect(r.status).toBe(200);
    // Each names the date its figures are driven by. They are different dates,
    // which is the whole reason the three cannot be one number.
    expect(sales.body.basis.sales).toBeTruthy();
    expect(collections.body.basis).toBeTruthy();
    expect(refunds.body.basis).toBeTruthy();
    expect(refunds.body.rows.length).toBe(1);
    expect(refunds.body.rows[0].amount.paise).toBe(5000);

    // The bill invoiced yesterday and collected today. It is yesterday's sale
    // and it is not yesterday's cash, and no single figure can say both.
    const soldPaise = sales.body.totals.netSales.paise;
    const gotPaise = collections.body.totals?.collected?.paise ?? 0;
    expect(soldPaise).toBeGreaterThan(gotPaise);
    expect(soldPaise - gotPaise).toBeGreaterThanOrEqual(CARRIED_SUBTOTAL);
  });

  it('a part-paid bill appears as a due, not as a missing sale', async () => {
    const dues = await get(`/api/reporting/reports/dues?${YESTERDAY}`, tokens.ownerA);
    expect(dues.status).toBe(200);
    const row = dues.body.rows.find((r) => r.storeName === 'Alpha Two');
    expect(row, JSON.stringify(dues.body.rows)).toBeTruthy();
    // Billed 84000, paid 20000.
    expect(row.outstanding.paise).toBe(64000);
  });

  it('collections split by method rather than collapsing into one figure', async () => {
    const res = await get(`/api/reporting/reports/collections?${YESTERDAY}`, tokens.ownerA);
    expect(res.status).toBe(200);
    const methods = res.body.rows.map((r) => r.method).sort();
    expect(methods).toContain('CASH');
    expect(methods).toContain('CARD');
  });
});

describe('reporting api: the export is the payload', () => {
  it('every format answers, with the reader its content type promises', async () => {
    const expected = {
      csv: /text\/csv/,
      json: /application\/json/,
      pdf: /application\/pdf/,
      xlsx: /spreadsheetml/,
    };
    for (const [format, contentType] of Object.entries(expected)) {
      const res = await request(app)
        .get(`/api/reporting/reports/sales/export?${YESTERDAY}&format=${format}`)
        .set(auth(tokens.ownerA))
        .buffer(true)
        .parse((r, cb) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status, format).toBe(200);
      expect(res.headers['content-type'], format).toMatch(contentType);
      expect(res.headers['content-disposition'], format).toMatch(
        new RegExp(`filename="[^"]+\\.${format}"`),
      );
      expect(res.body.length, format).toBeGreaterThan(64);
    }
  });

  it('the CSV carries the same net sales as the JSON payload', async () => {
    const json = await get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.ownerA);
    const csv = await request(app)
      .get(`/api/reporting/reports/sales/export?${YESTERDAY}&format=csv`)
      .set(auth(tokens.ownerA));
    expect(csv.status).toBe(200);
    for (const row of json.body.rows) {
      expect(csv.text, `missing ${row.netSales.paise}`).toContain(String(row.netSales.paise / 100));
    }
    expect(csv.text).toContain(json.body.period.timezone);
  });

  it('refuses a format it cannot write instead of sending the wrong bytes', async () => {
    const res = await get(
      `/api/reporting/reports/sales/export?${YESTERDAY}&format=docx`,
      tokens.ownerA,
    );
    expect(res.status).toBe(400);
  });

  it('logs the export with the period and the exact stores it contained', async () => {
    await get(`/api/reporting/reports/sales/export?${YESTERDAY}&format=csv`, tokens.ownerA);
    const row = await prisma.posAuditLog.findFirst({
      where: { action: 'reporting.export', companyId: companyA.id },
      orderBy: { at: 'desc' },
    });
    expect(row).toBeTruthy();
    expect(row.meta.storeIds.sort()).toEqual([a1.id, a2.id].sort());
    expect(row.meta.format).toBe('csv');
  });
});

describe('reporting api: honest about what it cannot answer', () => {
  it('an unknown report key is a 404, not an empty success', async () => {
    const res = await get(`/api/reporting/reports/nonsense?${YESTERDAY}`, tokens.ownerA);
    expect(res.status).toBe(404);
  });

  it('a report family this build has no data for says so instead of showing zero', async () => {
    const res = await get(`/api/reporting/reports/wastage?${YESTERDAY}`, tokens.ownerA);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.note).toBeTruthy();
    expect(res.body.totals).toBeNull();
  });

  it('never reports a fabricated loyalty or delivery figure', async () => {
    for (const key of ['loyalty', 'delivery']) {
      const res = await get(`/api/reporting/reports/${key}?${YESTERDAY}`, tokens.ownerA);
      expect(res.status, key).toBe(200);
      expect(res.body.available, key).toBe(false);
      expect(res.body.rows, key).toEqual([]);
    }
  });

  it('consumption reports no variance at all when nothing has been counted', async () => {
    const res = await get(`/api/reporting/reports/consumption?${YESTERDAY}`, tokens.ownerA);
    expect(res.status).toBe(200);
    // A zero variance would claim the shelves agree with the recipes.
    expect(JSON.stringify(res.body.totals ?? {})).not.toMatch(/"unexplained":\s*0/);
    expect(res.body.caveats?.join(' ') ?? res.body.note ?? '').toMatch(/count|recipe|not/i);
  });

  it('the catalog states what each family can answer and why', async () => {
    const res = await get('/api/reporting/catalog', tokens.ownerA);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.reports.map((r) => [r.key, r]));
    expect(byKey.sales.state).toBe('AVAILABLE');
    expect(byKey.wastage.buildable).toBe(false);
    expect(byKey.wastage.note).toBeTruthy();
    expect(res.body.formats).toEqual(['csv', 'xlsx', 'pdf', 'json']);
  });
});

describe('reporting api: the company decides its own boundaries', () => {
  it('serves documented defaults before anybody has configured anything', async () => {
    const res = await get('/api/reporting/settings', tokens.ownerA);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.timezone).toBe('Asia/Kolkata');
    expect(res.body.defaults).toBeTruthy();
  });

  it('refuses a timezone ICU cannot resolve rather than falling back silently', async () => {
    const res = await request(app)
      .patch('/api/reporting/settings')
      .set(auth(tokens.ownerA))
      .send({ timezone: 'Mars/Olympus_Mons' });
    expect(res.status).toBe(400);
    const after = await get('/api/reporting/settings', tokens.ownerA);
    expect(after.body.timezone).toBe('Asia/Kolkata');
  });

  it('applies a business-day cutoff to the period every report resolves', async () => {
    const saved = await request(app)
      .patch('/api/reporting/settings')
      .set(auth(tokens.ownerA))
      // 0 is Sunday. The engine indexes weekdays the way getUTCDay does, and the
      // route must validate in the same numbering — when it accepted 1..7 the
      // patch was taken and the value silently stored as Monday.
      .send({ businessDayCutoffMinutes: 300, weekStartDay: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.businessDayCutoffMinutes).toBe(300);
    expect(saved.body.weekStartDay).toBe(0);

    const report = await get(`/api/reporting/reports/sales?${YESTERDAY}`, tokens.ownerA);
    expect(report.body.period.businessDayCutoffMinutes).toBe(300);
    expect(report.body.period.weekStartDay).toBe(0);
    // And the export says so too, because a spreadsheet outlives the screen.
    const csv = await request(app)
      .get(`/api/reporting/reports/sales/export?${YESTERDAY}&format=csv`)
      .set(auth(tokens.ownerA));
    expect(csv.text).toContain('Business day starts,05:00');
  });

  it('audits a change that re-cuts every past report', async () => {
    const row = await prisma.posAuditLog.findFirst({
      where: { action: 'reporting.settings.update', companyId: companyA.id },
      orderBy: { at: 'desc' },
    });
    expect(row).toBeTruthy();
    expect(row.meta.before.businessDayCutoffMinutes).toBe(0);
    expect(row.meta.after.businessDayCutoffMinutes).toBe(300);
  });

  it('one company’s policy does not move another company’s boundaries', async () => {
    const res = await get('/api/reporting/settings', tokens.ownerB);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.businessDayCutoffMinutes).toBe(0);
  });

  it('a partial period is labelled partial and compared against the same elapsed time', async () => {
    const res = await get('/api/reporting/reports/sales?preset=TODAY', tokens.ownerA);
    expect(res.status).toBe(200);
    expect(res.body.period.partial).toBe(true);
    expect(res.body.comparison?.basis).toBe('SAME_ELAPSED');
    expect(res.body.comparison?.note).toMatch(/same elapsed/i);
  });

  it('rejects a custom period whose end precedes its start', async () => {
    const res = await get(
      '/api/reporting/reports/sales?preset=CUSTOM&from=2026-09-10&to=2026-09-01',
      tokens.ownerA,
    );
    expect(res.status).toBe(400);
  });
});
