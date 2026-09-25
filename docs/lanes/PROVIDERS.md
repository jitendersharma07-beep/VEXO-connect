# Lane evidence — provider integrations (`x/providers`)

Date: 2026-09-24, revised 2026-09-25. Scope: Swiggy, Zomato, Reelo, TallyPrime.
Nothing in this lane has been merged, pushed, deployed, or pointed at a live
provider account.

The 2026-09-25 revision exists because five conclusions in the first one were
challenged and four of them turned out to be wrong. Each is retracted in place
rather than quietly overwritten — §9 lists them, because a build record that
hides its own corrections is not evidence of anything.

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
| `2d39142` | Say which commit the recorded test results were measured against |
| `57d08f6` | Record the owner's push decision and the command it needs |

Head at the start of the 2026-09-25 revision:
`57d08f641c26a272e68be624c53d210e4741908a`. `34be0c7` is the last commit of the
first revision that changes code — `f8af80e`, `2d39142` and `57d08f6` touch
documents only.

The 2026-09-25 revision then added these:

| SHA | Subject |
|---|---|
| `df400a8` | Keep a cancellation that arrives before the order it cancels |
| `22fdadd` | Ask Tally what happened instead of sending the voucher twice |
| `a6aa858` | Stop the settings screen taking credit for what Zomato offers |
| `a4de95d` | Leave the database as the next test file expects to find it |

Every figure in §5 was measured against the tree those four commits contain, with
this document and `INTEGRATION-VERIFICATION.md` as the only uncommitted files at
the time — both documents, so the recorded results describe the code as shipped.
The final commit of the revision is this document and cannot state its own SHA.

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

Line counts are as of the 2026-09-25 revision.

```
backend/src/lib/integrations/providers.js        585   the registry and its CONTRACT vocabulary
backend/src/lib/integrations/accounting.js       565   Tally postings, ack parsing, duplicate bar
backend/src/lib/integrations/loyaltyImport.js    436   resumable file import + exceptions
backend/src/lib/integrations/aggregatorOrders.js 424   provider order -> existing order ledger
backend/src/lib/integrations/loyalty.js          317   lookup / redeem / reverse / sale return
backend/src/lib/integrations/worker.js           329   outbound queue runner
backend/src/lib/integrations/hooks.js            214   where the rest of the POS calls in
backend/src/lib/integrations/lanHost.js          195   is this destination actually on the LAN
backend/src/lib/integrations/events.js           189   inbound event de-duplication
backend/src/lib/integrations/index.js            174   adapter registry + test override
backend/src/lib/integrations/queue.js            167   backoff, locking, DEAD
backend/src/lib/integrations/secrets.js          139   credential sealing
backend/src/lib/integrations/http.js             108   ProviderCallError and retry classification
backend/src/lib/integrations/adapters/tally.js   525   XML envelopes, Day Book lookup, lost-ack recovery
backend/src/lib/integrations/adapters/zomato.js  272   order pull, menu snapshot, outlet state
backend/src/lib/integrations/adapters/reelo.js   271   lookup, redeem, reverse, return
backend/src/lib/integrations/adapters/testAdapters.js 222 the deterministic stand-ins
backend/src/lib/integrations/adapters/index.js    50   adapter lookup by provider key
backend/src/lib/integrations/adapters/swiggy.js    49   refuses every call, and says why
backend/src/api/routes/integrations.js           940   the portal's API
backend/src/api/routes/loyalty.js                400   till-facing loyalty
backend/src/api/routes/integrationWebhooks.js    377   inbound callbacks (raw body)
backend/tests/integrations.test.js              2947   119 tests
frontend/src/pages/Integrations.jsx             1128   the portal screen
backend/prisma/migrations/20260924900000_providers_integration_framework/
backend/prisma/migrations/20260924910000_providers_import_resume/
backend/prisma/migrations/20260925100000_providers_out_of_order_placement/
```

`adapters/swiggy.js` is 49 lines because it implements nothing. It exists so that
switching Swiggy on fails at one readable place with one reason, instead of
failing somewhere further in with a null.

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

The gate is the whole suite, not this lane's file. Running one file is what the
first revision reported as "the full suite", and it hid a failure that broke 17
of the other 22 files — see §9 item 6.

```
bash /home/atc-noc/vcx-providers-local/vcxp test
```

See §5.1 for the recorded result.

This lane's own file, for iteration:

```
bash /home/atc-noc/vcx-providers-local/vcxp test tests/integrations.test.js
```

A name filter is available — `vcxp test tests/integrations.test.js -t 'pattern'`,
note **one** `-t`, not `-- -t` — but no figure from a filtered run is recorded
here, and one should not be trusted. Several `describe` blocks build their
fixtures in a `beforeAll` that depends on a connection created by an earlier
*test*; filter that test out and the block dies with `Cannot read properties of
null (reading 'id')`. Those failures are artifacts of the filter, not defects,
which makes a filtered run useless as evidence in either direction.

### Browser acceptance — ACCEPTED

```
node /home/atc-noc/vcx-providers-local/shootIntegrations.mjs /tmp/vcx-integrations-shots4
```

→ **62 passed, 0 failed. 8 distinct screenshots.** 56 of those checks are the
first revision's; the six added in this one cover the two honesty defects the
screenshots themselves exposed (§9 items 8 and 9).

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

→ **REHEARSAL: PASS — 22 of 22 assertions, exit status 0.** Covers all three
migrations, applied to a populated database, with migration 3's backfill
rehearsed in a stage of its own against `AggregatorOrder` rows whose `createdAt`
is deliberately spread over nine days. Also proves the migrated populated
database matches `schema.prisma` with an empty diff.

The 2026-09-24 **PASS (12 checks)** it replaces was real but measured before
migration 3 existed, and the script as it then stood could not have covered
migration 3 even if re-run — it stripped only the two migrations it knew about,
so stage A would have retained a migration depending on a table stage A never
creates. Reviewing the script for isolation before running it also found that the
scratch connection string was built by an unguarded `sed`, which on a
non-matching `DATABASE_URL` would have silently migrated the lane's real
database while still reporting PASS. A guard now refuses to run in that case and
is the first line of output.

Full observed output, the independently re-queried backfill table, the isolation
review and the schema-agreement diff are in `docs/INTEGRATION-VERIFICATION.md` §6.

### Schema drift — ACCEPTED

```
bash /home/atc-noc/vcx-providers-local/vcxp migsql
```

→ `-- This is an empty migration.` No drift.

### Frontend build — ACCEPTED

```
bash /home/atc-noc/vcx-providers-local/vcxp build
```

→ 1681 modules in 5.54s, `dist/assets/index-rDFyA5u7.js` 1,329.22 kB
(gzip 259.20 kB), `index-DNGwnlJK.css` 40.67 kB (gzip 7.54 kB).

The hash is load-bearing evidence, not decoration. It moved
`C-5KaRTN → 03I3UPMH → rDFyA5u7` across the two UI fixes in §9, which is how the
page the browser harness rendered is demonstrably the page that was edited.

### 5.1 Recorded run

| | |
|---|---|
| Full suite | **Test Files 23 passed (23) · Tests 747 passed (747)** · `SUITE_EXIT=0` · Duration 899.80s |
| When | 2026-09-25 04:12:32 → 04:27:37 UTC |
| This lane's file within it | `tests/integrations.test.js` — **119 tests**, 683.24s |
| 100,000-row import | 671.89s for the test, the import itself 599.0s at 167 rows/s, in `vcx_providers_test` — 75% of the suite's runtime |
| Code under test | `backend/src` `d527c4b`, `backend/tests` `7f9e4bc`, `backend/prisma` `36e8deb`, at `HEAD` `142f67b` — recorded in the log's own header, before and after |
| Log | `/tmp/vcxp-bound-gate.log` |

**Why this run exists at all.** The previous revision's evidence was the run
logged at `/tmp/vcxp-full-gate2.log` — same 23/23 and 747/747, in 676.76s, with
the 100k import at 461.4s and 217 rows/s. Nothing was wrong with the result. What
was wrong was the binding: it was argued from file modification times, and an
mtime says nothing about content. This run was launched only to capture the git
object hashes of the source it read, before and after, so the numbers name the
bytes they were measured against. `INTEGRATION-VERIFICATION.md` §6.1 carries that
argument in full, including the reason its closing `git diff HEAD` says DIRTY —
these two documentation files were being edited while the suite ran;
`git diff HEAD -- backend/` is empty and the three subtree hashes are unchanged.

The 223s spread between the two runs is wall clock on a shared box, not a code
change: the source hashes are identical and the slow part is one Postgres instance
doing 100,000 inserts. Throughput here is a measurement, not a guarantee.

The run before *both* of those, at the same commit, was **Test Files 17 failed | 6
passed (23) · Tests 238 passed | 509 skipped (747)** in 564.55s. Every one of the
23 errors was a foreign-key violation on
`IntegrationOutlet_branchId_companyId_fkey` or
`LoyaltyOperation_customerId_companyId_fkey`, raised inside *other* files'
cleanup. All three figures are kept because the failing one is what the first
revision would have reported had it run the suite, and the gap between them is the
whole value of running it. Cause and fix in §9 item 6.

---

## 6. Migration, rollback and recovery

Three migrations, applied in order:

1. `20260924900000_providers_integration_framework` — 5 enums, 12 tables, and
   the three `Order` columns.
2. `20260924910000_providers_import_resume` — the import cursor and exception
   table.
3. `20260925100000_providers_out_of_order_placement` — one column:
   `AggregatorOrder.placementReceivedAt`.

Migration 3 adds the column nullable and then **backfills it**, which is the
opposite of what "nullable, so no backfill needed" would suggest and is the point
worth reading. Null on this column is not "unknown" — it means "a state change
for this order arrived before the order did, and this row records a state rather
than an order we have seen". Every row that existed before the migration was
created by a placement, so leaving them null would have made every historical
order look like a shell. They are set to their own `createdAt`, in the same
migration, so there is no instant at which a real order reads as one.

It deliberately carries **no index**. A partial index is the obvious thing to
want here and was left out on purpose: Prisma's schema language cannot express
one, so the migration would carry DDL the schema cannot describe and `vcxp
migsql` would report drift forever — at which point the drift gate stops being
able to detect a real mistake. The only query that filters on the column is the
daily reconciliation, already bounded by `companyId` and `connectionId`. The
migration file says all of this, so the next person does not "fix" it.

`AccountingPosting.externalMasterId`, `externalVoucherKey` and `acknowledgedAt`
are **not** new here — they arrived with migration 1. The Tally recovery path
described below finally writes the first of them; until 2026-09-25 it was a
column nothing populated.

**Forward compatibility.** `Order.channel` is `NOT NULL DEFAULT 'POS'`, so
existing rows backfill to the value that describes them and no application code
has to handle a null channel. Rehearsed against a populated database — see §5.

**Rollback.** Dropping the three migrations drops only this lane's tables plus the
three `Order` columns; no pre-existing column is altered or dropped, so a
rollback loses integration state and nothing else. Orders, payments, invoices
and customers are untouched by all three migrations.

**Recovery.** Outbound work is durable in `IntegrationJob`. A process restart
resumes it: `lockedAt`/`lockedBy` expire after `LOCK_TIMEOUT_MS = 5 min`, so a
job locked by a process that died is picked up by the next runner rather than
being stranded. A job that exhausts `maxAttempts` (8) becomes `DEAD` and waits
for a person — it is never dropped and never retried forever.

**Import recovery.** A `LoyaltyImportRun` holds the last committed row. An import
killed at row 40,000 of 100,000 resumes at 40,001; it does not restart, and it
does not re-apply the rows it already committed.

**Recovery from a lost Tally acknowledgement.** A retry is only safe when
something outside this process can tell the two attempts apart, and for Tally
nothing can: it has no idempotency key and it accepts the same voucher twice.
So when a Tally import call is sent but no answer comes back, the adapter does
not retry — it asks Tally what happened, by exporting the `Day Book` for the
voucher's own date and looking for the voucher number.

| Found in the Day Book | The job succeeds. Nothing is resent, and the master id from the export is written to `AccountingPosting.externalMasterId`. |
|---|---|
| Not found | The job is **parked**, not retried: `kind: 'TERMINAL'`, so the queue stops and a person decides. An export that omits a voucher is not proof the voucher is absent. |
| The export call also fails | No verdict is reached. The original error stands and ordinary backoff applies. |

The distinction that keeps this from turning every network blip into manual work
is whether the request ever arrived. `ECONNREFUSED`, `EHOSTUNREACH`,
`ENETUNREACH`, `ENOTFOUND` and `EAI_AGAIN` all mean nothing was delivered, so
those keep plain automatic retry — a back-office PC rebooting recovers by itself.
A timeout does not mean that, and is treated as ambiguous.

**No exactly-once claim is made for Tally.** See §9 for what the first revision
claimed here and why it was wrong.

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

The single consolidated list of everything needed from outside this repo is
`docs/INTEGRATION-VERIFICATION.md` §7. It is not duplicated here, so the two
cannot drift. This table is what the *lane* did not do.

| Status | Item |
|---|---|
| **BLOCKED** | Swiggy's wire contract. A merchant/POS route is attested to exist and is in commercial use through middleware; what is missing is the published request/response shapes and partner onboarding. Corrected from the first revision — see §9. |
| **BLOCKED** | Every provider credential. These are issued to the restaurant, not the POS vendor, and none were supplied. |
| **BLOCKED** | Reelo's real export format — the importer's column mapping is written to the documented shape and unconfirmed against a real file. |
| **BLOCKED** | Reelo's auth-header scheme — needs written confirmation. |
| **BLOCKED** | Tally voucher reconciliation against a real TallyPrime instance; credit-note, receipt, purchase, GST and cost-centre tags need an XML export of a real voucher before those posting types are enabled. |
| **RESOLVED** | The remote's visibility. **It is public**, confirmed against GitHub repository metadata — see §8.1. Previously recorded BLOCKED; no longer. The consequence is recorded with it: the branch and its full diff become permanently world-readable on push. |
| **NEEDS OWNER** | Live activation of anything. Production activation, live financial transactions, real-customer bulk imports and external messages are reserved to the owner. |
| **NEEDS OWNER** | `git push` — see §8.1. The commits are local on `x/providers` and have not been pushed. |
| **NOT DONE** | The portal screen does not render `IntegrationDiscrepancy`. The rows are created, the API returns them, and the tests assert on them — but an operator cannot see one without calling the API. This is the largest functional gap in the UI and the most likely thing to be mistaken for "no discrepancies exist". |
| **NOT DONE** | Zomato menu, price, stock and outlet push. The provider **does** offer these with published semantics — the first revision said otherwise and §9 retracts it. They are unimplemented here and their descriptors are recorded as `notImplementedHere`, which is a different and smaller statement than `NOT_OFFERED`. |
| **NOT DONE** | Zomato settlement and refund reconciliation. This one really is `NOT_OFFERED`: 51 pages of developer documentation contain no settlement endpoint, and the figures are dashboard downloads only. Re-confirmed in the 2026-09-25 recheck. |
| **RESOLVED** | The populated-database migration rehearsal. **Executed: 22/22, exit 0**, covering migration 3's backfill against rows and proving the migrated populated database matches `schema.prisma`. Previously recorded BLOCKED; no longer. Output in `docs/INTEGRATION-VERIFICATION.md` §6. |
| **NOT DONE** | Any provider sandbox call. No provider has been contacted. |
| **NOT DONE** | Duplicate stock consumption was not tested, because **this build has no stock or inventory engine**. `grep -in stock prisma/schema.prisma` finds only the `INVENTORY` permission-group name. The requirement is vacuous here, and is recorded rather than quietly ticked: if a stock engine lands later, the aggregator ingestion path must be re-verified against it. |
| **IMPLEMENTED-UNVERIFIED** | Every adapter. They match the published documentation and pass deterministic tests; that is not the same as a provider having accepted a request, and this lane does not claim it is. |

### 8.1 The push

**Superseded, 2026-09-25 08:3x UTC.** The earlier entry here recorded an owner
decision that the owner would push this branch rather than the lane, and kept the
command so it would not have to be reconstructed. The owner has since authorised
commit and push explicitly, so the lane performs it. Both states are left visible
rather than the first being deleted: an instruction that reversed is a fact about
the work, and a reader who finds only the later one cannot tell whether the
earlier restriction was lifted or forgotten.

The command, unchanged from when it was written down:

```
git -C /home/atc-noc/vexo-connect-x-lanes/providers push -u github x/providers
```

It creates a new remote branch and touches no existing one. Established against
the **live** remote, not a cache: the branches endpoint returns 25 branches and
`x/providers` is not among them. `x/integration`, which is, is the deploy/CI lane
(rate limiter, e2e scripts) and not this one — the two share no files, so the
similar name is not a collision.

The remote resolves through an SSH host alias:

```
github → git@github-vexo-connect:jitendersharma07-beep/VEXO-connect.git
         (HostName github.com, IdentitiesOnly yes)
```

A correction to this document's own previous figure: it said 26 branches, read
from `git branch -r`. That count was wrong — it included refs from two other
remotes (`origin`, a local bundle, and a stale `lab` namespace). Counting only
`refs/remotes/github` gives 25, which matches the live API list exactly, with no
branch present on one side and absent from the other. So the cache happened to be
accurate here; the point is that this was checked against the remote rather than
inferred from the cache, and the first attempt to infer it produced a wrong
number.

### The remote is public. This is now confirmed, not assumed.

Verified against GitHub's own repository metadata on 2026-09-25:

```
GET https://api.github.com/repos/jitendersharma07-beep/VEXO-connect
→ HTTP 200
  "private":    false
  "visibility": "public"
  "default_branch": "sprint/client-handover-rc"
  "pushed_at":  "2026-09-25T04:12:13Z"
```

The HTTP status is load-bearing on its own: GitHub returns **404** to an
unauthenticated caller for a repository that is private, so a 200 with a populated
body cannot be produced by a private repo. The two fields then say it outright.

This settles a claim that had been carried unverified through two revisions. The
first revision asserted the remote was public with no evidence; the second
withdrew the assertion because `git ls-remote` was refused here and an SSH alias
cannot reveal visibility — correctly, since the alias
`github-vexo-connect → github.com` gives the account and repository name and
nothing about who may read it. Authenticated metadata was not available either:
there is no `gh` CLI on this box, no `GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_PAT` in
the environment, no credential helper and no `~/.git-credentials`. The anonymous
endpoint answers the question anyway, and for the public case answers it
conclusively.

**What that means for the push.** `x/providers` and its full diff become readable
by anyone the moment it lands, permanently — a public repository cannot be
un-published, and deleting a branch does not remove it from forks, caches or
anyone who cloned in between. The diff has been scanned for credentials and
contains none — §8.2 records what that scan actually looked for and what it hit.
That is a separate question from who can read it, and the answer to the second one
is now: everybody.

Note also that the default branch is `sprint/client-handover-rc`, **not** `main`.
Anyone opening a pull request from this branch should check the base.

### 8.2 What the outgoing range was scanned for before it was published

The push publishes **13 commits / 39 files** — everything on `x/providers` not
already reachable from any `github` ref, `5b8d54d` through the head of this
branch. The range was materialised as a single diff
(`git diff $(git merge-base HEAD github/main)..HEAD`, 14,650 lines) and scanned
before the push rather than trusting a per-commit habit.

| Scanned for | Result |
|---|---|
| Provider/cloud key formats — `sk_live_`, `sk_test_`, `rzp_live_`, `rzp_test_…`, `AKIA…`, `ghp_…`, `github_pat_`, `xox[baprs]-`, `AIza…`, and `BEGIN … PRIVATE KEY` | none |
| Added lines assigning a literal to `password` / `secret` / `token` / `api_key` / `credential`, excluding `process.env`, zod schemas and placeholders | one hit, and it is UI copy: `'Replace credential'` / `'Store credential'` button text |
| Added string literals of 32+ opaque characters | 25 hits, all of them SQL identifiers in the migration — `CREATE UNIQUE INDEX "IntegrationConnection_companyId_provider_key"` and its siblings. The word `_key` in an index name is what matched |
| Tracked files whose *name* suggests a secret | `.env.example` (placeholders, pre-existing) and `backend/src/lib/integrations/secrets.js`, which is the sealing mechanism, not a secret |
| Where the sealing key comes from | `secrets.js:33` throws `CredentialSealError` when `POS_INTEGRATION_SECRET_KEY` is unset; AES-256-GCM with a random IV per seal. No default, no fallback, nothing embedded |

The long-literal check is the one worth keeping. It is deliberately over-broad —
it cannot tell an index name from an API key — and that is the property that makes
it useful: a scan tuned to produce no false positives would also be a scan that
misses a credential in a format nobody anticipated. 25 hits that all resolve to
DDL is a cheap result to read.

The range contains **no build output, no screenshots, no logs and no `.env`**.
The 39 files are backend source, one test file, the migrations, three frontend
files and the two documents.

### 8.3 Release content and the Docker build context

Checked for this lane's own deliverable, on the understanding that "not in the
shipped image" and "not in the build context" are different claims and the second
is the stronger one.

- **Backend.** `backend/.dockerignore` excludes `node_modules`, `tests`, `*.md`
  and `.env*`. No `.md` exists below `backend/`'s top level and no `.env*` exists
  anywhere in the backend context on disk, so docker's `*`-does-not-cross-a-slash
  behaviour has nothing to leak here. Checked rather than assumed, because that
  rule is exactly what made the frontend's `*.md` ineffective.
- **Frontend runtime image.** `frontend/Dockerfile.prod` builds with `COPY . .`
  and then its runtime stage copies only `dist/` and `nginx.conf` into
  `nginx:1.27-alpine`. So the 48 acceptance-only entries tracked under
  `frontend/docs/screens/` and `frontend/qa/` — 38 PNGs, `results-vc104.json`,
  `results-vc105.json`, the browser-QA runners — **do not reach the shipped
  image**. They do enter the build context and therefore an intermediate layer.
- **`frontend/.dockerignore` does not exist on this branch.** Confirmed by ref:
  absent on `x/providers`, absent on `github/main`, present only on
  `x/kitchen-integration`. It is new work from the VC-103 close-out, not something
  this lane dropped.
- **This lane adds none of it.** The 39 files above contain no image, no JSON
  result file and no build output. This lane's own acceptance screenshots were
  written to `/tmp/vcx-integrations-shots4`, outside the repository, and its logs
  to `/tmp`.

**Deliberately not fixed here.** The obvious move is to add a
`frontend/.dockerignore` to this branch. It is the wrong move: the VC-103 lane has
one, measured rather than reasoned — a throwaway `alpine` image whose only
instruction is `COPY . /ctx` counted 114 context entries, 48 of them
acceptance-only — and it is better than anything written from scratch here.
Adding a second version on this branch produces an **add/add conflict** on merge
over a file whose every line is a considered rule, with a real chance of the
measured version losing. The gap closes when `x/kitchen-integration` merges. That
is a dependency, recorded, not a defect in this lane.

### 8.4 The refund-ordering fix is VC-103's, and is not duplicated here

The close-out brief that authorised this push also asked for the
`REFUND_PAYMENT_INCLUDE` → `pickRefundLeg` ordering fix. It was already done,
committed and published before this lane was asked: `94e4b89` on
`x/kitchen-integration`, and `git ls-remote github` reports that branch at
`82283c0`, which contains it.

Read in full rather than taken from its subject line, because the defect it fixes
is precisely a commit whose message named an outcome its diff did not reach.
`72b11e0` gave `ORDER_INCLUDE.payments` a `[createdAt, id]` tie-break and
justified it on the refund path — but `pickRefundLeg`'s only call site never read
through `ORDER_INCLUDE`. It used a local `REFUND_PAYMENT_INCLUDE` that was a bare
`select:` with no `ORDER BY`, so the receipt's tender order became deterministic
while the half that moves money stayed at the query planner's discretion.
`94e4b89` moves the include into `lib/orders.js` beside its only consumers, adds
`orderBy: [{createdAt:'asc'},{id:'asc'}]`, and exports it so the rule can be
asserted as a declaration — which matters, because a behavioural test of a tie can
pass by luck whenever the planner happens to agree.

`[createdAt, id]` is a **total** order, which is the property the requirement
about equal timestamps needs: tied `createdAt` resolves on `id` instead of on heap
position.

This branch still carries the pre-fix copy, because it branched before it. That is
correct and it stays: `backend/src/api/routes/orders.js` and
`backend/src/lib/orders.js` are not this lane's files, and porting a one-line
change into a shared file that already has it elsewhere produces a conflict for
whoever merges and no behaviour that the merge would not deliver anyway.

One limitation worth carrying forward, since it belongs to the money path rather
than to either lane: the tie-break makes leg selection **reproducible, not
correct**. Ascending cuid follows the order rows were inserted locally; it is not
evidence of the order the provider captured the charges in. If Finance rules that
a tie should prefer "most headroom" or "oldest provider intent", that is a
different rule rather than a tuning of this one, and attributions already stored
under the current rule stay as they are.

---

## 9. What the first revision got wrong

Five conclusions from 2026-09-24 were challenged on 2026-09-25. Four were wrong
and one held. They are listed with the measurement that settled each, because
"we checked and it was fine" and "we never checked" read identically once the
sentence is deleted.

| # | The first revision said | Verdict | What settled it |
|---|---|---|---|
| 1 | Swiggy is not integrable; no partner POS API exists | **Wrong** | A POS/merchant route is attested by a former Swiggy API product manager and corroborated by middleware vendors selling it commercially. What is genuinely unpublished is the wire contract. "No first-party public documentation" was the only defensible part, and it does not imply impossibility |
| 2 | Zomato offers no menu, price, stock or outlet API | **Wrong** | The official POS developer documentation specifies all four, with semantics: full-snapshot menu upsert, a stock flag ignored on existing items, a provider-defined auto-on window, and bidirectional outlet offline. Now captured as `menuSemantics` |
| 3 | Zomato offers no settlement or refund API | **Held** | 51 documentation pages, zero settlement endpoints; the figures are dashboard downloads. `NOT_OFFERED` was correct |
| 4 | The `AccountingPosting` unique index makes Tally retries idempotent | **Wrong, and dangerous** | The index stops a second posting *row*; a retry reuses that row, so it does nothing about a second *send*, and Tally accepts the repeat. Proven by negative control: with the new recovery path disabled, an unanswered import came back `retryable: true` — the queue would have re-sent a real sale |
| 5 | Rejecting non-HTTP URL schemes establishes LAN-only access | **Wrong** | `8.8.8.8`, `tally.example.com`, `134744072`, `0x8080808` and `010.010.010.010` all got through. The WHATWG URL parser reads bare integers and hex and octal dotted-quads as IPv4 addresses. The positive controls written to prove the fix then found two further defects |

And two the *first* revision made about its own verification, found by this one:

| # | The first revision said | Verdict | What settled it |
|---|---|---|---|
| 6 | "Full suite — Test Files 1 passed (1)" | **Misleading** | That is one file, not the suite. The real suite is 23 files, and when it was finally run it failed **17 of them** — every one on a foreign-key violation from this lane's own residue. §5 now records both figures under their real names |
| 7 | "Migration rehearsal — ACCEPTED, 12 checks" | **Stale, and would not have run — now fixed and executed** | The PASS predated migration 3. Reading the script to re-run it showed it stripped only the two migrations it knew about, so its "before this lane" stage would have kept a migration depending on a table that stage never creates. Corrected, extended to rehearse the backfill against rows, and run: **22/22, exit 0**. The review that preceded the run found a second defect — an unguarded `sed` that on a non-matching `DATABASE_URL` would have migrated the lane's real database while still reporting PASS |

And two this revision *caused*, both found by looking at the page rather than at
the diff. They are listed because a correction that damages something else is the
failure mode a revision is least likely to notice in itself.

| # | What happened | What settled it |
|---|---|---|
| 8 | Re-grading Zomato's menu push `NOT_OFFERED → PATH_ONLY` was true about Zomato and made the **portal** dishonest: the screen renders only the grade, so an operator would read "menuPush PATH_ONLY" and wait for a menu that nobody has built to sync | The registry already carried `notImplementedHere` and `providerSummary` was dropping it, so it reached neither API nor page. Now rendered as its own panel — "Offered by Zomato, not built in VEXO Connect yet". A grade describes the provider; that line describes us |
| 9 | Zomato's outstanding-items panel was headed "Not operable" directly beneath a status badge reading CONNECTED | The heading was driven by `blockedReason`, while operability is decided by `operable`, and Zomato has both. The heading now follows `operable`. Paired with Swiggy's existing "Not operable" assertion so the other branch stays covered |

And one where the first revision turned out to be **right**, which is worth
recording for the same reason as the rest:

| # | The arc | Settled by |
|---|---|---|
| 10 | Revision 1 stated the remote is public, with no evidence. Revision 2 withdrew it as unverifiable from here. Revision 3 confirms it **is public** | GitHub repository metadata: HTTP 200 anonymous, `private: false`, `visibility: public`. Withdrawing it was still correct — an unevidenced claim that happens to be true is not a verified claim, and the route that settled it (the REST API) is not the route that had been tried and refused (`git ls-remote`). The lesson is about which tool answers the question, not about the answer |

And one about this document's own evidence, rather than about the code:

| # | What was claimed | Verdict | What settled it |
|---|---|---|---|
| 11 | The suite result belongs to the committed source, because no source file's modification time was newer than the log | **Not a binding** | An mtime is metadata about a file, not a function of its contents: `touch` moves it without changing a byte, and a write that preserves it changes bytes without moving it. Replaced by git object hashes of `backend/src`, `backend/tests` and `backend/prisma`, captured in the log's own header before and after a fresh full run. Those are SHA-1s of content, so they name the bytes; and unlike a whole-tree `git diff`, they survive the documentation commit that describes them |

Item 6 is the reason this section exists at all. A gate that is named after
something broader than what it ran will pass forever. Item 11 is the same failure
one level up: evidence that is named after the thing it cannot actually
demonstrate.
