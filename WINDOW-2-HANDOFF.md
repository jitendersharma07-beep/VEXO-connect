# Window 2 handoff — frontend (Phase 1 foundation)

Issued by Window 1 (integration coordinator, session `ed6ffece`), 2026-09-24.

## Agreed development base — READ THIS FIRST

- **CORRECTION (W1, 2026-09-24 ~11:58Z): the previously published base SHA
  `4f2a91c` does not exist anywhere in this repo** — a prior-session
  compaction error invented it. The Phase-1 foundation bytes are really
  preserved as **`bddbe82`** (`x/w2-frontend`, your own read-only snapshot,
  fingerprint-verified against the live tree 07:21Z) and are contained in
  `cfa22e9` (`x/foundation` 08:43Z, mixed with early VC-102).
- **Agreed development base as of 2026-09-24 (Phase-1), historical pin:
  `x/foundation` @ `baa2456`** (full suite 479/479 owner-verified) — this is
  a Phase-1 evidence SHA, not a live integration candidate; the foundation
  lane has moved on since (lane tip was `6b2cdf5` at publish time, with
  further test-infra work in flight then). Confirm the lane's current tip
  before branching — do not branch off a stale or moving pin. Hand back as
  a branch, never a patch.
- `EVIDENCE-STALE-DOC-LINES.md` and `frontend/dist` in the foundation lane are
  deliberately NOT in the commit (handoff note + build output).

## Status

Backend suite PASSED 2026-09-24 (owner-run `vcxl test` against
`vcx_foundation_test`). Migration rehearsals COMPLETE 2026-09-24 (owner-run):
- Shadow-DB diff (`vcxl migsql`): clean — "-- This is an empty migration."
- Fresh-install rehearsal: passed (all 16 migrations applied to an empty DB).
- Populated-baseline rehearsal: passed — backfill counts all equal
  (Branch.publicId, InvoiceCounter.seriesPrefix, Payment.branchId).

**Phase-1 exit gate: PASSED.** Pinned Phase-1 bytes: `bddbe82`
(`x/w2-frontend` snapshot, fingerprint-verified 07:21Z) — see the base
correction above; the `4f2a91c` formerly printed here was wrong.

## Dev stack (isolated, local — never the lab, never prod)

- Runner: `bash ~/vcx-foundation-local/vcxl {setup|test|migrate|seed|up|down|status}`
- The OLD `~/vexo-connect-x-tools/vcx` rsyncs to vexo-lab (20.20.20.57) —
  **prohibited, do not run it.**
- DBs: `vcx_foundation`, `vcx_foundation_test` on `vexo-connect-dev-db`
  (loopback 127.0.0.1:5440) only. Nothing touches `atc_pos*` or prod.
- API: `http://127.0.0.1:5521` · Vite dev: `http://127.0.0.1:5621`
  (bind 127.0.0.1 only — owner rule on this public-IP box).

## Phase-1 API surface (mounted under `/api`, app.js:133–139)

All routes require the `pos_session` cookie, are tenant-scoped server-side
(client-supplied companyId ignored), and enforce role + store scope via
`requireAction` / `scopedBranchIdWhere`. Cross-tenant reads 404.

| Mount | Endpoints |
|---|---|
| `/api/legal-entities` | GET list · POST create · PATCH :id |
| `/api/gst-registrations` | GET list · POST create · PATCH :id |
| `/api/brands` | GET · POST · PATCH :id · PUT store links |
| `/api/regions` | GET · POST · PATCH :id |
| `/api/terminals` | GET · POST · PATCH :id |
| `/api/devices` | GET list · POST enrol · GET :id · POST activate · POST revoke · PATCH :id |
| `/api/users` | GET list · POST create (sets mustChangePassword) · PATCH :id · PATCH :id/password-reset · POST :id/… (see users.js:353) |
| `/api/permissions` | GET catalog/effective/rules · PUT rule · DELETE rule · GET/PUT assignments · GET/POST support grants · POST grant revoke |

New roles (enum, migration `20260924100000`): COMPANY_ADMIN … AUDITOR (9
added). Permission resolution: USER > BRANCH > COMPANY; COMPANY-level DENY is
hard. Support grants require expiry; revocation is immediate and audited.

## Frontend work already drafted in the foundation lane (uncommitted)

Pages: Organisation, Team, Permissions, Branches, Brands, Regions, Devices +
Layout/App/roles/permissions lib changes. These are drafts from the prior
session — after the base commit lands, Window 2 owns reviewing/finishing them.
Do not start parallel copies; diff against the lane versions.

## Your assignment (after base SHA is published here)

1. Review/finish the drafted org pages against the API table above.
2. First-login flow: mustChangePassword UX end-to-end.
3. Verify built bundle with `VITE_BASE_PATH=/pos/` rules (trailing slash!) —
   see docs/PHASE2-CONTRACT.md conventions.
4. Hand back as a branch off the published base, never a patch.

Report to Window 1 via a `WINDOW-2-REPORT.md` in your own lane; do not write
into the integration tree or the foundation lane.

## Phase-2 work order (added 2026-09-24, after Phase-1 exit gate PASSED)

Phase 1 is closed (see `docs/PHASE1-EXIT-EVIDENCE.md`). After finishing the
Phase-1 frontend items above, pick up in this order:

1. **VC-101 Customer display (frontend surface)** — secondary-screen order
   view (line items, totals, GST breakup) driven by the till's live cart.
   Key it on Terminal identity (`/api/terminals`), not window naming. Draft
   the till↔display transport proposal for Window 1 review before wiring it.
2. **VC-102 Promotions (admin + till UI)** — promotion setup pages and till
   application UX. Backend endpoints come from Window 1; do not stub your own
   API shapes — request the contract via WINDOW-2-REPORT.md when you reach it.

Same rules: branch off the published base (or its successor SHA once Window 1
publishes one), hand back branches, loopback-only dev servers.

## VC-102 duplicate-implementation reconciliation (W1, 2026-09-24)

Two parallel VC-102 backends exist: the foundation lane's (contract above)
and an older one in the `promotions/` lane working tree (migrations
`20260924150000_promotions_core`, `20260924170000_promotion_redemption_reversal`).
**W1 verdict: the foundation lane implementation is canonical.** Evidence:
integer-paise config matching this contract vs B's decimal `benefitValue`;
A has `perCustomerLimit`/`stackable`/`precedence` and `PromotionStore` +
`PromotionItemRule` relational targeting, B has none of these; B's reversal
column is `reversalReason` vs the contract's `reversedReason`. **CORRECTION (same day, later):** the `promotions/` lane is NOT a dead
spike — it is live work by session `2afb2cce` (its `.devlogs/VC102-EVIDENCE.md`
is from 08:17 today). The technical verdict stands (foundation implementation
is canonical and matches the published contract), but the resolution is a
COORDINATION step, not archival: that session must stop extending its chain
and either rebase its deltas onto the foundation implementation or hand its
tree to W1 for salvage review. Its two migrations must NEVER be applied to a
DB that has (or will get) `20260924120000_promotions` — this has ALREADY
caused damage once: they contaminated `vcx_kitchen_test` and produced the
kitchen lane's 159-fail runs (see WINDOW-KITCHEN-DB-FINDING.md).

## VC-102 promotions — ACTUAL API contract (published 2026-09-24, Window 1)

Implemented and under test in the foundation lane (`x/foundation`; successor
SHA will be published here once the verified commit lands). Mounted at
`/api/promotions` and `/api/orders/:id/promotions`. Money is integer paise in
promotion CONFIG, rupees-decimal in order/redemption responses (same split
the rest of the API uses).

### Admin surface (`/api/promotions`)
- Permissions: `promo.read` list, `promo.write` create/edit/target,
  `promo.publish` publish/pause/archive — company-scope; cashiers hold only
  `promo.apply` (store scope). Every write also requires a usable licence.
- `GET /` → `{ promotions: [...] }`, each:
  `{ id, name, code, status: DRAFT|PUBLISHED|PAUSED|ARCHIVED, version,
     benefitType: FLAT|PERCENT, percent, flatPaise, minSpendPaise,
     maxBenefitPaise, startsAt, endsAt, weekdayMask, startMinute, endMinute,
     channel: DINE_IN|TAKEAWAY|null, stackable, precedence, totalLimit,
     redemptionCount, perCustomerLimit, publishedAt,
     stores: [{branchId, branchName}],
     rules: [{id, kind, categoryId, productId}], createdAt, updatedAt }`
- `POST /` create, `PATCH /:id` full-body update. Validation: exactly one of
  `percent` (0<x≤100, 3dp) / `flatPaise` (int>0) matching `benefitType`;
  `code` optional `[A-Z0-9-]{3,20}`, unique per company (409 on duplicate);
  `weekdayMask` bit0=Sunday…bit6=Saturday; `startMinute`/`endMinute` are
  minutes since IST midnight, start<end, both-or-neither, NO midnight wrap
  (create two promotions); `startsAt<endsAt`; `totalLimit` and
  `perCustomerLimit` int>0 or null; `precedence` 0–1000 (default 100);
  `stackable` default false.
- `PUT /:id/stores {branchIds:[]}` / `PUT /:id/rules {rules:[]}` —
  replace-in-full. Rule kinds INCLUDE/EXCLUDE_CATEGORY (categoryId only) and
  INCLUDE/EXCLUDE_PRODUCT (productId only). No rules = whole menu; INCLUDEs
  start the eligible set, EXCLUDEs subtract; a product rule outranks its
  category.
- `POST /:id/publish|pause|archive`. Any edit after first publish bumps
  `version`; redemptions snapshot the version they were computed under.

### Till surface (`/api/orders/:id/promotions`) — `promo.apply`
- `POST` body: `{ promotionId }` XOR `{ code }`, plus optional
  `customerPhone` (≥7 digits after stripping formatting; REQUIRED when the
  promotion carries `perCustomerLimit`, else 400). Success returns the full
  order; `order.promotions[]` rows:
  `{ promotionId, name, code, version, amount, status: APPLIED|REVERSED,
     reversedReason }`. The benefit is folded into `order.discountAmount`
  by the shared server pricing engine — render it as a discount line named
  by the redemption row.
- Refusals: 404 for absent/other-tenant/unpublished (one indistinguishable
  answer); 409 for wrong store, already applied, stacking conflict,
  campaign limit reached, per-customer limit reached, order not OPEN, and
  schedule/eligibility with reason text: NOT_STARTED / ENDED / OFF_DAY /
  OFF_HOURS / WRONG_CHANNEL / BELOW_MIN_SPEND / NO_ELIGIBLE_ITEMS.
- `DELETE /:id/promotions/:promotionId` — reversal REMOVED, amount 0,
  campaign + customer slot released.
- Re-evaluation: every basket change re-runs eligibility; a promotion that
  stops qualifying reverses automatically (reason BASKET_CHANGE). Void
  reverses with ORDER_VOID and KEEPS the recorded amount. A billed order's
  redemptions are frozen (version + amount) whatever happens to the
  campaign afterwards. Partial refunds do NOT claw back promotions
  (recorded policy).
- Stacking: a non-stackable promotion must be alone on the order; stackables
  each compute on the undiscounted eligible base; the combined manual+promo
  discount is clamped to the subtotal, highest `precedence` number yields
  first.
- Modifier treatment (IMPLEMENTED 2026-09-24, supersedes the earlier
  variants-only note): products now carry modifier groups/options.
  - Catalog admin (same `catalog` write roles): product responses gain
    `modifierGroups: [{id, name, minSelect, maxSelect, status,
    options: [{id, name, price, status}]}]`. CRUD:
    `POST /api/catalog/products/:id/modifier-groups`,
    `PATCH .../modifier-groups/:groupId`,
    `POST .../modifier-groups/:groupId/options`,
    `PATCH .../options/:optionId` (archive via `status: ARCHIVED`).
    `price` is rupees (2dp, ≥0); `minSelect ≥ 0`, `maxSelect ≥ minSelect`
    or null = unbounded.
  - Till: order create items and `POST /:id/items` accept
    `modifierOptionIds: []` (per line). Selection is validated against the
    product's ACTIVE groups (min/max per group → 400 with reason). The
    chosen options' per-unit prices are FOLDED INTO `unitPrice`; each item
    row returns `modifiers: [{id, groupName, name, price}]` as the printed
    breakdown (prices already inside `unitPrice` — display rows, not extra
    charges). Same product+variant merges only when the modifier choice is
    identical; otherwise it's a separate line. KOT items carry
    `modifiers: [name]` (no prices).
  - Promotion treatment: because modifiers live inside `unitPrice`, the
    eligible base includes them on eligible lines and excludes them with an
    excluded product — verified by tests.
  - **UI status: NOT built, NOT browser-tested — the modifier feature is
    API-only until Window 2 ships and verifies these two surfaces:**
    1. Catalog admin (product edit page): manage modifier groups
       (name, minSelect, maxSelect, archive) and their options (name, rupee
       price, archive) via the CRUD endpoints above; product GET already
       returns `modifierGroups` for rendering.
    2. Till (item add): when the tapped product has ACTIVE `modifierGroups`,
       show a selection step enforcing min/max per group client-side, send
       `modifierOptionIds` on the item; render each line's `modifiers`
       breakdown under the line (prices are already inside `unitPrice` —
       display them as included, never re-add). Server 400s name the group
       and bound; surface them verbatim.
