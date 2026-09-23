// Gives the print job a concrete page size, because the CSS one is ignored.
//
// index.css declares `@page { size: 80mm auto; margin: 0 }`, which is the
// spec-correct way to say "80 mm wide, as long as the content needs" and is
// what a continuous thermal roll actually wants. Firefox honours it.
// Chromium — which is what the till runs — DOES NOT: a `<length> auto` pair
// is rejected and the engine silently falls back to the default page size.
//
// Measured on Chromium 1117 against this app's own receipt fixtures:
//
//   @page size            PDF MediaBox         verdict
//   80mm auto             612 x 792 pt         ignored — US Letter (215.9 mm)
//   80mm 200mm            227 x 567 pt         honoured (80.1 mm)
//
// The failure is silent and it is not cosmetic. A receipt laid out for a
// 215.9 mm page and sent to an 80 mm roll is scaled or cropped by the driver,
// so the thing that reaches the paper is not the thing that passed review.
//
// A fixed height would fix the width and create a second problem: these
// receipts measure 64 mm (KOT) to 153 mm (long bill), so a page tall enough
// for the longest feeds ~136 mm of blank roll after the shortest, and puts
// the auto-cut in the wrong place. So the height is measured per job and
// written into the rule just before the browser lays the page out.
//
// NOT TESTED ON HARDWARE. This settles what the browser asks the driver for.
// Whether a given driver honours a per-job page height, or overrides it with
// a fixed form, is a printer question — see docs/HARDWARE-CHECKLIST.md §2.

const STYLE_ID = 'pos-print-page-size';
const CSS_PX_PER_MM = 96 / 25.4;

// Must stay in step with the .print-area rules in index.css. 72 mm is the
// printable window of an 80 mm roll (576 dots at 203 dpi), not the paper.
const PAPER_MM = 80;
const PRINTABLE_MM = 72;
const SIDE_PADDING_MM = 2;

// Rounding up alone is not enough: a content box that lands a fraction over
// an integer millimetre spills a nearly-empty second page, which on a roll is
// a second cut. 2 mm of slack is cheaper than that.
const SLACK_MM = 2;

const styleEl = () => {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
};

// Measured on a detached clone forced to the print box, NOT on the live
// element. `.print-area` is only 72 mm wide inside `@media print`; on screen
// it is whatever the receipt modal gives it. Measuring the live element would
// read a height produced by different line wrapping at a different width, and
// the number would be wrong by however much the text rewrapped.
function measureHeightMm(el) {
  const clone = el.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  // The clone is a direct child of <body>, and index.css gives every body child
  // WITHOUT this attribute `display: none` in print media. Whether that bites
  // depends on whether the engine has already switched to print media by the
  // time `beforeprint` fires — engine-specific, and not worth betting a page
  // height on: a `display:none` clone measures 0, and a 2 mm page is a receipt
  // sliced into strips. So the clone claims the attribute. It is removed three
  // lines below, long before anything is painted, and the inline
  // `left:-10000px` keeps it off the paper even if it somehow were not.
  clone.setAttribute('data-print-root', '');
  clone.style.cssText = [
    'position:absolute',
    'left:-10000px',
    'top:0',
    `width:${PRINTABLE_MM}mm`,
    `max-width:${PRINTABLE_MM}mm`,
    `padding:0 ${SIDE_PADDING_MM}mm`,
    'box-sizing:border-box',
    'visibility:hidden',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(clone);
  const height = clone.getBoundingClientRect().height;
  clone.remove();
  return height / CSS_PX_PER_MM;
}

export function syncPrintPageSize() {
  const el = document.querySelector('.print-area');

  // No receipt on screen: drop the rule entirely. Leaving a stale 80 mm page
  // behind would silently reformat the NEXT thing printed from the app — a
  // day-close summary or a report would go out onto receipt-shaped pages
  // because a receipt happened to be printed earlier in the session.
  if (!el) {
    document.getElementById(STYLE_ID)?.remove();
    return null;
  }

  const heightMm = Math.ceil(measureHeightMm(el)) + SLACK_MM;
  styleEl().textContent =
    `@media print { @page { size: ${PAPER_MM}mm ${heightMm}mm; margin: 0; } }`;
  return heightMm;
}

// `beforeprint` covers both routes to the printer — the app's own Print
// button and the operator pressing Ctrl+P — so neither can reach the driver
// with the wrong page size. Chromium fires it for headless printToPDF too,
// which is what lets deploy/render-uat-screens.mjs verify this path.
export function installPrintPageSize() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeprint', syncPrintPageSize);
}
