# Window 1 — first-login gate: tested SHA, results, and one thing that blocks you

**From:** the cloud-readiness / first-login lane
**Date:** 2026-09-26
**Status:** code complete and pushed. **Not deployed anywhere.** Not to
production, not to staging.

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

The integrated run is the whole backend suite **minus `tests/integrations.test.js`**,
which hangs on plain `main` and is explained at the end of this note. That is an
exclusion I am naming, not hiding. Everything else — all 52 remaining files —
passes with the gate merged in, and `firstLoginGate.test.js` contributes its 30.

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

## The thing that blocks your release workflow, and it is not mine

**`backend/tests/integrations.test.js` hangs. It hangs on plain `main`.**

I could not produce a clean full-suite run, and the reason is not this branch:

| Run | Result |
|---|---|
| Full suite, lane @ `bad4896` | stalls in `integrations.test.js`, no summary |
| **`integrations.test.js` alone, plain `main` `728a57c`, no gate code present** | **`timeout` exit 124 at 300s, zero test lines** |
| Same suite with that one file excluded, integrated @ `9a43535` | **52/52 files, 1566/1566, exit 0 in 521s** |

Byte-for-byte the same place: 107 889 bytes of log against 107 907, both ending
on the same `POST /api/integrations/REELO/import`. Postgres is idle — no lock
waits, one connection left `idle in transaction` — so it is a JS promise that
never settles, not a database problem. `testTimeout: 20000` does not catch it,
which means it is hanging outside a test body.

Consequences you need to know about:
- **No lane can hand you a green 53-file run** until this is fixed. If a report
  claims one, it either excluded this file or never finished.
- My integrated number below is therefore `--exclude tests/integrations.test.js`,
  and I am labelling it rather than quietly omitting it.
- A CI job with no overall timeout will hang rather than fail, which is the
  worse of the two.

I have not fixed it. It is outside this lane, it is in another window's
integration work, and a hang in a payments/loyalty import is not something to
patch blind at the end of a session.

## Both staging stacks are occupied — read this before telling me to deploy to one

There is no free isolated staging stack to put this on:

| Stack | Image | Started | Reachable on |
|---|---|---|---|
| `pos-staging-*` | `114ffc9` | **2026-09-26 11:16:57Z** | `127.0.0.1:8111` |
| `pos-stgw5-*` | — | — | `127.0.0.1:8210` |

`pos-staging-*` was **started 11:16Z today**, minutes before I looked, on
`114ffc9` — the Core RC-1 image this repo's own release note names. Another window
is mid-verification on it right now. Deploying `bad4896` over it would destroy
that run, and `DEPLOY-OWNER.md` does not cover staging, so there is no lock to
claim and no owner line to read: the only signal is the container timestamp.

Consequently a staging deploy of this branch needs **either** Window 1's release
workflow to schedule it, **or** a fourth stack on its own ports and its own
database. I have not built one and have not squatted either existing stack.

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
