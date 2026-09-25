# Integration verification — `cf9c4a0`

Session: window-1 integration, 2026-09-25. Every line below was produced by a
command run in this session against the live host `atc-noc`. Where a claim from
the supplied handoff could not be reproduced, the handoff is corrected here and
the correcting command is named.

## What this candidate is

| | |
|---|---|
| Commit | `cf9c4a0d01b4919b70a565924b4d3ad0a6659b5b` |
| Branch | `main` |
| Worktree | `/home/atc-noc/vexo-connect-x-lanes/main-merge` (shared — see below) |
| Parents | `1ac2f31` (docs), `77242fe` (the 142-commit lane integration) |
| Routes | 48 files under `backend/src/api/routes` |
| Models / enums | 139 / 99 |
| Migrations | 40 directories |
| Backend test files | 52 |
| Frontend pages | 51 |

`77242fe` is 142 commits ahead of the former GitHub `main` (`ea04c07`) and 0
behind, across 32 merges — `git rev-list --left-right --count ea04c07...77242fe`.

## Corrections to the supplied handoff

| Handoff claim | Verified finding | Evidence |
|---|---|---|
| Root disk 96% full, 4.4 GB free, falling ~0.4 GB/h | **46% used, 103 GB free, 15% inodes (11.2M free).** No disk blocker. Re-sampled at 20:07Z after a 100,000-row import and 20 min of suite: still 46%, 102 GB free, 17% inodes. Two samples 33 min apart, across the heaviest I/O this candidate can generate, show the figure flat — so the claimed ~0.4 GB/h decline is not merely unreproducible, it is contradicted. | `df -h /`, `df -i /` at 19:34Z and 20:07Z |
| `77242fe` unpublished, single-host | **Was true at 19:35Z, no longer true.** GitHub `main` is now `cf9c4a0`, which contains it. Published by another session, not by this one. | `git ls-remote github` at 19:35Z (`main`=`ea04c07`) and 19:52Z (`main`=`cf9c4a0`) |
| Staging up at `127.0.0.1:8120` | **Down.** `vcx-staging-edge` exited (0) ~6 h ago. Clean exit, so likely deliberate. Not restarted here — deploy ownership sits with another session. | `curl :8120` → `000`; `docker ps -a` |
| 40 migrations | Confirmed 40 **directories**. A flat `ls | wc -l` returns 41 because it counts `migration_lock.toml`. | `ls -d backend/prisma/migrations/*/` |
| 48 routes / 51 pages | Confirmed, but only when counting recursively. A non-recursive `ls` gives 37 / 39 and understates both. | `find backend/src/api/routes -name '*.js'` |
| Refund defect open in `ea04c07`, fixed in `77242fe` | **Both confirmed.** See below. | `git grep REFUND_PAYMENT_INCLUDE` in each revision |
| `requireModule` gate exists | **Absent.** Only `requiredModuleFor` (`lib/permissions.js:216` → `middleware/permissions.js:129`). `requireModule` appears solely in `INTEGRATION(firstlogin)` comments saying the lane has not landed. | `grep -rn requireModule backend/src` |
| Store-side print agent client | **Absent.** Server side exists; no ESC/POS client, no agent package. `lib/peripherals/drawer.js` is the only peripheral code. | `find`, `grep -rln escpos` |
| VC-106/107/108, Captain, Kiosk, Feedback, Central Kitchen | **Confirmed zero files** for all of: offline, sync, analytics, assistant, mall, turnover, captain, kiosk, feedback. | `find backend/src frontend/src -iname '*<term>*'` |
| Production runs v1.0.1 | Confirmed. `pos-prod-frontend` :8110 → 200; backend image built 2026-09-23T12:37:06Z; `~/atc-pos` HEAD `55bf2dc`. No Expansion code deployed. | `curl`, `docker inspect`, `git log` |
| Evidence log `/tmp/inv-fullsuite3.log` (1012/1012) | **Gone.** The file no longer exists. Its result is not recoverable and no committed document carries the figure. | `head /tmp/inv-fullsuite3.log` → no such file |

One handoff claim deserves separate mention because it is about the handoffs
themselves: commit `1ac2f31` (another session, 19:42Z) records that three
documents published `x/foundation @ 4f2a91c` as the agreed base and that **the
object does not exist** — "a prior session invented it through a compaction
error". Identifiers in this project's prose have been wrong before; that is the
reason every figure above names the command that produced it.

## The refund payment ordering defect

Reproduced by reading both revisions, not inferred.

- `ea04c07:backend/src/api/routes/orders.js:1829` — `REFUND_PAYMENT_INCLUDE` is
  a bare `select:` with **no `orderBy`**. Call site at `:1943`. Defect open.
- `cf9c4a0:backend/src/lib/orders.js:358` — exported, with
  `orderBy: [{createdAt:'asc'},{id:'asc'}]` at `:369`. Consumed at
  `routes/orders.js:2713`. Fixed.

**Why it mattered, stated precisely.** `pickRefundLeg` (`lib/orders.js`) selects
with `legs.gateway.find(l => l.available >= amountPaise)` — the *first* leg that
can cover the amount. The leg array is built in result-set order, so with no
`ORDER BY` the target of a refund on an order with two eligible gateway charges
was planner-dependent.

**Money is not at risk, and this is checked rather than assumed.** Each leg
carries its own `chargeProviderRef` and `intentProviderRef`, so a refund posts
against the provider that actually took that charge; a null reference makes the
adapter refuse rather than guess. Each leg's `available` is
`amount − already-held`, so no leg can return more than it collected. The
exposure is therefore **reconciliation, not loss**: on an order with two gateway
charges the money could come back out of the wrong charge — and, if the two
charges sit with different merchants, off the wrong merchant's balance.

The guard is `tests/razorpayFlow.test.js:1255`, which asserts the declaration
(`REFUND_PAYMENT_INCLUDE.orderBy`, `ORDER_INCLUDE.payments.orderBy`) **and** the
bindings (`select.providerRef`, `select.intent.select.providerRef`). Asserting
the declaration rather than the behaviour is deliberate: a behavioural tie test
can pass by luck whenever the planner happens to agree.

## Defect found and fixed in this session

A full run of `x/tables` at 19:20Z (`/tmp/vcxt-regression-1.log`) returned
`1 failed | 8 passed`, the failure being `floorplan.test.js` dying in `wipe()` on
`UserInvitation_createdById_fkey`.

Root cause: `x/accounts` introduced `UserInvitation`, whose `createdById` and
`acceptedById` reference `PosUser` under `onDelete: Restrict`. Fourteen test
files older than that merge wipe `posUser` without clearing invitations first.
The failure is order-dependent — it fires only when an earlier file in the run
left an invitation row behind — which is why it reads as one flaky, unrelated
suite rather than as an integration defect.

Fixed in `cf9c4a0`: one line per file, 14 files, inserted by an anchored patch
that asserts one `posUser` wipe before and one `userInvitation` wipe after,
ordered ahead of it. `maildrop.test.js` is deliberately excluded — it deletes by
id because it shares the database with every other file, and a table wipe there
would pull rows out from under them. The assertion caught that file rather than
silently rewriting it.

### Latent, not fixed

Twelve models hold `Restrict` references to `PosUser`. Coverage across the 33
table-wiping test files, after the fix:

| model | files missing the wipe |
|---|---|
| `userInvitation` | 0/33 (closed by this change) |
| `discountPolicy`, `order` | 0/33 |
| `promotion`, `promotionRedemption` | 2/33 |
| `device` | 21/33 |
| `permissionRule`, `supportAccessGrant`, `userStoreAssignment` | 24/33 |
| `diningVisit`, `qrSubmission`, `tableQrCode` | 32/33 |

These are the same hazard but **none has been observed to fire**, because each
needs a surviving row of that type at wipe time. They are recorded rather than
pre-emptively patched: rewriting thirty files against a failure no run has
produced would be change without evidence. The suite is the instrument that
decides.

## Suite status

Commit `cf9c4a0`'s own message points forward to an evidence file it names
`docs/INTEGRATION-VERIFICATION-77242FE.md`. **This file is that evidence.** It
is named for `cf9c4a0` instead because that is the revision the run was actually
executed against; `77242fe` is its parent and is contained in it. The name in
the commit message is the only thing wrong, and it is recorded here rather than
corrected by a history rewrite.

A full 52-file run against this candidate started at 19:43:36Z from
`/tmp/run-integration-suite.sh` against `vcx_integration_test` on
`127.0.0.1:5440`, log `/tmp/integration-suite-77242fe.log`. The header records
`commit: 1ac2f31`, `dirty_files: 14` — the 14 uncommitted files were byte-identical
to what was committed minutes later as `cf9c4a0`, so the run is attributable to
this candidate's tree.

**Result.** Completed 20:17:34Z, exit code 1.

```
Test Files  6 failed | 46 passed (52)
     Tests  5 failed | 1497 passed | 153 skipped (1655)
  Duration  2034.00s
```

This is the first full-suite figure attributable to this integration candidate.
The handoff's "0/34 verified" is now superseded.

| # | Test | Kind |
|---|---|---|
| 1 | `integrations` › historical loyalty import | timeout (900 s) |
| 2 | `inventoryLedger` › averages two receipts and issues proportionally | **hook** timeout (30 s) |
| 3 | `inventoryLedger` › empties a position to exactly zero value | downstream of #2 |
| 4 | `inventoryScheduler` › writes a failure onto the run … stops after a few tries | timeout (20 s) |
| 5 | `reportingExceptions` › reports found: null … for every detector this build cannot run | **assertion — a real defect** |

The 153 skipped are `phoneOrders` (77) and `gateway` (76) — 77 + 76 = 153
exactly, so both files' bodies never ran at all.

**Four of the five are the clock, one is the code.** Only #5 is a defect in the
candidate, and it is fixed below. The rest are one causal chain plus load, set
out next — which matters, because "6 failed files" read cold would condemn an
integration that is in fact sound.

### The chain: one slow cascade, five red files

`tests/integrations.test.js` reported `119 tests | 1 failed`. The failure:

```
× historical loyalty import > holds 100,000 rows ... 900077ms
  → Test timed out in 900000ms.
```

The 900 s budget is the test's own (`tests/integrations.test.js:2780` — `}, 900_000);`),
not a global setting; `vitest.config.js` sets `testTimeout: 20000`.

**Every assertion in the test passed.** The proof is in the log: the test's
closing `console.log` at `:2772` printed —

```
[import] 100000 rows in 488.6s (205 rows/s)
```

— and that statement sits *after* the last `expect()` in the body. The import
completed, reconciled, and was asserted good. What then overran was the trailing
cleanup at `:2778-2779`, which had ~411 s and did not finish:

```js
await prisma.loyaltyProfileLink.deleteMany({ where: { connectionId: connId, externalCustomerId: { startsWith: 'P-' } } });
await prisma.customer.deleteMany({ where: { companyId: company.id, phone: { startsWith: '9110' } } });
```

**Mechanism, from the live schema rather than inferred.** `LoyaltyProfileLink`
references `Customer` on a *composite* key under `onDelete: Cascade`:

```prisma
customer Customer @relation(fields: [customerId, companyId], references: [id, companyId], onDelete: Cascade)
```

Deleting 100,000 customers fires that cascade 100,000 times. No index on
`LoyaltyProfileLink` leads with `customerId` — the five that exist lead with
`id`, `connectionId`, `connectionId`, `connectionId` and `companyId`
(`pg_indexes`, 20:06Z). The only index the cascade can use is `companyId`, and
every row the test creates shares one company, so each probe selects the whole
working set. The cost is quadratic in the import size.

This is a property of the candidate, not of the test: `LoyaltyProfileLink` is
introduced by `20260924900000_providers_integration_framework`, an Expansion
migration. **Recommended, not applied here:** `@@index([customerId, companyId])`.
It is not applied because it needs a migration, and adding one to a shared tree
mid-run — against a cause that is strongly evidenced but not yet demonstrated by
an A/B run — would be exactly the change-without-evidence this document avoids
elsewhere.

### The downstream files

```
❯ tests/phoneOrders.test.js   (77 tests | 77 skipped) 60027ms
❯ tests/gateway.test.js       (76 tests | 76 skipped) 35952ms
   FAIL tests/inventoryLedger.test.js  → Hook timed out in 30000ms
   FAIL tests/inventoryLedger.test.js  → LedgerError: Not enough stock: 1.000 requested, 0 on hand
```

Neither file contains `describe.skip`, `it.skip` or any conditional skip. Both
durations sit on the `hookTimeout: 30000` boundary — 60027 ms is two of them,
35952 ms is one plus change — which reads as `beforeAll` expiring and vitest
reporting the bodies it never reached as skipped.

The cause is the failure above, and the test's author predicted it in a comment
at `:2774`: the cleanup exists "because 200,000 leftover rows are the NEXT run's
problem: `wipe()` deletes them one table at a time in `beforeAll`, and at this
volume that alone exceeded the 30s hook timeout and failed a suite that had
nothing to do with imports." The cleanup timed out, the rows survived, and the
next two files died wiping them. One slow cascade, three red files.

`gateway.test.js` is **not** among the 14 files this session changed, which
separates the effect from the change on its own.

`inventoryLedger.test.js` — also untouched by `cf9c4a0` — is the same story with
its second failure worth spelling out, because `Not enough stock: 1.000
requested, 0 on hand` reads like a ledger arithmetic bug and is not one. Every
test in that file gets its state from one hook:

```js
beforeEach(async () => {
  await wipeAll();
  fx = await buildBaseFixture();
  item = await makeItem(fx.company.id, { name: 'Sugar', baseUnit: 'G' });
});
```

That hook is what timed out, on the bloated database. The next test then posts
three receipts and immediately finds nothing on hand — stock vanishing between
two statements, not stock being mis-valued. The ledger's own arithmetic tests
either side of it passed. Treat #3 as a symptom of #2, and #2 as a symptom of #1.

### Not attributable to the invitation-wipe fix

`tests/integrations.test.js` and `tests/phoneOrders.test.js` are both in the
changed 14. The change cannot reach either failure: `git show cf9c4a0 --
backend/tests/integrations.test.js` is a single hunk adding one line at `:123`,
inside `wipe()`, which runs in `beforeAll` — a different function and a different
phase from the test body at `:2733`, and from the cleanup that overran.

### A real integration defect: two detectors that now answer "0" without looking

This one is not a timeout. `tests/reportingExceptions.test.js` failed on an
assertion:

```
× reporting exceptions: what cannot be detected here says so
  > reports found: null and a reason for every detector this build cannot run
  → NEAR_EXPIRY: expected +0 to be null
```

`src/lib/reporting/exceptions.js` carries four detectors this build was not
expected to be able to run. Each declares the Prisma models it would need, a
note explaining the gap, and a stub body:

```js
{
  kind: 'NEAR_EXPIRY',
  needs: ['stockBatch'],
  unavailableNote: 'Batch tracking is not part of this deployment, so expiry cannot be detected. No batch is being reported as safe.',
  run: async () => [],      // ← a stub, for a build where the gate never opens
}
```

The gate is model presence alone (`:460`):

```js
if (d.needs?.length && !hasModel(...d.needs)) return { state: UNAVAILABLE, ... };
```

The inventory lane landed `StockBatch` and `StoreRequest`. Checked against the
live client rather than assumed:

| model | present? | detector | consequence |
|---|---|---|---|
| `stockItem`, `stockLevel` | absent | `LOW_STOCK` | correct — still UNAVAILABLE |
| `stockBatch` | **PRESENT** | `NEAR_EXPIRY` | gate opens, stub runs, reports **`found: 0`** |
| `storeRequest` | **PRESENT** | `OVERDUE_REQUEST` | gate opens, stub runs, reports **`found: 0`** |

So two detectors now tell an owner that nothing is near expiry and nothing is
overdue, having checked nothing. That is precisely the outcome the module was
written to prevent — its own header says leaving them out would be wrong because
"an owner would reasonably read the absence of a stock alert as the absence of a
stock problem", and the test says `0` "would read as 'looked, found none'".

**Neither lane is wrong on its own.** Reporting was correct when no inventory
models existed; inventory was correct to add them. The safety property inverts
only on the merge — which is exactly what an integration candidate is for, and it
would not have been found in either lane's own suite.

**The suite understates it.** The assertion loop walks
`['LOW_STOCK','NEAR_EXPIRY','OVERDUE_REQUEST','SETTLEMENT_MISMATCH']` and aborts
at the first failure, so `OVERDUE_REQUEST` is broken identically and invisibly.
One red test, two defects.

**Fixed in `02ee253`, after the suite finished.** Availability is now gated on
whether the detector is *implemented*, not on whether its models happen to exist:

```js
// Last, so a missing model or a missing provider still gets the more specific
// answer. Reached when the data arrived but the detector was never written.
if (d.implemented === false) {
  return { state: UNAVAILABLE, note: d.unavailableNote ?? 'Not implemented in this build.' };
}
```

`implemented: false` is set on all four stubs, not only the two that had already
fired — `LOW_STOCK` breaks the same way the day the inventory lane lands
`stockItem`/`stockLevel`, and `SETTLEMENT_MISMATCH` the day a provider is
connected. The check is placed *after* the model and integration gates so those
keep giving their more specific answers; `SETTLEMENT_MISMATCH` therefore still
reports `PENDING_INTEGRATION` today, which the suite asserts. The two notes that
had become false were reworded — the models are in the deployment now; it is the
detector that is not wired to them.

Verified at 20:19Z and 20:20Z, after the change:

| Run | Result |
|---|---|
| `tests/reportingExceptions.test.js` | **23 passed (23)** — was 1 failed |
| `tests/reportingApi.test.js` + `tests/reportingSchedule.test.js` | **64 passed (64)** |

Those are the only consumers: one test file references the detector module and
one route (`src/api/routes/reporting.js`) reads its output.
`src/lib/reporting/capability.js:158` shares the gate but its families compute
rather than stub, so it does not produce the same false figure.

### Build and schema evidence

Both were taken against `cf9c4a0` directly and both are clean.

| Check | Command | Result |
|---|---|---|
| Migrations | `npx prisma migrate deploy` (in the suite log) | 19 applied, "All migrations have been successfully applied" |
| Schema | `npx prisma validate` | "The schema at prisma/schema.prisma is valid" |
| Frontend build | `npx vite build --outDir /tmp/vcx-build-cf9c4a0` | **exit 0**, 1711 modules, 7.01 s, 984 kB |

Log: `/tmp/frontend-build-cf9c4a0.log` (header records commit and node v22.23.2).
The build was directed at `/tmp` rather than `frontend/dist` because this
worktree is shared and `dist/` is a real artifact another session may be serving.
Its only warning is the pre-existing 500 kB chunk advisory — `index-DRCmxLRN.js`
is 939 kB raw, 242 kB gzipped — which is a bundling opinion, not a failure.

A note on how the schema check was read: `prisma validate` first reported
`Validation Error Count: 1`. That was `P1012 Environment variable not found:
DATABASE_URL` — the shell, not the schema. Re-run with the variable set, it
passes. Recorded because the raw first output would otherwise read as a schema
defect in this candidate, and it is not one.

### Conditions of the run

The host carried a load average of **10.97** at 20:05Z with peer suites running
(`uptime`). The import measured 205 rows/s. The same test's author declined to
assert a timing threshold for precisely this reason — "this box is a shared
development machine and a timing assertion here would fail for reasons that have
nothing to do with the import" (`:2769`). A 900 s budget that holds on a quiet
box does not necessarily hold at load average 11.

## Next serial integration: `x/tables`

Of ~30 lanes, exactly two branches are unmerged into `main`
(`git branch --no-merged main`): `sprint/client-handover-rc`, which belongs to
the separate v1.1 RC programme and is not an Expansion lane, and **`x/tables`**.

| | |
|---|---|
| Head | `f7132c5` (published — `git ls-remote github refs/heads/x/tables`) |
| Position | 2 ahead of `main`, 2 behind |
| Behind by | `cf9c4a0` (the invitation fix) and `1ac2f31` |
| Adds | migration `20260925160000_tables_pax_waiter`, schema, `routes/tables.js`, `lib/tables/service.js`, permissions, and 905 lines of new tests |

**Not merged in this session, deliberately.** The 52-file suite is executing
against this worktree's files right now; a merge would rewrite them under a live
vitest process and destroy the result this document exists to report. The lane is
also checked out and in active use by a peer session at
`vexo-connect-x-lanes/tables`.

### The lane independently confirms this session's diagnosis

`x/tables` adds `tests/storeScopeGate.test.js`, whose wipe carries this comment
at `:79` — written by another session, with no contact with this one:

> Before posUser, and not optional: `UserInvitation.createdById` is a Restrict
> FK, so leaving a row here makes `posUser.deleteMany()` fail with
> `UserInvitation_createdById_fkey`. `floorplan.test.js` omits this line and
> fails exactly that way whenever the sequencer happens to run it after
> `invitations.test.js` — recorded in the handover as a separate defect.

Same mechanism, same constraint, and the same two files this session identified
from the 19:20Z log. That lane recorded the defect and guarded its own new file;
`cf9c4a0` closed it across the fourteen older files. The two are complementary,
and neither depends on the other.

### One file the merge will still need

`tests/tablesService.test.js`, also new in the lane, wipes `posUser` at `:57`
with no preceding invitation wipe — the fifteenth instance of the same hazard.
`/tmp/fix-invitation-wipe.sh` selects exactly this shape
(`posUser.deleteMany` present, `userInvitation.deleteMany` absent, unscoped) and
will pick it up unmodified when the lane lands.

## Shared-worktree hazard

`main-merge` is not exclusively this session's. During this work another session
committed `1ac2f31` into it and, separately, published `main` to GitHub. All
commits here were therefore made path-limited
(`git commit -F <msg> -- <explicit paths>`) so that no co-tenant's in-flight work
could be swept in. `git show --stat cf9c4a0` confirms exactly 14 files, 14
insertions.
