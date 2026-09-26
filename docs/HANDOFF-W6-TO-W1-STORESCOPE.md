# Window 6 → Window 1 handoff — store-scope authorisation fix (2026-09-26)

**Commit `f672c564e5139ed76519375d186f24addbd64d36`** on branch
**`x/identity-coverage`**, based on **`728a57c`** (= `github/main` at the time of
writing, verified by `git ls-remote`).

That commit is three files, nothing else:

| File | Lines | Kind |
|---|---|---|
| `backend/src/middleware/permissions.js` | +15 / −3 | **shared middleware — the fix** |
| `backend/tests/orgIdentity.test.js` | +1117 | new, 59 tests |
| `backend/tests/storeScopeResolution.test.js` | +352 | new, 16 tests |

The **branch** carries one further commit, **`6bc5a2c`** — this file and the two
other handoffs, docs only, no code. It is deliberately separate so the certified
change stays exactly the three reviewed files: cherry-pick `f672c56` alone if you
want the fix without the paperwork, or take both if you want the analysis in the
tree. Nothing in `6bc5a2c` is required for the fix to work or to be tested.

Both commits are **committed but NOT pushed** — `git push` to a shared remote is
denied on this box. Exact command to run, unchanged, from any checkout of the
lane:

```text
git -C /home/atc-noc/vexo-connect-x-lanes/w6-identity push -u github x/identity-coverage
```

It creates a new remote branch. `main` is untouched. Production is untouched —
no deploy, no restart, no `pos-prod` change was made by this lane.

---

## 1. What was wrong

`resolveStoreInScope` is the shared "is this store both inside the tenant and
inside the caller's own scope" check. It built one flat `where` object and
spread the scope fragment into it:

```js
// BEFORE
const branch = await prisma.branch.findFirst({
  where: {
    id: String(branchId),
    companyId: req.companyScope.id,
    ...branchWhereForScope(req.perm.scope),   // ← last key wins
  },
});
```

For a `LIST` scope, `branchWhereForScope` returns `{ id: { in: [...] } }`. The
spread therefore **overwrote the `id` the caller asked for**. The query silently
degraded from

> *this store, if it is mine*

to

> *any store of mine*

…which always found a row. `findFirst` returned it, and the guard never fired.

### Who was affected

`LIST` only — and `LIST` is precisely the population the check exists to
constrain:

| `scope.kind` | fragment | collides with `id`? |
|---|---|---|
| `ALL` (platform) | `{}` | no |
| `COMPANY` | `{}` | no |
| `REGION` | `{ regionId }` | no |
| **`LIST`** | **`{ id: { in: [...] } }`** | **yes** |

Every store-pinned role resolves to `LIST`, as does **any** company-wide role
narrowed by a `UserStoreAssignment` (per `storeScopeFor`, assignments *replace*
a role's implied scope). So a `COMPANY_ADMIN` deliberately pinned to one store
by the tenant was unconstrained by the very mechanism used to pin them.

### Two harm modes across the eleven call sites

Eleven invocations across nine files — eight routers plus `lib/userAuthority.js`
— per `git grep -n resolveStoreInScope -- 'backend/src/**'`. **Corrected:** an
earlier revision of this section was headed "the ten call sites", and the test
header said "ten call sites across nine routers". The enumeration below was
always complete — 6 in Mode A plus 5 in Mode B — so only the summary figure was
wrong, written before the list and never recomputed from it. Nothing about the
defect, the remedy or the tests changes; but a count that disagrees with its own
evidence is the defect class the print-agent lane files as A16, so it is stated
rather than quietly overwritten.

**Mode A — bypass.** Caller discards the returned row and then writes the
caller-supplied raw id. The write lands on a store the caller does not hold.

- `api/routes/brands.js:147`
- `api/routes/permissions.js:172`
- `api/routes/permissions.js:359` — `PUT /permissions/assignments`. **Scope
  escalation:** the endpoint that decides which stores a user holds could be
  pointed at a store the actor does not hold.
- `api/routes/invitations.js:119`
- `api/routes/orders.js:986`, `api/routes/orders.js:1108` — live for
  assignment-narrowed principals specifically, because `loadOrder`'s own fences
  key off `isBranchPinned` + `req.user.branchId` and do not see an assignment.

**Mode B — wrong store, silently.** Caller uses the returned row, so the write
is in-scope but lands on **a different store than the request named**.

- `lib/userAuthority.js:105`, `api/routes/devices.js:143`,
  `api/routes/terminals.js:73`, `api/routes/paymentAccounts.js:153`,
  `api/routes/drawer.js:458`

`requireStoreParam` (the `/:branchId/…` flavour) shares the defect but currently
has **zero call sites** — latent, fixed anyway.

### The app named the bug itself

Asked to create a till at **Store B** by an admin pinned to **Store A**, the
pre-fix code created it at **Store A**. The next honest request then failed
with the application's own error:

```text
Store A already has a till called T1
```

That is Mode B in the product's own words.

---

## 2. The fix

```js
// AFTER
const branch = await prisma.branch.findFirst({
  where: {
    AND: [
      { id: String(branchId), companyId: req.companyScope.id },
      branchWhereForScope(req.perm.scope),
    ],
  },
});
```

Both constraints survive, whatever keys a future scope kind introduces. This is
also how the **correct sibling implementation** — `requireBranchAccess` in
`middleware/auth.js` — has always done it (fetch by id, then test membership),
so the change aligns the broken copy with the one that was right.

I audited every other place a scope fragment is spread into a `where`. None
collide: `scopedBranchIdWhere` targets `branchId` (different key),
`paymentAccounts`' `scopeWhere` produces `{ OR }`, `phoneOrders`' produces
`{ companyId, OR }`. `resolveStoreInScope` was the only instance.

---

## 3. Evidence — sanitized, reproducible

Logs preserved at `/home/atc-noc/vcx-w6-ident/.runlogs/`. Lane runner is
`/home/atc-noc/vcx-w6-ident/vcxw6i` (hostname-guarded to `atc-noc`, aborts
unless `TEST_DATABASE_URL` names `vcx_w6ident_test`).

### 3.1 Before / after on the lane gate

| Run | Code state | Result | Log |
|---|---|---|---|
| Before | spread (unfixed) | **6 failed / 65 passed (71)** | `before-fix.log` |
| After | `AND` | **71 passed (71)** | `after-fix.log` |
| After + 2 new API negatives | `AND` | **75 passed (75)**, exit 0 | `lane-gate-restored.log` |

The six pre-fix failures, verbatim:

```text
× brands > a store-narrowed admin may attach only the stores in their own scope
× resolveStoreInScope > returns the store that was actually asked for, not merely some store in scope
× resolveStoreInScope > refuses a store outside a LIST scope
× store scope through the routers that trust the caller-supplied id > a store-narrowed admin cannot attach a brand to a store outside their scope
× store scope through the routers that trust the caller-supplied id > …and a mixed payload is refused whole, not partially applied
× store scope through the routers that trust the caller-supplied id > a store-narrowed admin cannot assign a colleague to a store they do not hold
```

### 3.2 The new negatives are load-bearing

After adding the two API-level negatives (terminals, users) I **reverted the
middleware hunk** and ran `storeScopeResolution.test.js` alone, to prove no
assertion passes for a reason unrelated to the fix:

```text
Tests  8 failed | 8 passed (16)        ← control-prefix-validation.log
```

8 of 16 are decided by this hunk. The fix was then restored and the diff
re-verified verbatim.

### 3.3 Full suite on the fixed code — the certifying run

`full-suite-after-fix.log`, 39 421 bytes, Start 11:03:22, single run, not
relaunched:

```text
 Test Files  1 failed | 53 passed (54)
      Tests  4 failed | 1722 passed (1726)
   Duration  969.43s
```

Skipped: 0. All four failures are in **one** file, `tests/phase2.test.js`,
group "daily closing":

```text
× only a refund handed back in cash comes out of the expected drawer   20005ms  ← timeout
× a second closing needs to say which one it corrects                    164ms
× history shows the correction and hides what it replaced…                33ms
× a closing says when money landed on the day after it was counted        25ms
```

**Adjudicated as not caused by this change**, on two independent grounds:

1. **No shared code path.** `phase2.test.js` contains **zero** references to
   any endpoint that reaches `resolveStoreInScope` — no `/drawer`,
   `/terminals`, `/devices`, `/api/users`, `/brands`,
   `/permissions/assignments`, `/invitations`, `/promotions`,
   `/payment-accounts`. Its surface is auth / catalog / orders / reports /
   tables.
2. **Green in isolation on the same fixed code.** `phase2-isolated.log`:
   **67 passed (67)**, **17.50s**, exit 0 — against 37.4s for the same file
   inside the loaded 969s run. The first failure is a 20 000 ms timeout and the
   other three cascade from it (a missing prior closing gives 400 instead of
   409, `isCorrection` false, `postClose` null). A `where`-clause change cannot
   produce a hang; contention on the shared dev Postgres can.

Treat those four as a **pre-existing flake under load in W2's file**, not a
regression here. They are outside this lane's ownership; flagged, not touched.

### 3.4 Private-DB residue cleared

Post-run audit of `vcx_w6ident_test`:

```text
BranchBrand        cross-company rows | 0
UserStoreAssignment cross-company rows | 0
```

Remaining rows match `storeScopeResolution.test.js`'s legitimate end state
exactly — 4 Branch, 3 BranchBrand, 2 UserStoreAssignment, 1 Terminal. The one
Terminal is `T1` at **Store A** (`SA`); both assignments point at `SA`
(`cashier@scope.local`, `pinned@scope.local`). No artefact of the pre-fix run
survives: `grep -c "emptied 139 tables"` = 1 in the restored-gate log,
confirming the per-file catalogue wipe ran.

---

## 4. Integration instructions

> **Superseded in one respect — read this first.** The tables lane fixed the
> same defect in the same function a day earlier, in **`ef6bc79`** on `x/tables`,
> which is already pushed and already inside candidates. The two remedies are
> functionally identical (theirs wraps only the fragment:
> `AND: [branchWhereForScope(scope)]` beside top-level `id`/`companyId`; mine
> puts both inside the `AND`). **Take `ef6bc79` and drop my middleware hunk** —
> it is earlier, published, and carries the fuller comment. Both cannot be taken:
> they touch the same lines with different comment text, and that conflict must
> not be resolved by keeping both comments.
>
> Everything below still applies to the **test files**, which do not collide with
> theirs (`storeScopeGate.test.js`). Note also the correction to `ef6bc79`'s risk
> assessment in `WINDOW-1-HANDOFF-IDENTITY.md` §2: `orders.js` was *not* masked
> for assignment-narrowed principals, because `isBranchPinned` is role-based.

1. **Cherry-pick `f672c56` for its two test files, discarding the
   `permissions.js` hunk** — or copy the files across directly. Base is
   `728a57c` = `github/main`. `orgIdentity.test.js` overlaps nothing;
   `storeScopeResolution.test.js` covers all four scope kinds at middleware level
   plus terminals/users API negatives, and closes the
   `PUT /brands/:id/stores` coverage gap `ef6bc79` recorded as *not* added.
2. **Whichever middleware fix lands, keep a regression test with it.** The hunk
   alone leaves nothing standing between a future refactor and a silent repeat —
   `storeScopeGate.test.js` or `storeScopeResolution.test.js` both serve; the
   point is that one of them must be present.
3. **Gate to re-run after integration** (fast, ~13s, needs no fixtures beyond
   its own):
   ```text
   npx vitest run tests/storeScopeResolution.test.js tests/orgIdentity.test.js
   ```
   Expect **75 passed**. If `storeScopeResolution` shows 8 failures, the
   integration dropped the middleware hunk.
4. **Check the candidate actually contains it** — cheap, unambiguous:
   ```text
   grep -n "AND: \[" backend/src/middleware/permissions.js
   ```
5. **No migration, no schema change, no config change, no frontend change.**
   `License.modules` is not touched. Nothing to seed. Nothing to restart beyond
   the normal candidate build.
6. **Behaviour change to expect in UAT:** a store-pinned or
   assignment-narrowed principal who names a store they do not hold now gets
   **404 `Store not found`** where it previously succeeded against the wrong
   store. That is the fix working. A tenant who had unknowingly been relying on
   the old behaviour would see it as "permissions got stricter" — correct, and
   worth a line in the release note.

---

## 5. Items for W1/W3 awareness, not fixed here

- **`orders.js:986` and `orders.js:1108` were live Mode-A bypasses** for
  assignment-narrowed principals, because `loadOrder`'s fences read
  `isBranchPinned` + `req.user.branchId` and never consult
  `UserStoreAssignment`. The `AND` fix closes the store-resolution hole, but
  W3 should decide whether `loadOrder` itself ought to be scope-aware rather
  than role-aware. Out of this lane.
- **Six call sites are covered by the middleware-level tests but not by their
  own API-level negative**, for concrete fixture reasons rather than oversight:
  `devices` (needs terminal + reader fixtures), `paymentAccounts` (gated by
  `requireSecretStorage`), `drawer` (needs a device session, and has
  `assertDeviceStore` as a second independent fence), `invitations` (gated by
  `requireMailConfigured`), `permissions.js:172` (needs `permission.write`,
  which is `DEFAULT_OFF` for `COMPANY_ADMIN`). The two chosen for API-level
  proof — `terminals` (Mode B) and `users`/`userAuthority` (Mode B), plus
  `brands` and `PUT /permissions/assignments` (Mode A) — exercise both harm
  modes end to end through real HTTP.
- **`requireStoreParam` has no callers.** Fixed, untested at API level for
  exactly that reason.
- **Entitlement labels `MULTI_GST`, `BRANDS`, `REGIONS` are not enforced.**
  Separate handoff: `docs/GAP-ORG-ENTITLEMENTS-UNENFORCED.md`. **This commit
  does not fix them** and does not claim to.

---

## 6. Verdict

**PASS** — the shared-middleware change is certified for integration.

- 1722 / 1726 on the full suite, with the only 4 failures proven off this
  change's code paths and green 67/67 in isolation on the same fixed code.
- 75 / 75 on the lane gate, exit 0.
- Every new negative shown load-bearing by an 8-failure pre-fix control.
- Test-database residue clear; no cross-tenant row anywhere.
- Production untouched.
