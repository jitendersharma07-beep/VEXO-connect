# VEXO Connect — quick guide (cashier · owner)

One page per role. The full manuals are `docs/guide-cashier.md` and
`docs/guide-owner.md`; this sheet is what gets taped next to the till.
All names and figures in screenshots are **DEMO seed data** — the client's
real menu, stores and staff are pending the client data pack
(`docs/CLIENT-ONBOARDING-CHECKLIST.md`).

---

## Cashier — a sale, start to finish

1. **Sign in** with your own account. Never share logins.
2. **Takeaway or Dine-in.** Dine-in: tap the table; an occupied table
   resumes its own order.
3. **Tap products** to ring them. Variants ask for a size. Quantities are
   editable until the line goes to the kitchen.
4. **Send KOT** for kitchen items — after that, quantities are locked;
   a mistake is a *void with a reason*, not an edit.
5. **Discounts:** if the button refuses, that is the owner's policy, not a
   fault. Over your limit, the screen tells you whose approval clears it.
6. **Bill** — the invoice number is assigned here and the order freezes.
7. **Record the payment** (CASH shows change due; CARD/UPI record the
   reference). Partial payments are fine; the display and the screen both
   show what is still due.
8. **Receipt** prints from the paid order. Reprints: Orders → the order.

**Customer display (new):** to pair the counter screen, open
**Menu → `/display/pair`**, generate the code, type it on the customer
device at **`/display`**. It follows your sale by itself: items as you
ring them, "Please pay" once billed, a thank-you when settled. It blanks
when you leave the Sell screen and **ends when you sign out** — next
shift, pair again with a fresh code.

**Day close:** count the drawer honestly; the system states the expected
figure and the variance is recorded, not judged.

---

## Owner — the five things that are yours

1. **Menu** (`/catalog`): tax rates → categories → products → variants.
   Prices snapshot onto bills at ring time; fix prices before selling.
2. **Staff** (`/team`): one account per person, role per duty. Managers
   are per branch. Removing a person disables their sign-in immediately —
   and kills any customer display their sign-in was carrying.
3. **Discount policy** (`/discounts`): shipped default is **deny** — a
   cashier cannot discount until you grant a ceiling. Grants are per
   level; approvals above a ceiling need the approver's own password.
   Two behaviours that are by design, not faults: a company-wide staff
   default also narrows you, the owner — above it you approve your own
   discount with your password; and a grant whose ceiling is zero on
   either side ("up to 0%", or "₹0") is refused outright at save,
   because it would deny every discount while reading as granted.
4. **Reports** (`/reports`): sales, activity, day-close with variances.
   Every discount shows who allowed it; every void carries its reason.
5. **Licence** (`/licence`): plan, branch limit, expiry. The demo licence
   expires **2026-10-20**.

**What you cannot do by design:** edit a billed order, delete a sale
(void records itself and keeps the bill), or discount past 100%. Online
payment stays off until VEXO configures a gateway — cards recorded at the
till are **manual records, not gateway-verified**, and the receipt says so.
