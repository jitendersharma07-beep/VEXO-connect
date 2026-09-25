# D-6 is now pinned by tests — please do not "fix" it

**From:** the session working D-5/D-6 in this worktree (`main-merge`)
**Date:** 2026-09-24
**Commit:** `2aea286`, pushed to `github` `main` (`e78928a..2aea286`)

## The one thing that matters

`backend/tests/promotions.test.js` grew 5 tests (42 → 47) under
`describe('archiving a campaign (D-6)')`. **They pin current behaviour. They are
not a specification.** If you see them go red, the right reaction is "someone
changed archiving", not "the tests are wrong".

**D-6 is not fixed and should not be fixed without the owner.** Archiving a
promotion still permanently burns its code. That is deliberate for now.

## If you are tempted to fix it anyway, read this first

The obvious half-fix is **worse than the status quo**, and this is measured, not
predicted. Filtering the duplicate check in `routes/promotions.js` so it ignores
`ARCHIVED` rows, *without* also replacing the unique index, gives:

```
expected 500 to be 409
```

`@@unique([companyId, code])` is **total** — it does not know about status. Skip
the route's own 409 and the write falls through to a raw Postgres constraint
violation, i.e. `POS_INTERNAL_ERROR`. So that option is **a migration plus a
route change, together or not at all.** Half of it ships a 500 to the till.

## Why it is owner-gated rather than just open

There is no promotions contract anywhere to say whether permanent code
reservation is intended:

```
$ grep -c -i promotion docs/PHASE2-CONTRACT.md docs/VC104-API-CONTRACT.md
docs/PHASE2-CONTRACT.md:0
docs/VC104-API-CONTRACT.md:0
```

Nothing records intent, so choosing a behaviour here would be setting policy by
implementation. A third option (restore-to-DRAFT keeping the same identity,
code, `redemptionCount` and history, requiring a fresh `promo.publish`) is named
in the doc but **deliberately left undesigned** — no other entity in this
codebase has an unarchive route, and adding the first one sets precedent.

Full write-up: `docs/VC104-BACKEND-DEFECTS.md`, section D-6.

## What this does to your test runs

Baseline on a clean tree is **639/639**. With my two test files it is
**644/644**, 22 files. If your run reports 655 and one failure in
`razorpayFlow.test.js`, that is your own uncommitted `orders.js` in the tree, not
D-5, D-6 or a flake — it was green on a tree built from `HEAD` plus only my two
test files.

## Two facts the reproduction settled that reading the code could not

- A discount **already applied** to an order survives archiving completely
  untouched — snapshot, `discountAmount`, totals.
- A campaign with **no code** reserves nothing; a second uncoded campaign is
  created fine afterwards.

Nothing in any database was changed: no code renamed, no archived campaign
deleted, no redemption counter reset, no historical invoice rewritten.

## Your work

I committed by pathspec — only `backend/tests/catalogModifiers.test.js`,
`backend/tests/promotions.test.js` and `docs/VC104-BACKEND-DEFECTS.md`. Your
dirty files (`orders.js`, `phoneOrders.js`, `phase2.test.js`,
`phoneOrders.test.js`) were not touched, staged or reverted.

I also saw your D-3 work land on top of my committed copy of
`VC104-BACKEND-DEFECTS.md` — the merge is clean, my D-5 and D-6 rows survived
intact, and I have left your version alone.

One small thing: `backend/src/api/routes/orders.js.tmp.3536382.e7841f119832` is
an editor temp file of yours sitting untracked in the tree. I have not removed
it — it is yours to clean up, but it will show up in `git status` if you commit
with `-A`.
