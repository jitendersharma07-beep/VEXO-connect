# Café terminal — hardware checklist

Fill one of these per site before go-live. Everything in this file is a check
**someone has to physically perform**; nothing here has been verified by this
lane, because this lane has no terminal and no printer.

---

## PHYSICAL PRINTING: NOT TESTED

**No receipt or KOT produced by this build has ever been sent to a thermal
printer.** All print evidence to date is browser-rendered: Chromium print
emulation and PDFs generated at the 80 mm paper size. That is enough to prove
the *layout* is right and to catch the clipping bug it did catch, and it is
not enough to prove anything about a physical printer.

Specifically **untested and unclaimed**:

| Capability | Status | Note |
|---|---|---|
| Ink/paper layout at 80 mm | Verified in browser + PDF only | Re-verify on paper |
| Characters printing legibly on thermal stock | NOT TESTED | Font rendering on a 203 dpi head is not the same as on screen |
| **Silent printing** (no browser print dialog) | **NOT SUPPORTED** | Requires kiosk-mode flags or a print agent; neither is built. Do not promise this. |
| **Automatic paper cut** | **NOT SUPPORTED** | Needs ESC/POS `GS V`, i.e. a raw-command path. This app prints via the browser and cannot emit ESC/POS. |
| **Cash-drawer kick** | **NOT SUPPORTED** | Needs ESC/POS `ESC p` through the printer's drawer port. Same reason as above. |
| Printer auto-selection / default printer | NOT TESTED | Browser-dependent |
| Multiple printers (counter receipt vs kitchen KOT) | NOT TESTED | See "Open question" below |

If the customer needs silent print, auto-cut or a cash drawer, that is a
**new integration** (a local print agent or an ESC/POS bridge), not a setting.
Scope it separately — do not let it be assumed as included.

---

## 1. Terminal

- [ ] Device make/model: ______________________
- [ ] OS and version: ______________________
- [ ] Screen resolution (actual, from display settings): ______ × ______
- [ ] Browser and version: ______________________
- [ ] Touchscreen: yes / no. If yes — capacitive / resistive: __________
- [ ] Browser zoom set to **100%** (a zoomed browser changes every CSS px
      measurement this UI was verified against)
- [ ] OS display scaling set to **100%** (or note the value: ______%)

**Verified resolutions.** The cashier screen was measured at 1024×768,
1366×768, 1920×1080 and 768×1024 (tablet portrait) — see
`TOUCHUI-HANDOVER.md` for results. **1024×768 is the smallest supported
screen.** Below that, nothing has been measured and the sidebar disappears
with no replacement navigation (see the known gap in the handover note).

> Browser viewport tests do not prove physical terminal compatibility.
> A real terminal differs in DPI, touch digitiser accuracy, on-screen
> keyboard behaviour and browser chrome height. Sign off §1 on the actual
> device, not on a resized desktop window.

- [ ] On the real device: open Sell, add items, and confirm the total and the
      payment button are reachable **without scrolling**
- [ ] On the real device: confirm the on-screen keyboard does not cover the
      amount field when recording a payment
- [ ] On the real device: confirm the qty +/− buttons can be hit reliably with
      a thumb, including a wet or gloved one if that is realistic for the site

## 2. Printer

- [ ] Make and model: ______________________
- [ ] Print width — confirm **which** the head images:
      - [ ] 80 mm paper / **72 mm printable** (576 dots @ 203 dpi) ← what this build targets
      - [ ] 80 mm paper / 80 mm printable (rare; full-width heads exist)
      - [ ] 58 mm paper (**NOT SUPPORTED** — the layout is fixed at 72 mm)
- [ ] Paper roll width loaded: ______ mm
- [ ] Resolution: ______ dpi (203 assumed)
- [ ] Connection: [ ] USB  [ ] LAN/Ethernet  [ ] Bluetooth  [ ] Serial
- [ ] If LAN: IP address ______________ and is it static/reserved? ______
- [ ] Driver installed on the terminal OS, printer visible in the OS print
      dialog: yes / no
- [ ] Printer set as the **default** printer: yes / no

### Printer sign-off (do these on paper)

- [ ] Print a receipt. Confirm **nothing is cut off the right edge** — check
      the rightmost characters specifically: the TOTAL's paise, the full
      invoice number, and the amount on every line.
- [ ] Print the long multi-item receipt. Confirm long product names wrap and
      the amount column stays straight.
- [ ] Print a KOT. Confirm every quantity is present and readable at arm's
      length across a pass.
- [ ] Confirm the DEMO banner prints on demo bills and **does not** print on
      real ones.
- [ ] Confirm the payment and refund wording prints verbatim (see below).
- [ ] Measure the printed content width with a ruler: ______ mm (expect ~72)

### Wording that must survive printing

These strings are sent by the server and printed verbatim. If any of them is
altered, truncated or wrapped into illegibility on paper, that is a defect —
they are the customer's evidence of what happened to their money.

- `DEMO — sample data, not a real sale`
- `MANUAL PAYMENT RECORD — not gateway-verified`
- `GATEWAY PAYMENT — confirmed by the provider`
- `REFUND REQUESTED — not yet paid out by the provider`
- `REFUND HANDED BACK — recorded by staff`

Note the refund distinction: a **requested** gateway refund prints without a
minus sign, because no money has moved yet. Only a settled refund prints
`-₹x`. Confirm on paper that a pending refund does not read as returned.

### Open question for the release owner

Receipt and KOT both print through the same browser print path, so they go to
whatever printer the browser is pointed at. If the site wants the **KOT at a
kitchen printer and the receipt at the counter**, that is not currently
possible without the operator changing the printer in the dialog each time.
Confirm whether the customer needs this before go-live.

## 3. Network

- [ ] Terminal reaches the POS URL: ______________________
- [ ] Behaviour when the network drops mid-sale has been observed: yes / no
      (This app is server-authoritative for every amount, so it cannot bill
      offline. Confirm the site accepts that.)

## 4. Sign-off

| Check | By | Date | Result |
|---|---|---|---|
| Terminal §1 on real hardware | | | |
| Printer §2 on paper | | | |
| Network §3 | | | |
