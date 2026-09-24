# Café terminal — hardware checklist

Fill one of these per site before go-live. Everything in this file is a check
**someone has to physically perform** on the real terminal and the real
printer.

Applies to **v1.0.1** (deployed code `55bf2dc`).

> To *run* a printer session rather than plan one, use
> **`PRINTER-TEST-SESSION.md`** — the same checks as §2 here, ordered as a
> 30-minute script with the kit list and the results sheet. This file explains
> why each check exists; that one is what you carry to the desk.

---

## What v1.0.1 already fixed — so you know what you are re-testing

The duplicate-page defect **is fixed and is live**. Before v1.0.1 a receipt
printed 3 times and a KOT 15 times: the modal was `position: fixed` over a
full-height page, so Chromium repainted it once per page of the background.
The fix hides every top-level node that is not the print root
(`body > *:not([data-print-root]) { display: none !important }`).

Verified on the deployed build, through the real signed-in till modal — not a
render harness — on a 12-line order, 1310 px of document behind a 768 px
viewport:

| | Result |
|---|---|
| KOT | **1 page** |
| Receipt | **1 page** |
| Negative control (pre-fix rule re-applied in the same browser) | **9 pages** KOT, **5** receipt |

The negative control is the part that matters: it proves the page counter
actually detects the defect, so "1 page" is a measurement and not a harness
that was never looking.

**Do not re-run that test, and do not report it as outstanding.** What remains
is whether it holds on *paper*, which is §2 below.

---

## PHYSICAL PRINTING: NOT TESTED

**No receipt or KOT produced by this build has ever been sent to a thermal
printer.** All print evidence to date is browser-rendered: Chromium print
emulation and PDFs generated at the 80 mm paper size. That proves the *layout*
is right, it caught the clipping bug, and it proves the pagination fix — and
none of that is evidence about a physical printer.

The distinction to hold onto: page **count** and page **geometry** are proven;
ink on thermal stock is not. A driver that overrides the requested page height
can still ruin a correct layout, and only paper will show it.

Specifically **untested and unclaimed**:

Three different things get muddled here, and quoting them as one costs money.
They are separated on purpose:

**A. Built and verified — but in a browser, not on paper**

| Capability | Evidence |
|---|---|
| Print receipt + KOT via the browser print dialog | Works; the operator chooses the printer per job |
| One page per ticket (the v1.0.1 fix) | 1 page each, with a 9-page/5-page negative control |
| 80 mm page geometry, 72 mm printable | Chromium `MediaBox` measured at 80 mm width |

**B. NOT IMPLEMENTED — absent from the code, and new work to add**

| Capability | Why it is absent |
|---|---|
| **Silent printing** (no print dialog) | Needs kiosk-mode flags or a local print agent. Neither is built. Every job raises the dialog. |
| **Automatic paper cut** commanded by the app | Needs ESC/POS `GS V`, i.e. a raw-command path. A browser cannot emit ESC/POS. |
| **Cash-drawer kick** | Needs ESC/POS `ESC p` through the drawer port. Same reason. |
| **Printer routing** (receipt→counter, KOT→kitchen) | No routing exists. Both documents go to whichever printer the dialog points at. |
| **58 mm paper** | The layout is fixed at 72 mm printable in two places (`PAPER_MM`/`PRINTABLE_MM` in `printPageSize.js`, `PAPER_W = w-[272px]` in `Receipt.jsx`). A code change, not a setting. |

These are **not** configuration. If a customer needs any of them it is a new
integration — a local print agent or an ESC/POS bridge — and must be scoped and
quoted separately. Do not let them be assumed as included.

One nuance that is regularly misread: a printer with an auto-cutter **will**
still cut, because the *driver* cuts at end of page. That is the hardware doing
it, not the application commanding it. Useful in practice, still not a feature
this product drives — so it is on the paper sign-off list, not in table A.

**C. UNVERIFIED — plausible, nobody has checked, needs paper**

| Capability | Why it is open |
|---|---|
| Characters legible on thermal stock | 203 dpi thermal rendering is not screen rendering |
| Driver honours the **requested page height** | The single biggest print risk — see "Page length and the cut" in §2 |
| Default-printer selection behaviour | Browser- and OS-dependent |
| Ink/paper layout at 80 mm on a real head | Verified in browser + PDF only; re-verify on paper |

**Nothing in group C may be marked PASS without paper evidence.** A screenshot,
a PDF or a successful dialog is not paper. If no printer was present, the
result is NOT TESTED — which is a legitimate outcome to report, and a false
PASS is not.

---

## 0. Recommended specification

Added 2026-09-23. The owner asked for the best configuration rather than
supplying one, so this is ATC's recommendation, and every line of it is chosen
against what the build actually does — not against a generic "good POS printer"
list. Buy to this and the UAT in §2 runs as written, with no code change.

| | Recommended | Why this one |
|---|---|---|
| **Paper** | **80 mm roll, 72 mm printable** | The only width this build supports. It is fixed in two places (`PAPER_MM`/`PRINTABLE_MM` in `printPageSize.js`, `PAPER_W = w-[272px]` in `Receipt.jsx`). **58 mm is a code change, not a setting** — avoid it unless the site already owns 58 mm stock, and say so before quoting. |
| **Printer** | **Epson TM-T82X** first choice; **TM-T88V/VI/VII** also correct | The single biggest print risk here is a driver that imposes a *fixed form length* instead of the per-job page height the app asks for — that is what feeds a bill's worth of blank roll after a short KOT. Epson's drivers are the most consistent at honouring a requested page size. TM-T82X is named first because it is the cheaper of the two **and** it is the 203 dpi / 576 dot head that the print code's own comments describe, so every number in §2 and in `PRINTER-TEST-SESSION.md` comes out as written. TVS RP 3200/3230 is the acceptable budget alternative; expect to check the feed behaviour (§2, "Page length and the cut") more carefully. |
| **Connection** | **USB** for a single counter; **LAN with a reserved IP** only if a second (kitchen) printer is planned | USB has the fewest failure modes on a counter. Bluetooth is the least reliable and its pairing drops are a recurring go-live complaint. If LAN, reserve the address on the router — a DHCP lease change silently breaks printing. |
| **Host OS** | **Windows 11** | The app is browser-based, so the OS barely matters *to the application* — it matters to the **driver**, and that is where every print risk lives. Windows has the widest thermal-driver support and is what this class of hardware is tested against by its vendors. macOS and Linux go through CUPS and will work, but generic thermal drivers there are thinner and page-size handling differs; if the site is on either, treat §2 as genuinely unverified rather than a formality. |
| **Browser** | **Chrome/Edge at 100 % zoom** | Chromium is what the `@page` workaround was measured against. Firefox honours `size: 80mm auto` natively and is fine, but it is not what the fix was built for. |
| **Screen** | **1366×768 or larger, landscape** | 1024×768 is the smallest measured; below it the sidebar disappears with no replacement navigation. |

### Head resolution does not change the layout — it changes the test numbers

Corrected 2026-09-24. The line above used to read "Epson TM-T82 / TM-T88" as
though those were one specification. They are not, and the difference surfaces
the moment someone prints the printer's self-test:

| | Epson TM-T82 / T82X | Epson TM-T88V / VI / VII |
|---|---|---|
| Head resolution | 203 dpi | 180 dpi |
| Printable width | 72 mm | 72.2 mm |
| Dots across that width | 576 | 512 |
| Characters per line, Font A | 48 | 42 |
| Characters per line, Font B | 64 | 56 |

**Both print this build correctly, and neither is a code change.** The layout
is expressed in millimetres, not in printer dots — `PRINTABLE_MM = 72` in
`printPageSize.js`, and a 272 px box at 96 dpi CSS in `Receipt.jsx` — so the
browser rasterises to whatever head the driver owns and 72 mm stays 72 mm.
What the dpi changes is the number the operator *reads off the paper* during
the test. A checklist that quotes only the 203 dpi figures makes a healthy
TM-T88 look like a failure, which is exactly the wrong way to burn a UAT slot.

Figures are from the vendor data sheets. **This lane has not confirmed any of
them against a printer** — see the standing notice at the top of this file.

> Known, deliberately not fixed: the same conflation sits in a source comment
> in `frontend/src/index.css` ("576 dots at 203 dpi on an EPSON TM-T82/T88-class
> head"). It is a comment, it changes no behaviour, and Core v1.0 is frozen to
> release blockers — so it is recorded here rather than edited. Correct it at
> the next thaw.

**Deliberately not recommended, because the build cannot use them:** a printer
bought for its cash-drawer port, its auto-cutter, or its "silent print" driver
feature. None of those is reachable from this application — see group **B,
NOT IMPLEMENTED**, above. A drawer-capable printer is not *wrong* to buy, it just
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
      - [ ] 80 mm paper / **~72 mm printable** ← what this build targets
            (576 dots @ 203 dpi on a TM-T82-class head, 512 dots @ 180 dpi on
            a TM-T88-class head — **both are correct**, see §0)
      - [ ] 80 mm paper / 80 mm printable (rare; full-width heads exist)
      - [ ] 58 mm paper (**NOT SUPPORTED** — the layout is fixed at 72 mm)
- [ ] Paper roll width loaded: ______ mm
- [ ] Resolution: ______ dpi (203 on a TM-T82-class head, 180 on a TM-T88-class
      head; **either passes** — the layout is millimetres, not dots. Record it
      anyway, because it sets the characters-per-line you should expect.)
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
- [ ] Confirm each ticket comes out as **one** piece of paper. This is the
      paper-side regression check for the v1.0.1 fix: in the browser it already
      measures 1 page for both KOT and receipt, so **more than one piece of
      paper here means the driver is paginating**, not that the fix regressed.
      Record the model and the page height it used — that is a per-site driver
      setting, and it is the finding this whole session exists to surface.
- [ ] If the printer has auto-cut: confirm it cuts **after** the last line and
      does not cut mid-receipt.

### Wording that must survive printing

These strings are sent by the server and printed verbatim. If any of them is
altered, truncated or wrapped into illegibility on paper, that is a defect —
they are the customer's evidence of what happened to their money.

**Reachable today** (the gateway is disabled, so every payment is `MANUAL`):

- `DEMO — sample data, not a real sale`
- `MANUAL PAYMENT RECORD — not gateway-verified`
- `REFUND HANDED BACK — recorded by staff`

**Not reachable until a gateway is enabled** — absence is not a defect, and
nobody should enable a gateway to print one:

- `GATEWAY PAYMENT — confirmed by the provider`
- `REFUND PAID OUT — confirmed by the provider`
- `REFUND REQUESTED — not yet paid out by the provider`
- `REFUND SENT — awaiting confirmation from the provider`
- `REFUND FAILED — the provider did not pay this out`

All eight are in `backend/src/lib/orders.js` (`paymentLabelFor`,
`refundLabelFor`). The four gateway *refund* labels are one state machine, not
alternatives: which one prints depends on the provider's answer, and `SENT`
exists precisely because "requested" would claim more than is known when the
provider never replied.

Note the refund distinction: a **requested** gateway refund prints without a
minus sign, because no money has moved yet. Only a settled refund prints
`-₹x`. Confirm on paper that a pending refund does not read as returned.

The smallest type on the receipt is these labels, at 9 px. They are therefore
the most likely thing to be lost on thermal stock, which is why they get their
own check rather than being assumed to follow from a legible total.

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
