# VEXO Connect — Phase 2 Contract (Backend ↔ Frontend)

Version 1.0.3 — 2026-09-20. Maintainer: **Window 1** (backend + integration).
Status: **FROZEN for Milestone 1.** W2 requests changes by reporting to the
owner/W1; only W1 edits this file (version bump + changelog entry).

Milestone 1 = product add → order → KOT → bill → payment record → receipt →
sales report, end to end, on the dev stack. Payment gateway work starts only
after Milestone 1 (separate section at the end).

---

## 1. Lanes & file ownership

| Lane | Tree | Branch | Owns (exclusive write) |
|---|---|---|---|
| **W1** backend + integration | `~/atc-pos` | `phase2-backend` | `backend/**` (incl. **all** Prisma schema + migrations + seed), `deploy/**`, `docker-compose*.yml`, `.env*`, `docs/**` |
| **W2** frontend | `~/atc-pos-lanes/frontend` (git worktree) | `phase2-frontend` | `frontend/**` — nothing else |

Rules:
- W2 **never** edits backend, schema, migrations, seed, deploy, compose or env
  files — not even "small fixes". Found a backend bug? Report it; W1 patches.
- W2 commits only on `phase2-frontend`, never merges, never touches `main`.
- W1 does every merge: `phase2-frontend` → `phase2-backend` (integration),
  then → `main` only after E2E passes. Production images/stack/nginx stay
  untouched until the owner approves rollout (staging report + rollback plan
  come first).
- Both lanes branch from the commit that froze this contract, so each
  worktree carries its own copy at `docs/PHASE2-CONTRACT.md`. W2 reads the
  copy inside its own worktree and treats it as read-only; only W1's copy is
  ever edited (and W1 propagates updates by merge).

## 2. Dev runtime (both lanes)

- Dev Postgres: `atc-pos-dev-db`, `127.0.0.1:5439` (compose stack in
  `~/atc-pos`; `docker compose up -d` from repo root if it is down).
- Backend dev server (**W2 may RUN it, must not edit it**), from `~/atc-pos/backend`:

  ```bash
  # <dev-db-password> = POSTGRES_PASSWORD of the dev container atc-pos-dev-db.
  # Read it from that container, not from this repo:
  #   docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD
  DATABASE_URL='postgresql://atc_pos:<dev-db-password>@127.0.0.1:5439/atc_pos?schema=public' \
  POS_JWT_SECRET="$(openssl rand -hex 32)" \
  npm run dev            # node --watch, listens on :5010
  ```

- Frontend dev: `npm run dev` in `frontend/` → vite on **:5177**, proxies
  `/api` → `http://localhost:5010` (see `vite.config.js`; `VITE_DEV_API`
  overrides the target). Base path is `/` in dev, `/pos/` only in the prod
  image — never hardcode `/pos` in app code.
- Only ONE backend dev server runs at a time (port 5010 is shared between
  lanes). If it is already up, just use it.
- **Fixed dev logins** (dev DB only; prod credentials are different and never
  appear in any file or chat). Emails below — the passwords are **not
  committed**: the seed reads them from `POS_SEED_ADMIN_PASSWORD` /
  `POS_SEED_OWNER_PASSWORD` / `POS_SEED_MANAGER_PASSWORD` /
  `POS_SEED_CASHIER_PASSWORD` at seed time; the values are issued out-of-band
  in the owner's terminal.

  | Role | Email |
  |---|---|
  | POS_SUPER_ADMIN | pos.admin@atcinfocom.in |
  | CUSTOMER_OWNER | demo.owner@atcpos.example |
  | BRANCH_MANAGER (BSC-CP) | demo.manager@atcpos.example |
  | CASHIER (BSC-CP) | demo.cashier@atcpos.example |

- These fixed passwords exist only because the seed ran with
  `POS_SEED_ALLOW_FIXED_PASSWORDS=true` — a dev/test-only flag: the seed
  refuses it under `NODE_ENV=production`, and without it even env-provided
  passwords still force a first-login change.
- Login endpoint is rate-limited: don't loop logins; the `pos_session` cookie
  lasts 12 h — reuse it.
- Demo catalog (tax rates, categories, products with variants, tables) is
  seeded by W1's seed script after the phase-2 migration lands. Until then W2
  builds components; **mock data is allowed in dev-only fixtures/tests, never
  wired into the live UI as fake success**.

## 3. API conventions

- Success envelope: resource-keyed objects — `{"product": {...}}`,
  `{"orders": [...], "page": 1, ...}`. Created resources return HTTP 201.
- Error envelope (always): `{"error": {"code": "...", "message": "...",
  "field": "optional"}}` with the matching HTTP status:

  | HTTP | code |
  |---|---|
  | 400 | `POS_BAD_REQUEST` (validation; `field` set when known) |
  | 401 | `POS_UNAUTHENTICATED` (UI: go to login) |
  | 403 | `POS_FORBIDDEN` (role refused) |
  | 403 | `POS_LICENSE_EXPIRED` / `POS_LICENSE_SUSPENDED` / `POS_LICENSE_MISSING` |
  | 404 | `POS_NOT_FOUND` (also for cross-company ids — indistinguishable, by design) |
  | 409 | `POS_CONFLICT` (illegal state transition, duplicate, occupied table) |
  | 429 | rate-limited (login) |

- **Money**: JSON numbers in **rupees**, max 2 decimals (e.g. `675.36`). The
  server computes everything in integer paise. **The client never computes
  money** — every mutation returns the full recalculated order; display server
  values only. Client-side arithmetic is allowed solely for non-authoritative
  hints (e.g. disable Pay button), never for display of amounts.
- Dates: ISO-8601 UTC strings in JSON. Business day boundaries (reports
  `byDay`, financial-year label) use **IST**.
- IDs: cuid strings. Auth: same as phase 1 — `pos_session` httpOnly cookie
  (browser) or `Authorization: Bearer` (tests/scripts).
- Licensing: when a customer company's licence is not usable (expired/
  suspended/missing), **every phase-2 write** below returns the matching 403;
  reads and receipts still work. UI must show a licence banner and disable
  write actions gracefully (no fake success). ATC operators bypass.
- ATC operators (`POS_SUPER_ADMIN`) must send `?companyId=` or header
  `x-pos-company` to scope any of these endpoints. They get **read** access
  everywhere and **write** access to catalog/tax config only — they can NOT
  create orders, KOTs, payments, refunds or voids (403).
- Branch scoping: `BRANCH_MANAGER`/`CASHIER` are pinned to their branch —
  server forces `branchId = user.branchId` on everything they do and filters
  every list; any client-sent branchId is ignored for them. `CUSTOMER_OWNER`
  sees all branches and must pass `branchId` where marked.

## 4. Data model (as serialized to W2)

```jsonc
// TaxRate      {"id","name":"GST 5%","ratePercent":5,"status":"ACTIVE","createdAt"}
// Category     {"id","name":"Coffee","sortOrder":1,"createdAt"}
// Product      {"id","categoryId","name","sku":null,"basePrice":180,
//               "taxRate":{"id","name":"GST 5%","ratePercent":5}|null,
//               "status":"ACTIVE"|"ARCHIVED",
//               "variants":[{"id","name":"Large","price":220,"status":"ACTIVE"}]}
// DiningTable  {"id","branchId","name":"T1","capacity":4|null,
//               "status":"ACTIVE"|"RETIRED",
//               "currentOrder":{"id","status","type","total"}|null}   // occupancy
// OrderItem    {"id","productId","variantId":null,"name":"Cappuccino",
//               "unitPrice":180,"qty":2,"lineDiscount":0,"lineSubtotal":360,
//               "taxRate":{"name":"GST 5%","percent":5}|null,
//               "lineTax":16.2,"lineTotal":340.2,       // post order-discount share
//               "kotSeq":1|null,                        // null = not sent to kitchen
//               "status":"ACTIVE"|"VOIDED","voidReason":null}
// Payment      {"id","method":"CASH|CARD|UPI|OTHER","channel":"MANUAL",
//               "amount":675.36,"tendered":700|null,"changeDue":24.64|null,
//               "note":null,"receivedBy":{"id","fullName"},"createdAt"}
// Refund       {"id","amount","reason","by":{"id","fullName"},"createdAt"}
// Order (full) {"id","branchId","branch":{"id","name","code"},
//               "type":"DINE_IN"|"TAKEAWAY","status":"OPEN|BILLED|PAID|VOID|REFUNDED",
//               "table":{"id","name"}|null,"invoiceNumber":"BSC-CP/26-27/00042"|null,
//               "items":[OrderItem...],
//               "discount":{"type":"FLAT|PERCENT","value":10,"amount":70}|null,
//               "subtotal":700,"discountAmount":70,"taxAmount":45.36,"total":675.36,
//               "payments":[Payment...],"refunds":[Refund...],
//               "amountPaid":675.36,"amountDue":0,"amountRefunded":0,
//               "openedBy":{"id","fullName"},"note":null,
//               "createdAt","billedAt":null,"closedAt":null}
// OrderSummary (lists)
//              {"id","invoiceNumber","type","status","branchId","tableName":"T1"|null,
//               "itemCount":3,"total":675.36,"amountPaid":675.36,
//               "openedBy":"Demo Cashier","createdAt","billedAt"}
```

Every order mutation response is `{"order": <full order>}` (plus extras noted
below), already recalculated — render from it directly.

## 5. Endpoints

### 5.1 Catalog (writes: CUSTOMER_OWNER + ATC; reads: all roles in company)

| Method + path | Notes |
|---|---|
| GET/POST `/api/catalog/tax-rates`; PATCH/DELETE `/api/catalog/tax-rates/:id` | POST `{name, ratePercent}` (0–100, ≤3dp). DELETE archives (products may reference). |
| GET/POST `/api/catalog/categories`; PATCH/DELETE `/api/catalog/categories/:id` | POST `{name, sortOrder?}`. DELETE is hard, 409 if it still has products. |
| GET/POST `/api/catalog/products`; GET/PATCH/DELETE `/api/catalog/products/:id` | POST `{categoryId, name, sku?, basePrice, taxRateId?}`. GET list filters: `?categoryId=&q=&status=` (default ACTIVE, name-contains search, variants + taxRate embedded). DELETE archives. |
| POST `/api/catalog/products/:id/variants`; PATCH/DELETE `.../variants/:variantId` | POST `{name, price}` — price is the **absolute** unit price (not a delta). DELETE archives. |
| PUT/DELETE `/api/catalog/products/:id/image` | PUT `{dataUrl}` — a base64 `data:` URL, **not** multipart; JPEG/PNG/WebP only, ≤512 KB decoded, ≤2000 px per edge, all re-checked server-side from the magic bytes. Idempotent: the filename is a content hash, so re-sending the same photo yields the same URL. Both return the full product; `imageUrl` is null when there is no photo. Files are written under `POS_PRODUCT_IMAGE_DIR` and served **unauthenticated** from `/api/media/products/...` (immutable, 1-year cache) — see §5.1n. |

<a id="51n"></a>**§5.1n — why menu photos are public.** They are `<img src>` targets on the till *and* on the paired customer display, which has no POS session, so a session gate would blank the screen the diner looks at. The path carries a cuid plus a content hash, so it is unguessable though not secret, and the contents are a shop's own menu pictures. The static mount sits **above** the 300 req/min global limiter deliberately: every till in one café shares a public IP under `trust proxy`, and a cache-cold grid of forty photos must not be able to spend the API's budget. A miss still falls through to the limiter and the normal JSON 404.

### 5.2 Tables (writes: BRANCH_MANAGER own branch / CUSTOMER_OWNER; reads: all)

| Method + path | Notes |
|---|---|
| GET `/api/tables` | Pinned roles: own branch. Owner/ATC: `?branchId=` or all. Each row carries `currentOrder` (open/billed order on that table) for the occupancy board. |
| POST `/api/tables` | `{name, capacity?, branchId?}` (branchId required for owner, ignored for pinned). |
| PATCH/DELETE `/api/tables/:id` | DELETE retires (`RETIRED`); 409 while an open order sits on it. |

### 5.3 Orders — cashier flow (CASHIER / BRANCH_MANAGER own branch / CUSTOMER_OWNER)

**Create** — `POST /api/orders`

```jsonc
// request
{ "type": "DINE_IN",              // or "TAKEAWAY"
  "tableId": "tbl_1",             // REQUIRED for DINE_IN, FORBIDDEN for TAKEAWAY
  "branchId": "br_1",             // owner only; pinned roles: server uses their branch
  "note": "window seat",          // optional, ≤500
  "items": [                      // ≥1
    { "productId": "prd_1", "qty": 2 },
    { "productId": "prd_2", "variantId": "var_9", "qty": 1 } ] }
// response 201: {"order": <full order, status OPEN, totals computed>}
```

- `unitPrice` snapshots variant price (if any) else basePrice; tax rate
  snapshots too — later catalog edits never change an existing order.
- DINE_IN on a table that already has an OPEN/BILLED order → 409 (occupied).
- Table must be ACTIVE and in the same branch → else 404/409.

**Items** (order must be OPEN):

| Call | Rules |
|---|---|
| POST `/:id/items` `{productId, variantId?, qty?}` | qty default 1. Same product+variant already ACTIVE and **not on a KOT** → qty increments instead of a new line. |
| PATCH `/:id/items/:itemId` `{qty}` or `{lineDiscount}` | `qty` (1–999) only while the line is **not on a KOT**. `lineDiscount` (₹ flat, 0…lineGross) any time while OPEN. |
| DELETE `/:id/items/:itemId` | Only lines not on a KOT. |
| POST `/:id/items/:itemId/void` `{reason}` | KOT-sent lines; **BRANCH_MANAGER/OWNER only**; line stays visible as VOIDED and leaves all totals. |

**KOT** — `POST /:id/kot` (order OPEN; ≥1 ACTIVE line not yet on a KOT)

```jsonc
// response 201
{ "kot": { "id","seq":1,"orderId","type":"DINE_IN","tableName":"T1",
           "items":[{"name":"Cappuccino","qty":2}], "createdAt" },
  "order": <full order — those lines now carry kotSeq> }
```
GET `/:id/kots` lists them for reprint.

**Order-level discount** — `POST /:id/discount` `{type:"FLAT"|"PERCENT", value}`;
`DELETE /:id/discount` clears. OPEN only. FLAT ≤ subtotal, PERCENT ≤ 100.

**Bill** — `POST /:id/bill` `{}` → 200 `{"order", "receipt"}`. OPEN with ≥1
ACTIVE line. Freezes all amounts, assigns `invoiceNumber`, status → BILLED,
sets `billedAt`. After this, items/discount calls → 409.

**Record payment** — `POST /:id/payments` (order BILLED)

```jsonc
// CASH — send tendered OR amount (exactly one):
{ "method": "CASH", "tendered": 700 }
// applied = min(tendered, amountDue); changeDue = tendered − applied
// CARD / UPI / OTHER — amount required, must be ≤ amountDue:
{ "method": "UPI", "amount": 675.36, "note": "GPay, manual entry" }
// response 201: {"order", "payment", "changeDue": 24.64}
```

- Splits allowed; when Σ applied = total → status PAID, `closedAt` set.
- Every payment is `"channel": "MANUAL"` — a hand-recorded entry. The UI must
  label it exactly **`MANUAL PAYMENT RECORD — not gateway-verified`** on the
  payment screen, receipt and history. Never render a manual record as a
  verified/online payment. (Gateway payments arrive in a later phase with
  their own channel.)

**Refund** — `POST /:id/refunds` `{amount, reason}` — BILLED or PAID;
**MANAGER/OWNER only**; reason mandatory; cumulative refunds ≤ collected.
PAID + fully refunded → status REFUNDED. Audited.

**Void order** — `POST /:id/void` `{reason}` — OPEN or BILLED;
**MANAGER/OWNER only**; allowed only when collected − refunded = 0. Voided
bills keep their invoice number (gaps are normal and audited).

**Read**:

| Call | Notes |
|---|---|
| GET `/api/orders` | Filters `?status=OPEN,BILLED&branchId=&from=&to=&page=1&pageSize=20` (max 100; from/to on createdAt, IST dates). Response `{"orders":[OrderSummary], "page","pageSize","total"}`, newest first. |
| GET `/api/orders/:id` | `{"order": full}` |
| GET `/api/orders/:id/receipt` | BILLED/PAID/REFUNDED only (409 for OPEN/VOID). Shape in §9. |

### 5.4 Reports (BRANCH_MANAGER own branch / CUSTOMER_OWNER all / ATC read; CASHIER → 403)

GET `/api/reports/sales?from=2026-09-01&to=2026-09-20&branchId=` → §10.

## 6. Money math (normative — W1 implements, W2 only displays)

1. All arithmetic in integer **paise**; JSON exposes rupees ≤2dp.
2. `lineGross = unitPrice × qty`; `lineSubtotal = lineGross − lineDiscount`.
3. `subtotal = Σ lineSubtotal` over ACTIVE lines.
4. Order discount: FLAT = value (≤ subtotal); PERCENT = value% of subtotal,
   half-up to paise. `discountAmount` distributed across lines proportionally
   to `lineSubtotal` (largest-remainder, so shares sum exactly).
5. Per line: `taxable = lineSubtotal − discountShare`;
   `lineTax = taxable × ratePercent%`, half-up to paise; no tax rate → 0.
6. `taxAmount = Σ lineTax`; `total = (subtotal − discountAmount) + taxAmount`;
   `lineTotal = taxable + lineTax`.
7. Everything frozen at bill time; payments/refunds never recompute.

**Worked example** (the seed data can reproduce it):
Cappuccino ₹180×2 (GST 5%) + Veg Sandwich ₹150×1, line discount ₹30 (GST 5%)
+ Cold Brew Large ₹220×1 (GST 12%); order discount PERCENT 10.
- lineSubtotals 360 / 120 / 220 → subtotal **700.00**
- discountAmount **70.00** → shares 36 / 12 / 22
- taxable 324 / 108 / 198 → tax 16.20 / 5.40 / 23.76 → taxAmount **45.36**
- **total 675.36**; cash tendered 700 → applied 675.36, **changeDue 24.64**
- Receipt tax breakup: GST 5% → taxable 432.00 tax 21.60; GST 12% → 198.00 / 23.76.
Rounding micro-example: FLAT ₹1.00 over lineSubtotals 3.33/3.33/3.34 →
paise shares 33/33/34.

## 7. Order state machine

```
OPEN ──bill──▶ BILLED ──payments Σ=total──▶ PAID ──refund Σ=collected──▶ REFUNDED
 │                │
 └──void──▶ VOID ◀┘   (manager+; only while collected − refunded = 0)
```

| From | Action | Who | Guard |
|---|---|---|---|
| — → OPEN | create order | cashier+ | licence usable; DINE_IN needs a free ACTIVE table |
| OPEN | add line / qty / delete line | cashier+ | qty & delete only pre-KOT |
| OPEN | line discount, order discount | cashier+ | caps in §6 |
| OPEN | void line (KOT-sent) | manager+ | reason |
| OPEN | KOT | cashier+ | ≥1 unsent ACTIVE line |
| OPEN → BILLED | bill | cashier+ | ≥1 ACTIVE line; freeze + invoice |
| BILLED | payment | cashier+ | Σ applied ≤ total; = → PAID |
| BILLED/PAID | refund | manager+ | ≤ collected − refunded; PAID full → REFUNDED |
| OPEN/BILLED → VOID | void order | manager+ | net collected 0; reason |

Anything else → 409 `POS_CONFLICT`. PAID/REFUNDED/VOID are terminal (except
PAID→refunds).

## 8. Invoice numbering

`<branchCode>/<fy>/<seq5>` e.g. `BSC-CP/26-27/00042`. FY = Indian financial
year (Apr–Mar, IST). Per **branch+FY** counter, atomic in the bill
transaction — concurrent bills can never share a number (unique constraint).
Numbers are assigned at bill; voided bills leave gaps (normal, audited).

## 9. Receipt & KOT (print)

GET `/:id/receipt` →

```jsonc
{ "receipt": {
    "invoiceNumber": "BSC-CP/26-27/00042", "isDemo": true,
    "company": { "name": "Brew Street Café (Demo)" },
    "branch": { "name": "Brew Street Café — Connaught Place", "code": "BSC-CP",
                "addressLine": "Block A, Connaught Place (sample address)",
                "city": "New Delhi" },
    "order": { "id": "...", "type": "DINE_IN", "tableName": "T1",
               "billedAt": "...", "cashier": "Demo Cashier" },
    "items": [ { "name": "Cappuccino", "qty": 2, "unitPrice": 180,
                 "lineDiscount": 0, "amount": 360 } ],   // amount = lineSubtotal
    "subtotal": 700, "discountAmount": 70,
    "taxBreakup": [ { "name": "GST 5%", "percent": 5, "taxable": 432, "tax": 21.6 },
                    { "name": "GST 12%", "percent": 12, "taxable": 198, "tax": 23.76 } ],
    "total": 675.36,
    "payments": [ { "method": "CASH", "amount": 675.36, "tendered": 700,
                    "changeDue": 24.64,
                    "label": "MANUAL PAYMENT RECORD — not gateway-verified" } ],
    "amountPaid": 675.36, "amountDue": 0, "refunds": [] } }
```

W2 print rules: 80 mm thermal layout (~302 px), `@media print` hides all app
chrome; `isDemo: true` → a clear **DEMO** banner on screen AND print; the
manual-payment label prints verbatim; `amountDue > 0` prints as BALANCE DUE.
KOT print: seq, table/type, time, item names + qty only (no prices).

## 10. Sales report

```jsonc
{ "report": {
    "from": "2026-09-01", "to": "2026-09-20", "branchId": null, "currency": "INR",
    "sales":  { "grossItems": 0, "discounts": 0, "tax": 0, "netSales": 0,
                "refunds": 0, "collected": 0 },
    "orders": { "total": 0, "open": 0, "billed": 0, "paid": 0,
                "refunded": 0, "voided": 0 },
    "byMethod":   [ { "method": "CASH", "channel": "MANUAL", "amount": 0, "count": 0 } ],
    "byCategory": [ { "categoryId": "...", "name": "Coffee", "qty": 0, "amount": 0 } ],
    "byDay":      [ { "date": "2026-09-20", "orders": 0, "netSales": 0, "collected": 0 } ],
    "note": "All payments are manual records; gateway payments arrive in a later phase." } }
```

Definitions: sales figures cover PAID+REFUNDED orders **billed** in [from,to]
(IST); `grossItems` = Σ lineGross, `discounts` = line + order discounts,
`netSales` = Σ order.total; `collected`/`refunds` follow payment/refund
timestamps; `byCategory.amount` = lineSubtotal (pre order-discount, pre-tax);
VOID orders count only in `orders.voided`. Render the `note` verbatim.

## 11. W2 build scope (Milestone 1)

Routes (inside existing Layout/auth; role-gate nav):
- `/sell` — cashier screen (CASHIER lands here): category tabs + search,
  product grid (variant picker popover), cart with qty/line-discount, order
  discount, DINE_IN table picker (occupancy from `/api/tables`) vs TAKEAWAY,
  KOT button, Bill → payment modal (CASH tendered/change, CARD/UPI/OTHER) →
  receipt view with Print.
- `/orders` — history: filters (status/date/branch where allowed),
  pagination, detail drawer, receipt reprint.
- `/catalog` — owner admin: categories, products + variants, tax rates
  (archive flows, no hard deletes in UI except empty categories).
- `/tables` — manager/owner: table CRUD + live occupancy board.
- `/reports` — sales report per §10 (manager sees own branch; owner all/one
  branch; ATC with company scope; CASHIER gets no route/nav).

Non-negotiables: loading/empty/error state on every fetch; every error
envelope surfaced honestly (401 → login, 403 licence → banner, 409 → toast
with server message); **no fake success, no client-computed money**; fast on
a small screen (cashier uses it standing); keep phase-1 pages working.

## 12. Milestone-1 verification (who proves what)

- W1: vitest suite `backend/tests/phase2.test.js` — money math (incl. §6
  worked example verbatim), RBAC matrix, cross-company 404s, licence-expired
  blocks, invoice uniqueness under concurrency, full E2E flow by API. Existing
  `foundation.test.js` stays green untouched.
- W2: browser walkthrough of the full flow on dev creds + screenshots; every
  claim of "works" must have been exercised in the browser.
- W1 integration: merge W2, run both suites + build, then staging report +
  rollback plan → owner decides prod rollout. Prod stack/nginx untouched
  until then.

## 13. After Milestone 1 (not now)

Payment gateway (sandbox): provider + sandbox credentials are an **owner
dependency** (e.g. Razorpay test key id/secret). Then: order-linked gateway
sessions, signature-verified webhooks, idempotent duplicate protection,
refunds via gateway, reconciliation report, `channel: "GATEWAY"` rendered as
verified — clearly distinct from MANUAL.

## Changelog
- 1.0.3 (2026-09-20): credential hygiene — dev password values removed from §3
  (emails + `POS_SEED_*_PASSWORD` env names stay); no API change.
- 1.0.2 (2026-09-20): §11 adds the `/reports` route (was specified in §10 but
  missing from W2 scope; W2 change-request accepted). Note: `foundation.test.js`
  wipe extended for phase-2 tables — suite still green (71/71 total).
- 1.0.1 (2026-09-20): W2 worktree branches from the contract commit (own copy
  of this file); fixed dev passwords gated behind dev-only seed flag.
- 1.0 (2026-09-20): initial frozen contract for Milestone 1.
