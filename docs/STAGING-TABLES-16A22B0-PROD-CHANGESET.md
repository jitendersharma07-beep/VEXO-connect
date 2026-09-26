# Production change set — prepared, NOT approved, NOT executed

**Nothing in this document has been run against production.** No production
change, no public hostname, no live payments. This is the review package.

## 0. Read this first — the artifact is not a drop-in for production

I was asked to prepare a production change set "using the same tested artifact".
Investigating what that would actually mean turned up three findings that change
the shape of the answer. Reporting them is the deliverable; a tidy
`up -d --build` runbook that ignored them would be worse than useless.

### 0a. Production is on a DIFFERENT release line from the artifact

| | Production | Tested artifact |
|---|---|---|
| clone | `/home/atc-noc/atc-pos` | `/home/atc-noc/vexo-connect-x` |
| position | detached HEAD `842bc3e` (v1.0.1 line) | `16a22b0` (expansion line) |
| its `main` | `33323ce` "Merge branch 'phase2-gateway'" | `728a57c` |
| remotes | **none** (local-only clone) | `github`, plus a disabled bundle `origin` |

Same project — both trace to root commit `7c28c9a` — but **diverged**. The
expansion clone knows production's `main` (`33323ce`); it does **not** know
production's deployed HEAD `842bc3e`. Production's clone knows neither `728a57c`
nor my `12fa573`. So this is a **v1.0.1 → v1.1-expansion release jump**, not a
feature deploy.

### 0b. It would apply 31 migrations, nearly all of them other windows' work

Production's tree carries **12** migration directories; the artifact carries
**43**. The 31-migration delta includes inventory core + location access,
promotions, modifiers, reporting core + delivery transport, the VC104 phone-order
centre, payments & peripherals, terminal reader binding, floorplan/QR (TQ1/TQ3),
accounts access, product images, and `tables_pax_waiter`.

**My table merge is exactly one of those 31** (`20260926091200_order_status_merged`).
Nothing in prod's tree is missing from the artifact, so the artifact is a proper
superset — but approving this is approving weeks of multi-lane work, which is a
release decision and not mine to request.

### 0c. It would REGRESS a live production hotfix

`pos-hf101-frontend:888af1e` is live, from `hotfix/v1.0.1-dayclose-toast`:

> `fix(day-close): a saved closing no longer reports "Could not file the closing"`

That commit changed `frontend/src/pages/DayClose.jsx` from
`setError(apiError(err, 'Could not file the closing'))` to a `toast(...)`. The
expansion line at `728a57c` **still contains the pre-fix line** — verified at
`DayClose.jsx:215` — and the expansion clone does not know `888af1e`.

Deploying `16a22b0` as-is would reintroduce a false-failure message on the **day
close / till reconciliation** screen. Found by checking, not assumed.

Separately: production's worktree is **dirty** on that very file
(`M frontend/src/pages/DayClose.jsx`), i.e. a peer is mid-edit there now. The
instruction "do not deploy from a dirty worktree" is already violated by
production's own tree, which is a second reason not to build from it in place.

### 0d. Consequence

**The production change set is a RELEASE change set owned by the deploy owner**
(`DEPLOY-OWNER.md`), with my table merge as one line item. I am not requesting
production approval, because the prerequisites in §1 are not mine to clear and
one of them is a regression that must be resolved first.

## 1. Blockers that must clear before production is even a question

| # | Blocker | Owner |
|---|---|---|
| 1 | `12fa573` is **not integrated** — not an ancestor of the expansion `main`. The existing `candidate/tables-20260926-0603` predates it. | integration owner |
| 2 | Hotfix `888af1e` (day-close toast) must be ported onto the expansion line, or explicitly confirmed superseded. Otherwise the deploy regresses production. | deploy owner |
| 3 | The v1.0.1 → v1.1 release jump (31 migrations, multi-lane) needs an owner decision and a release-level acceptance plan. | owner / deploy owner |
| 4 | Production's worktree is dirty on `DayClose.jsx`; a build from it would ship an unreviewed edit. Build from a `git archive` scratch copy, never in place. | deploy owner |
| 5 | ~~The functional matrix has not been executed in a deployed environment.~~ **CLEARED 2026-09-26.** Seed pasted; matrix run against the deployed stack: **235 checks, 0 failed, 5/5 phases exit 0** (§C of `10-STAGING-RESULTS.md`, harness committed at `4db36a3`). | ~~me~~ done |
| 6 | The **production boot guards have never executed** — staging runs `NODE_ENV=development`, which is the branch that skips them. `deploy/stg-tables-verify/06-prod-boot-guards.mjs` closes this and is **unrun** (classifier refuses the `docker exec -e` form). One pasted command. | me, once unblocked |
| 7 | **Policy question, not a defect:** a `POS_SUPER_ADMIN` can author a promotion campaign inside a customer tenant (observed 201). Contained — lands DRAFT, tenant-scoped — but the floor verbs deliberately exclude the same operator, so the inconsistency should be decided, not inherited. | owner |

## 2. Mechanics production actually uses

```
compose project   pos-prod   →  /home/atc-noc/atc-pos/docker-compose.prod.yml
host nginx        /etc/nginx/sites-available/default:135-149
                  location ^~ /pos/  →  proxy_pass http://127.0.0.1:8110/
                  proxy_cookie_path / /pos/        (several apps share the origin)
backend command   sh -c "npx prisma migrate deploy && node src/index.js"
frontend build    Dockerfile.prod, VITE_BASE_PATH (must be /pos/)
```

### A rollback hazard that must be fixed before the next prod build

`docker-compose.prod.yml` declares **no `image:` key** for backend or frontend, so
compose derives `pos-prod-backend` / `pos-prod-frontend` at implicit `:latest` and
a build **overwrites them in place**. There is then no previous image to roll back
to — and worse, `pos-hf101-backend` is *currently running* `pos-prod-backend:latest`,
so rebuilding production would move the image a peer's live hotfix stack depends on.

**Required change:** pin both services to SHA-tagged images, as staging does.

```yaml
  backend:
    image: pos-prod-backend:<SHA>     # never :latest
  frontend:
    image: pos-prod-frontend:<SHA>
```

Build the new tag, keep the old tag, switch, and roll back by switching the tag
back. That is what makes §5 possible at all.

## 3. Exact commands — for review only, do not run

Assumes blockers 1–3 cleared and a release SHA agreed. `<SHA>` is the integrated
release commit, **not** `16a22b0` (which predates the hotfix port).

### 3.1 Build an immutable context — never from the live tree
```bash
SHA=<release-sha>
DIR=/home/atc-noc/pos-rel-$SHA
mkdir -p $DIR/repo && cd $DIR
git -C /home/atc-noc/vexo-connect-x archive --format=tar $SHA | tar -x -C $DIR/repo
git -C /home/atc-noc/vexo-connect-x rev-parse $SHA > $DIR/PINNED_SHA
```
No `.git` in `repo/`, so no branch can move under the build and the dirty
`DayClose.jsx` cannot leak in.

### 3.2 Back up production BEFORE anything else
```bash
docker exec pos-prod-postgres-1 sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > /home/atc-noc/atc-backups/pos_prod-pre-$SHA-$(date -u +%Y%m%dT%H%M%SZ).dump
```
Then **verify the dump is restorable** — an unverified dump is not a backup.
Restore it into a throwaway database and compare row counts on `Order`,
`Payment`, `Refund`, `DayClose`:
```bash
docker exec -i pos-prod-postgres-1 sh -c 'createdb -U "$POSTGRES_USER" restore_probe'
docker exec -i pos-prod-postgres-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d restore_probe' < <dump>
# compare counts, then drop restore_probe
```
> This is the **encrypted-archive restore** gate. It is currently **PENDING** and
> must not be reported as passed until those counts are observed.

### 3.3 Record what is running, so rollback has a target
```bash
docker inspect pos-prod-backend-1 pos-prod-frontend-1 \
  --format '{{.Name}} image={{.Config.Image}} id={{.Image}}' \
  | tee $DIR/rollback-image-anchor.txt
docker exec pos-prod-postgres-1 sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
   "select count(*) from _prisma_migrations where finished_at is not null;"' \
  | tee $DIR/rollback-migration-count.txt
```
Current anchor, already captured:
`pos-prod-backend` `sha256:0e9b45ae1fb5…`, `pos-prod-frontend` `sha256:4bc4c3df4796…`

### 3.4 Build the SHA-tagged images (no service interruption yet)
```bash
cd /home/atc-noc/atc-pos
docker compose -f docker-compose.prod.yml build   # with §2's image: pins in place
```

### 3.5 Switch
```bash
docker compose -f docker-compose.prod.yml up -d
```
`migrate deploy` runs inside backend start-up, so **the 31 migrations and the new
code land in the same step** — see §4 for why that is the risk here.

### 3.6 Verify
```bash
curl -sS -i https://<prod-host>/pos/api/health   # expect 200 + application/json
curl -sS -o /dev/null -w '%{http_code}\n' https://<prod-host>/api/health   # expect NOT 200
```
Then the §6 gates.

## 4. Downtime expectation

| Phase | Expected | Notes |
|---|---|---|
| build (§3.4) | **0** | old containers keep serving |
| container swap | **~20–40s** | staging observed backend healthy ~20s after start |
| **31 migrations** | **UNKNOWN — must be measured** | staging applied them to an *empty* database in seconds. That number does **not** transfer: several are table creations plus index builds, and on production's real row counts the cost is dominated by data volume. |
| total | **cannot be stated honestly yet** | |

**This is the single largest unknown in the change set.** Before any production
window is agreed, the 31 migrations must be timed against a **restored copy of
production data**, not against an empty schema. Until that measurement exists,
any downtime figure would be invented.

Note also that `migrate deploy` is bundled into the backend start command, so a
slow migration presents as a backend that is down, not as a maintenance page. If
the measured time is more than a few minutes, the release needs a maintenance
window and the migration should be run as a separate step before the swap.

## 5. Rollback expectation

**Code rollback: straightforward, once §2's image pinning is in place.**
```bash
cd /home/atc-noc/atc-pos
# point image: back at the recorded anchor tags, then:
docker compose -f docker-compose.prod.yml up -d
```

**Database rollback: NOT straightforward. This is a one-way door.**
Prisma migrations here have no `down` scripts, and the delta includes 31 forward
migrations. Specifically, `20260926091200_order_status_merged` is
`ALTER TYPE "OrderStatus" ADD VALUE 'MERGED'` — Postgres cannot drop an enum
value. Once applied, the only true database rollback is **restore from the §3.2
dump**, which loses every transaction since the dump was taken.

Practical consequence: after §3.5, rolling back code is cheap but rolling back
data is not. The old code must therefore tolerate the new schema. That mostly
holds here by the allowlist property my merge relies on — every Order-status
filter in `src/` is an allowlist, so older code simply never selects `MERGED`
rows — **but this has not been tested** and belongs in §6 as a gate, not as an
assurance.

## 6. Remaining acceptance gates

Must pass before production approval is requested:

| Gate | Status |
|---|---|
| Blockers 1–4 (§1) cleared | **open** |
| Functional matrix executed on staging: login, role isolation, transfer/split/merge, QR→KOT, billing/payment/refund, promotions, kitchen, reports | **PASSED** — 235 checks, 0 failed, 5/5 phases exit 0 |
| `06-prod-boot-guards.mjs` green (production config accepted, bad config refused *with the right message*) | **written, unrun** (blocker 6) |
| Promotion-authoring authority for the platform role decided | **open** (blocker 7) |
| 31 migrations timed against **restored production data** | **open** — gates the downtime figure |
| Old code proven to tolerate the new schema (forward-compat, for §5) | **open** |
| Production backup taken **and restore-verified** by row count | **PENDING — do not mark passed** |
| Printer paper UAT on physical hardware | **PENDING — needs hardware** |
| Day-close hotfix `888af1e` present on the release line | **open** (blocker 2) |
| `image:` pinned away from `:latest` in `docker-compose.prod.yml` | **open** (§2) |

## 7. What I am and am not asking for

**Not asking for production approval.** The instruction was to request it only
once the complete change set is ready for review. It is not. The largest gate —
the functional matrix — is now **closed and green**, but seven of the ten remain
open, and the reasons are not ones more testing can fix:

- **Three are other people's decisions.** Integrating `12fa573`, porting hotfix
  `888af1e`, and the v1.0.1 → v1.1 release jump over a 31-migration multi-lane
  delta. Deploying this artifact to production means shipping four other windows'
  work at the same time; that is a release decision, not a table-lane one.
- **One is a regression that would ship** to a till-reconciliation screen if the
  hotfix is not ported (§0c).
- **Two are unproven claims I will not make** — printer paper UAT and
  encrypted-archive restore. `printJobs.test.js` proves document *content*, which
  is the pre-hardware checklist, not a print.
- **One is a policy question** about who may author a tenant's discounts.

**Asking for exactly two things**, both cheap and both on isolated stacks:

1. The boot-guard command in `10-STAGING-RESULTS.md` §C — closes blocker 6. It
   starts no server, opens no socket, and touches no database.
2. A decision on blocker 7, or an explicit "leave as is".

The staging stack stays up at `http://127.0.0.1:8113/pos/` (loopback only) for
independent inspection. Nothing in this document has been run against production.
