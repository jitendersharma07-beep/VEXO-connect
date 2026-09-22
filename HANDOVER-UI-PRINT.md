# Handover — touchscreen UI and 80 mm print

**For Window 1 (the release-docs / client-handover lane).**
Raised by the integration lane (`atc-pos-lanes/integration`, branch
`phase2-integration`), whose UI/print assignment is now complete.

Three things are being handed over: **commit `5309f4c`** (test-only),
the **corrected UAT screenshots**, and the **hardware checklist**.

---

## 1. Commit `5309f4c` — test-only, no redeploy

```
fix(uat): screenshot one receipt per navigation, not four stacked
```

**Do not schedule a deploy for this.** The proof, not the assurance:

- It touches `deploy/render-uat-screens.mjs` and `frontend/src/uat-render.jsx`.
- `uat-render.jsx` is referenced by exactly one file — `uat-render.html`
  (`grep -rn uat-render` over the frontend returns those two lines and nothing
  else).
- `uat-render.html` is **not in the production image**:
  `docker exec pos-prod-frontend-1 ls /usr/share/nginx/html/` returns
  `50x.html  assets  favicon.svg  index.html`, and the file itself returns
  `No such file or directory`.
- Therefore no production code path reaches the changed module.

`git diff 543a220..HEAD` across the whole branch is `render-uat-screens.mjs`,
`docs/DEPLOY-PHASE2.md` and `uat-render.jsx` — docs and test harness only.
**The deployed bundle is already correct at `543a220`.**

### What the commit actually fixed, because it is worth knowing

The print-media PNGs were composites of all four receipt fixtures. Under
`@media print` the `.print-area` box is `position:absolute; left:0; top:0`, so
on `?view=all` every fixture painted at the same origin, and an element
screenshot captures *painted pixels* — `receipt-long-print.png` showed a KOT
header sitting over the long bill while still carrying the long bill's name.

**This sat underneath 47/47 green.** The measurements read element boxes, which
are per-element regardless of overlap, so every number was correct. Correct
numbers beside a picture that lies, in the artefact set that goes to the client
as UAT evidence — that is the shape to watch for, not a red test.

---

## 2. Corrected screenshots

`/home/atc-noc/pos-uat-screens/` — regenerated after the fix, **47/47**, and
each image was inspected rather than merely counted.

| Artefact | What it demonstrates |
|---|---|
| `receipt-long-print.png` | `BSC-CP/2026/000483` in full; `₹2,160.00` uncut; long names wrap |
| `receipt-due-print.png` | Pending refund prints `₹100.00` **with no minus sign** + `REFUND REQUESTED — NOT YET PAID OUT BY THE PROVIDER` |
| `receipt-demo-print.png` | Settled refund prints `-₹60.00` **with** a minus; DEMO banner present |
| `kot-print.png` | Quantities right-aligned, long names wrap without pushing qty off |
| `receipt-long.pdf`, `kot.pdf` | 227.0 pt ≈ 80.1 mm, single page, 155 mm vs 66 mm |

The refund pair is the one to show the client: a **requested** gateway refund
and a **settled** staff refund must not look alike on paper, and they do not.

`/home/atc-noc/pos-nav-screens/` — **33/33 run against live production**
(`BASE_URL=https://atcworkspace.com/pos`), not against a local build:
767 px hides the sidebar and reveals the menu button, 768 px keeps the sidebar,
cashier sees 4 links against the owner's 12, zero horizontal overflow.

Regenerate either set with:

```sh
cd atc-pos-lanes/integration
BASE_URL=http://127.0.0.1:5181/pos OUT_DIR=/home/atc-noc/pos-uat-screens \
  node deploy/render-uat-screens.mjs
BASE_URL=https://atcworkspace.com/pos OUT_DIR=/home/atc-noc/pos-nav-screens \
  node deploy/render-nav-widths.mjs
```

The UAT harness needs a **dev server** (`uat-render.html` is a dev-only Vite
entry, per §1) and its base path **must include `/pos`** — without it every
check fails `element not found`, which is a misconfigured harness and not a
product defect.

---

## 3. Hardware checklist — the client-UAT gate

`frontend/docs/HARDWARE-CHECKLIST.md`. One per site, before go-live.

**Physical printing remains NOT TESTED.** No receipt or KOT from this build has
reached a thermal head. All print evidence above is Chromium print emulation and
PDF at the 80 mm page size: enough to prove layout and to have caught the
clipping defect, not enough to claim anything about a printer.

Not supported, and not to be promised as settings:

- **Silent printing** — every job raises the browser dialog
- **Automatic paper cut** — needs ESC/POS `GS V`; this app cannot emit raw commands
- **Cash-drawer kick** — needs ESC/POS `ESC p`
- **Receipt-to-counter / KOT-to-kitchen routing** — not implemented. The operator
  may pick any printer in the dialog and change it per job, but nothing stops a
  KOT printing at the counter or a bill printing in the kitchen.

If the customer needs any of these it is a **new integration** (a local print
agent or ESC/POS bridge), to be scoped separately.

The checklist item most likely to differ by printer model is **page length and
the cut**: the browser requests a per-job page height (~66 mm KOT, ~155 mm long
bill). A driver that overrides this with a fixed form will feed a bill's worth
of roll for a KOT. Print one of each back to back and measure.

---

## 4. `§6.12` navigation below 768 px — CLOSED

`WORK-ORDER-MOBILE-NAV.md` is discharged. The work order's main warning was that
a hand-copied nav list would drift and eventually hand a cashier the owner's
links. It was not copied: `SidebarBody` (`Layout.jsx:58`) is the single
definition, rendered at line 266 (sidebar) and line 300 (drawer) from the same
`navProps` — verified live at both widths: cashier 4 links, owner 12, no
owner-only link visible to a cashier. The drawer also closes on route change
and on Escape.

---

## 5. Correction you need for `docs/HANDOVER.md` §1

That table is **stale** and stale in a way that matters: it still names
`f014ab5` with images `055f9ae7f23f` / `0db76709b98b`, and those two IDs are now
the **rollback targets**, not the running build. Leaving it would send someone
rolling "back" to what the table calls current.

Supplied as evidence for you to fold in — I have not edited your section:

| | |
|---|---|
| Release | **`543a220`** — deployed 18:17 UTC 2026-09-22 |
| Backend | `pos-prod-backend:20260922-integration-543a220` (`f000ba8e3e89`) |
| Frontend | `pos-prod-frontend:20260922-integration-543a220` (`40a41c4e0c09`) |
| Frontend bundle | `assets/index-BYmQsKta.js`, sha256 `4a3bbd1ed1bd64fd…`, **434862 bytes** — hashed off the public URL |
| Stylesheet | `assets/index-D4XA2h9n.css` |
| Rollback tags | `pos-prod-{backend,frontend}:rollback-20260922-preprintfix` |
| Migrations | 8, unchanged — backend log reads `No pending migrations to apply.` Postgres was never restarted |
| DB dump | `/home/atc-noc/pos-backups/pre-printfix-20260922.dump` — verified to *parse*, not merely exist: `PGDMP` magic, 182 TOC entries, 22 tables with data |

**The defect this release fixes.** Production was serving
`.print-area{width:80mm}` together with `@page{margin:4mm}` — 80 mm of content
inside a 72 mm printable window, silently cutting every right-aligned value off
the paper: the TOTAL's paise, the invoice number, every line amount. Live CSS is
now `@page{size:80mm auto;margin:0}` and `.print-area{width:72mm;padding:0 2mm}`.
An "80 mm" roll images only ~72 mm (576 dots @ 203 dpi); the rest is dead margin
under the head's edges.

Verified on the deployed artefact, not on the working tree: `pos-print-page-size`
×1 and `beforeprint` ×1 in the live bundle, `prod-verify.mjs` 8/8 credential-free
(the 9th needs a TTY), and `/pos/`, `/pos/api/health`, `/` and `/reviews/` all 200.

---

## 6. Gaps in this lane's verification, stated so they are not assumed closed

- **E2E gate (precondition 0.3) was not run** — explicitly skipped, not omitted.
- **`prod-verify` is 8/9**; the interactive sign-in check needs a TTY and cannot
  be driven from an agent pipe. Someone should run it from a terminal.
- **Browser viewport tests do not prove terminal compatibility.** A real till
  differs in DPI, touch digitiser accuracy, on-screen keyboard behaviour and
  browser chrome height. §1 of the checklist must be signed off on the device.
- `globals.css` was treated as a **palette reference only**. No claim is made
  that the UI matches an approved visual design.
