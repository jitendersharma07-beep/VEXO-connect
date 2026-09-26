# Physical receipt / KOT print — UAT run-book (2026-09-24)

**Status (2026-09-25): hardware and driver VERIFIED; VEXO output on paper still
PENDING.** The owner has photographed a DCode DC RP30 self-test and a successful
Windows print through the `POS-80C` driver on `USB001` — that is **Record A**
below, and it closes the "is the printer and its driver working" question.

It does **not** close printer acceptance. No photograph yet shows a VEXO
receipt, KOT or reprint on paper, so **Record B is PENDING in full** and this
document still claims no VEXO print works. Three kinds of evidence live here
and must not be merged:

| | What it is | Status |
|---|---|---|
| Automated | Chromium pagination + CSS geometry, in pixels, no printer | PASS — "What is already proven" |
| Record A | Hardware + driver, owner photographs | **VERIFIED 2026-09-25** |
| Record B | VEXO documents on physical paper | **PENDING** |

It exists so the session with the real printer is a checklist, not an
improvisation.

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

## Kit — partially supplied 2026-09-25 (owner photographs)

| | Value | Notes |
|---|---|---|
| Printer make/model (from the unit's label) | **DCode DC RP30** | **Rating plate read directly** by W6, 2026-09-25 — photo `A1`, see provenance below |
| Serial | **DCRP30-2606F0313** | Barcode line of the same rating plate (`A1`) |
| Interfaces on the unit | **USB + LAN** | Printed on the rating plate (`A1`): `Interface : USB+LAN`. The unit has Ethernet, so a `PrintTarget` with `transport: TCP` → `host:9100` is reachable on this hardware once it is given an address. Earlier notes calling this unit USB-only are wrong |
| Power | 24 V ⎓ 2.5 A; BIS `R-93025780` | Rating plate (`A1`) |
| Head (from self-test) | ____ dpi / ____ chars per line | **STILL BLANK — and it is the one gating value.** See the dpi table: 48 (203 dpi) and 42 (180 dpi) are BOTH passes; **~32 or fewer means a 58 mm printer: STOP** (58 mm is a code change, not a setting). **The photographs in hand cannot close this** — they are raster output from a browser print, not ESC/POS text; see "the cheapest open question" below, which has been rewritten now that the photographs have actually been looked at |
| Connection in use | **USB** | Owner-supplied photograph: Windows port `USB001`. This is the port currently wired, not the unit's only interface — see the row above |
| Attached computer + OS | **Windows**, driver `POS-80C` on port `USB001` | Owner-supplied photograph of a successful Windows print |
| Browser | ________ (Chromium preferred; 100 % zoom) | Not yet recorded; the app-output rows below need it |
| Paper | 80 mm roll (~72 mm printable) | Implied by the `POS-80C` driver name and by the app's own `@page { size: 80mm auto }`, **not** independently confirmed. The rating plate does not state a media width |

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

## Record A — hardware and driver, from owner photographs (2026-09-25)

**This table is not the acceptance.** It is the prerequisite the acceptance
sits on, and it is kept apart on purpose: the two tables answer different
questions, and collapsing them is how "the printer works" becomes "printing
works". Record B below is the acceptance and is still open.

| # | Check | Result |
|---|-------|--------|
| H-1 | The unit powers up and its own **self-test prints cleanly** — head, paper feed and thermal line all functional, before any driver or app is involved | **VERIFIED** — DCode DC RP30, owner photograph, 2026-09-25 |
| H-2 | **Windows driver path delivers to paper**: a print issued through the `POS-80C` driver on port `USB001` reaches the printer | **VERIFIED** — owner photograph, 2026-09-25 |

What those two facts buy, precisely: the hardware is not dead, the USB port and
cable carry data, and the Windows spooler → `POS-80C` → `USB001` chain is
configured and delivering. Every failure of *that* class is now excluded, which
is worth real money in diagnosis time — a blank strip from VEXO can no longer be
blamed on the printer or the driver being unconfigured.

What they do **not** buy, and this is the whole reason for two tables: neither
photograph shows a VEXO document. A self-test is the printer's own stored
pattern and a Windows test page is Microsoft's; both are generated below our
code, prove nothing about our stylesheet, and would look identical on a stack
where VEXO's receipt renders at the wrong width. Column alignment, the 72 mm
band, wrap of a long item name, per-rate tax lines, cut position and the 9 px
refund labels are all still unobserved. **Record B stays PENDING in full.**

### Provenance — read before citing these two rows

Superseded 2026-09-25 by Window 6. The paragraph that stood here said no
photograph had been inspected and asked for the images to be filed. They have
now been recovered from the owner's chat attachments, opened and read.

Raw images are held privately and durably at
`~/w6-print-agent/evidence/hardware/`, indexed with sha256, dimensions,
source transcript line and a description of each in `MANIFEST.md` there. They
are deliberately not committed: this run-book carries the sanitised summary and
the hashes, so an auditor on this box can open the originals and check them
against the claims, without owner hardware photographs entering Git.

| Ref | File | sha256 (short) | Role |
|---|---|---|---|
| `A1` | `A1-rating-plate-dcode-rp30.webp` | `10c4f6f5b687…` | The unit's rating plate — the source of the model, serial and interface rows above |
| `B1` | `B1-receipt-on-paper-20260925.png` | `e147b3e45cb8…` | A VEXO receipt on thermal paper, close up and fully legible |
| `B2` | `B2-receipt-on-roll-in-situ.png` | `9f65df548a18…` | The same receipt on the roll, printer in frame |
| `C1` | `C1-receipt-modal-print-dialog.png` | `a835270daa20…` | The in-app Receipt modal and its `Print` button — the path that produced `B1`/`B2` |

One correction to row H-1 falls out of this. **No self-test strip exists in the
evidence set.** What was described as one is `B1`/`B2`: a VEXO receipt. The
hardware conclusion H-1 draws — head, feed and thermal line functional — still
holds, and holds more strongly, because a VEXO receipt exercises the same
mechanism and more of the stack. But it was reached from a different artefact
than the row claims, and any reader expecting a character ruler in that
photograph will not find one.

### The cheapest open question in this document — rewritten 2026-09-25

The earlier text here assumed the photograph in hand was a self-test strip
showing a character ruler, and that reading chars-per-line off it would cost
seconds. **Having looked at the photograph: it will not, and no arrangement of
these photographs can.**

`B1` and `B2` are raster output. The glyphs `₹` (U+20B9), `é`, `·`, `×` and `—`
all render correctly, and the type size changes within the document — the
`MANUAL PAYMENT RECORD — NOT GATEWAY-VERIFIED` line prints visibly smaller than
the lines around it. No ESC/POS code page yields that combination; a Windows
driver rasterising an HTML page does, which is exactly what `C1` shows happening.
So the characters-per-line countable in these photographs is a property of the
stylesheet's font size, not of the print head. Counting them and writing the
answer in the Kit table would be the precise mistake this run-book already warns
against one paragraph earlier, arrived at from a photograph instead of a driver
name.

What can be said from `B1` without over-reaching: a 41-character line
(`Block A, Connaught Place (sample address)`) prints unwrapped and centred with
white margin on both sides. Together with the `POS-80C` driver name and the
app's own `@page { size: 80mm auto }`, that makes 58 mm **improbable**. It does
not make it measured, and the STOP check stays open on purpose.

**What closes it:** an ESC/POS character ruler emitted by the store print agent
(`agent selftest`), printed on this unit and photographed. That strip is
generated below the stylesheet, in the same text mode the agent uses for real
KOTs and receipts, so the count it produces is the number that belongs in
`PrintTarget.widthChars`. Until that strip exists, `widthChars` stays at the
schema default of 48 **as a declared assumption, not a measurement**, and every
Record B row that depends on width is measuring an assumed target.

## Record B — VEXO application output, fill only from observed paper

**Almost entirely PENDING.** Record A above does not advance any row here. The
automated evidence in "What is already proven" is a third, separate thing:
it is Chromium pagination and CSS geometry, measured in pixels, and it never
touched a printer.

Two rows move on the strength of `B1`/`B2`, and they move only part of the way.
Those photographs are a VEXO receipt on paper, so they are Record B evidence and
not Record A — but they were printed from **an older build than the release
candidate** (`B1` has no GSTIN line; `C1`, a later screenshot of the same modal,
does) and through the **browser print dialog, not the print agent**. A row filled
from them describes a build nobody is shipping and a path that is not the one
under acceptance. They are recorded as `OBSERVED (old build, browser path)` —
which is not PASS, and must not be totalled as one.

| # | Check | Result |
|---|-------|--------|
| 1 | KOT prints on ONE continuous strip, no blank pages | PENDING |
| 2 | KOT header and every line legible, no clipped right edge | PENDING |
| 3 | Receipt prints on ONE strip, header to footer | **OBSERVED (old build, browser path)** — `B2` shows one continuous strip, DEMO banner through `Thank you — VEXO Connect`, no page break. Re-observe on the candidate |
| 4 | Receipt DEMO banner, invoice number, totals, change due all legible | **OBSERVED (old build, browser path), partial** — in `B1` the DEMO banner, `BSC-CP/26-27/00006`, the two per-rate GST lines, `TOTAL ₹632.10` and the 9 px `MANUAL PAYMENT RECORD — NOT GATEWAY-VERIFIED` are all legible, and subtotal + taxes add up by hand. **Change due was not on this receipt** (it settled to `OTHER` for the full amount), so that clause is untested |
| 5 | ~72 mm printable width fits — no horizontal truncation; measured printed band ____ mm | PENDING |
| 6 | Feed/cut proportionate: KOT and long receipt feed DIFFERENT lengths; blank after last line ____ mm; if the printer cuts, cut lands after the footer | PENDING |
| 7 | Reprint (step 4) matches the first print and is identifiable (same invoice no./totals) | PENDING |
| 8 | Driver self-test prints cleanly, before the app; chars/line matches the head's row in the table | **SPLIT** — "prints cleanly" is **VERIFIED** at Record A H-1; "chars/line matches" is **still PENDING** and is the STOP check. Do not read this row as closed |
| 9 | The long item name wraps onto a second line, nothing clipped, amount column stays hard right | PENDING |
| 10 | Each tax rate prints its own line and subtotal + taxes = TOTAL by hand-addition | PENDING |
| 11 | After the partial refund: refund line prints with a minus sign, and `REFUND HANDED BACK — recorded by staff` + `MANUAL PAYMENT RECORD — not gateway-verified` print in full and legibly (9 px — smallest type on the receipt) | PENDING |
| 12 | Disconnect/recovery (step 6): failure state recorded; recovered reprint matches | PENDING |
| 13 | Driver-cut observed? yes / no (hardware behaviour, NOT an app feature) | PENDING |
| 14 | Cash drawer | **PENDING — was N/A, reopened 2026-09-25.** "Not driveable by this build (no ESC/POS path)" was true of the browser path and is no longer true of the product: the store print agent forms the `ESC p m t1 t2` pulse and drives the drawer over the same credential and lease as print jobs. The row now tests the agent, not the driver. Two outcomes to keep apart on the sheet: the agent **acknowledged** the pulse, and a human **observed the drawer open**. Only the second is `OPENED`, and only when the target declares a sensor |

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

Window 6 (store print agent, peripheral software, physical acceptance
preparation) amended the Kit table, the Record A provenance block, the
"cheapest open question" section and Record B rows 3, 4 and 14 on 2026-09-25,
from the owner photographs listed in the provenance block. The document's
structure and W3's rows are otherwise untouched; every amendment is marked with
its date and says what it supersedes. The agent-path acceptance steps live in
`docs/completion/W6-ACCEPTANCE.md` rather than being interleaved here, so this
run-book stays the browser-path sheet it was written as.
