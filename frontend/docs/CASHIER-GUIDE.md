# VEXO Connect — cashier quick guide

For the person at the counter. One page; keep it by the terminal.

## Take an order

1. **Sell** in the sidebar is the till screen. It opens there by default.
2. Pick **Takeaway** or **Dine-in**. Dine-in asks for a table.
3. Tap products to add them. A product marked **opt** has sizes or options —
   tapping it asks which one before adding.
4. Can't see a product? Type in **Search products…**, or use the category
   strip above the grid (swipe it sideways for more categories).

## Change the order

On each cart line:

- **−** and **+** change the quantity. **Bin** removes the line.
- **line disc** applies a discount in rupees to that one line.
- Once a line has been **sent to the kitchen** its quantity locks. The line
  shows `KOT #n` and `Sent to kitchen — qty locked`. Only a manager can void
  a line after that, and it asks for a reason.
- **Discount** in the totals block (the tag icon) discounts the whole order.

## Send food to the kitchen

Tap **Send KOT**. This prints the kitchen ticket for everything not yet sent.
You can send more than once as the table orders more — each gets its own KOT
number. **Reprint KOTs** at the bottom of the panel reprints any of them.

## Take money

1. Tap **Bill**. The order gets its invoice number and locks for editing.
2. Tap **Record payment**.
3. Choose **CASH / CARD / UPI / OTHER**.
   - Cash: type what the customer handed over in **Cash tendered**, or tap
     **Exact**. The change to give back is worked out by the server and shown
     after you record it — do not calculate it yourself.
   - Card/UPI/Other: type the amount received, and use the note field for
     anything useful ("GPay, manual entry").
4. Split payments are fine — record one, then **Record another payment** until
   the balance reaches zero. The panel shows **Balance due** while any remains.
5. Tap **Receipt** to print the customer's bill.

> Every amount on screen comes from the server. If a figure looks wrong, it is
> wrong in the order, not in the display — fix the order, don't work around it.

## What the payment labels mean

Each payment prints a label saying how it was confirmed. They are not
interchangeable and you cannot change them:

- **MANUAL PAYMENT RECORD — not gateway-verified**: a person recorded this.
  The system has no independent proof the money arrived.
- **GATEWAY PAYMENT — confirmed by the provider**: the payment provider
  confirmed it.

## Refunds

- **REFUND REQUESTED — not yet paid out by the provider** means the refund is
  in flight. **The customer has not been paid yet.** It prints without a minus
  sign for exactly that reason. Don't tell the customer the money is back.
- **REFUND HANDED BACK — recorded by staff** means it was settled. It prints
  with a minus sign.

## When something is wrong

- **Red banner about the licence** — the till is read-only. You can look at
  orders but not open new ones or take payments. Call the manager; this is not
  something you can clear at the counter.
- **An error appears when you tap something** — the action did *not* happen.
  Nothing was half-saved. Read the message, fix what it says, try again.
- **Void order** (manager only) cancels a whole order. It is refused while any
  money is still collected on it — refund first, then void.
- **New sale** puts the current order down and starts a fresh one. It does not
  delete anything; the order stays under **Open orders**.

## Printing

Printing uses the browser's print dialog. The first time on a new terminal,
check the right printer is selected and set it as the default so it comes up
pre-selected after that.

The till **cannot** cut the paper automatically or open the cash drawer — tear
the paper by hand and open the drawer the usual way.
