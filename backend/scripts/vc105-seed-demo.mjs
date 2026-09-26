// VC-105 — deterministic synthetic dataset for UI and browser QA.
//
// This is the "versioned backend snapshot" W2 integrates against. It is a
// script rather than a dump so the snapshot is versioned by git like
// everything else, and so W2 seeds their OWN database rather than pointing at
// a peer's changing one.
//
// SYNTHETIC. Every price, quantity and cost below is invented for layout and
// QA. None of it is real trading data, and a passing browser test against it
// says nothing about live figures.
//
// Refuses to run unless the target database name contains "vc105" and
// NODE_ENV is not production, so it cannot seed a peer or a real database.
//
//   DATABASE_URL='postgresql://…/vcx_vc105_ui_test?schema=public' \
//   POS_SEED_PASSWORD='<your own>' node scripts/vc105-seed-demo.mjs

const dbUrl = process.env.DATABASE_URL || '';
if (process.env.NODE_ENV === 'production' || !/\/[a-z0-9_]*vc105[a-z0-9_]*(\?|$)/i.test(dbUrl)) {
  console.error('Refusing: point DATABASE_URL at a database whose name contains "vc105", and not in production.');
  process.exit(2);
}

const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

// The operator supplies the password; it is never printed and never committed.
const PW = process.env.POS_SEED_PASSWORD;
if (!PW || PW.length < 8) {
  console.error('Refusing: set POS_SEED_PASSWORD (8+ chars). It is not printed or stored in plain text.');
  process.exit(2);
}

const D = (paise) => paise / 100;
const at = (iso) => new Date(iso);

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
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

await wipe();

const passwordHash = await hashPassword(PW);
const company = await prisma.company.create({
  data: {
    name: 'VC105 Demo Cafe',
    slug: 'vc105-demo',
    licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 5, expiresAt: at('2027-12-31T00:00:00Z') } },
  },
});
const central = await prisma.branch.create({ data: { companyId: company.id, name: 'Central', code: 'CEN' } });
const airport = await prisma.branch.create({ data: { companyId: company.id, name: 'Airport', code: 'AIR' } });

const owner = await prisma.posUser.create({
  data: { passwordHash, email: 'owner@vc105.demo.local', fullName: 'Demo Owner', role: 'CUSTOMER_OWNER', companyId: company.id },
});
await prisma.posUser.create({
  data: { passwordHash, email: 'manager.central@vc105.demo.local', fullName: 'Central Manager', role: 'BRANCH_MANAGER', companyId: company.id, branchId: central.id },
});
await prisma.posUser.create({
  data: { passwordHash, email: 'cashier@vc105.demo.local', fullName: 'Demo Cashier', role: 'CASHIER', companyId: company.id, branchId: central.id },
});

const cat = await prisma.category.create({ data: { companyId: company.id, name: 'Drinks & Plates' } });
const mkProduct = (name, sku, pricePaise) =>
  prisma.product.create({ data: { companyId: company.id, categoryId: cat.id, name, sku, basePrice: D(pricePaise) } });

// Prices chosen so every cost-coverage state is visible in the UI at once.
const coffee = await mkProduct('Filter Coffee', 'SKU-COFFEE', 5000); // cost 810  -> high margin
const latte = await mkProduct('Latte', 'SKU-LATTE', 12000); // cost 1800 -> star
const special = await mkProduct('Seasonal Special', 'SKU-ESTIMATED', 8000); // ESTIMATED cost 5000
const oldie = await mkProduct('Old Favourite', 'SKU-STALE', 6000); // STALE cost 2000
const mystery = await mkProduct('Mystery Box', 'SKU-NOCOST', 20000); // no fixture entry -> MISSING
const loss = await mkProduct('Loss Leader', 'SKU-LOSS', 1000); // cost 2500 on a 1000 price -> negative margin

// Bills an order the way computeOrderTotals would have written it. Order-level
// discount is allocated across lines by largest remainder, exactly as the
// money engine does, so the seeded rows are shaped like real bills.
const bill = async ({ branch, type, billedAt, lines, discountPaise = 0, refundPaise = 0 }) => {
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const weights = lines.map((l) => l.unitPrice * l.qty);
  const sumW = weights.reduce((a, w) => a + w, 0);
  let assigned = 0;
  const shares = weights.map((w) => {
    const s = sumW > 0 ? Math.floor((discountPaise * w) / sumW) : 0;
    assigned += s;
    return s;
  });
  for (let i = 0; assigned < discountPaise; i += 1, assigned += 1) shares[i % shares.length] += 1;

  const total = subtotal - discountPaise; // tax-exclusive demo data: no tax rate configured
  const order = await prisma.order.create({
    data: {
      companyId: company.id,
      branchId: branch.id,
      type,
      status: refundPaise > 0 ? 'REFUNDED' : 'PAID',
      openedById: owner.id,
      billedAt,
      closedAt: billedAt,
      discountAmount: D(discountPaise),
      subtotal: D(subtotal),
      taxAmount: 0,
      total: D(total),
      items: {
        create: lines.map((l, i) => ({
          productId: l.product.id,
          name: l.product.name,
          qty: l.qty,
          unitPrice: D(l.unitPrice),
          lineDiscount: 0,
          lineSubtotal: D(l.unitPrice * l.qty),
          discountShare: D(shares[i]),
          lineTax: 0,
          lineTotal: D(l.unitPrice * l.qty - shares[i]),
          status: 'ACTIVE',
        })),
      },
    },
  });
  await prisma.payment.create({
    data: { orderId: order.id, amount: D(total - refundPaise), method: 'CASH', channel: 'MANUAL', receivedById: owner.id, createdAt: billedAt },
  });
  if (refundPaise > 0) {
    await prisma.refund.create({
      data: { orderId: order.id, amount: D(refundPaise), reason: 'QA: partial refund', status: 'SUCCEEDED', byId: owner.id, createdAt: billedAt },
    });
  }
  return order;
};

const L = (product, qty, unitPrice) => ({ product, qty, unitPrice });

// 2026-09-10 — Central, dine-in, clean volume.
await bill({ branch: central, type: 'DINE_IN', billedAt: at('2026-09-10T06:30:00Z'), lines: [L(coffee, 10, 5000), L(latte, 4, 12000)] });
// 2026-09-11 — Central, dine-in, ₹200 order discount across two lines.
await bill({ branch: central, type: 'DINE_IN', billedAt: at('2026-09-11T07:00:00Z'), lines: [L(coffee, 6, 5000), L(special, 2, 8000)], discountPaise: 20000 });
// 2026-09-12 — Central, dine-in, partial refund of ₹120.
await bill({ branch: central, type: 'DINE_IN', billedAt: at('2026-09-12T07:00:00Z'), lines: [L(latte, 3, 12000)], refundPaise: 12000 });
// 2026-09-13 — Airport, takeaway, the uncosted product and a stale-cost one.
await bill({ branch: airport, type: 'TAKEAWAY', billedAt: at('2026-09-13T05:30:00Z'), lines: [L(mystery, 2, 20000), L(oldie, 5, 6000)] });
// 2026-09-14 — Airport, takeaway, full refund: net sales must fall to zero.
await bill({ branch: airport, type: 'TAKEAWAY', billedAt: at('2026-09-14T05:30:00Z'), lines: [L(coffee, 2, 5000)], refundPaise: 10000 });
// 2026-09-15 — deliberately no trade, so an empty day is testable.
// 2026-09-16 — Airport, dine-in, a low-margin heavy seller for PLOUGHHORSE.
await bill({ branch: airport, type: 'DINE_IN', billedAt: at('2026-09-16T06:00:00Z'), lines: [L(special, 12, 8000), L(loss, 3, 1000)] });

const orders = await prisma.order.count();
const items = await prisma.orderItem.count();
const refunds = await prisma.refund.count();

console.log(`
VC-105 synthetic demo seeded — SYNTHETIC DATA, NOT REAL TRADE.

  company    ${company.slug}
  branches   Central (${central.id}), Airport (${airport.id})
  orders     ${orders}   items ${items}   refunds ${refunds}
  period     2026-09-10 .. 2026-09-16 IST (2026-09-15 has no trade, by design)
  logins     owner@vc105.demo.local / manager.central@… / cashier@…
             (password: the POS_SEED_PASSWORD you supplied — not printed)

Run the API with the synthetic cost provider to see margins:

  VC105_SYNTHETIC_COSTS=1 \\
  VC105_SYNTHETIC_COST_FILE=$PWD/tests/fixtures/vc105-synthetic-costs.json \\
  DATABASE_URL='<this database>' POS_JWT_SECRET='<32+ chars>' npm run dev

Expected cost coverage across the window: ACTUAL for Filter Coffee and Latte,
ESTIMATED for Seasonal Special, STALE for Old Favourite, MISSING for Mystery
Box. Mystery Box must show no margin at all — never a zero one.
`);

await prisma.$disconnect();
