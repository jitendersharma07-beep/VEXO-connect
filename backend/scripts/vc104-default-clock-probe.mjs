// Which clock fills `@default(now())` — the Node process, or Postgres?
//
// It decides whether mutants M8/M9 are testable at all. Both remove an explicit
// timestamp and let the default apply. If Prisma Client computes the value in
// JS, then a test that controls the JS clock controls the default too, the
// mutated and unmutated code write the same instant, and no test can tell them
// apart. If Postgres fills it, the two clocks are independent and a controlled
// JS clock makes the divergence visible and deterministic.
//
// Asserted rather than looked up, because the answer differs by Prisma version
// and by whether the column is in the INSERT column list at all. Prints the
// generated SQL as well as the outcome, so the conclusion is legible and not
// just a boolean.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const sql = [];
prisma.$on('query', (e) => sql.push(e.query));

// Far enough from real now that no clock skew could be mistaken for it.
const FAKE = new Date('2019-03-04T05:06:07.008Z');
const RealDate = Date;
const fakeClock = () => {
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...a) {
      // eslint-disable-next-line constructor-super
      return a.length ? new RealDate(...a) : new RealDate(FAKE);
    }

    static now() {
      return FAKE.getTime();
    }
  };
};
const realClock = () => {
  // eslint-disable-next-line no-global-assign
  Date = RealDate;
};

const run = async () => {
  const company = await prisma.company.create({
    data: { name: `clock-probe-${RealDate.now()}`, slug: `clock-probe-${RealDate.now()}` },
  });
  try {
    const branch = await prisma.branch.create({
      data: {
        companyId: company.id,
        name: 'probe',
        code: `P${RealDate.now() % 100000}`,
        // Branch_publicId_shape CHECK: ^VC-[A-Z]{2}-[0-9]{4,}$
        publicId: `VC-CP-${RealDate.now()}`,
      },
    });
    const customer = await prisma.customer.create({
      data: { companyId: company.id, name: 'probe', phone: `9${RealDate.now() % 1000000000}` },
    });

    fakeClock();
    let po;
    try {
      po = await prisma.phoneOrder.create({
        data: {
          companyId: company.id,
          reference: `PH-CLOCK-${RealDate.now()}`,
          customerId: customer.id,
          fulfilment: 'PICKUP',
          status: 'SUBMITTED',
          routedBranchId: branch.id,
          operatorName: 'clock probe',
          idempotencyKey: `clock-${RealDate.now()}`,
          requestHash: 'clock',
          // createdAt deliberately omitted: that is the mutated state.
        },
      });
    } finally {
      realClock();
    }

    const insert = sql.find((q) => q.includes('INSERT INTO "public"."PhoneOrder"'));
    const skewMs = Math.abs(po.createdAt.getTime() - FAKE.getTime());
    const fromNode = skewMs < 60_000;

    console.log(`fake JS clock     : ${FAKE.toISOString()}`);
    console.log(`persisted createdAt: ${po.createdAt.toISOString()}`);
    console.log(`column in INSERT  : ${insert?.includes('createdAt') ? 'YES' : 'no'}`);
    console.log(`INSERT            : ${insert ?? '(not captured)'}`);
    console.log('');
    // Be careful what this is allowed to conclude. A NO in the INSERT would mean
    // Postgres's own DEFAULT CURRENT_TIMESTAMP filled the column. A YES means
    // the value was bound as a parameter by the client side — but "client side"
    // here is the Rust QUERY ENGINE, not this Node process, and those are
    // different clocks. Saying "Postgres fills it" whenever the JS clock loses
    // would name the wrong component; the only thing the skew actually proves is
    // whether the JS clock is the source.
    const bound = Boolean(insert?.includes('createdAt'));
    console.log(
      fromNode
        ? 'VERDICT: the NODE process fills the default. A controlled JS clock cannot\n'
          + '         separate pinned from defaulted — M8/M9 stay undetectable this way.'
        : (bound
            ? 'VERDICT: the PRISMA QUERY ENGINE fills the default — createdAt is bound as\n'
              + '         a parameter, so it is not Postgres\'s DEFAULT, and patching JS Date\n'
              + '         did not move it, so it is not this process either.'
            : 'VERDICT: POSTGRES fills the default — the column is absent from the INSERT,\n'
              + '         so the column DEFAULT supplied it.')
          + '\n         Either way the clock is independent of this process, which is what\n'
          + '         makes the check/write divergence deterministic under fake timers.',
    );
  } finally {
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await prisma.$disconnect();
  }
};

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
