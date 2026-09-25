# Window 3 handoff — printing, peripherals, readiness evidence

Issued by Window 1 (integration coordinator, session `ed6ffece`), 2026-09-24.

## Base

**Agreed development base — CORRECTED (W1, 2026-09-24 ~11:58Z):
`x/foundation` @ `baa2456`** (suite 479/479 owner-verified; lane tip
`6b2cdf5` + in-flight test-infra work). The `4f2a91c` published earlier
never existed — prior-session compaction error; the Phase-1 bytes are
pinned at `bddbe82` (`x/w2-frontend` snapshot) and contained in `cfa22e9`.

Nothing in Phase 1 changes
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

1. **VC-103 KDS print/peripheral side** — extend the routing contract to
   kitchen stations (category→station mapping, reprint semantics, offline
   spool behaviour). Design doc only until Window 1 signs off.
2. **Readiness ledger** — add VC-101 customer-display hardware line items
   (secondary screen models to be tested) alongside printer/cash-drawer/
   off-host-restore rows; every row keyed to a Device id, status
   UNTESTED/PASS/FAIL.
