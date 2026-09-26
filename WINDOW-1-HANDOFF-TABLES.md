# WINDOW-1-HANDOFF-TABLES — x/tables lane status

Date: 2026-09-26 (updated; first written 2026-09-25). Window 1. Lane
`x/tables`, worktree `~/vexo-connect-x-lanes/tables`, runner
`~/vcx-tables-local/vcxt`, private test DB `vcx_tables_test` on
`127.0.0.1:5440`.

Base `77242fe` (the shared lane base, = remote
`checkpoint/integration-77242fe-20260925`). **Twelve commits**, worktree clean
after each. All four table verbs are now done: service, transfer, split, merge.

| SHA | What |
|---|---|
| `ef6bc79` | **Security fix in SHARED middleware** — `resolveStoreInScope` scope gate. Read this first; it is not tables-specific. |
| `f7132c5` | Covers (pax) + waiter attribution on `Order`. The lane's own feature. |
| `0d1d13e` | Test-only follow-up: `storeScopeGate.test.js` cleans its own fixtures instead of the whole database. Fixes a defect I introduced in `ef6bc79` — see §3.2. |
| `5338788` | **Table transfer** — `POST /api/tables/:id/transfer`. New `lib/tables/transfer.js`, new `tests/tablesTransfer.test.js`, and the route wired into `api/routes/tables.js`. See §4.1. |
| `80c677b` | **Split bill** — separate cheques, money conserved to the paise. See §5.1. |
| `c574934` | Test-only: the split tests get the headroom they were measured to need. |
| `95eae62` | Test-only: the audit test checks *who* split the bill, not just what. |
| `61f6d3c` | **Covers counted once** after a split — the pax hole my own feature opened. See §6.3/§6.3a. |
| `0056db1` | Removes an order-status list the card router never reads. |
| `5dc06e8` | Test-only: the post-split covers test now proves a double-count, not a misplacement. |
| `9f456b8` | Test-only: ask the covers aggregate before the rows that would abort the run. |
| `12fa573` | **Table merge** — `POST /api/tables/:id/merge`, `OrderStatus.MERGED`, own migration. Resolves §6.1. See §6.1 for the decision and its negative controls. |

Tested source identity: §3.1's full-suite result ran against the working
tree at **`0d1d13e`** (`git status` empty). `5338788` landed *after* that
run and is verified separately in §4.1 — a second full-suite run against
`5338788` is in flight and its result is recorded there. `ef6bc79` and
`f7132c5` contain no `src/` change beyond what was already verified at
`f7132c5`; `0d1d13e` touches one test file and no production code.

**Pushed** to `github` (`jitendersharma07-beep/VEXO-connect`). `x/tables`
did not exist remotely before this lane, so no force at any point and
nothing of anyone else's was overwritten. Remote SHA verified by
`git ls-remote` after each push:

```
53387885fa0b337117b8eef4bc39dc2490559791  refs/heads/x/tables   ( = local HEAD)
0d1d13e96e2f6dd9bb8fb986338f9e34634e7e05  Clean only this suite's own fixtures, not the whole database
f7132c5df8722f5491e70f8eb2e49b5a809efa70  Record covers and the serving staff member against a bill
ef6bc797c38d6808098aef6ea283d6462637732f  Restore the store id the scope gate existed to check
```

All pushes were fast-forwards (`f7132c5..0d1d13e`, `0d1d13e..5338788`), no
force at any point.

Not merged into `main` or any shared release branch, and not deployed.

---

## 1. Read this first — `ef6bc79` touches shared code

`src/middleware/permissions.js` is used by nine routers, so this commit is
deliberately separate from the lane feature and can be reverted, reassigned
or cherry-picked into another lane on its own.

### The defect

`resolveStoreInScope` — the "is THIS store inside your scope?" gate — built
its query as:

```js
where: { id: String(branchId), companyId, ...branchWhereForScope(req.perm.scope) }
```

`branchWhereForScope` returns `{ id: { in: [...] } }` for every scope
narrower than the whole tenant. The spread therefore **deleted the `id` key
the gate existed to check**, and the query became "is there any store in
this caller's scope?" — true for anybody holding a store at all. `findFirst`
returned some store the caller happened to have, so the gate never threw.

Fix: `AND: [branchWhereForScope(req.perm.scope)]`, which keeps both
conditions. One line.

### Blast radius — what it is, and what it is not

**It is not a cross-tenant leak.** `companyId` is a different key and
survived the spread intact. Every affected query still could not leave the
company. The damage was *inside one tenant*, on the boundary the
`UserStoreAssignment` feature exists to draw, and it splits into three
kinds that differ in kind rather than degree:

1. **Misfiled writes** (uses the RESOLVED row) — `terminals.js`,
   `devices.js`, `drawer.js`, `paymentAccounts.js:153`, and
   `resolvePlacement()` in `lib/userAuthority.js:105`. These wrote into the
   *caller's own* store while answering `201` for the store requested. A
   till created in the wrong outlet, silently. Bad data, but the write
   stayed within the caller's reach — so `userAuthority`'s stated promise
   ("a scoped admin cannot place staff where they themselves cannot go")
   actually held; only the requested store was substituted.
2. **Immediate privilege grant** (persists the REQUEST BODY id) —
   `PUT /permissions/assignments/:userId` (`routes/permissions.js:359`). A
   company-wide role that the tenant had deliberately narrowed with
   assignments could assign somebody to a store outside that narrowing.
3. **Deferred privilege grant** — `POST /invitations`
   (`routes/invitations.js:119`). `UserInvitation.storeIds` becomes real
   `UserStoreAssignment` rows *at acceptance*, and nothing at acceptance
   re-checks the inviter's scope. So the grant appears later, out of band,
   when the recipient clicks a link — possibly after the inviter is gone.

Both (2) and (3) have route comments promising exactly what was broken.
`brands.js:147` is shape (2) without the privilege — a brand attached to a
store the caller cannot reach. The gates in `orders.js` were masked
throughout by `loadOrder`'s stricter legacy branch pin, so nothing
reachable there changed behaviour.

### Why it was invisible

The gate returned *a* store, so callers proceeded and answered success.
There was no error, no log line, and no failing test — the till simply
appeared in the wrong outlet. Asserting only the refusal status would have
passed on a route that answered 404 *after* writing the row, which is why
every test below also asserts the absence of the row.

### Evidence

`backend/tests/storeScopeGate.test.js`, 9 tests in 3 blocks, one per kind
above, each with a positive control so a gate that simply refused
everything could not pass.

- **With the fix: 9/9 pass.**
- **Without the fix: 8 of 9 fail** (temporarily reverted to the spread,
  re-run, then restored and confirmed byte-identical to the pre-proof copy).
  The failure payloads are the finding, stated by the code itself:
  - a `POST /api/terminals` for **Alpha Two** answered `201` with
    `"branchName":"Alpha One"` — the wrong-outlet write, captured verbatim;
  - a `PENDING` invitation was written with `storeIds:[<Alpha Two>]`, i.e.
    a durable grant to a store the inviter cannot reach, sitting in the
    database waiting to be accepted.

The fixture is narrower than it looks and the choice matters. A
`BRANCH_MANAGER` cannot reach `POST /terminals` at all (no `terminal.write`
in the baseline → `403` at `requireAction`, gate never consulted), and a
`REGIONAL_MANAGER` with only a `regionId` has scope `{kind:'REGION'}`, whose
fragment is `{regionId}` — a key that does not collide with `id`. Only an
explicit `UserStoreAssignment` produces `{kind:'LIST', branchIds}`, the one
scope whose fragment is keyed on `id`. So the suite uses a regional manager
narrowed by an assignment: realistic, and the only configuration that
reaches the gate in the shape that broke.

**No existing suite depended on the loose behaviour.** The nine suites this
fix can reach pass **286/286**: `terminal`, `drawer`, `paymentAccounts`,
`invitations`, `foundation`, `foundationPeople`, `phase2`, `tablesService`,
`storeScopeGate`. `invitations.test.js`'s own "accepting an invitation
materialises named stores into assignments" still passes.

---

## 2. `f7132c5` — covers and waiter attribution

Spec §B "Tables (Pro): floor/table layout, pax, waiter, transfer/merge
table, split bill" — **the pax and waiter half only.**

Neither field is money, and the code is arranged so it cannot become money
by accident: nothing in `lib/tables/service.js` calls `recomputeOrder()` and
nothing writes an amount column. `lib/orders.js` stays the single evaluator
of a total.

**Schema.** `Order` gains `pax`, `waiterId`, `waiterSetAt`, `waiterSetById`,
all nullable — additive migration, every existing bill stays valid.
`waiterId` is a composite FK `(waiterId, companyId) → PosUser(id, companyId)`,
so crediting another tenant's staff is a constraint violation rather than a
filter somebody can forget. Two hand-written CHECKs carry the invariants the
application is not trusted with alone:

```
Order_pax_positive                 pax IS NULL OR pax > 0
Order_waiter_attribution_complete  the three waiter columns are all NULL or all set
```

The second exists because "who credited this, and when" is only evidence if
it cannot be half-written. **All four constraints confirmed live in the
database** (`pg_constraint` query, both CHECKs + both FKs present).

**Authority.** Three actions added to the catalogue: `table.service`,
`table.transfer`, `bill.split`. `CAPTAIN` gets the first two and not
`bill.split` — covers and the server are the captain's own observations, and
dividing what a party owes is the restricted financial action the spec keeps
out of that role. `POST /tables/:id/service` keeps the legacy
`requireRole(...)` list beside `requireAction('table.service')`, and that
list omits `POS_SUPER_ADMIN` on purpose so ATC stays read-only on tenant
floor data, matching the rest of `tables.js`.

`resolveWaiter()` proves four things before anybody is credited: in this
tenant, `ACTIVE`, permitted to take orders **by the tenant's own resolved
rules** rather than the role baseline, and working in **this** store.

> The same spread bug as §1 existed in my own `resolveWaiter()` and was
> caught by this lane's own negative control — Alpha Two's captain was
> accepted on an Alpha One table until it became an `AND`. That is what
> sent me looking for the shared one.

**Evidence:** `backend/tests/tablesService.test.js`, **19/19** — both CHECK
constraints, the attribution triple, cross-tenant and cross-branch
refusals, the suspended account, the role matrix including ATC's 403, audit
content, and proof that a service change leaves every money column
untouched.

---

## 3. Verification (all DB-backed integration, no synthetic or mocked runs)

| Check | Result |
|---|---|
| `tablesService.test.js` | 19/19 |
| `storeScopeGate.test.js` | 9/9 with fix; 8/9 **fail** without it |
| `storeScopeGate.test.js` after `discounts.test.js` | 59/59 — the ordering that exposed §3.2 |
| 9 suites the shared fix can reach | 286/286 |
| Full backend suite | see §3.1 |
| Migration drift (`vcxt migsql`) | `-- This is an empty migration.` — no drift |
| CHECK/FK constraints live in DB | 4/4 confirmed via `pg_constraint` |

Every run is against real Postgres (`vcx_tables_test`) through the HTTP
surface with `supertest`. **No browser, no physical printer, no live
payment provider was exercised, and nothing below claims otherwise.**

### 3.1 Full suite

Run at `0d1d13e`, 54 files, private DB `vcx_tables_test`:

```
Test Files  4 failed | 50 passed (54)
     Tests  3 failed | 1603 passed | 77 skipped (1683)
  Duration  2064.54s
```

**None of the four is from this lane, and none is the shared fix reaching
further than intended.** Every file the fix can touch is green, including the
five that matter most for judging it:

| File | Result |
|---|---|
| `storeScopeGate.test.js` | 9/9 ✓ |
| `tablesService.test.js` | 19/19 ✓ |
| `invitations.test.js` | 33/33 ✓ |
| `discounts.test.js` | 50/50 ✓ |
| `floorplan.test.js` | 16/16 ✓ |

The four failures, against the lane baseline at `77242fe`
(`.runlogs/baseline-151434Z.log`, `Test Files 2 failed | 50 passed`,
`Tests 5 failed | 1650 passed`):

| File | Failure | At baseline | Verdict |
|---|---|---|---|
| `integrations.test.js` | `Test timed out in 900000ms` — 100,000-row loyalty import | **passed**, 627931ms | time, not logic |
| `phoneOrders.test.js` | `Hook timed out in 30000ms`, file-level → all 77 tests skipped | **passed**, 11770ms | time, not logic |
| `inventoryProduction.test.js` | `Hook timed out in 30000ms` | **passed**, 53951ms | time, not logic |
| `reportingExceptions.test.js` | `NEAR_EXPIRY: expected +0 to be null` | **failed the same way** | genuine, pre-existing |

**Three of the four are the clock, and together they are one finding worth
acting on.** All three passed at baseline and none of them fails an
assertion — they run out of `testTimeout: 20000` / `hookTimeout: 30000`
while the box is busy. The durations say how little room there is:
`integrations` needs 628 s of a 900 s ceiling when nothing competes and 943 s
when something does; `phoneOrders` goes from 11.8 s to over 30 s in a single
hook. `inventorySales.test.js` is the same story measured precisely — see §7,
where one test takes 24.4 s **alone** against a 20 s limit.

So the suite's timeouts are calibrated for a quiet machine and have no
margin. On this box, with sibling lanes running, 3 of 54 files fail purely on
time, and the whole run stretches 1536 s → 2065 s. That is a release-gate
problem for whoever owns CI, not a defect in any of the three features.
**Recorded as a timing finding, not waved away as flakiness**, and
deliberately not "fixed" by raising limits from inside this lane.

Two corrections to what an earlier draft of this document claimed:

- **`reportingApi.test.js` is now 36/36.** It failed 4 tests at baseline and I
  had recorded "5 pre-existing reporting failures" carried forward. Only
  **one** survives — the `NEAR_EXPIRY` assertion in
  `reportingExceptions.test.js`. The other four were order- or
  load-dependent, which means they were never the stable baseline I described
  them as.
- The first full run reported 6 failed files; this one reports 4. The two that
  stopped failing are `storeScopeGate.test.js` (the §3.2 fix) and
  `reportingApi.test.js`.

### 3.2 A defect I introduced, and what it says about the house pattern

The first full-suite run failed in **my own new file**, not in the code the
fix touched:

```
Invalid `prisma.posUser.deleteMany()` invocation in tests/storeScopeGate.test.js:85
Foreign key constraint violated: `Order_discountApprovedById_fkey`
```

`storeScopeGate.test.js` had copied the house cleanup pattern — a chain of
**unscoped** `deleteMany()` calls. That pattern works in the long suites
because they delete most of the database in dependency order anyway. It does
not survive in a short file: `discounts.test.js` has no `afterAll` wipe and
leaves its orders behind deliberately, nine of them carrying an approver, so
an unscoped `posUser.deleteMany()` in any later file has to delete orders it
knows nothing about.

The pattern broke **twice here, on two different constraints** —
`UserInvitation_createdById_fkey` while the file was being written, then
`Order_discountApprovedById_fkey` once it ran beside the rest of the suite.
That is not two mistakes; **23 RESTRICT foreign keys point at `PosUser`**
(one of them `Order.waiterId`, added by this lane), so the chain is only ever
one unfamiliar suite away from failing again. `tests/globalSetup.js` already
says this about itself: `TRUNCATE ... CASCADE` "needs no knowledge of the
dependency graph, **which is why it is used here and not in the per-file
helpers**."

`0d1d13e` therefore resolves this suite's two companies by slug and deletes
downward from them — 15 scoped deletes, `PosSession` joining through
`userId` because it carries no `companyId`.

This mattered more for this file than it would for most, and that is the
transferable lesson: a **regression test for a privilege boundary** that goes
red for a reason unrelated to the boundary trains the next reader to discount
it. `globalSetup.js` makes the same argument in the opposite direction — "a
warning that cries wolf is worse than none: the next reader learns to ignore
it, and then a real theft passes for noise."

Verified after the fix: 9/9 alone, and **59/59 run immediately after
`discounts.test.js`**, which reproduces the exact precondition that failed —
confirmed by querying the test database afterwards: 9 approver-bearing
`Order` rows and 11 `PosUser` rows still present, `discounts`' three
companies intact, and **neither of this suite's two companies left behind**.
So the scope both cleans what it owns and leaves alone what it does not.

> Honest note on the red-without-fix proof: the failing run in the first full
> suite **is** that evidence, observed and logged. I tried to re-demonstrate
> it with a standalone script that calls the old unscoped delete against the
> leftover rows; that was blocked by the sandbox classifier and I did not
> rebuild it under another name. The before/after pair above does not depend
> on it.

---

## 4. Table transfer — `5338788`, done and verified

### 4.1 What it does, and what it deliberately does not touch

`POST /api/tables/:id/transfer`, body `{ toTableId }`. Same store only.

| | |
|---|---|
| MOVES | `DiningVisit.tableId` **and** `.openTableId` |
| MOVES | `Order.tableId` for the visit's `OPEN` bill(s) |
| STAYS | `TableQrCode` — the card is glued to the table |
| STAYS | `Order.branchId` — the move is within one floor |
| STAYS | every amount, tax and discount column |

**No money moves, because none can.** `recomputeOrder()` is never called,
no amount column is written, and no price list is re-read — `lib/orders.js`
stays the single evaluator of a total. A party that stands up at table 5 and
sits at table 6 owes exactly what it owed before it moved. A transfer that
changed a bill would be a pricing bug wearing a furniture feature's clothes.

`openTableId` moves *with* `tableId` because the pair is the invariant: it
holds `tableId` while OPEN and NULL once CLOSED, which is how the database
rather than the application enforces "at most one open visit per table".
Writing one without the other would leave the source table looking occupied
for ever and no code path would notice.

The QR card staying put is structural, not a preference. `TableQrCode` is
pinned by a composite `(tableId, branchId)` FK and carries
`activeTableId @unique`; re-pointing a card at the destination would either
violate that constraint or leave the laminated card on table 5 opening
orders for table 6.

**A `BILLED` order refuses the move** — *"settle it before moving the
party"*. The bill has been printed with the table on it, so moving the party
afterwards leaves the customer's copy disagreeing with the record. That is
the identical argument `assertServiceEditable` already makes about covers
and the server, and it has to be the same argument, because it is the same
piece of paper. Also matches what actually happens on a floor.

Only the **source** table is resolved through the caller's permission scope
(`loadTableInScope`). The destination is resolved against the *source's*
branch, so "may this caller touch this floor?" is one question asked once
instead of two that can disagree. Gate is `canTransfer` — the same six roles
as `canServe`, `POS_SUPER_ADMIN` deliberately absent (ATC stays read-only
throughout `tables.js`), plus `requireAction('table.transfer')`.

`auditRequired`, not `audit`: a party that moved with no record of who moved
it is precisely the dispute that row exists to settle, so the row and the
move commit together or neither does.

### 4.2 Concurrency — the part that needed care

- **Lock order is visit-then-destination, and is not arbitrary.**
  `lib/qr/visits.js` `orderForVisit()` takes the `DiningVisit` lock first and
  its comment states every caller does too. A writer that took the table
  first would quietly falsify that sentence the moment a guest hit Send
  during a transfer.
- **Every pre-lock read is re-read after the lock.** The first reads are
  stale by definition. Re-resolving the destination under the lock is what
  makes a table retired mid-flight impossible to slip past, and re-reading
  the party is what makes a bill issued mid-flight fall out of the move.
- **Two staff racing for the same empty table** are serialised by the
  destination row lock. `DiningVisit.openTableId @unique` closes the window
  structurally if the lock is ever bypassed, and that `P2002` is translated
  to a 409 about the floor rather than a 500 about the database.
- **For a till-rung dine-in order there is no unique constraint** —
  `Order.tableId` has no uniqueness — so for that shape the free-destination
  check plus the row lock is the *only* thing between two parties and one
  bill. Written down because it is the asymmetry a future edit could miss.

### 4.3 Verification

- `tests/tablesTransfer.test.js` — **20/20**, 2928ms.
- All four suites that share this router, run together:
  `tablesTransfer 20` + `tablesService 19` + `storeScopeGate 9` +
  `floorplan 16` = **64/64**, 15.30s. This is the run that proves the route
  edit to the shared `tables.js` regressed nothing.
- A second full-suite run covering `5338788` did happen, but it must be read
  as **diagnostic, not as certification of that commit**: split-bill files
  were being edited while it ran, and vitest resolves `src/` imports lazily
  per test file, so files that had not started yet picked up a changing tree.
  Figures: **55 files collected, 1 failed / 54 passed** in 39m 48s, log
  preserved at `/tmp/vcxt-fullrun-5338788-diagnostic.log`. The single failure
  was `reportingExceptions.test.js:626` (NEAR_EXPIRY, pre-existing and
  recorded in §7), not a transfer test. `tablesTransfer` passed 20/20 in it.
  Two things that run flatly disproves:
  - its headline exit code was **0 while the summary said 1 failed** — the
    invocation ended in `; echo`, which replaced vitest's status with the
    shell's. Read the summary block, never that exit code.
  - `billSplit.test.js` was **not collected at all** (55 files = 54 baseline +
    `tablesTransfer`). The glob is resolved at run *start*; the file was
    created at 04:19 against a 03:53 start, so it contributed zero of those
    figures. The split suite's first real execution is in §4.4.
- The certifying run for this lane is the one in **§4.4**, against a clean
  tree at `c574934`. The `80c677b` run recorded there is the one that *found*
  two defects in my own split tests; it is honest evidence, not a pass.

**Three of the negative controls assert the refusal *message*, not just the
404** — and that is a correction to my own first draft. `notFoundHandler`
(`src/middleware/error.js:14-16`) answers an unrouted path with status 404
*and* code `POS_NOT_FOUND`, which is exactly what `notFound('Table not
found')` returns. Status-only assertions would therefore have passed against
an endpoint that was never mounted at all. A dedicated control now pins the
two apart by asserting the unrouted sibling says `'Not found'` while the
real path says `'Table not found'`, and that the two strings differ. The
suite passed 19/19 on the first attempt, which is what prompted the audit
rather than satisfying me.

### 4.4 The full-suite runs, and the two defects the first one found

Two full 56-file runs matter here. The first is not a pass, and saying so is
the point of this section.

**Run at `80c677b`** — 04:43:08, 2242.10s (37m 22s), exit 1.

| | |
|---|---|
| Test Files | 6 failed / 50 passed (56) |
| Tests | 6 failed / 1645 passed / **77 skipped** (1728) |

Six failures, and I own two of them:

| # | failure | mine? |
|---|---|---|
| 1 | `integrations` — 100k loyalty import, 900,077ms timeout | no — pre-existing, §7 |
| 2 | `inventoryApi` — "splits a dispatched value three ways", 20s timeout | no — inventory dispatch, not bill split |
| 3 | **`billSplit` — 'conserves across every way of cutting the same bill', 20,005ms timeout** | **yes** |
| 4 | **`billSplit` — 'copies the server but leaves the covers on the original'** | **yes** |
| 5 | `inventorySales` — "refuses to return a line that never took stock", 30,002ms hook timeout | no — §7, and **not merely load**: one of its tests needs 24.4s *alone* against a 20s limit |
| 6 | `reportingExceptions:626` — NEAR_EXPIRY `expected +0 to be null` | no — §7, and **a genuine defect**, root-caused at the end of §7 |
| — | `phoneOrders` 77 skipped — `beforeAll` blew the 30s hookTimeout | no — cascade from #1 |

Note the shape of that table: **five of the six are timeouts, and the only
genuine assertion failure in the whole suite predates this lane.** The split
suite had passed 25/25 on its own immediately before this run. Running alone
is the number that flattered me; running inside 56 files is the honest one.

**Which of these are actually "the box", stated precisely — because "it's
environmental" is the easiest thing in this document to say and the easiest to
be wrong about.** The isolation evidence already exists in §3.1, measured at
the lane baseline `77242fe`, so re-running these files would cost ~20 minutes
of a shared database to re-learn what is written down:

| failure | passes alone? | so it is |
|---|---|---|
| `integrations` 100k import | **yes** — 627,931ms of a 900,000ms ceiling | load-sensitive, but at **70% of ceiling on a quiet box** |
| `phoneOrders` hook | **yes** — 11,770ms of a 30,000ms ceiling | load, and a cascade from `integrations` here |
| `inventoryApi` dispatch split | **yes** — whole file 32/32 alone | load |
| `inventorySales` | **NO** — one test needs **24.4s alone** vs a 20s limit | **a real budget defect**, not load |
| `reportingExceptions` NEAR_EXPIRY | **no** — fails identically alone | **a real defect**, see §7 |

So of the six, **three are load, two are genuine defects in other lanes, and
one was mine** (now fixed in `c574934`). An earlier draft of this section, and
a status report I gave mid-session, called `inventorySales` environmental. That
was wrong and this table is the correction: a test that needs 24.4s against a
20s ceiling fails on an idle machine too.

**Failure #4 was caused by failure #3, and the mechanism is worth knowing**
because it will catch somebody else. When vitest times a test out it abandons
the test but **does not cancel the in-flight promise**. The abandoned
`POST /api/orders` completed *after* the next test had already run
`clearTable(tableA1.id)`, so that test opened onto a table it had just emptied
and died with `Table "S1" already has an open order` — a 409 at its first
assertion, nothing to do with splitting. One missing second of headroom failed
two tests and only one of them had anything wrong with it.

**Fix — `c574934`, tests only, no production code.** The root cause was one
test doing five things: the 'conserves' test looped five cuts of the same
basket (clear table, open a 3-line bill over the API, split, verify) inside a
single `it`. 8.0s alone, 20,005ms under load, 20s ceiling. It is now five
`it.each` cases — each gets the whole budget for a fifth of the work, and a
failure names the cut instead of pointing at a loop. Three further tests were
given an explicit 45s against measurements, and one assertion of mine was
deleted for being a tautology (`paise(0 or 1) >= 0`, labelled "fixture
sanity", true whatever the code does).

**The measurement that reframes all of this — a private database isolates
rows, not CPU.** Chasing the 45s grants I timed `'copies the server'` two
ways:

| | |
|---|---|
| alone (`-t` filter) | **581ms** |
| same work, in sequence, same file | **13,283ms** |

A **23× stall on identical work.** At the moment the 13.2s was recorded the
shared Postgres container `vexo-connect-dev-db` was at **143.72% CPU** and the
box at **load average 10.51** with 26 node processes. This lane's DB
(`vcx_tables_test`) is private, so rows are isolated — but the container is
shared with every other lane, and capacity is not. The same file has now run
in 43.6s, 30.6s and 15.7s wall-clock with identical content.

The consequence for anyone reading test timings in this programme: **a budget
sized on an idle measurement is sized on a number that never occurs during a
real run.** That is also why I did not blanket-raise the ceiling for the file —
a test that stalls past 45s should still fail, because at that point the stall
*is* the finding.

**Focused split suite:** 25/25 at `80c677b` (43.60s) → **29/29 at `c574934`**,
exit 0, re-run twice at 30.62s and 15.68s. Same coverage, four more test names.

**Run at `c574934`** — the certifying run, launched against a verified clean
tree and re-verified *mid-run*, which matters because §4.3 records that editing
a file vitest has not reached yet contaminates the run:

| check | result |
|---|---|
| lane `HEAD` | `c5749341…a474` |
| `git status --porcelain` | empty |
| `git diff HEAD -- backend/{src,tests,prisma}` | empty |
| `git status --ignored` over those dirs | empty — nothing hiding behind `.gitignore` |
| any file there with mtime inside the run | **none** |
| tracked tree object | **`523d3e676fb63f29b9f64b23393d049d8f1c2324`** |

Cite the **tree object**. An earlier draft of this section also quoted a
"source fingerprint `1ae83b63cdbbb25a`" over `backend/{src,tests,prisma}`, and
**I could not reproduce that number from the unchanged tree** — so it is struck
rather than quietly corrected. The reason is worth knowing before anyone builds
another one: `sha1sum` writes the *path* next to each digest, so a
`find | sort | xargs sha1sum | sha1sum` roll-up changes when the paths change.
The identical filter over the identical bytes gives `dc85a3aa007bb2e8` from
relative paths and `5d37250e9518a557` from absolute ones. Add a `-name` filter
and it moves again. Such a number proves nothing to a second reader, because it
is not a property of the source alone.

`git rev-parse HEAD^{tree}` has none of that: content-addressed, path-canonical,
order-canonical, and comparable across machines and worktrees. **The source
identity above is also strictly stronger than any digest** — `git diff HEAD`
empty plus `--ignored` empty plus no mtime in the window says the working tree
*is* the commit, which is the actual claim a certifying run needs.

**The result this lane is accountable for is in, and it is the one that
matters here:**

```
✓ tests/billSplit.test.js (29 tests) 21034ms
```

**29/29, zero failed, inside the full 56-file suite under real contention** —
not in isolation, which is the number §4.4 argues is the dishonest one. That is
the claim this lane makes. Note the figure against the history: the same file
timed out at **20,005 ms** as one 5-cut test at `80c677b`; as five `it.each`
cases the *whole file of 29 tests* now finishes in 21,034 ms.

**Suite totals — the run finished. Read them as they are:**

```
Test Files  3 failed | 53 passed (56)
Tests       3 failed | 1729 passed (1732)
Start at    05:47:10
Duration    2495.09s (transform 2.83s, collect 39.60s, tests 2437.19s)
EXIT=1
```

Log: `/tmp/vcxt-final-c574934-b.log`. (The earlier `/tmp/vcxt-final-c574934.log`
was killed mid-`integrations` by the harness and certifies nothing — it is kept
only so nobody mistakes it for this one.)

**All 56 files ran and `skipped` is 0** — the bar this lane was asked to clear,
and the one the `5338788` run could not (77 skipped in `phoneOrders` alone,
§4.3). 1732 tests collected, **1729 passed.** `EXIT=1` is correct and expected:
three tests failed, so a zero exit would have been the thing to distrust.

**This is not a green gate and should not be presented as one.** Three failing
files, none of them this lane's:

> | file | failing test | ms | reading |
> |---|---|---|---|
> | `gateway.test.js` (76 \| 1) | "refuses and records nothing when it has the payment under another reference" | **20,006** | test body, **6 ms over the 20,000 ms `testTimeout`**. Passed at `80c677b`; no lane has touched it |
> | `inventoryProduction.test.js` (16 \| 1) | "charges the run that was set up, not the one that came out" | **30,006** | **`→ Hook timed out in 30000ms` — 6 ms over `hookTimeout`, and none of it is the test's own work.** Its 15 siblings pass at 2.6–19.7 s |
> | `reportingExceptions.test.js` (23 \| 1) | "reports `found: null` and a reason for every detector this build cannot run" | 3,064 | the **§7 `NEAR_EXPIRY` defect on an old base.** Fixed on `main` by `02ee253`, which base `77242fe` predates. Failure site: `reportingExceptions.test.js:626` |
>
> **Exactly one of the three is an assertion failure, and it is a known defect
> already fixed upstream.** The other two are the shared box, and they say so in
> an unusually legible way: two independent files, two different budgets, each
> missed by **6 ms**. Work that overruns a round number by 0.02–0.03% did not
> hang — it simply did not fit. Nothing is wedged.
>
> The `inventoryProduction` one is worth reading carefully rather than counted as
> "a slow test": vitest attributes hook time to the test it ran before, so a
> `beforeEach` that truncates the world reads as a 30-second test. The failing
> line's own body is not implicated at all.
>
> **Both timeouts are the cost `main` has already attacked** — `94fec3d`
> (per-test wipe by `DELETE` instead of rebuilding 672 files) and `d625370`
> (index on the cascade Postgres was scanning). Neither is in this lane's base.
> So the prediction for a re-run on refreshed `main` is that all three go away:
> two because the teardown gets cheaper, one because the defect is fixed. That
> is a falsifiable claim and whoever integrates should check it rather than
> take it.
>
> **None of the three is an assertion about money, tenancy or table behaviour,
> and none touches a file this lane changed.**

**Run at `61f6d3c`** — 07:48:53, 2223.09s (37m 03s), exit 1. Log
`/tmp/vcxt-full-61f6d3c.log`, exit code in `/tmp/vcxt-full-61f6d3c.exit`.

```
Test Files  3 failed | 53 passed (56)
Tests       2 failed | 1656 passed | 77 skipped (1735)
Duration    2223.09s (transform 2.84s, collect 42.29s, tests 2164.44s)
EXIT=1
```

1735 collected against 1732 at `c574934` — **+3, exactly the three §6.3a tests**
and nothing else appearing or vanishing.

This lane's three files, inside the full suite under contention:

```
✓ tests/billSplit.test.js       (32 tests) 34782ms
✓ tests/tablesTransfer.test.js  (20 tests)  5326ms
✓ tests/tablesService.test.js   (19 tests)  2443ms
```

71/71. Note `billSplit` at **34.8 s here against 7.6 s on a quiet box** — the 45 s
grants §6.3a gave the three new tests were sized for exactly this and would have
failed at the 20 s default.

**The two failures, and neither is this lane's:**

| file | failing test | reading |
|---|---|---|
| `integrations.test.js` (119 \| 1) | 100k loyalty import | **900,091 ms timeout.** This one **passed at `c574934` in 841,044 ms** — 93% of ceiling. It has now crossed it. §4.4 already called it "load-sensitive at 70% of ceiling on a quiet box"; the trend is the story, not the individual run |
| `reportingExceptions.test.js` (23 \| 1) | `NEAR_EXPIRY: expected +0 to be null` at `:626` | **byte-identical to `c574934`** — same test, same line, same values. The §7 defect on an old base, fixed on `main` by `02ee253`. Not load: it fails alone too |
| — | `phoneOrders.test.js` 77 skipped | `Hook timed out in 30000ms`, cascade from `integrations` — mechanism below |

**Two that failed at `c574934` and pass here:** `gateway` ("payment under another
reference", 20,006 ms → whole file 26,158 ms against 97,200 ms) and
`inventoryProduction` ("charges the run that was set up"). Both were the 6-ms
overruns §4.4 read as the box, and **both are money-adjacent** — payment recovery
and value movement — so their passing is worth more than the count suggests. It
also confirms the reading: work that missed a round number by 0.03% fits on a
quieter box. **The prediction in §4.4 that all three would clear on a cheaper
teardown is two-thirds borne out without the teardown having changed at all.**

**The `integrations` → `phoneOrders` cascade, root-caused — this chain was not
previously recorded and it strengthens the §4.4 recommendation with a reason.**
`integrations.test.js` does its teardown *inside the timed test body*
(`integrations.test.js:2777`), not in `afterAll`. So:

1. the 900 s timeout abandons the test **before** its cleanup line,
2. ~100,000 `loyaltyProfileLink` rows survive into the next file,
3. `phoneOrders` runs next (size order) and its `beforeAll` calls `wipe()`,
4. `customer.deleteMany()` must cascade across all of them —
   `LoyaltyProfileLink.customer` *and* `.connection` are both `onDelete: Cascade`,
5. that exceeds `hookTimeout: 30000`, the hook fails, and vitest reports **all 77
   tests as skipped** (file duration 59,550 ms).

So the 77 skipped are **not** a `phoneOrders` defect and not caused by `61f6d3c`.
The DB read 0 links / 0 customers afterwards, so the damage stopped at one file
and the six files after it passed. **The generalisable point: a teardown inside a
timed body does not just fail to clean up, it poisons the *next* file.** Moving
it to `afterAll` costs nothing and is the fix §4.4 already asked for — this is
the reason it matters more than tidiness.

**Source identity of this run — and it is NOT clean. Recorded as a failure of my
own check, because §4.3's contamination rule exists precisely for this:**

| check | result |
|---|---|
| lane `HEAD` at launch | `61f6d3c…1360` |
| `git status --porcelain` at launch | empty |
| tracked tree object | `373f8903…1300` |
| `git status --porcelain` **at finish** | **2 files modified** |

Two foreign edits landed on the working tree:

- **`backend/src/api/routes/tableQr.js`** — mtime **07:48:48**, i.e. **5 seconds
  before the vitest process started.** My porcelain check ran moments earlier and
  came back empty, so it was true when taken and stale when used. The run
  therefore did **not** execute tree `373f8903`; it executed that tree plus a
  one-line deletion. It was the dead `OPEN_STATUSES` const from §7, and its owner
  **committed** it at 08:27:44 as `0056db1` (§9) — which is why it is gone from
  `porcelain` now. Reviewed and sound; it does not affect any result above,
  because the const it deletes was unreferenced.
- **`backend/tests/billSplit.test.js`** — mtime **08:13:16**, **inside the run
  window**, and `billSplit` ran in this run. Both the committed and the modified
  version declare 32 tests, so `✓ (32 tests)` **cannot discriminate which bytes
  executed.** The honest verdict for that one file in that one run is
  **INCONCLUSIVE**, not pass.

This is the start-only-guard trap in its exact documented form: a clean
`porcelain` at launch proves nothing about a co-tenant's edit five seconds later,
and a run needs a **finish** identity check to make any claim at all. Take that
as the standing procedure, not as an incident.

**So what actually certifies the §6.3a fix is not this run.** It is the dedicated
gate at **07:40:44** (71/71, 24.14 s) which finished *before both* edits, and the
re-run at `5dc06e8` below. The value of this full run is the other 53 files —
the blast-radius evidence — and that part is unaffected by either edit.

**The zero-skipped bar this lane was asked to clear is NOT cleared by this run.**
77 skipped, and the blocking cause is `integrations`' in-test teardown, which is
outside `x/tables` and unfixable from here without editing another lane's file.
That is a real remaining item, not an acceptable final gate.

**`5dc06e8` — the covers test strengthened to prove a double, re-gated.** The
mid-run edit above turned out to be a genuine improvement, so it was proved and
kept rather than reverted. The `61f6d3c` test recorded covers only *after* the
split, so its control failed with `expected null to be 4` — a *misplacement*.
Recording pax 4 before the split and correcting to 5 after makes the same defect
produce `SUM(pax) = 9` at a table of five, which is what a covers report prints.
Two controls, the second because the first cannot reach the line it needs to:

| control | result |
|---|---|
| `desc` ordering restored | FAILED `expected 4 to be 5` — the correction reached the cheque, aborting at the opening assertion |
| `desc` + opening pair relaxed | FAILED **`expected 9 to be 5`** at `billSplit.test.js:509` — the aggregate. **This** is the control that proves the double |

Without the second, "nine" would have been an unverified aside in a comment —
the same failure mode as the tautology removed in `61f6d3c`, caught the same way:
by asking what the control actually *reached*. Both reverted; `tables.js`
verified byte-identical to `61f6d3c` before committing; gate re-run **71/71,
0 skipped, 26.38 s, exit 0**.

**`9f456b8` — the reason two controls were needed at all, removed.** Needing a
second control only to get past the first is a defect in the test's ordering, not
a fact about the tooling. The aggregate is the assertion whose failure states the
harm, and it sat *below* two row assertions that abort any failing run before it
is reached:

```
expect(original.pax).toBe(5)    <- control dies here, "expected 4 to be 5"
expect(cheque.pax).toBeNull()
...
expect(agg._sum.pax).toBe(5)    <- never reached
```

Reversed — aggregate first, then where the five actually sits. **One control now,
nothing relaxed: `desc` restored fails `expected 9 to be 5` at
`billSplit.test.js:509` on the first try.** Same 32 tests, same assertions, same
values; what changes is that the next person to break this route sees the
*reported figure* go wrong, in the units a covers report is denominated in,
without editing the test to find out. The row assertions still follow and still
matter — they are what makes the sum right for the right reason rather than by two
errors cancelling.

**A test whose most important claim its own negative control cannot reach is
ordered wrongly.** That is the transferable lesson from `5dc06e8` → `9f456b8`,
and it is worth more than either commit: the two-control workaround *looked* like
rigour and was actually a symptom. Gate **71/71, 0 skipped, 18.89 s, exit 0**.

**Closing gate on the final HEAD, widened to cover `0056db1`.** The gates above
are three suites; `0056db1` landed in the middle of them and touches
`tableQr.js`, which none of the three loads. Re-run at `9f456b8` with the tree
clean and `git diff HEAD -- backend/src` **empty** (so the reverted control is
provably gone, not merely believed gone):

| suite | tests |
|---|---|
| `billSplit` | 32 |
| `tableQr` | 74 |
| `tablesTransfer` | 20 |
| `tablesService` | 19 |
| `floorplan` | 16 |
| **total** | **161 passed, 0 failed, 0 skipped**, 46.46 s |

Two independent confirmations of the strengthened test on this HEAD, not one:
`billSplit` alone at **32/32, 0 skipped, 13.61 s**, then inside the five-suite
gate above. `floorplan` is in the list because it is the third reader of the
`OPEN_STATUSES` triplet (`floors.js`, `tableQr.js`, `tables.js`) and the one
`0056db1` did *not* touch — if that commit had removed a const something still
read, this is where it would surface.

### 4.5 Conflict surface on `orders.js` — checked against every live lane

`src/api/routes/orders.js` is the most contended file in the programme, so I
measured the overlap rather than hoping. At the time of `80c677b`, the lanes
with **uncommitted** edits to it were `int-payments`, `promotions`,
`vc104-salvage`, `w2-frontend` and this one. `lib/money.js` had exactly one
other editor (`w2-frontend`) and **I did not touch it**; `lib/orders.js` had
two (`promotions`, `w2-frontend`) and **I did not touch that either**. The
single money evaluator stays where it was.

My change is **3 hunks, +90 / −1**:

| hunk | what | contended? |
|---|---|---|
| ~26 | `import { audit }` → `import { audit, auditRequired }` | **no** — the only *existing* line I modify, and no other lane edits it (`w2-frontend` mentions `lib/audit.js` in a comment only) |
| ~46 | 3-line `import { splitBill }` inside a `// ==== LANE tables ====` marker | no — follows the established lane-marker convention, adjacent to `// ==== LANE inventory ====` |
| ~1141 | the 86-line `POST /:id/split` block, inserted at the `// --- bill ---` boundary | no — no other lane has a hunk within 170 lines |

A caution for whoever merges: **the lanes sit on different base commits**, so
raw hunk line numbers look like they collide when they do not. The `orders.js`
blob differs per lane (`ff3a79f` here vs `1238a10`, `b47c439`, `242219f`
elsewhere), which is why several lanes appear to "all edit line 26" while in
fact line 26 is a different line in each tree. Compare by content, not by
offset.

**Window 3 coordination:** checked and there is no contention. W3's own
handover (`WINDOW-3-HANDOFF.md:87`) pins its `orders.js` claim to "exactly one
call — `routeKotItems(tx, …)` at orders.js:625, inside the existing KOT
`$transaction`", which is already committed and present in my base; and both
its worktrees (`kitchen`, `kitchen-int`) were clean of `orders.js`,
`lib/money.js` and `lib/orders.js` edits. So W3 owns neither the money rules
nor the order route broadly, and split touches neither of its surfaces —
except to keep `KitchenItem.orderId` truthful, which is a *consumer* of its
model, not a change to it.

**Split is the delta the integration candidates do not have yet — checked, not
assumed.** Three branches look like they carry this lane's work. None carries
the split:

| branch | `f7132c5` pax | `ef6bc79` shared fix | `5338788` transfer | `80c677b` split | `c574934` headroom |
|---|---|---|---|---|---|
| `x/tables-merged` (`55eb62e`) | yes | yes | yes | **no** | **no** |
| `candidate/tables-20260926-0603` (`18c0cd3`) | yes | yes | yes | **no** | **no** |
| `candidate/tables-20260926` (`0ad8f00`) | yes | yes | yes | **no** | **no** |

So somebody has already integrated this lane **through transfer** and stopped
there — reasonably, since split did not exist when they branched.
`x/tables-merged` is **11 commits ahead** of `x/tables` while `x/tables` is
**2 ahead** of it, and those 2 are exactly `80c677b` and `c574934`. The two
histories have diverged, so *do not* treat `x/tables-merged` as a superset of
this lane and do not fast-forward either onto the other. **The split is a
2-commit cherry-pick onto whichever candidate is current**, and the merge check
below is what says that is safe.

**Re-checked against current `main` on 2026-09-26, because the surface above
was measured at `80c677b` and peers have committed since.** `main` has moved
**10 commits** past our shared merge-base `77242fe` (now at `828208a`). It
touches **none of the four files this lane cares about** — not
`src/api/routes/orders.js`, not `src/lib/tables/splitBill.js`, not
`src/lib/money.js`, not `src/lib/orders.js`. What it does touch is
`schema.prisma` (one loyalty index migration), `lib/reporting/exceptions.js`
(the §7 fix), and eleven test files.

The merge is clean, and not by inspection — by asking git:

```
git merge-tree --write-tree main x/tables   →  exit 0, tree 947eec53, 0 conflicts
```

Two of those ten commits are worth flagging to whoever merges, because they
change the ground this lane's *timings* were measured on:

| commit | what it does |
|---|---|
| `d625370` | indexes the cascade Postgres was table-scanning, so deleting customers stops being quadratic |
| `94fec3d` | switches the per-test wipe to `DELETE`, so it stops rebuilding 672 files |

Those attack the shared-teardown cost that §4.4 and §7 blame for most of the
timeout failures in this programme. So the 45 s grants in `billSplit.test.js`
were sized against a **slower box than the one that now exists.** They are
still correct — a grant is an upper bound, not a target, and every one of those
tests passes far inside it — but do not read them as a claim about how long the
work takes today. Re-point this lane at current `main` before quoting any
timing from this document as current.

## 5. What remains in this lane

- **All four table verbs are shipped.** Merge was the last one — its
  `OrderStatus` blocker is **resolved** (§6.1) and it shipped as `12fa573`.
- **Task 4 — split bill is DONE and verified**, shipped as `80c677b`. See
  §5.1 for the measurement that shaped it and §4.4 for the run that certifies
  it. It **never shared merge's blocker**, which is a correction to what an
  earlier revision of this document said.
- Frontend for transfer / covers / split / merge: still nothing. All API-only.
  That is the one substantive thing left in this lane.

### 5.1 Split bill — `80c677b`, and the measurement that shaped it

An earlier revision of this document said split "shares merge's blocker."
**That was wrong and I am correcting it rather than leaving it.** Merge was
blocked because a bill gets *emptied* and needs a terminal status. A split
does not have to empty anything: the original order keeps its id and becomes
cheque #1, and the other cheques are new orders. Nothing reaches a terminal
state, so `OrderStatus` never comes into it. Keeping the original id is also
the better model independently — payments, KOT references and audit rows that
already point at that order still resolve after the split.

What split *is* hard for is money, and I measured it instead of guessing.
`computeOrderTotals` in `lib/money.js` is pure, so conservation can be tested
with no database at all — 4000 randomised baskets per policy, 2–6 lines, mixed
GST rates (0/5/12/18/28%), checking only whether `sum(cheques) == whole` to
the paise:

| Split policy | discount | mismatched | worst delta |
|---|---|---|---|
| copy the discount to both cheques | none | **0/4000** | 0 |
| copy the discount to both cheques | PERCENT | 1073/4000 | 3 p |
| copy the discount to both cheques | FLAT | **4000/4000** | **−1001610 p (−₹10,016)** |
| keep it on the first cheque only | PERCENT | 4000/4000 | **+345913 p** |
| keep it on the first cheque only | FLAT | 3980/4000 | **+3405521 p (+₹34,055)** |
| apportion FLAT by subtotal, copy PERCENT | none | **0/4000** | 0 |
| apportion FLAT by subtotal, copy PERCENT | either | ~1060/4000 | 3 p |
| apportion the whole's FINAL per-cheque shares | none | **0/4000** | 0 |
| apportion the whole's FINAL per-cheque shares | either | ~40/4000 | **1 p** |

Read the two catastrophic rows first. Copying a FLAT discount onto both
cheques gives the money away twice and in the worst observed basket the two
cheques summed to **zero against a ₹8,414 bill**. Keeping it on the first
cheque only *overcharges* by up to ₹34,055, because `recomputeOrder` clamps a
FLAT discount to `min(value, subtotal)` and the shrunken first cheque can no
longer absorb it. Either of these shipped silently would be a till that does
not balance, in favour of the shop or the guest depending on the basket.

The best policy — evaluate the whole once, then hand each cheque a FLAT
discount equal to the sum of the `discountShare`s its own lines already
received — is off by **at most 1 paise, ~1% of the time**. That residue is
real and not fixable by apportioning harder: `distributeProportional` is
exact within one order, but re-running it on a subset can move a line's share
by a paise, and when lines carry different GST rates that paise moves the tax
with it. Exactness would require carrying the already-computed per-*line*
money across untouched, which contradicts `recomputeOrder()` being the single
evaluator — a split cheque would then disagree with its own recomputation.

**So it refuses what cannot be done exactly** — which is the same move as
refusing a BILLED transfer, and for the same reason. All six refusals below
are implemented in `lib/tables/splitBill.js` and each has a test:

1. Split is allowed when the order carries **no order-level discount** —
   observed **0/4000** mismatches, exact by construction, no policy needed.
2. Split **refuses an order with an order-level discount**, with a message
   telling staff to remove the discount, split, then apply it per cheque.
   That keeps the paisa-exact requirement rather than negotiating it down to
   "within a paise".
3. Split **refuses an order with APPLIED `PromotionRedemption` rows.**
   `reevaluatePromotions` re-runs on every money change, so a "spend ₹500 get
   ₹50" promo would reverse on both smaller cheques and the guest silently
   loses a benefit they had already earned — and `redemptionCount` would be
   decremented on the way. Not a rounding question; a promise question.
4. Split **refuses anything not `OPEN`**, and refuses an order with any
   `Payment` rows — a partly-settled bill has no unambiguous division.
5. Split **refuses a non-`POS` channel bill** — in practice an aggregator
   order. This one is structural rather than arithmetic, and it was found by
   reading the schema rather than by the probe. `Order.channel`,
   `.channelProvider` and `.externalOrderId` are written together in exactly
   one place (`lib/integrations/aggregatorOrders.js:230`), and
   `AggregatorOrder.orderId` is `String? @unique` — so a split cheque could
   never carry a provider record. Copying `channel` alone would leave an
   `AGGREGATOR` cheque whose provider is `null`, and
   `lib/integrations/accounting.js:179` interpolates that field straight into a
   Tally narration, posting "`null` order". Copying it would be worse: two
   bills would claim to be the same Swiggy order. This costs the dine-in path
   nothing — `channel` is `@default(POS)` and nothing else in `src/` ever sets
   it, so QR, phone, till, dine-in and takeaway bills are all still splittable.

6. Split **refuses moving every line** — that is a rename, not a split, and it
   would leave an empty original that only merge's missing terminal status
   could describe.

Every one of those is a refusal, not a weakened assertion: the paisa-exact
requirement stays exactly as written, and the cases that cannot meet it are
turned away in words a floor screen can show. Owner may later choose to relax
**(2)** by accepting a 1-paise variance, but that is their call to make and it
is recorded in §6, not assumed here. (1) is the case that is already exact and
needs no relaxing.

**The conservation check is also enforced at runtime, not just in tests.**
After `recomputeOrder()` has run on both cheques, `splitBill` sums their totals
inside the same transaction and compares against the total before the split; a
mismatch throws and the whole split rolls back, leaving the original bill
untouched. The arithmetic above is not trusted at runtime either.

#### Each required proof, against the test that proves it

The brief for this lane named seven things split had to prove. Rather than leave
a reviewer to infer them from prose, here is each one against the **actual test
name** that carries it — all 29 in `tests/billSplit.test.js`, all DB-backed, no
mocks, **29/29 in the full 56-file suite** (§4.4):

| required proof | test(s) |
|---|---|
| **amount conservation** | `adds up to the paise, and neither cheque invents money`; plus `conserves when the lines moved are %j` ×5 — every distinct cut of one mixed-rate basket (`[0]`, `[1]`, `[0,1]`, `[1,2]`, `[0,2]`); plus the runtime guard above |
| **invoice allocation** | `gives each cheque its own invoice number at billing` |
| **discount allocation** | `discounts each cheque on its own subtotal, not the other's`; and `refuses a discounted bill and tells staff what to do instead` for the pre-existing-discount case (§6.2) |
| **kitchen item / KOT consistency** | `re-points the kitchen item but leaves the ticket it was cooked on` |
| **audit records** | `writes an audit row naming who split what` — asserts the **actor** as well as the action; see the note below |
| **tenant scope** | `keeps both cheques on the same table, visit, store and tenant`; `refuses a bill the caller cannot see, by message and not just by status`; `refuses a manager from another store in the same company` |
| **documented aggregator refusal** | `refuses an aggregator bill, which the provider settles` |

The remaining tests are the refusal surface and the role matrix —
`refuses once money has been taken against the bill`, `…a bill that has already
been issued`, `…to move every line, because that is not a split`, `…a line that
belongs to a different bill`, `…the same line listed twice`, `…an empty
selection`, `…a voided line`, and a cashier/kitchen/captain/platform-operator
matrix.

One of the 29 is a **control, not a feature test**:
`is actually a mounted route, and not a 404 the controls mistook`. Every
negative test above asserts a refusal, and an unmounted route returns 404 —
which would let the whole refusal suite pass green against a route that does not
exist. That test exists so a 404 cannot be mistaken for a policy decision.

##### The audit test asserted the action and not the actor — fixed

Found by auditing my own assertions after the certifying run, not by a failure.
The test is *named* `writes an audit row naming **who** split what`, and it
checked the row count, `entityId`, `meta.chequeId` and `meta.movedItemIds` —
all of which are the **what**. It never checked the who.

That is not a cosmetic gap. `lib/audit.js` derives every actor column from the
request with a null fallback —

```js
actorId:    req.user?.id    ?? null,
actorEmail: req.user?.email ?? null,
actorRole:  req.user?.role  ?? null,
```

— and all three are nullable in `PosAuditLog`. So an auth context that stopped
resolving would write **three NULLs and no error**, and every assertion in that
test would still pass. For a money action the actor is the one thing the row
exists to record. It now asserts all three.

**The new assertions were proved able to fail before being trusted.** A passing
test is not evidence that a test works; §3.2 and the `false pass` note in this
programme both turn on that. Negative control: expected role flipped to
`CASHIER`, one test run —

```
AssertionError: expected 'BRANCH_MANAGER' to be 'CASHIER'
Received: "BRANCH_MANAGER"
```

— which fails as required *and* independently confirms the route really writes
`BRANCH_MANAGER`. Reverted, then the whole file re-run.

**Two further implementation notes an integrator needs:**

- `KitchenItem.orderId` is a denormalised `String` with **no foreign key** —
  only `@@index([orderId])`. Nothing in the database would have caught it going
  stale, so the moved lines' kitchen rows are re-pointed explicitly, each with
  a fresh `nextChangeSeq(tx, branchId)` so a connected kitchen screen re-reads
  instead of trusting its cache. Their `kotId` is deliberately **left alone**:
  the kitchen really did cook those items on that ticket. Same argument as the
  laminated QR card that stays on the old table during a transfer.
- The gate is `requireRole(...)` **AND** `requireAction('bill.split')`, not
  `requireAction` alone. This is a money-policy decision and it is deliberate:
  `permissions.js:274` gives `POS_SUPER_ADMIN` **every** action key, and
  `bill.split` is *not* in `SUPPORT_GRANT_REQUIRED`, so an action-only gate
  would let the VEXO platform operator divide a tenant's bill — contradicting
  the contract at the top of `orders.js`. `requireRole` does not special-case
  `POS_SUPER_ADMIN`, and that is what keeps ATC read-only here. `CAPTAIN` *is*
  in the role list so an owner's `customPermissions` grant works as asked,
  while `requireAction` stays the real authority — by default a captain may
  seat a party but not divide its money. Note this is **not** the shape of the
  neighbouring `promoGate` (`orders.js:957`), which is `requireAction`-only and
  therefore ATC-writable; that is another lane's policy and I did not change
  it, but it is recorded in §7.
- **Two columns `chequeFrom()` does not copy, which I found by auditing the
  `Order` model against my own function *after* committing.** Neither is a
  money or isolation fault; both are judgment calls I am flagging rather than
  quietly deciding:
  - **`note`** (order-level free text) stays on the original. It reaches the
    kitchen — `printing.js` puts `order.note` on the KOT — so if the party said
    "no nuts" and a *new* item is later added to cheque 2, that ticket would not
    carry the note. Against copying: the note can be bill-specific ("split for
    Mr Sharma"), and duplicating an instruction onto two tickets has its own
    failure mode. It is a one-line change in `lib/tables/splitBill.js` either
    way. I left it uncopied rather than change money-adjacent code after
    certification, but if the owner wants it copied, that is the safer default
    for an allergy note and I would not argue.
  - **`qrCodeId`** stays null on the cheque while **`source` is copied**, so a
    cheque split off a QR order reads `source: QR` with no `qrCode` link. That
    is deliberate: `source` is lineage (this bill came from a QR order, which is
    true) whereas `qrCodeId` is a live link, and the printed card is pinned by
    `activeTableId @unique` — the same reason transfer leaves the card behind.
    `QrSubmission.orderId` also stays with the original, which is correct: that
    guest really did submit to that bill.
- **The `Kot` rows stay on the original order, and that has two visible
  consequences a floor screen must expect.** This is not a shortcut — it is
  forced. A single KOT can contain items that a split sends to *both* cheques,
  so `Kot` is one-to-many across what become two orders and there is no correct
  order to re-point it at. Moving it would misattribute the items that stayed.
  What follows:
  - `GET /orders/:id/kots` on the **new cheque returns `[]`**, even though its
    items were cooked. The tickets are listed under the original.
  - KOT **reprint is scoped** `{ id: kotId, orderId: order.id }`
    (`api/routes/printing.js:316`), so reprinting that ticket *from the new
    cheque* answers `404 KOT not found`. It still reprints correctly from the
    original order, so **no ticket becomes unreachable** — but a UI that offers
    "reprint" on a split cheque must target the original.

  The kitchen itself is unaffected: `KitchenItem.orderId` *is* re-pointed, so
  the KDS names the right cheque. It is only the *ticket* record that stays
  with the send that produced it.
- **Split makes "two open bills on one table" reachable for the first time**,
  and I checked what that breaks: nothing, but not by luck.
  `POST /orders:371` is the only place that enforces one-bill-per-table and it
  is an existence check (`findFirst` on `OPEN|BILLED`), so a third party still
  cannot open a bill at an occupied table — correct. Table transfer moves
  bills with `updateMany({ where: { tableId, status: 'OPEN' } })`
  (`lib/tables/transfer.js:194`), so **both** cheques follow the party to the
  new table, and transfer touches no money column at all, so conservation
  survives a transfer-after-split by construction rather than by test. No
  `findFirst`-on-order-by-table exists anywhere else in `src/`, so nothing
  silently picks one of the two.
- The audit row is written with **`auditRequired()`**, not `audit()`.
  `audit()` swallows failures by design; `auditRequired()` has no catch and
  rolls the caller back, so a split that cannot be accounted for does not
  commit at all.

Probe kept at `/tmp/vcxt-split-conservation.mjs`. It is pure arithmetic — no
database, no fixtures — so it is reproducible on any box with `node`.

> One honest note on the probe itself: its first version let `lineDiscount`
> exceed a line's gross, which produced negative line subtotals and made
> **every** policy look worse than it is. Baskets the real routes reject were
> driving the failure counts. The table above is from the corrected generator.
> A probe can fail wrongly just as easily as it can pass wrongly.
- `table.transfer` is **registered AND routed** as of `5338788`; `bill.split`
  is **registered AND routed** as of `80c677b`. Both action keys were
  registered early, in one edit, to avoid a second pass over a
  high-contention shared file — which is why an earlier revision of this
  document had to describe `bill.split` as "registered but not routed".
- **Covers cannot be set before the first item**, because `POST /orders`
  requires `items.min(1)` — there is no empty bill to attach them to. Left
  for the floor-screen work rather than worked around in the API.
- No frontend work in this lane. Transfer, covers and waiter are all
  API-only so far; nothing draws a floor screen.

## 6. Owner decisions needed

### 6.0 Why an undiscounted split conserves *exactly* — the structural reason, not the measured one

§5.1 justifies refusing a discounted bill with a measurement over 4000
randomised baskets per policy. That measurement is real, but it is the weaker
argument and I only found the stronger one while re-reading `lib/money.js` on
2026-09-26. **Anyone reviewing this feature should be given the structural
reason, because it decides whether the refusal is a preference or a
requirement.** It is a requirement.

`computeOrderTotals` (`src/lib/money.js:77-89`) computes tax **per line**:

```js
const shares   = distributeProportional(discountAmount, lineSubtotals);  // :77
const taxable  = l.lineSubtotal - shares[i];                             // :80
const lineTax  = l.taxPctMilli ? percentOf(taxable, l.taxPctMilli) : 0;  // :81
const taxAmount = outLines.reduce((a, l) => a + l.lineTax, 0);           // :84
total = subtotal - discountAmount + taxAmount;                           // :89
```

**With no discount and no promo**, `discountAmount` is `0`, so
`distributeProportional` returns all zeros, so `taxable === l.lineSubtotal` —
a function of **the line alone**. Every term in `total` is then additive over
any partition of the lines:

- `subtotal` = Σ `lineSubtotal`
- `taxAmount` = Σ `lineTax`, and each `lineTax` depends on nothing outside its
  own line
- therefore `total(A) + total(B) = total(A ∪ B)` for *any* cut

So conservation is **exact by construction — there is no rounding to lose.**
That is why the five per-cut tests pass to the paise rather than within a
tolerance, and it is a much better reason than "I tried 4000 baskets."

**With a discount, the same algebra is what breaks it.** `shares[i]` comes
from a largest-remainder allocation over *the set of lines in the order*.
Change the set — which is precisely what a split does — and every line's
`discountShare` changes, so its `taxable` changes, so its `lineTax` changes.
The ±1 paise drift I measured for the best apportioning policy is not a bug in
that policy; it is the largest-remainder allocation redistributing its
leftovers across a different set. **No apportioning scheme can avoid it**,
which is why the refusal is the only answer that lets this endpoint *assert*
conservation instead of hoping for it.

**This also explains why the runtime guard in `splitBill.js:284` has no test,
and why that is correct rather than an omission.** The guard
(`if (sum !== totalBefore) throw`) is unreachable for exactly as long as
`taxable` stays line-local. It cannot be triggered from the API without first
introducing the defect it exists to catch, and the suite is DB-backed with no
mocks (§3), so there is no honest way to reach it from a test. What it really
guards is a **future** change: the day someone makes `taxable` depend on
order-level state — an order-level service charge apportioned across lines, a
switch to order-level tax, a new promotion type — conservation stops being
additive and this throw fires inside the transaction and rolls the split back.
It is a regression detector for an invariant that lives in another lane's file.
Do not delete it because coverage tools call it dead.

### 6.1 `OrderStatus` had no terminal value for a merged bill — RESOLVED, merge shipped in `12fa573`

**Decision: `OrderStatus.MERGED` was added.** Merge is live. This section is kept
because the reasoning is the load-bearing part, and because one line of it was
wrong in a way worth recording.

`VOID` was rejected for the reason originally stated: `lib/reporting/metrics.js:244`
counts status `'VOID'` into `voidedOrders`, so reusing it would have reported every
merge as a cancelled sale and corrupted the void rate an owner reads to spot till
fraud. A merge is the opposite of a cancellation — the money did not go away, it
moved onto the other cheque.

**What I got wrong above: "plus reporting updates".** There were none. Every
Order-status filter in `src/` is an **allowlist**, so `MERGED` falls outside all of
them without one being edited: `SALES_STATUSES` keeps it out of net sales, tax,
discounts and the AOV denominator; `OPEN_STATUSES` keeps it off the floor and frees
the table; the dues query asks for `BILLED` alone. The status **guards** run the
other way — `!== 'OPEN'` — so a merged bill refuses new lines, payments, billing,
splitting and transferring by default, and the tests prove that rather than
asserting it in a comment.

Exactly **two** places needed a word added, and both are **denylists**:
`display.js:232`, where a merged bill would otherwise sit on the customer screen
emptying itself to zero in front of the guest, and the `GET /orders?status=` filter
list at `orders.js:3092`, so a merged cheque can still be pulled up while
reconciling a `BILL_MERGE` audit row.

The enum value is in its **own migration** (`20260926091200_order_status_merged`)
because Postgres cannot read a value in the transaction that added it — the same
reason `20260924900000_payments_enum_values` stands alone.

Gated on the existing **`table.transfer`**, *not* a new permission key:
`permissions.js:103` already registers it as "Move or merge a party between
tables", so minting `table.merge` would have silently removed the capability from
every role set that already had it until somebody re-granted it.

**Conservation is exact, and proved by negative control rather than assertion.**
The in-code assertion inside the transaction is deliberately a *pair* — the
survivor must carry the whole amount **and** every merged-away bill must carry
nothing — because "everything sums to what it summed before" also passes when
money stayed behind on the source and the survivor came out short, which is the
exact failure a merge is prone to. Removing the source recompute → refused,
"243.34 / 681.99 / 715.32 would be left behind", 17 tests red. Disabling the
discount guard → refused by the conservation assertion itself, "would come to
1017.97 but the two bills are 961.49" — ₹56.48 of real money, on both sides.

That second control also found a fault in the **test**, not the library: the
discount fixture wrote `discountType` without recomputing, leaving a stored total
that excluded its own discount — a state no floor can reach. The fixture now calls
`recomputeOrder` and asserts it really is discounted.

**Evidence:** lane gate 5 files / **112 passed / 0 skipped / exit 0**. Candidate
gate on `16a22b0` (= `main 728a57c` + this lane's `12fa573`), fresh DB, full
43-migration chain: **57 files / 1767 passed / 0 skipped / exit 0**, with
`tablesMerge` 32, `billSplit` 32, `tablesTransfer` 20 green *inside* the full run.
Migration checksum `803b04e3…` matches the ledger; `migrate diff` reports an empty
migration, so zero drift. Deployed to isolated staging `pos-stgtbl` on
`127.0.0.1:8113` — see `/home/atc-noc/pos-stg-tables-16a22b0/10-STAGING-RESULTS.md`.

**Not integrated.** `12fa573` is not yet an ancestor of the expansion `main`;
landing it is the integration owner's job, not this window's.

### 6.2 Does a split have to balance to the paisa? — shapes SPLIT

Not a blocker, and it did not block shipping: **split is live in `80c677b`
under the first option below.** The owner may still prefer the second, so the
choice is recorded rather than buried:

- **What shipped (§5.1):** split refuses a discounted or promotion-bearing
  order. Always exact — `sum(cheques) == whole` is literally true, asserted at
  runtime inside the transaction and in tests across five different cuts of the
  same mixed-rate bill. Costs staff two extra steps on a discounted bill:
  clear the discount, split, re-apply per cheque.
- **The relaxation available:** allow it and accept a **≤1 paise** variance per
  split, ~1% of splits, using the final-shares apportioning already measured in
  §5.1. Fewer refusals, but `sum(cheques) == whole` stops being literally true,
  and any future audit that asserts it will find real mismatches.

I shipped the first because it is the one that does not quietly redefine the
requirement, and because the instruction I was working under forbids weakening
an assertion to make a case pass. Switching to the second is a contained
change — drop the `discountType` refusal in `lib/tables/splitBill.js`, apportion
the whole's final `discountShare`s onto the two cheques, and relax the runtime
conservation assertion to a ±1 paise tolerance plus a matching reporting
tolerance. It is **not** a rewrite, but it **is** an owner decision about money
and I did not make it on their behalf.

### 6.3 `POST /tables/:id/service` after a split — the pax hole my own feature opened

> **RESOLVED 2026-09-26 — the owner chose, and it is fixed, tested and committed.**
> The instruction was *"fix the pax hole"*, which decides the reporting-semantics
> question left open below: **option 2, split the fields by their meaning.** The
> implementation, the three regression tests and the negative controls that prove
> those tests can fail are in **§6.3a**, immediately after this section. Everything
> from here to §6.3a is the original diagnosis, left unedited on purpose — it is
> the record of what was wrong and why it was invisible, and rewriting it in the
> past tense would destroy the evidence that the fix was aimed at a real defect
> rather than at a test.

**This one is mine, it is not covered by any test, and it defeats the exact
invariant the split was designed around.** Found by self-review on 2026-09-26,
not by a failing test, which is the reason it is worth writing down carefully:
nothing in the suite would ever have told anyone.

`currentOrderOf` (`src/api/routes/tables.js:280`) is:

```js
prisma.order.findFirst({
  where: { tableId, status: { in: OPEN_STATUSES } },   // ['OPEN','BILLED']
  orderBy: { createdAt: 'desc' },
})
```

That `orderBy` was decoration. Before split, a table could hold **only one**
open order — `POST /orders` refuses a second (`orders.js:371-375`) — so
`findFirst` had nothing to choose between. **Split makes two reachable for the
first time, which silently promoted that `orderBy` to load-bearing**, and it
resolves to the newer row: the cheque.

The reachable sequence, all legal calls, no errors:

1. Table S1 — one bill, `pax = 4`, waiter Meera.
2. Split. Original keeps `pax = 4`; the cheque gets `pax = null`, deliberately,
   so that summing covers over the table still gives 4.
3. Staff `POST /api/tables/S1/service { pax: 4 }` — re-confirming covers, or a
   relieving captain naming themselves.
4. `currentOrderOf` returns **the cheque**. `cheque.pax = 4`.
5. `SUM(pax)` over the table's open orders is now **8, for four guests.**

Step 2 is the entire point of `pax: null`, and step 4 undoes it. My own test
comment says why it matters — *"Copying pax would report eight the first time
anything SUMs it"* — and that is now reachable by a different door. `waiterId`
has the milder version of the same problem: a waiter change after a split lands
on the cheque only, so sales-per-waiter credits half the table.

**Why it is an owner decision and not just a fix I should have made.** The two
sane behaviours differ in floor workflow, not in code difficulty:

- **Refuse** when a table has more than one open cheque, with a message naming
  them. Safe and honest, but it blocks a previously-working action for staff who
  only want to name the server.
- **Split the fields by their meaning** — `waiterId` to *every* open cheque,
  because one server served the party and that matches what the split already
  does when it copies `waiterId`; `pax` to exactly the one order that already
  carries it, because covers are a property of the party and must be recorded
  once. Better for staff, more surface, and it changes what an existing endpoint
  does.

`pax` feeds sales-per-cover, so this is a reporting-semantics call, and the
instruction I am working under says not to invent business policy. **Recorded,
not fixed.**

**How urgent: latent, and there is a clean window to fix it in.** Reaching step 4
requires step 2, and step 2 requires calling `POST /api/orders/:id/split`, which
**no frontend calls yet** (§8). So on any deployment today the second open cheque
cannot come into existence through the UI at all, and the double-count is
unreachable in practice. That is the whole reason this is worth fixing *now*
rather than arguing about: **fix it before the floor screen ships and there is no
migration, no backfill and no corrupted history to reconcile.** Ship the screen
first and the same fix acquires a data-repair problem.

**Whether it has already happened — read-only, safe to run anywhere**, for
whoever has the access I do not:

```sql
SELECT "tableId",
       count(*)                                        AS open_cheques,
       count("pax") FILTER (WHERE "pax" IS NOT NULL)    AS cheques_carrying_pax,
       sum("pax")                                       AS summed_pax
FROM "Order"
WHERE "status" IN ('OPEN','BILLED') AND "tableId" IS NOT NULL
GROUP BY "tableId"
HAVING count(*) > 1
   AND count("pax") FILTER (WHERE "pax" IS NOT NULL) > 1;
```

**Zero rows is the expected and correct answer**, and it is what makes the
"latent" claim above checkable instead of assumed. Any row is a table whose
covers are being counted more than once; `summed_pax` is the inflated figure a
sales-per-cover report would divide by. **I have no production access and have
not run this** — same standing as the composite-FK precheck in §7, and stated
the same way rather than implied to have passed.

**I deliberately did not patch `src/` to fix this while the certifying run was
in flight.** Vitest resolves `src/` imports lazily per test file, so editing
source mid-run contaminates every file that has not started yet — that is
precisely how the `5338788` run was reduced to diagnostic-only (§4.3). A fix
here needs its own clean run and its own test, and it should be one commit that
does nothing else.

### 6.3a The fix — and a second instance of the same root cause, found while fixing the first

The owner's instruction *"fix the pax hole"* settles §6.3's open question. Option 2
is implemented: **`waiterId` goes to every open cheque, `pax` to exactly one.**

**Why option 2 and not the refusal.** Refusing would have blocked an action that
works today — a relieving captain naming themselves on a party whose bill happens
to have been divided — to prevent a double-count that has a correct answer. And
`waiterId` on every cheque is not a new policy invented here: it is the policy
`splitBill.js` already applies when it *copies* `waiterId` onto a new cheque. The
two would have disagreed otherwise, which is worse than either.

**The rule, and where it lives.** Two pure functions in `lib/tables/service.js`,
next to `serviceUpdateData` and for the same reason — the policy is testable
without a database and cannot drift from the writer:

```js
export const paxAnchorOf     = (bills) => bills[0] ?? null;                      // oldest open bill
export const waiterTargetsOf = (bills) => bills.filter((b) => b.status === 'OPEN');
```

The anchor is the **oldest** open bill. That is the original, because
`splitBill.js` creates cheques with `pax: null` and never touches the original's
`pax` — so the oldest bill is already the one carrying the covers. "Oldest"
rather than "whichever row has `pax`" for two reasons: it is still defined
*before* any covers have been recorded, and it is stable, so a party that splits
twice has one anchor instead of a race between two cheques.

**A second defect, not in §6.3, found while fixing it.** `CURRENT_ORDER_INCLUDE`
— the floor list and every `GET` on a table — read:

```js
orders: { where: { status: { in: OPEN_STATUSES } }, take: 1 }   // no orderBy AT ALL
```

§6.3 blamed a `desc` that should have been `asc`. Here there was **no ordering to
be wrong**: `take: 1` on an unordered query returns whatever Postgres hands back.
So a floor screen could be given the *cheque* and display a table of four with no
covers against it, and it could display a different bill on the next 15-second
poll with nothing changed. Same root cause as §6.3 — split made two open bills
reachable and silently promoted every "there is one order" assumption to a
defect — but a different symptom class: §6.3 corrupts a stored figure, this one
misreports a correct one. **Both are fixed in the same commit**, because they are
one cause and a reader who finds one should find the other.

**All three readers were checked, not just the two that were wrong.**
`OPEN_STATUSES` is declared separately in `tables.js:80`, `floors.js:31` and
`tableQr.js:45`, so "split broke every reader that assumed one open order" needed
verifying rather than asserting. `floors.js` is clean: its `take: 1` at line 481,
and the `some:` filters at 194 and 620, are **existence tests** — the code asks
`table.orders.length > 0` to mean "has an open order" and blocks a rename or a
retire either way, so which row Postgres returns cannot change the answer.
`tableQr.js` never reads a single order through that const at all. `tables.js` was
the only place that cared *which* row it got, and it cared in two places, both
fixed here. That is why this commit touches one route file and not three.

`findFirst` → `findMany` for the write path (`openBillsOf`), ordered oldest-first,
and the write became a `$transaction`: it is now up to two statements —
`updateMany` for the server, `update` for the covers — and a party must never end
up with its server changed on one cheque and not the other. Nothing in it calls
`recomputeOrder()` and no amount column is written, so **no total can move**;
that is the whole reason covers and server live in `lib/tables/service.js` and
not near the pricing path.

**Refusals are unchanged.** `assertServiceEditable` still produces both messages,
but it is now asked about the row each field actually lands on: covers may only
change while the bill that *owns* them is unissued, the server may change on any
cheque still open. With one bill on the table both checks reduce to exactly the
single check that was there before, so nothing on the common path changed.

**Audit meta gained the attribution trail** — `openBills`, `paxOrderId`,
`waiterOrderIds`. With one bill these are the same id and say nothing new; with a
split party they are the only way to reconstruct afterwards why covers moved on
one cheque and the server on two.

#### The three regression tests, and proof that each can fail

They are in `tests/billSplit.test.js` rather than `tests/tablesService.test.js`
on purpose: the defect belongs to **split**. `POST /tables/:id/service` was
correct for every case that could exist before a table could hold two open bills.

| Test | What it pins |
|---|---|
| `records covers once after a split, on the original and not the cheque` | Covers recorded **after** a split land on the original; the cheque stays `null`; and `SUM(pax)` over the table's open bills is **4, not 8** |
| `moves the server onto every open cheque after a split` | Both cheques carry the new `waiterId`, with `waiterSetAt`/`waiterSetById` populated — so sales-per-waiter sees the whole party |
| `shows the covers-bearing bill on the floor list after a split` | `GET /api/tables` returns the **anchor**, with its covers and server, deterministically |

**A passing test is not evidence that a test works**, so each was proved able to
fail before being trusted — the same standard as the audit-actor assertions in
§5.1. The first two controls are the strong form: they restore the *original
broken code* and confirm the tests detect the real defect rather than merely
agreeing with the new code.

| Control | Inversion | Result — one run each |
|---|---|---|
| 1 | `openBillsOf` ordering back to `createdAt: 'desc'`, floor-list `orderBy` back to `'desc'` | covers test **FAILED** `expected null to be 4` (covers landed on the cheque — §6.3 step 5 reproduced); floor-list test **FAILED** `expected 'cmui2swjc…' to be 'cmui2swfp…'` (the list returned the cheque); server test passed, correctly — it does not depend on ordering |
| 2 | `waiterTargetsOf` → `.slice(0, 1)`, i.e. the old single-row write | server test **FAILED** `expected null to be 'cmui2vj9s…'` on the cheque; other two passed |
| 3 | expected `SUM(pax)` flipped `4` → `8` | covers test **FAILED** `expected 4 to be 8`, `Received: 4` — the aggregate reads a real 4 from the database |

Control 3 exists because control 1 aborted that test at its *first* assertion and
never reached the aggregate block, so control 1 proved nothing about it. Three
inversions, three separate runs, every one reverted — `grep -c "NEGATIVE CONTROL"`
over both source files and the test file returns 0 in the committed tree.

#### The gate

`POST /tables/:id/service` is shared by three suites, so all three were run
together from the reverted tree — the two that existed before this change are the
ones that would catch a regression on the single-bill path, which is every table
in production today:

```
 ✓ tests/billSplit.test.js      (32 tests)  8940ms
 ✓ tests/tablesTransfer.test.js (20 tests)  4908ms
 ✓ tests/tablesService.test.js  (19 tests)  3408ms

 Test Files  3 passed (3)
      Tests  71 passed (71)
   Duration  24.14s
```

**71 passed, zero skipped, zero failed.** `tablesService.test.js` is the one that
matters most for blast radius: 19 tests written against the old single-bill route,
including the covers/server clear path and the captain and platform-operator
gates, all unchanged and all still passing. This is a three-suite gate, not the
full suite — the full-suite state and its three known non-money failures are §4.4,
and they are unaffected by this change.

**One assertion in these tests was wrong when I first wrote it, and I removed the
claim rather than the check.** The comment above the aggregate said it would catch
a route that wrote `4` onto both rows "which the two above would both still
hold" — false: `expect(cheque.pax).toBeNull()` fails in exactly that case. Given
a count of 2 and both rows asserted, the sum is *entailed*, so sold that way it
would have been a **tautology** — the same defect as the one removed in `c574934`
and the same class as the audit test's missing actor. The check is kept because it
does ask something the row-level pair cannot — that the table holds exactly the
two bills named, so a **third** open bill carrying `pax` fails here — and the
comment now says that and nothing more.

**Committed as `61f6d3c`** — `backend/src/api/routes/tables.js`,
`backend/src/lib/tables/service.js`, `backend/tests/billSplit.test.js`: 3 files,
+253/−26, nothing else. Pushed to the `github` remote — note that `origin` in this
worktree is the local RC bundle with `pushurl = DISABLED`, which is deliberate and
was left alone. Remote head verified equal to local HEAD at
**`61f6d3cdbb6b88e659e367b6f62882afe2df1360`**, tree `373f8903`.

### 6.3b The display question this fix does NOT answer — left open on purpose

`publicTable.currentOrder` is **singular by contract** and carries one bill's
`total`. Before this commit it returned an arbitrary open bill after a split; now
it deterministically returns the anchor. **That is strictly better and still not
the whole truth:** a table running two cheques has no single "current order"
total, so the floor list shows the anchor's figure and silently omits the
cheque's.

**Why it is not fixed here.** The honest fix changes the response *shape* — a
list of bills, or a table-level total alongside the current one — and
`TablesAdmin.jsx` and any other consumer read `currentOrder` today. That is a
frontend contract decision on a shared API, not a defect in covers handling, and
taking it silently inside a money-adjacent commit is the kind of scope creep that
makes a change unreviewable. It is also not the same *class* of problem: §6.3
corrupted a stored figure, this understates a correct one.

**Why it is not urgent.** The same reason the pax hole was not: no frontend calls
split yet, so no screen can reach a table with two open bills. When the floor
screen is built this is a **design input for it**, not a bug to fix first —
whoever builds that screen must decide what a split table displays anyway, and
should decide it once, in the shape of the API they actually need.

**What is safe to rely on meanwhile:** `currentOrder.id` is now stable and always
the anchor, and `currentOrder.service` carries the party's real covers and server.
A screen can already render "table 6, four covers, Meera" correctly for a split
table. Only the money figure is partial, and it is partial in the direction of
understating, not inventing.

## 7. Defects found but NOT fixed (not my lane, recorded only)

- **`floorplan.test.js` fails whenever the sequencer runs it after
  `invitations.test.js`.** Its `wipe()` omits `UserInvitation`, and
  `UserInvitation.createdById` is a `Restrict` FK, so `posUser.deleteMany()`
  dies on `UserInvitation_createdById_fkey`. **Not a regression from this
  lane** — proven by running `floorplan.test.js` alone: 16/16. Vitest
  reorders files with its own sequencer even when given explicit paths, so
  this surfaces intermittently. One line fixes it
  (`await prisma.userInvitation.deleteMany()` before `posUser`);
  `storeScopeGate.test.js` includes that line with a comment pointing here.
- **`PUT /brands/:id/stores` has no endpoint test coverage.** Nothing in
  `tests/` calls `/api/brands`. It is one of the call sites the §1 defect
  reached, so its correctness now rests on the shared fix with no test of
  its own.
- **`Order.tableId` is a single-column foreign key, where every neighbouring
  model uses a composite one.** `Order.table` is
  `@relation(fields: [tableId], references: [id])`, so the database does not
  refuse an order pointed at a table in another store — or another tenant.
  Compare `DiningVisit`, `TableQrCode` and `QrSubmission`, which all resolve
  `(tableId, branchId) → DiningTable(id, branchId)`; `DiningTable` already
  carries the `@@unique([id, branchId])` that composite FK needs, and its own
  comment gives the reason: "Cross-store resolution is then impossible rather
  than merely checked."

  Nothing exploits this today, and **table transfer is the feature that makes
  it reachable** — which is why it surfaced here. The transfer path therefore
  enforces same-store in application code and proves it with a negative
  control, but that is a filter somebody can forget, not a constraint.

  **Deliberately NOT fixed in this lane.** The migration is one line
  (`FOREIGN KEY ("tableId","branchId") REFERENCES "DiningTable"("id","branchId")`)
  but it lands on `Order`, which several lanes have in flight, and on real
  data it needs a precheck first —
  `SELECT count(*) FROM "Order" o JOIN "DiningTable" t ON t.id=o."tableId" WHERE t."branchId" <> o."branchId"`
  must return 0 or the migration fails on deploy. **I have no production
  access to run that precheck**, so this is recorded for whoever owns the
  orders schema rather than guessed at.
- **`inventorySales.test.js` → "freezes what a sale consumed: a later
  version does not restate an earlier bill" has no timeout headroom left.**
  It timed out at `testTimeout: 20000` in the contended full run. Run
  **alone**, with its 31 siblings filtered out and nothing else competing, it
  still takes **24.4 s wall clock** (the body finishes under 20 s; hooks make
  up the rest). So this is not simply "a contention artefact to ignore" — the
  margin against its own ceiling is effectively zero on this hardware, and it
  will flake on any loaded machine, CI included. **Not caused by this lane**
  (the whole file passes 32/32 alone). Owner of the inventory lane should
  either give this test an explicit longer timeout or trim its fixture setup.
  Global config is `testTimeout: 20000`, `hookTimeout: 30000`,
  `fileParallelism: false` — there is no per-test override today.

  **Correction from the `c574934` run: it passed — 32/32 in 248,348 ms, on a box
  at load 12–14.** So "it will flake on any loaded machine" was too strong, and
  I am striking it rather than leaving a claim this run disproves. The accurate
  version is the narrower fact already stated above: only the **body** is
  charged against `testTimeout`, the body is under 20 s, and the hooks account
  for the rest of the 24.4 s isolated figure. The test therefore passes or fails
  on where its body happens to land relative to 20 s — **probabilistic, not
  doomed.** Identical code failed at `80c677b` and passed here. The zero-margin
  problem is still real and still worth the owner's one-line fix, but stating it
  as a certainty would have sent them after a reproduction they would often fail
  to get, and then to doubt the report.
- **`integrations.test.js` → the 100,000-row historical loyalty import timed
  out at 900000 ms** in the contended full run. **Not investigated here on
  purpose:** a peer session was observed running that file in isolation at
  the same time, so it is someone's active work and duplicating it would
  waste both our runs. Left to that owner.

  **Read of it on 2026-09-26, from run logs rather than a re-run** (re-running
  costs 16 minutes of a shared DB and would duplicate that peer's work).
  Two things sharpen it beyond "the box was busy":

  - The import **completes**; the test dies after it. The run log prints
    `[import] 100000 rows in 605.3s (165 rows/s)` and *then* the 900s timeout
    fires. So the failure is not a hung import.
  - **The test's own cleanup is inside the timed body** — a `deleteMany` of
    100,000 `loyaltyProfileLink` rows at `tests/integrations.test.js:2777`,
    plus two `count()`s over 100k rows before it. That work is charged to the
    test's 900s budget, not to a hook.

  So the budget is spent on throughput (165 rows/s under contention) plus
  six figures of in-test teardown. It is still fair to call it *load*-sensitive
  and not a logic defect — **it passed once at 627,931ms of the 900,000ms
  ceiling when nothing competed**, which is the strongest evidence in this
  document for any of the timeout failures. But note what that margin means:
  **70% of the ceiling on a quiet box.** It is one busy afternoon from failing
  permanently, and it is a ~16-minute tax on every full-suite run in the
  programme. Moving the teardown into `afterAll` would reclaim most of it
  without touching a single assertion. That owner's call, not mine.
- **`promoGate` lets the VEXO platform operator apply a discount to a
  tenant's bill.** `orders.js:957` is
  `[requireUsableLicense, loadPermissionContext, requireAction('promo.apply')]`
  — `requireAction` with **no `requireRole`**. Because `permissions.js:274`
  gives `POS_SUPER_ADMIN` every action key and `promo.apply` is not in
  `SUPPORT_GRANT_REQUIRED`, an ATC support login satisfies that gate. Contrast
  the top-of-file contract in `orders.js` itself, and contrast `bill.split`
  (§5.1), where I used `requireRole` **and** `requireAction` precisely to avoid
  this. **Deliberately NOT changed**: it is the promotions lane's policy, it
  affects money, and tightening someone else's authority model from inside my
  lane is exactly the kind of silent business-policy change I was told not to
  make. Recorded here so the owner of that lane can decide. If it *was*
  intentional — ATC applying promotions on a customer's behalf during support —
  then it deserves a comment saying so, because it currently reads as an
  oversight.
- **One** pre-existing reporting failure survives: `NEAR_EXPIRY: expected +0
  to be null` in `reportingExceptions.test.js`, which fails identically at
  baseline and at `0d1d13e`. It is a real assertion failure and a real
  finding: the detector returns `0` where the test requires `null`, and the
  test says why in its own comment — "`0` would read as *looked, found none*"
  when the truth is that this build cannot run that detector at all. Not
  this lane's code; not touched.

  **Root cause, traced 2026-09-26 — this is an owner-facing false negative,
  not a stale test.** It is the only non-timeout failure in the whole 56-file
  suite, so I chased it rather than filing it as flake:

  - `src/lib/reporting/exceptions.js:460` decides availability structurally —
    `if (d.needs?.length && !hasModel(...d.needs))` → `UNAVAILABLE`, else
    `AVAILABLE`; and at line 518 an `AVAILABLE` detector reports
    `found: hits.length`.
  - `NEAR_EXPIRY` declares `needs: ['stockBatch']` (line 431) and its body is
    still the stub `run: async () => []` (line 434).
  - **`model StockBatch` now exists** — `prisma/schema.prisma:1675`. Some
    inventory lane landed the model.

  So the detector flipped itself from `UNAVAILABLE` to `AVAILABLE` the moment
  that model appeared, and now answers `found: 0` — *"looked, found none"* —
  while its `run` still checks nothing. The screen tells an owner that no
  batch is near expiry. Its own `unavailableNote` promised the opposite:
  "No batch is being reported as safe."

  **`OVERDUE_REQUEST` has the same defect and has not failed yet only because
  the test loop aborts at the first mismatch.** It needs `storeRequest`, and
  `model StoreRequest` exists at `schema.prisma:2637`, and its `run` is the
  same empty stub. `LOW_STOCK` still passes honestly because `StockItem` and
  `StockLevel` are genuinely absent — which is what proves the mechanism.

  This is the "a registered capability is not a feature" pattern again: adding
  the model silently satisfied a capability probe that was standing in for an
  implementation. Whoever owns `lib/reporting/exceptions.js` must either
  implement the two detectors or gate them on something stronger than model
  presence. **Not my lane, not touched, not fixed** — but it should not be
  read as environmental, and re-running it on a quiet box will not help.

  **CLOSED on `main` by `02ee253`, not by me — verified 2026-09-26.** The owner
  of that module reached the same root cause independently, from the 52-file
  integration run, and fixed it more completely than this entry asked for:
  availability now also requires `implemented: false` to be *absent*, so the
  gate no longer rests on model presence at all. Three things about their fix
  are worth carrying forward:

  - It is set on **all four** stubs, not just the two that had fired. That
    closes `OVERDUE_REQUEST` — the latent one predicted above — and pre-closes
    `LOW_STOCK` for whenever `StockItem`/`StockLevel` land, which this document
    said was coming.
  - The new check sits **after** the model and integration gates, so
    `SETTLEMENT_MISMATCH` still answers `PENDING_INTEGRATION` rather than being
    flattened into a less specific `UNAVAILABLE`.
  - The two `unavailableNote` strings that had quietly become false ("Batch
    tracking is not part of this deployment") are reworded to say the models
    exist and the detector does not read them.

  Their commit message names the property better than mine did: "neither lane
  is wrong alone… the property inverts only on the merge, so only the
  integration candidate could have caught it."

  **The base matters here.** `main` at `828208a` has the fix; this lane's base
  `77242fe` does not. So a reporting failure seen while running this branch is
  the *old* defect on an old base, not a regression — and re-pointing this lane
  at current `main` makes it disappear without anybody touching reporting.
- The other four baseline reporting failures (`reportingApi.test.js`) **no
  longer reproduce** — 36/36 at `0d1d13e`. See §3.1; they were load- or
  order-dependent rather than the stable baseline an earlier draft of this
  document called them.

## 8. Precise next step for whoever picks this up

1. **Review `ef6bc79` on its own merits and merge it ahead of the lane.** It
   is a security fix in shared middleware, it is one line plus tests, it is
   independently revertable, and three of its five affected route families
   are outside this lane. It does not depend on `f7132c5`.
2. **The §6.1 `OrderStatus` decision is CLOSED.** The owner's instruction was
   "get the OrderStatus decision sorted so merge can ship", i.e. option A — a
   new terminal `MERGED` value, appended last so no existing value's sort order
   moves. Implemented as `12fa573` with its own migration file
   (`20260926091200_order_status_merged`), because Postgres cannot read a value
   added by `ALTER TYPE ... ADD VALUE` in the transaction that added it.
   *(§6.3 was the other open owner decision and it is also closed: the
   instruction was "fix the pax hole", implemented and pushed as `61f6d3c`.
   See §6.3a.)* Transfer shipped before it (`5338788`) and so did split
   (`80c677b`); merge is what needed it.
3. **Split bill is done** — `80c677b` (route + library + tests), `c574934`
   (test headroom), `95eae62` (actor assertions on the audit row), `61f6d3c`
   (the §6.3 pax fix), `5dc06e8` and `9f456b8` (that fix's covers test
   strengthened to prove a double-count, then reordered so one control proves it),
   pushed, remote SHA
   **`9f456b8e945658a7f3eb89aba7f2d52291266ae9`**. **32/32 focused, and 32/32
   again inside the full 56-file suite under contention** (34,782 ms; §4.4) —
   though read the source-identity caveat in §4.4 before citing that second
   figure, because a co-tenant edited this file mid-run and the log line cannot
   discriminate which bytes ran. The clean certifications are the 07:40:44 gate
   (71/71, before both foreign edits) and the `9f456b8` re-gate (**71/71, 0
   skipped, 18.89 s, exit 0**). `95eae62`, `5dc06e8` and `9f456b8` touch no
   production code — `tables.js` and `lib/tables/service.js` are byte-identical to
   `61f6d3c`, verified with `git diff --stat 61f6d3c --` before each commit — so
   the suite result stands for the route and the library either way.
   **It merges into current `main` with zero conflicts, re-verified at
   `9f456b8`:** `git merge-tree --write-tree github/main x/tables` exits **0**,
   result tree `990533c1e7390dd4c6e6c978b68f3405de150285`, against `main` at
   **`728a57c6f26afeceeac14ec524f6b12b068d272f`** (2026-09-26 07:49). Histories
   have diverged further since §4.5 — **`main` is 13 ahead, `x/tables` 11 ahead**
   (`git rev-list --left-right --count github/main...x/tables` → `13  11`), so
   this is a merge or a cherry-pick, **never a fast-forward**.

   Exactly **one** file is touched by both sides: `backend/prisma/schema.prisma`
   — the file that, per this box's own history, routinely carries two sessions'
   hunks. It merges cleanly because the hunks are in different models: this lane
   changed `PosUser` and `Order` (`f7132c5`, covers and waiter attribution),
   `main` changed `LoyaltyProfileLink`. **Re-check that specific file if `main`
   moves again before the merge** — the clean result above is a fact about these
   two commits, not a property of the branch.
   What it still wants is not backend work:
   - a **floor screen**. The API takes `POST /api/orders/:id/split` with
     `{ itemIds: [...] }` and returns `{ split, order, cheque }`; nothing in
     the frontend calls it yet. Every refusal message is written to be shown
     verbatim to staff, so the screen does not need to interpret error codes.
   - the **§6.2 policy answer** if the owner wants discounted bills to be
     splittable rather than refused. Optional; split is complete without it.
   - **one display question, deliberately left alone — see §6.3b.** After a
     split, `publicTable.currentOrder` still shows *one* bill's total, and it is
     now deterministically the anchor's rather than an arbitrary row's. That is
     strictly better and still incomplete: a table running two cheques has no
     single "current order" total. Fixing it means changing a response shape
     that the existing floor screen consumes, which is a frontend contract
     decision and not mine to take unilaterally.
4. **When merging this lane, read §4.5 first** — it records the exact conflict
   surface on `src/api/routes/orders.js`, which four other lanes are editing
   concurrently.
5. No migration is outstanding from this lane — neither transfer nor split
   needed one. `prisma migrate deploy` reports "No pending migrations to
   apply" against `vcx_tables_test` at `80c677b`, and split adds no schema
   change: it creates ordinary `Order` rows and re-points existing
   `OrderItem.orderId` / `KitchenItem.orderId` values.

## 9. Boundaries honoured

No production database writes, no production migrations, no live payments or
refunds, no external customer messages, no destructive cleanup, no changes
to shared infrastructure. Nothing merged into `main` or any shared release
branch, nothing deployed, no force-push, no second repository. All database
work was against `vcx_tables_test`, which the runner refuses to start
without. No peer session's work is included in any of the **eight** commits —
each was committed path-limited (`git commit -F … -- <path>`), and
`git status --porcelain` was empty after each. The shared tree at
`/home/atc-noc/vexo-connect-x` currently holds three *peers'* modified files
(`WINDOW-2-HANDOFF.md`, `WINDOW-3-HANDOFF.md`, `docs/PHASE1-EXIT-EVIDENCE.md`)
and several untracked peer documents; **none of them is touched, staged or
committed by this lane.**

The lane's eleven commits, oldest first (`git rev-list --count 77242fe..x/tables`
= 11). **Ten are mine; `0056db1` is not** — see the note under the table:

| commit | what |
|---|---|
| `ef6bc79` | restore the store id the scope gate existed to check (shared middleware fix — §1) |
| `f7132c5` | record covers and the serving staff member against a bill |
| `0d1d13e` | clean only this suite's own fixtures, not the whole database |
| `5338788` | move a seated party to another table without touching the bill |
| `80c677b` | split a bill into separate cheques without losing a paise |
| `c574934` | give the split tests the headroom they were measured to need |
| `95eae62` | make the audit test check *who* split the bill, not just what |
| `61f6d3c` | record a party's covers once when its bill has been split (§6.3a) |
| `0056db1` | **NOT MINE** — drop an order-status list the card router never reads |
| `5dc06e8` | make the post-split covers test prove a double-count, not a misplacement (§4.4) |
| `9f456b8` | ask the covers aggregate before the rows that would abort the run (§4.4) |

**`0056db1` is a peer commit and it must not be read as this lane's work.** It
came from the §7 follow-up task for the dead `OPEN_STATUSES` const in
`tableQr.js`, committed at 08:27:44 by another session working this same tree. I
did not write it, and I **pushed it** — it was already an ancestor of `5dc06e8`,
so `git push` carried it with the fast-forward. Saying that plainly rather than
letting the ledger imply nine authored commits:

- Reviewed after the fact, because pushing it made it mine to answer for:
  the diff is a single deletion of `const OPEN_STATUSES = ['OPEN', 'BILLED'];`,
  `grep -n OPEN_STATUSES backend/src/api/routes/tableQr.js` returns **nothing**
  (so it was genuinely unreferenced, not merely unused-looking), and
  `tableQr.test.js` passes **74/74** on the current HEAD.
- It is sound, so it stays. **No history was rewritten to excise it** — that
  would mean a force-push, which is out of bounds and would be the wrong trade
  against a verified one-line dead-code deletion.
- Whoever integrates should still attribute it to its own author, not to this
  lane's review.

Branch `x/tables`, pushed to the existing verified repository. Remote SHA
**`9f456b8e945658a7f3eb89aba7f2d52291266ae9`**, confirmed equal to local by
`git ls-remote`; tree `6cf7c854036012b9113fba065902538d674e37ef`. Fast-forward
throughout, no force, no other branch touched, nothing merged into `main`.

**Clean-merge proof refreshed at `9f456b8`:**
`git merge-tree --write-tree github/main x/tables` exits **0**, result tree
`990533c1e7390dd4c6e6c978b68f3405de150285`, against `main` still at
`728a57c6f26afeceeac14ec524f6b12b068d272f`. Divergence
`git rev-list --left-right --count github/main...x/tables` → **`13  11`**, so a
merge or cherry-pick, never a fast-forward. One file touched by both sides,
`backend/prisma/schema.prisma`, and it merges because the hunks sit in different
models (this lane: `PosUser`, `Order`; `main`: `LoyaltyProfileLink`).
**Re-check that one file if `main` moves again** — this is a fact about these two
commits, not a property of the branch.
