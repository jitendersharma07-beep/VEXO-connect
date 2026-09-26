# Migration rehearsal — the 31-migration fast-forward

**Run 2026-09-26 by the `x/operator-ui` session, on isolated staging. Nothing was
applied to production.** This closes the gap W6 recorded as **A14**: "those 29
migrations, adding roughly 117 tables, have never touched that database."

## 0 · The count is 31, not 29

W6 measured 29 against candidate `d625370` (41 migrations). The current
integration candidate carries **43** — `x/tables` adds
`20260925160000_tables_pax_waiter` and `20260926091200_order_status_merged`.
Production is at 12. **A deploy today performs 31 migrations, not 29.**

No other lane in the candidate adds a migration: `x/experience`,
`x/operator-ui` and `x/identity-coverage` change routes, middleware, tests,
frontend and docs only.

## 1 · What was rehearsed

| | |
|---|---|
| Source dump | `atc-backups/pos-prod/pos-prod-postcrash-20260926T111706Z.dump` (104K, custom format, 2026-09-26 13:08) |
| Staging DB | `vcx_migrehearse_31` on `127.0.0.1:5440` — **retained as evidence** |
| Migration set | tree `ab647c8` = main + `x/experience` + `x/tables` |
| Apply log | `/tmp/migrehearse-apply.log`, script `/tmp/migrehearse-apply.sh` |

Restored state matched W6's documented production baseline exactly: **12
migrations, 23 tables**, 17 orders / 32 items / 16 payments / 11 refunds /
366 audit rows / 90 sessions / 16 staff / 2 branches / 27 products.

## 2 · Result

**31 applied, 0 failed, 11 seconds.**

| | before | after |
|---|---|---|
| migrations | 12 | **43** |
| tables | 23 | **140** (+117) |

**Every row count is byte-identical before and after.** Order=17, OrderItem=32,
Payment=16, Refund=11, PosUser=16, PosAuditLog=366, PosSession=90, Company=1,
Branch=2, Product=27 — unchanged. No data was lost, rewritten or orphaned.

Slowest migration `20260924400000_inventory_core` at **1020 ms**; every other
one under 400 ms. There is no maintenance window here at production's scale —
this is a schema-correctness question, and the schema is now proven correct.

**No schema drift.** `schema.prisma` declares 139 models; the migrated database
holds 140 tables, which is 139 + `_prisma_migrations`. Every declared model has
a table. Set-differenced, not counted — the counts matching is not the proof.

## 3 · The crash-loop failure mode is excluded, measured not assumed

`prisma migrate deploy` re-checks a SHA-256 of every already-applied
`migration.sql` and refuses on a mismatch. Under `&& node src/index.js` with
`restart: unless-stopped` that refusal is a crash loop.

I re-derived the checksum of all **12** shared migrations from the candidate
tree and compared each against the `checksum` column in the restored production
`_prisma_migrations`: **0 drift**. Independently reproduces W6's "identical 12,
differing 0". The deploy fast-forwards.

## 4 · Rollback plan

**There are no down migrations.** Prisma `migrate deploy` is forward-only, and
none of the 31 ships a reverse script. Rollback is therefore *restore*, not
*revert*, and it requires a dump taken immediately before the deploy.

Measured on this box, against the real dump:

| step | measured |
|---|---|
| `pg_restore` to 12 migrations / 23 tables / 17 orders | **934 ms** |

So the database half of a rollback is under a second at current scale. The
binding constraint is the image swap and the pre-deploy dump, not the restore.

Order:

1. **Take a fresh dump immediately before deploying.** The rehearsal used a
   13:08 dump; anything older loses the interval. `pg_dump -Fc`.
2. Deploy. If the backend crash-loops, **check for a checksum refusal first** —
   its first error rotates out of a `10m × 5` log, so read it early.
3. To roll back: stop the backend, drop and recreate the database, `pg_restore`
   the pre-deploy dump, redeploy the previous image.
4. **The previous image must be pinned by digest before you start**, or step 4
   has nothing to roll back to. See §5.

## 5 · What I could NOT pin, and why it matters

The directive asked for a pinned image. **I did not build one, and the reason is
itself the finding** — W6's A13, which is still open:

- The images running in production are stamped
  `org.opencontainers.image.revision = 483a47f0…` (backend) and
  `842bc3ec…-dirty-dayclose` (frontend).
- `842bc3ec…-dirty-dayclose` is **a dirty build no commit describes**.
  Production is a mixed pair.
- `483a47f` does not exist in this repository, and the audited candidate does
  not exist in the tree those images were built from. They are divergent clones.

Pinning a *rollback target* means pinning those two images by digest. Pinning a
*forward* image means building from the final merged candidate — which does not
exist yet, because the `x/tables` ↔ `x/identity-coverage` conflict in
`backend/src/middleware/permissions.js` is unresolved (see the lane report).

Building an image from a tree that is not the release candidate would produce
exactly the untraceable artifact A13 is about. So this is deliberately left to
the deploy owner, with the two prerequisites named.

## 6 · Reproducing this

```bash
docker exec vexo-connect-dev-db psql -U vexo_dev -d postgres \
  -c 'CREATE DATABASE "vcx_migrehearse_31"'
docker exec -i vexo-connect-dev-db pg_restore -U vexo_dev -d vcx_migrehearse_31 \
  --no-owner --no-privileges < <dump>
/tmp/migrehearse-apply.sh
```

`migrate deploy` itself was not used: it needs a `DATABASE_URL` credential this
session could not obtain. The script is faithful to what `deploy` does —
lexical order, one transaction per migration, `ON_ERROR_STOP`, abort on first
failure, bookkeeping row written only on success with the real SHA-256. The one
thing it does not reproduce is deploy's own checksum gate, which §3 checks
separately and directly.
