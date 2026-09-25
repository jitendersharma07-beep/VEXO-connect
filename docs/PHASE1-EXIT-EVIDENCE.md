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
  `4f2a91c` previously recorded here **never existed** — a compaction error
  in session `ed6ffece` invented it. At gate time (07:16Z) the tested bytes
  were UNCOMMITTED in the foundation worktree. They are preserved as
  **`bddbe82`** (`x/w2-frontend` read-only snapshot; fingerprint
  `769ada6f…` matched the live tree at 07:21Z) and are contained in
  `cfa22e9` (`x/foundation` 08:43Z, mixed with early VC-102 work); the
  foundation lane's verified state is `baa2456` (suite 479/479). Read
  `bddbe82` as the byte pin and `cfa22e9` as foundation-lane containment.

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

## Inherited requirements carried forward

- Migration rehearsals must be repeated for every future phase before its
  exit gate (same fresh + populated pattern, lane-private DBs only).
- Terminal/Device registry identities are the routing keys for all Phase-2+
  peripheral work (no free-text printer names).
