# W5 — Experience: floor, QR, Captain, reporting

Status as of **2026-09-25**. Everything below is either a measured result with
the log that produced it, or an explicitly named gap. Where a claim could not be
tested, it says so rather than being left to a green suite to imply.

---

## 1. What was tested, and what the tests actually ran against

Bundle text and a successful compile are not evidence, so nothing here rests on
either. Every browser harness ends its scenarios by reading the **database**.

| | |
|---|---|
| Source | lane `~/vexo-connect-x-lanes/experience`, branch `x/experience`, base `77242fe` |
| Frontend served | Vite dev server on `127.0.0.1:5661`, driven in real Chromium (`chromium-1117`) |
| Production build | 1714 modules, `assets/index-DOkGz9XT.js` 2,033.53 kB (gzip 364.72 kB), `assets/index-BfkoGCjR.css` 48.32 kB — clean |
| API | lane's own on `127.0.0.1:5561` |
| Database | `vcx_experience` on `127.0.0.1:5440` — the lane's private DB, never `atc_pos*`, never another lane's |

### Results

| Suite | Result | Log |
|---|---|---|
| Backend baseline (`vcxe test`) | **1652 / 1655** at `77242fe` | `evidence/baseline-77242fe.log` |
| W5's own backend suite (`captainWorkflow.test.js`) | **29 / 29** | `evidence/captain-acceptance-PASS.log` |
| QR / card / PDF over HTTP (`qr-evidence.sh`) | **22 / 22** | `evidence/qr-evidence-20260925.log` |
| Staff browser acceptance (`browser-acceptance.mjs`) | **36 / 36** | `evidence/browser-acceptance-20260925.log` |
| Guest phone journey (`guest-phone-acceptance.mjs`) | **36 / 36** | `evidence/guest-phone-acceptance-20260925.log` |
| Reporting / HQ / display (`reporting-acceptance.mjs`) | **36 / 36** | `evidence/reporting-acceptance-20260925.log` |

Evidence root: `~/vcx-experience-local/evidence/`. Screenshots in
`evidence/shots/` — 22 of them, named per scenario.

The three baseline failures are classified in `WINDOW-5-BACKEND-REQUEST.md`:
two are load artefacts that pass in isolation (proven, with logs), one is a real
pre-existing defect in `reportingExceptions.test.js` that belongs to W4. None is
attributable to W5.

**The harnesses live outside the worktree on purpose.** `vcxe setup` asserts
`frontend/package.json` and its lockfile are byte-identical to the dev clone's,
so a test dependency committed into the lane would invalidate the dependency
reuse the whole lane stands on. Playwright is resolved from the npx cache with
an explicit `executablePath`; nothing downloads a browser.

---

## 2. Deliverable 1 — floor, tables, QR

**Done and proven.**

- A card resolves to its own tenant, store and table; an unknown token 404s
  without disclosing what exists.
- **Scanning alone writes nothing.** Asserted twice over — once over HTTP, once
  in the browser with two consecutive scans — against visit, order and
  submission counts, and against the table still reading `FREE` to staff.
- The printable sheet is a real PDF (`application/pdf`, `%PDF` magic, 73,744 B,
  2 page objects). Single-card PNG renders.
- **Rotation does not corrupt history.** The old card is `REVOKED` and stops
  resolving; the order it took still points at the old card row and is still
  readable; at most one live card per table.
- **States carry words, not only colour.** `Served` appears as text. `Ready` is
  deliberately *not* a table state — a plate on the pass is not a plate on the
  table — and its absence is asserted. A settled table says *"clear table"*
  rather than reading as free.

One production defect was found this way and fixed: the Captain table header
kept the state it had when the tile was tapped, so it could read **"Free" over
food already with the kitchen**. Board polling is suspended while a table is
open, so the snapshot never refreshed. Fixed in `Captain.jsx` by making the
row re-read part of the shared post-write path rather than something each
handler had to remember. Regression-asserted in `browser-acceptance.mjs` §G.

### Nothing here computes a state

`tableStateOf()` in `backend/src/lib/qr/tableState.js` is the only thing allowed
to derive a table's state. `frontend/src/lib/tableState.js` mirrors it for
**display only** and says so in its first line. The Captain screen fetches the
server's answer after every write instead of recomputing one, specifically so a
second rival answer cannot exist.

---

## 3. Deliverable 2 — Captain

**Shipped and proven, with one gate that is not W5's to open.**

`frontend/src/pages/Captain.jsx` (792 lines) and `FloorStatus.jsx` (423 lines),
registered in `App.jsx` and the sidebar. No alternate billing or authentication
logic: the screen calls the same `/api/orders` routes the till does, and holds
no money control at all — asserted, along with the copy that tells the user
where a bill *is* raised.

Proven in the browser: an order opened, a draft line's quantity changed, a KOT
sent with exactly one KOT existing afterwards; a guest basket accepted from the
handheld cutting exactly one more; unauthorized actions refused **with the
business records asserted unchanged**, not merely a status code read.

### The CAPTAIN gate — recorded, not taken

A captain's own baseline grants `order.create`, but `POST /api/orders` is gated
by `operate` (`backend/src/api/routes/orders.js:86`) =
`requireRole('CUSTOMER_OWNER','BRANCH_MANAGER','CASHIER')`. The route answers
**403** to a real captain token — verified live, not inferred from the role
table. Same omission on `tableQr.js`.

This is exactly the "resolved permissions, not merely the role's baseline"
check, and it found a real discrepancy. **W5 did not change it.** Widening a
shared authorization path for a role W5 does not own is W3's call. Recorded as
`WINDOW-5-BACKEND-REQUEST.md` §1 and §2 with the live evidence.

The client comment at `frontend/src/lib/pos.js` states the divergence in place
so the next reader is not misled into thinking the two lists agree.

`order.item.void` is granted to two roles and reachable by neither — §3.
Recorded; **not silently changed**.

---

## 4. Deliverable 2 — Kiosk: BLOCKED, and why no page was shipped

**No kiosk page exists, deliberately.** A kiosk needs an unauthenticated,
table-free, one-party-at-a-time write path and the product has none:

1. `app.js:294-295` — `/guest/qr` is *"the only unauthenticated write surface in
   the product"*, and its credential is the token printed on a card. Every other
   router is behind `requirePosAuth` (`orders.js:84`).
2. `openOrJoinVisit` (`lib/qr/visits.js:118`) throws `POS_QR_JOIN_CODE_REQUIRED`
   at `visits.js:151` for the second party at a table. Correct for a table,
   wrong for a terminal that serves strangers back-to-back — they would be
   locked out or share a bill.
3. `QrSubmission.tableId` and `visitId` are both non-null, so the staff queue is
   structurally table-bound.

**The shortcut was available and was rejected.** Routing kiosk orders through a
dedicated "Kiosk 1" `DiningTable` row would satisfy both non-null columns and
would have put a working-looking page in this build. It would also make the
floor plan lie — that row escalates through `SEATED` → `IN_KITCHEN` like a real
table — which is the precise failure deliverable 1 forbids and which §2 above
spent this sprint fixing.

Shipping a kiosk screen that cannot order was equally not an option: *"Do not
label a disconnected UI as offline order support."*

Recorded as `WINDOW-5-BACKEND-REQUEST.md` §8, including the smallest shape that
would reuse rather than duplicate the order service. **Ownership is named as the
open question rather than assumed** — the surface is unauthenticated and touches
`visits.js` and `QrSubmission`, neither of which W5 owns.

---

## 5. Deliverable 3 — reporting, HQ, displays

**Done and proven**, in `reporting-acceptance.mjs` (36/36).

Every figure read off a rendered page is compared against SQL run straight at
the database. A page that calls a real API and renders something *else* passes a
network check and fails this one. `docs/VC104-UI-DELIVERY.md` and
`VC105-UI-DELIVERY.md` already claim 72/72 and 48/48; this harness exists to
re-test those claims rather than trust them.

- HQ dashboard figures tie to SQL, using **the report's own window boundaries**
  (`period.startUtc/endUtc`) — recomputing the window would have verified a
  second, differently-wrong number.
- Report Centre: unbuildable reports render genuinely `disabled`, dimmed, with
  a state badge and the server's own `note`. Asserted via `isDisabled()`, not
  by reading a class name.
- Customer display: the pairing code is single-use, the session is a bound JWT,
  and the display **cannot write to the till**. `GET /api/display/state` returns
  a *view* (`IDLE` / `ACTIVE` / `THANKYOU`) and never an order id; the pointer
  self-clears after `THANKYOU` and on fresh pairing. Totals tie to the DB.

**No canned data and no fake assistant.** Asserted directly: no screen in this
build offers an "ask" or assistant affordance at all. The AI-provider
integration is absent, and rather than shipping a surface that answers from
canned text, nothing pretends to be an assistant. VC-107 remains a separate
later phase, so the honest presentation of "pending" belongs to that phase's
UI, not to a placeholder added here.

---

## 6. Deliverable 1 of the directives — uncertain submission outcomes

The unconditional *"nothing has been queued, and the kitchen has not seen this"*
is **gone**. A timeout can happen after the server commits, and that message
asserted otherwise.

The replacement splits the case in two, and both halves are browser-proven with
KOT counts read from the database:

- **§G — the write is lost but a read gets through.** The screen does not stop
  at "unknown": it reconciles with a `GET`, which cannot cut a second ticket,
  then shows what the server actually holds. Exactly **one** KOT. Nothing is
  offered to resend, because there is nothing left to ask about.
- **§G2 — the reconcile read fails too.** *Now* the screen says the confirmation
  failed, marks what it shows as possibly out of date, and offers to ask the
  server again. Still exactly **one** KOT.

**No ambiguous mutation is ever retried automatically.** The send control is
disabled while the outcome is unknown — and because a disabled button is only a
promise until someone presses it, the harness force-clicks it and asserts the
KOT count is still 1. It also asserts the control *looks* dead (computed
opacity < 1), not merely behaves dead.

Idempotency on the guest path already exists (`idempotencyKey` + `requestHash`
over the normalised line list). The staff routes have none; the exact contract
needed is recorded as `WINDOW-5-BACKEND-REQUEST.md` §4 for W3, and the client
works correctly without it today by reconciling rather than retrying.

---

## 7. The gap that is NOT closed

**A real phone has never loaded a card.**

`POS_QR_BASE_URL` in this lane is `http://127.0.0.1:5661`. That loopback origin
is what gets printed into every card and every PDF, and no handset can reach it.

`guest-phone-acceptance.mjs` therefore runs at a 390×844 viewport with touch and
a real iPhone user-agent, and **asserts the limitation out loud** rather than
letting a green run imply a customer journey:

```
PASS  and that origin is loopback, so no handset can reach it (loopback)
note  printed origin is http://127.0.0.1:5661 —
      everything below is a 390px VIEWPORT run, not a handset run.
```

That assertion is written to fail if someone later points the lane at a real
origin, so the note has to be rewritten deliberately rather than quietly
becoming false.

What the viewport run *does* prove: scanning writes nothing; the menu is
readable before ordering with copy saying nothing is ordered yet; starting opens
exactly one visit; a sent basket is described honestly as **"Waiting for
staff" / "Nothing has been sent to the kitchen yet"** with zero KOTs to back any
other claim; a second phone is gated and cannot read the first party's order; a
wrong join code is refused and opens no visit; the right one joins the *same*
bill on *one* visit; and only after staff accept does the line become "With the
kitchen" — the flag tracking the KOT, not this phone having pressed Send.
Totals tie to the database. No horizontal scroll at 390px.

**Closing it needs an approved, reachable base URL.** That is a public-exposure
change, which is outside W5's ownership. It is the one genuine external input
this workstream is waiting on.

### Prepared: what the change is, and what it does not touch

Written out so that whoever is approved to make it does not have to rediscover
it. **W5 has not made it and must not** — it is public exposure.

The whole change is one environment variable:

```
POS_QR_BASE_URL=https://<approved-host>
```

**No token is reissued and no historical order is touched.** The printed URL is
composed at print time from the base plus the stored token — `cards.js:33-34`
reads `env.POS_QR_BASE_URL` and strips trailing slashes, and `tableQr.js:12`
states the same property. `QrToken` rows are not derived from the origin, so
repointing the origin changes where a scan *lands* and changes nothing about what
a token *is*. Revocation and regeneration stay independent of it. That is the
answer to the deliverable's "without corrupting historical orders" question for
this particular change: the corruption risk is zero because no row is rewritten.

What the change *does* invalidate is **paper**. Cards already printed carry the
old origin and stop resolving. Reprint is a business step, not a code one, and it
belongs in the rollout note rather than in a migration.

**The boot guard will refuse a wrong value, loudly, at startup rather than at
print time** (`env.js:300-321` — deliberately at boot, because the failure mode
being avoided is a room full of guests who cannot order):

| Rule | Line | Effect outside test/development |
|---|---|---|
| must parse as an absolute URL | 305 | boot fails |
| must be `https:` | 308-310 | boot fails on `http://` |
| host not `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, and not `*.local` | 311-317 | boot fails — *"not reachable from a customer's phone"* |
| no query string, no fragment | 318-320 | boot fails |

`NODE_ENV` of `test` or `development` relaxes the first two. The whitelist is on
the safe environments, so an **unset** `NODE_ENV` refuses rather than allows —
worth preserving, and worth knowing before anyone debugs a "why won't it boot".

### Acceptance steps once an approved host exists

In this order. Steps 1-3 need no public exposure and can be done first.

1. **Rewrite the honest-limit assertion in `guest-phone-acceptance.mjs`.** It is
   written to **fail** against a non-loopback origin, by design, so it fails
   first and is *supposed* to. Replace the loopback assertion with its inverse:
   the printed origin must be `https:` and must not be in the unreachable list.
   Do this deliberately, as a reviewed edit — the header comment stating the
   limitation must go at the same time, or the suite will pass while the file
   still claims a handset was never used.
2. **Re-run the four harnesses** against the new origin: `qr-evidence.sh`,
   `browser-acceptance.mjs`, `guest-phone-acceptance.mjs`,
   `reporting-acceptance.mjs`. All 130 checks must stay green. Expect card/PDF
   URL assertions to move; nothing else should.
3. **Confirm token stability across the repoint** — the check that proves the
   "no historical corruption" claim rather than asserting it. Record
   `id, token, tableId` for existing `QrToken` rows before the change, re-read
   after, and require them byte-identical while the printed URL differs. If any
   token moved, stop: the composition assumption above is wrong.
4. **Then, and only with the approved hostname in place, a physical handset.**
   Scan a printed card; confirm the menu loads over HTTPS with no certificate
   warning; confirm scanning alone still writes nothing (re-read `QrSubmission`
   and `DiningVisit` counts); complete one guest order end to end; confirm the
   second-party join code path on a second physical device.
5. **Only step 4 retires the gap.** Until a handset has loaded a card, §7 stays
   open regardless of how green steps 1-3 are. A viewport is not a phone.

---

## 8. Owned source in this delivery

| File | |
|---|---|
| `frontend/src/pages/Captain.jsx` | new, 792 lines |
| `frontend/src/pages/FloorStatus.jsx` | new, 423 lines |
| `frontend/src/lib/tableState.js` | new, 118 lines — display mirror only |
| `backend/tests/captainWorkflow.test.js` | new, 790 lines, 29/29 |
| `WINDOW-5-BACKEND-REQUEST.md` | new, 509 lines, §§1-8 |
| `frontend/src/App.jsx` | routes `floor-status`, `captain` |
| `frontend/src/components/Layout.jsx` | sidebar entries incl. the CAPTAIN group |
| `frontend/src/lib/pos.js` | `isCaptain`, and the gate divergence recorded in place |

Shared-route registration was W5's to make and no other window's page
registrations were touched.

Harnesses (outside the worktree, by design):
`~/vcx-experience-local/{qr-evidence.sh, browser-acceptance.mjs,
guest-phone-acceptance.mjs, reporting-acceptance.mjs, browser-fixture.mjs,
captain-reach.sh}`.

### Commits

| SHA | |
|---|---|
| `77242fe` | base this branch was cut from, and the source all results above were measured on |
| `6764af3` | the delivery — 9 files, +2977 |
| `9c8fc7e` | this section, plus §10 |
| `0d7e997` | stopped this document naming a SHA it moves itself |
| *(head)* | §6 marked resolved upstream; this section corrected once the branch was published and PR #5 opened |

`main` has moved on since the base — it is at `d625370` at the time of writing,
four commits past the `cf9c4a0` this branch was compared against earlier. None of
those four touches any of the 9 files here, which is why no rebase is needed; the
merge-ref check in §10 is what actually establishes that, and it is cheap to
re-run when `main` moves again.

Later commits on `x/experience` may sit on top; `6764af3` is the one that
carries the tested source. Doc-only commits after it do not change any tested
file — the guard in §10 is what proves that, not this sentence.

### Published, and under review

Branch `x/experience` **is on the remote**, pushed as a new branch with no force.
`main` was never a push target and no W5 commit advanced it.

**PR #5** → `main`. Verified without `gh`, by reading the pull-request refs the
remote advertises:

```
git -C ~/vexo-connect-x-lanes/experience ls-remote github 'refs/pull/5/*'
```

`refs/pull/5/head` must equal local `HEAD`. `refs/pull/5/merge` existing at all
is the useful signal — the remote only computes a merge commit when the merge is
conflict-free — and its parents must be `main` plus that head.

**A clean merge preview is not functional acceptance.** It says the diff applies,
nothing more. What this PR does *not* yet prove is listed in §9: a captain still
cannot place an order, so the handheld's send path is unexercised against a
server that permits it. Merge needs integration evidence green on the candidate,
not a green merge box.

---

## 9. Remaining dependencies

| # | Needs | Owner | Blocks |
|---|---|---|---|
| §1/§2 | CAPTAIN admitted to `operate` in `orders.js` and the `tableQr.js` gate | W3 | a captain doing the job the role is named for |
| §3 | `order.item.void` granted to two roles, reachable by neither | W3 | nothing in W5; recorded, not changed |
| §4 | Idempotency keys on `POST /orders`, `/:id/items`, `/:id/kot` | W3 | nothing today — client reconciles instead |
| ~~§6~~ | ~~`reportingExceptions.test.js` NEAR_EXPIRY~~ — **RESOLVED** on `main` by `02ee253`, via an explicit `implemented: false` gate | W4 (closed) | nothing |
| §7 | A paid table reads `FREE` on any floor run without guest scans | visits owner (`zen-bhabha`) | `PAID` ≠ `FREE` being visible in practice |
| §8 | A kiosk ordering surface — ownership itself is the open question | unresolved | the entire kiosk deliverable |
| §5 | W1 to publish `CONTROL.md` | W1 | coordination |
| — | An approved reachable `POS_QR_BASE_URL` | outside W5 | a real handset customer journey |

**Nothing in W5's own scope is waiting on W5.** Every item above is either
another window's file or an external input, and each was recorded with the
route-level evidence rather than edited across an ownership line.

---

## 10. Publishing, and verifying what was published

The push is never run from here. Pushing to the shared remote is an owner action,
and in this environment it is also refused by the agent safety classifier —
independently of the permissions table, so it cannot be allow-listed. The branch
exists on `github` now; subsequent pushes update it rather than create it:

```
git -C ~/vexo-connect-x-lanes/experience push github x/experience
```

Then verify the remote actually holds it. These two must print the same SHA —
naming a literal here would be wrong the moment another commit lands, so
compare them rather than trusting either alone:

```
git -C ~/vexo-connect-x-lanes/experience rev-parse HEAD
git -C ~/vexo-connect-x-lanes/experience ls-remote --heads github x/experience
```

Whatever that SHA is, `git log --oneline` must still show `6764af3` in its
history — that is the commit these results were measured on.

### Verifying the pull request without `gh`

`gh` is not installed here, and a personal access token belonging to someone else
is not an acceptable substitute for it. The remote advertises pull-request refs,
which is enough:

```
git -C ~/vexo-connect-x-lanes/experience ls-remote github 'refs/pull/*'
```

Refs appear the instant a PR is created, drafts included. Three checks:

1. `refs/pull/5/head` equals local `HEAD`.
2. `refs/pull/5/merge` exists — the remote computes it only for a conflict-free
   merge — **and its parents are `main` plus that head.** Read the parents. Do
   not stop at the ref existing; see below.
3. `git diff github/main refs/pull/5/merge` lists **only** the 9 owned files.
   This is the check that matters most: it is how you would catch a co-tenant's
   work having been swept in, which has happened in this organisation before.

Before trusting a *negative* result from step 1, confirm the method works by
finding a sibling lane's existing PR in the same listing. An empty answer and a
broken method look identical otherwise.

#### The merge ref lags a push, and it lags silently

**Measured 2026-09-26.** A push moved `head` from `0d7e997` to `55f1316`, and in
the same `ls-remote` `refs/pull/5/merge` still advertised `7674688` — the value it
had held before the push, whose second parent was `0d7e997`, i.e. `HEAD~2`. The
remote recomputes mergeability as a background job, so for a window after every
push the advertised merge preview describes the **previous** head.

This fails in the quiet direction, which is what makes it worth writing down:

- the ref is present, so an existence check passes;
- its SHA is a real commit that really does merge cleanly;
- nothing in the output says "stale";
- so "is the merge clean?" gets a confident **yes about the wrong commit**.

Anyone verifying in the seconds after a push gets that answer. Certifying it
would mean certifying two commits that are no longer on the branch.

**The check that catches it** — the second parent must be the head you just
pushed, not merely *a* plausible commit:

```
git -C ~/vexo-connect-x-lanes/experience fetch --force github \
  'refs/pull/5/merge:refs/pr/5/merge'
git -C ~/vexo-connect-x-lanes/experience log -1 --format='%P' refs/pr/5/merge
```

Second parent `!=` local `HEAD` → stale, wait and re-read. It recomputed within
seconds here, but the wait is not the point; noticing is.

**`--force` is required, and here is why** — measured, not assumed. Each recompute
replaces the merge commit with a *sibling*, not a descendant: `76ca747` is not
reachable from `7674688`, because both are merges of the same `main` with
different heads. So updating a local ref from one to the other is a
non-fast-forward, and a plain fetch refuses it:

```
$ git fetch github 'refs/pull/5/merge:refs/pr/5/merge'
 ! [rejected]        refs/pull/5/merge -> refs/pr/5/merge  (non-fast-forward)
$ echo $?
1
```

The refusal is visible and the exit status is 1 — this part is not silent. What
*is* quiet is the consequence: the local ref still holds the old commit, so a
pipeline that discards stderr or ignores the exit status goes on to read a
perfectly valid stale merge and reports it as current. Use `--force`, or fetch
into a fresh ref name, and check the parents either way.

Same discipline as everything else in this delivery: a ref that exists is only a
promise until you read what it points at.

`main` is not a push target and was not advanced. Coordination with W1 on merge
order is still open — §5. **Merge is gated on integration and Captain-workflow
evidence being green on the candidate, not on the merge box being green.**
