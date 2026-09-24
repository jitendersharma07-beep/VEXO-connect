# Window 2 handoff — frontend (Phase 1 foundation)

Issued by Window 1 (integration coordinator, session `ed6ffece`), 2026-09-24.

## Agreed development base — READ THIS FIRST

- **Agreed development base: `x/foundation` @ `4f2a91c`** (Phase-1 foundation
  work, committed 2026-09-24 on top of `38856d3`). Branch your work off this
  SHA; hand back as a branch, never a patch.
- `EVIDENCE-STALE-DOC-LINES.md` and `frontend/dist` in the foundation lane are
  deliberately NOT in the commit (handoff note + build output).

## Status

Backend suite PASSED 2026-09-24 (owner-run `vcxl test` against
`vcx_foundation_test`). Migration rehearsals COMPLETE 2026-09-24 (owner-run):
- Shadow-DB diff (`vcxl migsql`): clean — "-- This is an empty migration."
- Fresh-install rehearsal: passed (all 16 migrations applied to an empty DB).
- Populated-baseline rehearsal: passed — backfill counts all equal
  (Branch.publicId, InvoiceCounter.seriesPrefix, Payment.branchId).

**Phase-1 exit gate: PASSED.** Base `x/foundation` @ `4f2a91c` is confirmed.

## Dev stack (isolated, local — never the lab, never prod)

- Runner: `bash ~/vcx-foundation-local/vcxl {setup|test|migrate|seed|up|down|status}`
- The OLD `~/vexo-connect-x-tools/vcx` rsyncs to vexo-lab (20.20.20.57) —
  **prohibited, do not run it.**
- DBs: `vcx_foundation`, `vcx_foundation_test` on `vexo-connect-dev-db`
  (loopback 127.0.0.1:5440) only. Nothing touches `atc_pos*` or prod.
- API: `http://127.0.0.1:5521` · Vite dev: `http://127.0.0.1:5621`
  (bind 127.0.0.1 only — owner rule on this public-IP box).

## Phase-1 API surface (mounted under `/api`, app.js:133–139)

All routes require the `pos_session` cookie, are tenant-scoped server-side
(client-supplied companyId ignored), and enforce role + store scope via
`requireAction` / `scopedBranchIdWhere`. Cross-tenant reads 404.

| Mount | Endpoints |
|---|---|
| `/api/legal-entities` | GET list · POST create · PATCH :id |
| `/api/gst-registrations` | GET list · POST create · PATCH :id |
| `/api/brands` | GET · POST · PATCH :id · PUT store links |
| `/api/regions` | GET · POST · PATCH :id |
| `/api/terminals` | GET · POST · PATCH :id |
| `/api/devices` | GET list · POST enrol · GET :id · POST activate · POST revoke · PATCH :id |
| `/api/users` | GET list · POST create (sets mustChangePassword) · PATCH :id · PATCH :id/password-reset · POST :id/… (see users.js:353) |
| `/api/permissions` | GET catalog/effective/rules · PUT rule · DELETE rule · GET/PUT assignments · GET/POST support grants · POST grant revoke |

New roles (enum, migration `20260924100000`): COMPANY_ADMIN … AUDITOR (9
added). Permission resolution: USER > BRANCH > COMPANY; COMPANY-level DENY is
hard. Support grants require expiry; revocation is immediate and audited.

## Frontend work already drafted in the foundation lane (uncommitted)

Pages: Organisation, Team, Permissions, Branches, Brands, Regions, Devices +
Layout/App/roles/permissions lib changes. These are drafts from the prior
session — after the base commit lands, Window 2 owns reviewing/finishing them.
Do not start parallel copies; diff against the lane versions.

## Your assignment (after base SHA is published here)

1. Review/finish the drafted org pages against the API table above.
2. First-login flow: mustChangePassword UX end-to-end.
3. Verify built bundle with `VITE_BASE_PATH=/pos/` rules (trailing slash!) —
   see docs/PHASE2-CONTRACT.md conventions.
4. Hand back as a branch off the published base, never a patch.

Report to Window 1 via a `WINDOW-2-REPORT.md` in your own lane; do not write
into the integration tree or the foundation lane.

## Phase-2 work order (added 2026-09-24, after Phase-1 exit gate PASSED)

Phase 1 is closed (see `docs/PHASE1-EXIT-EVIDENCE.md`). After finishing the
Phase-1 frontend items above, pick up in this order:

1. **VC-101 Customer display (frontend surface)** — secondary-screen order
   view (line items, totals, GST breakup) driven by the till's live cart.
   Key it on Terminal identity (`/api/terminals`), not window naming. Draft
   the till↔display transport proposal for Window 1 review before wiring it.
2. **VC-102 Promotions (admin + till UI)** — promotion setup pages and till
   application UX. Backend endpoints come from Window 1; do not stub your own
   API shapes — request the contract via WINDOW-2-REPORT.md when you reach it.

Same rules: branch off the published base (or its successor SHA once Window 1
publishes one), hand back branches, loopback-only dev servers.
