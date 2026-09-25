// LANE reporting — synthetic multi-location dataset for browser and performance QA.
//
// SYNTHETIC. Every store, price, bill and payment below is invented. A passing
// walkthrough against this data says the screens work; it says nothing about any
// real company's figures.
//
// A script rather than a dump, so the dataset is versioned by git and so anybody
// verifying this lane seeds their OWN database instead of pointing at a changing
// one. It refuses to run unless the database name contains "reporting" and
// NODE_ENV is not production, so it cannot reach a shared or live database.
//
//   DATABASE_URL='postgresql://…/atc_pos_reporting_demo?schema=public' \
//   POS_SEED_PASSWORD='<your own>' node scripts/reporting-seed-demo.mjs
//
// WHAT IT IS SHAPED TO PROVE — each of these is a claim the dashboard makes that
// would otherwise be untestable, and every one of them is a state that a
// single-store, single-day fixture cannot produce:
//
//   * six stores, two regions, two brands, two legal entities and two GSTINs, so
//     every filter has more than one option and a scope bug has somewhere to show
//   * one store that has NEVER traded and one that stopped weeks ago — the
//     difference between "no activity", "never reported" and "stale"
//   * one demo store with real-looking takings, so leaving it out of the company
//     total is visible and including it changes the number
//   * BILLED part-paid bills, so dues are non-zero and "collected" is legitimately
//     below "invoiced" rather than looking like a bug
//   * tax on every bill, so net sales and invoiced differ by the GST
//   * VOID and OPEN orders, which must not become revenue
//   * a PENDING gateway refund, which is money not yet returned to anybody
//   * trade today, yesterday, this week, last week, this month and last month, so
//     every preset answers something and the comparison has a previous period
//
// Dates are computed from the clock, not hardcoded. A fixture pinned to fixed
// dates makes "Today" permanently empty, and a screenshot of an empty Today
// proves nothing about the screen that owners look at most.

const dbUrl = process.env.DATABASE_URL || '';
if (process.env.NODE_ENV === 'production' || !/\/[a-z0-9_]*reporting[a-z0-9_]*(\?|$)/i.test(dbUrl)) {
  console.error('Refusing: point DATABASE_URL at a database whose name contains "reporting", and not in production.');
  process.exit(2);
}

const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const PW = process.env.POS_SEED_PASSWORD;
if (!PW || PW.length < 8) {
  console.error('Refusing: set POS_SEED_PASSWORD (8+ chars). It is not printed or stored in plain text.');
  process.exit(2);
}

// Volume knob for the §8 performance measurement. The default is the amount a
// person can read on a screen and check by hand; a larger number is for timing,
// not for reading.
const BILLS_PER_DAY = Number(process.env.REPORTING_SEED_BILLS_PER_DAY || 4);
const DAYS = Number(process.env.REPORTING_SEED_DAYS || 70);

const D = (paise) => paise / 100;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Midnight IST of "days ago", expressed in UTC — which is what the database
// stores and what the reporting engine converts back. Doing this arithmetic here
// rather than writing local-looking strings is the only way the seeded boundary
// and the engine's boundary are the same instant.
const istMidnightUtc = (daysAgo) => {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const y = nowIst.getUTCFullYear();
  const m = nowIst.getUTCMonth();
  const d = nowIst.getUTCDate() - daysAgo;
  return new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
};

// Today is only partly over. A bill asked for at 21:00 while the clock reads
// 01:24 is in the FUTURE, so it lands in no window and no report — which is how a
// fixture that computes its dates from the clock can still leave Today empty, the
// exact thing the header above claims it avoids. Times that have already happened
// are used exactly as asked; times that have not are folded back into the part of
// the day that has, in the same order. Past days are never touched, and neither is
// a deliberately future date such as a licence expiry.
const at = (daysAgo, istHour, istMinute = 0) => {
  const midnight = istMidnightUtc(daysAgo).getTime();
  const minuteOfDay = istHour * 60 + istMinute;
  const when = midnight + minuteOfDay * 60000;
  if (daysAgo !== 0 || when <= Date.now() - 60000) return new Date(when);
  const elapsed = Math.max(2, Math.floor((Date.now() - midnight) / 60000) - 1);
  return new Date(midnight + Math.round((minuteOfDay / 1440) * elapsed) * 60000);
};

const wipe = async () => {
  // Reporting's own rows first: a schedule holds recipients and deliveries, and a
  // recipient is deliberately onDelete: Restrict so revoking an address cannot
  // quietly orphan the schedules that mailed it.
  await prisma.reportDelivery.deleteMany();
  await prisma.reportScheduleRecipient.deleteMany();
  await prisma.reportSchedule.deleteMany();
  await prisma.reportRecipient.deleteMany();
  await prisma.reportingException.deleteMany();
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  // Before orderItem and kot, both of which a kitchen line points at. The FKs
  // cascade, so the order only matters for the error message somebody gets when
  // one of these tables acquires a restricting reference later.
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.kitchenCursor.deleteMany();
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
  await prisma.userStoreAssignment.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.reportingSetting.deleteMany();
  await prisma.branchBrand.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.gstRegistration.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.region.deleteMany();
  await prisma.company.deleteMany();
};

await wipe();

const passwordHash = await hashPassword(PW);

const company = await prisma.company.create({
  data: {
    name: 'Brew Street Group (Reporting Demo)',
    slug: 'reporting-demo',
    licenses: {
      create: { plan: 'MULTI_STORE', baseBranchLimit: 10, expiresAt: at(-400, 0) },
    },
  },
});
const companyId = company.id;

const north = await prisma.region.create({ data: { companyId, name: 'North', code: 'NORTH' } });
const west = await prisma.region.create({ data: { companyId, name: 'West', code: 'WEST' } });

const brewStreet = await prisma.brand.create({ data: { companyId, name: 'Brew Street', code: 'BS' } });
const tiffinCo = await prisma.brand.create({ data: { companyId, name: 'Tiffin Co', code: 'TC' } });

const entityDelhi = await prisma.legalEntity.create({
  data: {
    companyId,
    legalName: 'Brew Street Hospitality Private Limited',
    tradeName: 'Brew Street',
    pan: 'AABCB1234C',
  },
});
const entityMaha = await prisma.legalEntity.create({
  data: {
    companyId,
    legalName: 'Tiffin Co Foods LLP',
    tradeName: 'Tiffin Co',
    pan: 'AABFT5678D',
  },
});

const gstDelhi = await prisma.gstRegistration.create({
  data: {
    companyId,
    legalEntityId: entityDelhi.id,
    gstin: '07AABCB1234C1Z5',
    stateCode: '07',
    stateName: 'Delhi',
    city: 'New Delhi',
  },
});
const gstMaha = await prisma.gstRegistration.create({
  data: {
    companyId,
    legalEntityId: entityMaha.id,
    gstin: '27AABFT5678D1Z9',
    stateCode: '27',
    stateName: 'Maharashtra',
    city: 'Mumbai',
  },
});

// publicId is pinned by a CHECK constraint to VC-XX-NNNN, so it is supplied
// rather than left to a default that would not satisfy it.
let publicSeq = 1000;
const store = (data) =>
  prisma.branch.create({
    data: { companyId, publicId: `VC-RD-${(publicSeq += 1)}`, ...data },
  });

const cp = await store({
  name: 'Connaught Place', code: 'BS-CP', city: 'New Delhi', state: 'Delhi',
  regionId: north.id, legalEntityId: entityDelhi.id, gstRegistrationId: gstDelhi.id,
});
const cyberHub = await store({
  name: 'Cyber Hub', code: 'BS-CH', city: 'Gurugram', state: 'Haryana',
  regionId: north.id, legalEntityId: entityDelhi.id, gstRegistrationId: gstDelhi.id,
});
const bandra = await store({
  name: 'Bandra West', code: 'TC-BW', city: 'Mumbai', state: 'Maharashtra',
  regionId: west.id, legalEntityId: entityMaha.id, gstRegistrationId: gstMaha.id,
});
const lowerParel = await store({
  name: 'Lower Parel', code: 'TC-LP', city: 'Mumbai', state: 'Maharashtra',
  regionId: west.id, legalEntityId: entityMaha.id, gstRegistrationId: gstMaha.id,
});
// Opened, licensed, never sold anything. Its row must say "never reported", not
// report a zero day like a shop that simply had none.
const newTown = await store({
  name: 'New Town (opening soon)', code: 'BS-NT', city: 'Kolkata', state: 'West Bengal',
  regionId: north.id, legalEntityId: entityDelhi.id, gstRegistrationId: gstDelhi.id,
});
const demoStore = await store({
  name: 'Training Kitchen (demo)', code: 'BS-TR', city: 'New Delhi', state: 'Delhi',
  isDemo: true, regionId: north.id, legalEntityId: entityDelhi.id, gstRegistrationId: gstDelhi.id,
});

for (const [branchId, brandId] of [
  [cp.id, brewStreet.id],
  [cyberHub.id, brewStreet.id],
  [demoStore.id, brewStreet.id],
  [newTown.id, brewStreet.id],
  [bandra.id, tiffinCo.id],
  [lowerParel.id, tiffinCo.id],
]) {
  await prisma.branchBrand.create({ data: { branchId, brandId, companyId } });
}

const user = (email, fullName, role, extra = {}) =>
  prisma.posUser.create({ data: { passwordHash, email, fullName, role, companyId, ...extra } });

// One account per authority the reporting gate distinguishes. The point of
// seeding all six is that the tenant/store isolation claims in §8 are checked by
// signing in as each of them, not by reasoning about the middleware.
const owner = await user('owner@reporting.demo.local', 'Priya Owner', 'CUSTOMER_OWNER');
await user('finance@reporting.demo.local', 'Farhan Finance', 'FINANCE');
await user('regional.north@reporting.demo.local', 'Rhea Regional (North)', 'REGIONAL_MANAGER', {
  regionId: north.id,
});
const cpManager = await user('manager.cp@reporting.demo.local', 'Manoj Manager (CP)', 'BRANCH_MANAGER', {
  branchId: cp.id,
});
await user('auditor@reporting.demo.local', 'Anita Auditor', 'AUDITOR');
await user('cashier.cp@reporting.demo.local', 'Kiran Cashier (CP)', 'CASHIER', { branchId: cp.id });

const gst5 = await prisma.taxRate.create({
  data: { companyId, name: 'GST 5%', ratePercent: 5 },
});

const cat = await prisma.category.create({ data: { companyId, name: 'Coffee & Plates' } });
const mkProduct = (name, sku, pricePaise) =>
  prisma.product.create({
    data: { companyId, categoryId: cat.id, name, sku, basePrice: D(pricePaise), taxRateId: gst5.id },
  });

const menu = [
  await mkProduct('Filter Coffee', 'RD-FILTER', 12000),
  await mkProduct('Cappuccino', 'RD-CAPP', 18000),
  await mkProduct('Cold Brew', 'RD-COLD', 24000),
  await mkProduct('Veg Club Sandwich', 'RD-SANDWICH', 24000),
  await mkProduct('Masala Fries', 'RD-FRIES', 14000),
  await mkProduct('Blueberry Cheesecake', 'RD-CAKE', 28000),
];

// Deterministic pseudo-random, so two runs of the same knobs produce the same
// dataset. Math.random would make a variance somebody is investigating vanish on
// the next seed.
let seed = 20260924;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const TAX_RATE = 0.05;

/**
 * Write one bill the way computeOrderTotals would have written it.
 *
 * `status` and `paidPaise` are separate on purpose: a BILLED order with a part
 * payment is the case that makes dues real, and it is exactly the case that used
 * to make "collected" exceed "sold".
 */
const bill = async ({
  branch, billedAt, status = 'PAID', lines, orderDiscountPaise = 0,
  paidFraction = 1, method = 'CASH', channel = 'MANUAL', paidAt = null,
  refundPaise = 0, refundStatus = 'SUCCEEDED', refundChannel = 'MANUAL',
  // Only the bills an exception names get one. A worklist row reading "A bill
  // discounted ₹1,200" cannot be looked up by the person expected to explain it,
  // and the ordinary trade below has no reason to carry a number nobody quotes.
  invoiceNumber = null, refundReason = 'Synthetic QA refund',
}) => {
  const lineSubtotals = lines.map((l) => l.unitPrice * l.qty);
  const subtotal = lineSubtotals.reduce((a, v) => a + v, 0);
  const sumW = subtotal;
  let assigned = 0;
  const shares = lineSubtotals.map((w) => {
    const s = sumW > 0 ? Math.floor((orderDiscountPaise * w) / sumW) : 0;
    assigned += s;
    return s;
  });
  for (let i = 0; assigned < orderDiscountPaise; i += 1, assigned += 1) shares[i % shares.length] += 1;

  const taxable = subtotal - orderDiscountPaise;
  const tax = Math.round(taxable * TAX_RATE);
  const total = taxable + tax;

  const order = await prisma.order.create({
    data: {
      companyId,
      branchId: branch.id,
      // DINE_IN and TAKEAWAY are the whole of OrderType. There is no delivery
      // order type in this schema, which is why a delivery-channel report has
      // nothing to read and the capability layer calls it unavailable rather
      // than showing it as nil sales.
      type: pick(['DINE_IN', 'TAKEAWAY']),
      status,
      openedById: owner.id,
      billedAt: status === 'OPEN' ? null : billedAt,
      // A void closes the bill at the moment it is voided. The model records the
      // act with voidedById and voidReason and has no separate voidedAt, so
      // closedAt is when it stopped being an open bill.
      closedAt:
        status === 'PAID' || status === 'REFUNDED' || status === 'VOID'
          ? (paidAt ?? billedAt)
          : null,
      voidedById: status === 'VOID' ? cpManager.id : null,
      voidReason: status === 'VOID' ? 'Customer left before ordering' : null,
      createdAt: billedAt,
      invoiceNumber,
      discountAmount: D(orderDiscountPaise),
      subtotal: D(subtotal),
      taxAmount: D(tax),
      total: D(total),
      items: {
        create: lines.map((l, i) => ({
          productId: l.product.id,
          name: l.product.name,
          qty: l.qty,
          unitPrice: D(l.unitPrice),
          lineDiscount: D(l.lineDiscount ?? 0),
          lineSubtotal: D(lineSubtotals[i] - (l.lineDiscount ?? 0)),
          discountShare: D(shares[i]),
          lineTax: D(Math.round((lineSubtotals[i] - shares[i]) * TAX_RATE)),
          lineTotal: D(lineSubtotals[i] - shares[i]),
          status: 'ACTIVE',
        })),
      },
    },
  });

  // VOID and OPEN orders have taken no money. Writing a payment for them would
  // be the exact defect the reports exist to make visible.
  const paid = status === 'VOID' || status === 'OPEN' ? 0 : Math.round(total * paidFraction);
  if (paid > 0) {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        branchId: branch.id,
        amount: D(paid),
        method,
        channel,
        receivedById: owner.id,
        // Money dates on its own clock. A bill raised yesterday and settled today
        // belongs to both days, in different reports.
        createdAt: paidAt ?? billedAt,
      },
    });
  }
  if (refundPaise > 0) {
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: D(refundPaise),
        reason: refundReason,
        status: refundStatus,
        channel: refundChannel,
        method,
        byId: cpManager.id,
        createdAt: paidAt ?? billedAt,
      },
    });
  }
  return order;
};

const L = (product, qty) => ({ product, qty, unitPrice: Number(product.basePrice) * 100 });
const randomLines = () => {
  const n = between(1, 3);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(L(pick(menu), between(1, 6)));
  return out;
};

// --- the ordinary trade ------------------------------------------------------
//
// Four stores trading every day for DAYS days. Bandra is excluded from the
// recent half of the window so it goes quiet: its coverage must read stale or no
// activity rather than simply showing small numbers.
const TRADING = [cp, cyberHub, lowerParel];
let written = 0;
for (let d = DAYS - 1; d >= 0; d -= 1) {
  const stores = d > 21 ? [...TRADING, bandra] : TRADING;
  for (const s of stores) {
    for (let i = 0; i < BILLS_PER_DAY; i += 1) {
      const hour = between(8, 22);
      // One bill in twelve is left part-paid and BILLED, so dues accumulate
      // across the window the way a real estate's receivables do.
      const roll = rnd();
      if (roll < 0.08) {
        await bill({
          branch: s, billedAt: at(d, hour, between(0, 59)), status: 'BILLED',
          lines: randomLines(), paidFraction: 0.4, method: 'CASH',
        });
      } else if (roll < 0.14) {
        await bill({
          branch: s, billedAt: at(d, hour, between(0, 59)), status: 'REFUNDED',
          lines: randomLines(), refundPaise: between(5000, 20000),
        });
      } else if (roll < 0.17) {
        await bill({ branch: s, billedAt: at(d, hour, between(0, 59)), status: 'VOID', lines: randomLines() });
      } else {
        await bill({
          branch: s,
          billedAt: at(d, hour, between(0, 59)),
          lines: randomLines(),
          orderDiscountPaise: roll < 0.3 ? between(2000, 8000) : 0,
          method: pick(['CASH', 'UPI', 'CARD']),
          channel: roll < 0.24 ? 'GATEWAY' : 'MANUAL',
        });
      }
      written += 1;
    }
  }
}

// --- the deliberate edge cases ----------------------------------------------

// A table still eating. Open orders are not revenue and must appear as open.
await bill({ branch: cp, billedAt: at(0, 21, 30), status: 'OPEN', lines: [L(menu[0], 2), L(menu[4], 1)] });

// Invoiced yesterday, settled today. The bill belongs to yesterday's sales and
// the money to today's collections — the single clearest case for why the two
// reports cannot be the same number.
await bill({
  branch: cyberHub, billedAt: at(1, 22, 15), status: 'PAID',
  lines: [L(menu[2], 4), L(menu[5], 2)], method: 'UPI', channel: 'GATEWAY',
  paidAt: at(0, 9, 45),
});

// The same split, but landing entirely inside days that are over: invoiced the
// day before yesterday, settled yesterday. The pair above only separates sales
// from collections once enough of today has elapsed to hold the payment, so a run
// just after midnight would find them equal and conclude, wrongly, that the two
// reports are the same figure. This one holds at any hour.
await bill({
  branch: lowerParel, billedAt: at(2, 21, 50), status: 'PAID',
  lines: [L(menu[2], 5), L(menu[5], 3)], method: 'CARD', channel: 'GATEWAY',
  paidAt: at(1, 10, 20),
});

// A refund the provider has accepted but not yet paid out. It is money that has
// returned to nobody, so it must be held apart from refunds that have.
await bill({
  branch: lowerParel, billedAt: at(2, 13, 10), status: 'REFUNDED',
  lines: [L(menu[3], 3)], method: 'UPI', channel: 'GATEWAY',
  refundPaise: 30000, refundStatus: 'PENDING', refundChannel: 'GATEWAY',
});

// An after-midnight bill: 00:40 IST today, which belongs to yesterday's trading
// day once the business-day cutoff is moved past it. Nothing else in the dataset
// changes when the cutoff moves, so this row is the boundary test.
await bill({
  branch: cp, billedAt: at(0, 0, 40), status: 'PAID',
  lines: [L(menu[1], 3), L(menu[4], 2)], method: 'CASH',
});

// The demo store trades properly. Excluded from the company total by default —
// and the number visibly changes when somebody ticks "include demo stores",
// which is the only way that switch means anything.
for (let d = 6; d >= 0; d -= 1) {
  await bill({ branch: demoStore, billedAt: at(d, 11, 30), lines: [L(menu[0], 4), L(menu[3], 2)] });
}

// --- cash counts -------------------------------------------------------------
//
// Every finished day at every trading store, less a few deliberate gaps. Closing
// only three days out of seventy would be truthful about this fixture and useless
// as a demonstration: the unclosed-shift detector would raise seventy-odd
// identical findings and bury every other kind under them, which is a statement
// about the seed rather than about the estate.
//
// So the habit here is a normal one — drawers counted, most days balancing, three
// that did not, and three days missed. The gaps are chosen, not left over.
//
// The figures follow POST /reports/day-close exactly. It is worth being precise
// about the one that is easy to get wrong: expectedCashPaise EXCLUDES the opening
// float, the counted figure INCLUDES it, and variance = counted − float −
// expected. Writing the float into `expected` as well leaves a row whose stored
// variance disagrees with its own columns by exactly the float — a bill of a shape
// the POS cannot produce, and a fixture like that measures the seed's arithmetic
// instead of the report's.
const { refundLeavesDrawer } = await import('../src/lib/orders.js');

// Deliberate gaps: the days nobody counted. One per store, and a fourth at CP so
// two consecutive days are missing at one store, which is what the detector is
// actually for.
const MISSED = new Set([`${cp.id}:4`, `${cp.id}:5`, `${cyberHub.id}:9`, `${lowerParel.id}:12`]);
// The days that did not balance, and what the manager wrote at the time. A
// variance without a note is refused by the route, so a seeded one must carry the
// explanation too, or the worklist shows "unexplained" where the POS would have
// insisted.
const VARIANCES = new Map([
  [`${cp.id}:2`, { paise: -45000, note: 'Short ₹450. Two card bills were rung as cash and the difference was not found.' }],
  [`${cyberHub.id}:2`, { paise: 12000, note: 'Over ₹120. A customer refused change and it was left in the drawer.' }],
  [`${lowerParel.id}:6`, { paise: -2500, note: 'Short ₹25 — a miscount of coins, written off.' }],
]);

let closingsWritten = 0;
// Bandra is included even though it stopped trading three weeks ago. The guard
// below skips the days it took nothing, so it gets closings up to the day it went
// quiet and none after — which keeps "this store has gone silent" as one finding
// rather than that plus forty-eight unclosed days saying the same thing again.
for (const branch of [...TRADING, bandra]) {
  // From yesterday backwards. Today is still being traded and its absent closing
  // is the evening, not an exception — the detector agrees, and closing today
  // would make the cash report claim a day had ended that has not.
  for (let d = 1; d < DAYS; d += 1) {
    if (MISSED.has(`${branch.id}:${d}`)) continue;
    const dayStart = istMidnightUtc(d);
    const dayEnd = istMidnightUtc(d - 1);
    const window = { gte: dayStart, lt: dayEnd };

    const [payments, refunds, ordersBilled] = await Promise.all([
      prisma.payment.findMany({
        where: { createdAt: window, order: { companyId, branchId: branch.id } },
        select: { amount: true, method: true, channel: true },
      }),
      // SUCCEEDED only, as the route does: a refund the provider has not paid out
      // has not left the drawer, and subtracting it would manufacture a shortfall
      // somebody would then be asked to explain.
      prisma.refund.findMany({
        where: { createdAt: window, status: 'SUCCEEDED', order: { companyId, branchId: branch.id } },
        select: { amount: true, channel: true, method: true },
      }),
      prisma.order.count({ where: { companyId, branchId: branch.id, billedAt: window } }),
    ]);
    if (!payments.length && !ordersBilled) continue;

    const tills = { cash: 0, card: 0, upi: 0, other: 0, gateway: 0 };
    for (const p of payments) {
      const amount = Math.round(Number(p.amount) * 100);
      // Channel before method: a GATEWAY payment with method CARD never touched
      // this drawer.
      if (p.channel === 'GATEWAY') tills.gateway += amount;
      else if (p.method === 'CASH') tills.cash += amount;
      else if (p.method === 'CARD') tills.card += amount;
      else if (p.method === 'UPI') tills.upi += amount;
      else tills.other += amount;
    }
    let cashRefunds = 0;
    for (const r of refunds) if (refundLeavesDrawer(r)) cashRefunds += Math.round(Number(r.amount) * 100);

    const v = VARIANCES.get(`${branch.id}:${d}`);
    const variancePaise = v?.paise ?? 0;
    const float = 200000;
    const expected = tills.cash - cashRefunds;
    await prisma.dayClose.create({
      data: {
        companyId,
        branchId: branch.id,
        businessDate: new Date(dayStart.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10),
        closedById: cpManager.id,
        openingFloatPaise: float,
        cashSalesPaise: tills.cash,
        cashRefundsPaise: cashRefunds,
        cardSalesPaise: tills.card,
        upiSalesPaise: tills.upi,
        otherSalesPaise: tills.other,
        gatewaySalesPaise: tills.gateway,
        expectedCashPaise: expected,
        countedCashPaise: float + expected + variancePaise,
        variancePaise,
        note: v?.note ?? null,
        // Counted after the shift, not at midnight — which is also what makes the
        // 24-hour clock on a cash-difference exception land where it should.
        closedAt: at(d - 1, 0, 45),
        ordersBilled,
      },
    });
    closingsWritten += 1;
  }
}

// --- things somebody has to act on ------------------------------------------
//
// The ordinary trade above raises three of the six runnable detectors — a short
// drawer, a long drawer, unclosed days and one store that went quiet. It raises
// none of the other three, because its refunds are ₹50–₹200 and its discounts
// ₹20–₹80, both well under the thresholds, and it sends nothing to a kitchen.
//
// A walkthrough against that data would show "0 found" beside those three, which
// is honest but proves nothing: a detector that has never returned a row and a
// detector that is broken produce the same screen. Each of the following exists to
// make one detector return something, and they are dated TODAY so the default
// preset has findings rather than an empty list an owner has to go looking for.
//
// Each pair straddles a threshold on purpose. The one under it must NOT appear,
// and a fixture with only the loud case cannot tell a working threshold from one
// that fires on everything.

// UNUSUAL_REFUND — the threshold is ₹2,000, critical at ₹5,000.
await bill({
  branch: cp, billedAt: at(0, 12, 20), status: 'REFUNDED',
  lines: [L(menu[5], 9), L(menu[2], 4)], method: 'CARD', channel: 'GATEWAY',
  invoiceNumber: 'CP-2041',
  refundPaise: 240000, refundReason: 'Whole table returned — order sent to the wrong party',
});
// ₹1,800: under it, and must stay off the worklist.
await bill({
  branch: cyberHub, billedAt: at(0, 13, 5), status: 'REFUNDED',
  lines: [L(menu[5], 8)], method: 'UPI', channel: 'GATEWAY',
  invoiceNumber: 'GH-1188', refundPaise: 180000, refundReason: 'Cake collected damaged',
});

// UNUSUAL_DISCOUNT — over the 40% rate and under the ₹1,000 value, so WARNING.
await bill({
  branch: cp, billedAt: at(0, 14, 40),
  lines: [L(menu[2], 2)], orderDiscountPaise: 30000,
  invoiceNumber: 'CP-2042', method: 'CASH',
});
// Over both, so CRITICAL: a staff party billed at a little over half price.
await bill({
  branch: lowerParel, billedAt: at(0, 15, 10),
  lines: [L(menu[5], 10)], orderDiscountPaise: 120000,
  invoiceNumber: 'LP-0907', method: 'UPI',
});
// 25% of ₹1,440 — a legitimate promotion, over neither threshold.
await bill({
  branch: cyberHub, billedAt: at(0, 16, 20),
  lines: [L(menu[1], 8)], orderDiscountPaise: 36000,
  invoiceNumber: 'GH-1189', method: 'CARD',
});

// DELAYED_KITCHEN_ORDER — the factor is 2×, and an item never marked ready is
// CRITICAL because somebody may still be at the table waiting for it.
const hotPass = await prisma.kitchenStation.create({
  data: {
    companyId, branchId: cp.id, name: 'Hot pass',
    targetPrepSeconds: 600, defaultForBranch: cp.id,
  },
});
const kotOrder = await bill({
  branch: cp, billedAt: at(0, 19, 5),
  lines: [L(menu[3], 1), L(menu[4], 1), L(menu[1], 1)],
  invoiceNumber: 'CP-2043', method: 'CASH',
});
const kot = await prisma.kot.create({ data: { orderId: kotOrder.id, seq: 1 } });
const queuedAt = at(0, 19, 6);
// Keyed by the dish rather than by row order: all three lines are written in one
// statement and share a createdAt, so ordering by it would decide at random which
// one is the late ticket, and a fixture that shuffles its own claim between runs
// cannot be read from the screen it produced.
const kitchenShapes = [
  // Sandwich: 26 minutes against a 10 minute target, and it did go out.
  { product: menu[3], state: 'SERVED', readyAt: new Date(queuedAt.getTime() + 26 * 60000) },
  // Fries: still in the pass, never marked ready. Measured against the clock, so
  // CRITICAL — somebody may be sitting at the table now.
  { product: menu[4], state: 'IN_PREP', delayReason: 'Fryer down', delayedAt: at(0, 19, 25) },
  // Cappuccino: 7 minutes, inside the target, raised by nothing.
  { product: menu[1], state: 'SERVED', readyAt: new Date(queuedAt.getTime() + 7 * 60000) },
];
for (const [i, { product, ...shape }] of kitchenShapes.entries()) {
  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: kotOrder.id, name: product.name },
  });
  await prisma.kitchenItem.create({
    data: {
      companyId, branchId: cp.id, orderId: kotOrder.id, kotId: kot.id,
      orderItemId: line.id, stationId: hotPass.id,
      changeSeq: i + 1, targetSeconds: hotPass.targetPrepSeconds,
      queuedAt, lastActorId: cpManager.id, ...shape,
    },
  });
}
await prisma.kitchenCursor.create({ data: { branchId: cp.id, lastSeq: kitchenShapes.length } });
await prisma.orderItem.updateMany({ where: { orderId: kotOrder.id }, data: { kotId: kot.id } });

// --- scheduled reports -------------------------------------------------------
//
// Recipients first, because a schedule stores recipient ids and never free text:
// an address becomes sendable by a deliberate act, which is the difference between
// a report schedule and an open relay on a timer.
//
// Only the first is a test address. This build has no mail transport, so a run
// writes a spool artifact for test addresses and records the others as WITHHELD —
// and the demo needs both, or "sent to 1 of 2" is a sentence with nothing behind
// it. The owner address is present and NOT marked as test on purpose: a
// verification run must be seen declining to write to it.
const testRecipient = await prisma.reportRecipient.create({
  data: {
    companyId, email: 'reporting-qa@reporting.demo.local',
    label: 'Reporting QA spool (test address)',
    approvedById: owner.id, isTestAddress: true,
  },
});
const ownerRecipient = await prisma.reportRecipient.create({
  data: {
    companyId, email: 'owner@reporting.demo.local',
    label: 'Priya Owner', approvedById: owner.id, isTestAddress: false,
  },
});
// Approved once and withdrawn. A schedule pointed only at a revoked address is
// recorded SKIPPED with the reason rather than quietly sending nothing, and this
// row is what makes that path reachable in the browser.
await prisma.reportRecipient.create({
  data: {
    companyId, email: 'former.finance@reporting.demo.local',
    label: 'Left the company', approvedById: owner.id,
    revokedAt: at(5, 11, 0),
  },
});

const schedule = async ({ name, reportKey, cadence, format, sendAtMinutes, weekday, dayOfMonth, state, branchIds = [], recipients, activatedAt = null, lastRunAt = null }) => {
  const row = await prisma.reportSchedule.create({
    data: {
      companyId, name, reportKey, cadence, format, sendAtMinutes,
      weekday: weekday ?? null, dayOfMonth: dayOfMonth ?? null,
      branchIds, state, createdById: owner.id, activatedAt, lastRunAt,
      recipients: { create: recipients.map((r) => ({ recipientId: r.id })) },
    },
  });
  return row;
};

// ACTIVE, and pointed only at the test address — "Test delivery only to approved
// test/owner addresses. Do not activate real customer schedules." Nothing in this
// dataset is a real customer, but the shape of the rule is worth keeping: the
// schedule that can actually fire writes only to the spool.
const dailySales = await schedule({
  name: 'Daily sales — every store, 07:00',
  reportKey: 'sales', cadence: 'DAILY', format: 'CSV', sendAtMinutes: 7 * 60,
  state: 'ACTIVE', recipients: [testRecipient], activatedAt: at(9, 10, 0),
});
// PAUSED, and pinned to two stores, so the store-scope field has a visible value
// and pausing is visibly not the same as deleting.
await schedule({
  name: 'Weekly location comparison — North',
  reportKey: 'locationComparison', cadence: 'WEEKLY', format: 'XLSX',
  sendAtMinutes: 8 * 60, weekday: 1, state: 'PAUSED',
  branchIds: [cp.id, cyberHub.id], recipients: [testRecipient, ownerRecipient],
  activatedAt: at(30, 10, 0),
});
// DRAFT: configured and never sent to anybody. New schedules are born here, and a
// screen that hid the state would let somebody believe this one is running.
await schedule({
  name: 'Monthly tax summary (draft)',
  reportKey: 'tax', cadence: 'MONTHLY', format: 'PDF', sendAtMinutes: 9 * 60,
  dayOfMonth: 31, state: 'DRAFT', recipients: [ownerRecipient],
});

// ---- A SECOND TENANT, so a leak has something to leak ---------------------
//
// One store, one owner, distinctive takings. Without a second company in the
// database, "no cross-tenant leak" is a claim about an empty room: every query
// would return only company one's rows whether the tenant filter worked or not.
// Its figures are deliberately unlike the first company's, so a single wrong
// number in a consolidated total is recognisable rather than merely plausible.
const rival = await prisma.company.create({
  data: {
    name: 'Kettle & Co (Other Tenant)',
    slug: 'reporting-demo-rival',
    licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 2, expiresAt: at(-400, 0) } },
  },
});
const rivalStore = await prisma.branch.create({
  data: {
    companyId: rival.id,
    publicId: 'VC-RX-2001',
    name: 'Kettle & Co Indiranagar',
    code: 'KC-IN',
    city: 'Bengaluru',
    state: 'Karnataka',
  },
});
const rivalOwner = await prisma.posUser.create({
  data: {
    passwordHash,
    email: 'owner@rival.demo.local',
    fullName: 'Ravi Rival',
    role: 'CUSTOMER_OWNER',
    companyId: rival.id,
  },
});
const rivalTax = await prisma.taxRate.create({
  data: { companyId: rival.id, name: 'GST 5%', ratePercent: 5 },
});
const rivalCat = await prisma.category.create({ data: { companyId: rival.id, name: 'Kettle menu' } });
const rivalProduct = await prisma.product.create({
  data: {
    companyId: rival.id,
    categoryId: rivalCat.id,
    name: 'Kettle Chai',
    sku: 'RX-CHAI',
    basePrice: D(9900),
    taxRateId: rivalTax.id,
  },
});
// 7 days × 1 bill of exactly ₹99 × 7 units — a round figure that cannot be
// mistaken for one of company one's bills if it ever appears in its totals.
let rivalNet = 0;
for (let d = 0; d < 7; d += 1) {
  const subtotal = 9900 * 7;
  const tax = Math.round(subtotal * TAX_RATE);
  const when = at(d, 13, 0);
  const rivalOrder = await prisma.order.create({
    data: {
      companyId: rival.id,
      branchId: rivalStore.id,
      type: 'DINE_IN',
      status: 'PAID',
      openedById: rivalOwner.id,
      billedAt: when,
      closedAt: when,
      createdAt: when,
      subtotal: D(subtotal),
      taxAmount: D(tax),
      total: D(subtotal + tax),
      items: {
        create: [{
          productId: rivalProduct.id,
          name: rivalProduct.name,
          qty: 7,
          unitPrice: D(9900),
          lineDiscount: 0,
          lineSubtotal: D(subtotal),
          discountShare: 0,
          lineTax: D(tax),
          lineTotal: D(subtotal),
          status: 'ACTIVE',
        }],
      },
    },
  });
  await prisma.payment.create({
    data: {
      orderId: rivalOrder.id,
      branchId: rivalStore.id,
      method: 'CASH',
      amount: D(subtotal + tax),
      receivedById: rivalOwner.id,
      createdAt: when,
    },
  });
  rivalNet += subtotal;
}

// --- one scan, so the worklist is not empty on arrival ----------------------
//
// Exceptions are detected at read time like every other figure; the ROW exists for
// the part that cannot be derived — that a named person picked it up, fixed it, or
// looked and decided it was fine. So the rows are produced by running the real
// scanner over the real fixtures, not written by hand: a hand-written worklist can
// contain a finding no detector would ever produce, and then the screen is showing
// the seed's opinion rather than the engine's.
//
// It runs as the owner, over this month, because that is the widest window whose
// findings are all still current.
const { contextForUser } = await import('../src/lib/reporting/schedule.js');
const { scanExceptions } = await import('../src/lib/reporting/exceptions.js');
const { resolvePeriod } = await import('../src/lib/reporting/period.js');

const scanCtx = await contextForUser({ userId: owner.id, companyId });
if (!scanCtx.ok) {
  console.error(`Refusing: the seeded owner cannot be resolved for a scan — ${scanCtx.reason}`);
  process.exit(1);
}
const scanned = await scanExceptions({
  scope: scanCtx.scope,
  period: resolvePeriod({ preset: 'THIS_MONTH', settings: scanCtx.settings }),
  settings: scanCtx.settings,
  actorId: owner.id,
});

// Three of them closed three different ways, so the three tabs all have content
// and the demo shows that they are three different claims rather than three words
// for "done". Chosen by kind rather than by position: the scan's order is the
// detector order, but which store's drawer was short is the loop's business.
const closeOne = async (kind, patch) => {
  const row = await prisma.reportingException.findFirst({
    where: { companyId, kind, status: 'OPEN' },
    orderBy: { detectedAt: 'asc' },
  });
  if (!row) return 0;
  await prisma.reportingException.update({ where: { id: row.id }, data: patch });
  return 1;
};
let closed = 0;
closed += await closeOne('CASH_DIFFERENCE', {
  status: 'ACKNOWLEDGED', acknowledgedAt: at(1, 10, 0), acknowledgedById: cpManager.id,
});
closed += await closeOne('UNCLOSED_SHIFT', {
  status: 'RESOLVED', acknowledgedAt: at(1, 11, 0), acknowledgedById: cpManager.id,
  resolvedAt: at(1, 11, 30), resolvedById: cpManager.id,
  resolutionNote: 'Drawer counted and the day closed retrospectively from the till tape.',
});
closed += await closeOne('UNUSUAL_DISCOUNT', {
  status: 'DISMISSED', resolvedAt: at(0, 17, 0), resolvedById: owner.id,
  resolutionNote: 'Approved staff party — the discount was authorised in advance.',
});

const counts = {
  stores: await prisma.branch.count({ where: { companyId } }),
  orders: await prisma.order.count({ where: { companyId } }),
  items: await prisma.orderItem.count({ where: { order: { companyId } } }),
  payments: await prisma.payment.count({ where: { order: { companyId } } }),
  refunds: await prisma.refund.count({ where: { order: { companyId } } }),
  closings: await prisma.dayClose.count({ where: { companyId } }),
  kitchenItems: await prisma.kitchenItem.count({ where: { companyId } }),
  schedules: await prisma.reportSchedule.count({ where: { companyId } }),
  recipients: await prisma.reportRecipient.count({ where: { companyId } }),
  exceptions: await prisma.reportingException.count({ where: { companyId } }),
};

// Printed per kind rather than as one total, because the total is the least
// informative number here: "80 exceptions" could be 80 unclosed days and none of
// the three fixtures above, and the run that seeded them is the cheapest place to
// notice that a detector produced nothing.
const byKind = await prisma.reportingException.groupBy({
  by: ['kind', 'severity'],
  where: { companyId },
  _count: { _all: true },
  orderBy: [{ kind: 'asc' }, { severity: 'asc' }],
});
const kindLines = byKind
  .map((r) => `${r.kind} ${r.severity} ×${r._count._all}`)
  .join('\n              ');

const billed = await prisma.order.count({ where: { companyId, status: 'BILLED' } });
const voided = await prisma.order.count({ where: { companyId, status: 'VOID' } });
const open = await prisma.order.count({ where: { companyId, status: 'OPEN' } });

console.log(`
Reporting demo seeded — SYNTHETIC DATA, NOT REAL TRADE.

  company     ${company.slug} (${companyId})
  stores      ${counts.stores}  (${DAYS}-day window, ${BILLS_PER_DAY} bills/store/day)
              Connaught Place, Cyber Hub  — North, Brew Street, Delhi GSTIN
              Bandra West, Lower Parel    — West, Tiffin Co, Maharashtra GSTIN
              New Town                    — never traded, by design
              Training Kitchen            — isDemo, excluded from totals by default
  orders      ${counts.orders}  (${billed} part-paid BILLED, ${voided} VOID, ${open} OPEN)
  items       ${counts.items}
  payments    ${counts.payments}   refunds ${counts.refunds}
  closings    ${counts.closings} (${closingsWritten} written; 4 days deliberately left uncounted,
              3 of the rest did not balance and carry the manager's note)
  written     ${written} bills in the ordinary loop, plus the edge cases

  worklist    ${counts.exceptions} exceptions, from one real scan of THIS_MONTH as the owner
              raised ${scanned.raised}, refreshed ${scanned.refreshed}, auto-cleared ${scanned.cleared}
              ${scanned.detectors.filter((d) => d.found !== null).length} detectors ran, ${
                scanned.detectors.filter((d) => d.found === null).length
              } could not — their reason is on the screen, never a zero
              ${closed} closed three different ways, so all three tabs have content
              ${kindLines}
  kitchen     ${counts.kitchenItems} lines on one ticket at Connaught Place: one 26 min,
              one never marked ready, one inside its 10 min target
  schedules   ${counts.schedules} (1 ACTIVE daily sales CSV, 1 PAUSED weekly XLSX, 1 DRAFT monthly PDF)
  recipients  ${counts.recipients} approved addresses, 1 marked as a test address, 1 revoked.
              Only the test address is ever written to — there is no mail transport
              in this build, and the rest are recorded as withheld.

  other       ${rival.slug} (${rival.id}) — 1 store, net ${D(rivalNet)}
              A second tenant, so a cross-tenant leak has something to leak. Its
              net sales are a round figure no bill of company one's can produce.

  logins      owner@reporting.demo.local            CUSTOMER_OWNER
              finance@reporting.demo.local          FINANCE
              regional.north@reporting.demo.local   REGIONAL_MANAGER (North only)
              manager.cp@reporting.demo.local       BRANCH_MANAGER (Connaught Place only)
              auditor@reporting.demo.local          AUDITOR
              cashier.cp@reporting.demo.local       CASHIER (no report access)
              owner@rival.demo.local                CUSTOMER_OWNER of the other tenant
              password: the POS_SEED_PASSWORD you supplied — not printed

Bandra West stops trading 21 days ago on purpose: its coverage must read stale or
no activity rather than a small number. New Town must read "never reported".
`);

await prisma.$disconnect();
