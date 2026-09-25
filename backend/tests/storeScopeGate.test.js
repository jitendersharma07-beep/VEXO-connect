// resolveStoreInScope — the "is THIS store inside your scope?" gate.
//
// A regression suite for one defect and one defect only: the gate was written as
//
//   where: { id: branchId, companyId, ...branchWhereForScope(req.perm.scope) }
//
// and branchWhereForScope returns `{ id: { in: [...] } }` for every scope
// narrower than the whole tenant. The spread therefore DELETED the `id` the gate
// existed to check, and the query became "is there any store in this caller's
// scope?" — true for everybody who has a store. findFirst returned some store
// the caller happened to hold, so the gate never threw.
//
// Nothing about the tenant boundary was involved: companyId is a different key
// and survived. These tests are about the boundary INSIDE one company, which is
// the one the assignment feature exists to draw.
//
// Three shapes are covered because the consequences differ in kind, not degree:
//
//   1. Callers that use the RESOLVED row (terminals, devices, drawer,
//      paymentAccounts, resolvePlacement) wrote into the caller's own store
//      while answering 201 for the store they were asked about. The till
//      appeared in the wrong outlet and nothing said so. Bad data, but the
//      write stayed inside the caller's own reach.
//   2. PUT /permissions/assignments/:userId persists the id from the REQUEST
//      BODY once the gate passes, so a company-wide role that the tenant had
//      narrowed with assignments could assign somebody to a store outside that
//      narrowing. That is a privilege grant, not a misfiled row.
//   3. POST /invitations is (2) deferred: storeIds are stored on the invitation
//      and become UserStoreAssignment rows only when it is ACCEPTED. The grant
//      therefore appears later, out of band, and nothing at acceptance re-checks
//      the inviter's scope.
//
// All three must answer "Store not found", and the positive control in each
// block proves the gate did not simply start refusing everything.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('storeScopeGate.test.js requires a DATABASE_URL ending in _test');
}

// POST /invitations refuses before it validates anything when mail is not
// configured, so reaching the store gate at all needs a deliverable address.
// Set before the app is imported: `mailEnabled` is decided at module load.
const sink = startSmtpSink({ port: 0 });
await sink.started;
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@scope.local';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const wipe = async () => {
  await prisma.deviceCommand.deleteMany();
  await prisma.device.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.permissionRule.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  // Before posUser, and not optional: UserInvitation.createdById is a Restrict
  // FK, so leaving a row here makes posUser.deleteMany() fail with
  // `UserInvitation_createdById_fkey`. floorplan.test.js omits this line and
  // fails exactly that way whenever the sequencer happens to run it after
  // invitations.test.js — recorded in the handover as a separate defect.
  await prisma.emailOutbox.deleteMany();
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const tokens = {};
const staff = {};
let companyA, companyB, branchA1, branchA2, branchB1;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Scope',
      slug: 'alpha-scope',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Scope',
      slug: 'bravo-scope',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SG-0001', name: 'Alpha One', code: 'A1', city: 'Delhi' },
  });
  branchA2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SG-0002', name: 'Alpha Two', code: 'A2', city: 'Jaipur' },
  });
  branchB1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-SG-0003', name: 'Bravo One', code: 'B1', city: 'Pune' },
  });

  const mkUser = (key, data) =>
    prisma.posUser.create({ data: { passwordHash, ...data } }).then((u) => {
      staff[key] = u;
      return u;
    });

  // A REGIONAL_MANAGER, assigned to Alpha One and nothing else.
  //
  // That combination is deliberate and it took a wrong first attempt to find it.
  // The obvious fixture — a BRANCH_MANAGER — cannot reach this route at all:
  // terminal.write is not in its baseline, so every request answers 403 at
  // requireAction and the store gate is never consulted. A regional manager does
  // hold terminal.write, but with only a regionId their scope is
  // `{ kind: 'REGION' }`, whose fragment is `{ regionId }` — a key that does not
  // collide with `id` and so never triggered the defect either.
  //
  // An explicit assignment is what produces `{ kind: 'LIST', branchIds }`, and a
  // LIST scope is the one whose fragment is keyed on `id`. So this is both a
  // realistic configuration (a regional manager covering one outlet) and the
  // only one that reaches the gate with the fragment that used to break it.
  await mkUser('rmA1', {
    email: 'rm.a1@scope.local', fullName: 'Regional A1', role: 'REGIONAL_MANAGER',
    companyId: companyA.id,
  });
  // Company-wide by role, then NARROWED to Alpha One by an assignment below.
  // This is the caller the assignment-widening test needs: company-wide roles are
  // the only ones that hold user.write, and an assignment is the only thing that
  // makes their scope narrow enough for the defect to bite.
  await mkUser('adminA', {
    email: 'admin.a@scope.local', fullName: 'Admin A', role: 'COMPANY_ADMIN', companyId: companyA.id,
  });
  // The person whose store list gets rewritten.
  await mkUser('subjectA', {
    email: 'subject.a@scope.local', fullName: 'Subject A', role: 'CASHIER',
    companyId: companyA.id, branchId: branchA1.id,
  });

  // The assignments that produce a LIST scope for both callers. Without these
  // the regional manager's scope is `{ kind: 'REGION' }` and the admin's is
  // `{ kind: 'COMPANY' }`, and neither fragment is keyed on `id`, so neither
  // reaches the gate in the shape that used to break it.
  await prisma.userStoreAssignment.create({
    data: { userId: staff.rmA1.id, companyId: companyA.id, branchId: branchA1.id },
  });
  await prisma.userStoreAssignment.create({
    data: { userId: staff.adminA.id, companyId: companyA.id, branchId: branchA1.id },
  });

  tokens.rmA1 = await login('rm.a1@scope.local');
  tokens.adminA = await login('admin.a@scope.local');
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
  await sink.close();
});

describe('a store outside the caller s scope is not found, and nothing is written elsewhere', () => {
  it('refuses a till in the company s other store, and does not create one in the caller s own', async () => {
    const res = await request(app)
      .post('/api/terminals')
      .set(auth(tokens.rmA1))
      .send({ branchId: branchA2.id, code: 'T-A2', name: 'Wrong Store Till' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.message).toMatch(/store not found/i);

    // The symptom that made this defect invisible: the gate returned the
    // caller's OWN store, so the till was created — just not where the request
    // said. Asserting the refusal alone would have passed on a route that
    // answered 404 after writing the row.
    expect(await prisma.terminal.count()).toBe(0);
  });

  it('still lets that regional manager create a till in the store they do hold', async () => {
    // The positive control. Without it, a gate that refuses everything passes
    // every test above.
    const res = await request(app)
      .post('/api/terminals')
      .set(auth(tokens.rmA1))
      .send({ branchId: branchA1.id, code: 'T-A1', name: 'Own Store Till' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await prisma.terminal.findMany({ select: { branchId: true, code: true } });
    expect(rows).toEqual([{ branchId: branchA1.id, code: 'T-A1' }]);
    await prisma.terminal.deleteMany();
  });

  it('answers the same for another tenant s store as for its own out-of-scope one', async () => {
    const foreign = await request(app)
      .post('/api/terminals')
      .set(auth(tokens.rmA1))
      .send({ branchId: branchB1.id, code: 'T-B1', name: 'Other Tenant Till' });
    const sibling = await request(app)
      .post('/api/terminals')
      .set(auth(tokens.rmA1))
      .send({ branchId: branchA2.id, code: 'T-A2', name: 'Sibling Store Till' });
    expect(foreign.status).toBe(404);
    expect(sibling.status).toBe(404);
    // Identical replies, so the shape of the refusal cannot be used to tell a
    // store that exists elsewhere from one in your own company you may not touch.
    expect(foreign.body.error.message).toBe(sibling.body.error.message);
    expect(await prisma.terminal.count()).toBe(0);
  });
});

describe('a narrowed admin cannot assign somebody to a store they do not hold', () => {
  const assign = (storeIds) =>
    request(app)
      .put(`/api/permissions/assignments/${staff.subjectA.id}`)
      .set(auth(tokens.adminA))
      .send({ storeIds });

  it('refuses a store outside the caller s own assignments, and writes no row', async () => {
    const res = await assign([branchA2.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    // This route persists the branchId from the REQUEST BODY once the gate has
    // passed, not the resolved row — so a gate that failed to refuse would have
    // granted real access to Alpha Two here.
    const rows = await prisma.userStoreAssignment.findMany({
      where: { userId: staff.subjectA.id },
      select: { branchId: true },
    });
    expect(rows).toEqual([]);
  });

  it('refuses a list that mixes one store they hold with one they do not', async () => {
    // The list is validated element by element and applied in a transaction, so
    // a partial application would be the worst outcome: half a request honoured.
    const res = await assign([branchA1.id, branchA2.id]);
    expect(res.status).toBe(404);
    expect(await prisma.userStoreAssignment.count({ where: { userId: staff.subjectA.id } })).toBe(0);
  });

  it('allows the store they do hold', async () => {
    const res = await assign([branchA1.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await prisma.userStoreAssignment.findMany({
      where: { userId: staff.subjectA.id },
      select: { branchId: true },
    });
    expect(rows).toEqual([{ branchId: branchA1.id }]);
    await prisma.userStoreAssignment.deleteMany({ where: { userId: staff.subjectA.id } });
  });
});

// The same gate on the invitation path, and the reason it gets its own block:
// UserInvitation.storeIds is materialised into real UserStoreAssignment rows
// when the invitation is ACCEPTED. So this variant hands out access that does
// not exist yet at the moment of the refusal — it appears later, out of band,
// when the recipient clicks a link. Nothing at acceptance time re-checks the
// inviter's scope, and by then the inviter may be gone.
//
// The route's own comment (routes/invitations.js:113) states the promise being
// tested: "every one must already be inside the CALLER's own scope, or a
// regional manager could invite somebody into a region they cannot reach."
describe('a narrowed admin cannot invite somebody into a store they do not hold', () => {
  const invite = (email, storeIds) =>
    request(app)
      .post('/api/invitations')
      .set(auth(tokens.adminA))
      .send({ email, fullName: 'Invited Person', role: 'CASHIER', branchId: branchA1.id, storeIds });

  it('refuses out-of-scope storeIds, and stores no invitation to be accepted later', async () => {
    const res = await invite('invitee.out@scope.local', [branchA2.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.message).toMatch(/store not found/i);

    // No PENDING row: a refusal that still wrote the invitation would be no
    // refusal at all, because acceptance is what creates the assignments and
    // acceptance does not consult the inviter's scope again.
    expect(await prisma.userInvitation.count()).toBe(0);
  });

  it('refuses even when the out-of-scope store is buried in a list of held ones', async () => {
    const res = await invite('invitee.mixed@scope.local', [branchA1.id, branchA2.id]);
    expect(res.status).toBe(404);
    expect(await prisma.userInvitation.count()).toBe(0);
  });

  it('still invites into the store they do hold, with that store recorded', async () => {
    const res = await invite('invitee.ok@scope.local', [branchA1.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await prisma.userInvitation.findMany({ select: { email: true, storeIds: true } });
    expect(rows).toEqual([{ email: 'invitee.ok@scope.local', storeIds: [branchA1.id] }]);
    await prisma.emailOutbox.deleteMany();
    await prisma.userInvitation.deleteMany();
  });
});
