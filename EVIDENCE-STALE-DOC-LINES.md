# Supplied evidence — stale and missing doc lines on shipped features

> **Revised 2026-09-24, after the original 06:59Z draft** — session 9a8852,
> owner-directed. Item 3's "already owner-reviewed" provenance is
> **withdrawn**; its Window 1 gate changed from a source grep to §6.1's
> deployed-state evidence; **F-5** added as prior art (intro and item 1); and
> **item 4 added** from F-4. Two windows have now written this file. Full
> change note: `.devlogs/PHASE1-EVIDENCE.md` § Cross-window notes.

**For Window 1 (release-docs lane).** Same pattern as `HANDOVER-UI-PRINT.md`:
nothing in your files has been edited; these are drop-in replacements (item 4
is an addition) with the evidence that justifies them. Fold in, reword, or
reject — your call. One worker per file holds.

Written 2026-09-24. Items 1–3 are one defect class: a limitation recorded
before the fix shipped, still standing in a doc the client reads, while
`CLIENT-HANDOVER-SCOPE.md` already records the feature as shipped. **Item 4 is
the mirror image** — a behaviour the scope sheet explicitly assigned to the
owner guide, which was then never written.

**This is not a new diagnosis.** `docs/CLIENT-HANDOVER-SCOPE.md:125` already
carries it as finding **F-5**: *"The handover said the discount cap (§6.1) and
mobile navigation (§6.12) were pending. Both shipped in v1.0.1."* — status
*"Corrected here. The stale text lives in `docs/HANDOVER.md`."* Items 1 and 3
below are that finding, carried the last step with the replacement text F-5
did not supply.

**What F-5 did not cover is item 2.** It scoped the stale text to
`docs/HANDOVER.md`, and `guide-owner.md` is named nowhere in the scope sheet.
So the correction stopped at the internal pack and never reached the document
the client actually reads — where both features are still described as absent,
each closing with an invitation to pay VEXO to build what already ships
(*"ask VEXO"*, lines 284 and 297).

---

## 1. `docs/HANDOVER.md` item 12 (line ~1075) — mobile nav IS shipped

Current text: *"There is no navigation below 768 px."*

Evidence it is stale: `SidebarBody` is in code-final `114ffc9` (4
occurrences), landed in `29a067f`; `docs/CLIENT-HANDOVER-SCOPE.md:90` records
*"Navigation below 768 px | Core | shipped v1.0.1, measured 33/33"*, and the
same sheet's **F-5** (`:125`) names §6.12 by number as already corrected there.
The two docs contradict each other on the same shipped feature.

Proposed replacement, following item 13's strikethrough pattern:

> 12. ~~**There is no navigation below 768 px.**~~ Fixed in `29a067f` and
>     shipped in v1.0.1. The sidebar's nav body was lifted into `SidebarBody`
>     and rendered twice: as the ≥ 768 px sidebar (unchanged) and as a drawer
>     behind a menu control below 768 px — the same role-gated tree, not a
>     copied link list, so a cashier's drawer shows only the cashier's links
>     and the drawer closes on route change. Measured **33/33** on the
>     deployed bundle across widths down to 320 px: navigation reachable at
>     every width, horizontal overflow still zero, and the cashier's visible
>     link count strictly smaller than the owner's at the same width — the
>     check that fails if the drawer were a hardcoded list. The original
>     defect for history: at 767 px a cashier had **zero** nav links, because
>     the sidebar was `hidden … md:flex` and nothing replaced it.

Window 1 gate before folding in: per `WORK-ORDER-MOBILE-NAV.md` §"After it
lands", re-measure against the bundle pulled out of the running container,
not the working tree. The 33/33 figure above is quoted from
CLIENT-HANDOVER-SCOPE.md:90, not re-measured by this window.

---

## 2. `docs/guide-owner.md` §9, "No phone-sized screen" (lines 292–297)

This is the doc the client reads, and it currently tells them the product
cannot do something it has done since v1.0.1 — and invites them to pay to ask
for it. Proposed replacement bullet:

> - **Phones can navigate; a till still wants a bigger screen.** Below about
>   768 pixels wide — every phone held upright — the menu down the left
>   becomes a menu button that opens the same menu as a drawer, so staff can
>   always reach their screens. Each person still sees only the pages their
>   role allows, phone or not. Selling all day is more comfortable on a
>   tablet, laptop or till monitor; the phone view is there so nobody is ever
>   stranded on one screen.

No percentages, no widths beyond the one the client can observe — same
register as the rest of §9.

---

## 3. Same class, same section: the discount bullet (lines 283–285) is also stale

*"No cap on how large a discount a cashier may give. Any cashier can discount
up to 100 %…"* — this describes pre-`847423d` prod. Discount ceilings shipped
in core-v1.0 (deny-by-default: an un-configured company's cashier may
discount NOTHING; owner-only Discounts page; branch-pinned approver
credentials; 98/98 suite at RC tier). This exact doc-vintage trap is already
recorded in `docs/HANDOVER.md` §6.1's status table — HANDOVER self-closed it,
guide-owner.md never followed.

Proposed replacement. **Provenance correction:** an earlier draft of this file
described the wording below as "already owner-reviewed on 2026-09-23". That
claim is **withdrawn** — the text appears nowhere in this repo or its history
(`git log --all -S "Discount limits are yours to set"` returns nothing), so
there is no record of a review to point at. Treat it as this window's proposed
wording, to be reworded or sent for owner review — not as signed-off text:

> - **Discount limits are yours to set.** Out of the box a cashier may not
>   discount at all. You grant permission and ceilings on the **Discounts**
>   page (visible only to you) — for the whole company, one branch, or one
>   named person — and you may delegate approval so a manager signs for
>   anything above a ceiling with their own password at the till.

Window 1 gate: this bullet is client-facing, so the question is whether the
ceilings are **deployed** — not whether they are in the source. That evidence
already exists and is stronger than a grep: `docs/HANDOVER.md` §6.1's status
table records *Deployed — **Yes**, 2026-09-23 02:22Z, images
`core-v1.0-rc-847423d`*, *Browser verification — **DONE** 2026-09-23, 49/49
against production*, with acceptance in `docs/RELEASE-CORE-V1.0.md` §9. Confirm
production is still serving that build or newer, then fold in.

Do **not** gate this on a source grep. §6.1's own moral is that "probing a
release that predates a feature cannot show the feature does not exist" — and
the converse holds just as hard: a grep of the RC tree says nothing about what
the client is actually running. That confusion is what put this line in the
guide in the first place.

---

## 4. `docs/guide-owner.md` — a company-wide discount limit also binds the owner, and that is written down nowhere

Not stale text: **missing** text. `CLIENT-HANDOVER-SCOPE.md:124` records this as
finding **F-4** — *"A company-wide staff default also narrows the owner at the
till: the owner reads '10%' and self-approves above it with their own
password."* — with status *"By design (`discountPolicy.js`: 'Narrowable').
**Belongs in the owner guide**; no code change."* Nothing ships for this; the
only deliverable F-4 asked for was a paragraph, and the paragraph was never
written. `grep -niE "narrow|self-approve|own password"` over `guide-owner.md`
returns nothing on this subject.

Verified in code on the working tree, not read off F-4:

- `resolveDiscountPolicy` (`backend/src/lib/discountPolicy.js`) selects rows by
  `scopeKey` in `['company', 'branch:<id>', 'user:<id>']`, filtered by
  `companyId` only — **there is no role dimension**. A COMPANY-scope row is
  therefore read for whoever is at the till, the owner included.
- `ROLE_FLOOR.CUSTOMER_OWNER = UNLIMITED`, but the floor applies only to fields
  no row wrote (`mergeField` → null → floor). A company row carrying
  `maxPercent` overrides the owner's unlimited ceiling. The source comment says
  so: *"Narrowable — an explicit COMPANY or USER row for them wins over this."*
- The owner keeps `canApprove: true` and an unbounded approval ceiling **when
  the company row leaves the approval fields blank**, because those fields then
  fall back to the same UNLIMITED floor.
- Self-approval is permitted and recorded, not blocked:
  `discountGuard.js:267` sets `selfApproved: approver.id === req.user.id`.

Proposed addition:

> - **A company-wide limit includes you.** The limit you set for everyone is
>   read at the till for whoever is standing there — and that includes you. Set
>   a company default of 10%, then go to give more yourself, and the till will
>   stop you at 10% and ask for an approval. Your own password is a valid
>   approval, so nothing is blocked; you sign for it. The bill records that you
>   approved your own discount, and **Reports → Discounts & voids** shows it
>   that way, which is the point — the limit is not a lock, it is a receipt. If
>   you would rather not meet that prompt, set a limit against your own name on
>   the Discounts page: a limit set for one named person overrides the company
>   default for that person. One caution — if you also set an *approval* limit
>   for everyone, that binds you the same way, and then there is no one above
>   you to sign.

Window 1 gates, two of them:

1. **Placement.** `guide-owner.md` has no discounts section — §9 is *"What this
   system does not do yet"*, and that is where item 3's bullet currently lives.
   Dropping item 3's replacement and this bullet into §9 would leave two
   descriptions of a *working* feature inside a "does not do yet" section. They
   want a home: either a short new section after §1 *"Who can do what"*, or
   inside §1 itself, which already carries the "apply discounts" authority row.
2. **Behaviour, not deployment.** Unlike items 1–3 nothing shipped here, so
   there is no deploy to confirm. Confirm instead on the running build that an
   owner under a company-wide ceiling is prompted and can clear it with their
   own password — `approvalSecrecy.test.js` and `discountSettings.test.js`
   cover the mechanism, but neither is written from the owner's point of view.

---

*Supplied from the foundation lane. Original draft 2026-09-24 06:59Z; revised
the same day by session 9a8852 under owner direction — see the header. Outside
this file, the revising session wrote only the cross-window note in
`.devlogs/PHASE1-EVIDENCE.md`: no file under `docs/` was touched and nothing
was committed. Delete this file once absorbed.*
