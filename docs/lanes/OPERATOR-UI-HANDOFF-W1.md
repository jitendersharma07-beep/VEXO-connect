# Handoff — `x/operator-ui` → Window 1

**Rewritten 2026-09-26.** The previous version of this file described the lane
as "code-complete and gate-verified, not journey-verified" and asked someone
else to push. Both are now out of date: the branch is pushed and the journeys
ran. That text is superseded, not merely amended — read this file, not the
prior one.

| | |
|---|---|
| **Branch** | `x/operator-ui` — **now on the remote** |
| **Head** | `2ae5c1c` |
| **Remote** | `github` = `jitendersharma07-beep/VEXO-connect` |
| **Branched from** | `d625370` |
| **PR** | **not opened — `gh` is not installed on this box.** See §5 |
| **Focused gate** | **332 passed, 0 failed, 3 open gaps** |
| **Verdict** | `GREEN — with 3 OPEN GAP(S), not a clean pass` |

The three gaps are two authorization questions on W3's `kitchen.js`. They are
**not failures of this lane and not passes**. §3.

## 1 · Commits

| Commit | What |
|---|---|
| `357e617` | Salvage the VC-102/VC-103 screens drafted in the `x/w2-frontend` lane |
| `07fd3c0` | The screens: gates, tenancy/branch scoping, loading and error states |
| `cd3c973` | `docs/lanes/OPERATOR-UI.md` — the other session's lane report |
| `32f6e26` | The kitchen-walk fix, the `Modal` fix, and the §4 correction |
| `b258c29` | The acceptance harnesses, which until now existed on this host only |
| `2ae5c1c` | Proves the dev-build diagnosis with a control; retracts one claim |

vs `github/main@728a57c`: **6 ahead, 7 behind**. The 7 are test-infrastructure
and release docs and touch **no file this branch changes**, so the merge should
be clean. Worth rebasing before review so the PR diff is only this lane's work.

## 2 · What changed, and why each thing was wrong before

**The VC-103 screens were never broken.** The kitchen walk reported 7 failures
and served **0** kitchen routes. One line caused all seven:

```js
await page.waitForSelector('select[aria-label="Store"] option:nth-child(2)');
```

`waitForSelector` defaults to `state:'visible'`, and an `<option>` inside a
collapsed `<select>` has no box — so it can never become visible however well
the page loads. Measured on that very picker: **4003ms timeout vs 16ms** with
`{ state: 'attached' }`. Without a chosen store `useKitchenBranch` never becomes
ready and not one `/kitchen` request is issued, so every board assertion fails
for one upstream reason. `walk-promotions.cjs` carried the identical bug on its
Item picker (4000ms vs 9ms). Both were authored in `07fd3c0` and never run.
Now **9/9**, 15 kitchen routes served, 0 console errors.

**A tall modal was unusable, not merely awkward.** Centring on a `fixed inset-0`
flex box pushes a taller-than-viewport dialog past **both** edges, and content
above a flex container's top edge cannot be scrolled back. On the promotions
editor (996–1050px tall) the close button sat 23px above the viewport at
1440×900 and 89px above it at 1366×768, with "Create draft" the same distance
below: the dialog could be neither submitted nor dismissed. Scrolling now lives
on the overlay with centring on an inner `min-h-full` wrapper, which leaves
short modals pixel-identical. Escape closes.

**The "GREEN frontend build" was a development build.** `07fd3c0` recorded
2,067.13 kB / 369.71 kB gzip. `set -a; source .env` leaks `NODE_ENV=development`
into vite, which then resolves development React. Module count is *identical*
(1717) and the manifest looks normal — only the doubled weight shows it.

Rebuilt clean: `assets/index-Bskb8Yso.js`, **983.94 kB / 253.41 kB gzip**,
sha256 `6c5b34feed6f528f013d17645c4e9b01cd21db4907af810f05facb0c792df497`,
reproduced twice including once on the exact committed tree.

**Proven, not inferred:** forcing `NODE_ENV=development` on this same tree emits
**2,067.50 kB / 369.81 kB** — their figure to within 0.4 kB, the difference
being the `Modal` change since. A matching bundle filename or module count would
not have caught any of this.

**One of my own claims is retracted in `2ae5c1c`.** I first reported "0
dev-React markers". The conclusion holds; the argument did not. Against both
artifacts:

| grep | prod | dev control | |
|---|---|---|---|
| `react-refresh` | 0 | **0** | useless — 0 on a dev build |
| `__REACT_DEVTOOLS_GLOBAL_HOOK__` | **5** | 21 | useless — prod React registers with DevTools |
| `checkDCE` | **2** | 1 | useless — higher in production |
| `Each child in a list should have a unique` | 0 | 3 | real |
| `Warning: ` | 0 | 4 | real |
| `validateDOMNesting` | 0 | 3 | real |
| `The above error occurred in` | 0 | 2 | real |

Two of the three greps I used cannot distinguish the builds, and `grep -c` over
a minified single-line bundle collapses them all to "1" anyway. If you are
checking someone else's build artifact, use the bottom four — each has a
non-zero control.

## 3 · The two open gaps — W3's decision, not mine

Full write-up committed at **`docs/VC103-KITCHEN-AUTHZ-QUESTIONS.md`**.
`kitchen.js` gates on hardcoded `requireRole` lists, not `requireAction`:

```
operate   = CUSTOMER_OWNER, BRANCH_MANAGER, CASHIER
managerUp = CUSTOMER_OWNER, BRANCH_MANAGER
```

- **K-1 — `COMPANY_ADMIN` and `REGIONAL_MANAGER` are in neither list**, so both
  get `403` on every `managerUp` route. Measured with real sessions for all six
  roles. What makes it a question and not a defect: both resolve broad
  permissions elsewhere via the `ROLE_ACTIONS` baseline, which `kitchen.js`
  never consults. Either the exclusion is deliberate (the kitchen is a
  store-floor surface) or the allowlist predates the roles. Nothing in the tree
  distinguishes these.
- **K-2 — `GET /kitchen/stations` carries no role gate at all.** Every sibling
  carries `operate` or `managerUp`; this one has only `requirePosAuth` +
  `resolveCompanyScope`. `FINANCE`, in neither list, gets **200**. Tenancy still
  holds, so this is over-exposure inside one company, not a leak.

**Please do not let these be reported as security passes.** The harness emits
them as a distinct `GAP` outcome, reprints them under `OPEN GAPS` with an owner,
and forces the verdict to say "not a clean pass". A test that reproduces a hole
is not evidence of a control, and counting one as a pass is how the hole gets
certified.

The frontend gates on the *same* three-role list, so the UI never offers a
screen the server will refuse. That is a consistency fix and **deliberately not
an answer** — if W3 widens the backend, this lane will make the matching
frontend edit.

Two probe traps are recorded in that doc because each produced a false result:
asserting owner/manager/cashier all get 200 cannot distinguish "correctly allows
`operate`" from "allows everyone" since all three are inside `operate`; and the
probe first ran without `?branchId=`, got a 400 from `callerBranchId()` before
reaching any gate, read "not 200, therefore refused", and **reported the gap
closed**. Anything neither 200 nor 403 is now INCONCLUSIVE and fails.

## 4 · Evidence

| Suite | Result |
|---|---|
| `promotions-acceptance.mjs` | 82 / 0 |
| `kds-acceptance.mjs` | 156 / 0 |
| `authz-acceptance.mjs` | 47 / 0 **+ 3 gaps** |
| `journeys.mjs` (real browser) | 47 / 0 |
| **total** | **332 / 0 / 3 gaps** |
| `walk-kitchen-fixtures.cjs` | 9 / 9 |
| `walk-promotions.cjs` | 7 / 7 in scope |
| production build | 983.94 kB, sha256 `6c5b34fe…` |

**Run provenance — captured at finish, not only at start.** A start-only check
cannot see a co-tenant restarting the API or moving the tree mid-run, and the
prior handoff records that happening to this lane once (`vcxo up` reported pid
199577; a `vcxo status` seconds later reported 212125). For this run:

| | at start | at finish |
|---|---|---|
| tree HEAD | `2ae5c1c` | `2ae5c1c` |
| tracked files dirty | 0 | 0 |
| API on `:5571` | pid **119279** | pid **119279** |
| Vite on `:5671` | pid **119335** | pid **119335** |

Both processes started 10:57:37–38 and were never recycled, so all four suites
were served by one API process against one immutable tree. The only untracked
files throughout are this handoff and the preserved `api-journeys.cjs`; neither
is loaded by anything.

The backend was not restarted because it did not need to be — this lane changes
no backend file. The frontend change is live regardless: the journeys drive the
Vite dev server, which reads from disk per request, so they exercised the fixed
`Modal` and not a stale bundle.

Full log:
`/home/atc-noc/vcx-opui-local/.runlogs/gate-everything-20260926T124954Z.log`
(467 lines, exit 0) — and it is the *complete* capture. An earlier run of mine
was piped through `tail -60`, which silently discarded three of the four suites
and left only authz's 47 visible. Worse, **`accept all` does not run
`journeys`**; the subcommand that runs the lot is **`accept everything`**. Both
mistakes inflate confidence while reducing coverage, and neither shows up in the
exit code.

Everything the prior handoff listed as NOT done is done: cross-tenant isolation
ran and asserts **exactly 404** (a 403 would confirm the id exists in the other
tenant, which is the disclosure); promotions create → publish → rules → archive;
KDS station → KOT → board → transition; and real-browser acceptance.

Transitions are asserted by polling the `KitchenItem` row in Postgres, not by
reading the screen or trusting a 200. The rival-tenant station check builds a
probe station of its own first, so it cannot pass vacuously against an empty
table — an earlier version printed a green line for "tenant A has 0 stations".

**`walk-promotions.cjs` steps 6–12 fail and are out of this lane's scope** —
they drive a "Sell offers" panel that belongs to another surface. In-scope steps
1–5 and 13–14 pass. Please log it against the owning lane, not this one.

## 5 · What Window 1 still needs to do

**Open the PR.** `gh` is not installed here, so I could not:

```text
https://github.com/jitendersharma07-beep/VEXO-connect/pull/new/x/operator-ui
```

Base `main`, head `x/operator-ui` at `2ae5c1c`. Suggested title:
`VC-102 promotions and VC-103 kitchen display (operator UI)`.

**Get W3 a decision on K-1 and K-2.** This is the only thing blocking a clean
pass. Both are one-line changes once the policy is settled; if K-1 goes the
widening way, this lane makes the matching frontend edit.

**Route the Sell-offers panel** (§4) to its owning lane.

## 6 · Two things I did not touch

- **`tests/e2e/api-journeys.cjs` is unattributed and left untracked.** It is not
  mine, I could not identify its author, and it is excluded from every commit
  and every number above. Do not let it be swept into a broad `git add`.
- **W3's comment in `03612b7`** still asserts the "fileParallelism shares one
  process" mechanism that W1's 07:45Z correction in
  `WINDOW-1-CAPTAINWORKFLOW-ENV.md` falsified. Flagged, not edited.

I did remove `backend/tmp-fixtures-authz.mjs`, which was mine — verified
untracked and verified superseded (the authz suite runs green without it) before
deleting. The `vcxo fixtures` subcommand it served is retired; the harnesses
self-provision their extra roles and the rival tenant.

## 7 · The harnesses are now in the repo

`tools/opui-acceptance/` (commit `b258c29`) — a verbatim, byte-identical
snapshot of `/home/atc-noc/vcx-opui-local/`, which is **not a git repo and not
backed up**. They are the evidence behind every number here, and
`VC103-KITCHEN-AUTHZ-QUESTIONS.md` asks W3 to reproduce the findings by running
them, which was unactionable off this box.

Host-specific tooling with absolute paths, not a portable suite — the README
says so plainly. **No credentials:** `.env` and the two 0600 files
(`.jwtsecret`, `.seedpasswords`) are excluded and documented as excluded; `vcxo`
mints the latter two on first use. Scanned for postgres URLs, long hex and
base64 — the only match is a runtime template taking `${PGPW}`.

This does not weaken the dependency-isolation claim: `vcxo setup` reuses the dev
clone's `node_modules` only after asserting four manifests are byte-identical
(backend and frontend `package.json` + `package-lock.json`, those four and
nothing else), so a `tools/` directory falls outside what that check covers.

## 8 · Lane environment

Worktree `/home/atc-noc/vexo-connect-x-lanes/operator-ui`; DBs `vcx_opui` /
`_test` / `_shadow` on `127.0.0.1:5440`; API `:5571`, Vite `:5671`; runner
`/home/atc-noc/vcx-opui-local/vcxo`.

Browser stack that works here: `playwright-core` **1.49.1** plus
`POS_E2E_CHROMIUM=/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome`.

`vcxo lint` deliberately refuses — this repo has no ESLint configuration and
`frontend/Dockerfile.prod` gates on `npm ci` + `npm run build` only, so
`vcxo build` is the check that corresponds to CI. A runner that had silently
`npx eslint`'d would have recorded "lint passed" having linted nothing.
