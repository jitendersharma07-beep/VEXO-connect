# Demo invoices 00009 and 00011 — correction proposal

Two orders on the demo company carry a false picture of what happened. Both are
**probe residue from release testing**, not customer trade. This is a proposal:
nothing has been executed against production, and the choice in §4 is the
owner's.

Constraint this proposal is built to satisfy: **no payment or audit row is
deleted, and no total is silently altered.** Every step below is an existing,
role-gated, audited API route. No SQL touches the live database.

---

## 1. What is actually wrong

Read from `pos-prod-postgres-1` 2026-09-23 06:22Z. Both are on **Brew Street
Café — Connaught Place**, which has **no day close filed** — the only filed
close is Cyber Hub / 2026-09-23, so neither correction disturbs a closed day.

**`BSC-CP/26-27/00009` — a bill nobody ever paid.**

| | |
|---|---|
| Status | `BILLED`, billed 03:40:27 |
| Total | ₹94.50 (1 × Masala Chai @ 90.00 + 4.50 tax) |
| Collected | **₹0.00**, no payment rows |
| Audit | `ORDER_CREATE`, `ORDER_BILL` |

Harmless in money terms but it sits in the list as an open unpaid bill forever.

**`BSC-CP/26-27/00011` — one tender recorded twice.**

| | |
|---|---|
| Status | `PAID` |
| Total | ₹94.50 |
| Payments | **two** `CARD`/`MANUAL` rows of ₹47.25, at 03:43:09.259 and 03:43:10.474 |
| Audit | `ORDER_CREATE`, `ORDER_BILL`, `ORDER_PAYMENT` ×2 |

This is the defect `3ecfa29` fixes, caught in the act. A ₹47.25 partial payment
was recorded, the response was lost after the server had committed, the operator
pressed *Record payment* again, and the ₹94.50 bill came out `PAID` on two rows
1.2 s apart for **one** tender. The till believes it holds ₹94.50; ₹47.25 of
that was never taken.

## 2. What the product actually allows

Rehearsed against the real routes on the release stack, reproducing both shapes
— **20 PASS / 0 FAIL**, `/home/atc-noc/pos-release-v101/backup/rehearse-demo-correction.mjs`.
This is observed behaviour, not a reading of the source:

| Attempt | Result |
|---|---|
| Void a `BILLED` order with nothing collected | **200** → `VOID`, reason stored, total untouched, `ORDER_VOID` audited |
| Void a `PAID` order | **409** `Only open or billed orders can be voided` |
| Refund **half** of a two-payment order | **201**, `MANUAL`/`SUCCEEDED`, settles at once |
| …and the order afterwards | **stays `PAID`** — net collected is now half the total |
| Void it now | **409** — still not `OPEN`/`BILLED` |
| Refund the remaining half | **201** → order moves to `REFUNDED` by itself |
| Void a `REFUNDED` order | **409** |

Three consequences follow, and they shape everything below:

1. **There is no route from `PAID` back to `BILLED`.** Nothing in the product
   can restore 00011 to "₹47.25 collected, ₹47.25 still due".
2. **A partial refund does not change the order status.** Only a refund that
   settles the *whole* collected amount moves it to `REFUNDED`.
3. **Void requires net collected to be exactly zero** *and* status `OPEN` or
   `BILLED`, so on 00011 it is unreachable by any sequence.

The rehearsal also confirms the constraint holds throughout: payment rows
survive at full value and are reversed by refunds rather than edited, order
totals are never written, and every step lands on the audit trail
(`ORDER_CREATE + ORDER_BILL + ORDER_PAYMENT + ORDER_PAYMENT + ORDER_REFUND + ORDER_REFUND`).

## 3. Proposal

### 00009 — void it. One action, no ambiguity.

```
POST /api/orders/<id>/void          (BRANCH_MANAGER or above)
  { "reason": "UAT probe residue: billed during release testing, never tendered" }
```

End state: `VOID`, reason and actor stored, total still ₹94.50, `ORDER_VOID` on
the audit trail. Nothing is deleted. This is the designed route for exactly this
situation and there is no reason to prefer anything else.

### 00011 — two defensible end states; pick one

**Option A — reverse only the duplicate.** One refund of ₹47.25:

```
POST /api/orders/<id>/refunds
  { "amount": 47.25,
    "reason": "Reverses a duplicate payment record created by a lost response; no second tender was taken" }
```

End state: total ₹94.50, collected ₹94.50, refunded ₹47.25, **net ₹47.25**,
status stays `PAID`.

- Most faithful to events: it says the shop kept one genuine ₹47.25 tender.
- The wart: the order reads `PAID` while only half the bill is actually held.
  Per §2.1 there is no supported way to fix that, and it must not be fixed by
  writing to the database.

**Option B — unwind the order completely.** Two refunds of ₹47.25:

```
POST /api/orders/<id>/refunds  { "amount": 47.25, "reason": "Reverses a duplicate payment record created by a lost response" }
POST /api/orders/<id>/refunds  { "amount": 47.25, "reason": "Unwinds the remaining tender; demo order retained no money" }
```

End state: **net ₹0.00**, status `REFUNDED`, both payment rows intact, two
refund rows explaining why.

- No order is left claiming to hold money it does not hold, which is what makes
  a demo dataset safe to show a client.
- The cost: the record now says both halves were returned, when really one was
  never taken. The reason strings carry that distinction; the numbers do not.

**Recommended: Option B.** These are demo records, not trade. The reader of a
demo dataset is a prospective client, and "an order marked PAID that holds half
its bill" misleads them in a way that matters, while "fully refunded, with
reasons" does not. Option A is the better choice only if these are ever to be
treated as a real financial record — in which case the residual `PAID` status
should be raised as a product gap rather than absorbed.

## 4. What is deliberately not proposed

- **No `DELETE`, no `UPDATE`, no SQL of any kind against `atc_pos`.** Deleting
  the duplicate payment row would produce a tidier table and destroy the only
  evidence that the defect occurred.
- **No edit to `Order.total`.** The totals are correct; the payments were wrong.
- **No touching 00010 or 00012.** Both are clean (₹94.50 billed, ₹94.50
  collected, one row each) and are not part of this.
- **Not executed.** 00009 and 00011 are live production rows. Awaiting the
  owner's choice between A and B, and the deploy owner's sequencing — running
  these before or after the v1.0.1 deploy makes no difference to the outcome,
  since neither route changed in this release.
