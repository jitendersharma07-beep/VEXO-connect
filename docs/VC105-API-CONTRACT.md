# VC-105 Menu Profitability — API contract

**Contract version 1.1.1** · published 2026-09-24 by VC-105 W1 (backend).

> **1.1.1 (2026-09-24)** — adds `meta.costing.historicalReproducibility`. The
> report now states, per provider, whether a past period can be reproduced
> after a purchase-price change. Additive only.

> **1.1.0 (2026-09-24)** — adds `rows[].costBreakdowns`, the per-unit cost
> explanation the item drilldown needs (recipe version, yield, ingredient and
> modifier components). Additive only: every 1.0.0 field is unchanged, so a
> 1.0.0 client keeps working.

**Pinned base SHA: `489b66a3b89febaf72361705eea08eef8331bb17`** (`x/integration`,
"Phase-1 exit gate closed"). Both VC-105 worktrees were created from this exact
commit:

| Lane | Path | Branch | HEAD |
|---|---|---|---|
| W1 backend | `vexo-connect-x-lanes/vc105-api` | `x/vc105-api` | `489b66a` |
| W2 frontend | `vexo-connect-x-lanes/vc105-ui` | `x/vc105-ui` | `489b66a` |

Ports: **5384/5385** (W1), **5386/5387** (W2) — all four verified free at
setup, localhost only.

> ### Read this before building anything against it
>
> **Live costing data is BLOCKED.** No recipe, inventory, purchase or cost
> capability is committed anywhere in this repository. This contract is
> therefore complete and implementable for *sales* figures, and returns
> explicit `MISSING` cost coverage — never a zero cost and never a fabricated
> margin — until the inventory lane lands. §3 names the exact missing
> capabilities. §9 says what W2 can safely build now.

---

## 1. Base selection, and a blocker found while selecting it

`docs/PHASE1-EXIT-EVIDENCE.md`, `WINDOW-2-HANDOFF.md` and
`WINDOW-3-HANDOFF.md` all publish **`x/foundation` @ `4f2a91c`** as the
"agreed development base", and the exit-gate table records "Clean pinned base |
PASS".

**`4f2a91c` is not a valid object in this repository.** `git cat-file -t
4f2a91c` → `fatal: Not a valid object name`. The foundation migrations it
describes exist only in `cfa22e9` (the `x/foundation` WIP snapshot, whose own
commit message states "No test run backs this commit") and in `bddbe82`
(`x/w2-frontend`'s snapshot import).

VC-105 therefore pins to `489b66a` instead, on these grounds:

- it exists, and it is the commit that *records* the Phase-1 exit gate;
- its `backend/` and `frontend/` trees are byte-identical to `38856d3`, the
  base seven other lanes share;
- it carries the committed, tested sales and money engine that VC-105 must
  reconcile against (§4);
- the alternative — `cfa22e9` — is explicitly unproven, and pinning a report to
  an unverified base would make every number in it unverifiable too.

**Consequence W2 must know:** `OrderItemModifier`, `Promotion`, `Terminal` and
`Device` are **not** in the pinned base. Modifier cost handling is specified in
§6 and implemented in the engine, but no modifier *data* exists at `489b66a`,
so modifier costs are exercised by synthetic fixtures only.

## 2. Endpoint

```
GET /api/reports/menu-profitability
```

Auth: `requirePosAuth` + `resolveCompanyScope`, then
`requireRole('POS_SUPER_ADMIN', 'CUSTOMER_OWNER', 'BRANCH_MANAGER')` — the same
gate `reports.js` puts on `/reports/sales`. A `CASHIER` receives **403
`POS_FORBIDDEN`**.

| Query param | Type | Notes |
|---|---|---|
| `from` | `YYYY-MM-DD` | required, IST day start |
| `to` | `YYYY-MM-DD` | required, inclusive (IST day end) |
| `branchId` | string | optional; ignored and forced for branch-pinned roles |
| `channel` | `DINE_IN` \| `TAKEAWAY` | optional |
| `groupBy` | `item` \| `store` \| `channel` \| `period` | default `item` |

Scoping rules, all server-side:

- `companyId` always comes from the authenticated principal
  (`req.companyScope.id`). A client-supplied company is ignored.
- A branch-pinned role (`BRANCH_MANAGER`, `CASHIER`) is forced to its own
  `branchId`; a `branchId` naming another store is not an error, it is
  overridden.
- A `branchId` belonging to another tenant answers **404**, indistinguishable
  from a store that does not exist.

**"Channel" is `Order.type`,** whose only values at the pinned base are
`DINE_IN` and `TAKEAWAY`. There is no delivery, aggregator or online channel in
the committed schema. The UI must not imply otherwise.

## 3. Costing dependency status — BLOCKED

Verified by inspection of every tree in the repository, 2026-09-24:

| Capability VC-105 needs | Status | Where it would come from |
|---|---|---|
| Recipe versions | **MISSING** | `RecipeVersion` — draft schema only |
| Yields | **MISSING** | `RecipeVersion.yieldPercent` / `outputQty` — draft only |
| Unit conversions | **MISSING** | `InventoryItemUnit.factorMilli` — draft only |
| Modifier costs | **MISSING** | `RecipeModifierAdjustment` — draft only; and `OrderItemModifier` is not in the pinned base |
| Purchase / valuation method | **DECLARED, NOT IMPLEMENTED** | schema comment: "perpetual WEIGHTED AVERAGE per location per item", pointing at `src/lib/inventory/ledger.js`, which does not exist |
| Historical cost snapshots | **MISSING** | `StockValuationSnapshot` / `…Line` — draft only |
| Sales / discount / refund data | **AVAILABLE** | `Order`, `OrderItem`, `Payment`, `Refund` — committed and tested at the pinned base |

What "draft only" means precisely, measured in `x/inventory`:

- the branch has **0 commits** beyond `38856d3`;
- its single dirty file is `backend/prisma/schema.prisma`, **+916 lines**,
  34 models and 14 enums;
- **0** inventory migrations, **0** routes, **0** lib modules, **0** tests.

So six of the seven dependencies do not exist as running code, and the seventh
— the valuation method — exists as a sentence in a schema comment. VC-105 does
**not** implement any of them, does not create a competing stock ledger, and
does not choose a valuation policy.

### The integration seam

When the inventory lane lands, VC-105 reads costs from one table and nothing
else: **`SaleConsumption`**, keyed `orderItemId @unique`. The engine already
consumes exactly that row shape:

| `SaleConsumption` field | Used by VC-105 as |
|---|---|
| `orderItemId` | join key to the sold line |
| `costPaise` | ingredient COGS for the line |
| `costStatus` (`ACTUAL`/`ESTIMATED`/`MISSING`) | cost coverage, reported verbatim |
| `uncostedReason` | shown to the operator when a line has no cost |
| `recipeVersionId` | recipe version in the drilldown |
| `costBasisAt` | historical reproducibility anchor (§7) |
| `returnedQty` | stock actually returned on a refund (§5) |

Integration is then a provider swap, not a rewrite. Until that table exists,
`prisma.saleConsumption` is undefined, the live provider is structurally
unreachable, and the report says so in `meta.costing`.

## 4. Money definitions, and how each reconciles

All money is **integer paise**. No float arithmetic anywhere in the engine. The
definitions below are not new policy: they are read out of the committed money
engine `backend/src/lib/money.js` (`computeOrderTotals`), which is what wrote
the stored columns.

Per sold line (`OrderItem` with `status = 'ACTIVE'`):

| Quantity | Formula | Source |
|---|---|---|
| `grossSales` | `unitPrice × qty` | stored inputs |
| `lineDiscount` | as stored | item-level discount |
| `lineSubtotal` | `grossSales − lineDiscount` | stored column |
| `discountShare` | order discount allocated across lines | **stored column** — largest-remainder over `lineSubtotal`, already computed at bill time |
| **`netSales`** | **`lineSubtotal − discountShare`** | equals the engine's `taxable` |
| `lineTax` | `percentOf(netSales, taxPctMilli)` | excluded from every VC-105 figure |

**Tax is excluded from net sales entirely.** VEXO prices are tax-exclusive; GST
is added on top, so including it would inflate margin by the tax rate.

**Discount allocation is not re-derived.** `OrderItem.discountShare` was
allocated at bill time by `distributeProportional` (largest remainder, ties to
lowest index, shares summing exactly to the order discount). VC-105 reads that
column. Re-allocating would risk disagreeing with the bill the customer holds.

### Reconciliation identities (asserted by tests, §8)

For any order set in scope:

```
Σ netSales(line)  =  Σ (order.subtotal − order.discountAmount)
                  =  Σ (order.total − order.taxAmount)
```

And against the existing sales report, which must not appear to contradict
this one:

```
VC105.netSales  =  SalesReport.netSales − SalesReport.tax
```

`/reports/sales` reports `netSales` as **Σ order.total**, which is
tax-**inclusive** despite the name. VC-105 is tax-exclusive. The identity above
is the bridge; the UI should not place the two numbers side by side without it.

Order selection matches `/reports/sales` exactly, so the two cannot drift:
`status IN ('PAID','REFUNDED')`, windowed on `billedAt`, IST day boundaries,
`OrderItem.status = 'ACTIVE'` only.

## 5. Refunds

`Refund` at the pinned base is **order-level**: `amount`, `status`, `channel`,
no `orderItemId` and no quantity. **Line-level refund attribution is not
represented in the committed data model.** VC-105 therefore applies a stated,
auditable allocation rather than pretending to know which dish came back:

1. Only `status = 'SUCCEEDED'` refunds count, matching `/reports/sales`.
2. `refundedTotal = Σ refund.amount` (tax-inclusive money returned), capped at
   `order.total`.
3. It is converted to a tax-exclusive basis and allocated across the order's
   lines by `distributeProportional(refundNetTotal, weights = netSales(line))`
   — the same largest-remainder helper the bill itself uses, so the shares sum
   exactly and no paisa is created or lost.
4. `netSalesAfterRefund = netSales − refundNet`.

**COGS is not reduced by a refund.** Whether stock came back is recorded in
`SaleConsumption.returnedQty` / `SaleStockReturn`, which do not exist yet. A
refunded meal is usually consumed, so reducing COGS would overstate margin.
The report exposes `refundNetPaise` separately on every row so the reader can
see the effect rather than infer it, and `meta.costing.refundPolicy` states
this in the payload. **This is flagged for owner confirmation** when the
inventory lane lands — it is a reporting treatment, not a valuation policy.

## 6. Ingredient COGS, and what the engine does with recipes

Per line, from the cost provider:

```
cogs(line) = SaleConsumption.costPaise            when a costed row exists
           = null                                  otherwise   ← never 0
```

The engine applies recipe version, yield, unit conversion and modifier deltas
**only through the provider's already-costed row**; it does not re-price
ingredients itself. That is deliberate — re-deriving cost from recipes inside a
report would be a second, competing costing implementation, which this task
explicitly must not create.

For the synthetic provider (§9) the same arithmetic is applied to fixture data
so the shape is exercised end to end:

All intermediate arithmetic is in **milli-paise**, rounding to paise exactly
once at the end, so yield and conversion cannot each contribute their own
rounding error:

```
qtyBaseMilli  = qtyBaseMilli, or round(qty × factorMilli)      // unit conversion
unitCost      = Σ over recipe lines of ( qtyBaseMilli × unitCostPaise )   // milli-paise
yieldAdjusted = round_half_up( unitCost × 100000 ÷ yieldMilliPercent )
withModifiers = yieldAdjusted + Σ ( modifier qtyBaseMilli × unitCostPaise )
cogs(line)    = round_half_up( withModifiers × qtySold ÷ 1000 )           // paise
```

Quantities are **thousandths of the item's base unit** (g, ml, pcs), matching
the inventory schema's stated "milli" convention, and `unitCostPaise` is paise
per **one** base unit. `factorMilli` is milli-base-units per one named unit, so
`1 kg` against a base unit of `g` is `factorMilli = 1000000`.

A 95 % yield means the plate consumes `1 ÷ 0.95` of what the recipe lists,
because trim and loss are paid for too. Modifier deltas sit **outside** the
yield adjustment — an extra shot is an extra shot, not `1/0.95` of one.

### Cost coverage — rule 6, stated as a rule

- A line with no costed row is `costStatus: "MISSING"`, `cogsPaise: null`,
  `contributionMarginPaise: null`, `marginPercent: null`.
- **`null` must never be rendered as `0`.** Not in a total, not in a chart, not
  in a segment.
- Totals are computed over **costed lines only** and always carry the coverage
  they were computed on. A total that excludes uncosted lines says so.
- `ESTIMATED` is carried through verbatim from the provider and shown
  distinctly from `ACTUAL`.
- **Stale** means `costBasisAt` older than `InventorySettings.staleCostDays`,
  which the draft schema already defaults to **90 days**. VC-105 adopts that
  number rather than inventing one; it is reported as
  `meta.costing.staleCostDays` so the UI never hardcodes it.

## 7. Historical reproducibility

Re-running a past period after purchase prices change must return the same
figures. The mechanism is `SaleConsumption.costPaise` being **written at sale
time**, with `costBasisAt` recording when that cost was struck. VC-105 reads
the stored per-sale cost and never recomputes from today's prices.

The engine takes an explicit `asOf` from the provider row rather than
`Date.now()`, so it never recomputes a cost from today's prices.

**But the guarantee lives in the provider, not the engine, and only the LIVE
provider has it.** Measured, not assumed — the same historical window was run
twice with the ingredient price doubled in between:

```
2026-09-10..11, Filter Coffee, SYNTHETIC provider
  before price change : COGS 12960 paise
  after  price doubled: COGS 25920 paise     <-- the past moved
```

The fixture provider prices at query time, so it cannot hold history still.
`SaleConsumption.costPaise` is written at sale time and read back, so the LIVE
provider can. Every response therefore states which it is:

| `meta.costing.historicalReproducibility` | Meaning |
|---|---|
| `GUARANTEED_BY_STORED_COST` | LIVE — cost was struck at sale time and is read, never recomputed |
| `NOT_GUARANTEED_SYNTHETIC` | SYNTHETIC — fixture prices apply at query time; a past period will move if the fixture changes |
| `NOT_APPLICABLE_NO_COSTS` | NONE — there are no costs to reproduce |

**A UI must not present a synthetic historical figure as a historical fact.**

## 8. Segments — thresholds, documented

Menu-engineering quadrants (Kasavana–Smith), computed over the rows in scope:

- **Popularity threshold** — the "70 % rule": an item is *high popularity* when
  its share of total quantity ≥ `0.70 × (1 ÷ N)`, `N` = number of items with
  non-zero quantity in scope. With 10 items the line sits at 7 % of volume.
- **Margin threshold** — *high margin* when the item's contribution margin per
  unit ≥ the quantity-weighted mean contribution margin per unit across all
  **costed** rows in scope.

| | High margin | Low margin |
|---|---|---|
| **High popularity** | `STAR` | `PLOUGHHORSE` |
| **Low popularity** | `PUZZLE` | `DOG` |

Both thresholds are returned in `segments.thresholds` so the UI displays the
actual numbers, not a restatement of the rule.

**An item with unknown cost is `UNCLASSIFIED`,** never `DOG`. Classifying an
uncosted item as a low-margin dog is exactly the fabricated conclusion rule 6
forbids. `UNCLASSIFIED` items are excluded from the margin threshold mean.

## 9. What the UI must and must not do

- **Use backend money and classification verbatim.** Every money value is an
  integer paise field ending `Paise`; every classification is a server string.
  The UI must not re-add, re-allocate, re-round or re-segment.
- **Label it "contribution margin".** `meta.marginLabel` carries the exact
  wording. Contribution margin here is *net sales after refunds minus
  ingredient COGS* and excludes labour, rent, utilities, packaging, wastage,
  delivery commission and tax. It is **not** net business profit and must not
  be presented as it.
- **Never render `null` as zero.** A missing cost is a state to show, not a
  number to display.
- **State coverage on every partial total**, using `coverage` (§6).

### Synthetic fixtures, for parallel work

Live costing is blocked, so the report ships a clearly-labelled synthetic
provider for development only. It activates only when **both** hold:

```
NODE_ENV !== 'production'      AND      VC105_SYNTHETIC_COSTS=1
```

and it reads a fixture file named by `VC105_SYNTHETIC_COST_FILE`. With no
fixture file, every line is `MISSING` — the product code path cannot invent a
cost even with the flag on.

Every response states which provider answered:

```json
"costing": { "dependency": "BLOCKED", "source": "SYNTHETIC" | "NONE" }
```

`source: "SYNTHETIC"` means **the margins are made up for layout purposes**.
The UI must surface that prominently, and fixture success is not evidence about
real data.

## 10. Response shape

```jsonc
{
  "meta": {
    "contractVersion": "1.0.0",
    "baseSha": "489b66a3b89febaf72361705eea08eef8331bb17",
    "generatedAt": "2026-09-24T10:00:00.000Z",
    "period": { "from": "2026-09-01", "to": "2026-09-24", "timezone": "Asia/Kolkata" },
    "scope": { "companyId": "…", "branchId": null, "channel": null, "groupBy": "item" },
    "costing": {
      "dependency": "BLOCKED",
      "source": "NONE",
      "method": "WEIGHTED_AVERAGE",
      "methodStatus": "DECLARED_NOT_IMPLEMENTED",
      "staleCostDays": 90,
      "refundPolicy": "COGS_NOT_REDUCED_ON_REFUND",
      "missingCapabilities": [
        "recipe_versions", "yields", "unit_conversions", "modifier_costs",
        "purchase_valuation", "historical_cost_snapshots"
      ]
    },
    "marginLabel": "Contribution margin (net sales after refunds − ingredient COGS). Not net business profit."
  },
  "coverage": {
    "lines": 120, "linesCosted": 0, "linesMissing": 120,
    "byStatus": { "ACTUAL": 0, "ESTIMATED": 0, "MISSING": 120, "STALE": 0 },
    "netSalesPaise": 4820000, "costedNetSalesPaise": 0, "coveragePercent": 0
  },
  "totals": {
    "qty": 480,
    "grossSalesPaise": 5200000, "discountPaise": 380000,
    "netSalesPaise": 4820000, "refundNetPaise": 120000,
    "netSalesAfterRefundPaise": 4700000,
    "cogsPaise": null, "contributionMarginPaise": null, "marginPercent": null,
    "basis": "COSTED_LINES_ONLY", "excludedLines": 120
  },
  "segments": {
    "thresholds": { "popularityShare": 0.07, "marginPerUnitPaise": null },
    "counts": { "STAR": 0, "PLOUGHHORSE": 0, "PUZZLE": 0, "DOG": 0, "UNCLASSIFIED": 24 }
  },
  "rows": [
    {
      "key": "prod_abc", "label": "Filter Coffee",
      "productId": "prod_abc", "branchId": null, "channel": null, "period": null,
      "qty": 42,
      "grossSalesPaise": 420000, "discountPaise": 21000,
      "netSalesPaise": 399000, "refundNetPaise": 9500,
      "netSalesAfterRefundPaise": 389500,
      "cogsPaise": null, "costStatus": "MISSING", "costStatusReason": "NO_COST_SOURCE",
      "contributionMarginPaise": null, "marginPercent": null,
      "marginPerUnitPaise": null, "popularityShare": 0.0875,
      "segment": "UNCLASSIFIED",
      "coverage": { "lines": 12, "linesCosted": 0 }
    }
  ],
  "reconciliation": {
    "orderCount": 96,
    "orderTotalPaise": 5570000, "orderTaxPaise": 870000,
    "derivedNetSalesPaise": 4700000,
    "lineNetSalesPaise": 4700000,
    "agrees": true
  }
}
```

### 10.1 `rows[].costBreakdowns` — what the drilldown explains (1.1.0)

Present **only when `groupBy=item`**; `null` otherwise, because a store,
channel or period row spans many products and a single recipe breakdown there
would be a fiction. An array, keyed by recipe version: if a recipe changed
mid-period the drilldown shows both rather than silently picking one. Empty
array when the row has no costed line.

```jsonc
"costBreakdowns": [
  {
    "recipeVersion": 2,
    "yieldPercent": 95,
    "ingredients": [
      { "item": "Coffee powder", "qtyBaseMilli": 18000, "unit": null,
        "factorMilli": null, "unitCostPaise": 45, "costMilliPaise": 810000 },
      { "item": "Milk", "qtyBaseMilli": 150000, "unit": "L",
        "factorMilli": 1000000, "unitCostPaise": 6, "costMilliPaise": 900000 }
    ],
    "preYieldMilliPaise": 1710000,
    "yieldAdjustmentMilliPaise": 90000,
    "modifiers": [],
    "unitCostMilliPaise": 1800000
  }
]
```

Everything in it is **per ONE unit sold**, in **milli-paise** (thousandths of a
paisa), which is the unit the engine works in before its single final rounding.
The row's `cogsPaise` remains the authoritative figure — it is
`round_half_up(unitCostMilliPaise × qty ÷ 1000)`, rounded once. A UI that adds
up the displayed components may land a paisa away from `cogsPaise`; when it
does, `cogsPaise` is right and the display should say so rather than quietly
showing a different total.

`yieldAdjustmentMilliPaise` is the amount the yield added
(`unitCost − preYield`), so the drilldown can show trim and loss as its own
line rather than burying it in the ingredient prices.

`reconciliation` is returned on every call, not just in tests: the report
carries the proof that its own net sales tie back to the stored order totals.
`agrees: false` is a bug in this report, not a data problem, and the UI should
treat it as an error state.

## 11. Fixtures and test evidence

Fixture file format (`VC105_SYNTHETIC_COST_FILE`), all costs integer paise:

```jsonc
{
  "label": "SYNTHETIC — not real cost data",
  "staleCostDays": 90,
  "items": {
    "<productId or sku>": {
      "recipeVersion": 3,
      "yieldPercent": 95.0,
      "costBasisAt": "2026-09-01T00:00:00.000Z",
      "costStatus": "ACTUAL",
      "lines": [
        // 18 g of powder at 45 paise/g, given directly in milli-base units
        { "item": "Coffee powder", "qtyBaseMilli": 18000, "unitCostPaise": 45 },
        // or as a named unit plus its conversion: 0.15 litre of milk,
        // base unit ml, so factorMilli = 1_000_000 milli-ml per litre
        { "item": "Milk", "qty": 0.15, "unit": "L", "factorMilli": 1000000, "unitCostPaise": 6 }
      ],
      "modifiers": {
        "<modifierId>": { "item": "Extra shot", "qtyBaseMilli": 9000, "unitCostPaise": 45 }
      }
    }
  }
}
```

Test evidence lives in `docs/VC105-EVIDENCE.md`, published alongside the
implementation. Hand-calculated cases required by the brief: discounts,
partial and full refunds, modifiers, unit conversions, missing costs, zero
sales and historical periods.

## 12. Change control

W2 records the version and checksum it built against. Any change to formulas,
rounding, field names or segment rules bumps `contractVersion` and is announced
in this file's header before the code changes.

```
sha256(VC105-API-CONTRACT.md) — see docs/VC105-EVIDENCE.md §0, regenerated on
every contract change.
```
