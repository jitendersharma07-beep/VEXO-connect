# Window 6 → Window 4 — staging must carry the store-scope fix (2026-09-26)

**Short version: the candidate must contain the `resolveStoreInScope` fix —
which in practice means `ef6bc79` — and the gate you run against it is
`3bc70ce` on `x/identity-tests`.**

Without the fix, staging puts a build on a public-ish host in which a
store-pinned operator can write to a store they do not hold. Full analysis and
evidence: `docs/HANDOFF-W6-TO-W1-STORESCOPE.md` and
`/home/atc-noc/vexo-connect-x/WINDOW-1-HANDOFF-IDENTITY.md`.

| You need | Take |
|---|---|
| The fix | **`ef6bc79`** (tables lane) — pushed, already inside candidates |
| The gate that proves it | **`3bc70ce`** on **`x/identity-tests`** — test-only, based on `16a22b0` (= main `728a57c` + `x/tables` `12fa573`) |

**Use `x/identity-tests`, not `x/identity-coverage`.** The older branch carries a
middleware hunk of my own that duplicates `ef6bc79` and would conflict with it;
`3bc70ce` is the same two test files with no source change, already verified on a
tables-line base at **75/75, exit 0**
(`~/vcx-w6-ident/.runlogs/rebased-final.log`).

## What the defect does, in one paragraph

`resolveStoreInScope` spread the caller's scope fragment over the store id the
request named. For a `LIST` scope — every store-pinned role, and **any**
company-wide role narrowed by a `UserStoreAssignment` — the fragment is
`{ id: { in: [...] } }`, so the requested id was discarded and the lookup became
"any store of mine". It always matched. Ten call sites: some then wrote the
caller's raw id to a store outside their scope (`brands`,
`PUT /permissions/assignments` — a scope escalation, `invitations`, two paths in
`orders`), the rest silently wrote to **the wrong in-scope store**
(`terminals`, `devices`, `drawer`, `paymentAccounts`, `userAuthority`).

## How to check a candidate before you stage it

Either check is sufficient; the first is cheapest.

```text
grep -n "AND: \[" backend/src/middleware/permissions.js
```

Expect a hit inside `resolveStoreInScope`. If instead you see
`...branchWhereForScope(req.perm.scope),` spread into a flat `where`, the
candidate is **unfixed — do not stage it**.

By SHA, test for `ef6bc79` — that is the fix expected to be in the candidate:

```text
git merge-base --is-ancestor ef6bc79 <candidate-sha> && echo CONTAINS-FIX || echo MISSING-FIX
```

**Do not test for `f672c56`.** Two lanes fixed this independently and mine is the
one being dropped, so a candidate can be correctly fixed while that SHA is absent.
If W1 takes mine after all, the `grep` still passes and the SHA check above would
report a false `MISSING-FIX` — which is why the `grep` is the more reliable of the
two. It tests the code rather than the ancestry, and both remedies produce the
same `AND` form.

## Gate to run against the staged candidate

The two test files come from **`3bc70ce`** (`x/identity-tests`). They add no
source code, so they can be dropped onto any candidate that has the fix:

```text
git cherry-pick -n 3bc70ce     # or copy the two files across
npx vitest run tests/storeScopeResolution.test.js tests/orgIdentity.test.js
```

~10 seconds, self-contained fixtures, no seed data needed. Expect **75 passed**.

**If the candidate is missing `helpers/wipe.js`**, it does not contain main
(`09127b1`) and the files will fail to load — that is a property of the
candidate, not of the tests. `x/tables` (`12fa573`) and `x/tables-merged`
(`55eb62e`) are both in that state; `16a22b0` is not.

A result of **8 failed | 8 passed** in `storeScopeResolution.test.js` is the
exact signature of a candidate **without** the fix. Those are the numbers I got
deliberately, twice — once against my own reverted hunk and once against
`ef6bc79`'s reverted line — so treat them as diagnostic, not mysterious. It means
**do not stage this candidate**.

## Two things to expect on staging, so they are not misread as bugs

1. **A pinned principal naming a store they do not hold now gets
   `404 Store not found`.** Previously the request succeeded against a different
   store. The 404 is the fix working. Foreign-tenant and non-existent ids answer
   identically, on purpose, so ids cannot be probed.
2. **A till/device/account that UAT expects at store X may already exist at
   store Y** in any environment seeded or exercised by a *pre-fix* build. That
   is residue of the defect, not a new failure. If staging is restored from a
   snapshot taken before the fix, re-check `Terminal`, `Device`,
   `PaymentAccount`, `BranchBrand` and `UserStoreAssignment` for rows attached
   to the wrong branch before you trust a UAT result.

## Push status

`ef6bc79` — the fix you actually need in the candidate — **is already pushed**
(`github/x/tables`, `github/x/tables-merged`,
`github/candidate/tables-20260926-0603`), so nothing blocks you there.

My gate branch is **committed locally but not pushed** — push to the shared
remote is denied on this box. If W1 has not published it by the time you need it:

```text
git -C /home/atc-noc/vexo-connect-x-lanes/w6-identity push -u github x/identity-tests
```

Its base `16a22b0` is also local-only, but both of that commit's parents are
published, so the two test files apply cleanly to any candidate you build that
contains main plus the tables lane.

Production (`pos-prod`) was not touched by this lane: no deploy, no restart, no
ownership claim taken.
