# Lane evidence — provider integrations (`x/providers`)

Date: 2026-09-24. Scope: Swiggy, Zomato, Reelo, TallyPrime.
Nothing in this lane has been merged, pushed, deployed, or pointed at a live
provider account.

The per-provider verdict and the blocked list live in
`docs/INTEGRATION-VERIFICATION.md`. This document is the lane's build record.

---

## 1. Revision

| | |
|---|---|
| Worktree | `/home/atc-noc/vexo-connect-x-lanes/providers` |
| Branch | `x/providers` |
| Base HEAD | `1c7e8e631762761d9f85bb4b6726aa693cb9a518` |
| Test database | `vcx_providers_test` on 127.0.0.1:5440 (lane-private) |
| Runner | `/home/atc-noc/vcx-providers-local/vcxp` |

### Commits

| SHA | Subject |
|---|---|
| `5b8d54d` | Keep the test lock alive past 300s, and stop describing another lane's database |
| `63b0766` | Provider integrations: Swiggy, Zomato, Reelo and Tally, with what each refuses |
| `34be0c7` | A settings screen that shows what each provider will not do |
| `f8af80e` | Record what was verified, by what command, and what is still unknown |

`34be0c7` is the last commit that changes code. Everything in §5 was executed
against that tree state; `f8af80e` adds these two documents and nothing else, so
the recorded results describe the shipped code and not an earlier draft of it.

### Modified tracked files (10)

```
backend/prisma/schema.prisma       | 722 +++  models/enums appended under // ==== LANE providers ====
backend/src/api/routes/kitchen.js  |   6 +    aggregator tickets reach the existing KDS
backend/src/api/routes/orders.js   |  26 ++   channel/provider fields on the existing order read
backend/src/app.js                 |  45 ++-  three router mounts + the raw-body webhook mount
backend/src/config/env.js          |  42 ++   POS_INTEGRATION_SECRET_KEY and worker knobs
backend/src/index.js               |   7 +    outbound worker start/stop on the existing lifecycle
backend/src/lib/permissions.js     |  46 ++-  8 integration actions + 2 loyalty actions
backend/tests/globalSetup.js       | 118 ++-  defect J (heartbeat) + a corrected false premise
frontend/src/App.jsx               |  14 +    /integrations route behind RequireAction
frontend/src/components/Layout.jsx |  10 +    nav entry gated on integration.read
```

### New files

```
backend/src/lib/integrations/providers.js        516   the registry and its CONTRACT vocabulary
backend/src/lib/integrations/accounting.js       565   Tally postings, ack parsing, duplicate bar
backend/src/lib/integrations/loyaltyImport.js    436   resumable file import + exceptions
backend/src/lib/integrations/aggregatorOrders.js 324   provider order -> existing order ledger
backend/src/lib/integrations/loyalty.js          317   lookup / redeem / reverse / sale return
backend/src/lib/integrations/worker.js           316   outbound queue runner
backend/src/lib/integrations/hooks.js            214   where the rest of the POS calls in
backend/src/lib/integrations/events.js           188   inbound event de-duplication
backend/src/lib/integrations/index.js            174   adapter registry + test override
backend/src/lib/integrations/queue.js            167   backoff, locking, DEAD
backend/src/lib/integrations/secrets.js          139   credential sealing
backend/src/lib/integrations/http.js             100   ProviderCallError and retry classification
backend/src/api/routes/integrations.js           940   the portal's API
backend/src/api/routes/loyalty.js                400   till-facing loyalty
backend/src/api/routes/integrationWebhooks.js    307   inbound callbacks (raw body)
backend/tests/integrations.test.js              2246   80 tests
frontend/src/pages/Integrations.jsx             1128   the portal screen
backend/prisma/migrations/20260924900000_providers_integration_framework/
backend/prisma/migrations/20260924910000_providers_import_resume/
```

---

## 2. Data model

Appended at the end of `schema.prisma` under `// ==== LANE providers ====`, plus
three columns on the existing `Order`.

| Model | Holds | Key constraint |
|---|---|---|
| `IntegrationConnection` | One provider per company: config, sealed credential, last check, last success, last error | unique `(companyId, provider)` |
| `IntegrationOutlet` | Provider outlet ↔ branch, explicitly | unique `(connectionId, externalOutletId)` |
| `IntegrationEvent` | Every inbound callback, raw | unique `(connectionId, externalEventId)` — **this is the duplicate bar** |
| `IntegrationJob` | Outbound work: attempts, backoff, lock, DEAD | unique `dedupeKey` |
| `IntegrationDiscrepancy` | What a human must decide | `(connectionId, kind, externalRef)` |
| `AggregatorOrder` | Provider order ↔ our order | unique `(connectionId, externalOrderId)` |
| `LoyaltyProfileLink` | Customer ↔ provider profile + balance snapshot | unique `(companyId, provider, externalCustomerId)` and `(companyId, customerId, provider)` |
| `LoyaltyOperation` | Redeem / reverse / return, once each | unique `(connectionId, idempotencyKey)` |
| `LoyaltyImportRun` | A file import, resumable | cursor = last committed row |
| `LoyaltyImportException` | Rows that could not be imported, with a reason | — |
| `AccountingPosting` | One document, once | unique `(connectionId, sourceType, sourceId, docType)` |
| `AccountingLedgerMap` | Our names ↔ the client's Tally ledgers | `(connectionId, kind, key)` |

`Order` gains `channel` (`NOT NULL DEFAULT 'POS'`), `channelProvider`, and
`externalOrderId`. **No parallel money ledger.** Aggregator orders are ordinary
orders with a channel marker, so existing sales reports, day close and
reconciliation see them without modification.

Money stays `DECIMAL(10,2)` rupees in the database with integer-paise
arithmetic via the existing `lib/money.js`. Nothing in this lane re-implements
money.

---

## 3. API

All under `requireAction`, never a bare role check. The server re-judges every
request; the portal's hiding is presentation only.

### `/integrations` (portal)

| Method | Path | Action |
|---|---|---|
| GET | `/providers` | `integration.read` |
| GET | `/:provider` | `integration.read` |
| PUT | `/:provider` | `integration.configure` |
| PUT | `/:provider/credential` | `integration.credential.write` |
| POST | `/:provider/test` | `integration.test` |
| PUT | `/:provider/outlets` | `integration.outlet.map` |
| GET | `/:provider/jobs` | `integration.read` |
| POST | `/:provider/jobs/:jobId/retry` | `integration.job.retry` |
| GET | `/:provider/discrepancies` | `integration.read` |
| POST | `/:provider/discrepancies/:id/resolve` | `integration.discrepancy.resolve` |
| GET | `/:provider/reconciliation` | `integration.read` |
| GET / PUT | `/TALLY/ledgers` | `integration.read` / `integration.configure` |
| GET | `/TALLY/postings` | `integration.read` |
| POST | `/TALLY/sweep` | `integration.job.retry` |
| POST | `/REELO/import` | `integration.import.run` |
| GET | `/REELO/import/:runId` | `integration.read` |
| GET | `/audit/trail` | `integration.read` |

`/audit/trail` exists as its own endpoint because `/reports/activity` cannot
serve it: that route selects discount, void and refund actions only and gates on
**role**, so a Finance user who may read integrations would be refused there.
Its `meta` projection is an **allow-list**, not a pass-through — `meta` is a JSON
column that any future action can write into, and "we checked at the time" does
not survive the next person adding a field.

### `/loyalty` (till)

| Method | Path | Action |
|---|---|---|
| POST | `/lookup` | `loyalty.lookup` |
| GET | `/orders/:orderId/customer` | `loyalty.lookup` |
| POST | `/otp` | `loyalty.redeem` |
| POST | `/orders/:orderId/redeem` | `loyalty.redeem` |
| GET | `/orders/:orderId` | `loyalty.lookup` |

### `/integration-webhooks/:provider/:connectionId` (inbound)

Raw body, mounted before the JSON parser. **Not** behind session auth — it
authenticates on the provider's own documented scheme (for Zomato, a shared
header compared in constant time, because Zomato publishes no signature
scheme). Unknown connection, wrong secret and malformed body are all refused
without revealing which.

---

## 4. Role matrix

Generated from `lib/permissions.js`, not written by hand.

| Action | SUPER | OWNER | COMP_ADMIN | FINANCE | REGIONAL | BRANCH_MGR | CASHIER | AUDITOR |
|---|---|---|---|---|---|---|---|---|
| `integration.read` | Y | Y | Y | Y | Y | Y | · | Y |
| `integration.configure` | Y | Y | Y | · | · | · | · | · |
| `integration.credential.write` | Y | Y | Y | · | · | · | · | · |
| `integration.test` | Y | Y | Y | · | · | · | · | · |
| `integration.outlet.map` | Y | Y | Y | · | · | · | · | · |
| `integration.job.retry` | Y | Y | Y | · | Y | Y | · | · |
| `integration.discrepancy.resolve` | Y | Y | Y | Y | · | · | · | · |
| `integration.import.run` | Y | Y | Y | · | · | · | · | · |
| `loyalty.lookup` | Y | Y | Y | · | · | · | Y | · |
| `loyalty.redeem` | Y | Y | Y | · | · | · | Y | · |

The two deliberate shapes: a **CASHIER holds no `integration.*` action at all**
(the till redeems points; it does not configure providers), and **FINANCE and
BRANCH_MANAGER hold different halves** — Finance resolves discrepancies, a store
manager retries stuck work. Both reach the screen and each sees a different one.

---

## 5. Test evidence

### Backend suite — ACCEPTED

```
bash /home/atc-noc/vcx-providers-local/vcxp test tests/integrations.test.js
```

See §5.1 for the recorded result of the run this document was written against.

The 100,000-row scale test runs **only in the full suite** and dominates its
duration. The fast subset, for iteration:

```
bash /home/atc-noc/vcx-providers-local/vcxp test tests/integrations.test.js -- -t '^(?!.*holds 100)'
```

→ **79 passed | 1 skipped (80)** in 12.35s.

### Browser acceptance — ACCEPTED

```
node /home/atc-noc/vcx-providers-local/shootIntegrations.mjs /tmp/vcx-integrations-shots
```

→ **56 passed, 0 failed. 8 distinct screenshots.**

| Screenshot | Shows |
|---|---|
| `owner-01-cards.png` | Four providers in four genuinely different states |
| `owner-02-swiggy-blocked.png` | A provider that cannot be switched on, and no form at all |
| `owner-03-tally-error.png` | ERROR, "Last successful sync: Never", a DEAD job, per-row retry |
| `owner-04-reelo-import.png` | Preview-first import with the preservation statement above the file picker |
| `owner-05-zomato-audit.png` | Seeded outlet mapping, queue, audit trail with actor and role |
| `manager-01-tally-readonly.png` | Retry buttons present; no Test, Settings, Credential or Save mapping |
| `manager-02-reelo-no-import.png` | The import section absent for a role without `integration.import.run` |
| `finance-01-tally-readonly.png` | The failure readable; **no** retry buttons |

The harness renders the **real built bundle** over a fixture transport, because
the states worth looking at (a CONNECTED provider, a DEAD job) cannot be produced
without calling a provider. The drift-sensitive half is not fixtured: it imports
the backend's own `providerSummary` and `baselineFor`, so a capability list or
field descriptor that changes in the registry changes in the page under test.

Every negative assertion has a paired positive control. `ERROR is red` is
checked against `NOT_CONFIGURED is not red` and the two being different colours,
so it cannot pass by the page painting everything red.

### Migration rehearsal — ACCEPTED

```
bash /home/atc-noc/vcx-providers-local/rehearseMigration.sh
```

→ **REHEARSAL: PASS** (12 checks). Detail in
`docs/INTEGRATION-VERIFICATION.md` §6.

### Schema drift — ACCEPTED

```
bash /home/atc-noc/vcx-providers-local/vcxp migsql
```

→ `-- This is an empty migration.` No drift.

### Frontend build — ACCEPTED

```
bash /home/atc-noc/vcx-providers-local/vcxp build
```

→ 1681 modules, `dist/assets/index-C-5KaRTN.js` 1,328.14 kB (gzip 259.03 kB),
`index-DdJ0Xfl7.css` 40.58 kB.

### 5.1 Recorded run

| | |
|---|---|
| Full suite | **Test Files 1 passed (1) · Tests 80 passed (80)** · Duration 611.48s |
| 100,000-row import | 528.4s, 189 rows/s, in `vcx_providers_test` — 86% of the suite's runtime |
| Code under test | `34be0c7` (see §1) |

---

## 6. Migration, rollback and recovery

Two migrations, applied in order:

1. `20260924900000_providers_integration_framework` — 5 enums, 12 tables, and
   the three `Order` columns.
2. `20260924910000_providers_import_resume` — the import cursor and exception
   table.

**Forward compatibility.** `Order.channel` is `NOT NULL DEFAULT 'POS'`, so
existing rows backfill to the value that describes them and no application code
has to handle a null channel. Rehearsed against a populated database — see §5.

**Rollback.** Dropping the two migrations drops only this lane's tables plus the
three `Order` columns; no pre-existing column is altered or dropped, so a
rollback loses integration state and nothing else. Orders, payments, invoices
and customers are untouched by both migrations.

**Recovery.** Outbound work is durable in `IntegrationJob`. A process restart
resumes it: `lockedAt`/`lockedBy` expire after `LOCK_TIMEOUT_MS = 5 min`, so a
job locked by a process that died is picked up by the next runner rather than
being stranded. A job that exhausts `maxAttempts` (8) becomes `DEAD` and waits
for a person — it is never dropped and never retried forever.

**Import recovery.** A `LoyaltyImportRun` holds the last committed row. An import
killed at row 40,000 of 100,000 resumes at 40,001; it does not restart, and it
does not re-apply the rows it already committed.

---

## 7. Test-harness change: `globalSetup.js`

Two things, recorded because the file is shared with other lanes.

**Defect J — the advisory lock was being lost silently.** Prisma retires the
pooled connection at roughly 300s of wall clock, and the session-scoped advisory
lock dies with it. The 100,000-row test runs for ~528s, so the lock was being
released mid-run and a second run could have started on the same database. Fixed
with a 10s heartbeat that re-takes the lock if it has been lost and exits if
another run holds it. **Observed working during the recorded run:**

```
[test-db-lock] acquired as vcx-test-lock:445024
[test-db-lock] lock session was retired by the pool and the lock has been re-taken — no other run intervened
```

**A false premise, corrected.** The file arrived here as a copy of the merge
worktrees' version and described *their* database: it stated that this worktree
has no private database and shares `vcx_foundation_test`. It does not — `vcxp`
pins `TEST_DATABASE_URL` to `vcx_providers_test`, and every lane runner on this
box names its own. The load-bearing part was the **operator-facing timeout
message**, which told whoever hit it to go looking through other people's
worktrees for a lock holder that cannot be there. The key is unchanged (advisory
locks are database-scoped, verified, so lanes sharing a key never contend) and
the comment now says that is a convention rather than a requirement.

---

## 8. Limitations / not done / needs owner input

| Status | Item |
|---|---|
| **BLOCKED** | Swiggy in its entirety — no public partner POS API exists. Not a code problem. |
| **BLOCKED** | Every provider credential. These are issued to the restaurant, not the POS vendor, and none were supplied. |
| **BLOCKED** | Reelo's real export format — the importer's column mapping is written to the documented shape and unconfirmed against a real file. |
| **BLOCKED** | Reelo's auth-header scheme — needs written confirmation. |
| **BLOCKED** | Tally voucher reconciliation against a real TallyPrime instance; credit-note, receipt, purchase, GST and cost-centre tags need an XML export of a real voucher before those posting types are enabled. |
| **NEEDS OWNER** | Live activation of anything. Production activation, live financial transactions, real-customer bulk imports and external messages are reserved to the owner. |
| **NEEDS OWNER** | `git push`. The lane rules forbid it and the task conditioned it on authorization; the work is committed locally on `x/providers` and has not been pushed. |
| **NOT DONE** | Zomato menu push and settlement statement import — `NOT_OFFERED` in the registry; there is no documented API for either. |
| **NOT DONE** | Any provider sandbox call. No provider has been contacted. |
| **IMPLEMENTED-UNVERIFIED** | Every adapter. They match the published documentation and pass deterministic tests; that is not the same as a provider having accepted a request, and this lane does not claim it is. |
