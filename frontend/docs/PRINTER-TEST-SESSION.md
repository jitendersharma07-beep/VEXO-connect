# Printer test session — operator script

One sitting, one laptop, one printer, about 30 minutes. Work top to bottom and
fill in every blank as you go.

This is the **short** script for the person at the desk. The full per-site
go-live document is `HARDWARE-CHECKLIST.md`; read this one to *run* the
session, read that one to understand why each check exists.

Applies to **v1.0.1**.

---

## What this session settles, and what it does not

It settles exactly one question: **does a correct on-screen receipt come out
correct on thermal paper.** Everything about page count, layout and 80 mm
geometry is already measured in a browser and must not be re-run here.

It cannot settle silent printing, app-commanded auto-cut, cash-drawer kick,
printer routing or 58 mm paper. None of those is built — see group **B** in
`HARDWARE-CHECKLIST.md`. If you are asked to test one, the answer is "not
implemented", not "failed".

**Until this session runs on real paper, physical printing is NOT TESTED.**
That is the current, correct status. A screenshot or a PDF does not change it.

---

## Before you start

- [ ] Printer, power supply, USB or LAN cable, and **at least one full 80 mm
      roll** (you will use ~1 m)
- [ ] Laptop that can reach the POS URL
- [ ] A login on the **Demo company (BSC-CP)**. Do not run this on a real
      customer's tenant.
- [ ] A ruler with millimetres
- [ ] A phone to photograph the paper — the photographs *are* the evidence
- [ ] The long-name test product exists in the demo catalog. The longest name
      currently there is 24 characters, which **cannot wrap** on 72 mm, so
      step 7 needs one creating first:

      ```
      node deploy/seed-print-test-product.mjs --dry-run   # check
      node deploy/seed-print-test-product.mjs             # create
      ```

      It creates one item — *Slow-Roasted Single Origin Ethiopian Yirgacheffe
      Filter Coffee* (62 chars, GST 5%, ₹385) — and does nothing if it is
      already there. **Prepared, not yet run**; it needs a `CUSTOMER_OWNER` or
      `POS_SUPER_ADMIN` login. Do this before the session, not during it.

---

## Step 1 — Record the kit

Fill this in before printing anything. A result with no kit recorded cannot be
acted on later.

- Printer make and model: ______________________
- Connection: [ ] USB  [ ] LAN  [ ] Bluetooth  [ ] Serial
- If LAN, IP: ______________ · reserved on the router? yes / no
- Laptop OS and version: ______________________
- Browser and version: ______________________
- Browser zoom: ______ % (must be **100**)
- OS display scaling: ______ % (note it even if not 100)
- Driver name shown in the OS print dialog: ______________________

## Step 2 — Driver self-test page, before the app

Print the printer's **own** self-test — the one from its power/feed button or
its driver utility, not from the POS.

- [ ] Self-test page prints

Do this first and do not skip it. If the self-test fails or prints garbage,
the printer, cable or driver is at fault and nothing you learn from the POS
afterwards means anything. Stop here and fix the hardware.

- Characters per line on the self-test: ______
- Head resolution printed on the self-test, if it states one: ______ dpi

  What to expect depends on the head, and **both of these rows are a pass**:

  | Head | Dots across 72 mm | Font A (12 dots) | Font B (9 dots) |
  |---|---|---|---|
  | 203 dpi — Epson TM-T82/T82X, TVS RP 3200 | 576 | **48** | **64** |
  | 180 dpi — Epson TM-T88V/VI/VII | 512 | **42** | **56** |

  Corrected 2026-09-24: this step previously gave only the 203 dpi figures, so
  a healthy TM-T88 printing 42 would have been written down as a defect. It is
  not one — the receipt layout is sized in millimetres, not in printer dots, so
  a 180 dpi head prints the same 72 mm band with fewer, larger dots.

  The count that actually matters is the low one. **~32 characters or fewer
  means it is a 58 mm printer** — 384 dots — whatever the box said. That is the
  cheapest possible way to catch the wrong machine, and it is worth catching
  here rather than in step 6 after a roll has been used.

## Step 3 — Paper width

- [ ] Roll width loaded: ______ mm (this build targets **80 mm**)
- [ ] Measure the **printed** band on the self-test with the ruler: ______ mm
      (expect ~72)

If the roll is 58 mm, stop. The layout is fixed at 72 mm printable in two
places in the code; 58 mm is a code change, not a setting. Record it and
report it — do not try to make it fit by changing the browser zoom, because
that invalidates every other measurement in this session.

## Step 4 — Build one test order

On the Demo company, one order containing:

- [ ] the **long-name** product from the setup step (the wrap case)
- [ ] at least one item at **GST 5 %** and one at **GST 18 %**, so the receipt
      prints more than one tax line. Nothing needs creating for this — the demo
      catalog already has both. The three GST 18 % items are the only ones, and
      they are all under *Packaged & Retail*:
      **Coffee Beans 250g** ₹650 · **Brew Street Mug** ₹450 ·
      **Cold Brew Bottle 500ml** ₹320. Everything else is GST 5 %.
- [ ] enough lines to make the receipt a realistic length (8–12 is plenty)

Send it to the kitchen, then bill it.

## Step 5 — One KOT

- [ ] Print the KOT
- [ ] Every quantity present and readable at arm's length
- [ ] It comes out as **one** piece of paper
- Blank paper after the last line: ______ mm

More than one piece of paper here does **not** mean the v1.0.1 fix regressed —
in the browser it already measures one page. It means the driver is paginating
to a fixed form length. Record the model and the page height the driver used;
that is a per-site driver setting and it is the single most likely finding of
this session.

## Step 6 — One receipt

- [ ] Print the receipt
- [ ] Nothing is cut off the right edge. Check the rightmost characters
      specifically: the paise on TOTAL, the full invoice number, and the amount
      on every line.
- [ ] It comes out as **one** piece of paper
- Blank paper after the last line: ______ mm
- Measured printed width: ______ mm (expect ~72)

- [ ] The KOT and the receipt fed **different** amounts of paper. A short KOT
      that feeds a full bill's worth of roll is the fixed-form-length symptom
      from step 5.

## Step 7 — Long item name

The wrap was designed against a **55-character** product name (`Receipt.jsx`,
the `Row` component). That is the case to put on paper.

- [ ] The long name **wraps onto a second line** rather than being truncated
- [ ] No characters are lost at the wrap point
- [ ] The amount column stays straight — the amount must never be the thing
      that wraps

## Step 8 — Tax totals

- [ ] Subtotal prints
- [ ] **Each** tax rate prints its own line, in the form `GST 5% on ₹x`
- [ ] TOTAL prints in the larger bold type and is legible
- [ ] Add up the printed lines by hand: subtotal + taxes = TOTAL: yes / no

That last one is a real check, not ceremony. All amounts come from the server,
so a mismatch on paper means something dropped a line in rendering.

## Step 9 — Refund labels

Record a **partial** refund on the order, then reprint the receipt.

- [ ] The refund line prints with a minus sign: `-₹x`
- [ ] The label `REFUND HANDED BACK — recorded by staff` prints in full and is
      legible at 9 px — this is the smallest type on the receipt and the most
      likely to be lost on thermal stock
- [ ] The payment label `MANUAL PAYMENT RECORD — not gateway-verified` prints
      in full
- [ ] The `DEMO — sample data, not a real sale` banner prints inside its dashed
      box

**The gateway labels cannot appear in this session and their absence is not a
failure.** Razorpay is disabled in production, so every payment is `MANUAL` and
every refund is `HANDED BACK`. `GATEWAY PAYMENT`, `REFUND REQUESTED`, `REFUND
PAID OUT`, `REFUND SENT` and `REFUND FAILED` are unreachable by design. Do not
record them as FAIL, and do not enable the gateway to reach them.

## Step 10 — Keep the paper

- [ ] Photograph each printed ticket flat, in good light, with the ruler beside
      it so the width is visible in the photo
- [ ] Keep the physical tickets until the results are signed off

---

## Results

Mark **PASS**, **FAIL** or **NOT TESTED**. A step you did not reach is NOT
TESTED — leaving it blank or guessing is worse than an honest gap.

| Step | Result | Note |
|---|---|---|
| 2. Driver self-test | | |
| 3. Paper width | | |
| 5. KOT — one piece, legible | | |
| 6. Receipt — one piece, nothing clipped | | |
| 7. Long name wraps | | |
| 8. Tax totals add up | | |
| 9. Refund + payment labels legible | | |

Operator: ______________________  Date: ____________

## Send back

1. This sheet, filled in
2. The photographs from step 10
3. The printer model and driver name, exactly as the OS shows them
4. For any FAIL: the measurement, not the impression. "18 mm of blank paper
   after every ticket" is actionable; "feeds too much" is not.

Until this comes back completed, physical printing stays **NOT TESTED** and
must be reported that way.
