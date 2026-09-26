# Window 3 handoff — printing, peripherals, readiness evidence

Issued by Window 1 (integration coordinator, session `ed6ffece`), 2026-09-24.

## Base

**Agreed development base — CORRECTED (W1, 2026-09-24 ~11:58Z), historical
Phase-1 pin, not a live integration candidate:
`x/foundation` @ `baa2456`** (suite 479/479 owner-verified at the time; lane
tip was `6b2cdf5` + in-flight test-infra work — the foundation lane has
since moved on, confirm its current tip before branching). The `4f2a91c`
published earlier never existed — prior-session compaction error; the
Phase-1 bytes are pinned at `bddbe82` (`x/w2-frontend` snapshot) and
contained in `cfa22e9`. Nothing in Phase 1 changes
the print path (`buildReceipt`, Receipt print CSS) — your baseline for print
evidence remains the deployed v1.0.1 behaviour (KOT 1 page / receipt 1 page,
verified 8/8 on 2026-09-23; do NOT re-run the prod checks — permanent
evidence is orders BSC-CP/26-27/00013–15 VOID + PosAuditLog REPLAY rows).

## Constraints

- Use only atc-noc. The old `~/vexo-connect-x-tools/vcx` targets vexo-lab —
  prohibited.
- No production changes. Physical-printer acceptance remains NOT TESTED and
  must never be reported as passed from browser/PDF emulation
  (HANDOVER-UI-PRINT.md §3; spec §7.1 "no claim without verification").
- Terminal/Device registry is NEW in Phase 1 (`/api/terminals`,
  `/api/devices` — enrol/activate/revoke/audit). Your Store-Agent/print
  routing designs must key on Terminal + Device identities, not free-text
  printer names.

## Your assignment

1. Keep `frontend/docs/HARDWARE-CHECKLIST.md` the single acceptance gate;
   extend it with device-registry binding (which Device id was used per test).
2. Draft the Store Agent print-routing contract (document/category/station →
   printer destination, spec §7.1) as a design doc for Window 1 review —
   Phase 2 (VC-103) consumes it. No implementation into shared trees yet.
3. Readiness evidence ledger: track printer/cash-drawer/off-host-restore
   acceptance items with status UNTESTED/PASS/FAIL + hardware named.

Report via `WINDOW-3-REPORT.md` in your own working area; do not write into
the integration tree or the foundation lane.

## Phase-2 work order (added 2026-09-24, after Phase-1 exit gate PASSED)

Phase 1 is closed (see `docs/PHASE1-EXIT-EVIDENCE.md`). Your item 2 above
(Store Agent print-routing contract) is now on the critical path for
**VC-103 (KDS + Store Agent)** — deliver the design doc first. Then:

0. **Reprint marker contract — PUBLISHED 2026-09-24 (W1, foundation lane,
   uncommitted pending suite run).** `POST /api/orders/:id/print-events`
   now answers `200 { printEvent: { document, kotSeq?, copyNumber,
   reprint } }` (was `204`). Audit actions: first print of a document =
   `ORDER_PRINT_REQUESTED`; later prints = `RECEIPT_REPRINT` /
   `KOT_REPRINT`, all with `meta.copyNumber`; KOTs count per `kotSeq`.
   The marker is a DISPLAY aid from the routine audit table — it is not
   evidence of paper and concurrent clicks may share a copyNumber. Your
   print UI stamps DUPLICATE from `reprint: true`; the existing
   fire-and-forget caller in `Receipt.jsx` stays as-is until you design
   the stamp (window.print must stay inside the user gesture — see the
   comment there). Tests: `backend/tests/printEvents.test.js` rewritten
   to the new contract; NOT yet run (shell classifier-blocked) — treat as
   unverified until a `vcxl test` green is recorded.

1. **VC-103 KDS print/peripheral side** — extend the routing contract to
   kitchen stations (category→station mapping, reprint semantics, offline
   spool behaviour). Design doc only until Window 1 signs off.
2. **Readiness ledger** — add VC-101 customer-display hardware line items
   (secondary screen models to be tested) alongside printer/cash-drawer/
   off-host-restore rows; every row keyed to a Device id, status
   UNTESTED/PASS/FAIL.

## W1 review verdict — x/kitchen (2026-09-24 ~11:58Z, session 77a07c43)

**APPROVED — both primary items, no change requests. Merge accepted,
sequenced foundation-first.** Reviewed from the kitchen worktree bytes at
`c0173e2` (tree clean per the final2 artifacts, so file reads == commit
content; git itself is classifier-blocked in this session).

1. **Schema/DDL** (`20260924120000_kitchen_print_agent/migration.sql`, read
   in full): 7 enums + 7 tables as declared; FK targets confirmed
   Branch/Kot/OrderItem/KitchenStation only. Explicitly ACCEPTED from the
   integration side: plain (non-FK) `orderId`/`companyId`/`branchId`
   columns on print/kitchen rows; the RESTRICT-driven wipe-order contract
   (lane-table deletes before `branch.deleteMany()` — will be preserved as
   the wipe-UNION at merge); `PrintJob.reprintOfId` UNIQUE = single-step
   reprint chains (P2002 dedupe path verified in printing.js).
   `20260924170000_order_item_note` is a correct additive drift fix.
2. **orders.js touchpoint**: exactly one call — `routeKotItems(tx, …)` at
   orders.js:625, inside the existing KOT `$transaction`; KOT and ticket
   lines commit or roll back together. Dormancy proven (kitchen.js:63,
   zero ACTIVE stations → early return, no rows). Tenancy sound:
   `companyId` from `req.companyScope`, `branchId` from the company-scoped
   `loadOrder`; station/route lookups branch-scoped.
   `KitchenItem.orderItemId` UNIQUE blocks replayed routing duplicates.
3. Also read, no change requests: `agentAuth.js` (sha256-only storage,
   timingSafeEqual, enrol code cleared in the enrolling write) and
   `printing.js` (claim race hands the loser `[]`, not a copied lease;
   DISPATCHED + expired lease → UNCERTAIN, never auto-retried; enqueue and
   reprint idempotent on `branchId+idempotencyKey` with P2002 dedupe;
   agent endpoints scoped to `req.printAgent.id`).
4. Integration notes (mine to execute at merge): PrintAgent → Terminal/
   Device re-key per your INTEGRATION(foundation) marker; foundation
   `6b2cdf5` declares `transactionOptions { timeout: 15000, maxWait: 5000 }`
   and maps P2028/P2024 → 503 `POS_STORAGE_BUSY` — your per-line
   `nextChangeSeq` serialization inside the KOT tx composes with that
   budget, and an overrun degrades to a legible retryable 503. The
   per-line note writer gap goes to W2 as a contract addition.
5. Sequencing: the foundation lane has in-flight uncommitted test-infra
   work (advisory-lock run serialization; edits observed 11:42–11:52Z), so
   the merge waits for foundation to settle, then foundation → kitchen
   (`c0173e2`). Nothing further needed from you for the merge; your open
   items remain hardware-UAT prep and the Store Agent claim-loop client.
