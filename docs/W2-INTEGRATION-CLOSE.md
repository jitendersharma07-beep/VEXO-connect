# W2 integration close — the one completion report

**Branch:** `x/w2-integration-close` · **Date:** 2026-09-25 · **Host:** `atc-noc` (the POS host, 20.20.20.55). No access to `vexo-lab` / 20.20.20.57 at any point.

This is the single canonical report for the work described in the owner's seven-part
directive. It supersedes nothing and duplicates nothing: the defect detail lives in
`VC104-BACKEND-DEFECTS.md`, the release ledger in `CLIENT-HANDOVER-SCOPE.md`, and the
two lane deliveries in `VC104-UI-DELIVERY.md` / `VC105-UI-DELIVERY.md`. What is here is
the part none of those can carry — **what was actually verified, against which tree, and
what is still owed to the owner.**

Read §1 and §8 if you read nothing else. §1 is what shipped; §8 is what did not.

---

## 1. What was delivered, and where it is

| | |
|---|---|
| Branch | `x/w2-integration-close` |
| Delivered content | `6eb31e9` (QA harness honesty + the artifacts it produced), `094607a` (task #11), `10c09b2` (this report). `10c09b2` is the last commit that changes any shipped code, test, artifact or finding |
| Verified remote state | `git ls-remote github` → both `refs/heads/main` and `refs/heads/x/w2-integration-close` contain all three, confirmed by re-reading the remote after each push rather than trusting the push's own output — the same reason D-4 exists. Either ref may sit a commit or two ahead of `10c09b2`, and they may differ from each other by that much: a report cannot contain its own commit hash, so this §1 bookkeeping necessarily lands after the content it describes. Every such commit touches **this file only** — `git show --stat 10c09b2..` is the check, and no code, test or artifact moves in them |
| Base | remote `main` @ `584de37`, which **was** an ancestor of this branch (`git merge-base --is-ancestor` returned 0) |
| Remote `main` | **`820a5a1` — advanced by the owner, `584de37..820a5a1`, a fast-forward.** `git ls-remote` shows `refs/heads/main` and `refs/heads/x/w2-integration-close` at the same commit, and `github/main^{tree}` is `bc49e09`, identical to the local tip's tree. So what is published on `main` is byte-for-byte the tree the §3 numbers describe — the numbers transfer without re-running anything |
| Remote | `github` — the PUBLIC Expansion repo |
| Working tree | `/home/atc-noc/vexo-connect-x-lanes/w2-close` |
| Migrations on disk | **22**, agreed by both demo databases (`schemaDigest a4215343d532`) |

**`main` was advanced by the owner, and the handover is worth recording because of what it
proves.** The fast-forward was checked before it was attempted: `584de37` an ancestor of the
tip, and the 12 commits `main` would gain all this lane's own or merges of `main` itself —
nothing unrelated, which is the §7 condition. Both idiomatic push forms were then refused
from this session by the local Claude Code auto-mode classifier — *"Auto mode could not
evaluate this action and is blocking it for safety"* — so rather than hunt spellings (which
is looping through forms to defeat a guard) the exact command was handed over:

```
cd /home/atc-noc/vexo-connect-x-lanes/w2-close
git push github x/w2-integration-close:main
```

The owner ran **that command, verbatim**, and it printed `584de37..820a5a1`. That settles
what the refusal was: not GitHub, not credentials, not the refspec — the command was
correct, and the block was this session's own tooling failing to parse it. The lesson for
next time is the escape hatch, not a third spelling: verify the fast-forward, then hand over
one line that really works.

Verified afterwards from the remote rather than from that output, which is the same
discipline D-4 is about: `refs/heads/main` and `refs/heads/x/w2-integration-close` both at
`820a5a1`, and both trees `bc49e09`.

The branch reached its base the hard way and it is worth one line, because it changes what
the evidence means. Two minutes after `git ls-remote` showed `main` at `7ab9cee`, a push
was rejected as non-fast-forward: a peer had merged `x/accounts` as `584de37` in between.
The response was to fetch, compute the conflict surface (zero overlap), merge, and then
**re-run everything** — because the previously green 700/700 no longer described the tree
that was going to be published. The numbers in §3 are from after that merge, not before.

---

## 2. Defects: D-1 … D-7

Detail and line numbers in `VC104-BACKEND-DEFECTS.md`. Status only, here:

| # | What it was | Outcome |
|---|---|---|
| D-1 | `priceChanged` on reassign ignored the delivery charge | **Fixed.** The flag could never be true, on exactly the moves that changed what the caller pays |
| D-2 | Prep capacity never counted ASAP orders | **Fixed**, guard no longer fails open. **One limitation survives and is recorded, not closed:** an order reassigned after its own slot has elapsed still occupies nothing. Being worked on `x/slot-anchor` |
| D-3 | Phone orders could not sell a product with a REQUIRED modifier group | **Fixed.** Created by the consolidation merge, not by either lane alone |
| D-4 | QA evidence did not identify the tree that produced it | **Closed, and hardened twice more this session** — see §4 |
| D-5 | The catalog API could leave a required modifier group permanently unsatisfiable | **Fixed.** Reconciled to **four ways in, guarded at three call sites** (one route carries two), consistently across the summary table, the D-5 section, §6 and §7 of that document |
| D-6 | Archiving a promotion permanently burns its code | **OPEN — and correctly so.** See below |
| D-7 | D-5's guard was not atomic: two simultaneous edits both passed it | **Fixed** with `FOR UPDATE` on the `ModifierGroup` row, counts re-read inside the transaction |

**D-6 is the one thing deliberately not fixed.** It was reproduced over HTTP in an isolated
database and is pinned by `describe('archiving a campaign (D-6)')` in
`backend/tests/promotions.test.js`, so the behaviour can no longer change unnoticed. It is
not fixed because the fix *is* the policy, and no VC-102 spec settles the policy —
`grep -c -i promotion docs/PHASE2-CONTRACT.md docs/VC104-API-CONTRACT.md` returns 0 and 0.
The whole decision reduces to one question:

> **When a promotion is archived, does its code go back into the pool?**

- **Recommendation: YES.** If taken, it must ship *whole* — a partial unique index
  `WHERE status <> 'ARCHIVED'` **together with** the matching route filter. Either half
  alone turns a clean 409 into a 500.
- **If NO**, the work is documentation and a UI that warns before the archive, not a
  constraint change.
- **Worth shipping either way:** the honest refusal message at `promotions.js:167–172`.
  Today an operator retyping `DIWALI20` is told the code already exists — true and
  useless, since the promotion holding it is invisible in every list they can see. Left
  alone here because `promotions.js` and its pinned tests belong to another session.

Nothing was removed to make a test pass: no uniqueness dropped, no historical promotion
deleted, no redemption counter reset, no code reuse allowed.

---

## 3. What was run against the final candidate

Everything below was run **after** the `584de37` merge, on this tree, against this tree's
own backend and this lane's own isolated databases.

### Backend suite — `/tmp/final-suite.log`

```
Test Files  30 passed (30)
     Tests  858 passed (858)
  Start at  01:56:39     Duration 263.66s     exit 0
```

858, not 857: the extra test is the one added for task #11 (§5). Zero failures, zero
skips. Isolated database `vcx_w2close_test` on the dev container — never a peer's, never
production.

### Browser acceptance — final run `/tmp/vcx-qa-20260925-020127`, artifacts in `frontend/qa/screens/`

| Harness | Result | Stamp |
|---|---|---|
| VC-104 phone orders | **75/75, 0 skipped**, `aborted: false`, `exitCode: 0`, `at 02:03:06Z` | `branch x/w2-integration-close`, `baseSha 71315d44`, `backendCwd` inside this tree, `database atc_pos_vc104ui_demo`, `migrationsOnDisk 22`, `schemaDigest a4215343d532` |
| VC-105 menu profitability | **48/48**, `aborted: false`, `exitCode: 0`, `at 02:03:58Z` | same branch and baseSha, `database vcx_vc105_main_demo`, same digest |

All 31 screenshots were written by the final run — none carried over.

This was the **third** pipeline run of the night, and the reason for the third is D-4's own
rule turned on my own commit. Run 2 (`…-015349`) was already green at 75/75 and 48/48 —
but I then changed `vc105-browser-qa.mjs`'s results writer, so the `results-vc105.json`
sitting on disk had been produced by code that was about to be replaced. Committing that
pair would have shipped an artifact that was evidence about a tree one edit older than the
tree it was committed in: a smaller version of exactly the defect this report closes. Both
committed artifacts therefore come from run 3, after the last source edit.

### Two runs that failed, recorded rather than buried

Both are in §4, because what they exposed matters more than the fact that a re-run was
green. Logs kept: `/tmp/vcx-qa-20260925-012545` (70 of 75) and
`/tmp/vcx-qa-20260925-014447` (50 of 75).

---

## 4. The evidence itself was the defect — twice more

D-4's lesson was that *a QA artifact is evidence about the tree that produced it, not the
tree it ends up committed in.* This session found two more instances of the same family,
both in the harnesses, and both by running them rather than by reading them.

**A partial run read as a clean pass.** The 01:25 run died on a navigation timeout after
70 of 75 checks and wrote `70/70 browser checks passed` — a true statement about a
shrunken denominator and a false one about the suite. The crash landed *after* the results
writer, so the artifact was green. `run-all.sh` caught it on the exit code; anyone opening
`results-vc104.json` on its own would not have. Both harnesses now write from an exit
handler and stamp `aborted` / `exitCode`, and an aborted run prints *"the run did not
finish, so this is NOT a pass"*. Proven, not assumed:

- *negative control* — pointed at a dead port, each harness writes `aborted: true`,
  `exitCode: 1`, `total: 0` and prints the ABORTED line;
- *real-world negative* — the 01:44 run printed `ABORTED after 50 checks (50 passed) — …
  NOT a pass` where the old code would have printed `50/50 passed`;
- *positive control* — the final run writes `aborted: false`, `exitCode: 0`, 75/75.

**The budgets were measuring the host, not the product.** Puppeteer's 30 s navigation
default killed the 01:25 run at load average 33 on 12 cores; the same run unchanged at
load 29 was 75/75, so flake-vs-real was *measured* before anything was touched. Raising
it exposed a second clock: the 01:44 run cleared every navigation and then died on a
hardcoded `{ timeout: 10000 }` waiting for "Rejected by". The backend log settles what
that was — `POST …/reject` → `statusCode: 200, responseTime: 24806`. **The feature
worked; the host took 24.8 s to say so, and the harness allowed 10.** Every budget is now
one knob (`QA_SLOW_FACTOR`, default 4, `=1` restores the original literals exactly).

This is legitimate for one specific reason, and it is the same argument as
`RACE_TIMEOUT_MS` in `catalogModifiers.test.js`: **every check downstream of a wait
asserts on page content.** If the cashier guard broke, `landedOn` still contains
`phone-orders` and the check fails in a second; if reject stopped working, the wait still
expires, just later. A timeout is the one failure these checks cannot produce from a real
regression, so a larger budget costs wall-clock on a genuine break — never detection.

**I had been writing into a peer's worktree.** `backend/node_modules` was a symlink to
`../../main-merge/`, and `[ -d path ]` follows symlinks, so the existence guard passed and
`prisma generate` wrote *through* the link, replacing that lane's generated client
(mtimes `09-24 19:43`). Harmless only by luck — both trees were on the same 54-model
schema, so the rewrite was content-identical. On a divergent schema it would have left the
peer serving code against the wrong client, which surfaces as `prisma.<model> is
undefined` deep inside a request and reads as application breakage. One day later the same
thing turned up on the frontend: the 01:44 stack frames all named
`main-merge/frontend/node_modules`, whose `.vite` cache carried the same 19:43 mtime — two
checkouts sharing one optimised-dependency cache.

`run-all.sh` now dereferences **either** `node_modules` symlink into a private copy before
using it. `rm` without `-r` is the load-bearing safety property: it removes a link but
physically cannot delete a real directory (`rm: cannot remove 'x': Is a directory`, exit
1), so a mis-detection fails closed instead of destroying the donor's install — verified
in a scratch directory. The branch is no longer hypothetical: the final runs hit it
("frontend node_modules is a symlink -> …; copying it private"), and afterwards both mine
and the donor's are real directories with 147 entries each and **the donor's `.vite` mtime
unchanged.**

One honest limitation of the stamp, since it is used as delivery proof: `contentSha` is a
git tree over the working tree *including the evidence being written*, so the VC-104 and
VC-105 stamps of one pipeline run legitimately differ, and neither will ever equal the
committed tree's hash. It identifies **the run**, not the commit. `baseSha` says where the
work started; `contentSha` says what ran.

---

## 5. Tasks #10 and #11 — actual names and outcomes

| # | The real task | Outcome |
|---|---|---|
| **#10** | Fix VC-104 **D-1** (`priceChanged` ignores the delivery charge) and **D-2** (prep capacity ignores ASAP orders) | **Done**, both fixed and pinned. D-2's residual limitation is recorded in §2 and is on another branch |
| **#11** | `VC105-TEST-COVERAGE-NOTE.md` — flagged *optional, non-blocking*: the suite pins `costStatus === 'MISSING'` in four places and never the reason string the client prints | **Done, and deliberately wider than asked** |

The note prescribed one line. That line alone is not enough, and proving it was the point:
`costStatusReason` is `[...costReasons][0] ?? 'NO_COST_SOURCE'`, so pinning only the
no-provider case would still pass if the field were **hardcoded** to the fallback. So a
second test asserts that the provider's own reason (`NO_RECIPE` — one of four:
`NO_RECIPE`, `EMPTY_RECIPE`, `INCOMPLETE_RECIPE_LINE`, `INVALID_YIELD`) reaches the row
instead of the fallback, because that string is what the operator reads on screen
(`MenuProfitability.jsx:276–278`) and the four are not interchangeable.

Negative control, run: with `costStatusReason` temporarily hardcoded to `'NO_COST_SOURCE'`,
**exactly 1 of 43 tests failed — the new one.** The other 42, including the note's own
prescribed line, all passed. The source was then restored byte-for-byte (`git diff` on
`profitability.js` is empty).

---

## 6. Opening hours, and the capacity cases that used to skip

All-day-open fixtures are fine for general workflow tests but prove nothing about opening
hours. `backend/tests/branchHours.test.js` (33 tests, in the 858) now covers open and
closed branches, the opening and closing boundaries in the configured business timezone,
future scheduled orders at valid and invalid times, and UTC/IST differences including the
date change. The capacity and reassignment checks that previously reported *skipped* now
run: VC-104 reports **0 skipped**, and the D-2 ASAP case asserts that one submission moves
the booked count by **exactly one**.

Controlled time and isolated fixtures throughout; production opening hours and validation
rules were not modified to fit a test.

---

## 7. Disk, measured (§6 of the directive)

| Reading | Value |
|---|---|
| Root filesystem | **92% of 98G, 7.9G free** |
| Inodes | **29%** — not the constraint |
| Trend observed tonight | 90% → 92% within hours (ledger row **B6** records 88% on 09-23) |
| **My lane's own contribution** | **279 MB** — exactly the two `node_modules` dereferenced from symlinks (141M frontend + 138M backend). That was the price of not writing into a peer's install |
| Reclaimable, measured | **2.1 GB** across **32 real `node_modules`** in **27 lane worktrees** — about 27% of the free space |

The 2.1 GB is reported, **not reclaimed**, and that is deliberate: five of those installs
are symlinks into others, and at least one lane is serving a live process (a backend on
`:5540`, cwd `…/cloud-readiness/backend`). Deleting another worker's dependencies would
break a running stack. It is a per-lane decision for the owner. Nothing was deleted, no
rollback image, backup, database or volume was touched, and no storage was resized.

B6's own remedy still stands and is still the real fix: ~439 GB of unallocated
volume-group space exists, so `lvextend` is a resize, not a cleanup (`OPS-HANDOVER.md`
§7 P1). It needs owner approval.

---

## 8. What is NOT done — the release ledger

**These suites passing does not mean the portal is complete.** The outstanding items from
`CLIENT-HANDOVER-SCOPE.md` §"Blockers", re-read against code rather than quoted from
memory:

| # | Item | State |
|---|---|---|
| B1 | Product Master Specification v1.1 | **Not held by anyone.** Every "Included" row in that ledger is included on *code* evidence, not a spec line |
| B2 | Client data pack (menu, stores, staff, GST, licence) | **Absent.** All onboarding is BLOCKED and demo output stays DEMO-labelled |
| B3 | RC-1 deployment decision | **Owner.** RC-1 adds migration 13 `20260923160000_refund_method`; the existing written grant covers only v1.0.1 post-deploy verification |
| B4 | Compliant off-host backup | **Not compliant.** The one retained encrypted copy is keyed to `…0F05CA51AEC13029`, whose unprotected private half is on this host; not append-only; restore rehearsed, not done; same /24 |
| B5 | Physical printer acceptance | **Still conditional.** Printing stays "browser print, untested on paper" until all 7 rows of `PRINTER-UAT-RUNBOOK.md` pass on paper. Two run-books exist — pick one, or results split across two tables |
| B6 | Production root disk | **Worse than the ledger says** — see §7 |
| — | Provider integrations | Razorpay/online payments **disabled by decision**; delivery orders not in Core (`OrderType` is `DINE_IN \| TAKEAWAY`) |

**One ledger fact has changed and the ledger should be updated: email-code account
recovery now exists in `main` and is wired.** `backend/src/app.js` mounts
`api.use('/auth', accountRecoveryRoutes)` and `api.use('/invitations', invitationRoutes)`,
backed by a real mail library (`src/lib/mail/{mailer,smtpClient,templates}.js`) and
`src/lib/{totp,userAuthority}.js`. It arrived with the peer's `x/accounts` merge
(`584de37`). This supersedes the earlier finding that no email recovery existed at all —
a reminder that **a "missing feature" may be an unmerged lane, not a product gap.** Row
F-3 in that ledger was already rewritten by its owner to match.

**Real-admin access** remains an owner item: `docs/CLOUD-READINESS-VERIFICATION.md` is
**not** in `main` (`x/cloud-readiness` @ `9779d28` is not an ancestor of `584de37`), so
main carries no stale claim — but one of that verdict's three blockers no longer holds,
and the verdict has not been re-taken.

### The only live demo URL on this box is not this tree

`http://127.0.0.1:8120` answers 200 — an `nginx:alpine` on the host network, loopback-only,
fronting a backend on `:5540`. That backend's cwd is `…/vexo-connect-x-lanes/cloud-readiness/backend`,
i.e. **`x/cloud-readiness` @ `9779d28`, which is not in `main`.** It is a peer's, it was
not verified here, and it is named only so nobody mistakes it for a demo of what this
branch delivers. The only URLs verified against *this* tree are the ephemeral loopback dev
servers the pipeline stands up and tears down (`:5382/:5383` and `:5386/:5387`).

---

## 9. Standing constraints, as actually observed

- Production `~/atc-pos` and frozen Core: **untouched**. No connection to 20.20.20.57.
- No peer's tests run, no peer's database touched, no peer's process killed. The one
  cross-lane *write* that did happen was found, measured, disclosed in §4 and fixed.
- No credential, token, `.env` content or customer datum printed. The published diff was
  scanned before pushing; the only long hex strings in the artifacts are git **tree**
  objects (`git cat-file -t` → `tree`), and the artifacts leak nothing beyond a bare
  database name by design (`tree-stamp.mjs` parses the path out of `DATABASE_URL` and lets
  the rest fall out of scope).
- The UI redesign remains **on hold**, as instructed. Only functional defects were fixed.
