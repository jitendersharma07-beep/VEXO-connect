# ATC POS — owner and manager guide

For the café owner and branch managers. The cashier's one-pager is
`guide-cashier.md`; give them that, not this.

`https://atcworkspace.com/pos`

---

## 1. Who can do what

Four roles. The screen hides what a role cannot do, and the server refuses it
again even if someone reaches the address directly — so a bookmark or a typed
URL is not a way around this.

| | Cashier | Branch manager | Owner | ATC support |
|---|---|---|---|---|
| Take orders, bill, record payment | ✓ | ✓ | ✓ | — |
| Send KOT, apply discounts | ✓ | ✓ | ✓ | — |
| Void a line already sent to kitchen | — | ✓ | ✓ | — |
| Void an order | — | ✓ | ✓ | — |
| Refunds | — | ✓ | ✓ | — |
| Sales reports | — | ✓ | ✓ | read-only |
| Daily closing | — | ✓ | ✓ | **read-only** |
| Tables | — | ✓ | ✓ | read-only |
| Menu, prices, categories | — | — | ✓ | read-only |
| Staff accounts | — | — | ✓ | ✓ |
| Branches | — | — | ✓ | ✓ |
| Licence | — | — | view | ✓ |

**ATC can read, not act.** ATC support can see your figures to help you, and is
refused the daily closing outright — a count of your drawer is not ATC's to
file. Everything ATC does is written to an audit log you can be shown.

A manager sees their own branch. An owner sees every branch.

---

## 2. First day: setting up

In this order.

**Branches** — name, code, address. The code is the invoice prefix, so
`BSC-CP` gives invoices `BSC-CP-000001`. Pick it once; changing it later leaves
your invoice history in two formats. How many branches you may open is set by
the licence (§6).

**Team** — add each person with their real email, and choose the lowest role
that lets them do their job. The system generates a password, and forces them to
change it the first time they sign in. **Do not create one shared "cashier"
login**: the whole point of the audit trail is knowing who voided the bill.

**Catalog** — categories first, then products.

- Products belong to a category and have a price.
- Sizes and options go on the product as **variants** (Regular / Large), each
  with its own price difference.
- Tax: pick the rate that applies to the item. Two rates are pre-loaded,
  **GST 5%** and **GST 18%**. Your accountant decides which items get which —
  do not guess, and do not assume the demo assignments are right for you.
- Turn a product **unavailable** when you run out. It disappears from the
  cashier's screen and comes back when you turn it on. Do not delete it: deleting
  breaks the history of what was sold.

**Tables** — only if you do dine-in. Name them what the staff call them.

---

## 3. Cancellations and refunds

Three different things. Use the right one.

**Void a line** (manager+) — one item, on an order not yet billed. The kitchen
made the wrong thing, or the customer changed their mind. The line stays on the
record marked voided; it does not vanish.

**Void an order** (manager+) — the whole sale is wrong or abandoned. **An order
with money collected against it cannot be voided until that money is refunded
first.** That is deliberate: a voided order holding a payment is a hole in the
day's cash.

**Refund** (manager+) — money already taken goes back. Cannot exceed what was
collected. Recorded against the original payment, with who did it and when.

Cash refunds come out of the drawer, and the daily closing already accounts for
them — the expected-cash figure subtracts them. You do not need to adjust
anything by hand.

> Refunds and voids are **never** deleted from the record. If you need the
> number to go away, you are looking for a correction, not a delete, and the
> answer is a note explaining it.

---

## 4. Daily closing

**Reports → Daily closing**, at the end of each trading day, by whoever counts
the drawer.

The screen shows what the system thinks is in the till: cash sales, minus cash
refunds, plus the opening float you type. You type what you actually counted.
The variance appears as you type, before you commit anything.

**If the count is off by even one rupee, the system will not accept it without a
note.** This is the single most useful thing in this screen: the moment to
explain a shortfall is while the person who counted is still standing at the
till, not next week when you read the report.

A few things worth knowing:

- It warns you about **open orders** — tables still running. Close them first or
  their cash will not be in the count.
- **Closing does not lock the day.** Sales can still be recorded against that
  date afterwards. If that happens the closing you filed no longer matches, and
  you should file a correction.
- **Corrections, not edits.** Filing again for the same day creates a new record
  that supersedes the old one, and both are kept. The history shows which is
  current.
- Card, UPI and gateway takings are shown for information. They are not part of
  the drawer count.

---

## 5. Reports

**Dashboard** — today at a glance, per branch.

**Reports → Sales** — a date range, per branch or consolidated: what was sold,
how it was paid for, discounts and voids. This is the report to give your
accountant.

Days run on **IST**, midnight to midnight, not on a 24-hour clock from when you
opened. A sale at 00:30 belongs to the new day.

---

## 6. Licence

**Licence** shows your plan, expiry and how many branches you may open.

- **Free trial** — full features, fixed end date.
- **Single store** — one branch.
- **Multi store** — several; additional branches are added by ATC.

**When a licence expires, billing stops.** Staff can still sign in and read, but
no new orders, bills or payments. Expiry is worked out fresh every time, so it
cannot be missed by a background job that failed to run — and equally, it cannot
be postponed by anything except ATC extending it.

Your current licence expires on the date shown on that screen. **Ask ATC to
renew it before that date, not on it.**

---

## 7. Printing

Receipts are 80 mm thermal, printed through the browser.

Set up once per till:

1. Install the printer in Windows/macOS as a normal printer and make it the
   default.
2. Set its paper size to **80 mm roll** in the printer's own settings.
3. In the browser's print dialog: **Margins → None**, **Scale 100 %**,
   **Headers and footers → off**, **Background graphics → on**.
4. Tick "do not ask again" if the browser offers it, so staff get one keypress.

Kitchen tickets print the same way. If the kitchen printer is a different
machine, set it as the default on the device that sends KOTs.

**ATC has not tested this against your printer.** The layout is correct at 80 mm
and prints correctly to PDF at that width; the first real print is something to
do together before the café opens, not on the first busy morning.

---

## 8. Things to do regularly

| When | What |
|---|---|
| Every day | File the daily closing. Investigate any variance the same day. |
| Every week | Read the sales report. Check voids and refunds — a rising count is worth a question. |
| Every month | Review who has a login. Remove people who have left. |
| Before expiry | Renew the licence with ATC. |

---

## 9. What this system does not do yet

Stated plainly so nobody discovers it mid-service:

- **No offline mode.** No internet, no billing. If your connection is unreliable,
  a cheap 4G backup router is the fix, and it is worth more than any feature on
  this list.
- **No inventory or stock.** It does not know you have run out of milk. Mark
  products unavailable by hand.
- **No Zomato or Swiggy.** Online orders are entered by hand as takeaway.
- **No online card/UPI collection.** Card and UPI are recorded from your existing
  machine or QR code. See §10.
- **No customer accounts, loyalty, or table reservations.**
- **No cap on how large a discount a cashier may give.** Any cashier can discount
  up to 100 %. If you want a ceiling above which a manager must approve, ask ATC
  — it is a small change, but ATC needs *you* to choose the number.

---

## 10. Cash, card, UPI — and what "paid" means

Every payment recorded in this system today is **a person saying the money
arrived**. The system did not ask the bank. It is a record, exactly like writing
it in a ledger, with the advantage that it is timestamped and attributed.

That is honest and sufficient for a café taking cash, card on a bank machine, and
UPI on a static QR — which is most cafés. It is worth understanding because it
tells you where to look when the day does not balance: at the machine's own
settlement report, not at this system.

Gateway-verified online payment is built but **switched off**, and your staff
will not see a "Pay online" button at all. Turning it on needs your own merchant
account and ATC's configuration. Until then there is no ambiguity about which
payments were verified, because none of them were.

---

## 11. Support

Contact ATC with: what you were doing, which branch, the invoice number if there
is one, and the time. ATC support can read your data to diagnose, and every
access is logged.

For backup and recovery, ATC holds the runbook (`docs/BACKUP-RESTORE.md`). What
you need to know: a backup of this database **has been taken and has been
proven to restore** — not assumed, actually restored into a separate database
and compared row by row, including that every staff login still worked. The
nightly schedule is **switched on**, and runs at about 02:30 each night.

Two things to ask ATC about, because they are real and they are not fixed:

- The backups sit on the **same machine** as the café's data. That survives a
  bad upgrade. It does not survive losing the machine. Ask ATC when a copy will
  be kept somewhere else.
- **Nothing tells anyone if a backup fails.** It would simply stop happening,
  quietly. "When was the last successful backup?" is a fair question with a
  one-line answer — ask it before you start billing, and occasionally
  afterwards.
