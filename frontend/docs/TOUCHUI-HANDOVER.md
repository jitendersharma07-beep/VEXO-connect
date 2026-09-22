# Touch-UI lane — handover to the release owner

Branch: **`phase2-touchui`**, based on `main@33323ce`.
Worktree: `~/atc-pos-lanes/touchui` (this lane never edited the shared tree).
Handing back a **branch, not a patch**. Only you merge and deploy.

---

## 1. Three things that need your decision

### 1.1 This branch breaks `deploy/render-uat-screens.mjs` — and that check was wrong

That file is W1's, so this lane did not edit it. It needs a one-line change:

```js
// deploy/render-uat-screens.mjs:21
const PAPER_PX = 302; // 80 mm at CSS 96dpi, matches .print-area w-[302px]
                  ^^^  must become 272 (72 mm)
```

Line 80 asserts `Math.abs(m.rect - PAPER_PX) <= 3`. The receipt is now 272 px,
so **that assertion will fail** on this branch.

**The assertion is itself the bug.** It asserts the content box is the full
80 mm *paper* width — which is exactly what caused receipts to be clipped —
and an element screenshot cannot observe `@page` at all, so it stayed green
through the entire defect. Details in §2.1.

### 1.2 A PALETTE reference exists — earlier "missing" reports were wrong

`globals.css` is a **palette reference and nothing more**. It is a stylesheet
of colour tokens, not a comp, not a screen layout, and not a sign-off. Its
existence says which blues are ours; it says nothing about whether any screen
in this build looks the way the customer expects. Do not cite it — or this
section — as evidence of approved visual design.

`frontend/tailwind.config.js` cites it in a comment, and the file is present:

```
/home/atc-noc/vexo-website/src/app/globals.css   (10,299 bytes)
```

The Tailwind palette in this repo (`pos-royal #1550E6`, `pos-deep #0B1730`,
`pos-orange #12BEDE`, …) is already derived from it. This lane worked within
that palette and **did not invent new brand colours**. The VEXO logo in
`frontend/src/components/Logo.jsx` is **untouched** — no replacement mark was
created.

This is not a claim that the UI matches an approved design. Nobody has signed
off a comp against these screens. It only means the reference was available
and was respected.

### 1.3 `Layout.jsx` had two real defects — both now FIXED on the release branch

**Status: closed.** This section originally handed these on as open findings,
because `frontend/src/components/Layout.jsx` was held by the unmerged
`phase2-copy-fix` branch (`76b9d2e`) and this lane could not touch it. The
release owner resolved that branch and fixed both. Kept here with the
measurements so the fix can be re-verified rather than taken on trust.

- ~~All 4 remaining sub-44 px touch targets are its sidebar nav items
  (208×40).~~ **Fixed:** `NavItem` now carries a `min-h-[44px]` floor. Three
  further sub-44 px links were found during verification in the *page body*
  of `Dashboard.jsx` (20 px tall) and took the existing `.link-touch` helper.
- ~~There is no navigation below 768 px.~~ **Fixed:** a drawer, opened by a
  hamburger in the top bar. The nav tree is now **one component rendered
  twice** — sidebar and drawer — because every entry in it is a permission
  decision, and a second hand-maintained copy drifts by showing a cashier the
  owner's links. The top-bar crowding at 768 px is fixed too: the company name
  no longer truncates to "Brew Stree…" and "Sign out" stays on one line.

Measured against the **built bundle** (`vite preview`), not the dev server:

| Width | Nav links, cashier / owner | `scrollWidth − clientWidth` |
|---|---|---|
| 430×932 | **4 / 12** (drawer) | 0 |
| 767×1024 | **4 / 12** (drawer) | 0 |
| 768×1024 | 4 / 12 (sidebar, unchanged) | 0 |
| 1366×768 | 4 / 12 (sidebar, unchanged) | 0 |

Before the fix the cashier had 4 links at 768 px and **0** at 767 px.

The cashier-vs-owner comparison is the check that matters and is the reason
the count is reported per role: it is the only assertion that fails if the
drawer is ever rewired to a hardcoded link list, and that failure mode is a
permissions leak rather than a layout bug. `deploy/render-nav-widths.mjs`
asserts it at 430 px and 768 px — 33/33 green.

**Merge order does not matter.** Verified with `git merge-tree`:

| Merge | Result |
|---|---|
| `phase2-touchui` → `main` | **CLEAN** |
| `phase2-copy-fix` → `main` | 3 conflicts (`dashboard.js`, `Layout.jsx`, `Dashboard.jsx`) |
| `phase2-touchui` + `phase2-copy-fix` | the **same 3** conflicts, nothing more |

Those conflicts are pre-existing between `copy-fix` and `main`. **This branch
contributes none of them** — the two lanes touch disjoint files.

---

## 2. What changed

Two commits, both confined to `frontend/**` (this lane's scope per
`docs/PHASE2-CONTRACT.md` §1). No backend, schema, Razorpay, deploy or
production config was touched.

### 2.1 `7613567` — receipts were being printed 8 mm too wide

**The defect.** An "80 mm" roll is 80 mm of *paper* but only ~72 mm of
*imageable* width (576 dots @ 203 dpi on an EPSON TM-T82/T88-class head); the
rest sits under the head's dead edges. The print CSS set the content box to
the full 80 mm **and** asked for a 4 mm `@page` margin — so 80 mm of content
was rendered into a 72 mm window and **7.9 mm fell off the right edge**.

That is the side every rupee amount, the invoice number and the TOTAL are
aligned to. Measured on the old rules:

```
content 302px, printable 272px, cut off: 30px (7.9 mm)
```

A clipped render of the old layout shows `TOTAL ₹682.` — the paise gone, the
invoice number truncated.

**Why it was never caught.** `deploy/render-uat-screens.mjs` measured the
`.print-area` *element* and asserted it was ~302 px. An element screenshot
cannot see `@page` margins, so the check passed while the paper was being cut.
Asserting the element is full paper width *is* the bug, restated as a test.

**The fix.** `@page` now carries no margin (the printer's own dead zone is the
margin), the content box is 72 mm, and the breathing space is padding *inside*
that box where it cannot push anything off the paper. Amounts keep their own
line box with tabular digits, so a long product name wraps and the figure
never does.

Also added a `receipt-long` fixture (8 items, wrapping names, two-digit
quantities) and lengthened the KOT fixture, because the original fixtures were
too short to expose wrapping.

### 2.2 `6ce30a4` — cashier screen was not usable by thumb at 1024×768

**Payment was below the fold.** The two-column breakpoint was `xl` (1280 px),
so a 1024×768 terminal — the smallest screen this is sold against — fell back
to stacked, putting the order panel *under the entire product grid*. "Record
payment" sat at y=1160 in a 768 px viewport.

Breakpoint moved to `lg`; the panel is now `sticky`/`self-start` so scrolling a
long menu cannot carry the totals off screen. Below `lg` (tablet portrait)
stacking is still correct, so a sticky bar carries the total and the primary
action instead.

> The sticky bar is **not a second source of truth**. It renders the same
> server-sent `order.total` / `order.amountDue` the panel renders, and calls
> the same handlers under the same `busy` / `canBill` / `licenseBlocked`
> guards, so it cannot offer an action the panel would refuse.

**Touch targets were mouse-sized.** 19 of 31 controls were under the WCAG 2.5.5
44 px floor — worst of all the quantity stepper at 22 px, which is the control
a cashier hits most and where a mis-hit changes what the customer is charged.
The floor now lives on `.btn`/`.input` plus two helpers (`.btn-touch`,
`.link-touch`) in `index.css`, so a control cannot be added at 38 px by
accident later.

Also: product names clamp to three lines (one 55-char name was stretching its
grid row to six lines and pushing the menu off screen), the variants badge no
longer overflows its tile, column counts follow the *catalog's* width rather
than the window's, and the cash/amount fields get `inputMode="decimal"` with
large tabular digits.

**Nothing about money changed.** Every displayed figure is still the server's;
billing calls, guards and permission checks are untouched.

---

## 3. Evidence

### 3.1 Viewports — 24 passed, 0 failed

Fixture-backed renders of the **real** `Sell.jsx` (API intercepted, no
credentials). Writes are refused with a 405 rather than faked.

| Viewport | Payment action reachable without scroll | Touch targets < 44 px |
|---|---|---|
| 1024×768 | before **1160 px** → after **651 px** (viewport 768) | 19/31 → **4/31** |
| 1366×768 | 651 px | 19/31 → **4/31** |
| 1920×1080 | 651 px | 19/31 → **4/31** |
| 768×1024 tablet portrait | before **1241 px** → after **1012 px** (viewport 1024) | 18/31 → **4/32** |

No horizontal overflow and no console errors at any of the four. The 4
remaining sub-44 px targets were the `Layout.jsx` nav items from §1.3, and
are **now fixed on the release branch** — the counts in this table are the
state of this lane at handover, not of the shipped build.

One harness correction was needed and is worth knowing about: the probe took
the *first* payment button in DOM order, which measured the panel's button and
reported a fail while the sticky bar was on screen doing its job. It now
checks **all** candidates and passes only if one is genuinely in the viewport,
reporting which — so a pass cannot come from a control the cashier can't see.

### 3.2 Print — 19/19 at handover, **47/47** on the release branch

All four fixtures measure exactly 272 px (72.0 mm) with no internal overflow,
and 80 mm PDFs render at the paper size. Required wording verified present and
verbatim: the DEMO banner, both payment labels, both refund labels, the
invoice number and the BALANCE DUE row. The pending-refund rule still holds —
a REQUESTED refund prints **without** a minus sign.

```
content 272px, printable 272px, cut off: 0px (0.0 mm)
```

**The 19/19 was not wrong, but it was not enough.** Two things it could not
see were found by the release owner and are now checked:

1. **Chromium ignored the page size.** `@page { size: 80mm auto }` is correct
   CSS and Firefox honours it; Chromium rejects a `<length> auto` pair and
   falls back to US Letter — so a correct 72 mm layout was still reaching the
   driver on a 215.9 mm page. Fixed by measuring the receipt on `beforeprint`
   (`src/lib/printPageSize.js`); the height is per job, so a KOT asks for
   ~66 mm and a long bill ~155 mm instead of one fixed form.
2. **Two checks could not fail.** The page size was read from CSSOM, which in
   Chromium drops the `size` descriptor entirely; and the dead-zone check
   compared two constants derived from the same literal. Both now come from
   the PDF MediaBox.

The harness is also negative-controlled now: an 80 mm content box fails the
width check with 73 escaping elements, and a re-introduced `@page
{ margin: 4mm }` is caught by a CSSOM scan of **every** `@page` rule — which
is its only possible defence, since element boxes, `scrollWidth` and the
MediaBox are all blind to a page margin.

None of this changes the standing caveat in §4: it is all browser geometry.
**Physical printing remains NOT TESTED.**

### 3.3 Regression sweep of the other 9 pages — 45/45

The 44 px floor lives on `.btn` and `.input`, so it changes **every page**, not
just the cashier screen. A taller control can push a toolbar into two rows or
overflow a table cell, so the rest of the app was swept at 1366×768 (the
tightest realistic desktop): dashboard, orders, catalog, tables, team,
branches, licence, reports, day-close.

All nine: no horizontal overflow, no element escaping the right edge, no
console errors, nothing rendering the error boundary. **No layout regression
was found from the global change.**

Two corrections were needed before that result could be trusted, both worth
recording:

- The sweep first ran with the **CASHIER** fixture, but catalog, tables,
  reports and day-close are gated to `BRANCH_MANAGER` and up. A role gate
  *redirects* rather than erroring, so those four silently landed on the
  dashboard and the sweep scored the dashboard four extra times as a pass for
  pages it never rendered. It now sweeps as `CUSTOMER_OWNER` **and** asserts
  the URL it landed on is the URL it asked for, so that false green cannot
  recur.
- The dashboard fixture was missing `company`, `branches.active`,
  `users.active` and `sales.note`, which `Dashboard.jsx` reads unguarded. That
  was a gap in the harness, not a defect in the page — but note the page does
  read `summary.company.isDemo` and `summary.sales.note` with no optional
  chaining, so a thin `/dashboard` response crashes it.

### 3.4 Build

`VITE_BASE_PATH=/pos/ npx vite build` → clean, 1662 modules, no warnings.
There is no frontend test script in `package.json` (`dev`/`build`/`preview`
only), so no unit suite was run — the verification above is the evidence.

### 3.5 Screenshots

In `frontend/docs/screens/`, committed with the branch:

```
cashier-1024x768.png            cart-payment-1024x768.png
cashier-1920x1080.png           cart-payment-1366x768.png
                                cart-payment-tablet-portrait.png
receipt-demo-print.png          receipt-long-print.png
kot-print.png
```

Probes that produced them: `/tmp/pos-touchui/{shoot,print-probe,clip-view,page-sweep}.mjs`
(scratch, not committed — they hard-code a local Chromium path).

---

## 4. What this branch does NOT claim

- **Physical printing is NOT TESTED.** Every print result above is browser
  emulation or a PDF. No receipt has touched a thermal printer.
- **Silent printing, automatic cutting and cash-drawer support are NOT
  supported and were not tested.** They need ESC/POS or a print agent; this
  app prints through the browser dialog and cannot emit raw commands. See
  `HARDWARE-CHECKLIST.md`. Do not let these be assumed as included.
- **Viewport results do not prove terminal compatibility.** A real device
  differs in DPI, digitiser accuracy, on-screen keyboard behaviour and browser
  chrome height. §1 of the hardware checklist must be signed off on the actual
  hardware.
- **No claim of client readiness or approved-design match.** No comp has been
  signed off against these screens.

- **The page height the driver receives is NOT TESTED.** The browser now asks
  for a per-job page height, but whether a given driver honours it or
  substitutes a fixed form decides how much roll is fed and where the cut
  lands. `HARDWARE-CHECKLIST.md` §2 has the measurements to take.

**Printer routing — a capability limit, not an open question.** The operator
may select any printer the OS offers, and may change it per job in the browser
dialog. There is **no automatic routing**: receipt-to-counter and
KOT-to-kitchen is not implemented. Both documents go through one print path to
whichever printer the dialog currently points at, and nothing in the software
prevents a KOT printing at the counter or a bill printing in the kitchen. A
site that needs two destinations needs this scoped as new work — it is not a
setting. See `HARDWARE-CHECKLIST.md` §2.

## 5. Also in this directory

- `HARDWARE-CHECKLIST.md` — per-site pre-go-live checks, with the untested and
  unsupported capabilities called out explicitly.
- `CASHIER-GUIDE.md` — one-page counter guide, including what the payment and
  refund labels mean and why a requested refund is not a returned one.
