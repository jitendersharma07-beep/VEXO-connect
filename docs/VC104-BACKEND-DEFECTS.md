# VC-104 backend defects found by W2's browser QA — report for W1

**From:** W2 (frontend lane `x/vc104-ui`) · **To:** W1 (this lane, `x/vc104-api`)
**Date:** 2026-09-24 · **Line numbers are this lane's, at `c40683b`**

Two defects in the phone-order backend. Both were found from the outside, by
driving this API through a real browser against W2's own database — not by
reading the code, and not by running this lane's test suite (W2 does not run
another worker's tests). Neither is fixed: the backend is W1's to change. This
report exists so the fix is a decision W1 makes with the evidence in hand.

The same file is committed on `x/vc104-ui` (where the QA evidence lives); this
copy sits in the lane it describes so it is next to the code it cites.

| # | Defect | Effect | Severity | Where |
|---|--------|--------|----------|-------|
| D-1 | `priceChanged` on reassign ignores the delivery charge | The caller is re-quoted nothing on exactly the moves that change what they pay | Medium — quote-facing, not billing (the charge is not billable while C-6 is open) | `backend/src/api/routes/phoneOrders.js:858,879,914` |
| D-2 | Prep capacity never counts ASAP orders | The kitchen-full refusal is dead on the dominant path; the guard fails OPEN | High for the feature's purpose — no money impact | `backend/src/api/routes/phoneOrders.js:178–185` + `:569` |

§3 is the part worth reading first: **this lane's own suite already builds D-1's
exact conditions and simply never looks at the flag.**

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
`frontend/qa/screens/results.json` on `x/vc104-ui` @ `f344ef4`.

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
orders. Evidence: `frontend/qa/screens/15b-capacity-asap-d2.png` on
`x/vc104-ui` @ `f344ef4`.

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

## 3. Why this lane's suite stays green on both

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

Environment recipe: `docs/VC104-SETUP.md` in this lane, or
`docs/VC104-UI-DELIVERY.md` §6 on `x/vc104-ui` for the browser path (lane DBs,
ports, seeded stores, and the env-var names for credentials — no secrets are
written down in either lane). Run this lane's backend against a scratch DB with
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

Both changes live on `x/vc104-ui`, not in this lane:

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

W2 did not run this lane's test suite, did not modify this lane's code, and does
not certify the 455/455 figure recorded in `docs/lanes/VC104-API.md` (the lane
holds no on-disk log for that run). Everything above is either a direct quotation
of the committed source at `c40683b` or an observation from W2's own browser-QA
runs, whose evidence is committed on `x/vc104-ui` @ `f344ef4`.
