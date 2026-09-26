# VC-105 Menu Profitability — evidence and dependency status

Prepared 2026-09-24 by VC-105 W1 (backend), lane
`vexo-connect-x-lanes/vc105-api`, branch `x/vc105-api`.

Everything below was executed. No production tree, frozen Core, peer lane or
peer database was written to; nothing was committed, merged, pushed or
deployed.

---

## 0. Setup, published for W2

| | |
|---|---|
| **Pinned base SHA** | `489b66a3b89febaf72361705eea08eef8331bb17` |
| Base branch | `x/integration` — "Phase-1 exit gate closed" |
| W1 worktree | `vexo-connect-x-lanes/vc105-api`, branch `x/vc105-api` @ `489b66a` |
| W2 worktree | `vexo-connect-x-lanes/vc105-ui`, branch `x/vc105-ui` @ `489b66a` |
| Contract | `docs/VC105-API-CONTRACT.md` **v1.1.1** |
| Contract sha256 | `182d5a16b259c65fb347114907b0a2e45817709fb3ccee3b3df9334df34a4eb0` |
| W1 ports | 5384 backend / 5385 frontend |
| W2 ports | 5386 backend / 5387 frontend |
| W1 test DB | `vcx_vc105_api_test` |
| Shared QA snapshot | `vcx_vc105_snapshot_v1` (seeded by script, see §5) |

All four ports were verified free before the worktrees were created, and are
free again now — no server was left running. Both worktree paths and both
branch names were confirmed not to exist beforehand; no existing lane was
touched.

**W2 records contract v1.1.1 and the sha256 above.** v1.1.0 is additive over
1.0.0: it adds `rows[].costBreakdowns`, the per-unit cost explanation the item
drilldown needs (recipe version, yield, ingredient and modifier components).
Every 1.0.0 field is unchanged. Any change to formulas,
rounding, field names or segment rules bumps the version and is announced in
the contract header first.

## 1. The dependency verification, done first

The brief said not to assume costing is complete. It is not. Measured across
every tree in the repository:

| Capability | Status | Evidence |
|---|---|---|
| Recipe versions | **MISSING** | `RecipeVersion` exists only in an uncommitted draft |
| Yields | **MISSING** | `RecipeVersion.yieldPercent` / `outputQty`, same draft |
| Unit conversions | **MISSING** | `InventoryItemUnit.factorMilli`, same draft |
| Modifier costs | **MISSING** | `RecipeModifierAdjustment`, same draft; `OrderItemModifier` is not in the pinned base at all |
| Purchase / valuation method | **DECLARED, NOT IMPLEMENTED** | schema comment: "perpetual WEIGHTED AVERAGE per location per item", citing `src/lib/inventory/ledger.js` — a file that does not exist |
| Historical cost snapshots | **MISSING** | `StockValuationSnapshot`, same draft |
| Sales / discount / refund data | **AVAILABLE** | `Order`, `OrderItem`, `Payment`, `Refund` — committed and tested at the pinned base |

The inventory lane, precisely:

```
x/inventory      0 commits beyond 38856d3
dirty files      1  (backend/prisma/schema.prisma, +916 lines, 34 models, 14 enums)
migrations       0
routes           0
lib modules      0
tests            0
```

So the design is thought through and nothing runs. **Live-data integration is
BLOCKED.** VC-105 implements no part of it, creates no competing stock ledger,
and chooses no valuation policy.

### Blocker found while choosing a base

`docs/PHASE1-EXIT-EVIDENCE.md`, `WINDOW-2-HANDOFF.md` and
`WINDOW-3-HANDOFF.md` all publish **`x/foundation` @ `4f2a91c`** as the agreed
development base, and the exit-gate table records "Clean pinned base | PASS".

```
$ git cat-file -t 4f2a91c
fatal: Not a valid object name 4f2a91c
```

**It does not exist.** The foundation migrations it describes live in
`cfa22e9` (whose own message says "No test run backs this commit") and in
`bddbe82`. VC-105 therefore pinned to `489b66a`, which exists, is the commit
that records the exit gate, and is byte-identical in `backend/` and
`frontend/` to `38856d3` — the base seven lanes share. **Raised for the owner:
three published handoffs name a base SHA that cannot be checked out.**

## 2. Tests — 42 VC-105, 426 total, all passing

```
Test Files  13 passed (13)
     Tests  426 passed (426)
```

That is the pinned base's 384 plus 42 new ones; mounting the route broke
nothing. Re-run:

```bash
cd /home/atc-noc/vexo-connect-x-lanes/vc105-api/backend
# <dev-db-password>: read it from the dev container, it is not written down here —
#   docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD
DATABASE_URL='postgresql://atc_pos:<dev-db-password>@127.0.0.1:5439/vcx_vc105_api_test?schema=public' \
POS_JWT_SECRET='<32+ chars>' npx vitest run tests/vc105Profitability.test.js
```

Every money assertion is hand-calculated in a comment above it, in paise. A
test that only re-runs the implementation proves nothing about whether the
implementation is right.

### Cases the brief asked for

| Case | Test | Hand-calculated expectation |
|---|---|---|
| Discounts | "reads the order discount already allocated to the line" | FLAT 1000 over lines 10000/3000 → shares **769 / 231**, summing exactly; net 9231 / 2769 |
| Partial refund | "a partial refund is allocated across lines and sums exactly" | refund 3000 over net 9231/2769 → **2308 / 692**; net after refund 6923 / 2077 |
| Full refund | "a refund is converted off the tax-inclusive total" | 10500 refund on total 10500 (tax 500) → refundNet **10000**, net after refund **0**, margin % **null** |
| Over-refund | "cannot drive net sales below zero" | capped at order total |
| Modifiers | "adds modifier cost outside the yield adjustment" | base 810 + extra shot 405 = **1215** paise; unknown modifier id ignored, not guessed |
| Unit conversions | "converts a named unit" | 0.15 L × factorMilli 1 000 000 = 150 000 milli-ml × 6 = **900** paise |
| Yields | "95 % makes the plate cost 1/0.95" | 810 000 milli-paise ÷ 0.95 → **853** paise (vs 810) |
| Missing costs | "reports MISSING and null — never zero" | `cogsPaise`, `contributionMarginPaise`, `marginPercent` all **null**; segment `UNCLASSIFIED` |
| Zero sales | "no orders is an empty report" | rows `[]`, totals 0, margin **null**, thresholds **null**, reconciliation agrees |
| Historical costs | "re-running a past period later returns the same cost" | same `costPaise` at two different `asOf` values |
| Historical reproducibility, per provider | "states whether a past period can be reproduced" | LIVE `GUARANTEED_BY_STORED_COST`; SYNTHETIC `NOT_GUARANTEED_SYNTHETIC` — **measured**: doubling the coffee price moved a past window's COGS 12960 → 25920 |
| Negative margin | "reported as negative, not clamped" | net 10000, cogs 12000 → CM **−2000**, **−20 %** |
| Stale costs | "STALE but still counts" | `costBasisAt` older than 90 days → flagged, cost retained |
| Rounding | "rounds to paise exactly once" | 1667 milli-paise × 3 = **5** paise (per-line rounding would give 6) |
| Cost breakdown (1.1.0) | "explains a latte" | 810 000 + 900 000 = 1 710 000 pre-yield; ÷ 0.95 → 1 800 000, so the yield itself added **90 000** milli-paise |
| Breakdown scope | "attaches breakdowns to item rows only" | `costBreakdowns` is `null` for a store row — one recipe for a whole store would be a fiction |

Scoping and roles: a branch-pinned manager is forced to their own store even
when they ask for a sibling; another tenant's store answers **404,
indistinguishable from absent**, with a positive control that the owning tenant
gets 200; a cashier gets **403**.

## 3. Reconciliation

Executed against the seeded snapshot through the running API on 127.0.0.1:5384,
then checked independently in SQL.

**Net sales ties to the stored order totals**, returned on every response:

```
orderTotal 336000  −  tax 0  =  derived 336000  =  Σ line net sales 336000
agrees: true
```

**And to the existing sales report**, via the bridging identity the contract
publishes — `/reports/sales` reports `netSales` tax-**inclusive** despite the
name, so the two would otherwise appear to contradict:

```
SalesReport.netSales 336000 − SalesReport.tax 0 = 336000
VC105.netSales                                  = 336000     MATCH
```

**Independent SQL check** — straight from the stored rows, not through the
engine:

```
 Seasonal Special |14|105044      Mystery Box   | 2| 40000
 Latte            | 7| 84000      Old Favourite | 5| 30000
 Filter Coffee    |18| 76956
```

Identical to the API's per-item net sales, item for item.

Worked example, Filter Coffee, verified by hand against the seed:
50 000 (10 × ₹50, no discount) + 16 956 (6 × ₹50 less its 13 044 discount
share) + 10 000 (2 × ₹50, later fully refunded) = **76 956 paise**. COGS 18 ×
810 = **14 580**. Refund 10 000, so costed net = 66 956 and contribution
margin = **52 376**, margin **78.22 %** — matching the API exactly.

## 4. What the report returns today, on real (synthetic-costed) data

```
costing: BLOCKED | source: SYNTHETIC | stale: 90 | WEIGHTED_AVERAGE DECLARED_NOT_IMPLEMENTED
coverage: 9/10 lines = 90%   ACTUAL 6 · ESTIMATED 2 · STALE 1 · MISSING 1

  item               qty      net  refund    cogs       CM    marg%  status     segment
  Seasonal Special    14   105044       0   70000    35044    33.36  ESTIMATED  PLOUGHHORSE
  Latte                7    84000   12000   12600    59400    82.50  ACTUAL     STAR
  Filter Coffee       18    76956   10000   14580    52376    78.22  ACTUAL     PLOUGHHORSE
  Mystery Box          2    40000       0       —        —        —  MISSING    UNCLASSIFIED
  Old Favourite        5    30000       0   10000    20000    66.67  STALE      PUZZLE
  Loss Leader          3     3000       0    7500    -4500  -150.00  ACTUAL     DOG

segments: popularity ≥ 0.1167 (0.70 × 1/6), margin/unit ≥ 3454 paise
totals: net 339000, refunds 22000, COGS 114680, contribution margin 162320 (58.60%)
        basis COSTED_LINES_ONLY, 1 line excluded
reconciliation: agrees
```

Mystery Box is the rule-6 case made visible: it has **no** cost, so it shows no
COGS, no margin and no verdict — not a zero, and not a DOG. Loss Leader is the
opposite case and equally important: a genuine **−₹45.00** at **−150 %** is
reported as the loss it is, not clamped at zero. Totals state the basis they
were computed on and how many lines they left out.

Empty period (2026-09-15, seeded deliberately with no trade): `rows: []`,
net 0, `marginPercent: null`, reconciliation agrees.

## 5. Snapshot for W2's integrated QA

A script, not a dump, so the snapshot is versioned by git and W2 seeds their
**own** database rather than pointing at a changing peer one:

```bash
cd /home/atc-noc/vexo-connect-x-lanes/vc105-api/backend
DATABASE_URL='postgresql://…/vcx_vc105_ui_test?schema=public' \
POS_SEED_PASSWORD='<your own>' node scripts/vc105-seed-demo.mjs
```

It refuses any database whose name does not contain `vc105`, and refuses
`NODE_ENV=production` — verified by pointing it at `atc_pos_test`, which it
declined. The password is supplied by the operator, never printed, never
committed.

Seeded window 2026-09-10 … 2026-09-16 IST, 6 orders / 9 lines / 2 refunds,
two stores, both channels, one discounted order, one partial refund, one full
refund, one empty day, one product with no cost at all, and one deliberately
loss-making dish. Every cost-coverage state and both margin signs appear at
once, so the UI can show all of them in one screenshot.

Fixture: `backend/tests/fixtures/vc105-synthetic-costs.json`, labelled
`"SYNTHETIC — not real cost data"`.

## 6. Separation of what is proven

| | |
|---|---|
| **Contract-ready** | Endpoint, response shape, formulas, rounding, segments, scoping, coverage semantics — published, implemented, tested |
| **Backend-verified** | Net sales, discount allocation, refund allocation, reconciliation to stored orders and to `/reports/sales`, role and tenant scoping — 36 tests plus an executed end-to-end capture |
| **Synthetic only** | Every COGS, contribution margin, margin % and segment above. Fixture data. **Fixture success is not evidence about real costs.** |
| **BLOCKED** | Live costing integration, in all seven capabilities of §1 bar sales data |
| **Not started** | UI (W2's lane), browser QA |

## 7. Open items for the owner

1. **Three handoff documents publish a base SHA (`4f2a91c`) that does not
   exist.** Whatever is decided for VC-105, the other windows are working to a
   pinned base they cannot check out.
2. **Refund COGS treatment needs confirmation.** VC-105 does not reduce COGS
   when a refund is issued, because whether stock came back is recorded in
   `SaleConsumption.returnedQty` / `SaleStockReturn`, which do not exist. A
   refunded meal is usually consumed, so reducing COGS would overstate margin.
   `refundNetPaise` is exposed per row so the effect is visible. This is a
   reporting treatment, not a valuation policy — but it should be confirmed
   before anyone reads margins as final.
3. **"Channel" is `Order.type`**, whose only values are `DINE_IN` and
   `TAKEAWAY`. There is no delivery or aggregator channel in the committed
   schema, and the UI must not imply one.
4. **Contribution margin is not net profit.** It excludes labour, rent,
   utilities, packaging, wastage, delivery commission and tax. The payload
   carries that wording in `meta.marginLabel`; it needs to survive into the UI
   and into any client-facing document.
