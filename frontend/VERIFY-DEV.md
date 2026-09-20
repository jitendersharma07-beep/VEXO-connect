# Phase 2 frontend — dev verification log (W2)

Bash tool availability is intermittent in this session ("claude-fable-5 is
temporarily unavailable … cannot determine the safety of Bash"). Per the task
brief, every command needed for verification is recorded here in order; each is
retried whenever the tool comes back. Status per command is kept honest:
DONE (ran, output noted) / BLOCKED (tool refused) / PENDING (not attempted yet).

Working directory for all commands: `/home/atc-noc/atc-pos-lanes/frontend/frontend`
unless noted. Network targets only 127.0.0.1:5010 (backend) and :5177 (vite).

## 0. Static verification (done without Bash, 2026-09-20)

While the tool was down, the whole frontend was verified by reading files:

- Import chain read end-to-end (main.jsx → App.jsx → every page/component/lib);
  every imported symbol exists at its source; no unresolved module. Phase-1
  pages untouched and present.
- Cross-checked EVERY endpoint URL, query param and response field this UI
  uses against W1's actual backend (read-only): app.js mounts, orders.js
  (create/items/kot/kots/discount/bill/payments/refunds/void/list/receipt),
  lib/orders.js serializers (kotSeq, summary openedBy string, amountDue,
  discount object, receipt/taxBreakup/label), tables.js (currentOrder shape,
  capacity ≤ 99), catalog.js (product/variant/taxRate shapes, status filter),
  reports.js (role gate, from/to/branchId), middleware/auth.js
  (`x-pos-company` header for ATC scope). All match.
- Three client fixes came out of the sweep: reason min length 2 → 3 (server
  `reasonSchema` is `min(3)`) in ReasonModal + RefundModal; table capacity
  input capped at 99; ProductForm PATCH now sends `sku: null` / `taxRateId:
  null` when cleared (server `productUpdate` is `.nullish()` — previously
  "No tax"/empty SKU on edit silently kept the old value; create still omits,
  since `productCreate` is `.optional()` and refuses null).
- Full second-pass review (fresh eyes, post-compaction) of EVERY source file:
  Sell, Orders, CatalogAdmin, TablesAdmin, SalesReport, App, Layout, Receipt,
  ui, toast, pos, api, auth, AtcCompanyDetail. Field-level re-checks against
  W1's serializers: payment `receivedBy`/refund `by` are `{id,fullName}|null`;
  summary `openedBy` string vs detail object; `MANUAL_PAYMENT_LABEL` is a
  character-exact match to backend lib/orders.js. No further defects found.
- Port scan via `/proc/net/tcp[6]` reads (no Bash needed): backend :5010 NOT
  listening (down), dev DB :5439 up, :5177 free.
  This static pass does NOT replace the browser run below.

## 1. Install + static build check

| # | Command | Status | Notes |
|---|---------|--------|-------|
| 1 | `ls node_modules/.bin/vite` | DONE | `NO_NODE_MODULES` — install required (re-confirmed after compaction) |
| 2 | `npm install --no-audit --no-fund` | BLOCKED ×6 | retried across the whole session; classifier down for every NEW command shape (only the previously-approved `ls` probe runs) |
| 3 | `npx vite build` | PENDING | syntax/import check over the ~2.5k new lines |

## 2. Dev stack

| # | Command | Status | Notes |
|---|---------|--------|-------|
| 4 | `curl -s -m 3 http://127.0.0.1:5010/api/health` | BLOCKED | curl blocked, but `/proc/net/tcp`+`tcp6` read directly (no Bash): **no :5010 listener → backend DOWN**; dev DB :5439 IS listening; :5177 free. As of 2026-09-20 read. |
| 5 | (if down) `cd /home/atc-noc/atc-pos/backend && npm run dev` (RUN only, never edit; :5010) | PENDING | W1's tree — run, never modify |
| 6 | `npm run dev` (vite :5177) | PENDING | |

## 3. Browser verification (golden path)

All with dev logins from backend/prisma/seed.js (documented dev-only creds).

| # | Check | Status |
|---|-------|--------|
| 7 | Login as demo.cashier → lands on /sell | PENDING |
| 8 | Product tap creates order (server 201, totals rendered from response) | PENDING |
| 9 | DINE_IN on occupied table → 409 surfaced, table board reloads | PENDING |
| 10 | Send KOT → KOT modal, no prices on KOT | PENDING |
| 11 | Bill → invoiceNumber shown; payment modal | PENDING |
| 12 | CASH payment tendered > due → server changeDue displayed | PENDING |
| 13 | Over-payment CARD amount > due → 400 error.message surfaced | PENDING |
| 14 | Receipt shows `MANUAL PAYMENT RECORD — not gateway-verified` verbatim + DEMO banner | PENDING |
| 15 | Cashier: /reports blocked (route guard), void/refund hidden | PENDING |
| 16 | Manager: refund w/ reason → REFUNDED; void blocked while netCollected>0 | PENDING |
| 17 | Owner: /catalog CRUD, variant editor; /tables retire occupied → 409 | PENDING |
| 18 | ATC: company → Browse POS data → scoped /orders via x-pos-company | PENDING |
| 19 | Licence expiry banner + blocked writes (POS_LICENSE_*) | PENDING |

## 4. Git

| # | Command | Status |
|---|---------|--------|
| 20 | `git status --porcelain` on the worktree | BLOCKED first try |
| 21 | Commits on `phase2-frontend`, frontend files only, small+logical, no push | PENDING |

Nothing above is claimed as passing until its row says DONE with output.
