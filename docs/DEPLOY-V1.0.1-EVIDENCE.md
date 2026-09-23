# v1.0.1 — pre-deploy evidence pack

Prepared by session `7565dff8`, which assembled and verified the candidate.
**This session does not own the deploy.** `DEPLOY-OWNER.md` names `896234f0`,
claimed 06:20Z; this file exists so that owner does not have to re-derive any of
it. Nothing here was run against `pos-prod` except read-only queries and one
`pg_dump`.

Everything below was executed. Where a line says PASS it is the output of a
script that is still on disk and can be re-run in front of you — paths are given
so a claim can be checked rather than believed.

---

## 1. The backup exists, and it restores

A dump that has never been restored is an untested claim, so it was restored.

| | |
|---|---|
| File | `/home/atc-noc/pos-release-v101/backup/atc_pos_preRelease_20260923T055235Z.dump` |
| Taken | 2026-09-23 05:52:35Z, `pg_dump -Fc --no-owner --no-acl` from `pos-prod-postgres-1` |
| Size | 97 751 bytes |
| sha256 | `c8d81196ee4c0ae276af259816be5705f8fbe8198bdc6dc017a7171a6d376f88` |

Restored into a throwaway database on `atc-pos-dev-db` and compared against live
production — **11 PASS / 0 FAIL** (`backup/verify-restore.mjs`):

```
PASS  restored copy has the same table set              prod=23 tables, copy=23 tables
PASS  every table restored with an identical row count  509 rows across 23 tables
PASS  Order / Payment / Refund / DayClose / PosAuditLog / GatewayWebhookEvent row counts preserved
PASS  total payments taken match to the paisa           1695.23 both sides
PASS  total refunds issued match to the paisa           50.00 both sides
PASS  every order id/status/total is byte-identical     md5 004690cc30c5...
```

The counts are exact `count(*)` values, not `pg_stat_user_tables.n_live_tup`.
That distinction is the whole reliability of this check: `n_live_tup` reads **0**
on a freshly restored database until `ANALYZE` runs, so a comparison built on it
would report a perfect match for a restore that had dropped every row.

## 2. The migration was rehearsed on a copy of production

Not on a synthetic database — on the restored dump, using the **exact command
the deploy runs**. **8 PASS / 0 FAIL** (`backup/rehearse-migrate-deploy.mjs`):

```
PASS  the copy starts where production is                11 migrations applied
PASS  `prisma migrate deploy` succeeds                   exit 0
PASS  exactly ONE migration was applied                  11 -> 12
PASS  and it is the one under review                     20260923040000_payment_idempotency_key
PASS  no migration is left unfinished or rolled back
PASS  the column and the per-order unique index are both there
PASS  not one paisa moved                                10/1695.23 (count/total) unchanged
PASS  running the deploy a second time is a no-op        No pending migrations
```

Two of those are worth naming. *Exactly one* guards against a migration being
added behind the reviewed change — if this ever reports 2, the deploy is not the
change that was verified. *A second run is a no-op* matters because the compose
command runs `prisma migrate deploy` on **every** container boot, including a
rollback boot and every subsequent restart.

## 3. Rollback: proven, not asserted

**Rollback is "redeploy the previous images and leave the schema in place."**
There is no down-migration and none is needed.

The claim underneath that is strong — it says the old binary keeps working
against a database it was never compiled for — so it was executed rather than
reasoned about. **15 PASS / 0 FAIL** (`backup/prove-migration-rollback.mjs`):

```
PASS  the old client genuinely predates the column (negative control)
                                          Payment block: shared=absent, release=present
PASS  the old client can still TAKE a payment on the new schema
PASS  the column it does not know about defaults to NULL
PASS  the old client can still READ and total payments   select + aggregate fine
```

The "old client" is the real one: the generated Prisma client in the shared tree
`/home/atc-noc/atc-pos/backend/node_modules`, which is what `847423d` is built
from. The negative control is scoped to the **`model Payment` block**, because a
file-wide search for `idempotencyKey` is true on every build ever made —
`PaymentIntent` and `Refund` have each carried one since the gateway work, and a
whole-file match would report "not an old client" for a client that is.

Why it works: `idempotencyKey` is **nullable**, and Postgres treats NULLs as
distinct under a unique index, so unlimited old-style rows coexist under
`@@unique([orderId, idempotencyKey])`. Old code writes NULL and never sees the
column.

### Ordering, and why it is not a risk here

The compose command is `sh -c "npx prisma migrate deploy && node src/index.js"`
— confirmed against the **running** container, not inferred from the Dockerfile,
whose `CMD` is overridden and says something different. So the migration runs at
container boot, before the app serves, on the way both forward and back.

That leaves one theoretical window: old container still serving while the new
one migrates. Section 3 is exactly the proof that this window is harmless.

## 4. What the candidate is, and that it is still what was verified

Branch `phase2-release-v1.0.1`, head **`bf802af`**.

The verification below was run at `f841ca2`. The branch has since advanced four
commits (a peer merged `phase2-integration`'s documentation and the two
ownership files). That does **not** stale the evidence, and this is checked by
content rather than argued:

```
IDENTICAL  backend/src        1f953f3380cf
IDENTICAL  backend/prisma     542e3f439204
IDENTICAL  backend/tests      24e0c3ffa3b0
IDENTICAL  frontend/src       fc5f512c8013
IDENTICAL  frontend/index.html 727627cd158c
IDENTICAL  backend/package.json / frontend/package.json
```

Every source tree object hash is unchanged between `f841ca2` and `bf802af`. The
merge is documentation only.

| Check | Result |
|---|---|
| Backend suite | **368 passed / 368**, 11 files, 119.24 s |
| Production build | 1665 modules, `index-KdFSGqFs.js` 451.22 kB (gzip 125.28), `index-j8XEdcDR.css` 34.38 kB |
| Both fixes present in the built artefacts | verified **by content**, incl. `body>*:not([data-print-root]){display:none!important}` |

### Receipt and KOT, from the actual modal flow

**8 PASS / 0 FAIL** (`/home/atc-noc/pos-hw-uat/probe-release-print.mjs`):

```
PASS  KOT PRINTS ONE PAGE from the modal flow, on 80mm stock      pages=1 leaf=1 agree=true 80.1x27.2mm
PASS  RECEIPT PRINTS ONE PAGE from the modal flow, on 80mm stock  pages=1 leaf=1 agree=true 80.1x70.9mm
PASS  the order is BILLED and unpaid — printing collected nothing BILLED, 0 collected
```

Driven through the real dialog on the real `/sell` screen, not a render harness.
That distinction is the defect: the bug was never in the receipt markup, it was
that the page *behind* the modal kept its full height, so Chromium repainted the
modal once per background page. A harness that renders the component on a blank
page cannot reproduce it and would have reported PASS throughout.

The **page width is asserted, not just the count.** On the first run this check
"passed" at 215.9 × 279.4 mm — US Letter — because the receipt dialog had never
opened and it was printing the plain `/sell` screen, which is also one page. One
page of the wrong thing is not a receipt.

### Payment idempotency — 11 named tests

Scoping, reuse, renewal, rejection and concurrency are each a test, not a
paragraph:

```
✓ CONTROL: without a key the same partial payment is still taken twice
✓ with a key the retry returns the first payment and takes nothing more
✓ a retried FULL payment answers with the payment, not a 409
✓ two simultaneous requests with one key produce one payment
✓ an even split under two keys is still two payments
✓ the same key for a different amount is refused, and the first payment stands
✓ a replayed CASH payment reports the same change due
✓ the same key on a different order is a different payment
✓ a neighbouring tenant cannot use the key to read a payment
✓ a replay is audited as a replay, not as a second collection
✓ the database itself refuses a second row under one key
```

The CONTROL line is the one that makes the rest mean anything: it proves the
double collection still happens when the key is absent, so the other ten are
measuring the fix rather than an unrelated guard.

## 5. Still NOT TESTED

- **Physical thermal printing.** No receipt or KOT from this build has reached a
  thermal printer. The 80 mm figures above are Chromium's PDF page geometry.
  This stays NOT TESTED until a device exists — it is not a PASS and must not be
  reported as one.
- **Razorpay.** Deliberately disabled; `POS_GATEWAY_PROVIDER` is unset and
  `/api/gateway/*` answers 404 on production and on the release stack. Nothing
  in v1.0.1 changes that, and `pay_Tf4bqZCtM4GOU2` remains unconsumed.

## 6. Re-running any of this

```
cd /home/atc-noc/pos-release-v101/backup
node ./verify-restore.mjs                  # backup integrity vs live production
ROLLBACK_PROBE_URL=... node ./rehearse-migrate-deploy.mjs
ROLLBACK_PROBE_URL=... node ./prove-migration-rollback.mjs
```

Both `ROLLBACK_PROBE_URL` scripts refuse to start unless the URL ends in
`/atc_pos_restore_check`, so a mistyped target cannot reach anything real. Each
re-restores the scratch database from the dump first, so they are repeatable and
a second run is not measuring the first run's residue.
