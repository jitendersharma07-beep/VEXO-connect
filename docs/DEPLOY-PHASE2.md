# ATC POS — Phase 2 production deployment runbook

Status: **EXECUTED 2026-09-21 at `0670e7e`** — see §7 for what actually
happened and what is still outstanding. Everything below §7 is the checklist
that was followed; keep it current, because the next phase reuses it. Scope:
ship phase-2 milestone 1 (catalog / orders / KOT / billing / **manual**
payment recording / refunds / reports) to the existing `pos-prod` stack behind
`https://atcworkspace.com/pos`.

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
     POS_JWT_SECRET="$(openssl rand -hex 32)" \
     NODE_ENV=test LOG_LEVEL=silent npx vitest run
   ```

   The database name **must** end in `_test` (`atc_pos_test`, not `atc_pos`) —
   that suffix is the whole safety property here.

   `POS_JWT_SECRET` is required by `src/config/env.js` (≥ 32 chars) and the
   suite boots the app, so without it two files fail to collect. Generate a
   throwaway one per run as above rather than reaching for the real secret:
   the tests only need *a* valid signing key, and an ephemeral value keeps the
   production secret out of the test shell and out of this document.

   → 71/71 at 209e128 (foundation 20, logRedaction 7, money 13, phase2 31).
   `tests/foundation.test.js` and `tests/phase2.test.js` refuse to start
   unless `DATABASE_URL` ends in `_test`, so a mis-pointed run fails loudly
   instead of writing somewhere real — treat that guard as a backstop, not as
   permission to run tests without setting the URL. Tests belong on the dev
   host/stack; the prod host runs verification only (§4).
3. Dev E2E walkthroughs green against the dev stack (`tests/e2e/walk-*.cjs`).
   The role walkthroughs read the dev seed passwords from
   `POS_SEED_*_PASSWORD` and refuse (exit 2) if one is unset. The licence
   walkthrough needs no password — it provisions its own disposable tenant:

   ```sh
   DATABASE_URL='postgresql://atc_pos:<dev-db-password>@127.0.0.1:5439/atc_pos?schema=public' \
     node tests/e2e/walk-licence.cjs
   ```

   It refuses to start unless that DSN is loopback on the dev port, drives
   ACTIVE → EXPIRED → SUSPENDED → ACTIVE on tenant `pos-licence-test` only,
   and restores the licence on exit and on SIGINT/SIGTERM, verified by reading
   the row back. If the restore does not verify it exits nonzero and leaves a
   recovery file (`/tmp/pos-licence-test-recovery.json`) holding the original
   status, the original expiry and the exact SQL to put them back.
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

# (a′) preferred: dump to a file INSIDE the container, then copy it out and
#      compare checksums. This host has zeroed files mid-write on ENOSPC, and
#      a shell redirect cannot tell a short write from a complete one — two
#      matching digests can.
docker exec pos-prod-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/pre-phase2.dump'; echo "pg_dump rc=$?"
docker cp pos-prod-postgres-1:/tmp/pre-phase2.dump "$DUMP"
docker exec pos-prod-postgres-1 sha256sum /tmp/pre-phase2.dump; sha256sum "$DUMP"
# the two digests MUST match; delete /tmp/pre-phase2.dump from the container
# afterwards — it is a full copy of production data on a container filesystem.

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

Checks 7–10 prompt for the ATC admin email and password, so **run this from a
real terminal, not a pipe or a non-interactive runner** — otherwise the script
stops at `interactive sign-in needs a TTY` and you get 8/10. The password is
read with echo off and is never printed, logged or sent anywhere but
`/api/auth/login`.

Run it **by absolute path**. The lane worktrees under `~/atc-pos-lanes/` each
carry their own older `deploy/prod-verify.mjs`, and the pre-`98e9f8f` copy
mangles the typed credential and then reports a bare `HTTP 400` with no field
name — which reads as "the admin password is wrong" for a password that works
in a browser. If a failing line does not name a field or an error code, you
are running the wrong copy.

```sh
node /home/atc-noc/atc-pos/deploy/prod-verify.mjs             # loopback 8110 — expect 12/12 PASS
BASE_URL=https://atcworkspace.com/pos node /home/atc-noc/atc-pos/deploy/prod-verify.mjs   # public mount — expect 12/12 PASS
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
  docker image tag pos-prod-backend:pre-phase2  pos-prod-backend:latest
  docker image tag pos-prod-frontend:pre-phase2 pos-prod-frontend:latest
  docker compose -f docker-compose.prod.yml up -d --no-deps --no-build backend frontend
  ```

  Those `:pre-phase2` tags were applied during the 2026-09-21 deploy (§7) and
  point at the last phase-1 images. Re-tag the *current* images before the next
  deploy or this block will roll back further than you intend.

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

## 7. Execution record — 2026-09-21

Released commit `0670e7e` on `phase2-backend`, working tree clean. Host nginx
was not touched: `/etc/nginx/sites-available/default` still carries its
2026-09-20 16:36 mtime and no reload was issued.

**Rollback anchors.** The phase-1 images were given durable tags *before* the
build, because `compose build` moves `:latest` and would otherwise leave them
untagged and prunable:

```sh
docker image tag 82334539af81 pos-prod-backend:pre-phase2   # 2026-09-20 17:53
docker image tag b3be108921da pos-prod-frontend:pre-phase2  # 2026-09-20 16:31
```

Do this on every future deploy. The §6 code-only rollback then reads
`pos-prod-backend:pre-phase2` instead of an image ID copied out of scrollback.

**Backup.** `/home/atc-noc/pos-prod-pre-phase2-20260921-0252.dump`, 21230
bytes, `pg_dump rc=0`, sha256 `9be4586eb5ec4ba7…` identical in the container
and on the host. TOC read back as CUSTOM format, 53 entries, 8 tables — all
phase-1, confirming the snapshot predates the migration. Restored with
`--exit-on-error` into two throwaway databases (both since dropped); counts
judged inside the snapshot: **PosUser 4, Company 1, Branch 2, License 1,
PosAuditLog 15, migrations finished 1, migrations unfinished 0.** That is the
restore point — anything recorded after 02:52 UTC on 2026-09-21 is not in it.

**Migration gate.** Live DB held one finished migration
(`20260920000000_pos_foundation`, no rollback marker); the built image carried
two. Delta was exactly `20260920180000_pos_phase2_orders`, and the backend log
shows exactly that one name applied, then the listen line. Gate the *image*
against the *database* like this — matching the image to git proves nothing
about what the database has already run.

**Timings.** Build 02:53:54→02:55:33 UTC (99 s). Deploy 02:56:11→02:56:24 UTC;
backend and frontend containers started 02:56:23.5 UTC. **Observed downtime
≈ 13 s**, and Postgres was never recreated (uptime unbroken since 2026-09-20
16:31), so no database restart was involved.

**Verification that passed.** `deploy/prod-verify.mjs` 8/8 credential-free on
loopback 8110 and on `https://atcworkspace.com/pos`, then **12/12 once the
owner supplied the admin password** (see below); `/pos/api/health` 200. Served
bundle moved `index-DgkiHruI.js` → `index-Blf2w4hP.js` and contains the
phase-2 marker, so this is not a cached phase-1 build. All 11 phase-2 tables
exist (19 total) and phase-1 row counts still match the snapshot exactly.
Route prefixes `/api/catalog`, `/api/tables`, `/api/orders`, `/api/reports`
answer 401 while an unmounted prefix answers 404. Sibling apps unaffected: `/`,
`/reviews/`, `/workspace/`, `/whatsapp/` all 200. Zero log records at level ≥ 50
since boot. A `find | sha256sum` over `/app/src` and `/app/prisma/migrations`
in the running container equals the same digest computed on the working tree.

**Redaction.** Checked with a *negative control* rather than by inspecting a
plain request: a probe carrying `Cookie: pos_session=FAKE-…` and
`Authorization: Bearer FAKE-…` plus a marker header `X-Probe` logged
`"authorization":"[REDACTED]"`, `"cookie":"[REDACTED]"`, zero occurrences of
the fake token — while `"x-probe"` was logged **with its value**. The marker is
what makes the result meaningful: it proves the logger does print arbitrary
header values, so `[REDACTED]` is redaction and not an absent field. `res`
remains exactly `{"statusCode":…,"contentLength":…}`.

**The four authenticated checks — CLOSED 2026-09-21.** They prompt for the prod
ATC-admin password, so the deploying agent could only reach 8/8 credential-free;
the owner ran them and `https://atcworkspace.com/pos` reports **12/12**, with
`logout revokes session` confirming server-side revocation.

Getting there took two fixes to the verifier itself, worth recording because the
symptom pointed at the wrong thing. It reported `HTTP 400` on sign-in for an
admin whose password worked in a browser. **`/api/auth/login` answers one
indistinct 401 for every credential failure; its only 400 is a payload the
schema rejected** — so that 400 was always the client, never the password.
`98e9f8f`: a fresh readline interface per prompt swallowed type-ahead, `.trim()`
stripped a password's outer spaces, and failures printed only a status code.
`f3a6aa9`: raw ESC/CSI bytes from a stray arrow key landed in the email field,
invisible when echoed, so the field looked untouched while failing validation.
Failures now name the API's own code, message and field — and nothing else.

**Still outstanding (needs the owner, does not block the release):**

1. §5 rotation was **not run, and the evidence says it is not needed**: all
   four prod accounts carry `PASSWORD_CHANGED` audit rows with `updatedAt`
   between 16:40:39 and 16:42:33 on go-live day, so they no longer hold the dev
   seed passwords that exist in git history. `pos.admin`'s later 20:48:34
   `updatedAt` corresponds to a `LOGIN_SUCCESS` (it moves `lastLoginAt`), not a
   password change. Re-run §5 only if you want fresh credentials for handover.
