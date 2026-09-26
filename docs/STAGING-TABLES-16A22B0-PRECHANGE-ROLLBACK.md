# Pre-change capture and rollback — pos-stgtbl @ 16a22b0

Captured 2026-09-26, **before** anything was built or started.

## 1. The honest answer to "capture the existing environment first"

This environment **did not exist**. That is not an assumption; it was measured,
because "there was nothing to back up" is exactly the claim a careless deploy
makes right before it overwrites somebody's data.

| Thing | Expected | Observed |
|---|---|---|
| containers `pos-stgtbl*` | none | **0** |
| images `pos-stgtbl-*` | none | **0** |
| volume `pos_stgtbl_pgdata` | none | **0** |
| listeners on `127.0.0.1:8113` | none | **0** |

So: **no database backup was possible or required for this stack**, because there
is no prior database. The first `docker compose up` creates `pos_stgtbl_pgdata`
empty and `prisma migrate deploy` populates it from the committed chain.

This is the one case where "no backup taken" is a correct outcome rather than a
skipped step. Once this stack holds data, the rollback path in §4 applies and a
`pg_dump` becomes mandatory before any redeploy.

## 2. Source identity being deployed

```
commit 16a22b00157406eade8c5096daedda560f738eef   (tag stg/tables-16a22b0)
tree   7b2ab2e8e0f2288859a90c38e4cc70c394696ed0
       = main 728a57c + x/tables 12fa573
```

`./repo` is a `git archive` extraction of that tree — **not a checkout**. There is
no `.git` inside it, so no branch can move under the build and a dirty worktree
cannot leak in. Deploying a branch name was explicitly ruled out.

Verified before build: full suite **57 files / 1767 tests / 0 skipped / exit 0**;
43/43 migrations applied with `20260926091200_order_status_merged` checksum
`803b04e3…` matching disk; `migrate diff` empty (zero drift); frontend build
exit 0 (1711 modules).

## 3. Peer stacks that must be untouched

Four other POS stacks are live on this box and belong to other windows. Recorded
here so non-interference is **provable** afterwards, not merely claimed:

| Container | Image | Port |
|---|---|---|
| pos-prod-backend-1 | pos-prod-backend | 5000/tcp |
| pos-prod-frontend-1 | pos-prod-frontend | 127.0.0.1:8110 |
| pos-prod-postgres-1 | postgres:16-alpine | internal |
| pos-staging-backend | pos-staging-backend:114ffc9 | 5000/tcp |
| pos-staging-edge | nginx:1.27-alpine | 127.0.0.1:8111 |
| pos-staging-frontend | pos-staging-frontend:114ffc9 | 80/tcp |
| pos-hf101-backend | pos-prod-backend:latest | 5000/tcp |
| pos-hf101-edge | nginx:1.27-alpine | 127.0.0.1:8112 |
| pos-hf101-frontend | pos-hf101-frontend:888af1e | 80/tcp |
| pos-stgw5-backend | pos-stgw5-backend:prov1-2465725 | 5000/tcp |
| pos-stgw5-frontend | pos-stgw5-frontend:prov1-2465725 | 127.0.0.1:8210 |

Every name this stack derives is disjoint from all of the above: project
`pos-stgtbl`, containers `pos-stgtbl-*`, images `pos-stgtbl-*:16a22b0`, volume
`pos_stgtbl_pgdata`, port `127.0.0.1:8113`. In particular the image tag cannot
overwrite a `pos-prod:*` rollback anchor — note `pos-hf101-backend` is running
`pos-prod-backend:latest`, so a careless `:latest` tag here would have been
capable of moving the image a peer's hotfix stack depends on.

Disk before build: 88G free on `/`, 5.1GB reclaimable images. Headroom is not a
concern, but it is recorded because a full disk on this box kills shells.

## 4. Rollback procedure

Because this stack is new and self-contained, rollback is **removal**, and it
cannot affect production or any peer stack.

### 4a. Stop, keep the data
```bash
docker compose -f /home/atc-noc/pos-stg-tables-16a22b0/docker-compose.staging.yml down
```
Containers and the network go; `pos_stgtbl_pgdata` and both images survive.
Re-running `up -d` returns to the same state.

### 4b. Full teardown, including the database
```bash
# Back up first if the stack holds anything worth keeping:
docker exec pos-stgtbl-postgres pg_dump -U pos_stgtbl -d pos_stgtbl \
  > /home/atc-noc/pos-stg-tables-16a22b0/backups/pos_stgtbl-$(date -u +%Y%m%dT%H%M%SZ).sql

docker compose -f /home/atc-noc/pos-stg-tables-16a22b0/docker-compose.staging.yml down -v
```
`-v` removes `pos_stgtbl_pgdata` only — it is scoped to this compose project, so
it cannot reach `pos_staging_pgdata`, `pos_prod_pgdata` or any peer volume.

> `docker volume rm` is deny-listed on this box and is **not** needed here;
> `compose down -v` is the correct and permitted form.

### 4c. Remove the images too
```bash
docker image rm pos-stgtbl-backend:16a22b0 pos-stgtbl-frontend:16a22b0
```
Safe by construction: these tags are unique to this stack and no other container
references them (verified in §3).

### 4d. Redeploy the same artifact
Nothing needs rebuilding from git — the tag pins the commit and `./repo` is
immutable. `docker compose ... up -d --build` reproduces byte-identical images
from the same context.

## 5. What this environment deliberately cannot do

- **No live payments.** Not a flag: there is no `RAZORPAY_*` variable anywhere in
  `backend/src`; gateway credentials are per-tenant DB rows and this volume starts
  empty. On top of that `gateway/accounts.js:137` refuses a `LIVE`-mode gateway
  account whenever `NODE_ENV !== 'production'`.
- **No outbound mail.** `SMTP_HOST` unset, so the transport is off; and
  `mailer.js:67` enforces `MAIL_ALLOWED_RECIPIENTS=nobody@invalid.test` outside
  production as a second rail.
- **No public hostname.** The edge publishes on `127.0.0.1:8113` only. Reachable
  from this box, or through an SSH tunnel; nothing is bound to a public interface.
- **No production contact.** Separate project, images, volume, database and port.

## 6. Still pending, and not claimed as passed

- **Printer paper UAT** — needs physical hardware. `printJobs.test.js` (26 tests)
  proves the document *content*, which is the pre-hardware checklist, not the
  print.
- **Encrypted-archive restore** — not yet exercised against this stack.
