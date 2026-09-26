# Window 1 — first-login gate: tested SHA, results, and what still blocks a staging deploy

**From:** the cloud-readiness / first-login lane
**Date:** 2026-09-26
**Status:** code complete and pushed. **Not deployed anywhere.** Not to
production, not to staging.

> **Revised 2026-09-26, after the first version of this note.** The first version
> claimed `tests/integrations.test.js` hangs and that **no lane could hand you a
> green 53-file run**. Both were wrong — the file is slow, not stuck, and I had
> killed it with my own 300s bound. It passes 119/119 in 537.7s. The withdrawal
> and the measurements are under "Withdrawn" below. Nothing about the gate code,
> `bad4896`, or the test results for it changed.
>
> **The 53-file run has since been measured end to end and it exits 1**, on four
> `reportingApi.test.js` assertions that also fail on plain `main` with none of my
> code present, and that pass on the same commit if the clock is moved back three
> hours. It is a clock-dependent flake in the suite, proven three ways under
> "`reportingApi.test.js` fails after 12:30 UTC" below. I am reporting the red
> exit rather than quoting only the 52-file green.

## The SHA to integrate

| | |
|---|---|
| Branch | `x/firstlogin-gate` |
| **Tested tip** | **`bad4896`** (`bad4896ec1be16bb5670d7c75a24592b1b15e330`) |
| Previous tip you were given | `af72be9` — **superseded, do not integrate it** |
| Remote | verified by `ls-remote`, and the three changed blobs match byte-for-byte |
| Merge base with `main` | `828208a` |

`af72be9` boots a deployment that sets `SESSION_TTL_HOURS` below 0.5 into a
crash loop. That is the whole reason there is a second commit. Take `bad4896`.

### It merges clean onto today's `main`

| | |
|---|---|
| `main` at time of check | `728a57c` (local and remote agree) |
| `merge-tree --write-tree` | exit 0, tree `9ebcf4a`, no conflicted paths |
| Real merge, throwaway worktree | **`9a43535`** — 7 files, 834 insertions, 35 deletions |

**A clean merge is not a safe release and I am not claiming it is one.**

### Production is not on the SHA the brief names — one correction

I was told production runs `942bed6`. It does not, any more:

| | |
|---|---|
| `pos-prod-backend-1` `GIT_SHA` | **`483a47f`** (`483a47f0b62e…`) |
| Container started | **2026-09-26 10:32:17Z** — today, recently |
| Relation to `942bed6` | `942bed6` **is** an ancestor; production is 2 commits past it |
| Those 2 commits | `0f0a248` docs(deploy) and `483a47f` ops(deploy) — deploy bookkeeping, **no application code** |

So the brief's underlying point holds and is if anything stronger. But there is a
sharper fact behind it: **`483a47f` does not exist in the Expansion clone at
all.** `git cat-file -t` cannot find it there, while `942bed6` resolves fine. The
deploy line and the Expansion line are in **separate object graphs** — not two
branches of one history. No single clone can compute an ancestry relation between
what production runs and what `main` holds, which is a stronger statement than
"they diverge" and worth saying plainly before anyone reasons about a merge.

I re-checked `942bed6` against this branch the careful way, because
`merge-base --is-ancestor` exits non-zero both when the answer is "no" *and* when
the object is missing, and a shell `||` cannot tell those apart. The object
resolves in the Expansion clone, so the answer is real: **`942bed6` is not an
ancestor of `bad4896`.** `main` is the unreleased Expansion line; merging here
does not move production and must not be described as if it had.

## What the tests prove

| Run | Result | Where |
|---|---|---|
| `firstLoginGate.test.js`, lane @ `bad4896` | **30 passed / 30**, 0 skipped, 0 todo, exit 0 | `flgate-lane-run1.log` |
| Gate + 7 auth-adjacent suites | **194 passed / 194**, 8 files, 0 skipped, exit 0 | `flgate-lane-regression.log` |
| Boot matrix, 11 configurations | all as specified | inline, reproduced below |
| **Control: new tests vs. OLD code** | **9 failed / 7 passed / 14 skipped**, exit 1 | `flgate-control-oldcode.log` |
| **Integrated, `9a43535` = lane merged onto `main` `728a57c`** | **52 files / 1566 tests passed, 0 failed, 0 skipped**, exit 0, 521s | `flgate-integrated-9a43535.log` |
| **The 53rd file on its own, integrated @ `9a43535`** | **119 passed / 119**, 0 skipped, 0 todo, exit 0, 537.7s | `integrations-unbounded.log` |
| **All 53 files in one run, integrated @ `9a43535`** | **1681 passed / 1685**, 52 files passed, **4 failed in `reportingApi.test.js`**, exit 1, 913.1s | `flgate-all53-9a43535.log` |
| **Control: those 4 on plain `main` `728a57c`, no gate code** | **same 4 fail**, 32 passed, exit 1 | `control-reportingApi-main-728a57c.log` |
| **Same file, same commit, clock moved back 3h** | **36 passed / 36**, exit 0 | `control-reportingApi-main-shift3h.log` |

Every log in that column lives in `/home/atc-noc/vcx-cloudready-local/` on this
box. They are not in the repo — they are raw run output, and some carry request
logs, so they are deliberately not committed.

The 52-file run is the whole backend suite **minus `tests/integrations.test.js`**.
I excluded that file because I thought it hung. **It does not hang — I was wrong,
and the withdrawal is the "Withdrawn" section below.** Run to completion it is
green, which is the row above. Everything else — all 52 remaining files — passes
with the gate merged in, and `firstLoginGate.test.js` contributes its 30.

**Read the 53-file row honestly: it exited 1.** The four failures are in
`tests/reportingApi.test.js`, they are **not mine, and they are not the gate's** —
they are a pre-existing clock-dependent flake that this lane touches no part of.
The proof is the section below; do not integrate on the strength of the 52-file
row alone without reading it.

One caution on reading that "0 skipped": the summary line genuinely reports none,
but the run does contain a *test whose name* is `globalLimiter skipped (NODE_ENV=test
at load) …`. Grepping the log for "skipped" therefore returns a hit that is a
passing test, not a skip. Worth knowing before someone greps this log and reports
a skip that does not exist.

The regression set was chosen by grepping for the things the gate can reach, not
by taste: `accountRecovery`, `authTenantIsolation`, `invitations`, `foundation`,
`foundationPeople`, `platformAdmin`, `approvalSecrecy`.

**The control is the part worth reading.** The 16 new assertions were run
unchanged against the pre-fix code: 9 fail there. Those 9 are load-bearing. The
7 that pass on both describe behaviour that was already correct, and I have left
them in rather than pretending all 16 are new coverage.

### The three behaviours you asked to see proven

1. **A new user cannot use protected APIs before changing the password.** The
   suite enumerates every route the app mounts and asserts the gate refuses all
   of them except exactly three a temporary session must reach — read own
   identity, change password, log out. It is an enumeration, so a route added
   later is covered without anyone remembering to add a test.
2. **Expiry and refusal paths.** A temporary session's TTL is asserted against
   the configured value, not a literal. Refusal is `403
   POS_PASSWORD_CHANGE_REQUIRED` and is distinguishable from the storage-timeout
   `503 POS_STORAGE_BUSY` — they are different failures and the client must not
   treat them alike.
3. **Existing users are unaffected — verified against production data, not
   inferred.** `mustChangePassword` is already `boolean NOT NULL default false`
   in the live production database, and **0 of 16** production users have it
   set. The gate is inert for every account that exists today. There is no
   migration, no schema file and no `.sql` in the integration diff — checked by
   filename, and the diff is empty of them.

## What `bad4896` changes, and why it is not cosmetic

**The reported defect.** The temporary-session TTL defaults to 30 minutes. The
guard that enforced "temporary is never longer than normal" compared that
*default* against `SESSION_TTL_HOURS` and threw. So:

```
SESSION_TTL_HOURS=0.25   ->  BOOT FAIL: POS_TEMP_SESSION_TTL_MINUTES must be
                              positive and no longer than SESSION_TTL_HOURS
```

The operator never wrote `POS_TEMP_SESSION_TTL_MINUTES`. The backend has no hot
reload, so this is not a warning — it is the API failing to come up, blaming a
variable that is absent from the config, and reading like a bad deploy.

The default is now **capped** instead of checked. An **explicit** value that is
too long still throws, and now prints both numbers. Shorter is safe here: an
expired temporary session costs the user one extra sign-in, because the
temporary password still works.

**The one I found while fixing it, which I think matters more.**
`SESSION_TTL_HOURS` was never validated at all:

```
SESSION_TTL_HOURS=abc    ->  BOOT OK   temp=30min  normal=NaN min
```

`Number('abc')` is `NaN`, and every comparison against `NaN` is false — so the
typo slipped past the guard beneath it and the service started clean. What
followed was not a config error. It was **a 500 on every login**: `jwt.sign`
throws on `expiresIn: 'NaNh'`, and the session row's `expiresAt` became
`Invalid Date`. Both confirmed directly rather than reasoned about. It is now
refused at boot, in its own check, with its own message, ahead of everything
that divides by it.

### The boot matrix, after the fix

```
unset                           OK    temp=30min  normal=720min
SESSION_TTL_HOURS=0.5           OK    temp=30min  normal=30min    (equal, uncapped)
SESSION_TTL_HOURS=0.25          OK    temp=15min  normal=15min    (was BOOT FAIL)
SESSION_TTL_HOURS=0.1           OK    temp=6min   normal=6min
SESSION_TTL_HOURS=abc           FAIL  names SESSION_TTL_HOURS     (was BOOT OK, NaN)
SESSION_TTL_HOURS=0             FAIL  names SESSION_TTL_HOURS
SESSION_TTL_HOURS=-1            FAIL  names SESSION_TTL_HOURS
hours=0.25 + explicit temp=45   FAIL  "(15 minutes); got \"45\""
hours=0.25 + explicit temp=10   OK    temp=10min  normal=15min
explicit temp=0                 FAIL
explicit temp=abc               FAIL
```

These run as real child processes in the suite, not as in-process asserts,
because `env.js` validates at **import** time and the test file has already
imported it — a second import is served from the module cache and would assert
nothing.

## Correction to §D1 of `WINDOW-1-GATE-TABLE.md`

That section says the boot guard means "zero, non-numeric, or longer than a full
session throws at startup… A bad value fails the deploy loudly, which is
intended." **That is now only true of an explicitly set value.** The default is
capped silently and on purpose. §D1 has been corrected in place; the file count
there moves from five source files to six, because `.env.example` now documents
both variables.

## Withdrawn: the `integrations.test.js` "hang" was mine, not the file's

An earlier version of this note told you this file hangs, that **no lane could
hand you a green 53-file run**, and that a CI job would hang rather than fail.
**All three were wrong.** The file is slow, not stuck, and every symptom I
reported was an artifact of my own 300-second bound.

Run to completion at the integrated SHA `9a43535`, 2026-09-26:

| | |
|---|---|
| `tests/integrations.test.js` alone | **119 passed / 119**, 0 skipped, 0 todo, **exit 0** |
| Duration | **537.7s** |
| Of which, the 100,000-row import | **496.1s — 202 rows/s** |
| Cleanup inside that same test | links 0.2s, customers 18.6s |
| Log | `integrations-unbounded.log` |

### Why it takes eight minutes, and why that is by design

Line 2661 imports 100,000 rows, and line 2746 gives the test its own budget:

```js
it('holds 100,000 rows in one isolated run and accounts for every one of them', async () => {
  const N = 100_000;
  …
}, 900_000);   // 15 minutes, overriding the suite's 20s
```

`src/lib/integrations/loyaltyImport.js` applies it in 500-row transactions and,
inside each one, loops row by row with an `await tx.customer.findUnique(...)` per
row — about 100,000 sequential round-trips. That is deliberate: it is what lets a
failure be attributed to a row number and a crashed run resume from its cursor.
202 rows/s is the designed cost, not a defect.

The repo already said so, in `backend/tests/globalSetup.js`:

> "Contention is low — only this lane's own runs compete — but **the 100,000-row
> import test alone takes ~8 min**, so waiting is real…"

### Each thing I reported, and what it actually was

| What I wrote | What was true |
|---|---|
| "`timeout` exit 124 at 300s" | The import alone needs 496s. I killed it 60% through. |
| "**zero test lines**" | `--reporter=basic` prints the file list only at the END. The silence was my reporter flag, not a lack of progress — under `--reporter=verbose` the same run visibly completes **111 of the file's 119 tests** before reaching the slow one, inside the first ~15s. Only 7 tests sit after it. Arithmetic: 533.1s of test time minus the big test's 496.1s import and 18.8s cleanup leaves 18.2s for the other 118 tests combined. |
| "`testTimeout: 20000` does not catch it, so it is hanging outside a test body" | The test overrides it with `900_000`. The 20s limit was never in play. |
| "a JS promise that never settles" | Sampled live: an **`active`** connection holding a 1.1s-old transaction, and `Customer` rows climbing 17 000 → 82 000 → 99 500 while I watched. |
| "one connection left `idle in transaction`" | A batch transaction caught between per-row round-trips. |
| "both ending on the same `POST …/REELO/import`" | True, and it is the *expected* last line. Those three requests are the cashier-403, manager-403 and owner-200 of the test immediately before the big one; the 100k request was still in flight and therefore unlogged, because the logger writes on response finish. |

### What this means for your release workflow

- **A 53-file run completes.** The "no lane can give you one" claim was false and
  is withdrawn. Measured at `9a43535`: **1681 passed / 1685, 52 of 53 files green,
  913.1s, exit 1.** It is *not* green, and the one red file is the next bullet.
- **The real hazard is the opposite of what I described.** CI will not hang — it
  will *fail* if the per-job timeout is under about 20 minutes. Budget the full
  backend suite at **~18–20 min** on an idle box, and more under load.
- **The 900s budget is not generous.** At load ~7 the import used 496s of it. The
  file's own comment records 146 rows/s at load 13.65, which projects to ~685s —
  inside the budget, but the headroom is finite. If it ever does fail, read the
  `[cleanup] customers` line first: tens of seconds means a busy box, hundreds
  means `LoyaltyProfileLink_customerId_companyId_idx` has gone missing.
- Nothing here was ever mine to fix, and there is nothing to fix.

## `reportingApi.test.js` fails after 12:30 UTC — on plain `main`, without my code

The 53-file run exited 1. Four tests failed, all in `tests/reportingApi.test.js`:

- `the figures reconcile > sales, collections and refunds are separately explainable` — `expected +0 to be 1`
- `the figures reconcile > a part-paid bill appears as a due, not as a missing sale` — `[]: expected undefined to be truthy`
- `the figures reconcile > collections split by method rather than collapsing into one figure` — `expected [] to include 'CASH'`
- `the export is the payload > the CSV carries the same net sales as the JSON payload` — `Cannot read properties of null (reading 'paise')`

Every one is a "no rows came back" assertion. **This is a pre-existing
time-of-day flake in the suite, not a regression and not the gate's.** Three
independent things establish that, and I ran all three rather than assert it:

| Test | Result |
|---|---|
| Does this lane touch reporting at all? | **No.** The lane diff vs `main` is 7 files / 834 insertions: `.env.example`, `auth.js` (route), `env.js`, `errors.js`, `session.js`, `middleware/auth.js`, `firstLoginGate.test.js`. Zero reporting files, zero schema change. |
| Do the same 4 fail with **no gate code present**? | **Yes.** `tests/reportingApi.test.js` alone at plain `main` `728a57c`: 4 failed / 32 passed, exit 1 — *the same four names, the same four assertions*. |
| Is it the clock? | **Yes.** Same file, same commit, same database, process clock moved back 3h: **36 / 36, exit 0.** |

### The mechanism

`reportingApi.test.js:135` dates its fixtures at `now − 18h`:

```js
const yesterdayAfternoon = () => new Date(Date.now() - DAY + 6 * 3600e3);
```

The tests then query `preset=YESTERDAY`. The server resolves that preset in
**`Asia/Kolkata`** (`src/lib/reporting/period.js:18`, `timezone: 'Asia/Kolkata'`),
but this box runs **UTC**. So once UTC passes **12:30** (= 18:00 IST), `now − 18h`
lands on *today* in IST rather than yesterday, `YESTERDAY` selects a day with no
fixtures, and every "no rows" assertion above fires.

I bracketed the cutoff by bisecting the process clock rather than trusting the
arithmetic: at an effective **12:34 UTC** the 4 fail, at **12:28 UTC** all 36
pass. That is the predicted 12:30 UTC boundary, measured.

It is also why my earlier 52-file run was green — it hit `reportingApi` at
~11:43 UTC, before the cutoff. The 53-file run reached it at ~13:40 UTC, after.

### What you should do with it

- **Do not treat this as a blocker on `bad4896`.** It reproduces without a line
  of my code in the tree.
- **It will bite your CI** on any job that starts after 12:30 UTC, which for an
  IST-hours team is most of the working afternoon. Worth a separate fix by
  whoever owns reporting: pin the suite's timezone, or date the fixture from the
  company timezone instead of `Date.now()`.
- I have **not** fixed it. It is outside this lane, and editing a shared test
  file to make my own run look green is exactly the wrong move.

## All four staging stacks are occupied — read this before telling me to deploy to one

There is no free isolated staging stack to put this on. Re-checked **13:25:51Z**,
and it has got busier since the first version of this note, not quieter:

| Stack | Image | Started | Reachable on |
|---|---|---|---|
| `pos-staging-*` | `114ffc9` | 2026-09-26 **11:16:57Z** | `127.0.0.1:8111` |
| `pos-stgw5-*` | `prov1-2465725` | 2026-09-26 **11:39:12Z** | `127.0.0.1:8210`, edge `:8212` |
| `pos-stgw5-rb` | `pos-prod-backend:latest`, **`GIT_SHA=483a47f`** | 2026-09-26 **12:05:19Z** | `127.0.0.1:8211` |
| `pos-w1rb-*` | `114ffc9` | 2026-09-26 **13:19:56Z** | `127.0.0.1:8310` |

Three points that matter more than the table:

- `pos-staging-*` has been up two hours on `114ffc9`, the Core RC-1 image this
  repo's own release note names. Another window is mid-verification on it.
  Deploying `bad4896` over it would destroy that run.
- **`pos-w1rb-*` is a complete fourth stack — postgres, backend, frontend, edge —
  and it came up four minutes before I wrote this line.** It runs the same
  `114ffc9` staging images. Somebody is actively rehearsing on it right now.
- `pos-stgw5-rb` runs `GIT_SHA=483a47f`, which is **what production is actually
  on** (see the production correction above). That is a rollback rehearsal
  against the real production image, and it is not mine.

`DEPLOY-OWNER.md` does not cover staging, so there is no lock to claim and no
owner line to read: the only signal is the container timestamp. Ports `8111`,
`8210`/`8211`/`8212` and `8310` are all taken.

Consequently a staging deploy of this branch needs **either** Window 1's release
workflow to schedule it, **or** a fifth stack on its own ports and its own
database. I have not built one and have not squatted any existing stack.

## What I did not do

- **Nothing is deployed.** No staging deploy, no pinned artifact, no production
  change. `DEPLOY-OWNER.md` line 8 still reads "Owner: nobody. Released
  2026-09-26 07:35Z"; I did not claim it, because claiming it is for touching
  `pos-prod` and I am not touching `pos-prod`.
- I did not merge anything into `main`. `9a43535` is a throwaway rehearsal
  branch in a scratch worktree, kept only so the number above is real.
- I did not touch production. The only production contact was two read-only
  queries against `atc_pos` to confirm the column shape and that 0 of 16 users
  carry the flag.
