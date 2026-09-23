# VEXO Connect v1.1 — release and handover checklist (go / no-go)

The single sign-off sheet for the 72-hour sprint. It **references** the
authoritative documents rather than repeating them:
`docs/CLIENT-HANDOVER-SCOPE.md` (scope, owners, blockers — owned by the Core
session) and `docs/RELEASE-V1.1-RC.md` (the deployment procedure). If this
sheet and either of those disagree, they win and this sheet is stale.

As of 2026-09-23. Feature freeze ≈ 2026-09-25 14:00 UTC — no new modules, no
code changes to verified areas; documentation only after the freeze.

## Three tiers of "verified" — never report a line above its tier

| Tier | Means | Holds today |
|---|---|---|
| **RC-verified** | Proven on the lab against the merged candidate, fresh databases | Every Included row below |
| **Deployed-verified** | Proven on production after the deployment owner deploys RC-1 | **Nothing.** Production runs v1.0.1. |
| **Hardware-verified** | Observed on physical devices — paper out of a real printer | **Nothing.** Printer PENDING until 2026-09-24. |

## The candidate

| | |
|---|---|
| Branch | `sprint/client-handover-rc` — lab `vexo-lab`, `~/atc-pos` |
| **Code-final** | **`a1e5228`** (`a1e5228ab4de23188e1b604fa484f45235bd5234`). Everything after it is `docs/` only — check with `git diff --name-only a1e5228 HEAD`. |
| Tip at time of writing | `5659243` (docs). The **release-final sha is stamped at the freeze**, after the last documentation commits land; it is not known yet and is not invented here. |
| Package for the deployment owner | `/home/atc-noc/pos-rc-v1.1-rc1-20260923/` — bundle, `RELEASE-V1.1-RC.md`, `CLIENT-HANDOVER-SCOPE.md`, README, `SHA256SUMS` (**re-verified OK 2026-09-23**) |
| Migrations | 13 (v1.0.1 has 12). New: `20260923160000_refund_method` — one nullable column, rollback proven 8/8 |

## Go / no-go

| # | Item | Tier reached | Status |
|---|---|---|---|
| 1 | Core flows — orders, billing, payments, retry-safety, refunds, reports, day close, isolation | RC-verified | ✅ suite 384/384; e2e 52/52 |
| 2 | **Discount policy** — see §Discount close-out | RC-verified | ✅ **CLOSED** |
| 3 | Core defects found this sprint: day-close cash refunds (`5f8ef01`), zero-ceiling grant (`20c6904`) | RC-verified | ✅ fixed, each moved a check FAIL → PASS |
| 4 | **VC-101 customer display** — see §VC-101 evidence | RC-verified (HTTP, lab) + browser-verified 17/17 on exercised-path-identical code (original box) | ✅ **INCLUDED, owner-accepted; browser evidence ACCEPTED by the owner** 2026-09-23 (atc-noc dev stack, not a lab run, not full RC browser acceptance); one display per counter |
| 5 | Physical receipt / KOT print | Browser-verified only | ⏳ **PENDING** — `docs/PRINTER-UAT-RUNBOOK.md`, 2026-09-24 |
| 6 | Off-host encrypted backup | One copy exists but is **not compliant** (Window 2's record @ `9ff94ac`) — see §Off-host backup | ⛔ **Not done** — re-send after the owner's new key; remediation stays with Window 2 and the owner |
| 7 | Client onboarding (menu, stores, staff) | — | ⛔ **Blocked** — client data pack not supplied (B2) |
| 8 | Reconcile against Product Master Specification v1.1 | — | ⛔ **Blocked** — document not held by anyone (B1) |
| 9 | RC-1 in production | — | ⏸ **Owner decision**, then the deployment owner (B3) |

**Release is GO at the RC tier** for rows 1–4. Rows 5–9 do not block the
candidate; they block specific claims — printing on paper, a backup that
survives the host, real client data, and anything on production.

## VC-101 evidence — with provenance

- **HTTP behaviour, RC-verified on the lab**: Window 1's harness, written
  outside the author's suite — DSP-1..8 and ISO-9 in 52/52 — plus the
  author's 13/13 inside 384/384.
- **Browser behaviour — pairing, cart updates, payment completion,
  sign-out: 8/8 in real Chromium**, two isolated browser contexts (till and
  display), `tests/e2e/walk-display.cjs`; screenshots d-01..d-09 in
  `~/vexo-connect-dev/.devlogs/vc101-shots/`. It ran on the **original-box
  dev stack, not on the lab**, and it tests **RC-1's VC-101 code exactly**:
  all eight VC-101 files (`display.js`, `displayAuth.js`, `displayState.js`,
  `CustomerDisplay.jsx`, `PairDisplay.jsx`, `displayClient.js`, `Sell.jsx`,
  `App.jsx`) are byte-identical (sha256) to the RC, and the only RC change
  to a file the display reads, `lib/orders.js`, is refund-only
  (`publicRefund.method` plus two new helpers) — fields the display
  allowlist never serves.
- **Why not on the lab**: attempted 2026-09-23 through an SSH tunnel and
  failed 0/8 — **not a product defect**. The lab backend's `CORS_ORIGIN` is
  pinned to exactly `http://localhost:5177`; Vite forwards the browser's
  Origin (`changeOrigin: false`), so a tunnel on any other local port is
  refused as CORS (a 500 in the lab log at `app.js:62`). Local port 5177 on
  the original box is held by another session's sandbox, and the lab has no
  browser tooling. Direct and proxied logins on the lab both answered 200.
  Getting a browser run *on the lab* needs either that port freed or the
  lab CORS widened — both outside this session's ownership during the freeze.
- **VC-101 browser evidence ACCEPTED by the owner (2026-09-23): 17/17 on the
  atc-noc isolated dev stack** (`~/vexo-connect-dev`, :5350/:5351, 12
  migrations), source `1d5407b`, exercised paths byte-identical to RC-1. It is
  **not a lab run and not full RC browser acceptance**; the untested display
  behaviours below stay listed as limitations. Run by session
  `7565dff8`: Run A at 15:36Z, `tests/e2e/walk-display.cjs` unmodified, 8/8;
  Run B at 15:38Z, `walk-display-qty-partial.cjs`, 9/9 — a quantity update
  re-priced on till and display, a part payment asks for the balance and does
  not thank the customer, settlement, sign-out revocation. **Environment: the
  original box `atc-noc` (20.20.20.55), isolated dev stack `~/vexo-connect-dev`
  — API 127.0.0.1:5350, Vite 127.0.0.1:5351, Postgres 5440 — not the lab,**
  whatever its evidence folder is called. **Source:
  `sprint/vc101-customer-display` @ `1d5407b`**, tree clean; its code is
  identical to `5ac675a` (every later commit is docs). Corroborated from
  machine records rather than the report: the runner scripts
  (`POS_E2E_BASE=http://127.0.0.1:5351`, sourcing `~/vexo-connect-dev/.env`);
  this box's backend log (HeadlessChrome, host `127.0.0.1:5351`, zero 5xx,
  logout 200 → display 401 within 4 s in both runs); and dev orders
  `BSC-CP/26-27/00002` (₹283.50) and `00003` (Cappuccino ×2, ₹378.00, paid
  ₹189.00 + ₹189.00). **Coverage of RC-1 `7faa9d6`:** every code path the 17
  steps executed is byte-identical to the RC. The display files, `Sell.jsx`
  and `App.jsx` match. Every RC change to `routes/orders.js` sits in the
  refunds route, the gateway-reconcile select or an import — none in the
  create, items, quantity, bill or payments handlers the runs used — and the
  `lib/orders.js` changes are refund-only. Evidence: package folder
  `vc101-browser-evidence-atc-noc-dev/` (renamed from `lab-browser-evidence/`,
  because the old name was itself a lab label; the report inside is unchanged
  and pinned in `SHA256SUMS`).
- **Still not verified in a browser** — these stay listed as limitations: (a) no browser has driven a stack *built from* RC-1, with migration 13
  applied and the RC's Prisma client (the tested tree has 12 migrations,
  RC-1 has 13); (b) nothing ran on the lab host itself (F-9: the lab accepts
  only `http://localhost:5177`); (c) RC-only screens — the refund dialog's
  "Returned as" and the cash-only day close — have HTTP evidence only
  (REF-*, DC-*), which is Core's gate; (d) display behaviour outside the
  gate's four areas is HTTP- or design-level only: a discount line on the
  display, void → idle, the "Reconnecting…" strip on network loss, and idle
  after a backend restart; (e) two displays on one station is out of scope
  (F-8).

**Deployment scope: ONE customer display per counter.** Two displays on one
station mirror the same bill, but only the first to poll after payment
shows the thank-you (F-8, documented; no data exposure).

**Drop path, if ever needed:** `git revert ae98beb`, then
`git revert -m 1 629461b` — executed on the lab, 371/371 and 43/43, Core untouched.

## Discount close-out — exact result

- **Author-side focused run on the lab RC** (tip `5659243`, migrations 13/13,
  `atc_pos_test`, coordinated with Window 1 so the shared test database was
  not truncated mid-run): **98/98** — `discounts` 50/50, `discountSettings`
  31/31 including the new zero-ceiling case, `discountConcurrency` 5/5,
  `approvalSecrecy` 12/12 (vitest 2.1.9, 15.2 s). These four files contain
  the changed code (`20c6904`); this was not a rerun of unchanged suites.
- **Window 1, after `20c6904`, at `a1e5228` on a fresh database**: POL-1..4,
  DISC-1..8, ISO-2 all green.
- **What `20c6904` enforces**: a discount permission (line/order) or an
  approval authority is refused **at save (HTTP 400)** when its resolved
  ceiling is zero on **either** side — percent or rupee. Before, only a
  both-zero grant was refused, so "allowed, up to 0%" and "10% or ₹0" saved
  with 200 and then denied every discount at the till. Resolution at the
  till is unchanged.
- **Open but not defects**: F-4, where a company default also narrows the
  owner (by design; now in `docs/QUICK-GUIDE.md`); and known limitation 9,
  where the approval-failure throttle is in-memory per process.
- **Verdict: discount-policy verification CLOSED at the RC tier.**

## Off-host backup — Window 2's status (read from its own record)

No live session reports as Window 2. This comes from its work product,
`~/vexo-connect-ops`, branch `ops/offhost-backup-readiness` @ `33ee8c2`,
`docs/OPS-HANDOVER.md` §4:

- Nightly dump: timer enabled and active, 02:30 IST, last run succeeded,
  14-day retention.
- **Off-host restore drill: VERIFIED 2026-09-23** on the real production
  dump — pg_restore exited 0, 23 tables and 586 rows match, the payment
  total matches to the paisa (₹4 467.52). Two negative controls prove it
  detects a broken dump and a falsified manifest.
- **Permanent encrypted off-host copy: NOT DONE.** The tooling passes 14/14
  with a *throwaway* key only. `offhost-backup.sh` exits 3 (MISSING INPUT)
  until the owner supplies a **GPG public key**. The candidate destination
  (the lab) is on the same /24, so it is not confirmed off-site.
- Not in RC-1 and not a build input.

**Current record — Window 2, `docs/OPS-HANDOVER.md` §0 @ `9ff94ac`.** It
supersedes the bullets above, which reflect `33ee8c2`:

- **Retained encrypted copy: EXISTS — NOT COMPLIANT.** One copy on vexo-lab,
  shipped 15:04:27Z by another backup session, intact (sha256 `52335566…`),
  but encrypted to key `…0F05CA51AEC13029`, whose **unprotected private half
  is on the POS host**. It is also stored under an unrestricted login, so it
  is not append-only. It must be re-sent after the owner supplies a new key.
- **Scheduling: prepared, NOT installed — on purpose** until a real success.
- **Restore: rehearsed 21/21 with throwaway keys, not done for real** — a
  real restore needs the owner's Mac key.
- **Off-site separation: UNCONFIRMED** (same /24), and the destination is
  not append-only yet (it needs a dedicated account).
- **Root disk: URGENT — owner** (§7 P1). Read on `atc-noc` 2026-09-23: 88% of
  98 GB used.

A report by session `7565dff8`
(`vc101-browser-evidence-atc-noc-dev/LAB-BROWSER-EVIDENCE.md` §5) calls that copy "DONE". Window 2's own record does not, and Window 2's
record governs. Status and remediation stay with Window 2 and the owner.

## Physical printer — Window 3's result

Window 3 is this session (ownership map in the scope document). **No result
yet**: the paper test is 2026-09-24 and every row of the run-book table
reads PENDING. It moves only when paper is observed. If it fails, printing
ships as "browser print, untested on paper", as v1.0.1 does.

## Deployment-owner handoff

**Deployment owner: session `7565dff8`.** Ownership passed from `896234f0`
(which deployed v1.0.1) for post-deploy verification, per `DEPLOY-OWNER.md`
@ `6000b6c`. That file scopes the grant to *v1.0.1 post-deploy
verification*, so **the owner should confirm that `7565dff8` also takes the
v1.1 deploy** before anyone acts on it. One deployment owner at a time; no
other session deploys.

Nothing in this sprint has deployed. When the owner approves RC-1, the
deployment owner:

1. Verifies the package: `cd /home/atc-noc/pos-rc-v1.1-rc1-20260923 && sha256sum -c SHA256SUMS`.
2. Confirms code-final: `git diff --name-only a1e5228 <release-final>` lists `docs/` only.
3. Follows `docs/RELEASE-V1.1-RC.md` §2 — tag `rollback-v101` images
   **before** building, take and verify the backup, and gate on **exactly one**
   unapplied migration (`20260923160000_refund_method`) — any other → STOP.
4. Keeps `.env` with `VITE_BASE_PATH=/pos/` and **no** `POS_GATEWAY_PROVIDER`
   (Razorpay stays off).
5. Decides VC-101 with the owner (owner-accepted; drop path above).
6. Records the result. Only then may any line move to **deployed-verified**.

**Not to be done by anyone in this sprint:** a production deploy without the
owner's go-ahead, enabling Razorpay, changing payment calculations, or
deleting demo financial records (bills 00009 and 00011 wait on the owner's
A/B choice, `docs/DEMO-DATA-CORRECTION.md`).
