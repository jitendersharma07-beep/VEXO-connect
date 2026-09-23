# Physical receipt / KOT print — UAT run-book (2026-09-24)

**Status: PENDING — physical results stay pending until paper is observed.**
Nothing in this document claims a printer works. It exists so tomorrow's
session with the real printer is a checklist, not an improvisation.

**This is the single results table of record.** A second script,
`frontend/docs/PRINTER-TEST-SESSION.md`, exists on the `phase2-hw-prep` lane
(`43d2218`). It is not on the release line and not in RC-1. Its extra content
checks and its evidence rules are folded in below (rows 8–11); do not fill in
its own Results table as well, or the results end up split across two sheets.

## What is already proven (do not re-prove)

On the deployed v1.0.1 release, driven through the signed-in SPA on a
12-line order (1310 px of content behind a 768 px viewport), Chromium with
`preferCSSPageSize` produces **KOT 1 page, receipt 1 page**, complete header
to footer. The negative control — the pre-fix CSS re-applied in the same
browser — gives 9 and 5 pages, so the page counter detects the defect it
rules out. The fix is commit `7cc7896` (merged at `eb9e50e`); it is an
ancestor of this branch and the VC-101 display work does not touch the
print path (`Receipt.jsx`, `printPageSize.js` — zero edits, and the sprint's
381/381 backend run includes the print-adjacent suites).

What that does **not** prove is everything between the browser's print
dialog and paper: driver, page size, margins, whether 80 mm thermal at
72 mm printable fits the layout, and where the cut lands.

Also **not implemented, by design** (`docs/HANDOVER-UI-PRINT.md` §3): no
ESC/POS, no cash-drawer kick, no per-job printer routing. The print path is
the browser's. If the pilot needs a drawer to open, that is new work.

## Prerequisites

- [ ] 80 mm thermal printer (see `frontend/docs/HARDWARE-CHECKLIST.md` for
      the buy-to spec) with its vendor driver installed on the till machine.
- [ ] The driver's paper size set to 80 mm roll (72 mm printable) — not A4.
- [ ] Chromium/Chrome on the till machine (the print path is the browser's).
- [ ] **Environment: the dev stack on the original box, not production.**
      From the laptop the printer is attached to, open the tunnel
      `ssh -N -L 5351:127.0.0.1:5351 atc-noc@<usual address>` and browse
      **`http://127.0.0.1:5351/`**. Do not use `localhost:5351`: the dev
      backend accepts only the `127.0.0.1` origin and refuses sign-in from any
      other with a server error. Receipt and KOT rendering is unchanged from
      v1.0.1, so the dev stack prints the same document. **Production only
      with the owner's explicit go-ahead for this test**: the steps below
      write an order, a KOT, payments and a refund into the production demo
      tenant, beside the bills `docs/DEMO-DATA-CORRECTION.md` is still
      reconciling.
- [ ] A ruler with millimetres, and a phone to photograph the paper — the
      photographs are the evidence.
- [ ] **Before the session**, signed in as the owner on the dev stack: create
      one product whose name is at least 40 characters, so it must wrap at
      72 mm. The longest name in the dev catalog is 16 characters and cannot
      wrap. The dev catalog has two tax rates, GST 5% and GST 12%; the order
      needs an item at each.

## The run

0. Before opening the app, print the driver's own **self-test page**, and
   record the printer model and driver name exactly as the OS shows them.
1. Ring a **12-line order** (the proven case was 12 lines) that includes the
   long-name product and at least one item at each tax rate. Send KOT.
2. In the KOT modal, print to the thermal printer. Record below.
3. Bill the order, record a CASH payment with change due, open the receipt,
   print. Record below.
4. Repeat the receipt once from **Orders → the paid order → receipt** (the
   reprint path shares the CSS but not the modal state).
5. Signed in as a manager or the owner, record a **partial refund** on that
   order, then reprint the receipt.
6. Photograph every strip flat, in good light, with the ruler beside it.
   Keep the paper and staple it to this checklist.

## Record — fill only from observed paper

| # | Check | Result |
|---|-------|--------|
| 1 | KOT prints on ONE continuous strip, no blank pages | PENDING |
| 2 | KOT header and every line legible, no clipped right edge | PENDING |
| 3 | Receipt prints on ONE strip, header to footer | PENDING |
| 4 | Receipt DEMO banner, invoice number, totals, change due all legible | PENDING |
| 5 | 72 mm printable width fits — no horizontal truncation | PENDING |
| 6 | Cut lands after the footer, not through it | PENDING |
| 7 | Reprint path (step 4) matches the first print | PENDING |
| 8 | Driver self-test page (step 0) prints cleanly, before the app | PENDING |
| 9 | The long item name wraps onto a second line, nothing clipped | PENDING |
| 10 | Each tax rate prints on its own line, and the totals add up | PENDING |
| 11 | After the partial refund (step 5): the refund line prints with a minus sign, and `REFUND HANDED BACK — recorded by staff` and `MANUAL PAYMENT RECORD — not gateway-verified` print in full and legibly | PENDING |

Mark each row **PASS**, **FAIL** or **NOT TESTED**. A row you did not reach is
NOT TESTED; a blank or a guess is worse than an honest gap. The gateway labels
(`REFUND PAID OUT`, `REFUND SENT` and the rest) cannot appear, because the
gateway is off. Their absence is not a FAIL, and the gateway is not to be
enabled to reach them.

**Pass:** all eleven observed on paper. **Anything else:** photograph the
strip, note driver + paper-size settings, and file the defect against the
print CSS — do not adjust the driver to mask a layout fault. A FAIL needs the
measurement, not the impression: "18 mm of blank paper after every ticket" is
actionable; "feeds too much" is not.

Owner of this run-book: the VC-101 display session. Physical execution
needs a human with the printer; results land here as edits to this table.
