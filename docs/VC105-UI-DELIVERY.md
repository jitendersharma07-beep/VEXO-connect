# VC-105 Menu Profitability — UI delivery and browser QA

Prepared 2026-09-24 by VC-105 **W2** (frontend), lane
`vexo-connect-x-lanes/vc105-ui`, branch `x/vc105-ui`.

No production tree, frozen Core, peer lane or peer database was written to.
Nothing was committed, merged, pushed or deployed. No inventory, recipe, schema
or migration file was touched.

---

## 0. What was verified before building

| | |
|---|---|
| Lane | `vexo-connect-x-lanes/vc105-ui`, branch `x/vc105-ui`, **0 dirty files** at start |
| Base SHA | `489b66a3b89febaf72361705eea08eef8331bb17` — identical to W1's published base |
| Contract | `../vc105-api/docs/VC105-API-CONTRACT.md` **v1.1.1**, read-only |
| Contract sha256 | `182d5a16b259c65fb347114907b0a2e45817709fb3ccee3b3df9334df34a4eb0` |
| Ports | 5386 backend / 5387 frontend — both verified free before use |
| Browser database | `vcx_vc105_ui_test` — W2's own, never a peer's |
| Backend snapshot | W1's `scripts/vc105-seed-demo.mjs`, **run, never edited** |

The contract version and checksum are also recorded in code, at the top of
`src/lib/vc105.js`, so a future contract change that nobody announced shows up
as a diff rather than as a silently wrong screen.

## 1. What was built

`/reports/menu-profitability` — [`src/pages/MenuProfitability.jsx`], with
display helpers in [`src/lib/vc105.js`], routed in `App.jsx` behind the same
role guard as the other reports and linked from both the sidebar and the
below-768px drawer.

| Brief item | Built |
|---|---|
| 1. Filters: stores, channels, period | Period, store, channel and grouping. A branch-pinned role sees "Your store only" instead of a store picker — the server pins them regardless, so offering the control would be a lie. Filters live in the **URL**, so a report can be sent to someone and open on the same figures |
| 2. Item table | Quantity, net sales, refunded, ingredient COGS, contribution margin, margin %, cost coverage, segment |
| 3. Popularity vs margin chart + 4 segments | Inline SVG scatter with the **server's** thresholds drawn as the quadrant lines and printed as numbers beside the chart |
| 4. Item drilldown | Recipe version, yield, each ingredient with its quantity and unit cost, modifier lines, the yield adjustment as its own row, cost per unit, discounts and refunds attributed to the item, and the calculation basis in words |
| 5. Missing/stale indicators + dependency status | Per-row coverage pills (Actual / Estimated / Stale / No cost), a coverage bar with counts, and a banner naming the costing dependency, its source and the missing capabilities |
| 6. Empty, loading, error, access-denied states | All four |
| 7. Responsive dashboard | Verified at 390 px with no horizontal page overflow |

### The rules the screen exists to honour

**An unknown cost is never zero.** `fmtPaise(null)` returns the unknown marker,
not `₹0.00`. That is enforced in one helper rather than at each call site, so a
new column cannot reintroduce the bug by formatting a null with the ordinary
money formatter. Uncosted rows show `—` for COGS, margin and margin %, a
**No cost** pill, and the segment **No verdict** — never *Dog*, which would be
the fabricated conclusion the contract forbids.

**Uncosted items are not plotted.** Putting them on the chart would place them
at zero margin, a claim the data does not support. They are named in a strip
under the chart instead: *"1 item(s) cannot be placed — no cost data, so no
margin exists to plot. They are not zero-margin and not dogs: Mystery Box."*

**Partial totals state their exclusions.** When any line is uncosted, the
totals row carries "Totals above are computed over costed lines only — N sold
line(s) are excluded because no cost exists for them."

**It says contribution margin.** The page title, the stat card, the drilldown
and `meta.marginLabel` all use it, and the QA asserts the phrase "net business
profit" never appears except in the denial.

**No money is calculated here.** Every figure and every classification is the
server's. The only local arithmetic is unit rendering: paise → rupees,
milli-paise → rupees, and milli-base-units → "0.15 L".

## 2. Browser QA — 48/48 checks passed

Run: `qa/vc105-browser-qa.mjs`, headless Chrome against the running stack,
screenshots in `qa/screens/`, machine-readable results in
`qa/screens/results.json`.

```
48/48 browser checks passed
```

Every screenshot carries at least one assertion — a screenshot nobody asserted
against is decoration. The last of the 48 asserts something about the
screenshots themselves: that the twelve files are twelve different images. That
check exists because they once were not (§3).

| Brief's QA item | Evidence |
|---|---|
| Filters | channel → takeaway narrows to exactly `Filter Coffee, Mystery Box, Old Favourite`; grouping by store returns exactly `Airport, Central`; grouping by day returns 6 rows |
| Permissions | a branch manager sees "Your store only" and **never** another store's items; a cashier is bounced off the route, is offered no nav link, **and** the API refuses them 403 when called directly from their own session |
| Empty data | 2026-09-15 (seeded with no trade) says "No sales in this period" and "not a zero-margin result"; the empty day is **absent** from the day grouping rather than shown as a zero row |
| Negative margins | Loss Leader renders **-₹45.00** and **-150.00%**, sign first |
| Zero sales | as above, plus margin % renders as the unknown marker, not 0% |
| Missing costs | Mystery Box: COGS `—`, margin `—`, margin % `—`, **No cost**, **No verdict** |
| Stale costs | Old Favourite flagged **Stale** and still counted; Seasonal Special flagged **Estimated** |
| Partial refunds | Latte shows ₹120.00 refunded against ₹840.00 net; the drilldown explains the allocation |
| Modifiers | **not exercisable in the browser** — see §4 |
| Historical periods | a past window re-queried twice returns byte-identical rendered rows — **and** the screen warns that a synthetic past is not reproducible (see §4) |

### Values checked against hand calculation

Not against the API's own output — against arithmetic done independently from
the seed (W1 evidence §3):

```
Filter Coffee   18 sold   net ₹769.56   COGS ₹145.80   CM ₹523.76   78.22%
Latte            7 sold   net ₹840.00   COGS ₹126.00   CM ₹594.00   82.50%
Loss Leader      3 sold   net  ₹30.00   COGS  ₹75.00   CM -₹45.00 -150.00%
```

Latte's drilldown, checked line by line: coffee powder 18 at ₹0.45/unit =
₹8.10, milk 0.15 L at ₹0.06/unit = ₹9.00, yield adjustment (95 %) ₹0.90, cost
per unit **₹18.00** — and ₹18.00 × 7 = **₹126.00**, the COGS in the table.

### Screenshots

| File | Shows |
|---|---|
| `01-owner-item-view.png` | the whole report: filters, synthetic banner, stat cards, coverage, chart, table |
| `02-chart-and-coverage.png` | coverage strip and quadrant chart, **clipped to those two panels** — see §3 |
| `03-drilldown-latte.png` | recipe version 2, 95 % yield, ingredients, yield adjustment, cost per unit |
| `04-drilldown-no-cost.png` | an uncosted item's drilldown refusing to invent a recipe |
| `05-empty-period.png` | the empty-day state |
| `06-historical-period.png` | a past window |
| `07-filter-channel-takeaway.png` | channel filter applied |
| `08-group-by-store.png` | store grouping, with the chart deliberately withheld |
| `09-group-by-day.png` | day grouping |
| `10-responsive-390.png` | 390 px layout |
| `11-manager-pinned-store.png` | branch manager, store pinned |
| `12-cashier-denied.png` | cashier bounced to the dashboard, no nav link |

## 3. Three defects found and fixed during QA

Recorded because a QA run that finds nothing usually means the QA is weak:

1. **URL filters were ignored.** The page held filters in component state only,
   so `?from=…&to=…` did nothing. Fixed by moving filters into
   `useSearchParams`. This also made the report shareable.
2. **Negative money read "₹-45.00".** The sign sat after the currency symbol,
   which is easy to miss in a column. Fixed locally in `fmtPaise` so the sign
   leads; the shared `fmtINR` is untouched, so no other screen moved.
3. **Recipe quantities rendered as raw milli units** ("150000"). Fixed to render
   the unit the recipe was written in — "0.15 L" — which is the point of a
   drilldown.

And two defects in the **QA harness** rather than the app.

**Shared cookie jar.** Pages in one browser share a cookie jar, so the manager
and cashier checks were reusing the owner's session and would have passed for
the wrong reason. Each user now gets its own browser context. The cashier
assertion was also looking for a refusal page when the app's house pattern is to
redirect; it now asserts the three things that should actually be true (off the
route, no link, API 403).

**Two screenshots were one screenshot.** Found after this document was first
written, while checking the delivery evidence file by file:
`01-owner-item-view.png` and `02-chart-and-coverage.png` were byte-identical —
both `fullPage` captures of a screen that nothing had changed between them, so
the second proved nothing the first had not already proved. The checks around it
were sound (the chart and coverage assertions read the DOM, and passed on their
own merits); what failed was the evidence, and no check was looking at it. Shot
02 is now clipped to the coverage strip and the chart, and the run ends by
hashing every screenshot it captured and asserting the digests are all
different. Verified by inverting it: with the clip removed the run goes 47/48
and names the pair, `01-owner-item-view == 02-chart-and-coverage`.

## 4. Separation of what is proven

| | |
|---|---|
| **UI-ready** | Every screen, state and interaction listed in §1. Built, rendered, asserted, screenshotted |
| **Backend-integrated** | The UI runs against W1's real endpoint at the pinned base — not mocks. Filters, scoping, roles, grouping, reconciliation line and contract version all come from the live response |
| **Costing-verified** | **NOTHING.** Every COGS, margin, margin % and segment on every screen above is fixture data from W1's synthetic provider. Fixture success is not evidence about real costs |

**Historical figures under synthetic costs are not reproducible.** Measured by
W1: doubling an ingredient price moved a past window's COGS from 12 960 to
25 920 paise, because the fixture provider prices at query time. The live
provider reads a cost struck at sale time and does not have this problem. The
contract states which is in force as
`meta.costing.historicalReproducibility`, and the screen renders a warning
when it is `NOT_GUARANTEED_SYNTHETIC` — so a synthetic past is never presented
as a historical fact.

**Not exercisable at this base:** modifier costs. `OrderItemModifier` does not
exist at `489b66a`, so no sold line can carry a modifier and the drilldown's
modifier rows cannot be produced from seeded data. The path is covered by W1's
unit tests (`costFromRecipe` with `modifierIds`) and the UI renders the rows
when the contract supplies them, but it has **not** been seen in a browser.

## 5. Integration handoff

When the inventory lane lands and `SaleConsumption` exists:

1. W1's provider switches from `SYNTHETIC` to `LIVE` with no contract change —
   `meta.costing.source` becomes `LIVE` and `dependency` becomes `AVAILABLE`.
2. **The UI needs no change for that.** The synthetic banner hides itself when
   `dependency !== 'BLOCKED'` and `source !== 'SYNTHETIC'`; coverage pills,
   segments and null handling are already driven by the response.
3. What must then be re-run before anyone reads a margin as real: this browser
   QA against live-costed data, and a fresh check that `costStatus` values
   coming from `SaleConsumption` match the pills (`ACTUAL`/`ESTIMATED`/
   `MISSING`, plus `STALE` derived from `costBasisAt`).
4. Until then the client-facing position is unchanged: **VC-105 reports sales
   accurately and reports cost as unknown.**

## 6. Reproducing this run

```bash
# W2's own database, seeded with W1's versioned script
DATABASE_URL='postgresql://…/vcx_vc105_ui_test?schema=public' \
POS_SEED_PASSWORD='<your own>' node ../vc105-api/backend/scripts/vc105-seed-demo.mjs

# backend on 5386 with the fixture cost provider
PORT=5386 HOST=127.0.0.1 DATABASE_URL='…vcx_vc105_ui_test…' \
  POS_JWT_SECRET='<32+ chars>' CORS_ORIGIN='http://127.0.0.1:5387' \
  VC105_SYNTHETIC_COSTS=1 \
  VC105_SYNTHETIC_COST_FILE=../vc105-api/backend/tests/fixtures/vc105-synthetic-costs.json \
  node ../vc105-api/backend/src/index.js

# frontend on 5387, proxying to it
VITE_DEV_API=http://127.0.0.1:5386 npx vite --port 5387 --host 127.0.0.1

# browser QA
QA_UI=http://127.0.0.1:5387 QA_OWNER=owner@vc105.demo.local \
QA_MANAGER=manager.central@vc105.demo.local QA_CASHIER=cashier@vc105.demo.local \
QA_PASSWORD='<the seed password>' QA_CHROME='<chrome-headless-shell path>' \
node qa/vc105-browser-qa.mjs
```

`CORS_ORIGIN` matters: the backend's default allows only `localhost:5177`, and
a browser request from another origin is rejected inside the CORS callback,
which surfaces as a **500** on `/api/auth/login` rather than a CORS error. That
cost an hour; it is written down so it costs nobody else one.

QA dependencies (`puppeteer-core`, `@puppeteer/browsers`, `yauzl`) were
installed with `--no-save`, so `package.json` and `package-lock.json` are
unchanged from the pinned base.
