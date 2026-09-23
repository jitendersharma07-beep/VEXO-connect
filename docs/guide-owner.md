# VEXO Connect — owner and manager guide

For the café owner and branch managers. The cashier's one-pager is
`guide-cashier.md`; give them that, not this.

`https://atcworkspace.com/pos`

You will meet three names and they are all the same people. **VEXO Connect**
is the product — it is what the sign-in screen and the footer of every page
say. **VEXO** is who supports it, and is the word this guide uses wherever
something is not yours to do. **ATC Infocom Solutions Pvt. Ltd.** is the
company behind it, which is why the address still reads `atcworkspace.com`.
Nothing changes for you depending on which name you see.

---

## 1. Who can do what

Four roles. The screen hides what a role cannot do, and the server refuses it
again even if someone reaches the address directly — so a bookmark or a typed
URL is not a way around this.

| | Cashier | Branch manager | Owner | VEXO support |
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

**VEXO can read, not act.** VEXO support can see your figures to help you, and is
refused the daily closing outright — a count of your drawer is not VEXO's to
file.

**What is and is not recorded about VEXO, stated plainly.** When VEXO *changes*
something on your account — sets up your company, issues or changes your
licence, adds a branch allowance, creates a user — that is written down with the
name of the person at VEXO who did it, and you can ask for it. When VEXO only
*looks* at your data, that is **not** recorded. So nobody can tell you afterwards
who at VEXO read your sales figures or your staff list, and you should not be
told otherwise. If that matters to you, say so and it can be added.

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
login.** Every discount, void and refund is stored against the person who did
it, and a shared login throws that away permanently — it cannot be reconstructed
later. Read §5 for what you can see on screen today and what has to be asked
for.

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

**Where the sales report stops.** It gives you the *total* discount for the
period and the *count* of voided orders — neither has a card of its own, so you
have to know where to look: the discount total is the small grey line *inside*
the **Tax** card, under the big number, and `voided` is the last item in the
Orders strip beneath the cards. What it does not tell you is **who**.

**Reports → Discounts & voids** answers that. A total is the wrong shape for the
question you will actually want to ask: "₹4,200 of discounts this week" is not
something you can act on; "one cashier gave 40 of the 46" is. So this screen
leads with counts per person, busiest first, with a bar beside each name — you
are meant to see the odd one out without reading the numbers. Underneath is
every individual event: when, who, which bill, and the detail (the discount
given, the reason for a void, the amount refunded).

Four things on that screen are worth knowing:

- **Discounts counts discounts given.** If someone applied a discount and then
  took it off, the removal is counted separately and named beside the number —
  "45 · 1 later removed" — never added into it. A correction is not a discount.
- **Refunds shows every stage**, manual and gateway. A gateway refund is tagged
  `provider confirmed` or `not confirmed`. That distinction is the subject of
  §10 and it is not cosmetic.
- **A manager sees their own branch only.** You see all of them, or one at a
  time from the Branch box.
- **The counts are a minimum, not a guaranteed total.** Recording is deliberately
  best-effort — a logging fault can never block a customer's bill, which is the
  right trade, but it means a number here can in principle be short. It will
  never be inflated.

Worth opening the first time a discount or void total looks higher than you
expected, rather than waiting for a pattern to become obvious.

---

## 6. Licence

**Licence** shows your plan, expiry and how many branches you may open.

- **Free trial** — full features, fixed end date.
- **Single store** — one branch.
- **Multi store** — several; additional branches are added by VEXO.

**When a licence expires, billing stops.** Staff can still sign in and read, but
no new orders, bills or payments. Expiry is worked out fresh every time, so it
cannot be missed by a background job that failed to run — and equally, it cannot
be postponed by anything except VEXO extending it.

Your current licence expires on the date shown on that screen. **Ask VEXO to
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

### Kitchen tickets and the second printer

Kitchen tickets are laid out separately — ticket number, table, time, item
names and quantities, **no prices** — but read this before assuming they route
themselves.

**Automatic routing is not built.** VEXO Connect does not know your printers
exist. Receipt and kitchen ticket both open the same browser print dialog, and
neither carries any instruction about which machine should receive it. There is
no screen for assigning a counter printer and a kitchen printer, and nothing
stored against your branch that says which is which. If you were told the
system sends KOTs to the kitchen on its own, that is not the case today.

**Choosing a printer by hand does work**, and it is a different thing. The
browser's dialog lists every printer installed on that device, so whoever is at
the till can pick the kitchen printer for a KOT and the counter printer for a
receipt, one print at a time. It is a real capability, not a placeholder — it
is simply manual, and it depends on a person choosing correctly every time.

Two consequences worth knowing before opening day:

- **Do not tick "do not ask again"** on a till that prints both. That box
  suppresses the dialog, and suppressing the dialog is exactly what removes the
  choice — every job then silently goes to that device's default printer.
  One keypress per print and one printer, or the dialog and both printers; you
  cannot have both on the same device.
- **The reliable arrangement is one device per printer.** If the kitchen has
  its own tablet or terminal, set the kitchen printer as *that* device's
  operating-system default and send KOTs from there. Then nobody has to choose,
  because each device only has one answer. This is an arrangement of your
  hardware, not a feature of the software — worth saying plainly, because it
  produces the result people expect from "automatic routing" and it is easy to
  mistake one for the other.

**VEXO has not tested any of this against your printer.** The layout is correct
at 80 mm and prints correctly to PDF at that width, but no physical printer has
been attached, so paper behaviour, cutting and the driver's own margin
handling are **untested**. The first real print is something to do together
before the café opens, not on the first busy morning.

---

## 8. Things to do regularly

| When | What |
|---|---|
| Every day | File the daily closing. Investigate any variance the same day. |
| Every week | Read the sales report. Check voids, refunds and the discount total — a rising number is worth a question, and VEXO can tell you which person it is (§5). |
| Every month | Review who has a login. Remove people who have left. |
| Before expiry | Renew the licence with VEXO. |

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
  up to 100 %. If you want a ceiling above which a manager must approve, ask VEXO
  — it is a small change, but VEXO needs *you* to choose the number.
- **Discount and void history goes back only as far as this system does.** Who
  discounted and who voided *is* now a screen you can open — **Reports →
  Discounts & voids** (§5) — but it reads the log this system has kept since it
  went live. It cannot tell you about anything that happened before that. The
  screen also reads at most 1,000 events per range and says so on screen when it
  hits that; narrow the dates if you see the warning.
- **No phone-sized screen.** Use a tablet, laptop or till monitor. Below about
  768 pixels wide — which is every phone held upright — the menu down the left
  disappears and there is nothing to replace it, so staff can see the page they
  are on and cannot get to any other. It is not a rendering fault and it will
  not look broken; they simply will not be able to navigate. If you want the POS
  on phones, ask VEXO.

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
account and VEXO's configuration. Until then there is no ambiguity about which
payments were verified, because none of them were.

---

## 11. Support

Contact VEXO with: what you were doing, which branch, the invoice number if there
is one, and the time. VEXO support can read your data to diagnose, and every
access is logged.

For backup and recovery, VEXO holds the runbook (`docs/BACKUP-RESTORE.md`). What
you need to know: a backup of this database **has been taken and has been
proven to restore** — not assumed, actually restored into a separate database
and compared row by row, including that every staff login still worked. The
nightly schedule is **switched on**, and runs at about 02:30 each night.

Two things to ask VEXO about, because they are real and they are not fixed:

- The backups sit on the **same machine** as the café's data. That survives a
  bad upgrade. It does not survive losing the machine. Ask VEXO when a copy will
  be kept somewhere else.
- **Nothing tells anyone if a backup fails.** It would simply stop happening,
  quietly. "When was the last successful backup?" is a fair question with a
  one-line answer — ask it before you start billing, and occasionally
  afterwards.
