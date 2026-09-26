# VC-103 kitchen authorization — two open questions for W3

**From:** operator-UI lane (`x/operator-ui`, VC-102/VC-103 screens)
**To:** W3 (kitchen backend lane `x/kitchen`, `backend/src/api/routes/kitchen.js`)
**Date:** 2026-09-26 · Line numbers are this tree's, kitchen.js at `a8b610e`

Two authorization questions found from the outside, by driving the landed
kitchen API with real sessions for every role in `PosRole`. Neither is changed
here: `kitchen.js` is W3's file and both questions turn on **intent**, which no
VC-103 spec in this repo settles. This document exists so the decision is W3's,
taken with the evidence already gathered.

Both are reproduced by `authz-acceptance.mjs`. They are reported by that harness
as `GAP`, **not** as `PASS` — a test that reproduces a gap is not evidence of a
control, and counting one as a pass is how a hole gets certified. The run prints
them again under `OPEN GAPS` at the end and the verdict line reads
`GREEN — with 3 OPEN GAP(S), not a clean pass`.

| # | Question | Observed today | Blast radius |
|---|----------|----------------|--------------|
| K-1 | Should `COMPANY_ADMIN` and `REGIONAL_MANAGER` reach the kitchen at all? | `403` on every `managerUp` route | Two real roles cannot open a kitchen screen |
| K-2 | Should `GET /kitchen/stations` have a role gate? | **No gate at all** — any authenticated role in the company gets `200` | Station names readable by every role, incl. `FINANCE` |

---

## K-1 — the allowlist predates two roles

`kitchen.js` gates with hardcoded `requireRole` lists rather than
`requireAction`:

```
operate   = CUSTOMER_OWNER, BRANCH_MANAGER, CASHIER      (board, item state)
managerUp = CUSTOMER_OWNER, BRANCH_MANAGER               (stations, routes, overview)
```

`COMPANY_ADMIN` and `REGIONAL_MANAGER` appear in neither, so both get `403` on
`GET /kitchen/overview`. Measured, with real sessions for all six roles.

What makes this a question rather than a defect: these two roles **do** resolve
broad permissions elsewhere. `COMPANY_ADMIN` resolves `promo.write` and
`promo.publish`, `REGIONAL_MANAGER` resolves `promo.apply`, both through the
`ROLE_ACTIONS` baseline in `permissions.js`. That baseline has no effect on the
kitchen because `kitchen.js` never consults it — the two axes are independent.

So either:

- **(a)** the exclusion is deliberate — the kitchen is a store-floor surface and
  a regional or company-wide role has no business on a station board; or
- **(b)** the allowlist simply predates both roles and was never extended.

Nothing in the tree distinguishes these. The operator-UI side is safe under
either answer: the Kitchen screens' route and nav gate on the *same* three-role
list (`frontend/src/lib/kitchen.js`), so the UI never offers a screen the server
will refuse. That is a UI-consistency fix and deliberately **not** an answer to
the backend question — it makes the product coherent with whichever policy W3
confirms, and it would be wrong to read it as this lane having decided.

**Decision needed from W3:** confirm (a), or extend the lists under (b). If (b),
the frontend list needs the same edit and this lane will make it.

## K-2 — `GET /kitchen/stations` carries no role gate

Every sibling route on that router carries `operate` or `managerUp`.
`GET /kitchen/stations` carries only `requirePosAuth` + `resolveCompanyScope`.

The proof needs care, and the first version of this probe got it wrong in a way
worth recording. Asserting that `owner`, `manager` and `cashier` all get `200`
proves nothing — all three are inside `operate`, so a correctly gated route
would admit them too. The assertion could not tell "correctly allows operate"
from "allows everyone", and it printed three green lines for an ungated route.

The probe now uses `FINANCE`, a role in **neither** list. It gets `200`:

```
GAP   GET /kitchen/stations admits a role in NEITHER operate NOR managerUp (finance → 200)
```

A second trap, also recorded because it produced a false all-clear: the probe
must send `?branchId=`. `FINANCE` is not in `BRANCH_PINNED_ROLES`, so
`callerBranchId()` throws `badRequest('branchId is required')` *before* any gate
is consulted. Without the parameter the probe got `400`, the code read
"not 200, therefore refused", and reported the gap **closed**. A `400` means the
request never reached the gate. The harness now treats anything that is neither
`200` nor `403` as INCONCLUSIVE and fails rather than concluding.

**Scope of the exposure.** Tenancy still holds — `resolveCompanyScope` is
applied, and the cross-tenant section proves a rival company gets none of tenant
A's stations (asserted against a station built for the purpose, so the check is
not vacuous). This is over-exposure *inside* one company, not a tenancy leak.
Station names are low-sensitivity, which is why this is filed as a question and
not an incident.

**Decision needed from W3:** add `operate` to match its siblings, or confirm the
route is intentionally open to any authenticated company user and record why.

---

## Reproducing

```
cd /home/atc-noc/vcx-opui-local && ./vcxo accept authz
```

Relevant sections: *kitchen role gates match kitchen.js operate/managerUp* (K-1)
and *GET /kitchen/stations has no role gate at all (open gap)* (K-2). Current
result: **47 passed, 0 failed, 3 gaps** — the three gap lines are K-2 and K-1's
two roles.
