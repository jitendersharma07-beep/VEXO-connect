# W3 — Captain and table service: the gates, and the one gap left open

Status **2026-09-26**. Everything below is either a measured result with the
command that produced it, or a named gap. Nothing here rests on a successful
build: a compile proves the gate parses, not that it refuses.

Scope of this document: `backend/src/api/routes/orders.js`,
`backend/src/api/routes/tableQr.js`, `backend/src/middleware/rbac.js`,
`backend/src/middleware/permissions.js`. Nothing else was touched.

---

## 1. What was wrong

`orders.js` gated every till route on a hard-coded role list:

```js
const operate = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'), requireUsableLicense];
```

`tableQr.js` did the same with two lists — `('CUSTOMER_OWNER','BRANCH_MANAGER')`
to manage cards and `('CUSTOMER_OWNER','BRANCH_MANAGER','CASHIER')` for the
visits and submissions inbox.

CAPTAIN is named in none of them. `ROLE_ACTIONS.CAPTAIN` holds `order.create`,
so the permission screen offered a captain the authority to take an order and
the route answered 403 anyway. The role whose entire job is working the floor
could not do it. Recorded as `WINDOW-5-BACKEND-REQUEST.md` §1/§2 by the window
that found it and could not fix it.

## 2. THE GAP LEFT OPEN, DELIBERATELY: `order.item.void`

**This is the policy mismatch the assignment asked to be resolved by
documenting rather than by granting. It is still open, on purpose.**

The facts, all checkable:

| | |
|---|---|
| Declared | `lib/permissions.js` — `A('order.item.void', 'Selling', 'Void a line', 'STORE')` |
| Held by | CASHIER, CAPTAIN, BRANCH_MANAGER, REGIONAL_MANAGER baselines |
| Enforced by | **nothing** |
| The route that voids a sent line | `POST /orders/:id/items/:itemId/void`, gated `managerUp` = `requireRole('CUSTOMER_OWNER','BRANCH_MANAGER')` |

So a cashier and a captain are both *shown* an authority neither can exercise,
and the route that would exercise it consults a role list that does not consult
the action.

### Why it was not "fixed"

The obvious fix — `requireAction('order.item.void')` on that route — is not a
wiring change. It is a **grant**, and of the most revenue-sensitive kind:

- Voiding a **sent** line removes food the kitchen has already cooked from a
  bill. It is the classic till-shrinkage path, which is exactly why the route
  also takes an `approval` body and writes a required audit row.
- The action sits in CASHIER's baseline and is **not** in `DEFAULT_OFF`, so
  wiring it would switch the authority on for **every existing cashier in every
  tenant, silently, on upgrade**. No tenant would be asked; no screen would
  change; the first anyone would learn of it is in a stock variance.
- The counterpart route already exists and is correct:
  `DELETE /orders/:id/items/:itemId` removes an **unsent** line and is open to
  anyone holding `order.create`. Measured: it answers **409** on a line that
  carries a `kotId` ("Line is already sent to the kitchen; void it instead").
  So the captain can fix a mistake before it reaches the kitchen and cannot
  erase food after. That is a coherent policy, not an accident.

The mismatch is therefore **in the declaration, not in the gate**. Two ways to
close it honestly, both of which are somebody else's call:

1. **Remove `order.item.void` from the CASHIER and CAPTAIN baselines** and leave
   it in BRANCH_MANAGER / REGIONAL_MANAGER. The screen then tells the truth and
   nobody gains anything. This is the conservative option and my recommendation.
2. **Wire the action AND add it to `DEFAULT_OFF` for CASHIER and CAPTAIN**, so
   the authority exists, ships off, and a tenant turns it on per store or per
   user with a PermissionRule. This is the richer option and is a product
   decision about whether the feature is wanted at all.

Either way it is a decision with money attached, so it is written down here
instead of being made quietly inside a refactor. Asserted as it stands in
`tests/captainWorkflow.test.js`:
`'a CASHIER holds order.item.void in its baseline and is still refused the route'`.

### It is not the only one — 15 keys, measured

`lib/permissions.js` states in its own header:

> An action listed here is enforced somewhere; there is no aspirational entry,
> because a permission screen that offers a toggle which changes nothing is a lie
> told to whoever sets it.

That claim is **false for 15 of 68 keys**. It could not be checked before,
because a gate built through a helper (`till('order.bill')`) or from a table has
the action as a *variable* at the call site, so no grep can see it — and a
substring search matches the action name in a *comment* and reports a dead key
as live. (My own first pass did exactly that and returned "0 dead keys".)

`requireAction` now tags its handler with `.posAction`, so the enforcement map
is obtained by walking the mounted router stack. Measured on this candidate:

```
declared ACTION_KEYS      : 68
mounted on a requireAction: 52
enforced in a handler body:  1   (drawer.open.manual, routes/drawer.js:382)
DECLARED, NEVER ENFORCED  : 15
```

That measurement is now a **test, not a number in a document**:
`backend/tests/permissionsCoverage.test.js` (6 assertions, green). It walks the
mounted stack on every run and holds the ungated set to an explicit ledger with a
reason per key, so the count above cannot rot:

- a **new** dead key fails the build — somebody must gate it or justify it;
- **wiring one up** also fails the build, deliberately, so the person who closes
  `order.item.void` has to come back to §2 and say so;
- a gate naming an **undeclared** action fails too. That one is a silent outage:
  `can()` finds the key in no baseline, so the route is dead for everybody
  including the owner.

It also guards its own instrument — it asserts the walk found >40 gates, because
an Express upgrade that moves `app._router` would otherwise walk an empty stack
and report perfect coverage.

| Key | What actually gates the route today |
|---|---|
| `order.item.void` | `requireRole('CUSTOMER_OWNER','BRANCH_MANAGER')` — §2 above |
| `order.void` | same |
| `refund.issue` | same |
| `order.read`, `kot.read` | reachable via `order.create`/`table.read` holders; no read-only gate exists |
| `catalog.read`, `catalog.write` | `routes/catalog.js` — `requireRole('POS_SUPER_ADMIN','CUSTOMER_OWNER')` |
| `report.sales.read`, `report.tax.read`, `report.audit.read`, `report.payments.read`, `report.inventory.read` | `routes/reports.js` — four different `requireRole` lists |
| `dayclose.read`, `dayclose.perform` | role lists |
| `platform.tenant.manage` | `requireAtc` |

**Out of scope for W3 and left alone.** Moving `reports.js` or `catalog.js` onto
the action model would widen access for FINANCE and AUDITOR the same way this
change widens it for REGIONAL_MANAGER (§5) — a policy decision per router, and
14 routers still carry a `requireRole`. This table is the backlog, not a defect
list.

## 3. What changed

`requireRole(...)` replaced by the action model on the till and QR routes:

```js
// orders.js
const till = (action) => [requireUsableLicense, denyPlatformSelling, requireAction(action)];
const takeOrder     = till('order.create');    // open, add, patch, delete draft, KOT, print-events
const issueBill     = till('order.bill');
const collect       = till('payment.record');   // payments, intents, handoff, terminal
const changeDiscount = till('order.create');    // the ENGINE decides the money — §4
const managerUp = [requireRole('CUSTOMER_OWNER','BRANCH_MANAGER'), requireUsableLicense]; // UNCHANGED, 5 routes

// tableQr.js
const canManage  = [requireUsableLicense, denyPlatformSelling, requireAction('table.write')];
const canOperate = [requireUsableLicense, denyPlatformSelling, requireAction('order.create')];
const canRead    = [requireAction('table.read')];
```

Two guards had to be added with it. Neither is optional, and a straight swap
without them would have been a security regression, not a fix.

### 3a. `denyPlatformSelling` — the ATC fence, stated instead of implied

`ROLE_ACTIONS.POS_SUPER_ADMIN` is `[...ACTION_KEYS]` — **every action there is**
— and `order.create`, `order.bill` and `payment.record` are **not** in
`SUPPORT_GRANT_REQUIRED`. The only thing that had ever kept a VEXO operator off
a customer's till was the fact that the old role list never named the role. An
action gate alone would therefore have **handed a platform operator a working
till**, which is the one widening the assignment forbade outright.

So it is now a rule rather than an omission, in `middleware/rbac.js`:

```js
export const denyPlatformSelling = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'POS_SUPER_ADMIN') {
    return next(forbidden('VEXO administrators cannot trade on a customer till. Use a store login.'));
  }
  return next();
};
```

`lib/discountPolicy.js` already asserted the same invariant from the money side
(`ROLE_FLOOR.POS_SUPER_ADMIN = DENY`, "ATC operators are read-only on orders
anyway"). This is that invariant made enforceable on the request path.

### 3b. `branchInScope` — because CAPTAIN is pinned in one model and not the other

| | |
|---|---|
| `lib/permissions.js` `STORE_PINNED_ROLES` | includes CAPTAIN |
| `middleware/auth.js` `BRANCH_PINNED_ROLES` | **does not** |

So `branchIdFilterFor(captain)` is `{}` — the legacy pinning does not constrain
this role at all. Enabling `order.create` without a scope check would have let
any captain open, read and modify orders **at every store in the tenant** just
by naming a branch id. `orders.js` now checks `req.perm.scope` itself, in
`loadOrder` and in `POST /`, and answers **404** rather than 403 so the reply
cannot be used to map somebody else's estate. `tableQr.js` takes
`scopedBranchIdWhere(req)` alongside the legacy filter in an explicit `AND` —
two `where` objects each carrying `branchId` would have had the second silently
overwrite the first.

## 4. What a CAPTAIN can and cannot do now

Positive journey, asserted over HTTP against a real database in
`tests/captainWorkflow.test.js` →
`'the captain journey, end to end: store, table, order, guest basket, KOT'`:

| Step | Result | How it is proved |
|---|---|---|
| Select an authorised store | implicit | the captain sends **no** `branchId`; the scope names the one store. A captain cannot pick the wrong store because a captain does not pick |
| Open a dine-in order on a table | **201** | the `Order` row is read back, `branchId` asserted, `records().orders` incremented |
| Add / change / remove a draft line | **200** | `orderItem.qty` read back as 3; the deleted row read back as `null` |
| Send it to the kitchen | **201** | `kot.count` +1 and the line's `kotId` non-null |
| Accept a guest QR basket | **200** | the submission is listed in the captain's inbox first, then accepted; `kotId` returned, `kot.count` 0→1, submission `ACCEPTED` |
| Read the order, tickets and floor | **200** | unchanged behaviour |

Negative authorisation, same file, measured **in the captain's own store** so
that the refusal is about authority and not about scope — run against another
store's order these would answer 404 and prove nothing:

| Attempt | Answer | Where the refusal comes from |
|---|---|---|
| `POST /orders/:id/bill` | **403** | `order.bill` not in CAPTAIN's baseline |
| `POST /orders/:id/payments` | **403** | `payment.record` not in baseline |
| `POST /orders/:id/refunds` | **403** | `managerUp`, unchanged |
| `POST /orders/:id/discount` | **403** `POS_DISCOUNT_NOT_PERMITTED` | passed the route gate, refused by the money engine — see below |
| `POST /orders/:id/items/:itemId/void` on a **sent** line | **403** | `managerUp`, unchanged (§2) |
| `DELETE /orders/:id/items/:itemId` on a **sent** line | **409** | the draft-line route is not a back door |
| Open an order at a store outside scope | **404** | `branchInScope` |
| Read/modify/KOT another store's order | **404** | `branchInScope` in `loadOrder` |

Every one of those also asserts `records()` is unchanged — status **and** the
absence of the row. A gate that answers 403 after writing is worse than one that
answers 200, because nothing on any screen will ever show it.

### The discount answer is 403 from the ENGINE, and that is the design

The discount routes are gated `order.create`, which a captain **holds**, so a
captain gets past the route gate and is refused by `guardDiscountChange`
instead. That is correct and deliberate: discount authority is **not** an action
key. It has its own resolver (`DiscountPolicy`, COMPANY→BRANCH→USER, with money
ceilings), and `ROLE_FLOOR[role] ?? DENY` means a role absent from `ROLE_FLOOR`
— CAPTAIN is absent — resolves to `DENY` with `maxPctMilli: 0`.

This is what "unless that action is explicitly authorised" looks like in
practice: a tenant grants a captain discount authority by writing them a
`DiscountPolicy` row on purpose, with a ceiling and an approval path. The test
asserts the **error code**, not just the status, because that is the only thing
that distinguishes "the route refused" from "the money engine refused".

### The money actions cannot be granted by a toggle, and that is asserted

`can()` consults `baselineAllows` **before** any `PermissionRule` row, so an
`ALLOW` rule can only restore what a `DENY` took away. A COMPANY-level ALLOW on
`order.bill` for a CAPTAIN is **inert**. Asserted directly, so nobody ships that
toggle believing it does something:

```js
for (const action of ['order.bill', 'payment.record', 'refund.issue', 'order.void']) {
  expect(baselineAllows('CAPTAIN', action)).toBe(false);
  expect(can({ role: 'CAPTAIN', resolved: new Map([[action, { effect: 'ALLOW' }]]) }, action)).toBe(false);
}
```

Giving a captain the till is a **role change or a different login**, never a
permission toggle.

## 5. The behaviour change Window 1 must accept or reject

Honouring the permission model means honouring it for every role that holds the
action, not only for CAPTAIN. Measured with `ROLES` × `baselineAllows` ×
`isDefaultOff` (`/tmp/w3-role-delta.mjs`):

| Role | order.create | order.bill | payment.record | table.read | table.write |
|---|---|---|---|---|---|
| POS_SUPER_ADMIN | **DENY (fence)** | **DENY (fence)** | **DENY (fence)** | **DENY (fence)** | **DENY (fence)** |
| CUSTOMER_OWNER | yes | yes | yes | yes | yes |
| COMPANY_ADMIN | **gained** | **gained** | **gained** | yes | yes |
| REGIONAL_MANAGER | **gained** | **gained** | **gained** | yes | yes |
| BRANCH_MANAGER | yes | yes | yes | yes | yes |
| CASHIER | yes | yes | yes | yes | no |
| CAPTAIN | **gained** | no | no | **gained** | no |
| KITCHEN / INVENTORY / PURCHASE / FINANCE | no | no | no | no | no |
| DELIVERY / AUDITOR | no | no | no | **gained (read)** | no |

The old list was `CUSTOMER_OWNER, BRANCH_MANAGER, CASHIER` and nobody else,
ever. So besides the intended CAPTAIN grant:

- **COMPANY_ADMIN and REGIONAL_MANAGER gain the till** — order-taking, billing
  and taking money. They hold all three actions in their baselines and were
  excluded only because the role list omitted them. REGIONAL_MANAGER is
  scope-limited to its region by `storeScopeFor`; COMPANY_ADMIN is tenant-wide.
- **DELIVERY and AUDITOR gain `table.read`** — read-only QR/table reads.
- **POS_SUPER_ADMIN loses nothing it had**, and is now refused by a stated rule
  rather than by an omission.

This is the model being obeyed rather than a decision I made, and a tenant that
disagrees has a real lever: a COMPANY-level `DENY` PermissionRule is **hard** and
no ALLOW can undo it. But it is a widening for two roles and **Window 1 should
accept or reject it explicitly.** If it is rejected, the narrow fix is to add
`order.bill` and `payment.record` to `DEFAULT_OFF` for COMPANY_ADMIN and
REGIONAL_MANAGER — soft, per-tenant reversible, and it leaves the CAPTAIN fix
intact.

## 6. Table states: text as well as colour

`frontend/src/lib/tableState.js` already carries a text `label` for every state,
and the three the requirement names are distinct in words, not only in colour:

| State | Label |
|---|---|
| FREE | `Free` |
| SEATED | `Seated` |
| ORDERING | `Order waiting` |
| **IN_KITCHEN** | **`In kitchen`** |
| **SERVED** | **`Served`** |
| BILLED | `Billed` |
| **PAID** | **`Paid · clear table`** |

Two distinctions matter and both hold:

- **READY is not SERVED.** A station marking an item READY means it is cooked,
  not carried. `tableStateOf` keeps the table `IN_KITCHEN` until every routed
  line is SERVED — including the mixed case where one line is served and another
  is still on the pass. A plan that turned green there would tell a manager the
  party had been looked after when nobody had walked over.
- **PAID is not FREE.** Settling does not clear a table; the party is still
  sitting there. PAID says `clear table` out loud, and `tableStateMeta` falls
  back to `UNKNOWN`, never to FREE, so a partial read cannot seat a party onto
  occupied chairs.

`tableStateOf` also **throws** rather than answering FREE when handed a row read
without `TABLE_STATE_INCLUDE` — a missing include and an idle table both look
like "no rows", and answering FREE for the first is the dangerous one.

Asserted from both sides: `tests/captainWorkflow.test.js` →
`'what a table is doing: every state, and the two that must not merge'` derives
every state from the database, and the lane browser harness checks the rendered
words on the real floor screen (§7).

### Known gap, not mine to fix: a table with no visit reads FREE the instant it is paid

`DiningVisit` is created in exactly one place — `openOrJoinVisit` in
`lib/qr/visits.js`, which needs a scanned card — and `orders.js` never sets
`Order.visitId`. So on a floor run from the handheld **with no guest scans**
there is no visit, the settled order drops out of the OPEN/BILLED include, and
the table reads FREE the moment the money lands. Recorded as
`WINDOW-5-BACKEND-REQUEST.md` §7 and asserted as it stands
(`'GAP: with no visit, paying frees the table immediately'`). It is **not** a
defect in `tableStateOf`: the evidence it needs was never written. The fix is for
`orders.js` to open a staff visit when a dine-in order is opened without one,
which changes floor semantics for every non-QR restaurant and is a product
decision, not a gate fix.

## 7. Evidence

All of it on a database **nobody else touches**: `vcx_experience_w3_test`, via
`~/vcx-experience-local/w3test.sh`. A peer window was mid-certification in
`vcx_experience_test` at the time, the suite's advisory lock is per-database, and
every file here truncates tenant tables — so sharing it would have meant queueing
behind a 50-minute run or corrupting it.

| What | Command | Result |
|---|---|---|
| Focused backend, W3 scope | `./w3test.sh tests/tableQr.test.js tests/floorplan.test.js tests/kitchen.test.js tests/captainWorkflow.test.js tests/permissionsCoverage.test.js` | **142 passed / 142, 0 skipped** (05:53Z) |
| — `captainWorkflow.test.js` | | 35/35 — journey, scope, money refusals, states |
| — `tableQr.test.js` | | 74/74 |
| — `kitchen.test.js` / `floorplan.test.js` | | 11/11, 16/16 |
| — `permissionsCoverage.test.js` | | 6/6 — the enforcement map, §2 |
| Live HTTP, real server | `bash ~/vcx-experience-local/captain-reach.sh` | captain **201** order, **200** add-line, **201** KOT; discount/bill/payment **403**; order unchanged `OPEN/189.00`; cashier control **201** |
| Browser, routed screens | `./vcxe accept staff` | **45 passed / 0 failed**, exit 0 (05:57Z) — incl. new section D driving the CAPTAIN through `/captain` |
| Enforcement map (one-off) | `/tmp/w3-action-map.mjs` | superseded by `permissionsCoverage.test.js` |
| Role delta | `/tmp/w3-role-delta.mjs` | §5 table |
| Full gate | see §8 | |

Logs kept at `~/vcx-experience-local/evidence/w3-20260926/`
(`captain-reach.log`, `staff-browser-postfix.log`).

The 15 console `401`s in the browser log are all `GET /api/auth/me` on page load
before a token exists — role-independent and pre-existing. Not a finding.

### Two harness defects found by running it, both of which faked a result

Worth recording because each one produced a *confident wrong answer*, which is
more dangerous than a crash:

1. **`captain-reach.sh` asserted `expect 0` orders on the captain's table.** True
   only while the captain was refused — it proved nothing had been written behind
   a 403. After the fix the correct count is 1, so the probe reported the fix as a
   failure. Flipped, with the reason in the file. It also sent
   `{"items":[…]}` to `POST /orders/:id/items`, which takes a single line at the
   top level, and drew a `400 productId: Required` that reads exactly like a
   refusal in a column of status codes. The add-line step of the journey had
   therefore never been measured at all.
2. **`captainWorkflow.test.js` collided with its own fixture.** The captain
   journey asked for a table the cashier journey above it opens and never settles,
   so it drew `409 POS_CONFLICT — Table "T1" already has an open order` and three
   later tests died on `undefined`. The app was right every time: a 409 about an
   occupied table says nothing about a role. Fixed by giving every block that
   opens an order its own table, and by deleting a cashier-then-owner fallback in
   the money block whose fixture author depended on which arm answered first.

Both are the same failure in different clothes — an assertion that passes or fails
for a reason other than the one it names.

**The browser harness had to be corrected, and the correction matters.**
`browser-acceptance.mjs` asserted `POST /api/orders as CAPTAIN is still refused
by the backend → 403` and **passed** on it. That expectation was right about the
code and wrong about the product; re-run against the fixed backend it would have
reported two FAILs for behaviour that is now correct. The expectations are
flipped to 201/200, the order row and its `branchId` are now asserted, and the
bill/payment refusals were added beside them so the section proves both halves.

It also carries the trap that produced the confusion: **the backend has no hot
reload.** A browser run against an API process started before the fix answers
403 and the FAIL is the stale server, not the code. The peer run at 05:20:43Z on
2026-09-26 is exactly that — its two §1/§2 PASSes were measured against a server
started before 05:14Z and describe the pre-fix build.

## 8. Verdict

Filled in by §9 of the handoff once the pinned full gate has run. Nothing in
this document should be read as "the POS release is complete" — it covers four
files and the Captain journey, and §2 and §5 are both open questions for Window 1.
