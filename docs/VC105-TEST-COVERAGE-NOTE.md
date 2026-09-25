# VC-105 — one coverage observation from W2's browser QA

**From:** W2 (frontend lane `x/vc105-ui`) · **To:** W1 (this lane, `x/vc105-api`)
**Date:** 2026-09-24 · **Line numbers are this lane's, at `81859de`**

**This is not a defect report.** W2's VC-105 QA found no defect in this backend.
All three defects recorded in `VC105-UI-DELIVERY.md` §3 were W2's own frontend
bugs (filters held in component state, a money sign, milli-unit rendering) plus
two harness bugs; the run is 48/48 green. Nothing here needs fixing, and
nothing here blocks the feature. What follows is the single observation left
over from running the same test-gap sweep that produced
`VC104-BACKEND-DEFECTS.md` §3 on the phone-order lane.

## Six response keys the client dereferences, and the suite never names

`backend/tests/vc105Profitability.test.js` does not contain these strings at all:

| Key | Produced at | Read by W2's UI at (`x/vc105-ui`) |
|---|---|---|
| `meta.contractVersion` | `api/routes/menuProfitability.js:130` | `pages/MenuProfitability.jsx:612` |
| `meta.baseSha` | `api/routes/menuProfitability.js:131` | `:612` — unguarded `.slice(0, 7)` |
| `meta.costing.refundPolicy` | `:141`, from `lib/vc105/costProvider.js:160` | `:259` |
| `row.costStatusReason` | `lib/vc105/profitability.js:230` | `:276–278` |
| `row.costedQty` | `lib/vc105/profitability.js:173` | `:342` |
| `row.discountPaise` | `lib/vc105/profitability.js:163` | `:245` |

The neighbouring keys *are* asserted — `meta.costing.dependency`, `.source`,
`.methodStatus`, `.missingCapabilities` at `:645–648`, `meta.marginLabel` at
`:659–660`, `meta.scope.branchId` at `:666`. These six sit in the same objects
and were simply not reached.

### The one worth a line: `costStatusReason`

The suite pins `costStatus === 'MISSING'` in four places — `:171`, `:210`,
`:366`, `:367` — but never the reason string the client actually prints
("Reason no cost exists: …"). Asserting the refusal without the reason is the
gap that lets a reason quietly become the wrong constant: `costStatusReason` is
computed as `[...row.costReasons][0] ?? 'NO_COST_SOURCE'`, so a regression
surfaces as a plausible-looking fallback rather than an error.

One line on the existing test at `:171` closes it, with no new fixture:

```js
expect(r.rows[0].costStatusReason).toBe('NO_COST_SOURCE');
```

## What this note does not claim

W2 does **not** claim any of the six is wrong today. W2 cannot claim it either
way: costing is BLOCKED on the inventory lane, so `VC105-UI-DELIVERY.md` §4
records **Costing-verified = nothing**. The `MISSING` path is the only one
either side has actually seen, and it renders correctly in W2's QA screens. Most
of this gap closes on its own the day real `ACTUAL` costs flow and the costed
path gets exercised for the first time — by both of us.

W2 did not run this lane's suite; the table above is a string search of the
committed test file at `81859de` against the committed source it tests.

## Why this is a note and not a report

Worth saying plainly, because the contrast is the useful part: this lane's suite
is in good shape. Its 42 tests assert the standing rules head-on — uncosted
reports `MISSING` and null and never zero (`:166`), totals cover costed lines
only and say how many they excluded (`:179`), a group holding one uncosted line
cannot report `ACTUAL` (`:203`), historical reproducibility (`:216`), a negative
margin is not clamped (`:241`), rounding happens exactly once (`:372`), an
uncosted row's breakdown is empty rather than fabricated (`:456`), the margin is
labelled contribution margin and not net profit (`:657`), and role/tenant
scoping including cross-tenant 404-not-403 (`:664`, `:674`, `:684`).

It also carries the negative controls: the synthetic provider is refused in
production (`:471`) and refused without the explicit flag (`:479`). That is
precisely the class of check whose absence let VC-104's D-1 sit unseen behind a
green suite. Every parameter the endpoint accepts is exercised too — `from`/`to`,
`branchId`, `channel`, and all four `groupBy` values (`:294–296`, `:694`, `:697`).

Raised on the shared task list as **#11**, flagged optional and non-blocking so
it does not compete with **#10** (VC-104 D-1/D-2, which did need a decision).
Both were fixed on 09-24. What still needs one is the single D-2 limitation the
fix does not close: an ASAP order reassigned after its own slot has elapsed
occupies nothing, so a store can still be overfilled. It is being worked on
branch `x/vc104-slot-anchor` — the anchor turns out to be derivable from the
`REASSIGNED` event already written on every move, so it is a read change rather
than the migration this note first claimed. See `docs/VC104-BACKEND-DEFECTS.md`
§D-2 *What this does not settle*.
Nothing here needs a decision before VC-105 ships.

**Update 09-25 — the limitation is fixed on the branch, and still open on
`main`.** Both halves of that sentence matter, so neither is dropped here.

*Fixed on the branch.* `x/vc104-slot-anchor` anchors a moved order to the `at`
of the latest `REASSIGNED` event into its current store, which is exactly the
derivation this note predicted, with **no new column** — the migration it adds
is two `CREATE INDEX` and nothing else. I verified it independently rather than
on report: a worktree built from `4b0ea9f` plus the branch's uncommitted work,
on a throwaway Postgres of my own, gives **673/673 backend tests green (22
files)**, and the original measurement (cap 2, three back-dated transfers ⇒ four
live orders reporting `booked = 1, available = true`) now reads **2 live and
`booked = 2`**, with the second transfer refused `409 AT_CAPACITY`.

*Still open on `main`.* That work is **uncommitted in its own worktree** as of
this writing, so nothing of it is on `main` (`dd15369`) or on `github/main`
(`584de37`). Anyone reading this note against either tip is still reading a tree
where a late transfer occupies nothing. Do not treat the paragraph above as
shipped until the branch lands.

*One gap the branch's own negative controls found.* Its mutation battery runs
twelve mutants; eleven are caught. The twelfth — delete the binding capacity
re-check from inside the reassign transaction — leaves **the entire suite
green**, because every sequential test is already refused by the advisory read
that runs before the transaction. So the in-transaction re-check on reassign is
currently unpinned. That is a test-coverage gap, not a defect: the call is
present and correct. It is also, read the other way, the cleanest evidence that
the binding check does **not** change ordinary behaviour — it only decides
genuine races, which is what keeps the advisory capacity contract intact.
Reported to the branch owner with a proposed deterministic test.
