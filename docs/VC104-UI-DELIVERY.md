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
| `qa/run-all.sh` | One-shot pipeline: self-heal node_modules → seed → both servers → QA → cleanup (§6) |

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

> RUN 2026-09-24 (`results-vc104.json` `"at": "2026-09-24T14:19:48.479Z"`):
> **72/72 checks passed, 0 skipped.** Evidence: `qa/screens/results-vc104.json`
> plus 19 numbered screenshots (`01`…`18`, with `15b` for the D-2 pin); run
> logs `/tmp/vc104-ui-qa-20260924-141846/`. Executed via
> `bash frontend/qa/run-all.sh` (§6) against a per-run reset demo DB. Two
> earlier same-day runs each failed on a real defect — the register is §3
> (backend D-1/D-2 reported to W1; harness and pipeline defects fixed here).

Coverage as run (each check passes, fails, or records an explicit SKIP with
its reason — Cyber Hub's real 11:00–22:00 hours and Monday closure make some
checks time-dependent by design; this run needed none of the skips):

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
   visibly re-prices (₹40 → ₹65) — the banner rises on payable-quote drift
   because the server's `priceChanged` cannot see it (D-1) — and history
   shows the move between named stores.
10. Manager scope after the move (routed-or-accepted only).
11. Capacity, on the scheduled path (see D-2): two ₹360 baskets scheduled
    into one shared future 15-min slot fill CH (cap 2); a third basket in
    that slot is refused "Kitchen full" with the 2/2 count while CP is
    untouched — plus a D-2 tripwire pin: the same basket flipped to ASAP
    books 0/2 despite §9's live ASAP CH order.
12. Cashier: no nav item, bounced route, 403 on read AND write APIs.
13. 390px responsive pass on both pages (no horizontal overflow).

Not browser-exercisable with this seed, by design: `POS_HQ_ROUTING_NOT_ENTITLED`
(the fixture licence IS entitled; the refusal is covered by W1's unit tests).

## 3. Defects found during QA

> The two backend defects below are also written up for W1 as a standalone
> report — `docs/VC104-BACKEND-DEFECTS.md` — with line numbers pinned to
> `x/vc104-api` @ `c40683b`, the reason W1's suite stays green on both, and
> suggested fixes with their trade-offs.

### D-1 — backend `priceChanged` ignores the delivery charge (W1's tree; REPORTED, not fixed)

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

W1's backend is read-only from this lane, so the fix here is UI-side and rule-
compliant: `PhoneOrders.jsx` derives
`quoteChanged = Boolean(priceChanged) || payableQuote !== previous payableQuote`
— an inequality between two server-computed numbers, no client money
arithmetic — and raises the re-price banner on either signal. W1 should either
fold `deliveryCharge` into the flag or the contract should bless the
quote-drift definition.

### D-2 — backend capacity never counts ASAP orders (W1's tree; REPORTED, not fixed)

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

QA consequence: §11 now proves the capacity UI on the scheduled path (two
₹360 baskets scheduled into one shared future slot; the third basket is
refused with "Kitchen full" and the 2/2 count) and pins the ASAP hole as an
explicit tripwire check that will FAIL the day W1 changes the semantics —
the pin's failure note says to retire it and re-prove ASAP with real
fillers. Suggested backend fix (W1's call): anchor ASAP orders to their
submission slot (persist `scheduledFor = now`) or extend the count with
`OR (scheduledFor IS NULL AND createdAt within the window)`.

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

### Pre-run review fixes (kept)

Positional menu clicks made basket totals depend on catalog sort order (now
named products with minimum-clearing totals), and a below-minimum basket could
mask the AT_CAPACITY verdict the capacity check asserts.

## 4. Separation of what is proven

- W1's backend is used READ-ONLY from `../vc104-api/backend` — not one file
  touched there; this lane's evidence is the UI's, not a re-run of W1's tests.
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

One shot (everything below, plus node_modules self-heal from vc105-ui's
byte-identical install, health waits and server cleanup):

```bash
bash frontend/qa/run-all.sh
```

Or step by step:

```bash
# W2's own DBs on the shared dev container (once):
docker exec atc-pos-dev-db psql -U atc_pos -d postgres \
  -c 'CREATE DATABASE atc_pos_vc104ui_demo' -c 'CREATE DATABASE atc_pos_vc104ui_test'

# Schema: stream W1's migration chain (lexicographic = chronological):
cat ../vc104-api/backend/prisma/migrations/*/migration.sql \
  | docker exec -i atc-pos-dev-db psql -v ON_ERROR_STOP=1 -U atc_pos -d atc_pos_vc104ui_demo -q

# Seed + QA fixture (licence → MULTI_STORE), verified by row counts:
node frontend/qa/run-seed.mjs
```

Secrets never print: the DB password is read from the container's environment
at runtime and the demo login password is DERIVED from it in-process
(sha256, first 24 hex chars) — the same derivation feeds the seed env vars and
`QA_PASSWORD`, so no credential is ever echoed, written to a file, or pasted
into scrollback. `seed.js` prints every password it issues, so the runner
swallows its stdout and proves seeding by row counts instead.

```bash
# W1's backend, read-only, on W2's port + DB (background):
cd ../vc104-api/backend && PORT=5382 HOST=127.0.0.1 \
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
