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

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | One ledger, canonical implementation reused, isolated branch | ACCEPTED | `StockMovement` is the only stock table written; `/inventory/ledger/verify` compares caches to it — pilot step 43, 11 positions, 0 mismatches |
| 2 | Locations, sublocations, item kinds incl. packaging, unit conversions | ACCEPTED | pilot steps 1–12; screens 02, 11; `Takeaway Box` is a `PACKAGING` item carried through to a plan line |
| 3 | Batches, FEFO, expiry blocking, shelf life, opened-container clock | ACCEPTED | pilot steps 13–22, 47, 48; screen 03; min-shelf-life refusal returns 409 |
| 4 | Receiving, ledger attribution, reversals not edits | ACCEPTED | pilot steps 23–31; screens 07, 09; every one of 29 movements resolves to a named person |
| 5 | Five-stage requests, damage/shortage, idempotency | ACCEPTED | pilot steps 32–36; screens 04, 05; reconciliation table shows dispatched ≠ accepted with the difference itemised; who raised and who decided is named on the request, its issues and every lifecycle event — `inventoryApi.test.js`, four tests incl. the deleted-account control |
| 6 | Plans, suggestions, reminders, scheduler persistence | ACCEPTED | pilot steps 37, 44–46; screens 06, 24; the suggestion panel shows an unapproved request excluded from projected stock |
| 7 | Single deduction per sale, uncosted visible, no restock on refund | ACCEPTED | pilot steps 38–42; screen 10; `tests/inventorySales.test.js` |
| 8 | Nine screens, scoped by role, server-enforced | ACCEPTED | 11 screens shipped, covering the nine the brief names; 24 screenshots, 15 walks, direct-API probes in §6 |
| 9 | Repeatable synthetic pilot | ACCEPTED | `scripts/dev-inventory-pilot.mjs`, 48 steps, exit 0, run twice on two different database builds |
| 10 | Portal connected and walked | ACCEPTED | §7 |
| 11 | Commits and push | see §9 | Eight commits listed in §9. This document is inside the last of them, so it cannot verify its own push — §9 gives the command that does. |
| 12 | — | — | reporting requirement, not a build item |

## 6. Tests

```
cd backend
DATABASE_URL=<…vcx_inventory_test> NODE_ENV=test npm test
```

```
Test Files  16 passed (16)
     Tests  492 passed (492)
```

Zero failures, zero skipped. That is the same file count and the same test count as the
pre-lane baseline plus this lane's four files — no test was removed, disabled or
loosened to reach it. This lane contributes 108 of the 492:

| File | Tests |
| --- | --- |
| `inventoryLedger.test.js` | 28 |
| `inventoryScheduler.test.js` | 27 |
| `inventoryApi.test.js` | 28 |
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

- Bundle: `index-qeJUVyHI.js`, 602.52 kB (gzip 162.29 kB), `index-DnuK0kMj.css`, 38.40 kB
  — 1681 modules, `vite build` clean.
- Backend `127.0.0.1:5524`, preview `127.0.0.1:5626`, database `vcx_inventory`.
- 15 authenticated walks → 24 screenshots in `docs/lanes/evidence/`.

Every screen was checked by reading its rendered text, not by confirming a PNG exists.

| Screens | Role | What the render proved |
| --- | --- | --- |
| 01–11 | owner | 5 locations, 11 positions, ₹30,917.16; batches ordered by expiry with RICE-B split across two locations; transfer reconciliation showing 12,000 g dispatched against 11,000 g accepted and 1,000 g short; 29 ledger movements with the cache check reporting 11 positions compared and none differing |
| 24 | owner | suggestion panel opened by a real click: paneer triggers 7,884.212, the packaging line reads "already asked for — not re-ordered", and rice's 1,000 unapproved shows in "Only requested" while being excluded from "At delivery" |
| 12–15 | north manager | 2 locations, 10 positions, ₹29,297.16 — exactly the owner's total less the ₹1,620.00 of freezer stock they cannot see; setup renders read-only with the reason stated |
| 16–19 | south manager | 1 location, 0 positions, ₹0.00, and only the one request routed to South |
| 20–23 | cashier | every inventory route redirects to the dashboard and the sidebar contains no inventory section at all |

The overview honestly reports "One scheduler job has never run" for the estate-wide pass,
because it has not. That is a real state surfaced rather than hidden.

## 8. Migrations

Two, both additive: `20260924400000_inventory_core`,
`20260924400100_inventory_location_access`. Every `ALTER TABLE` in either file is
`ADD CONSTRAINT … FOREIGN KEY` on a table the same migration just created. No pre-existing
POS table is altered, narrowed or back-filled.

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

Branch `x/inventory`, eight commits on top of `ca5780d`, each one internally consistent
rather than a slice of a single blob — the import graph was traced first so that no commit
mounts a router or boots a job that does not yet exist at that point in history:

| Commit subject | Contents |
| --- | --- |
| `INVENTORY schema: …` | `schema.prisma`, both migrations |
| `INVENTORY engine: …` | `lib/inventory/` |
| `INVENTORY scheduler: …` | `jobs/inventoryScheduler.js`, `index.js` boot |
| `INVENTORY api: …` | `api/routes/inventory/`, `app.js` mount |
| `INVENTORY pos: …` | `orders.js` consumption hook |
| `INVENTORY tests: …` | four test files, helper, pilot |
| `INVENTORY portal: …` | screens, `App.jsx`, `Layout.jsx` |
| `INVENTORY docs: …` | this file and the 24 captures |

Every commit was made with an explicit pathspec, never `git add -A`, so nothing belonging
to another lane could be swept in. The six pre-existing files this lane touches total
1,825 insertions and **0 deletions**, and each edit sits between `==== LANE inventory ====`
markers.

Remote `github` → `jitendersharma07-beep/VEXO-connect`, branch `x/inventory`. The push is
a fast-forward onto the existing remote tip; it is not a force-push and it is not the
release branch. This document is inside the last of the eight commits, so it cannot state
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
| INV-B3 | Scheduler has never run as a daemon. Its pass is proven by direct invocation and by tests, **not** by an unattended run | PRO | deployment decision | IMPLEMENTED-UNVERIFIED | `INVENTORY_SCHEDULER` unset |
| INV-B4 | Notifications are in-app only. **No email or WhatsApp adapter exists** — the non-in-app branch writes a FAILED row reading "No adapter configured for transport …". See the correction below | PRO | owner approval of a transport | NOT STARTED | `INVENTORY_NOTIFY_TRANSPORT=inapp` |
| INV-B5 | Landed-cost apportionment (`GoodsReceiptLandedCost`) is modelled and stored but has no UI, and **no test exercises it** | PRO | — | IMPLEMENTED-UNVERIFIED | unused table |
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
- **INV-B6 said `ProductionBatch` "is modelled with ledger support".** It is a table and
  nothing else: no route, no service, no ledger call, no reference of any kind under
  `src/`. It needs an API, ledger integration and a screen, from scratch.

INV-B5's row is accurate as it stood, with one addition: no test covers landed-cost
apportionment, so "stored" is a statement about the schema and the write path, not about
verified arithmetic.

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
