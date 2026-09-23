# VEXO Connect — client handover scope (sprint v1.1)

**The release candidate is RC-1 on `sprint/client-handover-rc` (lab `vexo-lab`,
`~/atc-pos`), built on the deployed v1.0.1 line. Every Core flow in scope is
proven end to end on it. Two Core defects were found and fixed, and the
customer display (VC-101) is integrated. What still blocks the handover is
input only the owner can give, not code.**

| | |
|---|---|
| As of | 2026-09-23, 15:00 UTC |
| Sprint window | brief received ≈ 2026-09-23 14:00 UTC → **feature freeze ≈ 2026-09-25 14:00 UTC** (T+48 h) → handover ≈ 2026-09-26 14:00 UTC (T+72 h) |
| Candidate | `sprint/client-handover-rc` — head and full commit list in `docs/RELEASE-V1.1-RC.md` |
| Base | `4a01c7e` = the v1.0.1 line; build inputs identical to deployed `55bf2dc` |
| Production deployment owner | session `7565dff8` (`DEPLOY-OWNER.md`). Nothing in this sprint deploys. |
| Maintained by | Window 1 — Core correctness and integration |

## Blockers — owner action needed

| # | Blocker | What it blocks | Who can clear it |
|---|---|---|---|
| B1 | **Product Master Specification v1.1 is not held by anyone.** It was searched for across both machines, the handover package, every session transcript, artifacts and docs. Window 3 confirms the same. | Reconciling this scope against the spec. Every "Included" row below is included **on code evidence**, not on a spec line. | Owner: supply the document. |
| B2 | **No client data pack**: menu, store details, staff list, GST treatment, licence terms. | Real onboarding. Every row of `docs/CLIENT-ONBOARDING-CHECKLIST.md` is BLOCKED, and demo output is labelled DEMO. | Owner / client |
| B3 | **The RC-1 deployment decision.** RC-1 adds migration 13 (`20260923160000_refund_method`, one nullable column). | Anything reaching production. | Owner, then the deployment owner `7565dff8` |
| B4 | **No off-host backup yet.** The tooling is ready and drilled 8/8 on the ops branch `ops/offhost-backup-readiness`. | A backup that survives losing the host. | Owner: the GPG **public** key |
| B5 | **Physical print test** is scheduled for 2026-09-24. | Moving printing from Conditional to Included. | Window 3, with a printer |

## Who owns what

| Area | Owner | Where |
|---|---|---|
| Core correctness, integration, release candidate, this file | Window 1 (this session) | lab `vexo-lab` — `~/atc-pos`, branch `sprint/client-handover-rc` |
| VC-101 customer display, printer run-book, onboarding checklist, quick guide | Window 3 — session "vexo-connect-dev connectivity setup" | original box — `~/vexo-connect-dev`, branch `sprint/vc101-customer-display` |
| Production deploy | session `7565dff8` | original box |
| Off-host backup | ops session | original box — `~/vexo-connect-ops`, branch `ops/offhost-backup-readiness` |
| Decisions: spec, client data, GPG key, demo-data A/B, Razorpay | Owner | — |

One owner per file for the sprint: Window 3 owns `backend/src/app.js`,
`frontend/src/App.jsx` and its new display files. Window 1 owns everything else
in Core, including `frontend/src/pages/Sell.jsx`. Window 3's single marked block
in `Sell.jsx` was integrated by Window 1, as agreed.

## Included — in RC-1, with evidence

Check IDs refer to `deploy/e2e-workflow.mjs`: 52 checks over HTTP against a
fresh database, **52/52 on RC-1**. "Suite" is the backend vitest suite:
**384/384 on RC-1**.

| Feature | Owner | Evidence |
|---|---|---|
| Orders: dine-in and takeaway, table map, KOT, void with reason | Core | suite; SALE-1..3 |
| Billing with per-branch, per-financial-year invoice numbers | Core | suite; SALE-2 |
| Manual payments (cash, card, UPI, other), partial and multiple payments per bill | Core | suite; PAY-1, PAY-6 |
| Payment retry cannot collect twice — sequential and concurrent; a reused key with a different amount is refused | Core | PAY-2..5; v1.0.1 evidence 9/9 |
| **Owner-controlled discount permissions**: deny by default, company → branch → staff, owner-only settings, one zero ceiling refused at save | Core | POL-1..4, DISC-1; **fix `20c6904`** |
| Discount ceilings measured on line + order discounts **together** | Core | DISC-2, DISC-7, DISC-8 |
| Above-ceiling approval with the approver's own password, within their own limit, branch-scoped, audited | Core | DISC-3..6, ISO-2 |
| **Cashier restrictions**: no refund, no void, no policy change, no sales report, no day-close commit | Core | REF-1, POL-1, REP-1, DC-2; void is manager-and-up in code |
| **Branch isolation**: bills, payments, receipts, lists, approvals, reports, day close, display | Core | ISO-1..9 |
| Refunds: manager-and-up, capped, reason required, **tender recorded** | Core | REF-1..5; **fix `5f8ef01`** |
| Sales and activity reports | Core | suite; REP-1, REP-2 |
| **Day close** — expected cash counts only cash that left the drawer; an honest count closes at zero | Core | DC-1..5; **fix `5f8ef01`**; rollback RB-1..8 |
| **VC-101 customer display** — pairing, live bill mirror, amount due, thank-you, sign-out ends it | Window 3 | W3 suite 13/13; W3 Chromium walkthrough 8/8; DSP-1..8 and ISO-9 run independently by Window 1 |
| Licensing, session revocation, server-side tenant scope, log redaction | Core | shipped v1.0.1; suite |
| Navigation below 768 px | Core | shipped v1.0.1, measured 33/33 |
| Quick guide and onboarding checklist (DEMO-labelled) | Window 3 | `docs/QUICK-GUIDE.md`, `docs/CLIENT-ONBOARDING-CHECKLIST.md` |

## Conditional — in only if the condition holds

| Item | Condition | Owner | If the condition fails |
|---|---|---|---|
| Physical receipt and KOT printing | All 7 rows of `docs/PRINTER-UAT-RUNBOOK.md` pass on paper | Window 3 | Ship as "browser print, untested on paper", as v1.0.1 does |
| RC-1 in production | Owner approves. The deployment owner runs backup, the migration gate (exactly one new migration) and verification per `docs/RELEASE-V1.1-RC.md`. | `7565dff8` | Production stays on v1.0.1; nothing is lost |
| VC-101 in the release | Still green at the freeze | Window 3 | Drop it: `git revert ae98beb`, then `git revert -m 1 629461b`, then re-run the suite. Core is untouched. |
| Real client onboarding | B2 cleared | Owner, then Window 3's checklist | Hand over on DEMO data, labelled as such |
| Off-host backup | B4 cleared | ops session | Backups stay on one disk (see `PENDING.md` §2) |
| Demo-data correction for production bills 00009 and 00011 | Owner picks A or B (`docs/DEMO-DATA-CORRECTION.md`) | Owner | Unchanged. Note: after RC-1, option B's two card refunds would be recorded as CARD and would no longer distort that day's cash. |

## Deferred — not in this handover

| Item | Why |
|---|---|
| The other Expansion drafts (GST registration and store identity, terminals and devices, the phase C orders list, phase D delivery, phase E notifications) | Only VC-101 was resumed. The 30 draft files stay preserved and untouched, and nothing was bulk-imported. |
| Razorpay and online payments | Disabled by decision; stays disabled |
| Delivery orders | Not in Core: `OrderType` is `DINE_IN \| TAKEAWAY`. **The v1.0 release-notes draft (§6) says "delivery orders" — correct that before any client-facing notes.** |
| ESC/POS, cash-drawer kick, per-job printer routing | Not implemented by design (`docs/HANDOVER-UI-PRINT.md` §3) |
| Multi-GST, inventory, recipe/BOM, purchase/GRN, KDS, loyalty/CRM, aggregators, central kitchen | Out of Core by design |
| Manual refund idempotency key | Known limitation 14; a retried manual refund relies on the operator |
| CSP, header allowlist logging, a shared approval throttle | Known limitations 6, 8, 9 |
| The `vexo-connect-core-v1.0` tag | Deliberately not created, on standing instruction |

## Findings this sprint

| ID | Finding | Status |
|---|---|---|
| F-1 | Day close subtracted **every** manual refund from expected cash. Refunding a card bill made an honest count read "over" by the refund: a ₹147.00 card refund turned an expected ₹179.82 into ₹32.82. | **Fixed `5f8ef01`**: `Refund.method`, migration 13. DC-4 and DC-5 went from FAIL to PASS. Rollback proven 8/8. |
| F-2 | An owner could save "allowed, max 0%" (or "10% or ₹0"), and that grant then refused every discount at the till. The save-time guard caught only the both-zero case. | **Fixed `20c6904`**. POL-3 went from FAIL to PASS. |
| F-3 | The first-login password change is enforced by the browser only. With a temporary password, the API accepts work (`POST /orders` → 201). | **Open — owner decision.** The fix is a gate in `requirePosAuth` that allows only `/auth/*` until the password is changed. It touches every route, so it needs its own test pass. Not done inside this freeze without a go-ahead. |
| F-4 | A company-wide staff default also narrows the owner at the till: the owner reads "10%" and self-approves above it with their own password. | By design (`discountPolicy.js`: "Narrowable"). Belongs in the owner guide; no code change. |
| F-5 | The handover said the discount cap (§6.1) and mobile navigation (§6.12) were pending. Both shipped in v1.0.1. | Corrected here. The stale text lives in `docs/HANDOVER.md`. |
| F-6 | The release-notes draft claims delivery orders. | Doc correction needed; see Deferred. |
| F-7 | `deploy/dev-verify.sh` false-failed on a brand-new database volume. | **Fixed `4faf36e`** (tooling, not a build input) |
| F-8 | VC-101: with two displays paired to one station, only the first shows the thank-you screen. | Accepted limit, documented in `docs/VC101-CUSTOMER-DISPLAY.md` |

## Evidence index

| What | Where | Result on RC-1 |
|---|---|---|
| Backend suite | `cd backend && npm test` (DB name must end in `_test`) | 384/384, 12 files |
| End-to-end workflow and display | `bash deploy/e2e-isolated.sh` (lab only; creates a throwaway DB) | 52/52 |
| Rollback to v1.0.1 and forward | `V101_DIR=… node deploy/rc-rollback-proof.mjs` | 8/8 |
| Frontend production build | `VITE_BASE_PATH=/pos/ npm run build` | clean, 1668 modules |
| Production images | `docs/RELEASE-V1.1-RC.md` §4 | both build; 13 migrations in the backend image; frontend base `/pos/` |
| Dropping VC-101 | `docs/RELEASE-V1.1-RC.md` §6, executed | 371/371 and 43/43, display checks skipped and reported |
| VC-101 browser walkthrough | Window 3, `tests/e2e/walk-display.cjs`; screenshots `~/vexo-connect-dev/.devlogs/vc101-shots/` on the original box | 8/8 (Window 3's run) |
| Printer on paper | `docs/PRINTER-UAT-RUNBOOK.md` | PENDING — 2026-09-24 |
