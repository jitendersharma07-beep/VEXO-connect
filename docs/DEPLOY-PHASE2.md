# ATC POS — Phase 2 production deployment runbook

Status: **PREPARED ONLY — do not execute.** Production deployment is
owner-gated; this file exists so the eventual deploy is a checklist, not a
judgement call. Scope: ship phase-2 milestone 1 (catalog / orders / KOT /
billing / **manual** payment recording / refunds / reports) to the existing
`pos-prod` stack behind `https://atcworkspace.com/pos`.

Standing rules that survive this runbook:

- Milestone 1 records payments **manually** — never describe or announce it as
  gateway-verified online payment.
- Host nginx is NOT touched: the phase-1 `location ^~ /pos/` vhost already
  routes to 127.0.0.1:8110 and phase 2 changes nothing about the mount.
- Other stacks (ATC NOC/CRM, AGR, Megatel, WhatsApp) are out of bounds.

## 0. Preconditions (all must hold, verify fresh)

1. `~/atc-pos` on `phase2-backend`, HEAD is the reviewed integration commit
   (`c5943ee` or a later reviewed commit) and `git status --porcelain` is
   **empty** — prod images build from the working tree, so an untracked file
   ships.
2. Backend tests green from this exact tree — **never with a bare `vitest run`
   on a host whose environment carries production credentials.** The suites
   truncate tables; point them at the dev test database explicitly and let the
   value, not the ambient env, decide:

   ```sh
   cd backend
   # <dev-db-password> = POSTGRES_PASSWORD of the dev container atc-pos-dev-db.
   # Read it from that container's env; it is not written down in this repo.
   env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
     DATABASE_URL='postgresql://atc_pos:<dev-db-password>@127.0.0.1:5439/atc_pos_test?schema=public' \
     NODE_ENV=test LOG_LEVEL=silent npx vitest run
   ```

   The database name **must** end in `_test` (`atc_pos_test`, not `atc_pos`) —
   that suffix is the whole safety property here.

   → 71/71 at c5943ee (foundation 20, logRedaction 7, money 13, phase2 31).
   `tests/foundation.test.js` and `tests/phase2.test.js` refuse to start
   unless `DATABASE_URL` ends in `_test`, so a mis-pointed run fails loudly
   instead of writing somewhere real — treat that guard as a backstop, not as
   permission to run tests without setting the URL. Tests belong on the dev
   host/stack; the prod host runs verification only (§4).
3. Dev E2E walkthroughs green against the dev stack (`tests/e2e/walk-*.cjs`),
   including the licence-enforcement walkthrough.
4. `df -h /` shows comfortably more free space than an image build needs
   (≥ 10G; this host has crashed databases on ENOSPC before).
5. Prod `.env` (repo root, not committed): `VITE_BASE_PATH=/pos/` and
   `HTTP_PORT=8110` present — the frontend bundle inlines the base path at
   build time.

## 1. Record rollback anchors (before anything changes)

Image IDs first — these are the code-rollback targets:

```sh
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep pos-prod
# write both IDs (backend + frontend) somewhere durable, not just this scrollback
```

Then the database dump. **A non-empty file is not a backup.** Three things
must hold before the dump counts: the dump command exited 0, the archive is
readable as an archive, and it restores into a scratch database. This host has
filled its single volume before and zeroed files mid-write, so verify all
three:

```sh
DUMP=~/pos-prod-pre-phase2-$(date +%Y%m%d-%H%M).dump

# (a) exit status of pg_dump itself — not of the shell redirect
docker exec pos-prod-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DUMP"; echo "pg_dump rc=$?"
# rc MUST be 0. Any other value: delete the file and stop.

# (b) archive readability — pg_restore parses the custom-format TOC
pg_restore --list "$DUMP" | tail -5        # if pg_restore is not on the host:
# docker exec -i pos-prod-postgres-1 pg_restore --list - < "$DUMP" | tail -5
ls -lh "$DUMP"

# (c) isolated restore verification — into a scratch DB in the same container,
#     never into the live database
docker exec pos-prod-postgres-1 sh -lc 'createdb -U "$POSTGRES_USER" pos_restore_check'
docker exec -i pos-prod-postgres-1 sh -lc \
  'pg_restore -U "$POSTGRES_USER" -d pos_restore_check --no-owner --exit-on-error' < "$DUMP"
echo "pg_restore rc=$?"   # MUST be 0
docker exec pos-prod-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d pos_restore_check -v ON_ERROR_STOP=1 -tAc "SELECT (SELECT count(*) FROM \"PosUser\"), (SELECT count(*) FROM \"Company\"), (SELECT count(*) FROM \"License\"), (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL), (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL);"'
```

Judge those numbers **inside the snapshot**, not against the live database. The
live database keeps taking orders and payments while you work, so a mismatch
there tells you only that time passed — and an accidental match tells you
nothing at all. What the snapshot must prove about itself:

- `PosUser`, `Company` and `License` counts are all non-zero, and the user and
  company counts match what §4 will later confirm on the restored system.
- the finished-migration count equals the number of directories in
  `backend/prisma/migrations/` at the deployed commit.
- the **unfinished**-migration count is 0. A row with `finished_at IS NULL` is
  a migration that was interrupted; restoring that snapshot reproduces a
  half-applied schema.

Write the three counts down next to `$DUMP`. They are the definition of the
restore point: after any future restore, this is the state you are entitled to
expect, and anything beyond it was created after the dump and is gone.

```sh
docker exec pos-prod-postgres-1 sh -lc 'dropdb -U "$POSTGRES_USER" pos_restore_check'
```

Only after (a), (b) and (c) pass is the deploy allowed to proceed. Keep `$DUMP`
until the deploy has been stable for at least a full business day.

## 2. Migration gate (never skip)

The backend container boots with `npx prisma migrate deploy && node
src/index.js`, so **whatever migration dirs are in the image get applied to the
production database on first boot**. Gate on the DATABASE, not on git:

```sh
docker exec pos-prod-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;"'
ls backend/prisma/migrations
```

Expected delta for THIS deploy: exactly one unapplied dir,
`20260920180000_pos_phase2_orders` — applying it on boot is **intended** here.
Any other unapplied name (a peer's lane, anything unreviewed) → **STOP**; that
is a decision, not a detail.

## 3. Build + deploy

```sh
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker logs pos-prod-backend-1 --tail 60
```

In the backend log expect the single phase-2 migration being applied (or `No
pending migrations to apply.` on a re-run), then the listen line. Any other
migration name in the log → STOP and roll back (§6).

## 4. Verify (read-only, in this order)

```sh
node deploy/prod-verify.mjs                                   # loopback 8110 — expect 12/12 PASS
BASE_URL=https://atcworkspace.com/pos node deploy/prod-verify.mjs   # public mount — expect 12/12 PASS
curl -fsS https://atcworkspace.com/pos/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://atcworkspace.com/       # regression: main site 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://atcworkspace.com/reviews/  # regression: reviews 200
```

**Content check — a green build can still be a stale cache** (learned on AGR):
the served bundle must actually contain phase-2 UI. The asset filename must
have changed from the phase-1 bundle, and a phase-2-only string must be
present:

```sh
curl -s https://atcworkspace.com/pos/ | grep -o 'assets/index-[^"]*\.js'
curl -s https://atcworkspace.com/pos/$(curl -s https://atcworkspace.com/pos/ | grep -o 'assets/index-[^"]*\.js' | head -1) \
  | grep -c 'Kitchen order ticket'    # expect >= 1
```

If the marker is missing, rebuild with `docker compose -f
docker-compose.prod.yml build --no-cache frontend` and redeploy.

**Log-redaction check (credential-free):** hit the anonymous
`https://atcworkspace.com/pos/api/config`, then confirm the new request line in
`docker logs pos-prod-backend-1` shows `res` as exactly
`{"statusCode":…,"contentLength":…}` with no `headers` key.

## 5. Demo credential rotation + handover (mandatory before sharing access)

Dev demo passwords exist in git history (24031d3..c5943ee); prod accounts must
not share them.

**Do not re-run the seed to rotate passwords.** `prisma/seed.js` is a
provisioning script: it walks the whole foundation and creates anything it
finds missing, so on a live database it can mint rows nobody asked for. Use
the scoped, password-only script instead — it writes `PosUser.passwordHash` +
`mustChangePassword` for accounts named on the command line, revokes their
sessions, and touches nothing else (licences, catalog, orders, payments,
branches and every unnamed user are untouched):

```sh
# 1. PREVIEW — name the accounts, see exactly what would change. Writes nothing.
docker exec pos-prod-backend-1 \
  node scripts/rotate-pos-passwords.mjs --emails 'a@example.com,b@example.com'
```

The preview prints one line per account — email, role, status, company slug
and live-session count — and refuses outright if any listed email has no POS
account (a typo must never silently rotate a shorter list than intended).
Confirm that list is exactly the set you mean to change before going on.

```sh
# 2. ROTATE — generated passwords, printed ONCE:
docker exec pos-prod-backend-1 \
  node scripts/rotate-pos-passwords.mjs --emails 'a@example.com,b@example.com' --confirm

# …or type the passwords yourself, echo off, nothing in argv/env/history:
docker exec -it pos-prod-backend-1 \
  node scripts/rotate-pos-passwords.mjs --emails 'a@example.com,b@example.com' --prompt --confirm
```

Per account the script, in one transaction: sets the new hash, sets
`mustChangePassword = true`, revokes **every** non-revoked `PosSession` row for
that user (an old `pos_session` cookie stops working immediately — that is the
same complete-revoke path used after the 2026-09-20 log-redaction incident),
and writes a `PASSWORD_ROTATED` audit row. Record the printed passwords, clear
the screen, hand them over out-of-band; each user is forced to change theirs on
first sign-in. Only then is access shared.

Verify afterwards — the audit trail and the session revocations, no password
needed:

```sh
docker exec -i pos-prod-postgres-1 sh -lc 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' <<'SQL'
SELECT at, "entityId", meta FROM "PosAuditLog"
 WHERE action = 'PASSWORD_ROTATED' ORDER BY at DESC LIMIT 10;
SELECT u.email, u."mustChangePassword",
       count(s.id) FILTER (WHERE s."revokedAt" IS NULL) AS live_sessions
  FROM "PosUser" u LEFT JOIN "PosSession" s ON s."userId" = u.id
 GROUP BY u.email, u."mustChangePassword" ORDER BY u.email;
SQL
```

Each rotated account must show `mustChangePassword = t` and
`live_sessions = 0` until its owner signs in.

## 6. Rollback

- **Code-only** (phase-2 tables are additive; phase-1 code ignores them, so a
  code rollback does NOT require a DB rollback):

  ```sh
  docker image tag <old-backend-id>  pos-prod-backend:latest
  docker image tag <old-frontend-id> pos-prod-frontend:latest
  docker compose -f docker-compose.prod.yml up -d --no-deps --no-build backend frontend
  ```

- **Full database rollback — DESTRUCTIVE LAST RESORT. Owner approval required.**

  This is not the undo button for a bad deploy; the code-only rollback above is.
  Reach for this only when the database itself is wrong and cannot be repaired
  forward.

  **A tested backup does not make the data loss safe.** §1 step (c) proves the
  archive restores — it says nothing about the writes that happened *after* the
  dump, and those are destroyed with no second copy:

  - every order, KOT, payment and refund recorded since the dump disappears;
    money that was taken at the counter will no longer exist in the system;
  - `InvoiceCounter` rewinds, so invoice numbers already printed on customer
    receipts get **reissued** to different sales — a GST-visible duplication
    that cannot be fixed by restoring again;
  - any user, branch, licence or catalog change made after the dump is undone,
    including a §5 password rotation (old passwords become valid again).

  Before running it: take a fresh dump of the *current* (wrong) database first,
  verified the same three ways, so the post-dump writes can still be read back
  and re-entered by hand afterwards. Losing them is a business decision, not a
  technical step — the owner makes it, and §5 rotation must be re-run after the
  restore.

  Two further things make this more than a `pg_restore --clean`:

  1. **Writes must be stopped first.** `--clean` against a live backend races
     the application and can leave a half-restored database. Stop the writer,
     not just the traffic:

     ```sh
     docker compose -f docker-compose.prod.yml stop backend
     docker exec pos-prod-postgres-1 sh -lc \
       'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();"'
     # expect 0; if not, find the connection before continuing
     ```

  2. **`--clean` does not remove the phase-2 tables.** `pg_restore --clean`
     only drops objects it is about to restore, and a pre-phase-2 dump does not
     contain `Order`, `OrderItem`, `Kot`, `Payment`, `Refund`,
     `InvoiceCounter`, `Product`, `ProductVariant`, `Category`, `TaxRate` or
     `DiningTable`. Left in place they survive with their data while
     `_prisma_migrations` is rolled back to the phase-1 row set — so the next
     boot re-applies `20260920180000_pos_phase2_orders` onto tables that
     already exist and fails. Restore into a clean schema instead:

     ```sh
     docker exec pos-prod-postgres-1 sh -lc \
       'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
     docker exec -i pos-prod-postgres-1 sh -lc \
       'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$DUMP"
     echo "pg_restore rc=$?"   # MUST be 0
     ```

     `DROP SCHEMA public CASCADE` destroys everything currently in the
     database — it is correct only because step (c) in §1 proved this exact
     archive restores cleanly. Never run it against an unverified dump.

  3. Then roll the code back (code-only steps above) and start the backend:
     `docker compose -f docker-compose.prod.yml up -d backend`. Confirm the
     log shows only phase-1 migrations and that `/pos/api/health` answers.

  If instead you want to **keep** the phase-2 data and only revert the code,
  use the code-only rollback: the phase-2 tables are additive and phase-1 code
  ignores them.

- Git-side undo of the integration itself: `git revert -m 1 c5943ee` on
  `phase2-backend`.
