# VEXO Connect v1.1 — release candidate RC-1

**RC-1 is ready for the production deployment owner's decision. It fixes two
Core defects in the till's money path, adds the VC-101 customer display, and
brings one new migration: a nullable column. That migration is proven safe to
roll back from.** Nothing here has been deployed; this document is the
handover to session `7565dff8`, which owns production (`DEPLOY-OWNER.md`).

| | |
|---|---|
| Deploy from | **commit `114ffc9`** (`114ffc9d592022132579d4264b87048f1778bfd8`) — an immutable sha. Historically branch `sprint/client-handover-rc` (lab `vexo-lab`, `~/atc-pos`); that branch has since diverged past RC-1 and **must not be checked out by name for this deploy** |
| Code final at | **`114ffc9`** — re-stamped 2026-09-23 from `a1e5228`; the one code change between them is a one-line day-close fix in `frontend/src/pages/DayClose.jsx`. Check with `git diff --name-only 114ffc9 <release-final>` — every path must be under `docs/`. |
| Base | `4a01c7e` — the v1.0.1 line; build inputs identical to deployed `55bf2dc` |
| Migrations | **13** (v1.0.1 has 12). New: `20260923160000_refund_method` |
| Feature freeze | ≈ 2026-09-25 14:00 UTC. RC-1 is the candidate at 2026-09-23 15:00 UTC. |
| Scope, owners, blockers | `docs/CLIENT-HANDOVER-SCOPE.md` |

## 1 · What is in it

| Commit | What | Owner |
|---|---|---|
| `20c6904` | fix(discounts): refuse a grant whose ceiling is zero on either side | Window 1 |
| `5f8ef01` | fix(day-close): record how a refund went back; only cash leaves the drawer — **migration 13** | Window 1 |
| `f44cc16` | test(e2e): isolated sale → discount → payment → refund → day close harness | Window 1 |
| `629461b` | merge(vc101): customer display — one `--no-ff` merge of `0a98c97`, `46b1940`, `ca0d983`, `3e9e4ec` | Window 3 |
| `1518d08` | test(e2e): customer display checked over HTTP from outside its own suite | Window 1 |
| `4faf36e` | fix(dev-verify): wait for the real database (tooling) | Window 1 |
| `ae98beb` | docs(display): two-display edge and RC verification (cherry-picked from `cc09efb`) | Window 3 |
| `a899f46` | test(release): rollback proof, v1.0.1 ⇄ RC | Window 1 |
| `a1e5228` | test(e2e): skip and report the display checks when VC-101 is not built in | Window 1 |
| `ce88a40`, `9274ebf` | docs: the owner guide's two by-design discount behaviours; `RELEASE-HANDOVER-CHECKLIST.md` go/no-go sheet (cherry-picked from `fb40fed`, `1d5407b`) | Window 3 |
| `1f0acc9` | docs: display browser gate closed on the 17/17, labelled where it ran (cherry-picked from `7501383`) | Window 3 |

### What changes for people using it

- **Refund dialog** gains *Returned as* (cash from the till / reversed on the
  card terminal / UPI / other). It is preselected when the bill was paid one
  way, and required with no default when the bill was split. The server
  refuses a split-bill refund that doesn't say how it went back.
- **Day close** takes only cash refunds off the expected drawer. Card and UPI
  refunds no longer make an honest count read "over".
- **Discount settings** refuse a permission whose ceiling is zero on either
  side (it would have refused every discount at the till).
- **Customer display** (new): staff open *Pair display* to show a 6-digit code;
  a second screen at `/display` enters it and mirrors the live bill.

### Build inputs that differ from deployed `55bf2dc` (16 files, +1104 / −12)

Backend: `prisma/schema.prisma`, `prisma/migrations/20260923160000_refund_method/`,
`src/api/routes/{discountPolicies,orders,reports}.js`, `src/lib/orders.js`,
`src/app.js` (+2: display mount), new `src/api/routes/display.js`,
`src/lib/displayState.js`, `src/middleware/displayAuth.js`.
Frontend: `src/pages/{Orders,Sell}.jsx`, `src/App.jsx`, new
`src/pages/{CustomerDisplay,PairDisplay}.jsx`, `src/lib/displayClient.js`.
Unchanged: both Dockerfiles, `nginx.conf`, `vite.config.js`, both lockfiles,
`docker-compose.prod.yml`. So there are no new dependencies and no new env
variables.

## 2 · Deploying it — the deltas over `docs/DEPLOY-PHASE2.md`

The procedure that shipped v1.0.1 applies unchanged. Only its inputs move.

**§0 — Preconditions, additionally:**
- The root disk is below 85%. It read 88% on 2026-09-23. The runbook's §1
  backup writes a full dump to the same disk, and this host has zeroed files
  mid-write on ENOSPC before.
- The owner approved RC-1, and decided whether VC-101 ships (to drop it, see §6).
- The owner confirmed who deploys it. `DEPLOY-OWNER.md` grants `7565dff8`
  the v1.0.1 post-deploy verification only; that grant does not by itself
  cover a v1.1 deploy.
- `.env` still holds `VITE_BASE_PATH=/pos/` and **no** `POS_GATEWAY_PROVIDER`.

**§1 — Rollback anchors and backup.** Tag the images running now **before**
building:

```sh
docker image tag pos-prod-backend:latest  pos-prod-backend:rollback-v101
docker image tag pos-prod-frontend:latest pos-prod-frontend:rollback-v101
```

Then take and verify the backup exactly as §1 (a)–(c) describes.

**§2 — Migration gate.** The expected delta is **exactly one** unapplied migration:
`20260923160000_refund_method`. Any other unapplied name → STOP.

What it does: `ALTER TABLE "Refund" ADD COLUMN "method" "PaymentMethod";` —
nullable, no default, no backfill. In PostgreSQL this is a catalog-only change
with no table rewrite.

**§3 — Build and up.** Unchanged commands. The backend log should show that one
migration applied, then the listen line.

**§4 — Verify.** Read-only; **no test money in production**.

```sh
# migrations: expect 13, latest 20260923160000_refund_method
docker exec pos-prod-postgres-1 psql -U atc_pos -d atc_pos -tAc \
  "select count(*) || ' / ' || max(migration_name) from _prisma_migrations where finished_at is not null"
# the column exists and every existing refund row is NULL (read as cash, as before)
docker exec pos-prod-postgres-1 psql -U atc_pos -d atc_pos -tAc \
  "select count(*) filter (where method is null) || ' null of ' || count(*) from \"Refund\""
# display route mounted — the pair must read 401 then 404. A 401 alone proves nothing:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8110/api/display/state          # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8110/api/display/no-such-route  # 404
# gateway still off
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8110/api/gateway/webhook        # 404
# bundle base path
curl -s http://127.0.0.1:8110/ | grep -o 'src="/pos/assets/index-[^"]*\.js"'
```

Then sign in through the browser and open an existing paid bill's refund
dialog. Confirm *Returned as* is present, then **cancel — do not submit**.

## 3 · Rolling back

**Code-only rollback to v1.0.1 is safe with migration 13 in place.** No
database rollback is needed or advisable:

```sh
docker image tag pos-prod-backend:rollback-v101  pos-prod-backend:latest
docker image tag pos-prod-frontend:rollback-v101 pos-prod-frontend:latest
docker compose -f docker-compose.prod.yml up -d --no-deps --no-build backend frontend
```

Proven on the lab by `deploy/rc-rollback-proof.mjs`, **8/8**. The v1.0.1 code,
booting with production's own command, meets the 13-migration database, prints
`No pending migrations to apply`, reads the RC's refund rows, and keeps taking
money and refunding. Its refunds land with `method` NULL. Rolling forward again
reads those as cash, which is the v1.0.1 rule, so no closing moves either way.

While rolled back, the day close uses v1.0.1's rule again: every manual refund
counts as cash. That is the defect this release fixes, not a new one.

The migration-13 column is harmless to old code under **any** gateway setting.
The one stranded-migration hazard from v1.0 (`GatewayWebhookEvent.source`,
`RELEASE-CORE-V1.0.md` §4.2) is unchanged by this release.

## 4 · Images built from RC-1 on the lab

Built with plain `docker build`, mirroring the `build:` stanzas of
`docker-compose.prod.yml`: same contexts and Dockerfiles, `VITE_BASE_PATH=/pos/`
as production's `.env` sets it. The images are tagged under a separate
`vexo-connect-rc/*` name so they cannot be mistaken for production's. The prod
compose file was not run.

| Image | ID | Size | Checked |
|---|---|---|---|
| `vexo-connect-rc/backend:rc1-a899f46` | `07cea1d0951b` | 613 MB | 13 migration dirs; latest `20260923160000_refund_method` |
| `vexo-connect-rc/frontend:rc1-a899f46` | `f5d605e1f351` | 74.3 MB | `index.html` → `src="/pos/assets/index-CgVCfGcR.js"` |

The frontend bundle hash matches the host build byte for byte:
`index-CgVCfGcR.js` came out of both the `node:20` image and Node 22 on the
host. The images were built at `a899f46`, which differs from `a1e5228` only in
`deploy/e2e-workflow.mjs` — not a build input — so they are the images of the
`a1e5228`-era RC-1. **Code-final has since been re-stamped to `114ffc9`, which
adds a one-line `frontend/src/pages/DayClose.jsx` fix — a frontend build
input — so these images predate the current pin and stand as buildability
evidence only.** Production builds its own images from the tree it deploys
(§3); these only prove that the tree builds.

## 5 · Acceptance matrix

Every row was executed; nothing is quoted from an earlier release. Lab rows ran
on `vexo-lab` against fresh databases on 2026-09-23.

| Gate | Result | How |
|---|---|---|
| Backend suite, all files | **384/384** (12 files) | `npm test` against `atc_pos_test` |
| — of which new this sprint | 3 Core + 13 VC-101 | `phase2.test.js` daily closing; `discountSettings.test.js`; `customerDisplay.test.js` |
| Frontend production build, `/pos/` base | **clean**, 1668 modules | `VITE_BASE_PATH=/pos/ npm run build` |
| End-to-end over HTTP, fresh DB | **52/52** | `bash deploy/e2e-isolated.sh` |
| · accounts | AUTH-1, AUTH-2 ✔ | |
| · sale and billing | SALE-1..3 ✔ | |
| · discount policy (owner-only, deny-default, zero-ceiling refusal, read-back) | POL-1..4, DISC-1 ✔ | |
| · discount at the till (ceiling, approval, wrong password, over-approver, stacking) | DISC-2..8 ✔ | |
| · payments (partial, replay, concurrent replay, key reuse, cash change) | PAY-1..6 ✔ | |
| · refunds (roles, split-bill refusal, tender inference, status) | REF-1..5 ✔ | |
| · branch isolation | ISO-1..9 ✔ | |
| · reports | REP-1, REP-2 ✔ | |
| · day close (cashier preview, cashier refused, cash sales, **expected = honest count**, zero variance) | DC-1..5 ✔ | |
| · customer display (independent of VC-101's own suite) | DSP-1..8 ✔ | |
| Rollback RC → v1.0.1 → RC | **8/8** | `deploy/rc-rollback-proof.mjs` |
| Production images build from RC-1 | **both built**; backend has 13 migrations, frontend base `/pos/` | `docker build`, lab (§4) |
| RC-1 with VC-101 dropped (§6 executed) | **371/371** suite, **43/43** end-to-end, display checks skipped and reported | worktree `~/atc-pos-drop`, branch `drop-vc101-proof` |
| VC-101 browser walkthrough (till + display, Chromium) | **8/8** — Window 3's run on the original box's dev stack, on display code **byte-identical to RC-1**: all 8 files sha256-match, and the other build-input differences are the Core fixes only. A lab-tunnel retry went 0/8 because of the lab's CORS origin pin (environment, not product). | `tests/e2e/walk-display.cjs`; screenshots on the original box |
| **VC-101 browser gate — CLOSED** | **17/17** (Run A 8/8 + Run B 9/9: quantity update, part payment without the thank-you screen, sign-out revocation), session `7565dff8`, on the **original box's dev stack** (:5350/:5351, 12 migrations). Source `1d5407b`, every exercised path byte-identical to RC-1. **Not run on the lab, and not run against a stack built from RC-1.** | package `lab-browser-evidence/` (read its `ERRATUM-WINDOW1.md`) |
| Never browser-driven | a stack built from RC-1 (migration 13); the lab host; the *Returned as* dialog and the cash-only day close (HTTP only); the discount line, void → idle, reconnect, and idle after a restart on the display | `CLIENT-HANDOVER-SCOPE.md`, verification tiers |
| Discount-policy test files, focused | **98/98** (discounts 50, discountSettings 31, discountConcurrency 5, approvalSecrecy 12) — Window 3's run | lab RC @ `5659243`, `atc_pos_test` |
| Physical receipt / KOT on paper | **PENDING** — 2026-09-24 | `docs/PRINTER-UAT-RUNBOOK.md` |
| Production §4 verification | **to be run by `7565dff8` at deploy** | §2 above |

Two observations recorded by the harness are **not** failures: the first-login
password change is enforced by the browser only (open finding F-3), and a
company-wide staff default also narrows the owner (by design, F-4). See
`docs/CLIENT-HANDOVER-SCOPE.md`.

## 6 · Dropping VC-101 before deploying

```sh
git revert --no-edit ae98beb        # its doc update first — it edits the merged doc
git revert --no-edit -m 1 629461b   # then the merge itself
```

Then re-run the suite and the end-to-end harness. **Executed on the lab**:
both reverts applied with no conflict; `display.js` is gone; `app.js`,
`App.jsx` and `Sell.jsx` are byte-identical to `4a01c7e`; both Core fixes are
still present; suite **371/371**; end-to-end **43/43**, with the display
checks skipped and reported as `OBS-4`. Core never depended on it: the merge touched `app.js` (+2),
`App.jsx` (+16) and one marked block in `Sell.jsx`, and nothing in the money
path.

## 7 · Open, and not this release's to close

**The production host's root disk is at 88%**, which Window 2 marks URGENT
at 3–8 days to full, with `lvextend` as the fix. A full disk stops the
database this release migrates, so clear it before deploying anything.
Physical print (Window 3, tomorrow). Off-host backup: a copy exists but is NOT
compliant (Window 2's `OPS-HANDOVER.md` §0 @ `9ff94ac`). The
first-login password gate (F-3, owner decision). Product Master Specification
v1.1 and the client data pack (owner). The demo-data A/B on production bills
00009 and 00011 (owner). Razorpay stays off.
