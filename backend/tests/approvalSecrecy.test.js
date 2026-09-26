// Where does the approver's password end up?
//
// It arrives in the request body, in plain text, on a route that writes an
// audit row and may throw. That is four sinks — the log, the audit trail, the
// response, and the order itself — and "we never wrote it anywhere" is the
// kind of claim that is easy to assert and hard to actually check.
//
// The check here is a canary. The approver's real password is a string that
// exists nowhere else in the system, so anything containing it came from this
// request. After driving the approval paths, every text and JSON column in the
// database is searched for it, and so is every line the app handed the logger.
//
// A search that finds nothing proves nothing on its own — an empty log and a
// broken query look identical from here. So two more canaries ride along
// through the same pipes in places that are SUPPOSED to be kept: a marker in
// the URL, which the request logger records, and the approval reason, which is
// deliberately stored on the order. If the scan cannot find those, it is not
// entitled to report that it could not find the password.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('approvalSecrecy.test.js requires a DATABASE_URL ending in _test');
}

// vi.mock is hoisted above every import, so the array it writes into has to be
// created in a hoisted block too or the factory closes over a dead binding.
const { logLines } = vi.hoisted(() => ({ logLines: [] }));

// The app's logger, rebuilt to write into an array instead of stdout — but
// carrying the REAL redact configuration, imported from the real module. A
// capture that quietly dropped REDACT would turn this whole file into a test
// of pino's defaults. The level is forced to trace because the suite runs at
// LOG_LEVEL=silent, and a silent logger would make every assertion below pass
// for the most boring possible reason.
vi.mock('../src/lib/logger.js', async () => {
  const actual = await vi.importActual('../src/lib/logger.js');
  const { default: pino } = await import('pino');
  const capture = pino(
    { level: 'trace', redact: { paths: actual.REDACT, censor: '[REDACTED]' } },
    { write: (line) => logLines.push(line) },
  );
  return { ...actual, logger: capture, default: capture };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { resetApprovalThrottle } = await import('../src/lib/discountGuard.js');

const app = createApp();

// --- the canaries -----------------------------------------------------------
// Distinct, searchable, and nothing like each other, so a hit names its own
// source without further digging.

// The secret. Must appear nowhere.
const CANARY_PW = 'CanaryPw-7f3b91d4e6a2c805';
// A wrong password, sent at the same approver. Refusal paths write more to the
// audit trail than success paths do, so this one exercises the wordier code.
const CANARY_BAD_PW = 'CanaryBadPw-2d8e4f01a7b69c3d';
// Kept on purpose: the reason is stored on the order and in the audit meta.
const CANARY_REASON = 'CanaryReason-5a0c7e29b4d1f863';
// Kept on purpose: pino-http records the request line.
const CANARY_URL = 'CanaryUrl-9b6d2a48c0e7f135';

const PW = 'cashier-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
const users = {};
let cafe, b1, bun;

// Every response body the suite sees, kept raw. `res.body` is the parsed
// object and would miss a secret that leaked into an unparsed error page.
const responseTexts = [];
const record = (res) => {
  responseTexts.push(res.text ?? '');
  return res;
};

const login = async (email, password) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const newOrder = async () => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', branchId: b1.id, items: [{ productId: bun, qty: 1 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order;
};

// --- the scan ---------------------------------------------------------------
// Walks every text-ish column in the schema rather than the handful of tables
// anybody would think to check. The point is to catch the sink nobody
// predicted — a column added later, on a table this file has never heard of.

const textColumns = async () =>
  prisma.$queryRaw`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'jsonb', 'json')
    ORDER BY table_name, column_name
  `;

const scanDatabase = async (needle) => {
  const hits = [];
  for (const { table_name: tbl, column_name: col } of await textColumns()) {
    // Identifiers are quoted, the needle is bound. Both come from this file or
    // from the catalogue, but a scanner that is itself an injection would be a
    // poor advertisement for the rest of the work.
    const [{ n }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${tbl}" WHERE "${col}"::text LIKE $1`,
      `%${needle}%`,
    );
    if (n > 0) hits.push(`${tbl}.${col} (${n} row${n === 1 ? '' : 's'})`);
  }
  return hits;
};

const scanLogs = (needle) => logLines.filter((l) => l.includes(needle));

beforeAll(async () => {
  await wipeAll();
  logLines.length = 0;
  const inADay = new Date(Date.now() + 86400e3);

  cafe = await prisma.company.create({
    data: {
      name: 'Canary Cafe',
      slug: 'canary-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  b1 = await prisma.branch.create({ data: { companyId: cafe.id, publicId: 'VC-AV-0001', name: 'Cafe One', code: 'C1' } });

  users.cashier = await prisma.posUser.create({
    data: {
      email: 'cashier.c1@test.local',
      fullName: 'Cashier C1',
      role: 'CASHIER',
      companyId: cafe.id,
      branchId: b1.id,
      passwordHash: await hashPassword(PW),
    },
  });
  // The approver's password IS the canary.
  users.manager = await prisma.posUser.create({
    data: {
      email: 'mgr.c1@test.local',
      fullName: 'Manager C1',
      role: 'BRANCH_MANAGER',
      companyId: cafe.id,
      branchId: b1.id,
      passwordHash: await hashPassword(CANARY_PW),
    },
  });

  tokens.cashier = await login('cashier.c1@test.local', PW);

  await prisma.discountPolicy.create({
    data: {
      companyId: cafe.id, level: 'COMPANY', scopeKey: 'company',
      allowLineDiscount: true, allowOrderDiscount: true, maxPercent: '10.000',
    },
  });
  await prisma.discountPolicy.create({
    data: {
      companyId: cafe.id, level: 'USER', scopeKey: `user:${users.manager.id}`,
      userId: users.manager.id, canApprove: true, maxApprovalPercent: '50.000',
    },
  });

  const tax = await prisma.taxRate.create({
    data: { companyId: cafe.id, name: 'GST 5', ratePercent: '5.000' },
  });
  const cat = await prisma.category.create({ data: { companyId: cafe.id, name: 'Bakery' } });
  bun = (await prisma.product.create({
    data: {
      companyId: cafe.id, categoryId: cat.id, taxRateId: tax.id,
      name: 'Bun Maska', basePrice: '1000.00',
    },
  })).id;

  // --- drive every path that handles the password -------------------------

  // 1. Accepted. 30% is over the cashier's 10%, so the approval block is read,
  //    the password is verified, and the discount is written and audited.
  const accepted = await newOrder();
  record(
    await request(app)
      .post(`/api/orders/${accepted.id}/discount`)
      .set(auth(tokens.cashier))
      .send({
        type: 'PERCENT',
        value: 30,
        approval: {
          approverEmail: 'mgr.c1@test.local', password: CANARY_PW, reason: CANARY_REASON,
        },
      }),
  );

  // 2. Refused on a wrong password. Writes ORDER_DISCOUNT_APPROVAL_FAILED,
  //    which carries more context than the success row does.
  const refused = await newOrder();
  record(
    await request(app)
      .post(`/api/orders/${refused.id}/discount`)
      .set(auth(tokens.cashier))
      .send({
        type: 'PERCENT',
        value: 30,
        approval: {
          approverEmail: 'mgr.c1@test.local', password: CANARY_BAD_PW, reason: CANARY_REASON,
        },
      }),
  );

  // 3. Rejected by validation, with the password present in the body. A
  //    validator that echoes what it received is a classic way for a secret to
  //    reach a response — the reason is too short, the password is not.
  const invalid = await newOrder();
  record(
    await request(app)
      .post(`/api/orders/${invalid.id}/discount`)
      .set(auth(tokens.cashier))
      .send({
        type: 'PERCENT',
        value: 30,
        approval: { approverEmail: 'mgr.c1@test.local', password: CANARY_PW, reason: 'x' },
      }),
  );

  // 4. The positive control for the log sink: a marker the request logger is
  //    expected to record, sent through the same app on the same run.
  record(
    await request(app)
      .get(`/api/orders?probe=${CANARY_URL}`)
      .set(auth(tokens.cashier)),
  );

  resetApprovalThrottle();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the instruments are live', () => {
  // Everything in the next block is an absence. These four assertions are what
  // make an absence mean something.

  it('captured log output at all', () => {
    expect(logLines.length, 'no log lines were captured — the logger mock is not wired').toBeGreaterThan(0);
  });

  it('finds a marker the request logger is supposed to record', () => {
    expect(
      scanLogs(CANARY_URL).length,
      `the URL marker never reached the log, so "the password is not in the log" is untested. ` +
        `${logLines.length} lines captured.`,
    ).toBeGreaterThan(0);
  });

  it('scans a schema it can actually see', async () => {
    const cols = await textColumns();
    expect(cols.length, 'the column catalogue came back empty — the scan would find nothing').toBeGreaterThan(20);
  });

  it('finds the approval reason, which is stored on purpose', async () => {
    const hits = await scanDatabase(CANARY_REASON);
    expect(
      hits,
      'the stored approval reason was not found by the scan, so the scan proves nothing about the password',
    ).not.toEqual([]);
  });
});

describe('the approver password', () => {
  it('reaches no database column', async () => {
    const hits = await scanDatabase(CANARY_PW);
    expect(hits, `approver password found in: ${hits.join(', ')}`).toEqual([]);
  });

  it('reaches no database column even when it was wrong', async () => {
    // The refusal path builds the richest audit meta in the file. A `...body`
    // spread anywhere in it would land here.
    const hits = await scanDatabase(CANARY_BAD_PW);
    expect(hits, `rejected password found in: ${hits.join(', ')}`).toEqual([]);
  });

  it('reaches no log line', () => {
    const hits = scanLogs(CANARY_PW);
    expect(
      hits.length,
      `approver password found in ${hits.length} log line(s), first: ${hits[0]?.slice(0, 400)}`,
    ).toBe(0);
  });

  it('reaches no log line even when it was wrong', () => {
    const hits = scanLogs(CANARY_BAD_PW);
    expect(
      hits.length,
      `rejected password found in ${hits.length} log line(s), first: ${hits[0]?.slice(0, 400)}`,
    ).toBe(0);
  });

  it('is echoed in no response body', () => {
    const leaks = responseTexts.filter(
      (t) => t.includes(CANARY_PW) || t.includes(CANARY_BAD_PW),
    );
    expect(leaks, `a response echoed the password back: ${leaks[0]?.slice(0, 400)}`).toEqual([]);
  });

  it('is not what the validator quotes when it rejects the block', () => {
    // The validation failure names the field, which is useful, and must not
    // quote the value, which is the password sitting next to it.
    const validation = responseTexts.find((t) => t.includes('POS_BAD_REQUEST'));
    expect(validation, 'the invalid-approval request was not rejected as bad input').toBeTruthy();
    expect(validation).toContain('approval.reason');
    expect(validation).not.toContain(CANARY_PW);
  });
});

describe('what the approval DOES leave behind', () => {
  // The other half of redaction: having proved the password is gone, prove the
  // trail is still worth reading. A guard that logged nothing would pass every
  // assertion above.
  it('records who approved it, and why, without the credential', async () => {
    const row = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_DISCOUNT_SET' },
      orderBy: { at: 'desc' },
    });
    expect(row, 'no ORDER_DISCOUNT_SET audit row was written').toBeTruthy();
    expect(row.meta?.approvedBy?.email).toBe('mgr.c1@test.local');
    expect(row.meta?.approvedBy?.selfApproved).toBe(false);
    expect(row.meta?.approvalReason).toBe(CANARY_REASON);
    expect(JSON.stringify(row.meta)).not.toContain(CANARY_PW);
  });

  it('records the refusal, naming the approver but not the attempt', async () => {
    const row = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_DISCOUNT_APPROVAL_FAILED' },
      orderBy: { at: 'desc' },
    });
    expect(row, 'no ORDER_DISCOUNT_APPROVAL_FAILED audit row was written').toBeTruthy();
    expect(row.meta?.approverEmail).toBe('mgr.c1@test.local');
    expect(row.meta?.refusal).toBe('BAD_PASSWORD');
    expect(JSON.stringify(row.meta)).not.toContain(CANARY_BAD_PW);
  });
});
