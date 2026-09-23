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

## 0. Recommended specification

Added 2026-09-23. The owner asked for the best configuration rather than
supplying one, so this is ATC's recommendation, and every line of it is chosen
against what the build actually does — not against a generic "good POS printer"
list. Buy to this and the UAT in §2 runs as written, with no code change.

| | Recommended | Why this one |
|---|---|---|
| **Paper** | **80 mm roll, 72 mm printable** | The only width this build supports. It is fixed in two places (`PAPER_MM`/`PRINTABLE_MM` in `printPageSize.js`, `PAPER_W = w-[272px]` in `Receipt.jsx`). **58 mm is a code change, not a setting** — avoid it unless the site already owns 58 mm stock, and say so before quoting. |
| **Printer** | **Epson TM-T82 / TM-T88** | The single biggest print risk here is a driver that imposes a *fixed form length* instead of the per-job page height the app asks for — that is what feeds a bill's worth of blank roll after a short KOT. Epson's drivers are the most consistent at honouring a requested page size. TVS RP 3200/3230 is the acceptable budget alternative; expect to check the feed behaviour (§2, "Page length and the cut") more carefully. |
| **Connection** | **USB** for a single counter; **LAN with a reserved IP** only if a second (kitchen) printer is planned | USB has the fewest failure modes on a counter. Bluetooth is the least reliable and its pairing drops are a recurring go-live complaint. If LAN, reserve the address on the router — a DHCP lease change silently breaks printing. |
| **Host OS** | **Windows 11** | The app is browser-based, so the OS barely matters *to the application* — it matters to the **driver**, and that is where every print risk lives. Windows has the widest thermal-driver support and is what this class of hardware is tested against by its vendors. macOS and Linux go through CUPS and will work, but generic thermal drivers there are thinner and page-size handling differs; if the site is on either, treat §2 as genuinely unverified rather than a formality. |
| **Browser** | **Chrome/Edge at 100 % zoom** | Chromium is what the `@page` workaround was measured against. Firefox honours `size: 80mm auto` natively and is fine, but it is not what the fix was built for. |
| **Screen** | **1366×768 or larger, landscape** | 1024×768 is the smallest measured; below it the sidebar disappears with no replacement navigation. |

**Deliberately not recommended, because the build cannot use them:** a printer
bought for its cash-drawer port, its auto-cutter, or its "silent print" driver
feature. None of those is reachable from this application — see the NOT
SUPPORTED rows below. A drawer-capable printer is not *wrong* to buy, it just
buys nothing today, and it must not be quoted to the customer as a feature the
POS drives.

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

**Page length and the cut.** The browser asks for a page whose height is
measured from the receipt, one page per ticket — a KOT asks for ~66 mm and a
long bill ~155 mm. Whether the driver honours a per-job page height or
overrides it with a fixed form is a printer question, and it is the one most
likely to differ between models.

- [ ] Print a KOT and a long receipt one after the other. Confirm the paper
      feed differs between them — the KOT should not feed a bill's worth of
      roll.
- [ ] Measure blank paper after the last printed line: ______ mm (a large,
      constant amount on both means the driver is using a fixed form, not the
      requested height — record the model, it needs a per-site setting)
- [ ] Confirm each ticket comes out as **one** piece of paper. A receipt that
      arrives in two parts is paginating, and on a roll that means it was cut
      in half.
- [ ] If the printer has auto-cut: confirm it cuts **after** the last line and
      does not cut mid-receipt.

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

### Printer routing: what this build can and cannot do

Stated plainly, because it is a capability limit and not an open design
question:

**Can.** Print receipts and KOTs through the browser's own print dialog. The
operator may pick any printer the operating system offers, and may change it
per job in that dialog.

**Cannot.** Route automatically. There is no receipt-to-counter and
KOT-to-kitchen routing in this build. Both documents go through one print
path to whichever printer the dialog is currently pointed at. A site running
a counter printer and a kitchen printer needs the operator to change the
printer by hand for every KOT, and nothing in the software stops a KOT
printing at the counter or a bill printing in the kitchen.

Also not implemented, and not to be promised: silent printing (every job
raises the dialog), automatic paper cut triggered by the app, and cash-drawer
kick. Auto-cut may still happen if the **printer** is configured to cut at
end of page — that is the driver's behaviour, not this application's, which
is why it is on the sign-off list above rather than claimed here.

- [ ] Confirm with the customer whether one shared printer is acceptable for
      go-live. If it is not, this needs scoping as new work — it is not a
      configuration setting.

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
