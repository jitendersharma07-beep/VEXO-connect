# Reporting, multi-location dashboard and product consumption — verification

Lane `x/reporting`. Worktree `/home/atc-noc/vexo-connect-x-lanes/reporting`.
Date 2026-09-25.

**Status in one line:** implemented and tested on an isolated database; merged
forward over `main`; **not deployed to production and not merged into `main`.**
The four words are kept apart everywhere below, because "it works" and "it is
live" are different claims and only the first one is being made.

| | |
|---|---|
| Implemented | Yes — 21 report keys over 19 capability families (10 measurable on this build, 11 declaring why they are not), consolidated dashboard, scheduled delivery, exception worklist |
| Tested | Yes — backend gate, an API-level verifier, a real-browser walkthrough, exports opened and parsed |
| Integrated | Merged over `github/main` at `6fdd2f9`; three conflicts, all resolved by keeping both sides |
| Deployed | **No.** Nothing has been pushed to production. `REPORTING_SCHEDULER` is off; no schedule sends unless a person activates one |

---

## 1. Revision tested

| | |
|---|---|
| Branch | `x/reporting` |
| Lane commit | `969e2af` — the reporting work |
| Merge commit | `6fdd2f9` — `main` (accounts lane, 22 commits) merged in |
| Base before merge | `1c7e8e6` |
| Evidence commit | `b0b1e17` — this document, `frontend/qa/screens/reporting/` (30 screenshots + `results.json`), a fix to two checks in `scripts/reporting-verify.mjs`, and a one-line wording fix in `capability.js` |
| Naming commit | `6322482` — one paragraph, adding the hash above |
| Fix commit | defect 21: `builders.js`, `ReportView.jsx`, two harnesses, this document, regenerated screenshots |

**Dirty state when the first set of figures was taken:** `6fdd2f9` plus four
paths, and it matters which of them is product code:

| Path | Kind |
|---|---|
| `docs/REPORTING-VERIFICATION.md` | this document, new |
| `frontend/qa/screens/reporting/` | evidence, new |
| `backend/scripts/reporting-verify.mjs` | test harness — two checks fixed, §5 |
| `backend/src/lib/reporting/capability.js` | **product code** — one user-facing string re-worded, defect 20 in §5 |

The last one is a product change, so it is called one. The reporting suites were
re-run after it (143/143 across the three files that touch the catalog), the demo
API was restarted on it, and **both the verifier and the browser walkthrough
whose figures are quoted in §6 were re-run against the restarted stack** — so no
figure here describes code that is no longer in the tree.

Every figure in §6 was measured after the merge, not on the pre-merge lane
commit.

**Those four paths were committed as `b0b1e17`**, so the tree those figures were
measured on is a commit that can be checked out rather than a description of
somebody's working directory — `git show --stat b0b1e17` lists exactly the four.
A document cannot contain the hash of the commit that introduces it, so `6322482`
is one paragraph doing nothing but naming `b0b1e17`.

**Then the closing demonstration found defect 21** (§5), in the branch that had
already been pushed, and the tree moved a third time. That commit changes product
code — `builders.js` and `ReportView.jsx` — so the figures affected by it were
re-measured rather than carried over: the unit gate, the verifier, the browser
walkthrough, the build, the consumption row in §6's latency table and 21 of the
30 screenshots. §4 lists the evidence and §6 the figures. Its own hash is not
printed here, because the recursion has to stop somewhere and one naming commit is
enough to establish the convention: **the newest commit on `x/reporting` is the
one this document describes**, and `git log --oneline -4 x/reporting` reads the
sequence back.

### Files

New, backend (5,786 lines):

```
src/lib/reporting/period.js       439   timezone, business day, week start, financial year, presets
src/lib/reporting/units.js        158   kg/g, l/ml, count — conversion and refusal
src/lib/reporting/consumption.js  324   the five-quantity reconciliation
src/lib/reporting/metrics.js      311   net sales, AOV, collections, recalculated ratios
src/lib/reporting/builders.js   1,086   the report families
src/lib/reporting/scope.js        144   which locations a principal may read
src/lib/reporting/capability.js   289   AVAILABLE / PENDING_INTEGRATION / UNAVAILABLE
src/lib/reporting/settings.js      48   per-company reporting policy
src/lib/reporting/export.js       553   CSV, XLSX, PDF from one row set
src/lib/reporting/zip.js           90   the XLSX container
src/lib/reporting/schedule.js     531   cadence, due run, claim, deduplicated delivery
src/lib/reporting/delivery.js      78   where a produced report is written
src/lib/reporting/exceptions.js   675   ten kinds, six detectors, four declared undetectable
src/api/routes/reporting.js     1,060   the router
prisma/migrations/20260924950000_reporting_core/migration.sql            182
prisma/migrations/20260924960000_reporting_delivery_transport/migration.sql 17
```

New, frontend (4,275 lines including the harness):

```
src/pages/HqDashboard.jsx         395
src/pages/ReportCentre.jsx        149
src/pages/ReportView.jsx          321
src/pages/ReportingSettings.jsx   260
src/pages/ReportSchedules.jsx     728
src/pages/ReportExceptions.jsx    527
src/components/reporting.jsx      635
src/lib/reporting.js              356
qa/reporting-browser-qa.mjs       904
```

New tests (4,224 lines) and scripts (2,486 lines):

```
tests/reportingPeriod.test.js       351
tests/reportingConsumption.test.js  630
tests/reportingApi.test.js          782
tests/reportingExport.test.js       623
tests/reportingSchedule.test.js     936
tests/reportingExceptions.test.js   902
scripts/reporting-test.sh            39   the gate, against a *_test database only
scripts/reporting-db.sh              52   status / deploy, forward only, no reset
scripts/reporting-seed-demo.mjs   1,003   the demo tenant
scripts/reporting-demo.sh           167   up / down / status for the demo stack
scripts/reporting-export-sample.mjs 131   writes one of each export for inspection
scripts/reporting-verify.mjs        971   102 API-level assertions
scripts/reporting-schedule-tick.mjs 143   the owner command (§8)
```

Changed, shared with other lanes — 8 files, all additive, 526 insertions and 17
deletions, the deletions being one refactor described in §2:

```
backend/prisma/schema.prisma          4 back-relations on Company + new models at the end
backend/src/app.js                   one import, one mount
backend/src/config/env.js            two variables
backend/src/lib/permissions.js       9 new actions + role grants
backend/src/middleware/permissions.js  permissionContextFor extracted
frontend/src/App.jsx                 6 routes
frontend/src/components/Layout.jsx    one nav group
.gitignore                           the demo scratch and the delivery spool
```

---

## 2. What the lane added, feature by feature

### Periods (work order §3)

Presets Today, Yesterday, This Week, Last Week, This Month, Last Month and
Custom, each resolved against the **company's** timezone, business-day cutoff,
week start and financial year rather than the server's. Grouping by day, week
and month. Every period carries its comparable previous period, and
`Today` compares against **the same elapsed part** of yesterday — a day that is
four hours old is not compared against a whole one.

Invoice, payment, refund, settlement and stock-movement dates stay separately
explainable: each report names the date it filtered on, and the same period on
two different bases is expected to disagree.

### Consolidated dashboard (§4)

One dashboard over the locations the reader is authorised for, with a
comparison table per location: net sales, finalised orders, AOV, collections by
method, dues, reconciliation exceptions, wastage and coverage, and the open
worklist. Consolidated ratios are recomputed from summed numerators and
denominators — no averaging of store percentages — and internal transfers are
never counted as company revenue.

Scope is enforced in the resolver every report calls, so it applies to the
screen, the drill-down, the exports and the scheduled send alike. §5 lists the
authorisation hole this replaced.

### Report families (§5)

**Nineteen capability families, surfaced as twenty-one report keys.** The two
numbers differ for two reasons worth stating rather than rounding away: the
`sales` family answers four report keys (`sales`, `salesByPeriod`, `tax`,
`discounts`), and `accounting` is a declared family with no report key of its
own. Counts below are report keys, read back from `GET /reporting/catalog` as the
owner sees it.

| State | Meaning | Report keys | Which |
|---|---|---:|---|
| `AVAILABLE` | the data exists and the figures are measured | **10** | `sales`, `salesByPeriod`, `tax`, `discounts`, `collections`, `dues`, `refunds`, `locationComparison`, `productMix`, `cash` |
| `PENDING_INTEGRATION` | the module is here, nobody connected a provider | **1** | `settlement` |
| `UNAVAILABLE` | this build cannot measure it, and says why | **10** | `consumption`, `wastage`, `stockValuation`, `expiry`, `transfers`, `purchasing`, `kitchenDelays`, `loyalty`, `delivery`, `profitability` |

The three states are not interchangeable, and `UNAVAILABLE` covers two different
situations which the note distinguishes:

- **The model is not in this build.** `consumption` — *"Recipes and stock
  movements are not part of this deployment."*
- **The data is recorded, but no builder reads it.** `kitchenDelays` — *"Kitchen
  and service delays: the data is recorded, but this version does not build the
  report from it. No figures are shown rather than a zero."* This one is the
  sharper case: the `kitchenItem` rows exist, and the `DELAYED_KITCHEN_ORDER`
  exception detector **does** run on them (§7 evidence, 2 findings). So the
  worklist can flag a late order while the kitchen *report* honestly declines to
  total them up. Reporting a zero there would have been the lie.

A missing provider reports as pending or unavailable **with the reason**, never
as a zero. An unavailable family answers `200` with `available: false`, the
state, the note and an empty `rows` — not a `500`, which would look like a fault
to report, and not an empty `200`, which would look like a measured zero.

Twelve of the 21 keys have a builder in this branch and nine do not, and the
report centre proves the accounting closes: the browser walkthrough asserts **21
cards against 21 catalog entries**, and that all **9** cards without a builder
carry the server's own reason rather than the harness's idea of one.

No Reelo, Swiggy, Zomato or Tally figure is fabricated anywhere.
`profitability` carries a permanent caveat — *"Food margin only. Rent, salaries
and utilities are not recorded, so this is not net profit"* — and the caveat
is emitted whether or not the figure can be produced, because a caveat says
what a number would mean.

The ten `UNAVAILABLE` keys are ready in the sense that the capability entry, the
route and the note exist; they need the inventory and purchasing models, which
are another lane's.

### Consumption (§6)

Five quantities, presented side by side and never merged:

1. menu-product sales quantities
2. expected ingredient usage, from the recipe with variant, modifier and yield
3. physical depletion between two counts — `opening + receipts − closing`
4. documented wastage and other recorded usage
5. the variance the first four do not explain

The acceptance example from the work order is a test, not a paragraph: opening
milk 20 L, receipts 10 L, closing count 13 L, so physical depletion 17 L;
100 coffees × 150 ml expected 15 L; recorded wastage 1 L; unexplained variance
**1 L**. It is asserted in `tests/reportingConsumption.test.js`.

**Be precise about what is proved where, because this is the one place the two
levels come apart.** The engine is implemented and unit-tested; the report is
`UNAVAILABLE` on this deployment, and deliberately so:

| | |
|---|---|
| The five-quantity engine | **Implemented and tested.** `consumption.js`, 324 lines, and 57 tests in `reportingConsumption.test.js` including the milk example above |
| The unit conversion it rests on | **Implemented and tested.** `units.js`, and incompatible units are refused, not summed |
| The `consumption` report on *this* build | **`UNAVAILABLE`** — *"Recipes and stock movements are not part of this deployment."* It has a builder; the models it needs belong to another lane |
| The consumption **screen** | **Verified in the browser.** It lists the five figures as five separate things, labels the four it cannot measure *not measured*, renders **no zero variance**, and still shows the one quantity it does have — 6 rows of measured menu quantities |
| The consumption **export** | **Verified by fetching the file.** The same 6 rows, and the four unmeasured columns are empty cells rather than zeros in CSV, XLSX and PDF alike. This was defect 21; see §5 |

So: the arithmetic is proved by test, the screen's honesty is proved by
screenshot, and the end-to-end figure is **not** proved on this deployment
because the ingredient data is not here. Nobody should read a reconciled milk
variance off the demo. §8 names what would make it real.

Physical variance belongs to the count period that produced it. If counts are
weekly, the report says weekly and refuses to present a daily book balance as
an independently measured daily actual. Recipe, cost and conversion versions are
preserved, so a recipe changed today does not rewrite last month's expected
usage.

### Scheduled delivery (§7)

Cadence, format, recipients, timezone and location scope per schedule, with
`DRAFT` / `ACTIVE` / `PAUSED` states — a new schedule is always born `DRAFT`, so
creating one cannot send anything. Delivery rows carry period, run key,
transport, attempts, addresses written, addresses withheld, row count and bytes.

`ReportDelivery.runKey` is unique per schedule, and **that** is the
deduplication: a retry of the same period finds the row it already wrote
instead of writing a second one.

There is no DELETE route for a schedule, deliberately: deleting one would
cascade away its delivery history, which is the evidence that something was
sent. Schedules are paused instead.

### Exception worklist (§7)

Ten kinds declared, six with detectors on this build, four declared
undetectable **by name and with a reason** rather than silently reporting zero:
`LOW_STOCK`, `NEAR_EXPIRY`, `OVERDUE_REQUEST` and `SETTLEMENT_MISMATCH` all need
models or a provider this build does not have. Each finding names the
responsible role, the due time and the resolution status, and zero activity,
missing data and stale data are three different renderings.

`STALE_BRANCH_DATA` is raised only when *some* stores have reported and others
have not. A day on which nothing anywhere reported is a closed business, not
fourteen stale branches.

---

## 3. Authorisation

Nine new actions, joining the three that existed (`report.sales.read`,
`report.tax.read`, `report.audit.read`) for twelve in total:

```
report.dashboard.read     consolidated multi-location dashboard
report.payments.read      collections, dues, refunds, settlement, cash
report.inventory.read     consumption, wastage, stock
report.settings.read      view reporting policy
report.settings.write     change timezone, business day, financial year
report.schedule.read      view scheduled reports and recipients
report.schedule.write     create and change them
report.exception.read     view the worklist
report.exception.resolve  acknowledge and resolve
```

They are separate keys because they are separate authorities. Reading a
company-wide figure is not reading one store's. Food cost is commercially
sensitive in a way turnover is not. `report.settings.write` moves every
historical boundary at once, so it is not an implied consequence of being able
to read a report.

Grants, by role:

| Role | Reads | Writes | Notes |
|---|---|---|---|
| `CUSTOMER_OWNER`, `COMPANY_ADMIN` | all | all | unchanged — these roles hold everything |
| `FINANCE` | dashboard, payments, inventory, settings, schedule, exceptions | settings, schedule | schedules the sends; **cannot resolve** an exception — an acknowledgement from somebody who was not there closes nothing |
| `REGIONAL_MANAGER` | dashboard, payments, inventory, settings, exceptions | exception resolve | not `settings.write`: the financial year belongs to the company, not to one region |
| `BRANCH_MANAGER` | dashboard, payments, inventory, settings, exceptions | exception resolve | scope narrows it to their own stores; **no schedule action at all** |
| `INVENTORY` | inventory, settings, exceptions | exception resolve | no sales, no dashboard — stock control is not a reason to see turnover |
| `PURCHASE` | inventory, settings, exceptions | — | purchase prices and receiving differences are its own work |
| `AUDITOR` | every `*.read` | — | unchanged rule, now reaches the new reads |
| `CASHIER`, `CAPTAIN`, `KITCHEN`, `DELIVERY` | none | none | unchanged |

Enforcement is on the server, in one resolver, and applies to exports and to
scheduled delivery as much as to a screen. The navigation gates on the same
actions, so nothing is offered that the API would refuse.

---

## 4. Evidence

All four gates were run on `6fdd2f9` against the isolated databases named in
§7, and re-run after each change made since — the figures in this section are
the merge-commit run, and **§6's gate table is the final one**. None of them
touched a shared or production database.

### Backend unit and API tests

```
bash scripts/reporting-test.sh
```

| | Before the merge (`969e2af`) | On `6fdd2f9` |
|---|---|---|
| Files | 28 passed | 35 passed |
| Tests | 864 passed, 0 failed | **1054 passed, 0 failed** |
| Duration | — | 248.86 s |

**The count changed and here is why:** the accounts lane merged in seven test
files of its own — `accountRecovery`, `bootstrapPlatformAdmin`, `invitations`,
`mail`, `maildrop`, `platformAdmin`, `totp` — adding 190 tests. None of this
lane's tests were deleted, renamed or skipped. The reporting files still
contribute the same count they did before the merge.

**Two earlier attempts on the merged tree failed, and neither was a defect.**
They are recorded because discarding a red run without saying why is how a real
failure gets buried:

- Attempt 1 failed `reportingExceptions.test.js` on a 20 s timeout, and printed
  `[test-db-lock] LOST the lock mid-run — results are not trustworthy, re-run
  alone` above it. That message is not decoration — another run was already
  wiping this database underneath the assertions.
- Attempt 2 failed a **different** file, `promotions.test.js` — pre-existing,
  untouched by this lane — also on a 20 s timeout, with no lock warning. Rather
  than calling it flaky, the load was measured: **18.67 / 25.70 / 35.99 on 12
  cores, with 16 vitest processes belonging to five other lanes.** Both files
  were then re-run alone and passed 70/70.
- Attempt 3, reported above, passed 1054/1054 with no timeout and no lock
  warning. It is the only run reported here.

### API-level verifier

```
node scripts/reporting-verify.mjs
```

**102 passed, 0 failed, 1 note.** Assertions over a running API: periods and
boundaries, scope isolation attempted directly against the API rather than
through the UI, every report family's state and note, export/screen agreement,
the consumption example, the schedule lifecycle and the exception worklist.

Nine sections. Sections H (schedules, 19 checks) and I (exceptions, 15 checks)
were **not executing at all** when first written — five assertions named fields
the routes do not return. §5 records what that hid.

The one note is deliberate and is not a soft failure: check H5 leaves a `DRAFT`
schedule behind, because a schedule cannot be deleted without destroying its
delivery record, and that is a design decision (§9), not an oversight. H5
therefore accepts either the `201` of a first run or the `409` of a later one.

### Browser walkthrough

```
node qa/reporting-browser-qa.mjs
```

Twelve sections, 64 passed, 0 failed, **2 skipped**, 30 screenshots in
`frontend/qa/screens/reporting/`. Real Chromium, real sign-ins, four roles.

The two skips are recorded rather than counted as passes, because a check whose
condition never arose has proved nothing:

- **10.5, 10.6** — the fold cap (8 rows per group) and the expand control. The
  largest group on the demo data is 4 rows, so this dataset cannot exercise
  them; the harness prints the measured group size next to the skip rather than
  asserting nothing. That is a consequence of fixing the seed's day-close
  arithmetic (§5):
  once almost every trading day closes correctly, there are not enough
  exceptions left to overflow a group. Inventing filler rows to make the number
  go up would have made the demo worklist misleading for whoever reads it.

### Exports

`scripts/reporting-export-sample.mjs` writes one CSV, one XLSX and one PDF per
family. Each was opened and parsed, not merely produced: the XLSX as a zip with
its sheet XML read, the CSV parsed back to rows, the PDF checked for its page
objects. Screen, drill-down and export are generated from the same row set and
were compared row for row.

### Performance

Measured on the demo tenant, over a 70-day trading window across five stores in
two regions, queried through the financial-year preset so every report spans 365
daily buckets. Figures in §6, with the box's load average recorded beside them —
this machine is shared with other lanes, so a latency without a load figure is
not a measurement.

---

## 5. Defects found and fixed

Twenty-one. Each was found by reading the code or by a check that failed, and
each is fixed in this branch.

**Authorisation and correctness**

1. **Scope clobber — a live authorisation hole, and the one that mattered most.**
   The caller's reach and the caller's filters were spread into a single Prisma
   `where`. A filter names the same keys the scope does, so the spread did not
   add a constraint, it **replaced** one: a store manager pinned to one store who
   passed `?storeId=` for a sibling store had the scope's own `id` clause
   overwritten by their own parameter and was served that store's takings, and a
   regional manager could do the same with `?regionId=`. The tenant check
   survived both, so it looked correct from outside the company and was wrong
   inside it — the harder half to notice. Reach and filters are now two objects
   combined with `AND`, and `?storeId=` is resolved against the reach before it
   is used at all.
2. **`report.payments.read` did not exist.** Collections, dues, refunds and
   settlement were reachable under the sales action, which meant seeing turnover
   implied seeing who handled the till and by how much it was short.
3. **An out-of-range setting was accepted and then quietly replaced.** The patch
   route restated its own numeric ranges, and they had drifted from the engine's.
   A `weekStartDay` the route accepted but the engine rejected was stored, and
   `normalizeSettings` then substituted the default — so the patch returned
   success, the stored value was not the one in use, and nothing said so. The
   route now derives its bounds from `SETTINGS_BOUNDS`, the single constant the
   engine uses, and refuses out-of-range values instead.
4. **Sales and collections contradicted each other** on what "net" meant — one
   included a discount the other had already removed, because
   `OrderItem.lineSubtotal` is net of `lineDiscount` and one of the two summed
   it again.
5. **`contextForUser` selected `PosUser.name`,** a column that does not exist —
   the model has `fullName`. Every call threw.
6. **`contextForUser` omitted `branchId` and `regionId`,** so a regional
   manager's scope resolved empty and their dashboard was silently blank rather
   than refused.

**Honesty of the output**

7. **`AVAILABLE` conflated with "has a builder".** A family with no builder
   reported as available and then produced an empty report, which reads as "no
   sales" rather than "not in this build".
8. **The caveat was dropped when a family was unavailable** — "this is not net
   profit" vanished exactly when nobody could check the figure themselves.
9. **`₹0.00` for a store that has never traded.** Indistinguishable from a
   store that traded and took nothing. Now it says so.
10. **Stale age hidden in a tooltip.** "Last updated" was a hover, so a branch
    that stopped reporting three days ago looked current at a glance.
11. **`exceptionSummary` returned `undetectable: null`** to the dashboard, so
    the four undetectable kinds silently became "nothing wrong" on the one
    screen an owner actually looks at.

**Crashes and silent failures**

12. **`ReportView` crashed on every unavailable report** — it read a field that
    only exists on an available one, so the honest state was unreachable through
    the UI.
13. **A duplicate schedule name returned an unmapped 500.** `ReportSchedule` is
    unique on `(companyId, name)` and nothing mapped the Prisma unique
    violation, so "you already have a schedule called that" arrived as a server
    error. There is still no global P2002 mapping in this product; this route
    maps its own and the gap is recorded in §8.
14. **`HqDashboard`'s period was not in the URL.** A dashboard could not be
    linked, shared or reloaded without silently jumping back to today.
15. **Silent 300-row truncation** of the exception list — the cap existed, the
    screen did not mention it, so a worklist could be a third of itself with no
    sign.
16. **A 72-row exception group was unreadable** in one wall of rows. Capped and
    folded, with the count always shown.
17. **The demo seed wrote arithmetically impossible day-close rows.** Counted
    cash, opening float and expected cash did not reconcile, because
    `expectedCash` excludes the float and the counted figure includes it. The
    seed had them the other way round, so every closing looked short.
18. **A deduplicated delivery returned no delivery row.** `deliverRun` answered
    "already delivered" without saying *which* delivery, so the tick summary
    reported `status: null` for a schedule that was in fact fully sent —
    rendering "nothing happened" and "already done" identically. Found by
    check H12, which had to start executing first (below).
19. **This lane shipped its own role-label map,** four entries, already
    disagreeing with `frontend/src/lib/roles.js`: "Store manager" here against
    "Store Manager" on the team and permission screens. Found while merging
    `main`. The copy is gone; `reporting.js` re-exports `roleLabel`.
20. **A note shown to owners was ungrammatical for every label it interpolated.**
    The fallback for a family whose data exists but has no builder read
    *"Kitchen and service delays **is** recorded, but…"* — the labels are plural
    noun phrases, so the template could not be right for any of them
    ("Sales, tax and discounts is recorded"). Found while checking the doc's
    families table against the live catalog rather than against my own notes.
    Re-phrased so the label is a subject and not a noun: *"Kitchen and service
    delays: the data is recorded, but this version does not build the report from
    it."*
21. **Every consumption export was an empty table under a note promising rows.**
    The report's coverage note says *"Menu quantities sold are shown below
    because they are measured"* — and on the screen they were, but the six
    measured rows lived in `meta.soldQuantities` while **every export renders
    `rows`**, which the builder set to `[]`. So the CSV, XLSX and PDF were a
    header line and nothing else: an owner exporting consumption got a file whose
    own note pointed at rows that were not in it, which reads as *nothing was
    sold* — while the screen beside it showed 380 cheesecakes. The same empty
    table went out with every scheduled delivery, since `schedule.js` calls the
    same renderer. It is the failure this whole report family exists to prevent,
    arriving through the back door: not a fabricated zero, but an absence that
    reads as one.

    `export.js` opens by claiming *"there is one set of numbers and three
    renderings of it"*, and that invariant is only true while the screen renders
    `rows` — so the fix is to make it true rather than to special-case the
    exporter. `rows` now carries the measured quantities with `null` — not `0` —
    in the four columns this deployment cannot measure; all three renderers write
    a null as an empty cell, and the screen renders the same `rows` through the
    same table every other report uses. The bespoke three-column table it used to
    draw is gone, so there is one table and one source for it.

    Found by fetching the file at the end of the work, when the document was
    already written and the branch already pushed. Checks E10b and E10c now
    compare the export against the screen, which is the comparison nobody had
    been making.

### Defects in this lane's own evidence

Worth recording separately, because a false PASS is worse than a failure.

- **Five assertions named fields the routes do not return.** `publicException`
  returns `branchId`, not `storeId`; `publicDelivery` returns `artifact`, not
  `artifactPath`; the close route is `POST /reporting/exceptions/:id`, not
  `PATCH`; `undetectable` is `{kind, note}` objects, so `.join()` printed
  `[object Object]`. Two of those checks **could never have failed**, and one —
  asserting a 404 — **would have passed for the wrong reason**, because a
  `PATCH` to a `POST` route 404s.
- **Two vacuous passes.** "No group exceeded the fold cap" passes loudest when
  there is no data at all. Replaced with a skip that says so, plus a heading
  count that always runs.
- **A third vacuous pass, and this one was hiding a live defect.** Browser check
  3.3, *"the menu quantities that ARE measured are shown on screen"*, compared
  the rows it counted against
  `consApi.body?.sold?.length ?? consApi.body?.soldQuantities?.length ?? soldRows`.
  Neither field has ever existed — the payload carried `meta.soldQuantities` —
  so both `??` arms fell through to `soldRows`, and the check compared the number
  with itself. It passed every run without once looking at the API, and it is the
  reason defect 21 above survived a green walkthrough: the check that would have
  caught the screen and the data disagreeing was, in the end, only asking the
  screen whether it agreed with itself. It now compares against `rows` with no
  fallback, so a missing field fails rather than passes.
- **A regex that passed on the wrong screen.** `/permission|access/i` also
  matches the navigation's "Users & Access", so the permission-denied check
  would have passed on a page that rendered nothing. Now it asserts the exact
  sentence, which also proves the guard's `what` prop is wired.
- **`\b` is not a word boundary between `g` and `2`.** `innerText` glues a
  heading to its count span — "Cash difference at closing2" — so a correct
  screen failed. The count is its own element and is now read as one.
- **The delivery spool and the demo scratch were committable.** Neither was
  ignored; `git add -A` would have put a report artifact — a named recipient and
  a company's takings — into a public repository. Now ignored. The QA
  screenshots are deliberately **not** ignored: this repo tracks 33 of them from
  earlier lanes, and ignoring the directory would have hidden this lane's
  evidence while keeping its predecessors'.
- **Two checks were coupled to the clock, and both went red 12 hours later.**
  Found by re-running the verifier the morning after the demo database was
  seeded — `I4` and `I13` failed, having passed the night before, with nothing
  in between but time. The product was right and the checks were wrong, which is
  the more dangerous direction:
  - `I13` compared the dashboard's exception count against a worklist snapshot
    taken *before* the scans in `I2`–`I4` ran. It reported "dashboard 13,
    worklist 10" — and the difference was exactly the 3 the scan had just
    raised. It was measuring the order of lines in the harness, so **any** scan
    that raised anything would have failed it. It now re-reads the worklist, so
    both numbers describe the same moment.
  - `I4` asserted that the verifier's scan raises 0, treating the seed's scan as
    the first. But `STALE_BRANCH_DATA` is in the detector layer's `TRANSIENT`
    set precisely because it is a *condition*, not a historical fact: leave the
    demo data alone for longer than `staleAfterMinutes` (180) and every store
    that traded that day legitimately goes stale. Three did. Confirmed by
    listing the rows — four `STALE_BRANCH_DATA` findings where the seed made
    one, the extra three being Connaught Place, Cyber Hub and Lower Parel, one
    per store that had been fresh at seed time, each correctly deduped on its
    own `STALE_BRANCH_DATA:<branchId>` key. The check now runs its own second
    scan and asserts the **pair**: whatever the first found, the one immediately
    after must add nothing. That is the dedup claim its name always made, and it
    no longer decays overnight.

---

## 6. Measurements

All from the runs on `6fdd2f9`. See §4 for how each was produced.

### The volume these figures were measured over

Read back out of the reporting layer itself rather than quoted from the seed's
own arithmetic, because the seed counting its own rows proves nothing about what
the reports can see.

| | |
|---|---|
| Stores in scope | **5** in 2 regions (North, West). A 6th, Training Kitchen, is `isDemo` and excluded from totals by default |
| Trading window | **70 days**, 4 bills per store per day (`REPORTING_SEED_DAYS`, `REPORTING_SEED_BILLS_PER_DAY`) |
| Finalized orders | **1013** in the financial year to date; 315 in September; 19 today |
| Also present | 29 VOID, 1 OPEN, 96 orders carrying dues, 20 refunds, 71 cash-closing rows |
| Net sales | ₹14,45,833.27 for the year; ₹4,31,692.40 for September |
| Second tenant | 1 store, net a round figure no bill of tenant one's can produce |

### Report latency

All **12** report keys that have a builder, owner scope, all five stores, warm
process. (The other 9 have no builder by design and answer with a reason — see
§2.) The API and Postgres are both on this box; the figures include HTTP and JSON
serialisation, not just the query.

| Report | Rows | Time |
|---|---:|---:|
| `locationComparison` | 5 | 115 ms |
| `sales` | 5 | 84 ms |
| `collections` | 6 | 84 ms |
| `salesByPeriod` | 30 | 79 ms |
| `consumption` | 6 | 79 ms † |
| `discounts` | 5 | 77 ms |
| `productMix` | 6 | 66 ms |
| `tax` | 1 | 37 ms |
| `cash` | 71 | 34 ms |
| `settlement` | 34 | 32 ms |
| `dues` | 96 | 31 ms |
| `refunds` | 20 | 28 ms |

Slowest report **115 ms** against a 2 s budget. Consolidated dashboard over the
whole financial year, five stores: **105 ms** against a 3 s budget.

† Eleven of those rows were measured before defect 21 was found, and the twelfth
stopped being true when it was fixed: `consumption` used to return **0 rows in
75 ms**, and the sentence that stood here praised it for costing 75 ms to return
nothing. It now returns the six measured menu rows. Its row is re-measured, but
by a different method — **79 ms median over the four `consumption` requests the
verifier and the browser walkthrough made against the fixed tree**, slowest
87 ms, read out of the API's own request log rather than from a fresh benchmark.

The controlled re-run this table deserves was attempted and could not be made:
the probe needs to authenticate, the demo stack deliberately never stores the
password it was seeded with, and all four ways of obtaining a session without
printing a secret were refused by this session's command classifier. Rather than
leave a figure that the fix had made false, or restate a differently-measured one
in the same column as though the methods matched, the row carries a dagger. The
log medians for the reports that did not change agree with the benchmarked
figures to within a few tens of milliseconds — `dashboard` 105 ms against 105 ms,
`locationComparison` 134 against 115, `sales` 55 against 84 — across mixed
presets, which is agreement about the order of magnitude and nothing finer.

79 ms and 75 ms are two different measurements of two different trees, so the
4 ms between them is not the cost of the fix and should not be read as one.
What the figure does say is that `consumption` is still in the same band as the
reports either side of it: the product-mix query it now runs was already being
run for `productMix` at 66–78 ms, and the four strands it does *not* measure cost
nothing to report as unmeasured. Saying so honestly is the feature.

Grouping is the axis that grows, so it was measured separately across the full
financial year:

| Grouping | Buckets | Time |
|---|---:|---:|
| `DAY` | 365 | 164 ms |
| `WEEK` | 53 | 120 ms |
| `MONTH` | 12 | 100 ms |

365 daily buckets cost 64 ms more than 12 monthly ones, so the bucket fill is
not the dominant term at this volume — the scan is. That is the honest reading:
these figures say the shape is right, not that the layer has been proved at
production scale. **Nobody has run this against a real multi-year estate**, and
§8 says so.

### Load while measuring

`8.49 11.35 17.95` before the run and `8.63 11.29 17.86` after, on **12 cores** —
so roughly **0.7 per core**, captured from `/proc/loadavg` in the same shell
command as the run rather than recalled afterwards. Other lanes were running
suites on this box throughout. The latencies above are therefore **pessimistic**
rather than best-case, which is the useful direction for a budget.

An earlier identical run at load `14.06 15.84 25.14` produced the same figures
within ±10 ms, so nothing here is sitting on a knife edge.

### Gate totals

Every row was run on the final tree, after defect 21 was fixed, not before it.

| Gate | Result |
|---|---|
| `scripts/reporting-test.sh` | 35 files, **1054 passed, 0 failed**, 213.81 s |
| `scripts/reporting-verify.mjs` | **104 passed, 0 failed**, 1 note |
| `qa/reporting-browser-qa.mjs` | **64 passed, 0 failed, 2 skipped**, 30 screenshots |
| `npx vite build` | clean, 4.62 s, 1692 modules |
| `scripts/reporting-db.sh status` | 24 migrations, schema up to date, no pending |

The unit gate was run three times on the merged tree, and the sequence is worth
recording: 1054/1054 in 248.86 s before the `capability.js` wording change,
1054/1054 in 240.56 s after it, 1054/1054 in 213.81 s after the defect 21 fix. A
single green run following a late edit proves the edit did not break anything;
three matching counts either side of two edits also show the total never moved,
which is the claim a reader actually wants. The verifier's total *did* move, from
102 to 104, and that is the opposite kind of news: the two new checks are E10b
and E10c, which assert that the consumption export carries the same rows as the
screen and that its four unmeasured columns are empty rather than `0`. They exist
because nothing asserted either thing, which is how defect 21 shipped.

---

## 7. Demo: URL and access

The demo runs on this server on loopback ports, against its own database. It is
not reachable from outside the machine.

```
cd /home/atc-noc/vexo-connect-x-lanes/reporting/backend
bash scripts/reporting-demo.sh up        # start API + Vite against atc_pos_reporting_demo
bash scripts/reporting-demo.sh status    # what is running, and against what
bash scripts/reporting-demo.sh down      # stop both
```

| | |
|---|---|
| UI | `http://127.0.0.1:5188/` |
| API | `http://127.0.0.1:5560/api` |
| Database | `atc_pos_reporting_demo` on `127.0.0.1:5439` (container `atc-pos-dev-db`) |
| Test database | `atc_pos_reporting_test` — same server, separate database |

Sign-ins. **All seven share one password, and this document does not print it**
— it is whatever was passed as `POS_SEED_PASSWORD` when
`scripts/reporting-seed-demo.mjs` was run, and the seed script deliberately
prints every other detail of the dataset but not that. This repository is
public, so a working credential does not belong in it even for a loopback demo
holding synthetic data. To sign in, either ask for the value or re-seed with one
of your own:

```
POS_SEED_PASSWORD='<choose one>' node scripts/reporting-seed-demo.mjs
```

| Address | Role | What it demonstrates |
|---|---|---|
| `owner@reporting.demo.local` | `CUSTOMER_OWNER` | the consolidated dashboard over every store |
| `finance@reporting.demo.local` | `FINANCE` | every report and the schedules; cannot resolve an exception |
| `regional.north@reporting.demo.local` | `REGIONAL_MANAGER` | the North region only — a region-scoped dashboard |
| `manager.cp@reporting.demo.local` | `BRANCH_MANAGER` | Connaught Place only, and the refusal on scheduled reports |
| `auditor@reporting.demo.local` | `AUDITOR` | every read, no write anywhere |
| `cashier.cp@reporting.demo.local` | `CASHIER` | holds no report action at all — the navigation shows none |
| `owner@rival.demo.local` | `CUSTOMER_OWNER` | **a second tenant**, so a cross-tenant leak has something to leak |

The demo tenant is **five** stores in two regions — Connaught Place and Cyber Hub
in North, Bandra West and Lower Parel in West, plus New Town — with a sixth,
Training Kitchen, flagged `isDemo` and excluded from totals by default. Seeded by
`scripts/reporting-seed-demo.mjs` over a 70-day trading window (§6 has the row
counts). Three stores are deliberately awkward, because each one makes a
different kind of honesty visible:

- **Bandra West** stopped trading 21 days ago, so its coverage must read *stale*
  rather than *small*.
- **New Town** has never traded at all, so it must read *never reported* rather
  than `₹0.00`.
- **Training Kitchen** is a demo store, so it must stay out of the company's
  takings unless somebody asks for it.

Three schedules — one `ACTIVE` daily sales CSV, one `PAUSED` weekly XLSX, one
`DRAFT` monthly PDF. Recipients: `reporting-qa@reporting.demo.local` is flagged
as a test address and is the only one a delivery writes to;
`owner@reporting.demo.local` is approved but not a test address and is recorded
as withheld; `former.finance@reporting.demo.local` is revoked, so it is neither.

---

## 8. What this needs from the owner

Precise inputs, not directions.

1. **Which transport should deliver a report, and its credentials.** This is the
   one blocking decision. Report delivery writes to a spool directory and every
   row, screen and export says `FILE`. A real mail transport now exists in the
   product — `backend/src/lib/mail/mailer.js`, from the accounts lane, off unless
   `SMTP_HOST` is set, and outside production it refuses any recipient not
   matching `MAIL_ALLOWED_RECIPIENTS` — but **nothing wires report delivery to
   it.** Connecting the two is a deliberate decision because it lets a file
   containing a company's takings leave the building. Until then the label is
   honest and the reports are on disk.
2. **The company's reporting policy**, per tenant: timezone, business-day
   cutoff, week start, financial-year start. Defaults are applied on first read
   and every one of them moves money between periods, so they should be
   confirmed rather than inherited.
3. **Who may receive a schedule.** Recipients must be approved before a schedule
   can name them, and only addresses flagged as test addresses have been written
   to during verification.
4. **Whether to run the scheduler at all.** `REPORTING_SCHEDULER` is off. The
   alternative is the owner command in §9, which is a dry run unless told
   otherwise.
5. **Physical stock counts.** Consumption variance is only as good as the count
   period. With no counts, the report says so instead of inventing a daily
   actual.

### Dependencies on other lanes

Ten report keys are `UNAVAILABLE` because the models are not in this build:
recipes, stock movements, wastage, valuation snapshots, batches, store requests
and purchase orders belong to the inventory and purchasing lanes. Nothing here
needs changing when they land — the capability layer checks the Prisma client at
runtime, so a key becomes measurable as soon as its models exist.

**Exactly one key is `PENDING_INTEGRATION` today, and it is `settlement`** — the
payment models are present and no gateway provider is configured, so there is
nothing to reconcile against. It is worth being exact here, because the other
three integration-shaped families do *not* report pending yet:

`loyalty`, `delivery` and `accounting` each declare a provider connection, but
the capability layer checks **model presence before provider connection**, and
their models (`loyaltyProfileLink`, `aggregatorOrder`, `accountingPosting`) are
absent. So today they report `UNAVAILABLE`; when the models land they will report
`PENDING_INTEGRATION`, naming the connection state and last successful
synchronisation, until an `ACTIVE` provider connection exists. That order is
deliberate — "no provider connected" would be a misleading thing to tell an owner
about a table that does not exist.

`OrderType` has only `DINE_IN` and `TAKEAWAY` in this build — no `DELIVERY`
member — so the delivery-channel report has no orders to classify even before an
aggregator is connected. Worth knowing before the channel filter is read as
broken.

---

## 9. Deployment and rollback

### Deploying

1. Apply the two migrations. Six new tables and seven new enums; every `ALTER` in
   them is a foreign key on one of those new tables, and the second migration
   touches only `ReportDelivery`. **No existing table or column is modified** —
   `Company` gains no column, because the four back-relations are Prisma-side
   only — so they are safe against a populated database.
   `scripts/reporting-db.sh deploy` applies forward only and has no `reset`
   subcommand at all.
2. Set nothing and the lane still works: `REPORTING_SPOOL_DIR` defaults to a
   directory under the backend, and `REPORTING_SCHEDULER` defaults to off.
3. Restart the API. On this estate a restart ships code, not environment
   variables — a new variable needs the compose file changed and the container
   recreated.

The migrations were verified in both directions that matter: applied to a fresh
database by the test gate on every run, and applied to a populated one — the
demo database, with a financial year of seeded data — without loss. The
accounts lane's migration `20260924170000_accounts_access` sorts *before* this
lane's two by name but was applied *after* them on both databases, which Prisma
records by name and handles; the three touch disjoint tables.

### Rolling back

Nothing outside the reporting surface changes behaviour, so a rollback is a
code rollback:

- **Reverting the code** leaves the new tables in place, holding configuration
  and history that nothing else reads. Harmless.
- **Do not drop the tables** to roll back. `ReportDelivery` is the evidence that
  something was sent, and `ReportingException` records who acknowledged what.
- **The one shared-behaviour change** is `permissionContextFor`, extracted from
  `loadPermissionContext` in `backend/src/middleware/permissions.js` so that a
  scheduled report — which has no session attached — is held to its owner's
  current authority through the same resolution a request uses. The middleware
  now calls it and nothing else changed; reverting the lane reverts it cleanly.
- **The nine new actions** are additive. A principal who held none of them
  before holds none after a rollback.

### Known gap, not fixed here

There is still no global Prisma `P2002` mapping in this product: a unique
violation from any route without its own handling reaches the error handler
unmapped and becomes a 500. This lane maps its own (§5, defect 13) rather than
change a shared handler that every other lane depends on. It is worth doing
centrally, in a lane that owns that file.
