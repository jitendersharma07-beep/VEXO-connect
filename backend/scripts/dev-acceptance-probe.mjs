// The handover acceptance probe: the checks a café owner is entitled to see
// pass before anyone takes money on this build.
//
// WHY A PROBE AND NOT A TEST
//
// The unit suite mocks the database, so it can only prove that this code does
// what this code says. Every property below is a property of two requests
// racing each other through a real Postgres at its real isolation level, or of
// one tenant's token against another tenant's row. Neither survives mocking —
// a mock has no MVCC and no second connection, so a lost update is invisible
// to it by construction. These run against a live backend over HTTP, which is
// the only place the answers are real.
//
// WHAT IT CHECKS
//
//   1. Double-billing. Two concurrent POST /:id/bill on one order. Exactly one
//      may win and exactly one invoice number may be issued. A cashier
//      double-clicking "Bill" at a busy counter is the ordinary case, not the
//      adversarial one.
//   2. Double-payment. Two concurrent POST /:id/payments for the full amount.
//      Exactly one may be recorded. The failure mode here is not a crash: it
//      is a till that balances against a bill collected twice, discovered at
//      day end with no way to tell which of the two was the real one.
//   3. Cross-tenant read. Company A's cashier asks for Company B's order by
//      id. Must be 403 or 404 — and must NOT be 200, obviously, but also must
//      not be a 500, because a stack trace is its own disclosure.
//   4. Cross-tenant write. The same token tries to bill that order. Reading
//      being blocked does not imply writing is: they are different guards and
//      each needs its own evidence.
//
// Each check states what it observed, not merely PASS/FAIL, because "one
// payment row" and "two requests returned 201 and one row lost the race" are
// very different health reports and only the second tells you why.
//
// SAFE TO RE-RUN: it creates its own order per run and never touches an order
// it did not create, except read-only for the isolation checks. Nothing here
// writes to production; it talks to whatever POS_BASE points at, which
// defaults to the dev backend on loopback.
//
// USAGE
//   node backend/scripts/dev-acceptance-probe.mjs
//   POS_BASE=http://127.0.0.1:5010 node backend/scripts/dev-acceptance-probe.mjs
import { readFileSync, statSync } from 'node:fs';

const BASE = process.env.POS_BASE || 'http://127.0.0.1:5010';
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ACCOUNT = `${REPO}/backend/.secrets/dev-sandbox-account.env`;

let raw;
try { raw = readFileSync(ACCOUNT, 'utf8'); } catch {
  console.log(`FAIL: no sandbox account at ${ACCOUNT} — run the sandbox setup first`);
  process.exit(2);
}
const mode = (statSync(ACCOUNT).mode & 0o777).toString(8);
if (mode !== '600') { console.log(`FAIL: ${ACCOUNT} is mode ${mode}, expected 600`); process.exit(2); }

// Quoting in this file is not uniform — the fixture writer quotes a value only
// when it needs to — so accept both forms. A parser that silently drops the
// unquoted line reports "password missing" for a password that is right there.
const env = {};
for (const line of raw.split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}
const OWNER = env.POS_SANDBOX_OWNER;
const PASSWORD = env.POS_SANDBOX_PASSWORD;
if (!OWNER || !PASSWORD) { console.log('FAIL: owner or password missing from the stored account file'); process.exit(2); }

let failures = 0;
const pass = (what, detail) => console.log(`PASS  ${what}${detail ? `\n      ${detail}` : ''}`);
const fail = (what, detail) => { failures += 1; console.log(`FAIL  ${what}${detail ? `\n      ${detail}` : ''}`); };

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
};

// --- sign in ----------------------------------------------------------------

const login = await call('POST', '/api/auth/login', { body: { email: OWNER, password: PASSWORD } });
if (login.status !== 200) {
  // A 400 here is a mangled payload, never a wrong password — the password is
  // read from a 0600 file and not retyped. Say so rather than sending anyone
  // off to rotate a credential that is fine.
  console.log(`FAIL: login HTTP ${login.status} — ${login.status === 400 ? 'malformed request, not a bad password' : JSON.stringify(login.body).slice(0, 200)}`);
  process.exit(2);
}
const TOKEN = login.body.token;
const COMPANY = login.body.company?.name ?? '(unnamed)';

// An owner is not pinned to a branch the way a cashier is, so the login
// response carries no branch for them and the order create needs one named.
let BRANCH_ID = login.body.branch?.id ?? null;
if (!BRANCH_ID) {
  const branches = await call('GET', '/api/branches', { token: TOKEN });
  const list = branches.body.branches ?? branches.body.items ?? [];
  BRANCH_ID = (list.find((b) => b.status === 'ACTIVE') ?? list[0])?.id ?? null;
}
if (!BRANCH_ID) { console.log('FAIL: no branch available to place a probe order in'); process.exit(2); }
console.log(`signed in as ${OWNER} — company "${COMPANY}"`);
console.log('');

// --- build a throwaway order ------------------------------------------------

const products = await call('GET', '/api/catalog/products?limit=50', { token: TOKEN });
const sellable = (products.body.products ?? products.body.items ?? []).find((p) => p.isAvailable !== false);
if (!sellable) { console.log('FAIL: no sellable product in the catalog to build a probe order with'); process.exit(2); }

const newOrder = async () => {
  const made = await call('POST', '/api/orders', {
    token: TOKEN,
    // Tagged so the orders this leaves behind are identifiable later. It
    // deliberately does not delete them: a probe that cleans up after itself
    // destroys the evidence for whichever check just failed, and the run you
    // most want to inspect is exactly the one that went wrong.
    body: {
      type: 'TAKEAWAY',
      branchId: BRANCH_ID,
      note: `acceptance-probe ${new Date().toISOString()}`,
      items: [{ productId: sellable.id, qty: 1 }],
    },
  });
  if (made.status !== 201 && made.status !== 200) {
    console.log(`FAIL: could not create a probe order — HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
    process.exit(2);
  }
  return made.body.order?.id ?? made.body.id;
};

// --- 1. concurrent bill -----------------------------------------------------

{
  const id = await newOrder();
  const [a, b] = await Promise.all([
    call('POST', `/api/orders/${id}/bill`, { token: TOKEN }),
    call('POST', `/api/orders/${id}/bill`, { token: TOKEN }),
  ]);
  const ok = [a, b].filter((r) => r.status < 400);
  const after = await call('GET', `/api/orders/${id}`, { token: TOKEN });
  const invoice = after.body.order?.invoiceNumber ?? after.body.invoiceNumber ?? null;
  const detail = `statuses ${a.status}/${b.status}, ${ok.length} accepted, invoiceNumber ${invoice}`;
  if (ok.length === 1) pass('double-click Bill issues one invoice', detail);
  else fail('double-click Bill issues one invoice', `${detail} — two bills were accepted for one order`);
}

// --- 2. concurrent payment --------------------------------------------------

{
  const id = await newOrder();
  const billed = await call('POST', `/api/orders/${id}/bill`, { token: TOKEN });
  const total = billed.body.order?.total ?? billed.body.total;
  const [a, b] = await Promise.all([
    call('POST', `/api/orders/${id}/payments`, { token: TOKEN, body: { method: 'CASH', amount: total } }),
    call('POST', `/api/orders/${id}/payments`, { token: TOKEN, body: { method: 'CASH', amount: total } }),
  ]);
  const ok = [a, b].filter((r) => r.status < 400);
  const after = await call('GET', `/api/orders/${id}`, { token: TOKEN });
  const rows = after.body.order?.payments ?? after.body.payments ?? [];
  const collected = rows.reduce((s, p) => s + Number(p.amount), 0);
  const detail = `total ${total}, statuses ${a.status}/${b.status}, ${rows.length} payment row(s), collected ${collected.toFixed(2)}`;
  if (rows.length === 1 && Math.abs(collected - Number(total)) < 0.005) {
    pass('double-click Record payment collects once', detail);
  } else {
    fail('double-click Record payment collects once', `${detail} — the order was collected ${rows.length} times`);
  }
}

// --- 3 & 4. cross-tenant read and write -------------------------------------

{
  // An order belonging to a DIFFERENT company. Passed in rather than guessed,
  // because a probe that silently finds nothing to test must not report PASS.
  const foreign = process.env.POS_FOREIGN_ORDER_ID;
  if (!foreign) {
    fail('cross-tenant access is refused', 'SKIPPED — set POS_FOREIGN_ORDER_ID to an order id owned by another company. A skipped isolation check is not a pass.');
  } else {
    const read = await call('GET', `/api/orders/${foreign}`, { token: TOKEN });
    if (read.status === 403 || read.status === 404) pass('cross-tenant read is refused', `HTTP ${read.status}`);
    else if (read.status === 200) fail('cross-tenant read is refused', 'HTTP 200 — another company\'s order was returned');
    else fail('cross-tenant read is refused', `HTTP ${read.status} — expected 403 or 404, got something else: ${JSON.stringify(read.body).slice(0, 160)}`);

    const write = await call('POST', `/api/orders/${foreign}/bill`, { token: TOKEN });
    if (write.status === 403 || write.status === 404) pass('cross-tenant write is refused', `HTTP ${write.status}`);
    else fail('cross-tenant write is refused', `HTTP ${write.status} — expected 403 or 404: ${JSON.stringify(write.body).slice(0, 160)}`);
  }
}

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
