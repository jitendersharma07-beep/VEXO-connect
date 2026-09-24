# VC-104 Phone-order Centre — UI delivery and browser QA

Lane: `x/vc104-ui` (worktree `vc104-ui/`, base `bddbe82`), W2 = frontend.
Contract: `../vc104-api/docs/VC104-API-CONTRACT.md` v1.2.1 — the version AND its
sha256 are pinned in `frontend/src/lib/vc104.js`, so a contract edit nobody
announced shows up as a checksum diff, not as a silently wrong screen.

Everything here is UNCOMMITTED, like the rest of the lane. Owner-decision
blockers are untouched and still open: phantom base `4f2a91c` in W1's handoff,
C-6 (GST treatment of the delivery charge — quoted, never billed), modifiers
absent at `bddbe82`, C-7 (company-wide menu only).

## 0. What was verified before building

Nothing below was assumed from the handoff; each was read in W1's tree or the
house frontend before a line of UI depended on it.

| Claim the UI depends on | Where it was verified |
| --- | --- |
| Roles, not permission actions, gate phone routes | `src/api/routes/phoneOrders.js`: `can(action) = [requireRole(...rolesFor(action)), requireUsableLicense]` — so `phone.*` never appears in `GET /permissions/me`, and the UI must gate by role |
| `phone.order.reassign` is CUSTOMER_OWNER-only | `rolesFor` map in `src/lib/phoneOrders.js` |
| Cross-store routing needs `plan === 'MULTI_STORE'` | `hqRoutingEntitled` in `src/lib/phoneOrders.js`; the seed issues FREE_TRIAL, so W2's QA fixture upgrades its own DB's licence row (see §6) |
| Response envelopes | list `{phoneOrders}`, detail `{phoneOrder + events[]}`, decisions `{phoneOrder}`, submit `201/200 {phoneOrder}` — read off the route file, not the doc |
| Event stream shape | `{at, action, fromBranchId, toBranchId, reason}`, actions SUBMITTED/ACCEPTED/REJECTED/REASSIGNED |
| Error envelope + codes | `POS_PHONE_ORDER_ALREADY_DECIDED`, `POS_IDEMPOTENCY_KEY_REUSED`, `POS_BRANCH_UNAVAILABLE {unavailableReasons}`, `POS_HQ_ROUTING_NOT_ENTITLED`, duplicate-customer 409 with `details.customerId` |
| Money is server-computed | `buildQuote(order, deliveryCharge)`; `payableQuote = total + deliveryCharge` arrives as three numbers; the client formats and never adds |
| Catalog endpoint | `GET /catalog/products` → `{products}`, ACTIVE by default, name-ascending |
| Customer search param | `?q=`, minimum 3 characters server-enforced |
| Seed fixtures | `prisma/seed.js`: BSC-CP 09:00–23:00 ₹40/min ₹200 @110001, ₹50 @110002, cap 6/15min; BSC-CH 11:00–22:00 closed Mondays ₹65/min ₹300 @110001, ₹45/min ₹250 @122001, cap 2/15min; Anita Rao (+…0011, Home 110001 default, Office 110002), Dev Menon (+…0012, Home 122001); menu ₹90–₹220, licence FREE_TRIAL |
| House UI kit | `useToast()` returns `push(message, kind)`; `ReasonModal` idle label is the `busyLabel` prop, auto-closes on a resolved `onSubmit`; `apiError`, `fmtINR(null)='—'`; toasts carry `role="alert"` |

## 1. What was built

| File | What it is |
| --- | --- |
| `src/lib/vc104.js` | Contract pin (version + sha256), status styles, queryable statuses (no CANCELLED — `?status=CANCELLED` is a 400 by contract §4), reason-code badge labels, error-envelope readers, `newIdempotencyKey()` |
| `src/pages/PhoneOrderNew.jsx` | Operator entry: caller search (≥3 chars, debounced) / new caller with duplicate-409 recovery, pickup–delivery with address list (default pre-selected, make-default, archive, add with 6-digit pincode), ASAP or scheduled, catalog + variant dropdown + basket (qty ≤999), check-stores with EVERY store's verdict + reasons, note, submit |
| `src/pages/PhoneOrders.jsx` | The centre: status chips in the URL, list, detail with caller card, decider names, money block, events timeline, Accept/Reject (routed store or owner), owner-only Move with basket-less preview + re-priced banner |
| `src/App.jsx` | Two routes under `RequireRoles roles={['CUSTOMER_OWNER','BRANCH_MANAGER']}` — role-gated because the server is |
| `src/components/Layout.jsx` | "Phone orders" nav item behind `isManagerUp(user)`, non-ATC scope only |
| `qa/vc104-browser-qa.mjs` | Real-browser QA (below) |
| `qa/run-seed.mjs` | Provisioning runner: seeds W2's own DB with secrets that never print (§6) |
| `qa/run-all.sh` | One-shot pipeline for **both** UI suites: provision → per-suite seed → servers → QA → cleanup, VC-104 then VC-105 (§6) |
| `qa/tree-stamp.mjs` | Derives `tree`/`branch`/`baseSha`/`dirty` from where the harness is running, so a results file states which tree produced it (D-4) |

### The rules the screen exists to honour

- **The client never computes money** (§3/§8). `payableQuote`, `order.total`
  and `deliveryCharge` are three server numbers; the screens format them and
  never add them. The QA asserts the on-screen strings equal the wire numbers
  and separately asserts the server's own invariant held on that response.
- **One idempotency key per form, minted at open** (§5.7). A double-click or a
  network retry can never create a second order; only "Take another order"
  mints a fresh key. A burnt key (409 reuse) locks the form and says so.
- **Every store is shown with its reasons, never hidden** (§5.6). Unavailable
  stores render badge + the server's authoritative `message`.
- **Store options are point-in-time** — any feeding input change withdraws the
  option list and the chosen store rather than leaving a stale verdict
  clickable; a submit-time 409 writes the server's reasons back onto the
  chosen option.
- **No CANCELLED filter chip** (§4): the enum value exists but no route can
  produce it and querying it is a 400.
- **Delivery charge is QUOTED, not billed** (C-6 open): the success panel and
  the detail money block both carry the caveat, sourced from
  `deliveryChargeBillable: false`.
- **Attribution is names**: taken-by / accepted-by / rejected-by render the
  snapshotted `*Name` fields, never a join the user table could orphan.

## 2. Browser QA — RUN AND GREEN

> RUN 2026-09-24 (`results-vc104.json` `"at": "2026-09-24T18:09:52.465Z"`):
> **72/72 checks passed, 0 skipped.** Evidence: `qa/screens/results-vc104.json`
> plus 19 numbered screenshots (`01`…`18`, with `15b` for the D-2 pin); run
> logs `/tmp/vcx-qa-20260924-180847/`. Executed via
> `bash frontend/qa/run-all.sh` (§6) against a per-run reset demo DB.
>
> **That 72 is historical and no longer reproduces.** D-1 and D-2 were fixed
> later the same day, and §11's ASAP pin — which asserted the D-2 defect — was
> replaced by the §11b fill described below, so the harness carries a different
> set of checks than the one that scored 72.
>
> RE-RUN 2026-09-24 against the FIXED backend (`"at":
> "2026-09-24T19:15:48.164Z"`, `baseSha` `d5b1cb0`, tree `…/main-merge`):
> **VC-104 75/75, 0 skipped; VC-105 48/48.** The three checks that matter here
> are new and all passed, none skipped: *one ASAP submission moves the booked
> count by exactly one (D-2)*, *a full CH slot refuses ASAP too, with Kitchen
> full*, and *the ASAP refusal carries the full count*. The §9 check *the
> re-price banner appears after the move* also still passes with the client-side
> D-1 workaround **removed** — which is the point of removing it: the observable
> behaviour was already right, only the place it was computed moved.
>
> **This run is against this tree's own backend.** The results file says so
> itself — `tree` `…/main-merge`, `branch` `main`, `baseSha` `0115898` — which
> matters because the previously quoted 72/72 (`"at": "…T14:19:48.479Z"`) was
> byte-identical to `x/vc104-ui`'s own `results.json`: a lane artifact, against
> the lane's 14 migrations rather than this tree's 21. `run-all.sh` and
> `run-seed.mjs` had both kept resolving the backend to `../vc104-api/`. See
> D-4 in `VC104-BACKEND-DEFECTS.md`. Earlier same-day runs each failed on a
> real defect — the register is §3 (backend D-1/D-2 reported to W1; harness and
> pipeline defects fixed here).

Coverage as run (each check passes, fails, or records an explicit SKIP with its
reason). This run needed none of the skips, and no longer can for reasons of
timing: `qa/run-seed.mjs` holds both demo stores open on all seven days in W2's
scratch DB, so the suite is time-independent. Before that it was green only
between 09:00 and 23:00 IST, and outside 11:00–22:00 it silently skipped the
two blocks carrying D-1 and D-2 — a 61/61 PASS that had never exercised the
evidence §3 leans on. What that fixture costs is stated in `run-seed.mjs` and
in D-4:

0. Session + fixture preconditions (`/auth/me` role + MULTI_STORE plan).
1. Nav gating, chip set exactly All/Submitted/Accepted/Rejected, empty state.
2. Golden path: Anita Rao, default 110001 address, named-product basket
   (₹500), both stores' verdicts, CP ₹40/min ₹200, submit → 201, DOM money ==
   wire money, C-6 caveat.
3. Idempotency: byte-exact replay of the captured request → 200, same id,
   list count unchanged.
4. Stale options withdrawn on basket change; fresh form = fresh key.
5. Duplicate phone 409 → "open the existing caller" recovery.
6. Out-of-area: Dev Menon 122001 — CP shown-with-reason, CH priced ₹45.
7. List + detail: caller card, To-collect == wire payable, deep-linkable
   `?open=`.
8. Accept exactly-once: manager accepts; the deliberately-stale second decider
   gets the 409 surfaced as a toast and then sees the truth.
9. Manager rejects with a reason; owner moves the order CP→CH; the quote
   visibly re-prices (₹40 → ₹65), the banner rises on the server's
   `priceChanged` (D-1, fixed 09-24), and history shows the move between
   named stores.
10. Manager scope after the move (routed-or-accepted only).
11. Capacity on the scheduled path: two ₹360 baskets scheduled into one
    shared future 15-min slot fill CH (cap 2); a third basket in that slot is
    refused "Kitchen full" with the 2/2 count while CP is untouched.
11b. Capacity on the ASAP path (D-2, fixed 09-24 for the ordinary case): CH's
    booked count is read, the kitchen is topped up with ASAP orders submitted
    **natively at CH** one at a time — each must move the count by exactly one
    — and the full slot is then refused "Kitchen full" with the 2/2 count.
    Fillers are native by design: building them by reassignment would exercise
    the late-transfer hole that is still open, and the block would look broken
    when it is not. Replaces the old tripwire pin that asserted the defect.
12. Cashier: no nav item, bounced route, 403 on read AND write APIs.
13. 390px responsive pass on both pages (no horizontal overflow).

Not browser-exercisable with this seed, by design: `POS_HQ_ROUTING_NOT_ENTITLED`
(the fixture licence IS entitled; the refusal is covered by W1's unit tests).

## 3. Defects found during QA

> The two backend defects below are also written up for W1 as a standalone
> report — `docs/VC104-BACKEND-DEFECTS.md` — with line numbers pinned to
> `x/vc104-api` @ `c40683b`, the reason W1's suite stays green on both, and
> suggested fixes with their trade-offs.

### D-1 — backend `priceChanged` ignores the delivery charge (REPORTED here, FIXED 09-24)

`POST /phone-orders/:id/reassign` answers
`priceChanged: Number(after.total) !== before.total || Number(after.taxAmount) !== before.tax`
(`src/api/routes/phoneOrders.js:914`) — the delivery charge sits outside both
terms. Under C-7 (company-wide menu) food+tax **cannot** change on a move, so
the flag is `false` on exactly the moves that change what the caller pays
(CP → CH re-prices delivery ₹40 → ₹65). Contract §5.10 requires the UI to
"show them as a changed price, not reuse the old summary", and its example says
`"priceChanged": true` — the flag as computed can never honour that under C-7.
First seen as the §9 banner timeout in run `20260924-135119` (66 passes, then
the harness died waiting for `po-move-banner`).

At QA time W1's backend was read-only from this lane, so the fix was UI-side and
rule-compliant: `PhoneOrders.jsx` derived
`quoteChanged = Boolean(priceChanged) || payableQuote !== previous payableQuote`
— an inequality between two server-computed numbers, no client money
arithmetic — and raised the re-price banner on either signal.

**Resolved 09-24 (backend, option 1).** `priceChanged` now also compares the
payable built by `buildQuote` before and after the move, so the flag means
"what the caller was quoted moved". Details and the two-directional tests:
`docs/VC104-BACKEND-DEFECTS.md` §D-1.

**The UI workaround has been removed, deliberately.** With the server reporting
the payable drift, re-deriving it in `onDone` would be two sources of truth for
one rule — the disease D-3 was about. It also compared against `detail`, so a
stale or not-yet-loaded detail made `payableQuote !== undefined` true and raised
the banner on a move that cost the caller nothing. `PhoneOrders.jsx` now reads
`data.priceChanged` and nothing else. The §9 banner assertion is unchanged and
still passes, which is the point: the observable behaviour was already correct,
only the place it was computed moved.

### D-2 — backend capacity never counts ASAP orders (REPORTED here, FIXED 09-24)

`loadBranchDecision` counts slot bookings with
`scheduledFor: { gte: start, lt: end }` (`src/api/routes/phoneOrders.js:178–185`),
but an ASAP submission persists `scheduledFor = null` (line 569 — only an
explicit `body.scheduledFor` is stored), and NULL never matches a range
filter. So an ASAP order can never occupy a slot, and a kitchen can never
fill from the phone flow's dominant path; the seeded caps (CP 6, CH 2 per
15 min) are dead letters for ASAP traffic. Measured in run `20260924-140702`:
the CH row read "0/2 booked this 15-min slot" while two live SUBMITTED
CH-routed orders sat in that wall-clock window — the DB showed
`scheduledFor` NULL on all three of the run's orders. W1's own unit tests
pass because they schedule explicitly.

**Mostly resolved 09-24 (backend, option 2)** — not "fixed" flat, and the
qualifier matters. The count was extended with
`OR (scheduledFor IS NULL AND createdAt within the window)`, so an ASAP order
occupies the slot it was *taken* in and the column keeps its meaning
(NULL = ASAP, which `scheduled:` still reads). The rejected alternative — persist
`scheduledFor = now` — would have made an ASAP order indistinguishable from one
scheduled for now. See `docs/VC104-BACKEND-DEFECTS.md` §D-2.

**What that covers, and what it does not.** Orders taken at a store, and orders
moved into it inside the same slot — the ordinary case — are now counted. A
**late transfer is still invisible**: reassign judges the target against the slot
containing *now*, while the count anchors an ASAP order to its `createdAt`, so an
order moved in an hour after it was taken lands in a slot that has already
elapsed. W1 measured it: cap 2, one native order plus three back-dated orders
reassigned in, and all three transfers were accepted — four live orders at a
store still reporting `booked = 1, available = true`. So the guard can still
show a kitchen as open while it holds double its cap, just no longer on the
ordinary path. Closing it needs a slot-anchor column that survives a move;
that is a schema decision and is pinned, unendorsed, by a backend test.

**QA consequence — the tripwire fired and has been retired.** §11 used to prove
capacity only on the scheduled path and pin the ASAP hole as a check asserting
`available && 0/2`, written to FAIL the day the semantics changed. That day
came. Per the pin's own instructions it is gone, replaced by §11b, which proves
ASAP with real fillers: read CH's booked count, top the kitchen up one ASAP
order at a time, and require the refusal. Its load-bearing assertion is the
**increment** — one ASAP submission must move `booked` by exactly one — because
that is the defect stated positively (the old behaviour held it at 0 forever)
and it also catches a counter that double-books, which "is it full yet" would
not. The top-up loop is bounded: a count that never moves would otherwise submit
orders forever. The ASAP slot is "now" and therefore moves, so the block mirrors
the server's epoch-floored bucket and SKIPS rather than fails if the run crosses
a boundary mid-block (~1 run in 15).

### Harness defect — a timeout destroyed its own evidence (fixed)

The §9 banner wait was a naked top-level `waitForSelector`; its TimeoutError
crashed the process, and because `results.json` was written only at the happy
tail, 66 recorded PASSes evaporated with it. Fixed twice over: the wait is
caught and asserted as an ordinary check, and a `process.on('exit')` writer
persists `results.json` on every exit path, crash included.

### Pipeline defects (all fixed in `qa/run-all.sh`)

1. **Backend died at boot** — `POS_JWT_SECRET` (≥32 chars) is required by
   `src/config/env.js`. Now a per-run random secret, never printed.
2. **Orphaned vite blocked reruns** — killing the `npx` wrapper left its vite
   child alive holding 5383, so `--strictPort` refused the next run. Now the
   script `exec`s `node_modules/.bin/vite` (the tracked PID *is* the server)
   and the port pre-check reaps only listeners whose cwd is inside this lane
   or W1's tree; a foreign listener is a refusal, never a kill.
3. **No node_modules in the lane** (cut during the npm outage) — self-heal
   copies vc105-ui's byte-identical install (`package.json` diff is empty).
4. **DB password embedded raw in the URL** — would break on URL-special
   characters. Now `encodeURIComponent`-encoded in-process, env-passed, never
   on argv.
5. **Reruns were not hermetic** — the seed only tops up, so a previous run's
   orders poisoned the empty-state (§1) and capacity (§11) assertions. Each
   run now DROPs, recreates, migrates and reseeds `atc_pos_vc104ui_demo` —
   W2's own scratch DB, nobody else's evidence.
6. **The runner served the wrong tree's backend** — both `run-all.sh` and
   `run-seed.mjs` resolved to `../../../vc104-api/backend`. That was correct
   while this file lived in W2's frontend lane, where W1's was the only backend
   in reach, and silently wrong after consolidation: a green run in `main`
   was a statement about the lane's 14 migrations. Both now resolve to
   `../../backend`, stage 0 regenerates the Prisma client from **this**
   schema, and it asserts `BranchPrepCapacity` is in the generated client —
   a model this schema has and neither lane does — so a leftover lane client
   cannot pass silently. (D-4.)
7. **A green run could depend on the clock** — see §2. Both demo stores are
   now held open all week by the seed runner, which asserts `cpOpenDays=14`
   before the suite starts. The capacity block also picked its slot with
   `getHours()` (box-local, UTC) and compared it to Cyber Hub's **IST** hours;
   the two windows overlap only 11:15–16:30 UTC, so the earlier run passed
   that guard by luck. The guard is gone — the fixture keeps CH open at every
   instant, and the backend's only constraint on `scheduledFor` is that it be
   in the future.
8. **One harness failure discarded the other's result** — a VC-105 seed error
   exited the script before VC-104's already-collected verdict was printed.
   The stages are functions returning status now, and both verdicts print.

### Pre-run review fixes (kept)

Positional menu clicks made basket totals depend on catalog sort order (now
named products with minimum-clearing totals), and a below-minimum basket could
mask the AT_CAPACITY verdict the capacity check asserts.

## 4. Separation of what is proven

- The backend is used READ-ONLY — not one file touched to make the UI pass;
  this evidence is the UI's, not a re-run of W1's tests. **Which** backend
  changed on consolidation: runs before 2026-09-24T18:09Z served
  `../vc104-api/backend` (W1's lane); this tree's `backend/` serves it now, and
  the results file records which (D-4).
- W2 runs on its OWN databases (`atc_pos_vc104ui_demo`, `atc_pos_vc104ui_test`)
  on the shared dev container; W1's `atc_pos_vc104api_*` DBs untouched.
- Ports: backend 127.0.0.1:5382, frontend 127.0.0.1:5383 (W2's designated
  pair; `--strictPort` because 5177 is busy on this host; vite's config
  `host: true` is overridden to loopback on the CLI).
- Production `/home/atc-noc/atc-pos`, the frozen Core, and 20.20.20.57 were
  never involved.

## 5. Integration handoff

- The two pages + `lib/vc104.js` + the two `App.jsx` routes + the `Layout.jsx`
  nav item are the whole surface; no shared file was reshaped.
- UI gating is role-based on purpose (`RequireRoles`/`isManagerUp`) — do NOT
  "fix" it to `can()`: the server's phone routes are `requireRole`-gated and
  the actions are absent from the permission catalog until integration grafts
  them onto the foundation matrix.
- The contract checksum pin in `lib/vc104.js` must be re-verified (and
  re-pinned) whenever the contract file changes.
- `data-testid` hooks (`po-*`, `mv-*`) exist for the QA harness; keep them.

## 6. Reproducing this run

One shot — and note it now drives **both** UI suites, VC-104 and VC-105, each
against this tree's own backend, writing `results-vc104.json` and
`results-vc105.json`. It also self-heals node_modules from a lane's
byte-identical install, regenerates the Prisma client from this schema, waits
on health, and cleans up its servers:

```bash
bash frontend/qa/run-all.sh
```

Neither suite's failure hides the other's verdict: both stages run, both print.

Or step by step, for the VC-104 half:

```bash
# W2's own DBs on the shared dev container (once):
docker exec atc-pos-dev-db psql -U atc_pos -d postgres \
  -c 'CREATE DATABASE atc_pos_vc104ui_demo' -c 'CREATE DATABASE atc_pos_vc104ui_test'

# Schema: this tree's migrations, applied by Prisma (the runner DROPs and
# recreates the DB first, so each run is hermetic):
cd backend && DATABASE_URL=… node_modules/.bin/prisma migrate deploy

# Seed + QA fixtures (licence → MULTI_STORE, both stores open all week),
# verified by row counts — it prints counts and PASS/FAIL, never a password:
node frontend/qa/run-seed.mjs
```

Secrets never print: the DB password is read from the container's environment
at runtime and the demo login password is DERIVED from it in-process
(sha256, first 24 hex chars) — the same derivation feeds the seed env vars and
`QA_PASSWORD`, so no credential is ever echoed, written to a file, or pasted
into scrollback. `seed.js` prints every password it issues, so the runner
swallows its stdout and proves seeding by row counts instead.

```bash
# This tree's backend, read-only, on W2's port + DB (background):
cd backend && PORT=5382 HOST=127.0.0.1 \
  CORS_ORIGIN=http://127.0.0.1:5383 DATABASE_URL=… node src/index.js

# Frontend (background):
cd frontend && VITE_DEV_API=http://127.0.0.1:5382 \
  npx vite --port 5383 --strictPort --host 127.0.0.1

# Browser QA (Chromium from the playwright cache; puppeteer-core resolved from
# this lane or borrowed from vc105-ui's node_modules):
QA_UI=http://127.0.0.1:5383 QA_API=http://127.0.0.1:5382 \
QA_OWNER=demo.owner@atcpos.example QA_MANAGER=demo.manager@atcpos.example \
QA_CASHIER=demo.cashier@atcpos.example QA_PASSWORD=<derived as above> \
QA_CHROME=~/.cache/ms-playwright/chromium-1117/chrome-linux/chrome \
node qa/vc104-browser-qa.mjs
```
