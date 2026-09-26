# Phase-1 exit gate evidence

Recorded by Window 1 (integration coordinator, session `ed6ffece`), 2026-09-24.
All executions below were owner-run in the owner's terminal (this session's
shell was classifier-blocked); results reported verbatim by the owner.

## Base

- Foundation work (on top of `38856d3`), ~50 files: migrations
  `20260924100000/100100/100200`, routes
  legal-entities/gst-registrations/brands/regions/terminals/devices/users/
  permissions, middleware, lib (identity/invoice/permissions/audit), tests,
  drafted frontend org pages.
- **SHA correction (W1 session `77a07c43`, 2026-09-24 ~11:58Z):** the
  `4f2a91c` recorded here and in the close-out below **never existed** — a
  compaction error in session `ed6ffece` invented it. At gate time (07:16Z)
  the tested bytes were UNCOMMITTED in the foundation worktree. They are
  preserved as **`bddbe82`** (`x/w2-frontend` read-only snapshot; fingerprint
  `769ada6f…` matched the live tree at 07:21Z) and are contained in
  `cfa22e9` (`x/foundation` 08:43Z, mixed with early VC-102 work); the
  foundation lane's verified state is `baa2456` (suite 479/479). Wherever
  `4f2a91c` appears below, read `bddbe82` (byte pin) / `cfa22e9`
  (foundation-lane containment).

## Exit-gate results (spec Phase-1 gate: "Migration rehearsal; cross-tenant/
store negatives; clean pinned base")

| Check | Result | Evidence |
|---|---|---|
| Backend suite (`vcxl test` vs `vcx_foundation_test`) | PASS | owner-run 2026-09-24, all green incl. cross-tenant/cross-store negative tests in foundation.test.js / foundationPeople.test.js |
| Shadow-DB schema diff (`vcxl migsql`) | CLEAN | output: `-- This is an empty migration.` — Prisma schema and migration chain agree |
| Fresh-install rehearsal (empty DB, full migrate) | PASS | all 16 migrations applied end-to-end |
| Populated-baseline rehearsal (v1.0-shaped data, then migrate) | PASS | backfill counts equal for Branch.publicId, InvoiceCounter.seriesPrefix, Payment.branchId — no row left unbackfilled |
| Clean pinned base | PASS (SHA corrected) | real pin = `bddbe82` (verified snapshot); the SHA published in the handoffs until 2026-09-24 ~11:58Z (`4f2a91c`) was wrong — see SHA correction above |

## Explicitly NOT covered

- Physical-printer acceptance: NOT TESTED (Window 3 ledger owns this;
  never claim from emulation).
- No production changes, pushes, or deployments were made.

## Phase-1 integration close-out (added 2026-09-24, W2+W3 evidence combined)

### Final candidate identity
- **Final candidate bytes: `bddbe82`** (`x/w2-frontend` snapshot; base
  `38856d3` = RC-1 code-final 114ffc9 + docs). No standalone Phase-1-only
  commit exists on `x/foundation` — see the SHA correction above.
- W2 preserved the tested bytes independently as commit
  `bddbe82c098a6c5b18c2931e6c3495217011b133` on `x/w2-frontend` (read-only
  snapshot import). Owner-run fingerprint check 07:21Z: live foundation tree
  == W2 pin (`769ada6fe555d579d0e19f440e9ef1f1`, sha256-of-sha256s over
  backend/src, backend/prisma, backend/tests, frontend/src, tests). Served
  bundle `index-HbJvuZ_P.js` (sha256 adb7647e70ae88e4…) verified referenced
  by the served page → browser evidence ties to these bytes.
- Note: Phase-2 (VC-102 promotions) work began in the same foundation
  worktree AFTER 07:21Z, so the live tree has since diverged; the Phase-1
  bytes remain addressable at `bddbe82` (and inside `cfa22e9`).

### Migration rehearsals (existing evidence, unchanged)
- Fresh DB: all 16 migrations onto empty `atc_pos_xfoundation_test` — PASS
  06:54Z; suite 414/414, 13 files (E1, .devlogs/PHASE1-EVIDENCE.md).
- Populated DB: clone of `atc_pos_rc1_20260923`, 13→16 — PASS; invariants
  byte-identical (52 orders, 35 payments ₹5876.70, 16 refunds ₹2014.70,
  invoice-set md5 1024eca0…, 0 orphans; publicId dup=0 null=0,
  seriesPrefix mismatches=0 proven against issued series) (E2).

### Browser acceptance — run identity preserved
- **Failed attempts (historical, do not count): 07:04–07:11Z** harness runs
  (FAIL-* shots a-02…c-09) — pre-fix stack; and the **07:14Z owner run
  failed** (`c-01-FAIL-reports_all_branches…` 07:14 shot; partial c-0x shots
  at 07:14 are from that aborted pass). Root causes fixed pre-07:16: seed.js
  Branch.publicId + CORS_ORIGIN (E3).
- **The accepted run is 07:13–07:16Z (backend pid 1250435, single run, no
  restarts): walk-owner 9/9, walk-cashier 19/19, walk-manager 11/11.**
  Zero-failure proof: final success shot of each walk exists at its
  UNSHIFTED number (FAIL shots shift the counter). 0 unexpected console
  errors, 0 5xx; expected 4xx only (pre-login 401s, deliberate over-payment
  400).

### Team / Permissions / forced-password-change browser coverage
- Verified by reading the harness: walk-owner (c-01…c-10) covers reports/
  catalog/tables/sell/ATC-scope only — **it never visits /team or
  /permissions and never exercises the forced first-login change**; the
  W2 handoff §5 "verified in walks" line overstates for those rows.
  Backend behaviour IS covered (foundationPeople.test.js 30/30, E1).
- Gap-closure walk written:
  `w2-frontend/tests/e2e/walk-team.cjs` (d-series shots): Team list,
  create member (temp password captured from the API response only — never
  printed, no screenshot while the reveal modal is on screen), Permissions
  page render, forced "Set a new password" modal on first login, change,
  temp password refused afterwards, new password lands on dashboard, walk
  account then DISABLED. Runner: `/tmp/walk-team-run.sh` (PASS/FAIL only).
- **Status: PENDING owner run** (this session's shell classifier-blocked).
  Result to be pasted below verbatim.

### Window 3 evidence (verified in ~/vexo-connect-dev reflogs)
- `w3/print-acceptance`: `b7b5ae5` "consolidate printer acceptance into one
  runbook; corrected dpi checklist + operator script; backup evidence
  reconciliation" then `3480796` "handoff to W1 with reprint audit finding
  and candidate identity". Docs-only, based on RC `7d11df1` — older than
  the candidate; integrate as a docs delta, no code impact.
- W3 product finding accepted into the ledger: **reprints are unaudited**
  (`orders.js` GET /:id/receipt and GET /:id/kots write no PosAuditLog row).
  Not a Phase-1 gate item (audit-trail gap, not a permission/tenancy gap);
  scheduled as Phase-2 backend work (RECEIPT_REPRINT / KOT_REPRINT audit
  actions + reprint marker contract for W3's print UI).

### Genuinely remaining acceptance items
1. Team/Permissions/forced-password browser walk — pending the owner-run
   command above (backend already green).
2. Physical printer UAT — NOT TESTED until paper is observed (W3 runbook;
   all 14 physical rows remain NOT TESTED).
3. Backup restore-from-ciphertext / key custody / destination — owner-gated
   (W3 BACKUP-EVIDENCE-RECONCILIATION.md), not a Phase-1 dev gate.
4. Reprint audit gap — accepted Phase-2 work item, not blocking Phase-1.

## Inherited requirements carried forward

- Migration rehearsals must be repeated for every future phase before its
  exit gate (same fresh + populated pattern, lane-private DBs only).
- Terminal/Device registry identities are the routing keys for all Phase-2+
  peripheral work (no free-text printer names).
