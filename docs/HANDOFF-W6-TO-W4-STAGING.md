# Window 6 → Window 4 — staging must carry the store-scope fix (2026-09-26)

**Short version: do not stage a candidate that predates
`f672c564e5139ed76519375d186f24addbd64d36`.**

That commit fixes a live authorisation defect in shared middleware
(`backend/src/middleware/permissions.js`). Staging an older candidate would put
a build on a public-ish host in which a store-pinned operator can write to a
store they do not hold. Full analysis and evidence:
`docs/HANDOFF-W6-TO-W1-STORESCOPE.md`.

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

```text
git merge-base --is-ancestor f672c564e5139ed76519375d186f24addbd64d36 <candidate-sha> && echo CONTAINS-FIX || echo MISSING-FIX
```

## Gate to run against the staged candidate

~13 seconds, self-contained fixtures, no seed data needed:

```text
npx vitest run tests/storeScopeResolution.test.js tests/orgIdentity.test.js
```

Expect **75 passed**. A result of **8 failed | 8 passed** in
`storeScopeResolution.test.js` is the exact signature of the middleware hunk
having been dropped during integration — that is the control I ran deliberately
against reverted code, so treat those numbers as diagnostic, not mysterious.

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

The branch `x/identity-coverage` is **committed locally but not pushed** — push
to the shared remote is denied on this box. If you need the commit and W1 has
not published it yet, the exact command is:

```text
git -C /home/atc-noc/vexo-connect-x-lanes/w6-identity push -u github x/identity-coverage
```

Production (`pos-prod`) was not touched by this lane: no deploy, no restart, no
ownership claim taken.
