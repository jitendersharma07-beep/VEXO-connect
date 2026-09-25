# Lane: inventory

Branch `x/inventory`, based on `38856d3` (integration candidate) via `ca5780d`.
Spec references are to `PRODUCT-MASTER-SPEC-v1.1.txt` — Part B §8/§8.1 for the module,
B§3.1 for attribution, B§12/A§1 for tier gating. The PDF itself was not supplied; the
authoritative text file was read.

Module key: `INVENTORY` (PRO tier). Exported once from
`backend/src/lib/inventory/permissions.js`, re-exported from the router index, and every
one of the nine routers carries `// ENTITLEMENT(INVENTORY)` for the firstlogin lane's
`requireModule()` to pick up at integration.

---

## 1. What this lane is

One stock ledger for the whole product. `StockMovement` is append-only and is the only
thing that is true; `StockBalance` and `StockBatchBalance` are caches rebuilt from it,
written inside the same transaction under `pg_advisory_xact_lock`. The ledger screen
carries a read-only check that re-adds the movements and compares them to the caches, so
"the numbers agree" is a measurement anyone can re-run rather than an assurance.

Two rules shape most of the design:

- **Which batch leaves is not the same question as what it cost.** Physical issue is
  FEFO. Valuation is a perpetual weighted average per location per item. They are
  computed separately and never merged.
- **Expiry is derived, never stored as a flag.** `batchBlockReason(batch, asOf)` answers
  QUARANTINED / RECALLED / EXPIRED / null from the batch's own dates and state. Expired
  stock is therefore unavailable even if the reminder scheduler has never run — proven by
  test, not by inspection (see §6).

Money is integer paise throughout; quantities are integer thousandths of an item's base
unit (G / ML / PCS) and every quantity the API emits is a fixed three-decimal string.

## 2. Data model

51 new models, 25 new enums. Five existing models — `Company`, `Branch`, `PosUser`,
`Product`, `ProductVariant` — gain nothing but a relation back-reference each
(`inventoryLocations`, `recipeLinks`, and so on, nine lines in total). Those are
Prisma-side only and emit **no SQL**: every `ALTER TABLE` in both migration files was
checked to target a table the same file had just created, and no pre-existing column is
added, changed or dropped. Grouped:

| Area | Models |
| --- | --- |
| Places & things | `InventoryLocation`, `InventoryLocationAccess`, `InventoryItem`, `InventoryItemUnit`, `InventorySettings`, `InventoryDocCounter` |
| Batches | `StockBatch`, `StockBatchBalance`, `StockBatchOpening` |
| Ledger | `StockMovement`, `StockBalance`, `StockValuationSnapshot(+Line)`, `StockReservation(+Line)` |
| Buying | `Supplier`, `SupplierItemPrice`, `PurchaseOrder(+Line)`, `GoodsReceipt(+Line)`, `GoodsReceiptLandedCost`, `PurchaseReturn(+Line)` |
| Moving | `StoreRequest(+Line, +Attachment, +Issue, +Event)`, `StockTransfer(+Line, +LineBatch)` |
| Planning | `ReplenishmentPlan(+Line)`, `ReplenishmentRun`, `StockReorderRule`, `InventoryReminder`, `InventoryNotification`, `InventorySchedulerState` |
| Making & selling | `Recipe`, `RecipeVersion`, `RecipeLine`, `RecipeProductLink`, `RecipeModifierAdjustment`, `ProductionBatch`, `SaleConsumption`, `SaleStockReturn` |
| Correcting | `StockCount(+Line)`, `StockWastage(+Line)` |

`StockMovement` carries `createdById` and `terminalId`.
`terminalId` is nullable with **no** foreign key and is marked
`// INTEGRATION(foundation)` — the foundation lane owns `Terminal`. The column is
unpopulated today because `Order` does not yet carry a terminal either; it exists now so
that adding the relation later is a constraint on an existing column instead of a second
migration rewriting a live ledger. **It is not operational and nothing should be reported
from it.**

## 3. API

85 endpoints across eight route files, all under `/api/inventory`. A ninth router,
`index.js`, is the single mount point and applies `requirePosAuth` and
`resolveCompanyScope` once, so a route file that is mounted is a route file that is
scoped:

| Router | Endpoints | Covers |
| --- | --- | --- |
| `setup.js` | 16 | locations, access grants, items, item units, suppliers, settings |
| `requests.js` | 15 | store requests, the five-stage transfer lifecycle, issues |
| `planning.js` | 13 | plans, suggestions, reminders, notification inbox, scheduler state |
| `recipes.js` | 9 | recipes, versions, product links, modifiers, sale consumption, returns |
| `reports.js` | 9 | stock on hand, valuation, ledger, ledger verify/rebuild, traceability, dashboard |
| `batches.js` | 8 | batch list, trace, quarantine, recall, release, open container |
| `receiving.js` | 8 | purchase orders, goods receipts, direct receipts, purchase returns |
| `adjustments.js` | 7 | stock counts, approval, wastage |

## 4. Roles and permissions

`INVENTORY_ACTIONS` in `backend/src/lib/inventory/permissions.js` is the single map.
`POS_SUPER_ADMIN` and `CASHIER` appear nowhere in it.

| | Owner | Branch manager | Cashier |
| --- | --- | --- | --- |
| See stock, batches, ledger, reports | all authorised locations | only locations granted to them | **no** |
| Raise / submit a store request | yes | yes | no |
| Approve a request | yes | yes, but **not one they raised** | no |
| Allocate, dispatch, receive | yes | only where granted | no |
| Record wastage, count stock | yes | yes, where granted | no |
| Approve a count or adjustment | **owner only** | no | no |
| Locations, items, units, suppliers, settings | **owner only** | read-only | no |
| Release a quarantined batch, direct receipt, plans, recipes, ledger rebuild | **owner only** | no | no |

Enforcement is server-side. The nav and the screens follow the same map, but removing a
link hides a screen — it does not close an endpoint, and the direct-API probes in §6 are
the evidence that matters.

## 5. Status per requirement

Requirement numbers are from the task brief. **ACCEPTED** means executed evidence exists
and is named. Nothing below is marked ACCEPTED on the strength of a file existing.

Pilot step numbers below were **re-derived from a captured run**, not carried forward.
Adding the landed-cost receipt at step 14 renumbered everything after it, and on checking
the shift it turned out several citations had already drifted out of step with the script
— requirement 4 pointed at the request lifecycle rather than at receiving. Shifting stale
numbers by one would have preserved the error in a tidier form, so each range below was
read back off the run instead. A citation that no longer resolves is worse than none,
because it reads as checked.

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | One ledger, canonical implementation reused, isolated branch | ACCEPTED | `StockMovement` is the only stock table written; `/inventory/ledger/verify` compares caches to it — pilot step 44, 11 positions, 0 mismatches; step 47, 31 movements of 7 kinds |
| 2 | Locations, sublocations, item kinds incl. packaging, unit conversions | ACCEPTED | pilot steps 1–8; screens 02, 11; `Takeaway Box` is a `PACKAGING` item carried through to a plan line |
| 3 | Batches, FEFO, expiry blocking, shelf life, opened-container clock | ACCEPTED | pilot steps 10, 11, 13, 17, 18, 48, 49; screen 03; min-shelf-life refusal returns 409 |
| 4 | Receiving, ledger attribution, reversals not edits | ACCEPTED | pilot steps 9–16 and 25; screens 07, 09, 25, 26; every movement resolves to a named person; landed cost is apportioned, readable and conserves to the paise — §13 |
| 5 | Five-stage requests, damage/shortage, idempotency | ACCEPTED | pilot steps 19–29; screens 04, 05; reconciliation table shows dispatched ≠ accepted with the difference itemised; who raised and who decided is named on the request, its issues and every lifecycle event — `inventoryApi.test.js`, four tests incl. the deleted-account control |
| 6 | Plans, suggestions, reminders, scheduler persistence | ACCEPTED | pilot steps 30–34; screens 06, 24; the suggestion panel shows an unapproved request excluded from projected stock; the scheduler has since run unattended as a daemon and redelivered a seeded-undelivered notification on its first tick — §11; delivery goes through one transport seam with a negative control — §12 |
| 7 | Single deduction per sale, uncosted visible, no restock on refund | ACCEPTED | pilot steps 39–43; screen 10; `tests/inventorySales.test.js` |
| 8 | Nine screens, scoped by role, server-enforced | ACCEPTED | 11 screens shipped, covering the nine the brief names; 26 screenshots, 16 walks, direct-API probes in §6 |
| 9 | Repeatable synthetic pilot | ACCEPTED | `scripts/dev-inventory-pilot.mjs`, 49 steps, exit 0, run repeatedly on rebuilt databases |
| 10 | Portal connected and walked | ACCEPTED | §7 |
| 11 | Commits and push | see §9 | Twelve commits listed in §9. This document is inside the last of them, so it cannot verify its own push — §9 gives the command that does. |
| 12 | — | — | reporting requirement, not a build item |

## 6. Tests

```
cd backend
DATABASE_URL=<…vcx_inventory_test> NODE_ENV=test npm test
```

```
Test Files  16 passed (16)
     Tests  506 passed (506)
   Duration  175.48s
```

Zero failures, zero skipped. That is the same file count and the same test count as the
pre-lane baseline plus this lane's four files — no test was removed, disabled or
loosened to reach it. This lane contributes 122 of the 506:

| File | Tests |
| --- | --- |
| `inventoryLedger.test.js` | 28 |
| `inventoryScheduler.test.js` | 34 |
| `inventoryApi.test.js` | 35 |
| `inventorySales.test.js` | 25 |

**`NODE_ENV=test` is required.** The login rate limiter is skipped only in that
environment; running the suite with a development environment loaded produces 22 failures
that are all HTTP 429 from the limiter and have nothing to do with the code under test.
This was hit and diagnosed during verification and is recorded here so the next person
does not spend the same hour on it.

**A single failure that moves between files on each run is not this lane's.** Three
consecutive full-suite runs each reported 491/492, and each one failed in a *different*
file — `gateway.test.js`, then an `inventoryApi` hook timeout, then
`discountConcurrency.test.js`. Every implicated file passed on its own immediately
afterwards. It is not test parallelism: `vitest.config.js` sets `fileParallelism: false`.
The cause is outside the suite — the dev Postgres container is shared by every lane on
this box (~50 databases against `max_connections = 100`), and its log carries
`FATAL: database "vcx_slotfresh_test" does not exist` and
`FATAL: terminating connection due to administrator command` from the window in which
those runs happened, i.e. another lane's suite was setting up and tearing down its own
database at the same time. Re-run the named file alone before treating such a failure as
real.

### Direct-API permission probes

Run against the live dev backend, not through the UI. Each refusal is paired with a
control that isolates *which* rule fired.

| Probe | Result |
| --- | --- |
| cashier `GET /stock`, `/locations`, `/ledger`, `POST /wastage` | 403 `POS_FORBIDDEN` on all four |
| south manager `GET /stock?locationId=<north>` | 404 `Location not found` — existence is not leaked |
| south manager `GET /requests/<north's>` | 404 |
| south manager `GET /requests/<its own>` | **200** — control: the 404s are scope, not a broken route |
| north manager `POST /locations`, `/items`, `/suppliers` | 403 on all three |
| north manager `GET /stock?locationId=<freezer, ungranted>` | 404 |
| north manager decides the request **they raised** | 403 `You cannot approve a request you raised yourself` |
| north manager decides a DRAFT request | **409** `Only a submitted request can be decided` — control: proves they hold the approve permission, so the 403 above is the self-approval rule specifically |

The last pair matters. Without the 409 control, the 403 is equally consistent with
"branch managers cannot approve anything", which is not the rule that was implemented.

## 7. Browser walk

Against the **built production bundle**, not the dev server: `frontend/dist` served by a
small static server that proxies `/api` to the dev backend and falls back to the shell
for client routes, which is what the production nginx does. A dev-server walk would prove
the source compiles, not that the shipped asset works.

- Bundle: `index-D9ANjftE.js`, 611.36 kB (gzip 164.07 kB), `index-BoZ_nfXy.css`, 38.44 kB
  — 1681 modules, `vite build` clean.
- Backend `127.0.0.1:5524`, preview `127.0.0.1:5626`, database `vcx_inventory`.
- 16 authenticated walks → 26 screenshots in `docs/lanes/evidence/`.

Every screen was checked by reading its rendered text, not by confirming a PNG exists.

| Screens | Role | What the render proved |
| --- | --- | --- |
| 01–11 | owner | 5 locations, 11 positions, ₹30,917.16; batches ordered by expiry with RICE-B split across two locations; transfer reconciliation showing 12,000 g dispatched against 11,000 g accepted and 1,000 g short; 29 ledger movements with the cache check reporting 11 positions compared and none differing |
| 24 | owner | suggestion panel opened by a real click: paneer triggers 7,884.212, the packaging line reads "already asked for — not re-ordered", and rice's 1,000 unapproved shows in "Only requested" while being excluded from "At delivery" |
| 25–26 | owner | the landed-cost receipt opened by a real click: ₹75.00 freight and ₹25.01 unloading listed as entered, and the two lines carrying ₹68.68 and ₹31.33 — which is ₹100.01, the figure on the header, read back out of the rendered DOM rather than off the API |
| 12–15 | north manager | 2 locations, 10 positions, ₹29,297.16 — exactly the owner's total less the ₹1,620.00 of freezer stock they cannot see; setup renders read-only with the reason stated |
| 16–19 | south manager | 1 location, 0 positions, ₹0.00, and only the one request routed to South |
| 20–23 | cashier | every inventory route redirects to the dashboard and the sidebar contains no inventory section at all |

The overview honestly reports "One scheduler job has never run" for the estate-wide pass,
because it has not. That is a real state surfaced rather than hidden.

## 8. Migrations

Three, all additive: `20260924400000_inventory_core`,
`20260924400100_inventory_location_access`, and
`20260925020000_inventory_notification_transport`. Every `ALTER TABLE` in the first two is
`ADD CONSTRAINT … FOREIGN KEY` on a table the same migration just created. No pre-existing
POS table is altered, narrowed or back-filled.

The third touches only this lane's own `InventoryNotification`, adding a nullable
`providerRef` and the `UNDELIVERABLE` value to `InventoryNotificationState`. Both are
additions: no existing row changes meaning and no column becomes required, so applying it
to a populated database rewrites nothing. It was applied with `prisma migrate deploy` to
the test and dev databases; the rehearsal table below predates it and describes the first
two.

`ALTER TYPE … ADD VALUE` is the one statement here worth a second look, because on
Postgres before 12 it cannot run inside a transaction block at all and Prisma wraps a
migration in one. From 12 onwards it is permitted provided the new value is not *used* in
the same transaction, which this migration does not do — it only adds the value, and the
first row to carry it is written by application code long afterwards. The server was
checked rather than assumed: **16.15**.

Verified after applying, on the dev database:

```
enum InventoryNotificationState -> QUEUED DELIVERED FAILED READ UNDELIVERABLE
_prisma_migrations              -> 20260925020000_inventory_notification_transport finished
```

Rehearsed both ways:

| Rehearsal | Result |
| --- | --- |
| Fresh install (empty database → all 15 migrations) | applied; drift `-- This is an empty migration.` |
| Upgrade (13 baseline migrations → 82 real rows in 22 tables → this lane's 2) | applied; **82 rows before, 82 after**; 74 tables; drift empty |
| Fresh schema vs upgraded schema | empty diff — the upgrade path converges exactly on a fresh install |

The upgrade rehearsal is the one that counts, and it is easy to run so that it proves
nothing: an earlier attempt copied `_prisma_migrations` along with the data and reported
"no pending migrations" while the tables were absent, and a later one used
`docker exec` without `-i`, so `psql` read no input and exited 0 with an empty database.
Both produced a confident, meaningless pass. The script now fails loudly if the "before"
count is zero.

### Rollback

No POS data is at risk, because nothing existing is modified.

1. `DELETE FROM "_prisma_migrations" WHERE migration_name IN ('20260924400000_inventory_core','20260924400100_inventory_location_access');`
2. `DROP TABLE` the 51 inventory tables (50 from `_inventory_core`, 1 from
   `_inventory_location_access`; CASCADE handles the foreign keys among them), then
   `DROP TYPE` the 25 enums.
3. Revert the commit. `backend/src/app.js` and `backend/src/index.js` lose the mount and
   the scheduler start; `orders.js` loses the `consumeForOrder` call and bills exactly as
   it did before.

The scheduler is off unless `INVENTORY_SCHEDULER=on`, so a deployment that has not
switched it on has nothing to stop. Sale consumption is inside the billing transaction
and is a no-op for any company with no sale-source location configured, so a company that
never enables the module bills exactly as it does today.

## 9. Delivery

Branch `x/inventory`, twelve commits on top of `ca5780d`, each one internally consistent
rather than a slice of a single blob — the import graph was traced first so that no commit
mounts a router or boots a job that does not yet exist at that point in history:

| Commit subject | Contents |
| --- | --- |
| `INVENTORY schema: …` | `schema.prisma`, the first two migrations |
| `INVENTORY engine: …` | `lib/inventory/` |
| `INVENTORY scheduler: …` | `jobs/inventoryScheduler.js`, `index.js` boot |
| `INVENTORY api: …` | `api/routes/inventory/`, `app.js` mount |
| `INVENTORY pos: …` | `orders.js` consumption hook |
| `INVENTORY tests: …` | four test files, helper, pilot |
| `INVENTORY portal: …` | screens, `App.jsx`, `Layout.jsx` |
| `INVENTORY docs: …` | this file and the 24 captures |
| `INVENTORY requests: …` | actor attribution on requests, issues and events (INV-B8) |
| `INVENTORY notifications: …` | the transport seam, `UNDELIVERABLE`, `providerRef`, third migration (INV-B4) and the daemon evidence (INV-B3) |
| `INVENTORY costing: …` | both proportional money splits routed through `distributeProportional` — §13 |
| `INVENTORY receiving: …` | the goods-receipt detail route, the landed-cost screen, the pilot's apportionment step and captures 25–26 (INV-B5) |

Every commit was made with an explicit pathspec, never `git add -A`, so nothing belonging
to another lane could be swept in. The six pre-existing files this lane touches total
1,825 insertions and **0 deletions**, and each edit sits between `==== LANE inventory ====`
markers.

Remote `github` → `jitendersharma07-beep/VEXO-connect`, branch `x/inventory`. The push is
a fast-forward onto the existing remote tip; it is not a force-push and it is not the
release branch. This document is inside the last of those commits, so it cannot state
its own pushed SHA without being wrong. Verify it directly instead:

```
git ls-remote --heads github x/inventory     # compare with: git rev-parse x/inventory
```

Not committed, by intent: the walk harness and its start scripts (they source a local-only
`.env`), `node_modules`, `frontend/dist`, database dumps, and every log. Before staging,
the 47 text files in scope were scanned for the *actual* values of the dev database
password, the JWT signing secret, the pilot password and the three seed passwords — not
merely for the words — plus connection-string, GitHub-token, AWS-key and private-key
shapes. All ten rules came back clean. No password, token or connection string appears in
any committed file or in any screenshot: the walk logs in server-side and hands the browser
only the resulting cookie, so the password never reaches the page.

## 10. Backlog / not done / needs owner input

| ID | Item | Tier | Depends on | Status | Rollback |
| --- | --- | --- | --- | --- | --- |
| INV-B1 | `requireModule('INVENTORY')` is not wired — routers are marked, the middleware belongs to firstlogin | PRO | firstlogin lane | BLOCKED | remove the markers; they are comments |
| INV-B2 | `terminalId` is never populated — `Order` carries no terminal yet | PRO | foundation + orders lanes | BLOCKED | column is nullable; drop it |
| INV-B3 | Scheduler has now run unattended as a daemon and did real work while it ran — see §11 | PRO | — | ACCEPTED | `INVENTORY_SCHEDULER` unset |
| INV-B4 | **No email or WhatsApp adapter exists.** What now exists is the seam one plugs into, a complete in-app transport, and a test transport — so the missing piece is a provider, not wiring. Naming an absent transport writes a FAILED row reading "No adapter configured for transport …" rather than reporting a delivery that did not happen | PRO | owner approval of a provider | BLOCKED | `INVENTORY_NOTIFY_TRANSPORT=inapp` |
| INV-B5 | Landed-cost apportionment is now readable and tested: a detail route, a screen that shows the charges and the share each line was given, six tests, and a pilot step that checks the sum. The apportionment itself was **wrong** until this row was closed — see §13 | PRO | — | ACCEPTED | drop `GET /goods-receipts/:grnId` and the modal; the stored columns predate them |
| INV-B6 | `ProductionBatch` / central-kitchen production is **schema-only** — zero references in `src/`. See the correction below | ENTERPRISE | — | NOT STARTED | unused table |
| INV-B7 | A rejected CORS origin surfaces as 500 `POS_INTERNAL_ERROR` rather than a 403. Pre-existing in `app.js`, not this lane's, not changed | CORE | — | NOT STARTED | n/a |
| INV-B8 | Store requests now name who raised, approved, closed and cancelled them, on the request, on every issue and on every lifecycle event | PRO | — | ACCEPTED | serializer-only change |

### Corrections to earlier rows in this table

Two rows above claimed more than the code did. Both were checked against the tree, not
against this document, and both were wrong in the same direction — a schema object was
read as a working feature.

- **INV-B4 said "Email/WhatsApp adapters exist but were not exercised".** No such adapter
  exists anywhere in the backend. The only adapter file, `src/lib/gateway/testAdapter.js`,
  belongs to payments. "Not exercised" implied a wiring gap; the real gap is the adapter
  itself, so the status moves from IMPLEMENTED-UNVERIFIED to NOT STARTED.
  *Since that correction* the seam has been built and tested (§12), which is why the row
  now reads BLOCKED rather than NOT STARTED: the work that is ours is done, and what
  remains is a provider only the owner can choose. The row still does not claim an
  adapter, because there still is not one.
- **INV-B6 said `ProductionBatch` "is modelled with ledger support".** It is a table and
  nothing else: no route, no service, no ledger call, no reference of any kind under
  `src/`. It needs an API, ledger integration and a screen, from scratch.

- **INV-B5's row said the apportionment was "modelled and stored", with no test.** That
  was accurate about the schema and wrong about the arithmetic, and the second half is
  what mattered: writing the test the row admitted was missing found the write path
  losing paise on every uneven split. "Stored but unverified" turned out to mean "stored
  incorrectly". This is the clearest case in this lane of an untested path being assumed
  correct because it was assumed simple — §13.

### Assumptions to confirm

- **Purchase tax in stock value** is a company setting (`InventorySettings`), defaulting
  to excluding it. A business that reclaims input tax does not carry it as stock cost and
  one that cannot, does; the spec does not say which way to default.
- **Voiding a billed order does not restock.** The kitchen has already cooked it. Same
  rule as a refund, so there is no special case to get wrong — but it is a business
  decision and it is reversible.
- **Branch managers may approve requests they did not raise.** The spec asks for approval
  on sensitive adjustments; it does not say approval must always escalate to the owner.
  Counts and adjustments *are* owner-only.

## 11. The scheduler has now run unattended (INV-B3)

Previously this lane could only say the scheduler passed when something called it. That is
a weaker claim than it sounds: the tick function being correct and the daemon that is
supposed to call it every five seconds actually doing so are two different facts, and only
the first had evidence.

The daemon was run against the **dev** database on loopback port 5524, `INVENTORY_SCHEDULER=on`,
a five-second interval, for five minutes, with nobody invoking anything.

**A counter moving is not evidence of work.** An empty tick increments `runCount` exactly
as happily as a useful one, so before starting the daemon one notification was seeded
undelivered — `state=FAILED`, `attempts=1`, `lastError='seeded as undelivered'` — giving
the run something real to find. The row count was read before and after the seed (10 → 11)
so the write was verified rather than assumed.

| | Before | After |
| --- | --- | --- |
| `job=inventory` | row did not exist | `runCount=59 failCount=0 lastError=none` |
| `lastTickAt` | — | `2026-09-25T02:19:41.441Z` |
| `lockedBy` | — | `free` |
| notifications | `DELIVERED:10, FAILED:1` | `DELIVERED:11` |

The only pre-existing state row was `job=inventory:cmufxh87e00009w9vhb1yi56w`, `runCount=1`,
last ticked `2026-09-24T19:31:47Z` — the direct invocation from the earlier verification. It
is **unchanged** by this run, which is itself the control: the daemon wrote its own row and
did not touch the hand-run's.

The seeded notification's own columns date the delivery:

```
seeded          createdAt   = 2026-09-25T02:14:30.701Z   state=FAILED    attempts=1
daemon booted               = 2026-09-25T02:14:36.221Z
delivered       deliveredAt = 2026-09-25T02:14:41.504Z   state=DELIVERED attempts=2
```

Delivery lands 5.3 s after boot — the first scheduled tick — with `attempts` incremented
1 → 2 and `lastError` cleared. No command was issued in that window. This is why the
evidence is the row and not the log: a row carries its own timestamps, so "the daemon did
it" is checkable after the fact instead of resting on someone having watched.

`failCount=0` and `lastError=none` across 59 consecutive ticks, and `lockedBy=free` at
rest, also demonstrate the lease is released on every pass rather than leaking — the
failure mode that would have stalled the job until its expiry.

The daemon was then stopped and port 5524 confirmed released.

## 12. How a notification reaches a person (INV-B4)

**There is still no email adapter and no WhatsApp adapter.** What was built is the seam one
plugs into, modelled on the payments adapter registry so the two look alike, plus a test
transport that drives the seam without sending anything. No external message was sent at
any point.

The rule the module exists to keep is that **a message which did not arrive must leave a
record saying so**. This is deliberately stricter than the payment gateway: a payment that
quietly does nothing fails loudly because the customer is standing at the counter, whereas
a notification that quietly does nothing is indistinguishable from one that was delivered
and ignored. So naming a transport with no adapter behind it does not throw and does not
silently pass — it writes the notification FAILED with the reason, which the portal shows.

Three things were also fixed on the way:

- **FAILED and UNDELIVERABLE are now different states.** A transport may answer
  `permanent: true` for an address that does not exist or a recipient who opted out. That
  row stops being retried, instead of burning the whole five-attempt budget rediscovering
  the same answer while the portal says "still trying" about a message that will never
  arrive. The portal shows these amber and separately counted, not red among the retries.
- **`providerRef` is stored**, so "we delivered it" can later be checked against the
  provider rather than merely asserted from our own row — the same reason a payment keeps
  its charge reference. In-app stores null, because the row *is* the message and there is
  no third party to ask. A null there is a fact, not a gap.
- **The delivery decision existed twice and had already drifted.** `reminders.js` marked
  in-app DELIVERED at creation; `inventoryScheduler.js` re-stamped `lastError` on every
  pass whether or not anything had changed. Both now call one `attemptDelivery`. This is
  the same duplication that INV-B8 removed from actor serialisation.

`queueNotification` now writes the row QUEUED first and updates it after the attempt, so a
crash mid-delivery leaves a recoverable row rather than nothing.

**The safety gate refuses rather than allows when it cannot tell.** The test transport
reports delivery on command, so production must never reach it. It is whitelisted to `test`
and `development`, read from `process.env` at call time with **no fallback** to the
boot-captured copy — and both halves are load-bearing. Call time, because `config/env.js`
captures at import and the rate limiter in this codebase caches `NODE_ENV` the same way, at
the cost of one debugging session already. No fallback, because `env.NODE_ENV` substitutes
`'development'` when the variable is unset, so falling back would turn "we do not know what
environment this is" into "it is a safe one" — the exact inversion the whitelist exists to
prevent. A first attempt at this file *did* have that fallback, and the test for an unset
`NODE_ENV` is what caught it.

Seven tests cover the seam. The load-bearing evidence is a **negative control**: replacing
`transport.send` with a stub returning `{ delivered: true }` fails exactly four of the
seven — precisely those asserting that something was handed to a transport — while the
other three continue to pass because they exercise genuinely different paths. That control
matters more here than usual, because in-app delivery *is* the row, so a transport layer
that did nothing at all would still pass every notification test written before this one.

Schema additions: `InventoryNotification.providerRef`, and `UNDELIVERABLE` on
`InventoryNotificationState` — migration
`20260925020000_inventory_notification_transport`.

## 13. What a delivery cost, and the paise that used to go missing (INV-B5)

INV-B5 was written down as a missing screen. It was also a wrong number, and the screen is
how that was found: building a view whose entire job is to show a total broken into parts
meant the parts had to be added up, and they did not come to the total.

### The defect

Landed cost — freight, duty, unloading — is charged once on a goods receipt and then has
to be carried by the lines, because stock is valued per line and the ledger is written per
line. The receipt apportioned it by value, truncating each share independently:

```
share = (landed * lineGoods) / goodsTotal      // integer division, per line
```

Truncation only ever rounds down, so the shares summed to **less** than the charge. A
₹1.00 freight over three equal lines was stored as 33 + 33 + 33, and the hundredth paise
existed on the header and on no line. Nothing reported the difference.

The ledger is where that mattered. The same share is folded into each line's value and
then into its `StockMovement`, and `StockMovement` is the only truth about stock value in
this product — so the money did not merely fail to display, it failed to exist. A receipt
whose header read `30000100` wrote `30000099` into the ledger.

Transfer acceptance had the same defect three times over. A dispatched line's value is
split into accepted, damaged and shortage; each part was divided separately, so the three
did not add back to what was dispatched. The same truncation then applied again to the
batch-by-batch arrival, and a third time to the stranded write-off. One value could be
divided in three places and disagree with itself in all three.

The telling detail is ten lines away in that same function. The **quantity** side of the
identical split already conserved exactly — the last batch takes whatever is left rather
than being rounded on its own. The problem had been understood for grams and not carried
across to money.

### The fix

Both sites now call `distributeProportional` from `src/lib/money.js` — the
largest-remainder split the order engine already uses to apportion a discount across order
lines. It conserves by construction: whatever truncation drops is handed back to the lines
with the largest remainders, ties to the lowest index, so the result is exact and
deterministic rather than exact on average.

Reusing it rather than writing a second technique is the point. A second one has to be
kept in step with the first, and the quantity/value drift above is exactly what that
costs.

Transfer acceptance now splits each line's value **once**, before the transaction, and
every later consumer reads that one split — the line columns, the per-batch `TRANSFER_IN`
movements, the damage and shortage issues, and the stranded write-off. Four independent
re-derivations became one.

The helper takes safe integers rather than `BigInt`. Every amount reaching these paths is
bounded by the request schema, and a document whose total exceeded 2^53 paise — ninety
trillion rupees on one receipt — throws inside the transaction and refuses the document
rather than writing a wrong one.

### The evidence

Five tests were written **before** the fix and each was observed failing on the exact
arithmetic above: 99 against 100 on the receipt lines, 30000099 against 30000100 in the
ledger, 998 against 999 on an uneven split, and 3000 against 3001 on the three-way
transfer split.

Two of them are built so they cannot pass vacuously. The uneven case asserts the exact
pair `[749, 250]` rather than only the sum, so handing the whole charge to one line would
not satisfy it. The transfer case asserts its own precondition — that the dispatched value
does not divide evenly into thirds — so it fails loudly rather than passing quietly if the
fixture ever changes. A receipt with **no** landed cost is the negative control: without
it, the other tests would still pass if apportionment were deleted and every share
hard-coded to the total.

### The screen

`GET /inventory/goods-receipts/:grnId` returns the charges as entered and the share each
line was given; the list gained `landedCostPaise` so a delivery that carried freight can
be picked out without opening every receipt in turn. The Receiving screen shows the
charges, a per-line share column that appears only when there is something to show, and
the totals written as the sum they are, so a reader can check the apportionment instead of
trusting it.

Six tests cover the route, including the 403 for a caller who cannot see the location — a
detail route is a new way to read a document and inherits nothing from the list.

The pilot now receives a delivery with freight on it, and **checks its own arithmetic**
rather than reporting that a document was created: it fails the run if the lines do not sum
to the header. The charges are deliberately an odd total over two unequal lines, so the
division does not come out whole:

```
14. landed-cost receipt GRN/26-27/00004: ₹100.01 of freight and unloading
    spread over 2 lines as 6868 + 3133 = 10001 paise, losing nothing
```

Truncation would have written 6868 + 3132 = 10000.

Captures 25 and 26 are that receipt rendered by the shipped bundle, opened by a real click
rather than a direct URL. The harness reads the share column back out of the DOM —
`₹68.68` and `₹31.33`, which is the `₹100.01` on the header — so the evidence is what a
person sees rather than what the API returned a moment earlier. The walk also reports
console errors and any element overflowing its box; both came back clean.

