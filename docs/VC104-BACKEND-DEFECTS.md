# VC-104 backend defects found by W2's browser QA — report for W1

**From:** W2 (frontend lane `x/vc104-ui`) · **To:** W1 (backend lane `x/vc104-api`)
**Date:** 2026-09-24 · **Line numbers are `x/vc104-api`'s, at `c40683b`**

Two defects in the phone-order backend. Both were found from the outside, by
driving W1's API through a real browser against W2's own database — not by
reading the code, and not by running W1's test suite (W2 does not run another
worker's tests). The backend is W1's to change, so this report exists to make
the fix a decision W1 takes with the evidence in hand.

> **Status, 2026-09-24 — this opening no longer describes the tree.** It was
> written as "two defects, neither fixed". The register below has since grown to
> six, and four of them are fixed here: **D-1, D-2, D-3 and D-5**. D-4 is
> process rather than runtime. **D-6 is pinned but deliberately unfixed**,
> pending an owner decision that no VC-102 spec settles. ~~One D-2 limitation
> survives its own fix and is recorded rather than closed~~ — **that limitation
> was closed on 09-25**, along with the TOCTOU race recorded beside it; see
> *The limitation is closed*. Line numbers cited for the **fixed** defects are this tree's; the
> unfixed ones still read against `c40683b`, so check which of the two a
> citation is following before trusting it.

> **Consolidation note (`merge/a406-consolidate`, 2026-09-24).** This report was
> written twice, once per lane, each copy describing the other lane in the third
> person. Both lanes are now in this one tree, so those references have been
> rewritten to point at paths rather than at branches: the backend it cites and
> the QA evidence it rests on are both present here. A third defect, D-3, was
> added by the merge itself and is marked as such.

| # | Defect | Effect | Severity | Where |
|---|--------|--------|----------|-------|
| D-1 | ~~`priceChanged` on reassign ignores the delivery charge~~ **FIXED 09-24** | The caller was re-quoted nothing on exactly the moves that changed what they pay — and since food and tax cannot move on a reassign at all, the flag could never be true | Medium — quote-facing, not billing (the charge is not billable while C-6 is open) | Fix: `payableQuote` captured before and after via `buildQuote`, `phoneOrders.js:930,988,995` |
| D-2 | ~~Prep capacity never counts ASAP orders~~ **FIXED 09-24**; ~~one limitation recorded~~ **that limitation CLOSED 09-25** | The kitchen-full refusal was dead on the dominant path; the guard failed OPEN | High for the feature's purpose — no money impact | Fix: booked-count widened to ASAP orders by `createdAt`, `phoneOrders.js:197`. The surviving hole — an order **reassigned after its own slot elapsed** occupied nothing — is closed by anchoring a moved order to the slot it *arrives* in, with no new column; see *The limitation is closed (09-25)* |
| D-3 | ~~Phone orders cannot sell a product with a REQUIRED modifier group~~ **FIXED 09-24** | Such products were refused on the phone path with "Choose at least N"; the caller could not complete the order | Medium — failed CLOSED, so no mispricing; a catalogue subset was simply unsellable by phone | Fix: `modifierOptionIds` on `phoneOrders.js` `itemsSchema`, plus the three places that had encoded "modifiers cannot arrive here" |
| D-4 | No VC-105 browser evidence exists for this tree, and the two QA harnesses used to overwrite each other | Process, not runtime: a VC-105 UI regression would ship unseen | Medium — no customer impact; blocks the UI acceptance row | `frontend/qa/run-all.sh`, `frontend/qa/vc105-browser-qa.mjs` |
| D-5 | ~~The catalog API can leave a required modifier group permanently unsatisfiable~~ **FIXED 09-24** | The product became unsellable on **every** channel, till included, with no warning at the moment of the edit | Medium — fails CLOSED like D-3, but unlike D-3 it was reachable by an ordinary catalogue edit | Fix: `assertSatisfiable` in `backend/src/api/routes/catalog.js`, three call sites |
| D-6 | Archiving a promotion permanently burns its code | The code cannot be republished, edited, or reused by a new promotion — the offer is unrecoverable and the till's code stops working for good | Medium — fails CLOSED, no mispricing; one code per mistake, not the catalogue | `backend/src/api/routes/promotions.js:353` with `:196`, `:229`, `:281`, `:167–172`. **Open, now pinned** by `promotions.test.js`; unfixed pending an owner decision — no VC-102 spec exists to settle intent |

§3 is the part worth reading first, and the sentence that made it worth reading
— **the phone-order suite already built D-1's exact conditions and simply never
looked at the flag** — is what let the defect survive a passing suite. Both are
now fixed and pinned (09-24); the original accounts below are kept unedited, and
each carries a dated *Fixed* subsection at its end.

**D-3 and D-4 did not exist in either lane alone — the consolidation merge
created both** (09-24, `merge/a406-consolidate`). They are recorded here because
this is where a VC-104 reader will look, not because W2's browser QA found them.

**D-5 is older than all of them** and was found later, on 09-24, while writing
the first HTTP-level tests for the modifier catalog routes
(`backend/tests/catalogModifiers.test.js`). It is filed here because it is the
other half of D-3's question — *what should happen when a required modifier
group cannot be satisfied* — and the two looked best answered once, together.
**Both were then fixed the same day** on the owner's instruction, D-5 first and
D-3 straight after. The full accounts are kept rather than deleted, because in
each case implementing the fix found more than the investigation had: D-5 had two
more ways into the bad state than were written up, and D-3 had three more places
to change — and unlike the reported symptom, all three of those fail *silently*.
The pattern is worth naming, since it caught the same author twice in one day:
**a write-up enumerates the paths that a failing test happened to walk, not the
paths that exist.** Both fixes were sized by grepping every route that writes the
fields named in the invariant.

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

### Fixed 09-24 — option 1, and the defect was worse than reported

`before` now captures the payable alongside total and tax
(`phoneOrders.js:930`), the same figure is rebuilt from the updated row after
the write (`:988`), and `priceChanged` compares all three (`:995`). Both
payables come out of `buildQuote`, not out of arithmetic repeated here, so the
flag keeps reporting whatever the operator is actually reading to the caller —
including after C-6 closes and the charge stops being quoted beside the order.

**What the write-up understated.** It said the flag is false "on exactly the
moves that change what they pay", which reads as *sometimes* wrong. It is
stronger than that: `total` and `taxAmount` are the only two things the old
expression looked at, and **neither can move on a reassignment at all.** The
catalog is company-wide (C-7) and each line's tax rate and unit price are
snapshotted onto the row at submit, so `recomputeOrder` re-derives the same
numbers from the same rows whichever store it is called for — `TaxRate` is
company-scoped (`schema.prisma:494`) and carries no branch dimension. So
`priceChanged` was not an inaccurate flag. It was a **dead** one: false on every
reassignment that has ever run, including the ones that cost the caller more.

Pinned by two tests, deliberately in opposite directions:

| test | asserts | why it exists |
|---|---|---|
| `reports a price change when only the delivery charge moved (D-1)` | payable 460 → 480, `priceChanged` **true** | the defect itself |
| `stays quiet when the move costs the caller nothing (D-1 control)` | both stores at ₹40, payable 460 → 460, `priceChanged` **false** | a flag hardwired to `true` passes the first test and is just as useless; the operator would re-quote every caller and learn to ignore it |

Before the fix the first test failed `expected false to be true`. The existing
test above it already built those exact conditions and simply never read the
flag — which is how the suite stayed green through 41, then 52, tests.

**The contract needs no version bump.** Option 2's concern was that §5.10
promises a food-price semantic; the fix keeps the total and tax comparisons
intact and only *adds* the payable, so nothing the contract already promises has
changed meaning. Option 3 (`priceChanged` plus a separate `quoteChanged`) stays
available if W1 later wants the two signals split.

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

### Fixed 09-24 — option 2, chosen over option 1 on purpose

The booked-count now reads (`phoneOrders.js:197`):

```js
OR: [
  { scheduledFor: { gte: start, lt: end } },
  { scheduledFor: null, createdAt: { gte: start, lt: end } },
],
```

An ASAP order is counted against the slot it was **taken** in. Option 1
(persisting `scheduledFor = now`) was rejected because the write-up's own
caveat is the decisive one: it would make an ASAP order indistinguishable from
one scheduled for now, and `scheduled: Boolean(scheduledFor)` has no other
source of truth to fall back on. Option 2 leaves the column's meaning alone.

**On the index question the write-up left open:** no new index is needed. The
selective predicates — `companyId`, `routedBranchId`, `status` — are unchanged
and already covered by `@@index([companyId, routedBranchId, status])`; the new
`OR` only re-filters rows already narrowed to one store's live orders, so the
access path is the same one the query used before.

**This is a behaviour change, not only a reporting fix.**
`loadBranchDecision` feeds three callers — branch-options (`:544`), submit
(`:644`) and reassign (`:907`) — and the last two both enforce
`if (!chosen.available) throw branchUnavailable(...)`. So a full ASAP slot now
genuinely refuses new orders where it previously waved them through. That is
the repair of a fail-open guard working as intended, but it will be visible to
operators the first time a kitchen fills up.

**Expected consequence elsewhere:** §5 below pins the ASAP hole as tripwire
check `15b` in the vc104-ui QA harness, written to fail the day the semantics
change. That day is today. A red `15b` is the welcome outcome described there,
not a regression — the pin should now be retired and ASAP re-proved with real
fillers.

Pinned by three tests. Reverting the `OR` to the old single-term filter turns
each of them red **on its own assertion**, not on a fixture:

| test | inverted-guard failure |
|---|---|
| `counts ASAP orders against the slot as well (D-2)` | `expected +0 to be 1` — the booking is invisible to the counter |
| `counts a reassigned ASAP order against the slot it was taken in (D-2)` | `expected 200 to be 409` — a full kitchen accepts a transfer |
| `does NOT count an ASAP order moved after its slot elapsed (D-2 limitation)` | `expected +0 to be 1` — see below |

The sibling scheduled-path test continues to prove the other branch, and books
an hour ahead, so the two do not interfere.

#### What this does not settle

**A reassignment can still overfill a kitchen, and this fix does not stop it.**
An ASAP order is anchored to its `createdAt`, but the reassign handler checks
the target against `when = po.scheduledFor ?? new Date()` (`phoneOrders.js:892`)
— the slot containing *now*. Move an order after its own slot has elapsed and
the two no longer agree: it passes into the new store without occupying
anything there. Measured, with a cap of 2 and one order taken natively:

```
3 late transfers accepted → 4 live orders at the store, reported booked = 1, available = true
```

Three things about that, in order of importance:

1. **It is not a regression.** Before this fix the same store reported `booked:
   0` and accepted everything, native orders included. The guard has gone from
   blind to partially sighted, not the other way round.
2. **The common case is covered**, and that is what the second test above
   proves: an order taken and moved within the same slot *does* count, and the
   store refuses the next one. A transfer minutes after the call — the ordinary
   operator action — is handled.
3. **Closing it needs a slot anchor that survives a move** and is distinct from
   both `createdAt` and `scheduledFor`; re-stamping either one destroys
   information the rest of the route depends on (the same objection that ruled
   out option 1). So it is recorded and pinned rather than quietly fixed, and
   the test above states today's behaviour without endorsing it — it goes red
   the day someone adds the anchor, and points here.

   > **Corrected 09-24, later the same evening — this said "a schema decision,
   > not a patch", and that was wrong.** A concurrent session working the same
   > item pointed out that **the anchor is already written**: every reassign
   > creates a `PhoneOrderEvent` with `action: 'REASSIGNED'`, `toBranchId` and
   > `at @default(now())`, inside the *same transaction* as the
   > `phoneOrder.update` (`phoneOrders.js:939–965`), so it cannot be missing for
   > any moved order. "When was this store asked to make this order" is
   > therefore derivable today — the `at` of the latest `REASSIGNED` event whose
   > `toBranchId` is the order's current `routedBranchId`, falling back to
   > `createdAt` — with no migration. I verified the model and the transactional
   > write before accepting it. The correct statement is that this is a **read
   > change of unknown cost**, not a schema change: the per-order lookup is
   > indexed (`@@index([phoneOrderId, at])`), but the capacity count is a query
   > over many orders in a slot, and whether that stays cheap is the open
   > question. Being tried on branch `x/vc104-slot-anchor`; this paragraph
   > should be replaced by its result rather than left as a second guess.
   >
   > **Result, 09-25 — the peer was right about the anchor and right to worry
   > about the cost.** The anchor needed no column, exactly as argued. The cost
   > question had a real answer and it was **no, it did not stay cheap**: written
   > as one `COALESCE` and filtered on directly, the count cost **82 ms** at 120k
   > orders against **10 ms** for the old (wrong) `createdAt` query, and an index
   > could not help it — a correlated subquery in the filter is evaluated per row
   > of the store's history. Rewritten as three disjoint UNION arms it indexes
   > properly and lands at **14 ms**. Both the anchor and the cost are settled
   > below; this paragraph is kept because the question it asked was the right
   > one and is what prompted the measurement.

**The TOCTOU race is unchanged.** Two concurrent submits into the last free slot
both read `booked = n-1` and both pass. It predates this fix and is equally true
of the scheduled path, so the change neither causes nor worsens it — but the
guard is now load-bearing on the path nearly every caller takes, which raises
the odds of someone reaching it. A fix means a transactional re-check or a
unique constraint on (store, slot, sequence), neither of which is in scope here.

#### The limitation is closed (09-25) — and so is the TOCTOU race beside it

Both paragraphs above are now out of date. They are left standing because the
reasoning in them is what the fix had to answer.

**The rule.** A store's slot is consumed by the moment *that store* was asked to
make the order, which is not always when the caller rang:

| order | anchor | why |
|---|---|---|
| scheduled | `scheduledFor` | the caller named the time; a transfer does not change it |
| ASAP, taken here | `createdAt` | the call *is* the request |
| ASAP, moved here | `at` of the latest `REASSIGNED` event into the current branch | the new kitchen was asked at the moment of the move, not at the moment of the call |

The third line is the fix. A back-dated or overdue transfer now lands in the
slot it **arrives** in, so it occupies a place there and can be refused.

**No new column.** The anchor is derived, exactly as the peer argued — the
`REASSIGNED` event is written in the same transaction as the `routedBranchId`
update, so it cannot be missing for a moved order. `scheduledFor` is validated
strictly future, so `anchor >= createdAt` holds by construction. The only
schema change is **two additive indexes** (below); no column, no backfill.

**Boundaries and timezone.** Slots are half-open `[start, end)`, so an order
anchored exactly on a boundary belongs to the slot that is *opening*, never to
the one that is closing — otherwise two adjacent slots both count it. Anchors
are `timestamptz` and all comparison is in UTC; the IST business day only enters
when the grid's origin is chosen. Three tests pin the boundary, **one per arm**,
because the arms each carry their own copy of the `<` and a single test only
ever exercised one of them (see the mutation results).

**Atomicity.** `reserveSlot` takes a Postgres advisory lock on
(company, branch, slot) *inside* the caller's transaction and re-counts behind
it, so check-and-reserve is one critical section. The reassign handler re-checks
inside its own transaction rather than trusting the earlier read. A refused
transfer throws before any write, so the source order keeps its branch, its
status and its reservation — the refusal is a no-op, not a partial move.

That last sentence was, until it was checked, an argument from reading the code:
every capacity test watched the *destination*, and none of them would have
noticed a refusal that had already repointed `routedBranchId`, flipped the
status, or written the `REASSIGNED` event before throwing. It is now asserted —
*leaves the source order, its status and its event log untouched when refused* —
including `updatedAt`, because Prisma stamps that on any write to the row, so an
unchanged `updatedAt` rules out a write that was subsequently corrected rather
than merely a net-zero outcome. The stray-event case matters more than it looks:
the slot anchor **reads** that event, so a half-written move would not just
mis-report a refusal, it would silently re-anchor the order to a store it never
reached.

The guarantee rests on the check sitting inside the transaction, so the control
for it has to keep the refusal and destroy only the atomicity. That is mutant
**M10**: the check is hoisted out and run after the transaction commits, so the
caller still gets `409 AT_CAPACITY` and the order is refused *and* moved. Adding
it required teaching the battery to apply **multi-point** mutations, because a
guard cannot be moved out of a block with a single substitution.

**And adding it immediately found that the atomicity was never actually
tested.** M10 escaped. So did **M3** — deleting the in-transaction `reserveSlot`
outright left the suite **completely green, zero tests red**. One root cause
behind both:

> Every capacity test fills the destination *before* the request. A destination
> that is already full is refused by the **advisory** read in
> `loadBranchDecision`, which runs *before* the transaction opens
> (`phoneOrders.js:986`). So no test ever reached the binding check, and the
> source-preservation test above was passing on an advisory refusal — proving
> something true, but not the thing it was written for.

M3 had appeared CAUGHT on earlier runs, by *lets exactly one of two simultaneous
transfers take the last place*. That was **luck**, and the source already said
so: `reserveSlot`'s own comment records that two reassigns fired with
`Promise.all` enter 28 ms apart and never overlap, so an HTTP-level race passes
with or without the lock. A detector that depends on scheduling is not a
detector. Recorded plainly because the earlier "10/10" in this document was
taken with that flake live.

The fix is one test that forces the transactional path — *re-checks capacity
inside the transaction, after the advisory read said yes*. The slot is filled
**after** the advisory read and **before** the re-count, deterministically
rather than with a sleep: a concurrent transaction takes the slot lock and
inserts the filling order **without committing**, so the advisory read (READ
COMMITTED, and it takes no lock) still sees room; the request then queues on the
lock inside its own transaction; and the handoff is **a waiter appearing in
`pg_locks`**, not a timer. If the binding check is missing there is never a
waiter, so the test fails loudly rather than passing by accident — which is what
makes it a control for M3 and M10 both.

The run that first included it is worth recording, because it shows the battery
doing the job it exists for. M3 and M10 came back **ESCAPED again** — with the
new test **red in both**. The battery does not ask "did anything go red"; it
asks "did *the named* test go red", and both were still pointing at detectors
that cannot reach the mutated lines. So the escapes were real and the correction
was to the prediction, not to the threshold: each now names the binding test,
and each carries a comment saying what the old name was and why it could never
have worked. A battery whose pass condition is "some test failed" would have
called this fixed one run earlier and been wrong about which test was load-bearing.

**Retry and replay.** Submit is unchanged: `idempotencyKey` returns the first
result without counting twice. **Reassign has no idempotency key**, so an
operator's double-click is two genuinely separate requests, and the two cases
differ:

- the first attempt **failed** — it was refused before any write, so there is
  nothing to undo and the retry starts from the same state;
- the first attempt **succeeded** — the retry is a move to the branch the order
  is already on, and is refused `400` ("already routed there") rather than
  counted again.

The test asserts the count after each, and also that exactly **one**
`REASSIGNED` event into the destination exists — so the count cannot double even
in principle, independently of how the route happens to reply.

**Cost — the peer's open question, answered.** Measured against the real
`countBookedInSlot` (imported, not a copy of its SQL), one store, 120k orders of
history, median of 7 including Prisma overhead:

| form | ms |
|---|---|
| old count by `createdAt` alone (wrong, the speed everyone was used to) | 10.0 |
| anchor as one `COALESCE`, filtered directly (correct, unindexable) | 82.3 |
| **three disjoint UNION arms, as shipped, no index** | 14–17 |
| **as shipped, with the two indexes** | **4.0** |

The `COALESCE` form is 8x the cost of the wrong answer and **an index does not
help it at all** — the correlated subquery sits in the filter, so it is
evaluated once per row of the store's history. That history is the reason the
number matters: **`PhoneOrderStatus` has no terminal state**, so an ACCEPTED
order stays ACCEPTED forever and the candidate set is everything the store has
ever taken, growing without bound. `loadBranchDecision` runs this once per
candidate branch, so a five-store company pays it five times per call.

Splitting the anchor into three arms that partition the same way `COALESCE`
does makes each arm's predicate indexable, which is what recovers the cost. The
two unindexed numbers (14.1 and 17.0) are separate medians of the same
configuration — treat the spread as the noise floor of this probe, not as a
result.

**Migration impact.** `20260924800001_vc104_slot_count_indexes` — two
`CREATE INDEX`, nothing else. Additive, no column, no data change, no backfill;
rolling back is a `DROP INDEX`. **It has not been applied to any production
database from this work.** The migration file carries a deployment note that
matters more than its size: plain `CREATE INDEX` takes a SHARE lock that blocks
INSERT/UPDATE/DELETE on the table until it finishes, and `CREATE INDEX
CONCURRENTLY` cannot be used because Prisma wraps each migration in a
transaction. On a large `PhoneOrder` table the two statements should be run by
hand with `CONCURRENTLY` and the migration marked applied, rather than pausing
writes on the phone-ordering path.

Only one of the two indexes carries the improvement, and the doc says so: the
`PhoneOrder` index alone takes 17.0 → 6.4 ms, the `PhoneOrderEvent` index alone
only 17.0 → 14.6 ms. Both are kept because together they reach 4.0 ms, but the
event index is the marginal one.

#### Results as observed, 09-25

Numbers below are what the runs printed, not what was expected of them.

| gate | result |
|---|---|
| `tests/phoneOrders.test.js` (focused) | **71 passed / 71** |
| backend full suite, `vitest run` | **675 passed / 675**, 22 files, exit 0, 141.25 s |
| mutation battery, `scripts/vc104-slot-mutants.mjs` | **11/11 enforced caught**, 2 predicted escapes (M8/M9) — `PASS`. The preceding run was `9/11`; both escapes and the correction are written up under *Atomicity* |
| migration applies from zero | **PASS** — all 22 migrations into an empty DB, both indexes present after |
| `frontend/qa/run-all.sh`, `tests/e2e/walk-*.cjs` | **NOT RUN** — need a running dev stack, and D-4 records that harness as defective for this tree. Not skipped silently; this change is backend-only and touches no frontend file |

**Two earlier full-suite runs were discarded, and why they were not defects.**
The first two attempts came back `672/673`, each with a **single failure that was
a 20 s timeout, not a failed assertion**, and in a *different* unrelated file
each time — `promotions.test.js` once, `gateway.test.js` once. Neither touches
phone orders. Rather than assume contention, both files were then run **in
isolation** on the same database and both passed: **123/123**, with the
previously-timing-out `promotions.test.js` completing in **10.0 s** against its
20 s limit — a 2x margin that a loaded box erases. At the time of those runs
there were **four to six concurrent peer `vitest` processes** on this machine
and a load average of **31**. The third run, at load 14, was green.

The first of the three also printed `[test-db-lock] LOST the lock mid-run —
results are not trustworthy, re-run alone`, so it was discarded on the suite's
own instruction rather than on judgement. `pg_stat_activity` grouped by database
was checked at the time and showed connections on this lane's DB only, all of
them this session's.

**Correction, 09-25 (acceptance).** The sentence that used to close that
paragraph — *"so the contention is CPU, not shared fixtures"* — does not follow,
and the server log says otherwise. `pg_stat_activity` lists who is connected
**now**; a foreign session that has already done its damage and disconnected
leaves it empty, so an empty snapshot is not evidence that nothing else touched
the database. What the server actually logged, on the container these databases
live in:

```
01:12:44.618 FATAL:  terminating connection due to administrator command
01:12:44.722 LOG:  checkpoint starting: immediate force wait
01:12:46.575 FATAL:  terminating connection due to administrator command
01:12:46.677 LOG:  checkpoint starting: immediate force wait
01:12:48.191 FATAL:  terminating connection due to administrator command
01:12:48.291 LOG:  checkpoint starting: immediate force wait
```

CPU load does not produce that line. Administrator termination followed ~100 ms
later by an *immediate forced* checkpoint, three times over, is the signature of
`DROP DATABASE … WITH (FORCE)`. No checked-in script on this server drops
databases, so it was an ad-hoc command from another session. Load may well have
caused the two **timeouts**; it did not cause the **lock loss**, and the two were
being explained as one thing.

The mechanism follows from the existing artifact, with no new experiment. The
lock is a **session** lock, so it dies with the backend; Prisma then
transparently reconnects and the new backend holds nothing. That the run
*printed* `LOST` is itself the proof: `held()` had to **succeed** and return
false to reach that branch. Had the connection merely errored, the
`.catch(() => {})` beside it would have swallowed the error and the run would
have continued with no message at all.

**The gap this leaves open.** The heartbeat only *notes* the loss — it never
aborts. `note()` writes one line to stderr and the run continues to completion,
so a run can lose its database lock in its first minute and still print a green
summary in its third. "Discard it" is an instruction addressed to a human
reading the log afterwards, and nothing enforces it. Until the heartbeat fails
the run, **"no `LOST` line" has to be checked explicitly** and cannot be inferred
from exit 0. Every run in the table above and in *Independent acceptance* below
was checked that way, and the check is meaningful because `[test-db-lock]
acquired …` is itself written to stderr — its presence in each log proves that
stream was captured, so the absence of `LOST` is a reading rather than a blind
spot.

*Recorded because "green on the third try" is only honest if the first two are
shown.*

The **675** in the table is not that third run. It is a **fourth**, taken after
the two atomicity tests were added, on the bytes below, at load 6.0 — and it
reports `[test-db-lock] acquired as vcx-test-lock:1795514` with no `LOST` line
anywhere in the log. The earlier 673 runs are left in place above rather than
overwritten, because they are the evidence for the contention finding.

#### What the numbers above were taken against

The tree was **dirty** when every gate above ran — the work is uncommitted at the
time of measurement, so "the tests passed" is only meaningful next to a
fingerprint of what they ran on. SHA-256 of the exact bytes:

| file | sha256 (first 8 … last 8) |
|---|---|
| `backend/prisma/schema.prisma` | `da2d0915…1351a4fa` |
| `backend/src/lib/phoneOrders.js` | `cf094b9d…c07f7341` |
| `backend/src/api/routes/phoneOrders.js` | `c499a352…1ff90af3` |
| `backend/tests/phoneOrders.test.js` | `595a8431…3f756e6b` |
| `backend/prisma/migrations/20260924800001_…/migration.sql` | `4eb9c24c…d34412ca` |
| `backend/scripts/vc104-slot-mutants.mjs` | `45c6068e…c39a761c` |
| `backend/scripts/vc104-slot-cost-probe.mjs` | `a0fddf2e…0d43903e` |

Rollup of the first four concatenated in that order, which is the one number to
check if you only check one:
`b82c528d39c8ebd8e804a142ccaac639e0cabd545c48c05eaed1fea8150b02ee`

The three documents in this change are deliberately **not** in that list: they are
still being written as the results come in, so digesting them would fingerprint
the prose rather than the thing tested.

Two of the entries are worth a word. `scripts/vc104-slot-mutants.mjs` is in the
list because the battery result is a claim about the *battery*, and it was edited
between the `9/11` run and the `11/11` one — anyone auditing that pair needs to
know the runner changed and how. And the digests were taken **after** the battery
printed `restored both files from the bytes read at startup`, because a mutation
run leaves the source mutated until it finishes: a `git diff` taken mid-run showed
M4's edit and would have been a false record of the change.

Equivalence to the commit is checkable without taking this table on trust, and
without a commit SHA that this file would have to be rewritten to carry:

```sh
git show HEAD:backend/src/lib/phoneOrders.js | sha256sum   # and each row above
```

Every row must reproduce against the commit that carries *this* file. If one
differs, the bytes that were tested are not the bytes that shipped, and the
results above belong to something else.

#### What *this* fix does not settle

Kept in the same spirit as the section it replaces — the limits are listed
because they are known, not because they are acceptable.

1. **A place is only ever released by rejection.** There is no cancel route —
   `CANCELLED` exists in the enum but nothing can produce it, deliberately,
   because cancelling an order that may hold money needs the refund rules that
   wait on C-6. There is no reschedule route either. So the spec item
   *"cancellation/rescheduling and exact booked-count changes"* is **covered
   only for rejection**, which is pinned; the other two are not testable
   because they do not exist. The operational consequence is real: **a
   scheduled order that no-shows holds its future slot forever**, and the only
   way to free it is for the destination to reject it.
2. **The candidate set still grows without bound.** `PhoneOrderStatus` has no
   terminal state, so every order a store has ever accepted stays `ACCEPTED`
   and remains a candidate row for every future slot count. The index makes
   that cheap (4 ms at 120k) rather than making it finite. A store doing a
   thousand orders a week crosses 120k in about two years, and nothing in this
   change prunes it. Retention, or a terminal state, is the actual fix and is
   not in scope here.
3. **A millisecond window between the check and the write remains.**
   `reserveSlot` counts at instant T, and the row is written a few ms later.
   Submit and reassign both pin the checked instant (`takenAt` → `createdAt`,
   `movedAt` → event `at`) so the row lands in the slot that was actually
   checked. Removing either pin is mutant M8/M9, and **both were predicted to
   escape and did** — the window is milliseconds wide and only opens exactly on
   a slot boundary, so no deterministic test can see it. It is argued in code
   and recorded here rather than asserted.
4. **The cost numbers are one machine, one Postgres, one shape of history.**
   Treat the *ratios* as the finding and the absolute milliseconds as
   indicative. Stated unambiguously, all against the old wrong count of 10.0 ms
   and all unindexed, so the comparison is like-for-like: the naive `COALESCE`
   form costs **8.2x**, the shipped three-arm form **1.4x**. The 4.0 ms figure
   is *not* on that scale — it is the shipped form *with* the new indexes, and
   it comes out below 10.0 ms only because those indexes would have sped up the
   old query too. Do not read "4.0 vs 10.0" as this change making the count
   faster than it was. The probe is kept at
   `backend/scripts/vc104-slot-cost-probe.mjs` so the numbers can be re-taken.
5. **Nothing here has touched a production database.** The migration is
   additive and applied only to an isolated test DB; see the deployment note
   above before running it anywhere real.
6. **No browser evidence, though the UI needs no change.** This is a backend
   change verified by backend tests. The response *shape* is untouched, which
   was checked rather than assumed: the only consumer is
   `frontend/src/pages/PhoneOrderNew.jsx:966`, rendering
   `${booked}/${maxOrdersPerSlot} booked this ${slotMinutes}-min slot`, and all
   three fields still exist and still mean the same thing. `AT_CAPACITY` is
   still the reason code, so `frontend/src/lib/vc104.js:36`'s "Kitchen full"
   copy still maps. **What changes is the number.** A store that receives
   transfers will now show a higher `booked` than before and will refuse at the
   cap where it previously waved orders through — correct, and visible to
   operators the first time a kitchen fills. That is a behaviour change to
   announce, not a bug report to expect. D-4 is still open (no VC-105 browser QA
   harness for this tree), so the UI has not been re-driven to confirm it
   renders the larger number sensibly.

#### Independent acceptance, 09-25 — taken against the commit, not a working tree

Everything above was measured on an uncommitted tree. This section re-takes the
load-bearing gates against **`82c355b`** itself, from a separate worktree and a
database created for the purpose.

**The commit is the thing that was fingerprinted.** The table in *What the
numbers above were taken against* reproduces exactly against `82c355b`: all
seven rows, and the rollup `b82c528d39c8ebd8e804a142ccaac639e0cabd545c48c05eaed1fea8150b02ee`,
recomputed with `git show 82c355b:<path> | sha256sum`. The invitation in that
section — *"every row must reproduce against the commit that carries this
file"* — has been taken up, and it holds.

| gate | result |
|---|---|
| backend full suite, `vitest run` | **675 passed / 675**, 22 files, **exit 0**, 112.68 s, start 02:32:07 — `tests/phoneOrders.test.js (71 tests)` |
| database | `vcx_vc104accept_test`, **created for this run**, all 22 migrations applied from zero |
| database lock | `[test-db-lock] acquired as vcx-test-lock:1849859`, **zero `LOST` lines** |
| log | `/tmp/vc104-accept-suite.log` |
| browser acceptance, `frontend/qa/run-all.sh` | **88 / 88 checks, 0 skipped** — closes limitation 6 above |

**One acceptance run was discarded, and it matters why.** An earlier full suite
captured at 01:57 reported `673 passed / 673` with
`tests/phoneOrders.test.js (69 tests)`. The committed file carries **71**, and it
was edited at 02:00 — *inside that run's window*. So the 673 belongs to bytes
that were replaced while the run was in flight, and it is not evidence about this
commit. It is recorded here rather than dropped, because a discarded run and a
run that was never taken look identical afterwards. The `675 / 71` in the table
above is correct; an intermediate draft of this document that said `673 / 69` was
describing the superseded state.

**Browser acceptance, and what it does and does not prove.** The run was driven
against an authorized isolated stack on private ports and a private database
(`:5482` / `:5483`, `atc_pos_vc104accept_demo`) — separate names on purpose,
because `db_reset` issues `DROP DATABASE … WITH (FORCE)`, which does not merely
race a peer's run, it terminates it. All six required scenarios are covered:
initial and scheduled order, cross-store reassignment, **source-slot release**,
destination capacity, **repeated transfer** (A→B→A), and the refusal display.
The last two were missing and are new — `§11c` of `frontend/qa/vc104-browser-qa.mjs`,
with the numbers it asserted on the run recorded here:

| step | CH (cap 2) | CP (cap 6) |
|---|---|---|
| after §11b fills CH | 2 — refused, *Kitchen is full (2/2)* | 1 |
| after moving one order CH → CP | **1**, offerable again | **2** |
| after moving the same order CP → CH | **2**, refused again | **1** |

The middle row is the release; the last row is the one worth reading twice. Once
that order has a `REASSIGNED` event into CH, arm C excludes it and only arm B can
count it, so `2` (not `1`, not `3`) is a live assertion that arm B finds the
**latest** arrival. `§11c` states its own scope in the file: every event in it
falls inside one slot, so it proves the journey through the real UI and guards
the regression, but the *discrimination* against pre-fix behaviour lives in the
backend suite, where the timestamps can be controlled — `counts a back-dated
transfer against the slot it ARRIVES in`, `occupies only the slot it arrived in,
not also the slot it was called in`, and `re-anchors to the latest move when an
order returns to a store it left`.

Result: **88/88, 0 skipped, nothing not-passing**, at `2026-09-25T02:29:17Z`;
artifacts in `/tmp/vc104-accept/frontend/qa/screens/` (`results-vc104.json`,
screenshot `15c-transfer-release-and-return.png`).

**What that artifact's own provenance stamp says, and what it does not.** It
records `baseSha 4b0ea9f`, `branch HEAD`, `dirty: true` — *not* `82c355b` —
because the browser run was taken in `/tmp/vc104-accept`, which is a detached
copy at `4b0ea9f` carrying the lane owner's then-uncommitted diff. So the stamp
alone does **not** place this run on the commit. What places it there is a
separate check: `md5sum` of the four sources the run exercised
(`backend/prisma/schema.prisma` `2dca7971`, `backend/src/lib/phoneOrders.js`
`7e9bcaeb`, `backend/src/api/routes/phoneOrders.js` `660f4074`,
`backend/tests/phoneOrders.test.js` `4f6fa551`) is identical to `git show`
of the same four paths at `82c355b`. Stated this way round on purpose: a stamp
that disagrees with the claim is the exact failure D-4 was about, and the
honest reading is that the stamp is stale for a known reason, with the
equivalence proved by content rather than asserted.

**Migration identity.** One `migration.sql`, checksum
`4eb9c24c…d34412ca`, has been applied under **two different names**, and Prisma's
ledger keys on the *name*:

| name | database | applied |
|---|---|---|
| `20260925011249_vc104_slot_count_indexes` | `vcx_slotanchor_test` | 01:15:44 |
| `20260924800001_vc104_slot_count_indexes` *(the committed name)* | `vcx_slotfresh_test` | 01:44:47 |
| `20260924800001_vc104_slot_count_indexes` | `vcx_vc104accept_test` | this acceptance run |

Nothing was published, so the old name is **not** shared identity and the rename
into the lane's reserved range is safe. `vcx_slotanchor_test` is hereby recorded
as a **superseded disposable rehearsal database**: it holds the retired name, and
because `migration.sql` uses plain `CREATE INDEX` a later `migrate deploy` there
would both report drift and fail on `relation already exists`. It is left exactly
as it is — no ledger row was edited and no database was reset — and it should be
dropped rather than reconciled. `vcx_slotfresh_test` and `vcx_vc104accept_test`
carry the committed name and are clean.

**The capacity policy is unchanged, and `booked` still is not kitchen load.**
The counting fix changes *which orders are counted*, not whether the cap binds:
capacity remains opt-in (`reserveSlot` returns early when a store has no
`BranchPrepCapacity` row), the refusal is still `409 POS_BRANCH_UNAVAILABLE` with
`AT_CAPACITY`, the `/branch-options` count is still taken outside any transaction
and is still a forecast, and the binding check is still the one under
`pg_advisory_xact_lock` inside the writing transaction. Two things keep `booked`
from being a measure of how busy a kitchen is, and both were re-checked against
the committed bytes: `branchPrepCapacity` is read **only** in
`src/api/routes/phoneOrders.js` — the till route `src/api/routes/orders.js` has
zero references — so **walk-in orders share the kitchen and are never counted**;
and by limitation 1 above a live order is released only by rejection or by moving
away, so a scheduled no-show holds its place. `booked` is an exact count of live
**phone** orders anchored in the slot, and that is the only thing it is.

**Cancellation and rescheduling are out of the accepted scope, not covered
elsewhere.** Confirmed from the code rather than from this document: no route
assigns `PhoneOrder.status = 'CANCELLED'` (the only `CANCELLED` writes in the
tree are `KitchenItem.state`), and `scheduledFor` is written at exactly one site,
the submit path. Neither appears in the approved requirements 1–9 of
`docs/lanes/VC104-API.md`; requirement 4 covers *creating* a scheduled order, not
changing one. Cancellation is deferred behind open owner blocker **C-6**.
Rejection coverage is **not** offered as a substitute for either: it is a
different event that happens to free a place.

---

## D-3 — a required modifier group makes a product unsellable by phone

> **FIXED 09-24.** Phone orders now carry `modifierOptionIds`, priced by the same
> function the till uses. The account below is left in the present tense as
> written; what changed is in **"Fixed 09-24"** at the end.
>
> **Read that section even if you only want the summary**, because the fix was
> four times the size of this write-up. The field was one of four places that had
> encoded "modifiers cannot arrive on this path", and the other three fail
> **silently** — the opposite of the fail-closed property this section uses to
> justify holding D-3 at Medium. Shipping only the field would have traded a
> visible refusal for three quiet wrong answers.

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

### Fixed 09-24

`modifierOptionIds` is now on `phoneOrders.js` `itemsSchema`, with the till's own
bounds (`max(30)`) deliberately rather than a new number: a basket an operator
can take by phone and a basket a cashier can take at the counter must be the same
set, or *"we can't do that over the phone"* becomes a shape of the API rather
than a decision anyone made.

#### The field was one of four places, and it was the only loud one

The paragraph above says the fix is "a modifier field on its line items". That is
true and it is not sufficient. Three other pieces of `phoneOrders.js` had been
written against the invariant *modifiers never arrive here*, and each of them
silently produces a wrong answer once they do:

| # | Where | What it did once modifiers arrived | Loud or silent? |
|---|-------|-----------------------------------|-----------------|
| 1 | `itemsSchema` | Stripped the field; the product stays unsellable | **Loud** — the reported symptom, 400 |
| 2 | `hashOf` | Same key + different toppings hashes equal → replay check passes → hands back the **first** order, 200 | **Silent** |
| 3 | `mergeItems` | Key was `product\|variant`, so two different-topping lines collapse onto one at whichever was seen first | **Silent** |
| 4 | `loadBranchDecision` | Minimum-order-value basket counted base price only, under-counting every paid extra | **Silent** |

Only #1 is in the write-up above. The severity argument in this section —
*"Medium because it fails CLOSED"* — describes #1 exactly and describes none of
the other three. Had the field been added on its own, D-3 would have been closed
as a Medium and would have shipped a mispricing: the phone path *does* move money
wrongly once it can carry modifiers at all, just not before.

Worked example of #2, which is the worst of them. An operator submits a Large
pizza with extra cheese under key `K`; the caller changes their mind; the
operator resubmits under `K` with a plain Regular. The hash ignores modifiers, so
it matches, and the API answers **200 with the first order**. The operator's
screen says the change succeeded. The caller is billed ₹450 for a ₹300 pizza, and
the kitchen makes the wrong food. There is no error anywhere. This is reproduced
as a test, and the negative control below shows the exact response body.

`createMany` was the fifth place, and it is the one that behaved well. It could
not write the nested modifier snapshot rows, and the previous author had put an
explicit `throw` there rather than letting the array be dropped:

> *"If that ever stops being true this must become per-row creates; it refuses
> instead of silently discarding the caller's choices."*

That guard is why D-3's blast radius was knowable instead of a data-loss bug
found months later. It is now replaced by the till's own `createLineData`, which
is a per-row create — the guard was an instruction for exactly this change, and
following it is what retires it.

#### What is now shared rather than duplicated

D-3's own origin is *the same rule written twice and only one copy maintained*.
Fixing it by writing a third copy of the merge key in `phoneOrders.js` would have
reproduced the defect on a one-year delay, so two functions moved to
`orders.js` and are now imported by both paths:

- `mergeCatalogItems(items)` — dedupe-and-sort the chosen option ids into the
  line key, so `["a","b"]`, `["b","a"]` and `["a","a","b"]` are one basket choice.
- `createLineData(line, orderId)` — the nested-snapshot row writer, which rules
  out `createMany` on **every** path that writes order items.

The same dedupe-and-sort is applied inside `hashOf`, which matters in both
directions: without it a retry listing the same two options the other way round
would be refused as a key clash — a *new* wrong answer invented by the fix. There
is a test for that false refusal, not only for the true one.

#### Deliberate decisions worth challenging

- **The reassign basket is not filtered on `status: 'ACTIVE'`.** Reassignment
  replays an existing order whose options may have been archived since it was
  taken, and the caller still agreed to pay for them. Filtering would under-count
  that real case to protect a new-basket case that `resolveCatalogLine` already
  refuses at submit.
- **Unknown option ids contribute zero to the pre-flight basket** rather than
  throwing, matching the treatment unknown *products* already had two lines
  above. `resolveCatalogLine` rejects them properly at submit; the selector is an
  estimate and should not 500 on a stale screen.
- **Reassignment does not re-price the lines.** `recomputeOrder` works off the
  stored rows, so modifier prices snapshotted at submit survive a move between
  stores. Only the availability estimate consumes the option ids.

#### Verification

`backend/tests/phoneOrders.test.js` 41 → 52; `backend/tests/phase2.test.js`
66 → 67. Full backend suite **656 passed / 22 files**.

Green on the first run is a claim, not evidence, so each part was inverted in the
*implementation* — not in the assertions — and the failures counted:

| Control | Inverted | Failures | Which |
|---------|----------|----------|-------|
| 1 | `hashOf` drops `m` | 1 | the reused-key test, failing **200 instead of 409**, body showing the ₹450 order returned for a ₹300 request |
| 2 | `mergeCatalogItems` ignores the modifier key | 2 | the phone merge test **and** the new till merge test |
| 3 | `basketPaise` drops the extras | 2 | store-minimum, and reassign |
| 4 | reassign stops passing option ids through | 1 | reassign only |
| 5 | `modifierOptionIds` removed from the schema | 10 | everything except the over-fix guard |

Two things the controls caught that the tests alone would not have:

- **The first attempt at control 1 was a no-op.** It was written `m: [] && modKeyOf(i)`, and `[]` is truthy in JavaScript, so the expression returned `modKeyOf(i)` unchanged and the suite went green — a control that "passes" is a broken control, not a passing fix. It is only because a green control was treated as a failure that this was caught.
- **One test passed spuriously under control 5.** *"refuses an archived option, another product's option and another tenant's"* asserted status 400 and `field: modifierOptionIds` — both of which an API that ignores the field entirely also produces, because the Size group is then unsatisfied. It now asserts the message names the reason, and it discriminates. The lesson generalises: on a route where several different faults share one error shape, status-plus-field is not evidence about which fault fired.

Control 2 also answered a question nobody had asked. When the merge key was
inverted, `phase2.test.js` and `catalogModifiers.test.js` stayed **green** — the
till's modifier-aware merge key had no test either. The till's only merge test
was `product+variant`, written before VC-102. So D-3 is not "the phone path was
behind"; it is *one rule, two copies, neither pinned, and the copy that happened
to be wrong was the one nobody drove*. A till-side test was added for that reason:
the key is one shared function now, but a shared function is only as good as both
call sites still calling it.

#### What this does not settle

- **No live data was inspected.** Whether any demo or production product
  currently carries a `minSelect >= 1` group is still unverified, exactly as the
  section above says. The fix does not depend on the answer, but the *urgency*
  of having shipped it does.
- **D-1 and D-2 remained open at the time this was written**; both were fixed
  later the same day — see their *Fixed 09-24* subsections. D-6 is recorded and
  now pinned by tests, but deliberately **unfixed pending an owner decision** on
  code reservation; it is parked, not forgotten.
- **The front end was not touched.** The phone-order operator screen has no
  modifier picker, so this fix makes the *API* able to sell these products; a
  human operator still cannot, from the UI, today. That is the next piece of work
  D-3 implies and it is not done here.

---

## D-4 — no VC-105 browser evidence for this tree, and the harnesses clobbered each other

> **CLOSED 09-24.** `frontend/qa/run-all.sh` now drives both harnesses against
> this tree's own backend, and both artifacts name the tree that produced them.
> The account below is left in the past tense as written, because the reasoning
> is what makes the fix reviewable. What changed is in **"Closed 09-24"** at the
> end — including a **correction to this section's own central claim**, which
> was half wrong in a way that matters more than the gap it described.

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

### Closed 09-24 — both harnesses run here, and the artifacts name their tree

One invocation of `frontend/qa/run-all.sh` now provisions, seeds, serves and
drives both suites, and writes both results files:

```
72/72 browser checks passed (0 skipped)      ← VC-104, ports 5382/5383
48/48 browser checks passed                  ← VC-105, ports 5386/5387
```

Both files carry the same stamp, self-derived by the harness at write time:

```json
"tree":    "/home/atc-noc/vexo-connect-x-lanes/main-merge",
"branch":  "main",
"baseSha": "011589841afe7a66364d5fe658a1da87a87f3480",
"dirty":   true
```

`dirty: true`, and a `baseSha` that is the **parent** of the commit carrying
these files, are both correct rather than sloppy: the run is what justified the
commit, so it necessarily happened before it. A stamp that read clean here
would be the precise lie this section exists to prevent.

#### The correction — the `at` tell could never have worked

Above, this section said the VC-105 artifact was the lane's, and that
`results-vc104.json` was "a real run" on which D-1's evidence rests. **The
second half was wrong.** `x/vc104-ui` carries its own
`frontend/qa/screens/results.json`, and the file `main` committed as
`results-vc104.json` was byte-identical to it:

```
git show HEAD:frontend/qa/screens/results-vc104.json      \
git show x/vc104-ui:frontend/qa/screens/results.json      # identical
```

So **both** results files in this tree were lane artifacts. The VC-105 one was
caught only because it happened to lack `at` — and the VC-104 lane harness
*does* stamp `at` (`git show x/vc104-ui:frontend/qa/vc104-browser-qa.mjs |
grep -c 'at: new Date'` returns `1`). A missing field is a **tell, not a
check**: it catches the lane that forgot and misses the lane that remembered.
The paragraph above congratulating the `at` stamp for working was therefore
describing luck.

`frontend/qa/tree-stamp.mjs` replaces the tell with a positive statement. It
shells `git -C <the harness's own directory> rev-parse` at write time, so the
value is **derived from where the harness is executing**, not declared. That
choice is the whole point: an env var like `QA_TREE=…` would have been set
correctly by the runner that was already correct, and wrongly — or not at all —
by the one that was not, which is exactly the failure being guarded. Negative
control: called from the `vc105-ui` lane it returns `branch: "x/vc105-ui"`, and
from a non-repo directory it returns nulls rather than inheriting anything.

#### What running against this tree actually exposed

The gap was not only that the VC-105 suite had not run here. **Neither suite
had.** `run-all.sh` and `run-seed.mjs` both resolved their backend to
`../../../vc104-api/backend` — correct while the files lived in W2's frontend
lane, where the only backend in reach was W1's, and silently wrong after
consolidation. A green run in `main` was evidence about the lane's 14
migrations, not this tree's 21. Both now resolve to `../../backend`, and stage 0
asserts the generated Prisma client contains `BranchPrepCapacity` — a model
present in this schema and absent from both lanes' — so a stale lane client
cannot pass silently.

Pointing the VC-105 seed at this tree surfaced two hard incompatibilities that
no lane run could have found, because in each case the lane simply lacks the
migration:

- `Branch.publicId` is `NOT NULL` here (`20260924100100_foundation_org_identity`,
  absent from `x/vc105-api`). The seed now mints through `mintStorePublicId`,
  the same helper `prisma/seed.js` uses, so the fixture carries a real VEXO
  Store ID rather than a literal.
- `Payment → Order` is a **composite** foreign key here,
  `[orderId, branchId] → [id, branchId]` (`20260924100200`), so the database
  itself refuses to attach a payment to an order in another branch. The seed's
  `payment.create` needed no `branchId` in the lane and cannot omit it here.

Both were schema-level refusals at seed time, not subtle drift — which is the
useful part: they had been invisible for as long as the harness ran elsewhere.

#### A related fix: the suite was only green between 09:00 and 23:00 IST

Found by running at 18:01 UTC (23:31 IST). The seed gives Connaught Place
09:00–23:00 and Cyber Hub 11:00–22:00 with Mondays closed. The harness asserts
CP's availability **unconditionally**, so a night run failed — and failed with
`Connaught Place is available for 110001`, which reads like a backend
availability bug rather than "you ran this after 23:00". It then hung on
`[data-testid="po-success"]` and took the process down, discarding the rest of
the suite.

CH was handled better — the harness records SKIP — but the blocks it skips are
the two carrying the open defects in this document: the CP→CH reassign and
re-price block (**D-1**) and the capacity block (**D-2**, including the ASAP
tripwire). The 18:01 run scored **61/61 with 4 skips** and reported PASS. A
passing artifact that has never executed the evidence the defect register leans
on is D-4's own pattern in miniature.

`qa/run-seed.mjs` now holds both demo stores open on all seven days, in W2's
scratch DB only, and asserts `cpOpenDays=14` before proceeding. The cost is
stated in the file: branch-hours logic is no longer exercised in the browser
suite, and the CLOSED reason string loses browser coverage — unavailable-store
*rendering* is still covered deterministically by the out-of-area case, where CP
refuses 122001 with "Out of area" (`07-out-of-area.png`). Hours are backend
logic and are tested there.

One latent harness bug fell out of this. The capacity block chose its slot with
`t.getHours()`, which is **box-local** — this box runs UTC — and compared it
against CH's **IST** window. The two overlap only 11:15–16:30 UTC; the lane's
14:19 UTC run landed inside that overlap and passed by luck. The guard is gone,
since the only backend constraint on `scheduledFor` is that it be in the future
(`phoneOrders.js:572`) and the fixture now keeps CH open at every instant.

With that, the VC-105 row of the UI acceptance table is **passed, not owed**,
and the VC-104 row is evidence about this tree for the first time.

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

*(Written while D-3 was open. Both are fixed now; the comparison is kept because
it is how the two were prioritised, and because the judgement below turned out to
be right about D-5 and **wrong about D-3** — see D-3's "Fixed 09-24", where the
reported symptom proved to be the only fail-closed part of it.)*

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

##### Re-verified independently, and one gap found and closed

The above was re-run from a clean checkout of `0115898` against a throwaway
Postgres of its own: **639/639 across 22 files**, reproducing the figure exactly.
Two further controls were then run, asking a question the first three do not —
*does a refused edit write anything?* The guard is called before the write on all
three call sites, so nothing is half-done today; the question is whether the
suite would notice if that ever stopped being true.

| Control | Perturbation | Tests that caught it |
|---------|--------------|----------------------|
| 4 | guard moved *below* the write in `PATCH .../:groupId` | 1 |
| 5 | guard moved *below* the create in `POST .../modifier-groups` | **0** |

Control 4 is caught because that test sells the product after the refusal — the
comment at the option-route test says exactly why ("a guard that 409s after
writing would pass every assertion above"). **Control 5 was caught by nothing.**
The create-path test asserted the 409 and the message but never that the refusal
wrote nothing, and selling afterwards cannot cover it: the group under test is
the refused one, so there is nothing to sell against. A guard that moved below
the create would answer 409 and still leave an unsatisfiable group on the
product — the precise state D-5 is about — with all 51 tests green.

Closed by asserting the absence directly, in that same test:

```js
expect(groupsOf(await getProduct(tokens.ownerA, p.id))).toEqual([]);
expect(await prisma.modifierGroup.count({ where: { productId: p.id } })).toBe(0);
```

Control 5 now fails (`expected [ { …(6) } ] to deeply equal []`), which is the
evidence that the new assertion does work. **No production behaviour changed —
the fix was already correct; what was missing was the proof that it stays
correct.**

#### What this does not settle

D-3 is still open *(as of this section's writing — it was fixed a few hours
later; see its own "Fixed 09-24")*. It asks the neighbouring question — *what
should happen when a required group cannot be satisfied **by a particular
channel*** — and this fix does not answer it. A group with two active options is
perfectly satisfiable and still unsellable by phone.

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

That grep is **as it stood when the sweep ran**, and it is the whole reason this
survived. It no longer returns nothing: `describe('archiving a campaign (D-6)')`
in that file now drives the route. What the tests pin, and what they pointedly do
not, is under "Status of the claim" below.

A corroborating detail, and the reason to trust that nobody has ever walked this
path: the refusal message is built as `` `A ${status.toLowerCase()} promotion
cannot be ${action}d` `` (`:332`). It was written for verbs ending in *e* —
`pause`→`paused`, `archive`→`archived`. For `publish` it renders **"A archived
promotion cannot be publishd"**. A malformed article and a missing *e*, in the
one sentence a stuck operator is shown. Any HTTP test on this route would have
put that string in an assertion.

### Status of the claim

**As first written**, every line above was a quotation of the committed source
and the migration SQL, and **no test pinned any of it** — the sweep that found
D-6 was research only. It was proven by reading, not by running, and was recorded
as the weaker standard it was.

**That is no longer the case.** The behaviour has since been reproduced over HTTP
against an isolated database and is now pinned by five tests in
`describe('archiving a campaign (D-6)')` in `backend/tests/promotions.test.js`.
The claim stands as written — every refusal the reading predicted, a run
reproduced:

| What the reading claimed | What the run found |
|---|---|
| Archive is reachable from DRAFT, PUBLISHED and PAUSED | 200 from all three |
| An archived promotion cannot be edited (`:196`) | 409, "An archived promotion cannot be edited" |
| It cannot be republished or paused, and is terminal (`:332`) | 409 on `/publish`, `/pause` and a second `/archive` |
| A new promotion cannot take the code (`:167–172`) | 409, "Code BURN-38 is already in use" |
| The archived row still holds the code | row present, `status: ARCHIVED`, code intact |

Two things the reading did **not** establish, which the run settles:

- **Applied discounts are untouched.** A bill that took the offer before the
  archive keeps its discount, its total and its snapshot afterwards. This is what
  holds the severity at Medium: D-6 costs a code, never money.
- **Uncoded campaigns reserve nothing.** `code` is nullable and Postgres permits
  many NULLs under a unique index, so the defect is bounded to coded campaigns.

**The tests take no position on whether this behaviour is right.** They pin what
ships, so that the policy decision below changes a test deliberately rather than
silently. D-6 stays **open**.

### What a fix has to touch — measured, not assumed

Fix (1) below was checked by building half of it and running the suite against
it, and the result rules that half out. **Filtering the route's duplicate check
without also replacing the index turns a clean refusal into a crash:** the
`POST /promotions` guard at `:167–172` stops firing, the request reaches the
database, and `Promotion_companyId_code_key` rejects it as an unhandled unique
violation — **500 `POS_INTERNAL_ERROR`**, not 409.

```
control: dup check becomes findFirst({ …, status: { not: 'ARCHIVED' } })
result:  expected 500 to be 409   ← the index is still total
```

So option (1) is a **migration plus a route change, together or not at all**. The
route filter alone is strictly worse than today's behaviour: same dead end, worse
error, and an entry in the error log every time an operator retries a burnt code.

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

### Why none of them was implemented

D-5 was fixed the same day it was found because the owner chose an option. D-6
has no such instruction, and — unlike D-5 — **there is nothing in this repository
to check the intent against.** Promotions have no written contract:

```
$ grep -c -i promotion docs/PHASE2-CONTRACT.md docs/VC104-API-CONTRACT.md
docs/PHASE2-CONTRACT.md:0
docs/VC104-API-CONTRACT.md:0
```

Phase 2 is where VC-102 lives, and its contract does not mention promotions at
all. The only mentions anywhere in `docs/` are incidental — migration number
ranges, dev ports, a list of models W2 must not touch — and none describes the
lifecycle. It exists solely in the `PromotionStatus` enum and the `transition`
factory. So the question *is permanent code reservation intended, or is it an
oversight?* cannot be answered from the tree, and implementing either answer
would be inventing policy:

- If reservation is **intended**, the work is option (3) plus documentation and,
  eventually, a UI that says so before the operator archives — not a code change
  to the constraint.
- If it is an **oversight**, the work is option (1), whole: migration and route
  filter together, per the measurement above.

A third possibility is worth naming because it is what an operator usually wants
and no option above delivers: **restoring an archived campaign to DRAFT** under
its own identity, keeping its code, its `redemptionCount` and its redemption
history, and requiring a fresh `promo.publish` to go live again. That is a
lifecycle capability rather than a constraint change, it is a larger decision
than the three above, and it is **deliberately not designed here** — no other
entity in this codebase has an unarchive route, so there is no house pattern to
follow and picking one would be setting precedent by stealth.

**What is owed to the owner is a decision, not a patch.** Until then the
behaviour is pinned by tests, the reasoning is here, and nothing in the database
has been changed: no code renamed, no archived campaign deleted, no redemption
counter reset, no historical bill rewritten.

---

## 3. Why the phone-order suite stayed green on both

> **Superseded 09-24 — this is the pre-fix analysis, kept because it is the
> reason both defects survived a green suite.** Five assertions now pin what
> this section says was unpinned. Four of them were **run red first** against
> the unfixed code, with the exact failures recorded in the two *Fixed 09-24*
> subsections, so the pins are evidence rather than decoration. The fifth is a
> control that passes either way on purpose — §6 explains why that is not the
> contradiction it looks like. The prediction below, that "fixing them should
> not turn the suite red", held.

**No existing assertion pins either bug, so fixing them should not turn the
suite red.** What is missing is coverage, and in D-1's case it is missing by a
single line.

### D-1 — the conditions are already built; nothing reads the flag

`backend/tests/phoneOrders.test.js:516`, *"moves the order and recomputes price
and tax for the new store"*, already sets up **exactly** the case that breaks
(the test is unchanged but now sits at `:890`, one added test and a fixture
helper above it):

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

> **What was actually done (09-24).** That one line was *not* added to this
> test. Editing an existing green test to make it red is a poor record: the
> reader cannot later tell the original intent from the pin. Two new tests were
> written beside it instead (`:913` and `:935`) — one asserting `true` on a
> charge-only move, one asserting `false` when the move is free — so the
> existing test keeps proving what it was written to prove. See D-1's *Fixed
> 09-24* subsection for why a single `toBe(true)` would not have been enough.

### D-2 — covered only on the path that works

The one capacity test — *"refuses a store whose prep slot is already full"*,
`phoneOrders.test.js:300` — books its filler with an explicit
`scheduledFor: when.toISOString()` (:305) and queries with the same explicit
time (:311). It therefore exercises the branch where the filter matches and
never the ASAP branch where it cannot. A test that submits N **ASAP** orders
into a store with `maxOrdersPerSlot = N` and then expects `capacity.booked: N`
and `AT_CAPACITY` would have caught this on the day; it is the one addition
worth making before the fix.

> **What was actually done (09-24).** Exactly that, with N = 1, at
> `phoneOrders.test.js:358`. It ran red first (`expected +0 to be 1`) and the
> filler is a plain `baseSubmission()` — no `scheduledFor` — so it fails again
> the moment the ASAP branch is dropped from the count.

This is also why the lane's recorded 455/455 was never evidence against either
defect — a green suite certifies what it asserts, and neither of these was
asserted. The same caution now applies in the other direction: a green suite
certifies these five assertions and nothing more.

> **How the 09-25 assertions were checked (same caution, applied to itself).**
> The rule above says a green suite proves only what it asserts, so the new
> capacity tests were not trusted for being green. Each was checked by breaking
> the **implementation** and requiring the run to go red on that test's own
> name: thirteen mutations, eleven of which must be caught, two declared in
> advance as undetectable with the reason written down. The first re-aimed run
> **failed, 3 of 10 escaping** — and the escapes were real coverage gaps the
> rewrite had created, not noise:
>
> - the rejected-order test moved its order into the store first, so it lived in
>   arm B and never exercised arm C's copy of the status list;
> - the boundary test anchored on a `REASSIGNED` event, so it exercised arm B's
>   `<` and neither of the other two.
>
> Both were fixed structurally rather than by writing cleverer mutants: the
> status list and the reassign predicate are now written **once** and shared by
> all three arms, and there is a boundary test **per arm**. Triplicated rules are
> what let the gaps open, so the fix was to stop triplicating them. At that
> point the battery reported 10/10 with the 2 predicted escapes, three times
> consecutively.
>
> **That 10/10 did not survive contact with the eleventh mutant.** Adding M10
> — the capacity check moved outside the transaction — made the run go
> **9/11**, and the second escape was **M3**, a mutant that had been passing
> for three runs. Both are written up under *Atomicity* above; the short
> version is that every capacity test filled the destination before the
> request, so all of them were refused by the advisory read and none ever
> reached the binding check inside the transaction. M3's apparent detector was
> a timing-dependent HTTP race that the source itself documents as
> non-overlapping.
>
> The run after that is the one worth keeping. With the binding test written,
> both mutants **escaped a second time — and the new test was red in both**,
> because each was still declaring a detector that cannot reach the mutated
> lines. Scoring on "the named test", not "any test", is the whole difference:
> the weaker rule would have called this closed a run early while the tests
> actually holding the invariant were not the ones anyone believed were.
>
> The lesson is about the method, not the defect: **a mutant that has never
> been written is not a mutant that escaped — it is a question nobody asked.**
> Three consecutive 10/10 runs said nothing about atomicity, because no
> mutation in the set attacked it. Consecutive green runs measure stability,
> never coverage.
>
> **One hazard in the battery itself was found by reading it, not by it
> failing.** The runner read vitest's JSON report from a fixed path without
> clearing it first, so a mutated run that died before writing — an OOM, a
> port clash, a dead DB — would have been scored against the *previous* run's
> report and reported a confident CAUGHT for a run that never happened. It now
> deletes the report, requires it to exist afterwards, and requires every
> mutated run to report the **same test count** as a mandatory green baseline;
> any mismatch voids the run instead of scoring it. Worth stating plainly: the
> earlier "twice consecutively" was taken with that hazard live. It is
> re-stated as three because the runs were re-taken after the fix, not because
> the old ones were recounted.
>
> This is worth recording because it is the second time on this defect that the
> tests looked sufficient and were not. The probe is kept at
> `backend/scripts/vc104-slot-mutants.mjs` so the claim can be re-checked rather
> than believed.

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

> **Since 09-24 these recipes prove the fix, not the defect.** Run against this
> tree, D-1 now returns `priceChanged: true` and D-2 reports `capacity.booked: 2`
> with `AT_CAPACITY`. To see the original behaviour, check out `c40683b` — or
> revert the `OR` array at `phoneOrders.js:195–198` and the two `buildQuote`
> calls at `:930` and `:988`, which is how the failing runs above were produced.

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

> **Both notes came due on 09-24, and both belong to the client side, which a
> concurrent session has claimed** (negotiated in a working note at the repo
> root, which may not outlive the branch — so the split is recorded here). The
> split
> agreed is: this session owns the route, the backend tests and this document;
> that session owns `PhoneOrders.jsx`, the QA harness, `VC104-UI-DELIVERY.md`
> and the API contract. **No frontend file was touched by this fix.**
>
> **D-1's banner is being removed there, and the first draft of this note
> argued for keeping it — wrongly.** The argument was that the `||` is merely
> redundant once the server flag works, and that redundancy is a free
> independent check. It is not free: the client term compares against the
> previous quote read off `detail`, so when `detail` is stale or not yet
> loaded the banner fires on a move that cost the caller nothing. That is a
> false positive the server flag cannot produce, and an operator who is
> re-quoted on every move stops believing the banner — which is the same
> failure D-1 caused, arrived at from the other side. Two sources of truth for
> one rule, and the weaker one is wrong more often.
>
> **D-2's `15b` tripwire has fired**, exactly as its failure note anticipated,
> so `15b` is **expected red** and retiring it is live work — claimed by the
> same session. It was not retired here: the backend fix is proven at HTTP
> level, but nobody has watched the ASAP capacity banner render, and marking a
> UI check done on the strength of a backend run is the substitution this
> report exists to warn about.

## 6. What this report does not claim

W2 did not run W1's test suite, did not modify W1's code, and does not certify
the 455/455 figure recorded in `docs/lanes/VC104-API.md` (that lane holds no
on-disk log for the run). Everything above is either a direct quotation of the
committed source at `c40683b` or an observation from W2's own browser-QA runs,
whose evidence is committed here (from `x/vc104-ui` @ `f344ef4`).

D-1 and D-2 were reported against `c40683b`, and the merge carried them forward
untouched as W2 wrote them. The paragraph that stood here warned that the
phone-order figure had risen from 41 to 52 while **none of those 11 new tests
touched D-1 or D-2** — a rising count proving nothing about the defects under
it. **Both were fixed on 09-24** and the count is now 57; the trap is worth
restating rather than deleting, because the five tests that moved it are the
only five that say anything about D-1 or D-2.

Four of those five were run red against the unfixed code before they were
allowed to go green. **The fifth never goes red, and that is its job** — `stays
quiet when the move costs the caller nothing (D-1 control)` asserts
`priceChanged === false`, which the broken code also produced. It is there to
fail a *bad fix* rather than reproduce the defect: hardwire the flag to `true`
and the other D-1 test passes while this one catches it. A test that has never
been red is usually worthless; this is the exception, and the exception has to
be argued rather than assumed.

D-3 was the merge's own doing and is **FIXED** (09-24, same day, after D-5) —
that is where 11 of those tests came from. A twelfth was added to
`phase2.test.js` because the negative control showed the till shared the same
unpinned merge key.

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

D-6 is **unfixed, but no longer unpinned**. It was the one entry here with no
test of any kind behind it; it is now reproduced over HTTP by five tests in
`promotions.test.js`, which record the shipped behaviour without endorsing it.
Unfixed is deliberate and not an omission: there is no VC-102 specification in
this repository to check the intent against, so whether permanent code
reservation is wanted is an owner decision, and a measurement recorded under D-6
shows the obvious half-fix (filtering the route's duplicate check alone) makes
things worse rather than better — 500 instead of 409. See "Status of the claim"
and "Why none of them was implemented" under D-6.

---

## 7. The sweep that found D-6 — and what else it turned up

D-5 hid because of two properties at once: no frontend caller, and no HTTP-level
test. Either alone is common; together they mean a route is exercised by
nothing. All 25 files in `backend/src/api/routes/` were checked against both.

**Both properties — four routes.** Only D-6 reaches an unguarded state.

| Route | Where | Verdict |
|---|---|---|
| `POST /api/promotions/:id/archive` | `promotions.js:353` | **D-6** — one-way door, code burned. *Second property now closed:* the route is driven over HTTP by `describe('archiving a campaign (D-6)')`. The behaviour is unchanged and still owner-gated |
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
