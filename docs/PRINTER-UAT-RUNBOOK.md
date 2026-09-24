# Physical receipt / KOT print — UAT run-book (2026-09-24)

**Status: PENDING — physical results stay pending until paper is observed.**
Nothing in this document claims a printer works. It exists so the session
with the real printer is a checklist, not an improvisation.

**This is the single procedure AND results record for printer acceptance.**
Consolidated 2026-09-24 by Window 3 (printing / peripherals / operational
acceptance). Do not fill results into any other sheet.

## Register of the other printer documents — read before trusting any of them

| Document | Status |
|---|---|
| `frontend/docs/HARDWARE-CHECKLIST.md` | **Capability authority + per-site sign-off form.** Use the **corrected 2026-09-24 revision** (hw-prep lane `15c27b9`, three-group A/B/C capability tables + the dpi table below). The pre-correction copy asserts "576 dots @ 203 dpi ← what this build targets", which makes a healthy TM-T88 (180 dpi, 42 chars Font A) read as defective. |
| `frontend/docs/PRINTER-TEST-SESSION.md` (hw-prep lane) | Folded into this run-book (rows 8–11 and the dpi table). **Do not fill its results table** — results split across two sheets are how acceptance evidence gets contradicted. |
| `docs/UAT-HARDWARE-RUNBOOK.md` (hardware lane, `phase2-hardware-uat`) | Reference only, two parts stale: its §0.1 "STOP — v1.0.1 not deployed" predates the 2026-09-23 12:37Z deploy (v1.0.1 **is** live), and it targets **production** — this session targets the **isolated dev stack** (below). Its §2–§3 (macOS driver install, custom paper size) remain the best connection-type walk-through and are summarised here. |
| `HANDOVER-UI-PRINT.md` (repo root) | Historical handover; capability limits it states are restated in HARDWARE-CHECKLIST groups B/C. |

## Browser printing vs Store Agent — never conflate the two claims

**Everything in this run-book is the BROWSER print path**: the operator's
browser renders the document and the OS print dialog delivers it. There is
**no Store Agent in this build** — no ESC/POS, no silent print, no
app-commanded cut, no cash-drawer kick, no receipt→counter / KOT→kitchen
routing (HARDWARE-CHECKLIST group B; spec v1.1 Part B §7 keeps browser
printing as the Core fallback and puts managed routing in the separate Store
Agent package, Phase 2 of the v1.1 sequence). Consequences:

- A "job sent" state in the browser is a **dialog interaction**, not a
  delivery status. There is no queue, no retry, no device health. Do not
  record any print as delivered on the strength of the dialog closing.
- If the printer auto-cuts or a drawer opens, that is the **driver/printer
  configuration** acting, not this application. Record it as observed
  hardware behaviour ("driver-cut: yes/no"), never as an app feature.
- When Store Agent work starts (Phase 2), its acceptance is a NEW record —
  none of the rows below transfer to it.

## What is already proven (do not re-prove)

On the deployed v1.0.1 release, driven through the signed-in SPA on a
12-line order (1310 px of content behind a 768 px viewport), Chromium with
`preferCSSPageSize` produces **KOT 1 page, receipt 1 page**, complete header
to footer; the negative control (pre-fix CSS re-applied) gives 9 and 5
pages. Fix `7cc7896`, an ancestor of RC-1; the VC-101 display work does not
touch the print path. Horizontal fit is measured: all four fixtures render
272 px = 71.97 mm with worst right excursion 0.01 px.

What that does **not** prove is everything between the browser's print
dialog and paper: driver, page size, margins, whether 80 mm thermal at
72 mm printable fits, where the cut lands, and thermal legibility of the
9 px payment/refund labels.

## Environment — the isolated dev stack, not production

- Stack: original box (`atc-noc`), `~/vexo-connect-dev` — API 127.0.0.1:5350,
  Vite 127.0.0.1:5351, Postgres 5440. Receipt/KOT rendering is byte-unchanged
  from deployed v1.0.1, so the dev stack prints the same documents.
- From the computer the printer is attached to, open the tunnel
  `ssh -N -L 5351:127.0.0.1:5351 -p 2033 atc-noc@103.168.210.243`
  and browse **`http://127.0.0.1:5351/`**. Do **not** use `localhost:5351` —
  the dev backend accepts only the `127.0.0.1` origin and refuses sign-in
  from any other.
- **Production only with the owner's explicit go-ahead**: these steps write
  an order, KOT, payments and a refund into the production demo tenant.
- Record the build under test at session start (fill in): dev stack commit
  `________`, verified serving by content (not by tag).
- Candidate this acceptance is prepared against: the **Foundation candidate**,
  `x/foundation` lane (base commit `38856d3` + the lane's Phase-1 work-in-tree;
  fill in the integrated commit SHA when it lands: `________`). Originally
  prepared on `sprint/client-handover-rc` `7d11df1` (docs commit `b7b5ae5`,
  branch `w3/print-acceptance` in `~/vexo-connect-w3`); receipt/KOT rendering
  verified unchanged in the Foundation tree (272 px band, wrap, per-rate tax
  rows, discount/refund lines). Print-request audit (`ORDER_PRINT_REQUESTED`,
  added 2026-09-24) records the explicit Print click only — it is a DIALOG
  event, never evidence of paper.

## Kit — filled in when the owner supplies the hardware

| | Value | Notes |
|---|---|---|
| Printer make/model (from the unit's label) | ________ | |
| Head (from self-test) | ____ dpi / ____ chars per line | See the dpi table — 48 (203 dpi) and 42 (180 dpi) are BOTH passes; **~32 or fewer means a 58 mm printer: STOP** (58 mm is a code change, not a setting) |
| Connection | USB / LAN / Bluetooth / Serial | |
| Attached computer + OS | ________ | Decides the driver steps below |
| Browser | ________ (Chromium preferred; 100 % zoom) | |
| Paper | 80 mm roll (~72 mm printable) | |

**Expected characters-per-line by head — both rows pass:**

| Head | Dots across ~72 mm | Font A | Font B |
|---|---|---|---|
| 203 dpi (TM-T82/T82X, TVS RP 3200) | 576 | 48 | 64 |
| 180 dpi (TM-T88V/VI/VII) | 512 | 42 | 56 |

**Connection setup (from UAT-HARDWARE-RUNBOOK §2–3, OS-adapted on the day):**

1. Install the **vendor driver** before adding the printer; a generic driver
   appears to work, then prints at the wrong size.
2. USB: plug in, add printer, set driver to the vendor's. LAN: get the IP
   from the printer self-test, add via raw socket 9100, reserve the IP on
   the router. Bluetooth: pair first; expect the weakest page-size support.
3. Define a custom paper size: **width 80 mm, height 200 mm, margins 0**
   (the app overrides height per job; 200 mm is a ceiling). On Windows use
   the driver's own paper definition; on macOS Manage Custom Sizes.
4. Print dialog settings: margins **None**, scale **100**, headers/footers
   **off**, background graphics **on** (the DEMO banner has a border).
5. Print the driver **self-test page first** (step 0 below). If it fails,
   stop — nothing learned from the POS afterwards means anything.

## Pre-session data prep (dev stack, signed in as owner)

- One product with a name **≥ 40 characters** (longest dev-catalog name is
  16 chars and cannot wrap at 72 mm). Prefix the name with `DEMO`.
- The order must carry **at least two different GST rates** (dev catalog has
  5 % and 12 %).

## The run

0. Print the driver's **self-test page**; record model, driver name exactly
   as the OS shows them, chars/line and dpi against the table above.
1. Ring a **12-line order** (the proven case) including the long-name
   product and items at two tax rates. Send KOT.
2. In the KOT modal, print to the thermal printer. Record.
3. Bill the order, record a CASH payment with change due, open the receipt,
   print. Record.
4. Reprint the receipt from **Orders → the paid order → receipt** (the
   reprint path shares the CSS but not the modal state). Verify the reprint
   is **identifiable against the first print** (same invoice number, same
   totals) and record what, if anything, on the paper distinguishes it.
5. As manager/owner, record a **partial refund**, then reprint the receipt.
6. **Disconnect/recovery:** unplug the printer (or drop its network), try a
   print — record exactly what the OS/browser shows; reconnect (power-cycle
   if needed) and reprint the same receipt from Orders. The recovered print
   must match. No app-side queue exists, so the expected behaviour is an OS
   error or a silently held OS queue job — record which.
7. Photograph every strip flat, in good light, ruler beside it. The
   photographs + kept paper are the evidence, recorded against the exact
   build noted above.

## Record — fill only from observed paper

| # | Check | Result |
|---|-------|--------|
| 1 | KOT prints on ONE continuous strip, no blank pages | PENDING |
| 2 | KOT header and every line legible, no clipped right edge | PENDING |
| 3 | Receipt prints on ONE strip, header to footer | PENDING |
| 4 | Receipt DEMO banner, invoice number, totals, change due all legible | PENDING |
| 5 | ~72 mm printable width fits — no horizontal truncation; measured printed band ____ mm | PENDING |
| 6 | Feed/cut proportionate: KOT and long receipt feed DIFFERENT lengths; blank after last line ____ mm; if the printer cuts, cut lands after the footer | PENDING |
| 7 | Reprint (step 4) matches the first print and is identifiable (same invoice no./totals) | PENDING |
| 8 | Driver self-test prints cleanly, before the app; chars/line matches the head's row in the table | PENDING |
| 9 | The long item name wraps onto a second line, nothing clipped, amount column stays hard right | PENDING |
| 10 | Each tax rate prints its own line and subtotal + taxes = TOTAL by hand-addition | PENDING |
| 11 | After the partial refund: refund line prints with a minus sign, and `REFUND HANDED BACK — recorded by staff` + `MANUAL PAYMENT RECORD — not gateway-verified` print in full and legibly (9 px — smallest type on the receipt) | PENDING |
| 12 | Disconnect/recovery (step 6): failure state recorded; recovered reprint matches | PENDING |
| 13 | Driver-cut observed? yes / no (hardware behaviour, NOT an app feature) | PENDING |
| 14 | Cash drawer | **N/A — not driveable by this build** (no ESC/POS path). Test only if the DRIVER offers a kick option and the drawer is connected; record as driver behaviour |

Mark each row **PASS**, **FAIL** or **NOT TESTED**. A row not reached is NOT
TESTED; a blank or a guess is worse than an honest gap. The gateway labels
(`REFUND PAID OUT`, `REFUND SENT`, etc.) cannot appear — the gateway is off;
their absence is not a FAIL and the gateway is not to be enabled to reach
them.

**Pass:** all applicable rows observed on paper. **Any FAIL:** photograph
the strip, note driver + paper-size settings, work the four-way triage from
UAT-HARDWARE-RUNBOOK §5.0 (paper vs deployed CSS vs browser settings vs
driver) before writing "driver limitation", and file layout defects against
the print CSS — do not adjust the driver to mask a layout fault. A FAIL
needs the measurement, not the impression: "18 mm of blank paper after every
ticket" is actionable; "feeds too much" is not.

Owner of this run-book: Window 3 (printing / peripherals / operational
acceptance). Physical execution needs a human with the printer; results
land here, in this table only.
