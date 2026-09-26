# Lane evidence — VC-104 backend / API (`x/vc104-api`)

Owner: VC-104 W1. Date: 2026-09-24. Spec: `A§3 VC-104` ("Update 5").
Nothing in this lane has been committed, merged, pushed or deployed.

---

## 1. Revision

| | |
|---|---|
| Worktree | `/home/atc-noc/vexo-connect-x-lanes/vc104-api` |
| Branch | `x/vc104-api` |
| HEAD | `bddbe82c098a6c5b18c2931e6c3495217011b133` — **unchanged; all work is uncommitted** |
| Base rationale | `docs/VC104-SETUP.md` §1 |

### Tracked files changed (3)

```
backend/prisma/schema.prisma     | 298 +++++   models/enums at end + 4 back-relation blocks
backend/prisma/seed.js           |  99 +++++   one marked seedPhoneOrderCentre() block
backend/src/api/routes/orders.js |   5 +-      resolveCatalogLine exported (one token + comment)
backend/src/app.js               |   5 +       one // LANE vc104-api import + mount block
```

### New files

```
backend/prisma/migrations/20260924800000_vc104_phone_order_centre/migration.sql  250
backend/src/lib/phoneOrders.js                                                   249
backend/src/api/routes/phoneOrders.js                                            969
backend/tests/phoneOrders.test.js                                                639
backend/scripts/vc104-fixtures.mjs                                               159
backend/tests/fixtures/vc104/*.json                                               12 files
docs/VC104-SETUP.md, docs/VC104-API-CONTRACT.md, docs/lanes/VC104-API.md
```

Contract sha256 `d8e30b769de7781f57779ee22e93ed0c108c55beeb04e72b38ba11494df904d9`.

---

## 2. Data model

Seven new tables, two-plus-two new enums, all at the end of `schema.prisma`
under `// ==== LANE vc104-api ====`.

| Model | Purpose |
|---|---|
| `Customer` | tenant-scoped caller, unique on `(companyId, phone)` |
| `CustomerAddress` | multiple addresses, default flag, archivable |
| `BranchServiceArea` | serviceability by pincode + delivery charge + minimum |
| `BranchHours` | per-weekday IST opening minutes, past-midnight capable |
| `BranchPrepCapacity` | orders-per-slot preparation capacity |
| `PhoneOrder` | the sidecar: routing, fulfilment, scheduling, acceptance, attribution, idempotency |
| `PhoneOrderEvent` | operational routing history |

**The sidecar principle.** A phone order *is* an ordinary `Order` in the routed
store from submission onward, so pricing, tax, KOT, payment and refund reuse the
existing lifecycle and `recomputeOrder()` stays the single evaluator. Nothing in
this lane writes order money.

**Teardown-safe referential actions.** These tables reference `Order`,
`PosUser`, `Branch` and `Company` — all four of which every peer suite's
`wipe()` deletes. With `RESTRICT`, one leftover row here would break all 12 peer
suites. That is not hypothetical: it is exactly how `OrderItemModifier` broke 7
suites in the foundation lane on 2026-09-24. So the FKs are `Cascade`/`SetNull`
on every path teardown touches (11 cascade, 4 set-null, 1 restrict), and
`tests/phoneOrders.test.js` wipes its own tables in both `beforeAll` and
`afterAll`.

**Attribution is snapshotted, not joined.** `PhoneOrder.operatorName` is NOT
NULL; `operatorId` is a nullable convenience join. Same for
`acceptedByName`/`rejectedByName`. Attribution that depends on a mutable row
still existing is attribution that can be edited or lost — the same reasoning
the foundation lane applies to the invoice billing snapshot.

---

## 3. Migration

`20260924800000_vc104_phone_order_centre` — range claimed in `VC104-SETUP.md` §5.

- **Purely additive**: 7 `CREATE TABLE`, 4 `CREATE TYPE`, 21 indexes, 16 `ALTER
  TABLE ADD CONSTRAINT` — every one targeting a new table. **Zero `DROP`.**
- No existing migration renamed, edited or deleted.
- Drift gate: `prisma migrate diff --from-migrations --to-schema-datamodel`
  prints `-- This is an empty migration.`

**Rollback.** The migration creates only new objects, so rollback is
`DROP TABLE "PhoneOrderEvent", "PhoneOrder", "CustomerAddress", "Customer",
"BranchServiceArea", "BranchHours", "BranchPrepCapacity";` followed by
`DROP TYPE "PhoneOrderStatus", "PhoneFulfilment", "DeliveryChargeTreatment",
"DeliverySupplier";` and deleting the `_prisma_migrations` row. No existing
table or column is touched, so no data outside this module can be affected.

---

## 4. API

Eleven endpoints under `/api/phone-orders`. Full request/response bodies,
permissions, state machine and error codes: `docs/VC104-API-CONTRACT.md` v1.2.0.

Role/tier matrix (§3 of the contract): six `phone.*` actions in ONE exported map
(`PHONE_ORDER_ACTIONS`) so integration can graft them onto the foundation
permission matrix mechanically. `POS_SUPER_ADMIN` holds none of them.

Module keys exported and every router marked: `PHONE_ORDERS` (Pro),
`HQ_ROUTING` (Enterprise).

---

## 5. Test evidence

Commands, run on lane-private DB `atc_pos_vc104api_test` @ 127.0.0.1:5439
(`POS_JWT_SECRET` exported, 64 chars; password read from the container at
runtime and never written down):

```
npx prisma generate
npx prisma migrate deploy          -> 17 migrations, all applied
npx prisma migrate diff ...        -> -- This is an empty migration.
npx vitest run tests/phoneOrders.test.js
npx vitest run
```

| Run | Result |
|---|---|
| Base `bddbe82` + migration, existing suites only | **414 passed (414), 13 files** |
| `tests/phoneOrders.test.js` alone | **41 passed (41)** |
| Full suite | **455 passed (455), 14 files**, 121.39s |

455 = 414 baseline + 41 new. **No existing test changed, skipped or deleted.**

### What the 39 tests actually assert

| Requirement (user brief) | Covered by |
|---|---|
| 1 tenant-scoped lookup, permitted history, addresses | cross-tenant search returns nothing on an exact phone match; direct fetch of a peer tenant's caller is 404 not 403; history scoped per store |
| 2 manual entry, pickup/delivery, items, notes | submission creates one real `Order` in the routed store |
| 3 branch selection: serviceability, hours, menu, capacity, charges | unserviceable/closed/at-capacity/below-minimum each returned **with a reason**, unavailable stores listed rather than hidden |
| 4 scheduled orders | future time required; explicit time preserved; capacity counted per slot |
| 5 reuse order/pricing/tax/payment/KOT lifecycle | **end-to-end through the real till routes, no VC-104 endpoint after acceptance**: KOT seq 1 → `/bill` mints `CP/26-27/00001` from the shared counter with tax breakup `{GST 5%, taxable 400, tax 20}` → `/payments` CASH 500 against 420 due, change 80, order `PAID` |
| 6 operator attribution, audited acceptance/reassignment | `operatorName`, `acceptedByName`, `rejectedByName` asserted; event trail `['SUBMITTED','REJECTED','REASSIGNED']` |
| 7 idempotency, concurrent acceptance | replay → 200 same ids; concurrent double-submit → exactly 1 row; two racing accepts → exactly `[200, 409]`, **and 1 order, 0 KOTs** |
| 8 branch change recalculates; invoice never relocates | reassign moves store, recomputes, charge 40→60; an order billed **through the real route** refuses with `POS_INVOICE_ISSUED` and **stays put** |
| 9 tenant/store permissions, HQ-routing entitlement | cashier 403 everywhere; manager cannot route or accept for another store; owner-only reassignment; `POS_HQ_ROUTING_NOT_ENTITLED` without `MULTI_STORE` |

---

## 6. Status per requirement

`LANE-BRIEF §5` statuses. **ACCEPTED requires executed browser evidence**, which
is W2's half and has not been run, so nothing here is ACCEPTED.

| # | Requirement | Status |
|---|---|---|
| 1 | Customer lookup, history, addresses | IMPLEMENTED-UNVERIFIED |
| 2 | Manual phone-order entry (pickup/delivery, items, notes) | IMPLEMENTED-UNVERIFIED |
| 3 | Authorized branch selection | IMPLEMENTED-UNVERIFIED (menu availability partial — see C-7) |
| 4 | Scheduled orders | IMPLEMENTED-UNVERIFIED |
| 5 | Reuse existing lifecycle | IMPLEMENTED-UNVERIFIED |
| 6 | Operator attribution, audited acceptance | IMPLEMENTED-UNVERIFIED |
| 7 | Idempotency + concurrency | IMPLEMENTED-UNVERIFIED |
| 8 | Recalculation, invoice immutability | IMPLEMENTED-UNVERIFIED |
| 9 | Permissions + HQ-routing entitlement | IMPLEMENTED-UNVERIFIED (proxy gate — see C-3) |
| 2b | **Modifiers on phone-order lines** | **NOT DONE — brief item 2 names them explicitly.** Blocked: base `bddbe82` has no modifier models. See §7.5 |

---

## 7. Limitations, blockers and owner input

1. **`4f2a91c` does not exist.** The base published to W2/W3 and certified by the
   Phase-1 exit gate is not in the repository. **BLOCKER — owner.**
   (`VC104-SETUP.md` §1.)
2. **C-6, delivery charge — OPEN, owner.** Two facts are unestablished: who
   supplies the delivery, and whether the charge is separate consideration.
   Current behaviour is a labelled temporary fallback: quoted beside the order,
   never in `Order.total`, never taxed, `deliveryChargeBillable: false`, and
   recorded in data as `deliverySupplier = UNRESOLVED` /
   `deliveryChargeTreatment = UNRESOLVED_POST_TAX_FALLBACK`. Closing it needs
   both answers plus, if composite supply, the rate. Contract §12.
3. **C-7, per-branch menu availability — no data model.** `Product` is
   company-scoped; there is no branch dimension in the catalog. `MENU_UNAVAILABLE`
   therefore only answers "is the item active in the tenant's menu", which is the
   same answer for every store. Real per-store availability needs a branch-scoped
   catalog, which is not this lane's to create. **Reported honestly rather than
   faked per branch.**
4. **C-3, HQ-routing entitlement is a proxy.** No module/tier mechanism exists
   (`LicensePlan` = FREE_TRIAL|SINGLE_STORE|MULTI_STORE; `LicenseAddonKind` =
   ADDITIONAL_BRANCH only). Gated on `MULTI_STORE` and marked
   `// INTEGRATION(firstlogin)` for mechanical replacement by `requireModule()`.
5. **Modifiers are not supported on phone-order lines.** The base `bddbe82` has
   no modifier models; they exist only in `cfa22e9` alongside promotions. When
   modifiers merge, `resolveCatalogLine` gains `modifierOptionIds` and this lane
   passes them through — one call site, `routes/phoneOrders.js`.
6. **No browser evidence, no UI.** W2 owns that. Fixture runs prove nothing about
   integration and are not claimed to.
7. **Cancellation is modelled but has no endpoint.** `CANCELLED` exists in the
   enum; no route sets it, deliberately — the refund/void rules for a paid-for
   phone order need the same C-6 answer. It is **not queryable**: an unknown
   `status` filter is now refused with 400 rather than dropped. Dropping it
   emptied the filter list, and an empty list means "no filter", so
   `?status=CANCELLED` would have returned *every* order — the widest possible
   answer to the narrowest question. Regression test:
   "filters by status, and REFUSES a status nothing can produce".

---

## 8. Integration notes

- **Shared files touched:** `schema.prisma` (additive, marked block + 4
  one-line back-relation blocks), `seed.js` (one marked function, idempotent),
  `app.js` (one marked block),
  `routes/orders.js` (**one token**: `export` on `resolveCatalogLine`, plus a
  three-line comment saying why). Expected conflicts are trivial.
- **Not touched:** `lib/orders.js`, `frontend/*`, any peer lane's files, any
  existing migration.
- **Migration ordering:** `20260924800000` sorts after foundation (`1000xx`),
  promotions (`2000xx`), kitchen, inventory, orders, firstlogin and cash. It
  depends on `Branch`, `Company`, `PosUser` and `Order` only, all of which exist
  in RC-1, so it can be applied at any point after the foundation migrations.
- **If the base is re-pinned to `cfa22e9`**, this lane rebases and the only
  expected conflicts are `schema.prisma` (both append at the end) and the
  `resolveCatalogLine` signature, which gains `modifierOptionIds` there.
