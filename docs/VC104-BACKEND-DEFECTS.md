# VC-104 backend defects found by W2's browser QA — report for W1

**From:** W2 (frontend lane `x/vc104-ui`) · **To:** W1 (backend lane `x/vc104-api`)
**Date:** 2026-09-24 · **Line numbers are `x/vc104-api`'s, at `c40683b`**

Two defects in the phone-order backend. Both were found from the outside, by
driving W1's API through a real browser against W2's own database — not by
reading the code, and not by running W1's test suite (W2 does not run another
worker's tests). Neither is fixed: the backend is W1's to change. This report
exists so the fix is a decision W1 makes with the evidence in hand.

> **Consolidation note (`merge/a406-consolidate`, 2026-09-24).** This report was
> written twice, once per lane, each copy describing the other lane in the third
> person. Both lanes are now in this one tree, so those references have been
> rewritten to point at paths rather than at branches: the backend it cites and
> the QA evidence it rests on are both present here. A third defect, D-3, was
> added by the merge itself and is marked as such.

| # | Defect | Effect | Severity | Where |
|---|--------|--------|----------|-------|
| D-1 | `priceChanged` on reassign ignores the delivery charge | The caller is re-quoted nothing on exactly the moves that change what they pay | Medium — quote-facing, not billing (the charge is not billable while C-6 is open) | `backend/src/api/routes/phoneOrders.js:858,879,914` |
| D-2 | Prep capacity never counts ASAP orders | The kitchen-full refusal is dead on the dominant path; the guard fails OPEN | High for the feature's purpose — no money impact | `backend/src/api/routes/phoneOrders.js:178–185` + `:569` |
| D-3 | Phone orders cannot sell a product with a REQUIRED modifier group | Such products are refused on the phone path with "Choose at least N"; the caller cannot complete the order | Medium — fails CLOSED, so no mispricing; a catalogue subset is simply unsellable by phone | `backend/src/api/routes/orders.js` `resolveCatalogLine` minSelect loop, called from `phoneOrders.js` |
| D-4 | No VC-105 browser evidence exists for this tree, and the two QA harnesses used to overwrite each other | Process, not runtime: a VC-105 UI regression would ship unseen | Medium — no customer impact; blocks the UI acceptance row | `frontend/qa/run-all.sh`, `frontend/qa/vc105-browser-qa.mjs` |
| D-5 | ~~The catalog API can leave a required modifier group permanently unsatisfiable~~ **FIXED 09-24** | The product became unsellable on **every** channel, till included, with no warning at the moment of the edit | Medium — fails CLOSED like D-3, but unlike D-3 it was reachable by an ordinary catalogue edit | Fix: `assertSatisfiable` in `backend/src/api/routes/catalog.js`, three call sites |
| D-6 | Archiving a promotion permanently burns its code | The code cannot be republished, edited, or reused by a new promotion — the offer is unrecoverable and the till's code stops working for good | Medium — fails CLOSED, no mispricing; one code per mistake, not the catalogue | `backend/src/api/routes/promotions.js:353` with `:196`, `:229`, `:281`, `:167–172` |

§3 is the part worth reading first: **the phone-order suite already builds D-1's
exact conditions and simply never looks at the flag.**

**D-3 and D-4 did not exist in either lane alone — the consolidation merge
created both** (09-24, `merge/a406-consolidate`). They are recorded here because
this is where a VC-104 reader will look, not because W2's browser QA found them.

**D-5 is older than all of them** and was found later, on 09-24, while writing
the first HTTP-level tests for the modifier catalog routes
(`backend/tests/catalogModifiers.test.js`). It is filed here because it is the
other half of D-3's question — *what should happen when a required modifier
group cannot be satisfied* — and the two looked best answered once, together.
**D-5 was then fixed the same day** on the owner's instruction; D-3 was not, and
remains open. The full account is kept rather than deleted, because implementing
the fix turned up two more ways into the bad state than the investigation had
found, which is worth knowing next time.

**D-6 was found by looking for D-5's shape elsewhere** (09-24, after D-5 was
closed): a route with no frontend caller *and* no HTTP test, so that nothing —
no screen, no browser QA, no suite — exercises it. A sweep of all 25 files in
`backend/src/api/routes/` found four routes with both properties, and only one
of them reaches an unguarded state. That one is D-6. The sweep's full result is
in §7, including the routes that have one property but not both.

---

## D-1 — `priceChanged` cannot see the delivery charge

### What the code does

`POST /phone-orders/:id/reassign` snapshots the order before the move:

```js
// backend/src/api/routes/phoneOrders.js:858
const before = { total: Number(order.total), tax: Number(order.taxAmount) };
```

writes the new store's delivery charge onto the phone order:

```js
// backend/src/api/routes/phoneOrders.js:879
deliveryCharge: chosen.deliveryCharge ?? 0,
```

and then answers:

```js
// backend/src/api/routes/phoneOrders.js:914
priceChanged: Number(after.total) !== before.total || Number(after.taxAmount) !== before.tax,
```

Both terms are `Order` columns. The delivery charge is deliberately **not** an
`Order` column — `backend/src/lib/phoneOrders.js:116` sets
`DELIVERY_CHARGE_BILLABLE = false` while C-6 is open, so the charge is quoted
beside the order and only ever surfaces in
`payableQuote = order.total + deliveryCharge` (`lib/phoneOrders.js:118–137`).
That design is right, and this flag is the one place that forgot about it.

### Why it matters under C-7

C-7 leaves the catalogue company-wide: there is no per-branch menu, so moving an
order between stores **cannot** change food or tax. The only number a move can
change is the delivery charge — which is precisely the number `priceChanged`
does not look at. The flag is therefore `false` on every move that changes what
the caller pays, and `true` essentially never.

`docs/VC104-API-CONTRACT.md` §5.10 tells the client to "show them as a changed
price, not reuse the old summary", and its own example response carries
`"priceChanged": true`. As computed, the flag cannot honour that contract under
C-7.

### Observed

Seeded lane data, CP → CH reassign, same basket: delivery ₹40 → ₹65,
`payableQuote` moves by ₹25, `priceChanged: false`. First seen as a hung
re-price banner in QA run `20260924-135119` (66 checks passed, then the harness
waited for a `po-move-banner` that the server's flag never justified). Evidence:
`frontend/qa/screens/12-reassign-modal.png`, `13-after-move.png` and
`frontend/qa/screens/results-vc104.json`, committed here (from `x/vc104-ui` @
`f344ef4`; the file was named `results.json` on the lane — see D-4).

### Suggested fixes — W1's call

1. **Fold the charge into the flag.** Snapshot `payableQuote` (or the charge
   alongside total and tax) at :858 and compare the same three numbers at :914.
   Smallest change, keeps the contract's wording true.
2. **Redefine the flag in the contract** as "quote drift" and say so in §5.10,
   i.e. bless comparing `payableQuote`. Same runtime behaviour as (1), but the
   contract stops promising a food-price semantic it cannot deliver while C-7
   is open.
3. **Return both**, e.g. `priceChanged` (food/tax) plus `quoteChanged`
   (payable). Most explicit; costs a contract version bump.

W2 has no preference between these — only that the client can tell, from the
response alone, whether to re-read the number to the caller.

---

## D-2 — prep capacity never counts ASAP orders (fails OPEN)

### What the code does

Slot bookings are counted with a range filter on `scheduledFor`:

```js
// backend/src/api/routes/phoneOrders.js:178–185
const { start, end } = slotBoundsFor(when, cap.slotMinutes);
const booked = await prisma.phoneOrder.count({
  where: {
    companyId,
    routedBranchId: branchId,
    status: { in: ['SUBMITTED', 'ACCEPTED'] },
    scheduledFor: { gte: start, lt: end },
  },
});
```

But an ASAP submission never stores a time:

```js
// backend/src/api/routes/phoneOrders.js:569–576
let scheduledFor = null;
if (body.scheduledFor) { … }
const when = scheduledFor ?? new Date();
```

`scheduledFor` is persisted as `NULL` (:630) and SQL `NULL` never satisfies a
range predicate. So an ASAP order occupies no slot, ever.

### Why it matters

ASAP is the dominant path for phone orders. `booked` under-counts, the
`AT_CAPACITY` reason at `backend/src/lib/phoneOrders.js:202–206` can never fire
for ASAP traffic, and the seeded caps (CP 6, CH 2 per 15 min) are dead letters.
The failure direction is the unsafe one: the guard **fails open** and keeps
accepting into a kitchen that is already full, rather than refusing.

### Observed

QA run `20260924-140702`: the CH store's row read "0/2 booked this 15-min slot"
while two live `SUBMITTED` CH-routed orders sat inside that wall-clock window.
A direct DB read confirmed `scheduledFor IS NULL` on all three of that run's
orders. Evidence: `frontend/qa/screens/15b-capacity-asap-d2.png`, committed here
(from `x/vc104-ui` @ `f344ef4`).

### Suggested fixes — W1's call

1. **Anchor ASAP to its own slot:** persist `scheduledFor = now` on submission.
   One-line change; makes the column mean "when this order is due", which is
   what the counter already assumes. It changes the meaning of the stored value
   (an ASAP order becomes indistinguishable from one scheduled for now), so the
   `scheduled: Boolean(scheduledFor)` flag at :664 would need another source of
   truth — e.g. the explicit request field.
2. **Widen the count:** `OR (scheduledFor IS NULL AND createdAt >= start AND
   createdAt < end)`. Leaves the column's meaning alone; costs a slightly more
   complex query and an index worth checking.

Either way the `booked` number that reaches the UI starts moving on the ASAP
path, which is all the client needs.

---

## D-3 — a required modifier group makes a product unsellable by phone

**Created by the consolidation merge, not by either lane.** VC-104 deliberately
reuses the till's line-pricing function rather than copying it:

> Exporting beats copying — a second copy would drift the day this gains
> modifiers, and both paths must price identically.

That reasoning was right, and this is that day. On `x/vc104-api` alone,
`resolveCatalogLine(companyId, { productId, variantId, qty })` had no modifier
concept. In the consolidated tree it is VC-102's modifier-aware version, which
ends with:

```js
for (const g of activeGroups) {
  const count = perGroup.get(g.id) ?? 0;
  if (count < g.minSelect) {
    throw badRequest(`Choose at least ${g.minSelect} from "${g.name}"`, 'modifierOptionIds');
  }
```

`phoneOrders.js` still calls it with no `modifierOptionIds`. The `?? []` on the
chosen-ids line keeps that safe for products whose groups are all optional
(`minSelect: 0`), so most of the catalogue is unaffected — but for any product
carrying a group with `minSelect >= 1`, `count` is 0, the guard trips, and the
phone order is refused outright.

**Severity is held to Medium because it fails CLOSED.** Nothing is mispriced
and no money moves; a subset of the catalogue is simply not sellable over the
phone. The till path is unaffected — it supplies `modifierOptionIds` normally.

Required groups are a real shape in this codebase, not a hypothetical:
`backend/tests/promotions.test.js:794` builds one (`minSelect: 1, maxSelect: 1`).
Whether any *demo or production* product currently uses one is unverified here.

**The fix is W1's call**, and it is a feature decision rather than a patch: the
phone-order API needs a modifier field on its line items, at which point the
existing validation starts doing useful work for that path too. Passing an empty
array would not help — the guard would still trip. Skipping the guard for phone
orders would make the phone path price differently from the till, which is the
exact drift the export was chosen to prevent.

---

## D-4 — no VC-105 browser evidence for this tree, and the harnesses clobbered each other

Not a runtime defect. It is here because it is the kind of gap that reads as
green.

### What the merge did

`x/vc104-ui` and `x/vc105-ui` each shipped a Puppeteer harness into
`frontend/qa/`, and **both wrote their machine-readable output to the same
`qa/screens/results.json`**. Neither lane could see the collision: alone in its
own tree, each filename was unique. Consolidated, whichever harness ran second
overwrote the first — and the survivor still looks like a complete, passing run,
so the loss leaves no trace. The add/add conflict git raised on that file during
this merge is the only reason it was noticed at all.

### What was done here

Both recorded runs are preserved verbatim under lane-specific names, and each
harness now writes its own:

- `frontend/qa/screens/results-vc104.json` — 72/72, `at` 2026-09-24T14:19:48Z,
  ports 5382/5383. This is a real run, and §D-1's evidence rests on it.
- `frontend/qa/screens/results-vc105.json` — 47/47, **no `at` recorded**, ports
  5386/5387. `vc105-browser-qa.mjs` now stamps `at` so the next one cannot be
  mistaken for fresh.

The ambiguous shared `results.json` is deleted rather than resolved: in a
two-harness tree there is no honest answer to "which run is this".

### What remains open

**`frontend/qa/run-all.sh` still drives only the VC-104 harness.** VC-105's
needs `backend/scripts/vc105-seed-demo.mjs`, not the `run-seed.mjs` that script
calls — different fixtures, so it cannot simply be appended. Until someone wires
a second seed-and-run stage, **the VC-105 UI has no browser evidence against
consolidated code**, and the 47/47 in `VC105-UI-DELIVERY.md` is a statement
about the lane, not about this tree. It is quoted in the delivery doc with that
caveat attached rather than removed, because the run did happen.

The screenshots do not collide — the two lanes happen to use different
`NN-name.png` stems — but that is luck, not a scheme, and a third lane would
have to check.

### Update, later on 09-24 — the artifact changed, the gap did not

`frontend/qa/screens/results-vc105.json` now reads **48/48**, and the harness
beside it gained a real improvement: it hashes every screenshot at the end of a
run and fails if two are byte-identical, which is how it learned that
`01-owner-item-view.png` and `02-chart-and-coverage.png` had been the same
picture twice.

That is a better harness and a better run. It is still **not evidence about this
tree**, and the file says so itself: it carries **no `at` field**. The harness
now in the tree stamps `at` unconditionally on the same line it writes `passed`
and `total`, so a file with `passed` but no `at` cannot have come out of it —
`git show x/vc105-ui:frontend/qa/vc105-browser-qa.mjs | grep -c 'at: new Date'`
returns `0`, and `results-vc105.json` does not exist on that branch at all. The
48/48 therefore came from the lane harness, run in the lane, against a tree with
no VC-104 in it, and reached `main` only as a merge resolution (`513b2b0`).

This is D-4 recurring one level up, and it is worth naming as a pattern: **a QA
artifact is evidence about the tree that produced it, not about the tree it ends
up committed in.** The `at` stamp exists precisely to make that difference
visible, and it worked — this paragraph is the result of the stamp being missing
rather than of anyone remembering to ask.

So the open half of D-4 stands unchanged: until `run-all.sh` drives the VC-105
harness itself, against consolidated code and a `vc105-seed-demo.mjs` fixture,
the VC-105 row of the UI acceptance table is **owed, not passed**.

---

## D-5 — the catalog API could make a product unsellable and did not say so

> **FIXED 09-24**, on the owner's instruction, by option 1 below. The account
> that follows is left in the past tense as written, because the reasoning is
> what makes the fix reviewable. What changed is in **"The fix, as applied"** at
> the end of this section — including **two further ways in that only came to
> light while implementing it**, which the original write-up missed.

Found 09-24 while writing `backend/tests/catalogModifiers.test.js`, the first
tests to reach the modifier catalog routes over HTTP at all. Not created by any
merge: this has been true since modifiers landed.

### What the code does

`resolveCatalogLine` enforces a group's `minSelect` over **active** groups,
counting only **active** options (`orders.js:211–239`):

```js
const activeGroups = product.modifierGroups.filter((g) => g.status === 'ACTIVE');
for (const g of activeGroups) {
  for (const m of g.options) {
    if (m.status === 'ACTIVE') optionIndex.set(m.id, { group: g, option: m });
  }
}
```

Both filters are right on their own. Together they create a state the catalog
routes will happily write and nothing will warn about: **an ACTIVE group with
`minSelect >= 1` and no ACTIVE option in it.** Nothing can satisfy it, so every
line for that product is refused, on every channel.

Two ordinary edits reach it, neither of which looks dangerous:

1. **Archive the last active option.**
   `PATCH /products/:id/modifier-groups/:groupId/options/:optionId` with
   `{"status":"ARCHIVED"}` (`catalog.js:644–675`) counts nothing and checks
   nothing. Retiring "Whole milk" from a required *Milk* group of one is a
   one-click way to stop selling the product.
2. **Raise `minSelect` above the number of options that exist.**
   `PATCH /products/:id/modifier-groups/:groupId` (`catalog.js:585`) has exactly
   one cross-field check, `max != null && max < min`. When `maxSelect` is null —
   the default, and the commonest case — that check is skipped entirely and
   nothing compares `minSelect` against the option count. `minSelect: 3` on a
   group with two options is accepted.

### Observed (before the fix)

Both paths were pinned in `backend/tests/catalogModifiers.test.js`, in a
`D-5 tripwires` describe that no longer exists under that name — those two tests
are now the refusal tests described below, which is what a tripwire is for. Each
first **sold the product successfully**, so the later refusal was attributable to
the edit and not to a broken fixture:

```
TRIPWIRE: archiving the last active option of a required group makes the product unsellable
  sell → 201
  PATCH option {status: ARCHIVED} → 200          ← accepted silently
  sell with no modifiers → 400 'Choose at least 1 from "Milk"'
  sell with the archived option → 400 'Unknown or archived modifier option'

TRIPWIRE: minSelect may be raised above the number of options that exist
  PATCH group {minSelect: 3} on a 2-option group → 200
  sell with both options → 400 'Choose at least 3 from "Toppings"'
```

There is no third thing to try: the two refusals are the complete set of moves
available to a caller, so the product is stuck.

### Why it matters more than D-3

D-3 costs a channel — a required-modifier product cannot be sold *by phone*.
D-5 costs the product outright, on the till too, and it is reachable by a
customer doing normal menu maintenance rather than by a merge. The failure also
surfaces far away from its cause: the edit succeeds in the back office and the
refusal appears at the till, possibly days later, with a message that describes
the group rather than the edit that broke it.

Severity is held at Medium only because it fails CLOSED — nothing is mispriced
and no money moves.

### The escape hatch exists, but is not discoverable

Archiving the **group** does work, and that is tested here too ("archives a
group, and the order path stops enforcing it"): `activeGroups` drops it and the
product sells again. So the product is recoverable, by someone who knows that
archiving the group is different from archiving its last option. Nothing in the
API, the error, or any document said so before this one.

### The options that were on the table

1. **Refuse the edit** — 409 on archiving the last active option of a group with
   `minSelect >= 1`, and on raising `minSelect` above the active-option count,
   with a message naming the remedy ("archive the group instead"). Fails loud,
   at the moment of the mistake, in front of the person who made it. Costs a
   legitimate workflow: retiring a group option-by-option now has to archive the
   group first.
2. **Treat a required group with no active options as inactive** in
   `resolveCatalogLine`. Nothing to refuse, nothing to learn. But it makes a
   required choice vanish from the order and the receipt silently, which is the
   kind of quiet semantic change this codebase avoids elsewhere.
3. **Warn without blocking** — allow the edit, return the product with a flag
   the catalogue screen renders. Needs a UI that does not exist yet (see below).

**The owner chose (1)** on 09-24. It matches how the rest of this codebase
behaves, and it is the only one of the three that puts the message in front of
the person who can still change their mind.

### The fix, as applied

`backend/src/api/routes/catalog.js`. One helper, `assertSatisfiable`, holding one
invariant:

> **An ACTIVE modifier group must have at least `minSelect` ACTIVE options.**

Three properties of how it is written matter more than the rule itself:

- **It is checked against the RESULT of the write, not the payload.** Three of
  the four paths in send a body that is perfectly valid on its own and only goes
  wrong against what is already stored. That is exactly why a zod `.refine`
  cannot express this and the check is written longhand in each route.
- **409, not 400.** Nothing about the input is malformed; the request conflicts
  with the state of the group. `POS_CONFLICT`.
- **Every message names the remedy**, and a different one per route, because the
  way out is not guessable — archiving the *group* is fine and archiving its last
  *option* is not, and until now nothing in the API said so.

```
"Milk" would require 1 choice but only 0 are available, so the product could not
be sold. Archive the whole group instead, or lower its minimum first.
```

#### Four ways in, not two

Implementing the guard surfaced two paths the original write-up above missed.
Both were live. The count is now four, and all four are pinned by tests:

| # | Route | How you get there | In the original write-up? |
|---|-------|-------------------|---------------------------|
| 1 | `POST .../modifier-groups` | `minSelect >= 1` on creation — **a group is born with no options**, so the very first write is already unsatisfiable | **No** |
| 2 | `PATCH .../options/:optionId` | `{"status":"ARCHIVED"}` on the last active option | Yes |
| 3 | `PATCH .../:groupId` | `minSelect` raised above the active-option count | Yes |
| 4 | `PATCH .../:groupId` | `{"status":"ACTIVE"}` on a group whose options were all archived while it was away | **No** |

Path 1 is the awkward one, because it makes creating a required group a
**three-step job**: create it with no minimum, add the options, then raise the
minimum. That is a real cost to a legitimate workflow and the error message says
so explicitly, otherwise it reads as "required groups are banned". The test
helper `makeRequiredGroup` does those three steps, and the fact that it needed
writing is the honest measure of the friction added.

`POST .../options` needs no guard at all: it only ever raises the active count.

#### Deliberately strict about data that is already broken

A group that is *already* unsatisfiable — rows written by the old code — refuses
unrelated edits too, including a plain rename. This is intentional. Those rows
exist and nothing else will ever mention them; a refusal at the next edit is the
only moment anyone is looking. All four repairs stay open, because each ends in
a state that satisfies the rule:

- archive the group,
- lower `minSelect`,
- restore an archived option (the rule must never refuse the repair for the
  breakage it is reporting), or
- add a new option.

Each of those four is a separate test in
`describe('a group that was already broken before the guard existed')`.

#### Finding pre-existing violations

The guard stops new ones; it does not clean up old ones. This finds them:

```sql
SELECT p.id AS product_id, p.name AS product, g.id AS group_id, g.name AS "group",
       g."minSelect", count(o.id) FILTER (WHERE o.status = 'ACTIVE') AS active_options
FROM "ModifierGroup" g
JOIN "Product" p ON p.id = g."productId"
LEFT JOIN "ModifierOption" o ON o."groupId" = g.id
WHERE g.status = 'ACTIVE' AND g."minSelect" > 0
GROUP BY p.id, p.name, g.id, g.name, g."minSelect"
HAVING g."minSelect" > count(o.id) FILTER (WHERE o.status = 'ACTIVE');
```

Every row it returns is a product that cannot currently be sold. **Not yet run
against any live database** — that is a production read and this lane does not
touch production.

#### How the fix was verified

`backend/tests/catalogModifiers.test.js` went 40 → 51 tests; the whole backend
suite 628 → 639, all green, no other file's count moved. Green on the first run
is a claim, not evidence, so the guard was inverted three ways in a scratch
worktree:

| Control | Perturbation | Tests that caught it |
|---------|--------------|----------------------|
| 1 | `assertSatisfiable` made a no-op | 6 |
| 2 | `countActive` counts ARCHIVED options too — the most plausible wrong implementation | 3 |
| 3 | the availability count hardcoded in the message | 1 |

Control 2 is the one that matters: it proves the tests distinguish ACTIVE from
merely-existing options, which is the entire content of the bug.

#### What this does not settle

D-3 is still open. It asks the neighbouring question — *what should happen when a
required group cannot be satisfied **by a particular channel***  — and this fix
does not answer it. A group with two active options is perfectly satisfiable and
still unsellable by phone.

### Note on how this went unnoticed

`grep -rn "modifier-groups" frontend/src/` returns nothing. **There is no
modifier management UI** — these four routes are API-only, so no screen, no
browser QA and, until now, no test has ever exercised them. The order side of
modifiers is covered well (`promotions.test.js`, `describe('modifier
treatment')`), which is what made the gap easy to mistake for coverage: the
tables were proven, the product was not. Every one of those tests builds its
groups with `prisma.modifierGroup.create`, never through a route.

---

## D-6 — archiving a promotion burns its code, permanently

Found 09-24 by searching for D-5's shape in the other 24 route files. Like D-5,
it is not the merge's doing: it has been true since promotions landed.

### What the code does

The three lifecycle transitions are generated by one factory
(`promotions.js:324–349`) and registered as three routes:

```js
// backend/src/api/routes/promotions.js:351–353
transition('publish', ['DRAFT', 'PAUSED'],              'PUBLISHED', 'PROMO_PUBLISH');
transition('pause',   ['PUBLISHED'],                    'PAUSED',    'PROMO_PAUSE');
transition('archive', ['DRAFT', 'PUBLISHED', 'PAUSED'], 'ARCHIVED',  'PROMO_ARCHIVE');
```

`ARCHIVED` appears in no `from` list, so it is terminal by construction — that
much is deliberate, and fine. The other three write routes agree:

```
promotions.js:196  PATCH /:id          → 409 'An archived promotion cannot be edited'
promotions.js:229  PUT   /:id/stores   → 409 'An archived promotion cannot be edited'
promotions.js:281  PUT   /:id/rules    → 409 'An archived promotion cannot be edited'
```

So far this is just "archive is final". The defect is what happens when the
operator does the obvious thing next and **re-creates the offer**:

```js
// backend/src/api/routes/promotions.js:167–172
const dup = await prisma.promotion.findUnique({
  where: { companyId_code: { companyId: req.companyScope.id, code: body.code } },
  select: { id: true },
});
if (dup) throw conflict(`Code ${body.code} is already in use`);
```

That lookup has **no status filter**, and neither does the constraint behind it:

```sql
-- prisma/migrations/20260924120000_promotions/migration.sql:104
CREATE UNIQUE INDEX "Promotion_companyId_code_key" ON "Promotion"("companyId", "code");
```

No partial index, no `WHERE status <> 'ARCHIVED'`. The archived row keeps its
code for ever. The code cannot be freed by editing the archived promotion
(`:196` refuses), cannot be brought back by republishing it (`:351` refuses),
and cannot be taken by a new promotion (`:167` refuses). Three refusals, no
fourth move — the same closed set D-5 has.

### Why it matters

The trigger is ordinary campaign maintenance: *this offer is over, archive it*.
A month later the same campaign runs again and `DIWALI20` cannot be recreated,
with an error that names a promotion the operator can no longer see in any
active list. The till-facing consequence is that a printed or advertised code is
dead for the company's lifetime.

Scope is narrower than D-5 — one code per mistake, not a product — and it fails
CLOSED: nothing is mispriced, no money moves, and applied redemptions are
unaffected because `PromotionRedemption` snapshots name, code, version and
amount at apply time (`orders.js:909`). Hence Medium, not High.

Uncoded promotions (`code` is `String?`, null = "pick from the list") are not
affected: Postgres allows many NULLs under a unique index, and re-creating an
uncoded offer is just a new row.

### Evidence it is unexercised

Both halves of D-5's shape hold, which is why this survived:

```
$ grep -rn "promotions" frontend/src/
frontend/src/lib/vc105.js:115:    hint: 'High margin but few buyers — a promotion candidate.',
```

One comment, no call. **There is no promotion management UI** — all six routes
in `promotions.js` are API-only. And in `backend/tests/`, `promotions.test.js`
does reach the others over HTTP (`/publish` ×2, `/pause` ×1, `POST /`, `GET /`,
`PATCH /:id`, `PUT /:id/stores`, `PUT /:id/rules`), so the file is not the
problem — `archive` alone is never called:

```
$ grep -rn "archive" backend/tests/promotions.test.js
(no output)
```

A corroborating detail, and the reason to trust that nobody has ever walked this
path: the refusal message is built as `` `A ${status.toLowerCase()} promotion
cannot be ${action}d` `` (`:332`). It was written for verbs ending in *e* —
`pause`→`paused`, `archive`→`archived`. For `publish` it renders **"A archived
promotion cannot be publishd"**. A malformed article and a missing *e*, in the
one sentence a stuck operator is shown. Any HTTP test on this route would have
put that string in an assertion.

### Status of the claim

Every line above is a quotation of the committed source and the migration SQL in
this tree. Unlike D-5, **no test pins this** — the sweep that found it was
research only, and no tripwire was added. So D-6 is proven by reading, not by
running; the closed set of three refusals follows from the three cited guards
rather than from an observed run. That is a weaker standard than D-5's and is
recorded as such deliberately.

### Suggested fixes — not applied, this is a product decision

1. **Scope the constraint to live promotions.** Replace the index with a partial
   unique index (`WHERE status <> 'ARCHIVED'`) and add the same filter at
   `:167`. Archiving then releases the code, which is almost certainly what an
   operator expects. Costs a migration, and means two promotions can share a
   code across time — reporting that groups by code has to group by id instead.
2. **Free the code on archive** — null it out in the `transition` write when
   `to === 'ARCHIVED'`, keeping it in the audit `meta`. No migration, no
   constraint change; but the archived row stops being a faithful record of what
   was offered, which is the kind of quiet history edit this codebase avoids.
3. **Say so in the refusal.** Leave the behaviour and make `:167` name the cause
   — "Code DIWALI20 belongs to an archived promotion and cannot be reused". The
   operator is still stuck, but stuck knowingly, and the support path is short.
   Cheapest, and it pairs with fixing the `publishd` typo at `:332`.

(1) is the one that matches how the rest of this codebase behaves — D-5's
suggested fix (1) refuses at the moment of the mistake; here there is no mistake
to refuse, so the equivalent move is to stop manufacturing the dead end.

---

## 3. Why the phone-order suite stays green on both

**No existing assertion pins either bug, so fixing them should not turn the
suite red.** What is missing is coverage, and in D-1's case it is missing by a
single line.

### D-1 — the conditions are already built; nothing reads the flag

`backend/tests/phoneOrders.test.js:516`, *"moves the order and recomputes price
and tax for the new store"*, already sets up **exactly** the case that breaks:

| Line | What it establishes |
|---|---|
| :519 | `deliveryCharge` is 40 before the move |
| :529 | `deliveryCharge` is 60 after the move — *"The second store charges 60 for the same pincode"* |
| :535–536 | `order.total` is still 420 and `taxAmount` still 20 — *"Same catalog, so the food total is unchanged"* |

Those three facts are the defect: `payableQuote` goes 460 → 480 while both terms
of `priceChanged` stay equal, so the flag is `false` on a move the caller must be
re-quoted for. The test simply never reads `res.body.priceChanged`, and the word
appears nowhere else in the file. Adding

```js
expect(res.body.priceChanged).toBe(true);
```

to that test reproduces D-1 without any new fixture — and the test's own comment
at :533–534 already states the C-7 premise that makes the flag structurally dead.

### D-2 — covered only on the path that works

The one capacity test — *"refuses a store whose prep slot is already full"*,
`phoneOrders.test.js:300` — books its filler with an explicit
`scheduledFor: when.toISOString()` (:305) and queries with the same explicit
time (:311). It therefore exercises the branch where the filter matches and
never the ASAP branch where it cannot. A test that submits N **ASAP** orders
into a store with `maxOrdersPerSlot = N` and then expects `capacity.booked: N`
and `AT_CAPACITY` would have caught this on the day; it is the one addition
worth making before the fix.

This is also why the lane's recorded 455/455 was never evidence against either
defect — a green suite certifies what it asserts, and neither of these was
asserted.

## 4. Reproduction

Environment recipe: `docs/VC104-SETUP.md` for the backend alone, or
`docs/VC104-UI-DELIVERY.md` §6 for the browser path — both are in this tree
(lane DBs, ports, seeded stores, and the env-var names for credentials; no
secrets are written down in either). Run the backend against a scratch DB with
the lane seed, then:

- **D-1:** submit a DELIVERY order routed to the first store, reassign it to the
  second (whose service area for the same pincode carries a different delivery
  charge), and read the response: `payableQuote` changes, `priceChanged` is
  `false`.
- **D-2:** submit two ASAP orders routed to a store with a seeded cap of 2 per
  15 min, then call `check-stores` with no `scheduledFor`: the option reports
  `capacity.booked: 0` and stays available.

Neither needs the UI; both are visible in the raw JSON.

## 5. What W2 did meanwhile (so W1 knows what to undo)

Both changes are W2's frontend work, not changes to the backend they describe:

- **For D-1**, `frontend/src/pages/PhoneOrders.jsx:606–614` raises the re-price
  banner on `priceChanged || payableQuote !== previous payableQuote` — an
  inequality between two server-computed numbers, no client-side money
  arithmetic. Once D-1 is fixed this stays correct; it can be simplified back to
  the flag alone if W1 prefers.
- **For D-2**, QA §11 proves the capacity UI on the **scheduled** path and pins
  the ASAP hole as an explicit tripwire check (screenshot `15b`). That check is
  written to **FAIL the day the semantics change**, and its failure note says to
  retire the pin and re-prove ASAP with real fillers. A red `15b` after a
  capacity fix is the expected, welcome outcome — not a regression.

## 6. What this report does not claim

W2 did not run W1's test suite, did not modify W1's code, and does not certify
the 455/455 figure recorded in `docs/lanes/VC104-API.md` (that lane holds no
on-disk log for the run). Everything above is either a direct quotation of the
committed source at `c40683b` or an observation from W2's own browser-QA runs,
whose evidence is committed here (from `x/vc104-ui` @ `f344ef4`).

D-1 and D-2 were reported against `c40683b` and are **still unfixed** in this
consolidated tree — the merge carried them forward untouched, as W2 wrote them.
D-3 is the merge's own doing and is likewise unfixed. None of the three is
pinned by an assertion, so the phone-order suite's 41/41 here says nothing about
them either way.

D-4 is half fixed: the evidence files no longer overwrite each other, but no
VC-105 browser run has been executed against this tree, so that row of the UI
acceptance table is **OWED, not passed**. The 48/48 that appeared on `main`
later on 09-24 does not change that — see the update under D-4 for why the
missing `at` field settles its provenance.

D-5 is **FIXED** (09-24, owner's instruction, option 1). It is also the only
entry here whose history can be read off the test file: it was pinned by two
TRIPWIRE assertions recording the broken behaviour, the fix broke both, and they
were rewritten as the refusal tests they were always meant to become. The four
paths in are now all refused with a 409 that names the remedy, verified by three
separate inversions of the guard rather than by the fact that the suite went
green. Full account, including the two paths the original investigation missed,
is in the D-5 section.

What the new test file does **not** claim: it proves the four modifier catalog
routes behave as written, not that the behaviour is the product anyone asked
for. There is no modifier management UI to compare them against, and no
acceptance criterion in the contract beyond §5.1's one line. One tripwire
remains, and says so at the assertion. The D-5 fix has a **workflow cost** that
no test can judge: creating a required modifier group is now three API calls
instead of one, and if that turns out to be wrong for real menu maintenance, it
is option 3 in the D-5 section that should be revisited, not this guard.

D-6 is **unfixed and unpinned**. It is the one entry here with no test of any
kind behind it — see "Status of the claim" under D-6 for what that does and does
not establish.

---

## 7. The sweep that found D-6 — and what else it turned up

D-5 hid because of two properties at once: no frontend caller, and no HTTP-level
test. Either alone is common; together they mean a route is exercised by
nothing. All 25 files in `backend/src/api/routes/` were checked against both.

**Both properties — four routes.** Only D-6 reaches an unguarded state.

| Route | Where | Verdict |
|---|---|---|
| `POST /api/promotions/:id/archive` | `promotions.js:353` | **D-6** — one-way door, code burned |
| `PATCH /api/atc/licenses/:licenseId/status` | `atc.js:230` | Reversible (the route also accepts `ACTIVE`), so no trap. Widest blast radius on this list — it flips every `requireUsableLicense` route for a tenant. It is also the only route in `atc.js` that loads its target by bare id with no company scope; safe today only because of `router.use(requirePosAuth, requireAtc)` at `:16`, and nothing pins that |
| `GET /api/kitchen/stations` | `kitchen.js:88` | Untested only. The file's four `/stations` test hits are all POSTs. Worth one look: it is the one route in the file carrying no role guard, unlike its `...managerUp` / `...operate` siblings — but it is a read |
| `GET /api/devices/:id` | `devices.js:147` | Untested only. The Devices page lists via `GET /devices` and never fetches one by id |

**One property, not both — not D-5's shape, but worth knowing.**

*UI-less but HTTP-tested* (so a suite would catch a regression): all 12 routes in
`printing.js`, the rest of `kitchen.js`, promotions' other five, and `orders.js`
`POST`/`DELETE /:id/promotions`.

*Browser-reachable but with no HTTP test* (so QA can at least see them): every
route in `devices.js`, `terminals.js`, `brands.js`, `regions.js`,
`legalEntities.js` and `gstRegistrations.js` — `grep -rn "/api/devices"
backend/tests/` and its five siblings all return nothing — plus `POST
/auth/change-password`, `GET /orders/:id/kots`, `PATCH` and `DELETE
/catalog/products/:id/variants/:variantId`, and `PATCH` and `DELETE
/tables/:id`. This is a real coverage hole and the larger one by route count; it
is recorded here rather than filed as a defect because none of it is a *defect*
— no unguarded state was found in any of it, and browser QA can reach all of it.
