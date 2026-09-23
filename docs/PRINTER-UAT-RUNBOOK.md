# Physical receipt / KOT print — UAT run-book (2026-09-24)

**Status: PENDING — physical results stay pending until paper is observed.**
Nothing in this document claims a printer works. It exists so tomorrow's
session with the real printer is a checklist, not an improvisation.

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
- [ ] A signed-in demo cashier on the dev stack, or the deployed v1.0.1 —
      either serves; the document under test is identical.

## The run

1. Ring a **12-line order** (mix products so at least one line wraps; the
   proven case was 12 lines). Send KOT.
2. In the KOT modal, print to the thermal printer. Record below.
3. Bill the order, record a CASH payment with change due, open the receipt,
   print. Record below.
4. Repeat the receipt once from **Orders → the paid order → receipt** (the
   reprint path shares the CSS but not the modal state).
5. Keep every strip of paper — staple them to the checklist.

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

**Pass:** all seven observed on paper. **Anything else:** photograph the
strip, note driver + paper-size settings, and file the defect against the
print CSS — do not adjust the driver to mask a layout fault.

Owner of this run-book: the VC-101 display session. Physical execution
needs a human with the printer; results land here as edits to this table.
