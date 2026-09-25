# WINDOW-5 → backend owners: route changes requested, not made

Window 5 (experience lane `x/experience`, worktree
`~/vexo-connect-x-lanes/experience`, runner `~/vcx-experience-local/vcxe`,
private DB `vcx_experience_test` on `127.0.0.1:5440`). Base `77242fe`, the
shared lane base (= remote `checkpoint/integration-77242fe-20260925`).

**Nothing in this document has been applied.** Every file named below belongs
to another window. This is the record of what W5 needs, why, and what the
change must not break — written so its owner can judge it without reading
W5's frontend.

| Ask | File | Owner |
|---|---|---|
| §1 Make CAPTAIN reachable on order-taking | `backend/src/api/routes/orders.js` | **W3** (shared order/payment authorization) |
| §2 Same, for QR submission accept/reject | `backend/src/api/routes/tableQr.js` | **W3**, unless `zen-bhabha` claims it with the rest of tables |
| §3 `order.item.void` is unreachable — recorded, not changed | `orders.js` + `lib/permissions.js` | **W3** |
| §4 Idempotency on three order writes | `orders.js` + `schema.prisma` | **W3** |
| §5 Publish CONTROL.md | — | **W1** |
| §6 Two reporting detectors now lie | `backend/src/lib/reporting/exceptions.js` | **W4** / inventory lane |

---

## 1. `orders.js` — CAPTAIN cannot take an order

### What is wrong

`orders.js:86` gates every order-taking route on a role list that omits the
one role whose entire job this is:

```js
const operate = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'), requireUsableLicense];
```

`ROLE_ACTIONS.CAPTAIN` (`lib/permissions.js:323`) holds `order.create`,
`order.item.void`, `kot.read`, `order.read`, `table.read`, `catalog.read`.
`frontend/src/lib/roles.js` describes the role to the administrator who hires
one as *"Takes orders and sends them to the kitchen — handles no money."*

Neither is true today. A captain is refused `403` by `requireRole` before any
of that is consulted. The role is sold, granted, and inert.

### The change

Add one gate beside the existing ones and use it on five routes:

```js
// A captain may open an order and send it to the kitchen, and may do nothing
// with money. That is a different question from `operate`, which is "may work
// the till", and it needs its own answer rather than a fourth name in that list.
const takeOrders = [
  requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER', 'CAPTAIN'),
  requireUsableLicense,
  loadPermissionContext,
  requireAction('order.create'),
];
```

| Line | Route | From | To |
|---|---|---|---|
| 342 | `POST /` | `...operate` | `...takeOrders` |
| 420 | `POST /:id/items` | `...operate` | `...takeOrders` |
| 518 | `PATCH /:id/items/:itemId` | `...operate` | `...takeOrders` |
| 619 | `DELETE /:id/items/:itemId` | `...operate` | `...takeOrders` |
| 756 | `POST /:id/kot` | `...operate` | `...takeOrders` |

**Everything else keeps the gate it has.** `operate` stays on discount (812,
903), bill (1140), payments (1236, 1490, 1643, 2070, 2240, 2508);
`managerUp` stays on void (676), reconcile (1735), refunds (2675, 2852);
`promoGate` stays on promotions (965, 1102). No money route is touched.

### Why this shape and not a bare `requireAction`

`middleware/permissions.js:104` argues for `requireAction` alone, and for most
routers it is right. It is wrong here, and the reason is specific:

`ROLE_ACTIONS.POS_SUPER_ADMIN` is `Object.freeze([...ACTION_KEYS])` — every
action, including `order.create` — and `order.create` is not in
`SUPPORT_GRANT_REQUIRED`. A bare `requireAction('order.create')` therefore
admits a platform operator to mutate a tenant's orders, breaking the fence
`orders.js` states in its own header at line 3: *"ATC operators are read-only
here (403 on writes)."*

Keeping `requireRole` in front, with `POS_SUPER_ADMIN` absent from the list, is
what holds that fence. `requireAction` behind it then supplies the thing
`requireRole` cannot: the tenant's **resolved** answer.

This is not a new invention. It is the pattern `zen-bhabha` landed one commit
ago in `x/tables` `f7132c5` on `POST /tables/:id/service`
(`api/routes/tables.js:44-57`) — `requireRole(...)` deliberately omitting
`POS_SUPER_ADMIN`, then `requireUsableLicense`, `loadPermissionContext`,
`requireAction('table.service')`. W5 is asking for the same construction on
the order routes, not a different one.

### What it preserves

- **Tenant boundary** — `router.use(requirePosAuth, resolveCompanyScope, …)`
  and `loadOrder`'s `companyId` filter are untouched.
- **Assigned-store boundary** — `loadOrder`'s `isBranchPinned(req.user) &&
  order.branchId !== req.user.branchId → forbidden` and `assertDeviceStore`
  are untouched. `CAPTAIN` is in `STORE_PINNED_ROLES` (`lib/permissions.js:489`),
  so a captain is pinned to one store by the same rule as a cashier.
- **Licence / module checks** — `requireUsableLicense` stays first.
  `requireAction` additionally applies `requiredModuleFor`, which returns
  `null` for `order.create` (no `EXTENSION_POINTS` prefix matches `order.`),
  so **no new entitlement is required** and no licence that works today stops
  working.
- **Platform-admin restriction** — held by the `requireRole` list, above.
- **Billing, payment, discount, void** — not in the five routes; unchanged.
- **Resolved, not baseline** — `requireAction` runs `permissionContextFor`,
  so a tenant `PermissionRule` DENY on `order.create` refuses that captain.
  This is the same test `resolveWaiter` already applies in the tables lane
  (`lib/tables/service.js:66`, `ctx.can('order.create')`), so a person who
  may be credited as a table's server and a person who may open an order
  become the same person by the same rule.

### One behaviour change, stated rather than buried

These five routes currently consult **no** `PermissionRule`. Adding
`requireAction('order.create')` means a `CASHIER` whose tenant has explicitly
DENY'd `order.create` stops being able to open orders. That is what the tenant
asked for and is almost certainly the intent of the rule — but it is a change
to an existing role on an existing route, it is W3's call, and W5 is not
making it quietly. If W3 prefers to avoid it, the alternative is to add
`'CAPTAIN'` to `operate`'s role list and accept that the gate stays
baseline-only; W5 recommends against it, because it leaves the captain's
authority unauditable by the tenant.

---

## 2. `tableQr.js` — the same gate, the same omission

`tableQr.js:40-43`:

```js
const canOperate = [
  requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'),
  requireUsableLicense,
];
```

| Line | Route | Requested |
|---|---|---|
| 623 | `GET /submissions` | add `CAPTAIN` |
| 653 | `POST /submissions/:id/accept` | add `CAPTAIN`, + `requireAction('order.create')` |
| 672 | `POST /submissions/:id/reject` | add `CAPTAIN`, + `requireAction('order.create')` |

Accepting a submission calls `acceptSubmission`, which creates order items and
cuts a KOT through the same `routeKotItems` the till uses. It is order-taking,
so `order.create` is the action that already describes it; W5 is not asking for
a new action key.

`canManage` (line 39 — card issue, revocation, bulk export, visit close) must
**not** change. A captain has no business minting or revoking a QR card.

**Until this lands, W5's frontend treats the submission list as optional.**
`Captain.jsx` calls `GET /table-qr/submissions` with `.catch(() => null)` and
renders the board without it, so a captain sees tables and can order but cannot
see or accept guest submissions. That is a degraded screen, not a broken one,
and it is degraded honestly.

---

## 3. `order.item.void` is granted to two roles and reachable by neither

Recorded for the owner. **W5 has not changed this and is not asking for a
policy decision in passing.**

`ROLE_ACTIONS` grants `order.item.void`:

- `CASHIER` — `lib/permissions.js:319`, `[...SELL, 'order.item.void']`, where
  the trailing element is there on purpose and by itself.
- `CAPTAIN` — `lib/permissions.js:323`.

The route that consumes it, `POST /:id/items/:itemId/void` (`orders.js:678`),
is `...managerUp` — `CUSTOMER_OWNER` and `BRANCH_MANAGER` only. So the action
is unreachable for **both** roles that hold it, and a tenant administrator who
opens the permission screen, sees "Void a line" against Cashier and leaves it
switched on has been told something untrue.

Exactly one of these is wrong and the two possible fixes are not equivalent:

- If the route is right, `order.item.void` should come out of both baselines —
  the permission screen stops advertising an authority nobody has.
- If the baselines are right, the route needs a gate that admits the holders —
  which is a revenue-affecting widening (a voided line leaves the bill) and
  wants its own decision, its own tests, and probably its own audit trail.

W5's screen is built for the first reading: `Captain.jsx` shows a
non-interactive "With the kitchen" note on a line already sent, rather than a
void button that would answer 403 every time. If W3 takes the second reading,
that note becomes a button and W5 will make the change — say which.

---

## 4. Idempotency on `POST /orders`, `POST /:id/items`, `POST /:id/kot`

### Why W5 needs it

A captain works on a handheld, over venue wifi, walking between a basement
kitchen and a terrace. A request that gets no reply is routine, and a reply
lost on the way back is indistinguishable from a request that never arrived.

`Order`, `OrderItem` and `Kot` carry no idempotency key. W5's frontend therefore
**does not retry** — an unanswered write is declared unknown, the screen
re-reads server state, and every write control stays dead until it has.

### Measured, not assumed — and the scope is narrower than first written

This section originally claimed all three writes duplicate under retry. Two of
them do not, and `tests/captainWorkflow.test.js` now pins all three:

| Write | Resent identically | Why |
|---|---|---|
| `POST /orders` (DINE_IN) | **409, one order** | `orders.js:368` refuses a table already holding an OPEN or BILLED order. The table is the idempotency key. |
| `POST /:id/kot` | **409, one ticket** | The route sends only unsent lines; after the first call there are none. |
| `POST /:id/items` | **silently doubles the qty** | The route merges an identical line into the existing row. |

So the captain's two riskiest moments are already safe, and the remaining gap
is the add-line — which is the *worst* of the three to lose, because it does
not surface as a suspicious duplicate row a captain might spot. It surfaces as
`2 × Dal`, indistinguishable from a guest who asked for two. It is caught only
at the bill, by the guest.

This narrows the ask and it lowers the urgency, and both are stated here rather
than left as the stronger original claim.

### What is asked

The contract already exists twice in this codebase and W5 is asking for a third
use of it, not a new design:

- `QrSubmission` (`schema.prisma:5174`) — `idempotencyKey String` +
  `requestHash String`, `@@unique([companyId, idempotencyKey])`. Its comment is
  the specification: *"a phone that retries on a flaky connection gets the
  first answer back instead of a second order. requestHash is sha256 over the
  normalised line list: the same key with a DIFFERENT basket is a client bug
  and is refused."*
- `PhoneOrder` (`schema.prisma:4073`) — identical shape.
- Replay handling to copy: `guestQr.js:386-394`, `idempotencyClash()` on
  `P2002` → `409 POS_QR_KEY_REUSED`, with the unique index as the guarantee
  rather than a pre-check.

Applied to **`POST /:id/items`** — the one route measured to duplicate — this
would let W5 offer the captain a real "send it again" on a send whose outcome
is unknown, instead of only "go and look". Until then W5 does not offer one,
and does not pretend to.

`POST /orders` and `POST /:id/kot` no longer need it on W5's account. Adding it
there would be defence in depth for TAKEAWAY creates, which have no table to
serve as the key, but W5 does not depend on that.

**Priority: lower than §1.** §1 makes the role work at all. §4 makes it
pleasant on bad wifi. If only one lands, land §1.

---

## 5. W1 — please publish CONTROL.md

W5's brief says to read Window 1's `CONTROL.md` for owners and candidate
identity. It does not exist: searched the working tree, every branch on both
remotes, and the session transcripts. The nearest artefacts are
`WINDOW-1-COORDINATION-NOTE.md` (2026-09-24, integration pipeline, names
sessions `77a07c43` and `896234f0`) and the per-lane `WINDOW-N-HANDOFF-*.md`
files, which are per-lane status rather than a register.

W5 needs from it, specifically:

1. **Who owns `orders.js` and `tableQr.js` right now** — this document assumes
   W3 for both on the strength of the brief. If `tableQr.js` belongs with
   tables, §2 should go to `zen-bhabha` instead.
2. **The candidate identity** — which SHA on which branch is the integration
   candidate W5's acceptance evidence must be produced against. W5 has tested
   `77242fe` + its own commits; if the candidate moves, the evidence is stale
   and W5 will re-run rather than restate.
3. **Where a cross-window request is meant to go.** W5 has followed the
   `WINDOW-N-*.md`-at-repo-root convention because that is what the tree shows;
   if there is a register, this file should be an entry in it.

W5 has not created a register of its own and will not. Two competing
integration authorities would be worse than none.

---

## 6. W4 / inventory — two exception detectors now claim "found none"

Found while establishing W5's baseline, outside W5's scope, reported here
because the screen that renders it is on W5's list.

`backend/tests/reportingExceptions.test.js:626` fails on base `77242fe`,
deterministically, in isolation:

```
AssertionError: NEAR_EXPIRY: expected +0 to be null
```

`detectorState` (`lib/reporting/exceptions.js:459`) decides a detector is
`UNAVAILABLE` when `hasModel(...d.needs)` is false. The four stub detectors at
lines 419-455 each declare `needs` and a `run: async () => []`. On this base:

| Detector | `needs` | present in client | state |
|---|---|---|---|
| `LOW_STOCK` | `stockItem`, `stockLevel` | **no** | correctly UNAVAILABLE |
| `NEAR_EXPIRY` | `stockBatch` | **yes** | wrongly AVAILABLE |
| `OVERDUE_REQUEST` | `storeRequest` | **yes** | wrongly AVAILABLE |
| `SETTLEMENT_MISMATCH` | — (integration) | n/a | correctly PENDING |

The inventory lane landed `StockBatch` (`schema.prisma:1633`) and
`StoreRequest`. Their detectors are still stubs, but `hasModel` now says yes,
so both are run, both return `[]`, and both report `found: 0`.

The file's own comment at line 625 names the consequence: *"`0` would read as
'looked, found none'."* An owner on a deployment that genuinely tracks batches
is now shown "Batches near expiry: none" by a detector that has never looked
at a batch. This is the exact failure the surrounding block was written to
prevent, and the test caught it.

The test reports only `NEAR_EXPIRY` because the assertion stops at the first
failing kind; `OVERDUE_REQUEST` is the same defect, currently masked.

W5 has not touched it. Whoever owns `exceptions.js` should decide whether to
implement the two detectors or tighten `needs` to something the stub actually
requires.

---

## 7. Visits — a paid table reads FREE on any floor run without guest scans

**Owner: whoever owns `DiningVisit` / active tables (believed `zen-bhabha`).
W5 has recorded this and changed nothing.**

W5's brief names this hazard directly: *"'paid' must not automatically mean
'table available'"*. `lib/qr/tableState.js` is written to honour it and does —
but only when the evidence it needs exists, and on a captain-run floor it does
not.

### The chain

1. `TABLE_STATE_INCLUDE` filters `orders` to `status in (OPEN, BILLED)`
   (`tableState.js:49`). A settled order leaves the array.
2. So the only remaining evidence for `PAID` is the settled order read
   **through the visit** — `visits.orders where status PAID`
   (`tableState.js:78`). The file says so itself: *"The visit is the thing that
   says the party has not got up yet, and a settled order under it is the only
   honest evidence for PAID."*
3. `DiningVisit` is created in exactly one place: `openOrJoinVisit`
   (`lib/qr/visits.js:118`), which takes a scanned `qr`. There is no staff
   "seat a party" route.
4. `api/routes/orders.js` never references `visitId` at all — an order rung up
   at the till or on the handheld is never attached to a visit.

Therefore: a table ordered and paid entirely through staff, with no guest ever
scanning the card, has no visit and no attached order. The instant payment
covers the bill the table reads **`FREE`** — not `PAID`.

### Evidence

`tests/captainWorkflow.test.js`, two adjacent tests that pass together:

- *"PAID is not FREE"* — the order is attached to a visit first (what the
  guest-QR path does) and the table correctly reads `PAID`. `tableStateOf` is
  not the problem.
- *"GAP: with no visit, paying frees the table immediately"* — same sequence
  with no visit, asserting `FREE`. It asserts today's behaviour deliberately,
  so that whoever fixes this sees the test fail and rewrites it, rather than
  the change landing silently.

### Not fixed here, and why

Three plausible fixes and they are not equivalent — the choice belongs to the
owner, not to W5:

1. Open a visit when a DINE_IN order is created and attach it. Makes `PAID`
   reachable everywhere, but gives every till order a visit row, which changes
   what `/visits` returns for a window that already ships against it.
2. Attach the order to an existing open visit only. Smaller, but leaves the
   no-scan floor exactly as it is today.
3. Widen the `orders` include to carry the most recent settled order. Changes
   `occupied` for every caller of the floor plan — `tableState.js:74-77`
   explicitly warns against this one.

W5 needs no change to ship: the Captain screen reads whatever state the server
derives and labels it in text, so it will display `PAID` the day the evidence
exists. Flagged because the requirement names it, not because W5 is blocked.

---

## 8. Kiosk — there is no surface a walk-up guest can order from

**Owner: unresolved, and that is the first thing this section asks for. The
guest router is W5-adjacent but `openOrJoinVisit` and the `QrSubmission` shape
are shared with whoever owns visits and active tables (believed `zen-bhabha`).
W5 has written no kiosk code and changed nothing.**

W5's brief asks for a kiosk "with real APIs" and forbids the alternative in the
same sentence: *"Reuse order and identity services rather than creating
alternate billing or authentication logic"*, and *"Do not label a disconnected
UI as offline order support."* Both rule out the page W5 could have shipped
this week. A kiosk needs an unauthenticated, table-free, one-party-at-a-time
write path, and the product has no such path.

### The three measured blockers

1. **There is exactly one unauthenticated write surface, and it is bound to a
   scanned card.** `app.js:294-295` mounts `/guest/qr` under `if
   (qrOrderingEnabled)` and the comment above it is explicit: *"PUBLIC, and the
   only unauthenticated write surface in the product… the credential is the
   token printed on the card."* Every other router sits behind
   `requirePosAuth` — `orders.js:84` is `router.use(requirePosAuth,
   resolveCompanyScope, deviceContext)`. A kiosk in a lobby has no cashier
   login to present and no card to scan, so it can reach neither.

2. **The guest path demands a join code from the second party at a table.**
   `openOrJoinVisit` (`lib/qr/visits.js:118`) finds an open visit and, with no
   `joinCode` supplied, throws `POS_QR_JOIN_CODE_REQUIRED` at `visits.js:151`:
   *"Someone at this table has already started an order. Ask them for the
   4-digit code."* That is correct for a table — it is what stops a stranger
   adding to your bill. It is wrong for a kiosk, where the whole point is that
   consecutive unrelated customers use the same terminal. Reusing it would
   either lock every customer after the first out of the terminal, or put them
   on the previous customer's bill.

3. **The guest queue is structurally table-bound.** `QrSubmission.tableId` and
   `QrSubmission.visitId` are both non-null in `schema.prisma`, each with a
   relation and `onDelete: Restrict`. So even a kiosk that got past the two
   points above could not put a basket in the queue staff actually work from.

The schema itself is not the obstacle: `OrderType` carries `TAKEAWAY`,
`Order.tableId` is nullable, and `orders.js:358-359` refuses a `tableId` on a
TAKEAWAY order rather than requiring one. A table-free order is a first-class
thing here. What is missing is a way for a guest to ask for one.

### What W5 explicitly did not do

Route kiosk orders through a dedicated `DiningTable` row — a "Kiosk 1" table —
to satisfy the two non-null columns. It would have compiled, demoed, and put a
kiosk page in the build this week. It is rejected because it makes the floor
plan lie: that row would appear on the Captain board and in `tableStateOf`,
escalating through SEATED → IN_KITCHEN like a real table, and W5 spent this
sprint fixing exactly that class of defect (a Captain header reading `Free`
over food already with the kitchen). Deliverable 1 requires states that mean
what they say; a phantom table is the same failure with a nicer name.

Nor did W5 ship a kiosk screen that cannot order. The brief names that outcome
directly.

### The change W5 needs, and the decision that comes first

Before any route text: **who owns it?** The surface is unauthenticated, so it
is a security boundary, and it touches `visits.js` and `QrSubmission`, which
W5 does not own. W5 is not proposing to add a second public write path on its
own authority. Per the directive on ownership, this section records the
requirement and stops.

If the owner wants it, the smallest shape that reuses rather than duplicates:

- A kiosk credential that is a **device**, not a card and not a user — the
  terminal is registered once, and the token identifies the terminal, so
  `deviceContext` keeps doing its job and no alternate authentication logic
  appears.
- Orders of `type: TAKEAWAY` with `tableId: null`, through the **existing**
  `POST /orders` service path, so pricing, tax, KOT and payment stay exactly
  where they are.
- Either relax `QrSubmission.tableId`/`visitId` to nullable **or** give the
  kiosk a queue of its own. Nullable is smaller but changes a shape other
  windows read; a separate queue is more code but touches nobody. W5 has no
  preference and no standing to pick.
- No visit, and therefore no join code. One kiosk basket is one party by
  definition, and it ends at payment.

W5's floor, Captain and reporting work does not depend on any of this, and the
rest of the delivery ships without it. Recorded as a genuine missing external
input rather than built around.

---

## Baseline this was found on

`vcxe test` at source `77242fe`, `vcx_experience_test`, 2026-09-25 19:40:19Z:
**1652 passed / 3 failed of 1655**, 52 files, 1880.95s.
Log: `~/vcx-experience-local/evidence/baseline-77242fe.log`.

| Failure | Classification |
|---|---|
| `integrations.test.js` 100,000-row loyalty import | timeout at 900086ms against a 900000ms limit, while two sibling lanes were running. **Passes in isolation** — 119/119, the import in 770807ms. Load, not a regression. Log: `evidence/integrations-solo-PASS.log`. |
| `invitations.test.js` weak-password | timeout at 20088ms against 20000ms. **Passes in isolation** — load, not a regression. |
| `reportingExceptions.test.js` NEAR_EXPIRY | **Real.** Fails in isolation. §6. |

All three classified: two are load artefacts of running three lanes at once,
one is a real pre-existing defect that belongs to §6. Nothing in the baseline
is attributable to W5's changes.

## W5's own suite

`tests/captainWorkflow.test.js` — **29 passed / 29**, 2026-09-25 20:34Z.
Log: `~/vcx-experience-local/evidence/captain-acceptance-PASS.log`.

It is the executable form of the acceptance list: the cashier order-taking
journey over HTTP; the captain refused on every order-taking route with the
business-record counts proven unchanged; money, void, cross-store and
ATC-operator refusals each asserting the status **and** the absence of the row;
lost-reply behaviour for all three writes; the full `tableStateOf` machine
including `READY` ≠ `SERVED` and `PAID` ≠ `FREE`; and the floor layout carrying
a per-table service state a captain can read.

Several tests in it assert **today's** behaviour where today's behaviour is
wrong (§1's refusals, §7's `FREE`). Those are labelled in place and are meant
to fail and be rewritten when the fix lands — a silent pass after a policy
change would be worse than a red test.
