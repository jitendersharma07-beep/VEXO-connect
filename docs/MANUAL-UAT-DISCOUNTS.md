# Manual UAT — discount permissions, by hand

For when `deploy/render-discount-screens.mjs` cannot be run. Same ground, same
evidence standard: **drive the screen, then read the effect out of the
database.** A prompt that closes is not proof that a discount was approved, and
a discount on screen is not proof of who allowed it.

One person, one browser, about fifteen minutes.

The automated harness covers this sequence step for step, and since the
`phase2-integration` merge it goes further than this document does: the till in
the un-configured state, the approval not carrying to the next customer, a
manager's own delegated ceiling, a 100% discount, the rupee cap as a limit
separate from the percentage, a line removal re-opening an already-allowed
discount, and a sweep proving the typed password reached neither the audit
trail nor the server log. If script execution is available, run that instead —
it checks the database after every step, which by hand is the part most likely
to get skipped.

---

## What this is testing, and what it is not

`backend/tests/discountSettings.test.js` and `backend/tests/discounts.test.js`
already prove the **rules**: 80 tests across the two files as measured on
2026-09-23 (50 + 30), covering allowed, denied, above-limit, cross-branch,
cross-tenant, and the approval throttle. Those run on every suite and they do
not need a browser. Re-count before quoting this number rather than copying it
forward — it was wrong by 24 the last time somebody did.

What a browser adds, and the only reason this document exists, is the part a
unit test cannot see:

- the settings screen is **reachable** and the owner's typing **arrives**
- the till **tells a cashier their limit before they type a number**
- a refusal **opens a prompt** instead of dead-ending at the counter
- the prompt **stays open** on a bad approval instead of re-asking by itself

---

## Before you start

**Do not run this on production.** It writes discount policy rows and creates
orders. Use a dev stack pointed at a database whose name ends in `_test`.

Seed the fixture (two companies, two branches, a manager in each):

```sh
node deploy/seed-discount-render.mjs     # reads /tmp/discount-render.env
```

That file is mode 600 and holds `DATABASE_URL`, `POS_JWT_SECRET` and
`RENDER_PASSWORD`. The fixture password is generated, never typed into this
repo, and never printed. If you are creating the file by hand, generate it —
do not reuse a real password.

The fixture deliberately starts with **nothing configured**: no company
default, no branch override, no staff grant. That is the state a company is in
on the day it is handed the product, and step 1 depends on it.

| Account | Role | Branch |
|---|---|---|
| `owner.f@test.local` | `CUSTOMER_OWNER` | — |
| `mgr.f1@test.local` | `BRANCH_MANAGER` | Foxtrot One |
| `mgr.f2@test.local` | `BRANCH_MANAGER` | Foxtrot Two |
| `cashier.f1@test.local` | `CASHIER` | Foxtrot One |

---

## 1 · The unconfigured company (cashiers default to nothing)

Sign in as **owner.f@**. Open **Discounts** in the left nav.

- [ ] The screen loads, titled *Discount permissions*.
- [ ] It says: *"Until this is set, only the owner may discount anything."*
- [ ] Both branches are listed under **Branch overrides**.
- [ ] Every cashier's **May give** column reads `No discounts`.

```sql
SELECT count(*) FROM "DiscountPolicy";   -- expect 0
```

> The point of this step is that the safe state is the **shipped** state. No
> cashier has a discount ceiling because none was ever configured — not
> because a default was chosen for them.

## 2 · Company default — 10%

Edit **Everyone, unless overridden below**. Set *Discount on a single item* =
Yes, *Discount on the whole order* = Yes, *Maximum % of the bill* = `10`.
Leave **Maximum amount (₹) blank.** Save.

- [ ] Saves without error; the card now summarises the setting.
- [ ] The **Company default** figure reads `10%` — not `0%`.

```sql
SELECT "maxPercent", "maxFlatPaise" FROM "DiscountPolicy"
WHERE "branchId" IS NULL AND "userId" IS NULL;
-- expect 10.000 | (blank)     <-- blank means NULL, not 0
```

> `maxFlatPaise` **must be NULL**. A blank amount box beside a filled percent
> box is not a ceiling of zero; if it stores as `0` the company can give
> nothing at all. In `psql` a NULL prints as an empty field; run with `\pset
> null '<NULL>'` first if you want to see the difference from an empty string
> at a glance, because that distinction is the whole point of this step.

> **The stored column is `maxPercent`, a `Decimal(6,3)` holding a percent —
> `10.000`, not `10000`.** `maxPctMilli` is the integer milli-percent the
> resolver hands the till *after* merging the three levels; it is not a column
> and does not exist on a row. Earlier drafts of this document queried it.
> That is worse than a typo: `SELECT "maxPctMilli"` errors, which at least
> announces itself, but the same mistake made through Prisma returns
> `undefined` and compares unequal to every expected value — a check that can
> never pass for the right reason, and never fail for the right reason either.

## 3 · Branch override — Foxtrot Two only

Edit **Foxtrot Two**. Set *Maximum % of the bill* = `20`. Save.

- [ ] Foxtrot Two shows the override; **Foxtrot One still shows *Not set***.

```sql
SELECT b.code, p."maxPercent" FROM "DiscountPolicy" p
JOIN "Branch" b ON b.id = p."branchId" WHERE p."userId" IS NULL;
-- expect exactly one row: F2 | 20.000
```

## 4 · Staff grant — Manager F1 may approve to 50%

Edit **Manager F1**. Set *May approve above-limit discounts* = Yes and
*Maximum % they may approve* = `50`. Leave *Maximum % of the bill* on
**Inherit**. Save. Do the same for **Manager F2**.

- [ ] Manager F1's **May approve up to** column now reads `50%`.
- [ ] Manager F1's **May give** column still reads `10%` — the company default.

```sql
SELECT u.email, p."canApprove", p."maxApprovalPercent", p."maxPercent"
FROM "DiscountPolicy" p JOIN "PosUser" u ON u.id = p."userId";
-- mgr.f1: t | 50.000 | (blank)   <-- blank/NULL: approving for others
-- mgr.f2: t | 50.000 | (blank)       did not raise their own limit
```

## 5 · The till states the limit before a number is typed

Sign out. Sign in as **cashier.f1@**. Open **Sell**, add a **Filter Coffee**,
then open the order discount.

- [ ] The modal says: *"Your limit is 10%, counting item and order discounts
      together. Above that, a manager can approve it."*

> `10%` is inherited — nobody set anything on this cashier or their branch.
> Combined item-and-order wording matters: the two are measured as one figure
> against the gross, which is what stops 50% off a line plus 50% off the order
> becoming 75% off the bill.

## 6 · ALLOWED — 10%

Choose **% Percent**, enter `10`, **Apply discount**.

- [ ] Applies. **No approval prompt appears.**

```sql
SELECT "discountValue", "discountApprovedById" FROM "Order"
ORDER BY "createdAt" DESC LIMIT 1;    -- expect 10.00 | NULL
```

## 7 · ABOVE LIMIT — 11% opens the prompt

Open the order discount again, **% Percent**, `11`, **Apply discount**.

- [ ] A modal appears: *"A manager needs to approve this"*.
- [ ] It asks for the **approver's own** email and password, and a reason.
- [ ] It warns: *"Do not enter someone else's password on their behalf."*

```sql
SELECT "discountValue" FROM "Order" ORDER BY "createdAt" DESC LIMIT 1;
-- still 10.00 — nothing moves while the prompt is open
```

## 8 · CROSS BRANCH — the wrong manager is turned away

In that prompt enter **mgr.f2@test.local**, their real password, and a reason.
Approve.

- [ ] Refused. The prompt **stays open** and says why.
- [ ] It does **not** retry by itself. Nothing happens until you press Approve.

```sql
SELECT "discountValue", "discountApprovedById" FROM "Order"
ORDER BY "createdAt" DESC LIMIT 1;    -- still 10.00 | NULL
```

> Manager F2 is a real manager with a real 50% approval ceiling and a correct
> password. They are refused purely because the till belongs to Foxtrot One.
> This is the case that distinguishes a branch check from a role check — if it
> passes, branch scoping is not being enforced.

## 9 · APPROVED — the right manager, within their delegation

In the same prompt enter **mgr.f1@test.local**, their password, reason
`Spillage, comped by manager`. Approve.

- [ ] Accepted. The prompt closes and the bill shows 11%.

```sql
SELECT o."discountValue", u.email AS approver, o."discountReason",
       o."discountApprovedAt" IS NOT NULL AS stamped
FROM "Order" o LEFT JOIN "PosUser" u ON u.id = o."discountApprovedById"
ORDER BY o."createdAt" DESC LIMIT 1;
-- expect 11.00 | mgr.f1@test.local | Spillage, comped by manager | t
```

```sql
SELECT "action", "actorId", "branchId", "meta" FROM "PosAuditLog"
WHERE "action" LIKE '%DISCOUNT%' ORDER BY "at" DESC LIMIT 5;
```

- [ ] The actor is the **cashier**, and the approver is recorded **separately**
      in `meta` — one row naming both, not one row naming whoever "did it".
- [ ] `branchId` is Foxtrot One.
- [ ] `meta` carries the before/after amounts and the ceiling that was in force
      at the time.

> The before/after pair and the recorded ceiling are what let this be read back
> months later, after the policy row has been edited. Without them the trail
> answers "was it blocked?" but not "was that inside what the cashier was
> trusted with *then*?".

## 10 · Over even the approver's ceiling

Try `60` and approve as **mgr.f1@**.

- [ ] Refused — 60% is above Manager F1's own 50% approval ceiling.

> A delegated ceiling that the delegate can exceed is not a ceiling. This is
> the negative control for step 9: without it, step 9 only proves that *some*
> password was accepted.

---

## Recording the result

Write down PASS/FAIL per numbered step and the SQL you actually saw. A step
without its query result is **NOT VERIFIED**, not PASS — the screen and the
table disagreeing is the whole class of defect this is looking for.

**Do not record a physical printer result here.** Nothing above touches a
printer.
