# Table QR ordering — contract, policy and evidence

**Lane** `x/floorplan` · backend + frontend in one worktree.

Owner manages Company → Store → Floor → Indoor/Outdoor section → Table, prints a
card per table, and a guest who photographs that card orders from their own phone
into the existing POS acceptance → KOT → KDS workflow.

This document is the part that cannot be read off the code: the configuration a
deployment must supply, the policy decisions that were taken rather than derived,
and what has actually been demonstrated.

---

## 1. The one variable that turns this on

```
POS_QR_BASE_URL=https://order.example.com
```

The origin a guest's phone reaches **on mobile data, not on the restaurant's
LAN**. A card is printed once and glued to furniture, so every rule below is
checked at **boot** — a deployment with a bad value refuses to start rather than
printing a stack of scrap.

| Value | Result |
|---|---|
| unset | QR ordering is **off**. `/api/guest/qr` is not mounted at all — there is no public route to probe. Staff QR endpoints answer `501 POS_QR_BASE_URL_NOT_SET`. |
| not an absolute URL | boot refuses |
| `http://…` outside `test`/`development` | boot refuses |
| `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.local` outside `test`/`development` | boot refuses — "not reachable from a customer's phone" |
| carries `?query` or `#fragment` | boot refuses in **every** environment |

The whitelist is on the safe environments, so an unset `NODE_ENV` refuses rather
than allows. `http` and `localhost` are permitted in `test` and `development`
only, so the suite and a laptop can exercise the real flow.

It is deliberately **not** defaulted to `APP_URL` (the staff console, routinely a
LAN address) and is **never** derived from the request's `Host` header. The
printed URL is built from configuration and the token alone:
`qrUrlFor(token) = ${POS_QR_BASE_URL}/t/${token}`.

`/t/:token` is half of that URL and lives outside `RequireAuth` in the SPA.
**Renaming that route invalidates every card already on a table.**

---

## 2. The credential

The token is 24 random bytes — 32 opaque base64url characters — carried in the
URL path. It identifies the card and nothing else. Company, store, floor, section and table are
resolved server-side from the card row; a branch or table supplied by the caller
is never read.

`status: 'ACTIVE'` sits in the `WHERE` clause rather than being checked after the
read, so a revoked card is not even loaded. An unknown token, a revoked token, a
card on a retired table and a card in a suspended store all return the **same**
`404 POS_QR_NOT_USABLE` with the same sentence — the endpoint cannot be used to
discover whether a guessed token exists, and it never names a store to a
stranger.

A guest who starts or joins a table order gets a second credential, returned
once and stored only as a sha256 hash, presented in `X-Guest-Token`. It is a
header and not a cookie on purpose: nothing is sent automatically from a public
origin, so there is no CSRF surface to defend.

`/api/guest/qr/*` is the only unauthenticated write-capable surface in the
product and carries its own limiter — 40 requests/minute/IP, against the global
300 — because anyone who can photograph a table can reach it.

---

## 3. Visit and session policy

A **DiningVisit** is one party at one table.

- **Scanning writes nothing.** No visit, no guest, no row of any kind. A
  passer-by reading the menu leaves no trace and does not make the table look
  occupied.
- **One open visit per table**, enforced by the database: `openTableId` is the
  table id while `OPEN` and `NULL` once closed, with a unique index. Two phones
  racing cannot produce two visits — the loser joins the winner's.
- **The party shares one order.** One `Order` per visit: one bill, guests append
  to it. `OrderItem.addedByGuestId` distinguishes "your items" without splitting
  the money.
- **A second phone must present the 4-digit join code.** Being within scanning
  distance of a card is not permission to read what the table has ordered. Only
  the host is shown the code. Wrong guesses are counted **outside** the
  transaction — otherwise the rollback would refund the attempt and hand a
  guesser unlimited tries — and the visit locks after 10.
- **No personal data exists to leak.** The model stores no guest name, phone or
  identity; a shared line is attributed as "Guest 3".
- **Closing isolates the next party.** A guest token is accepted only while its
  visit is `OPEN` *and* that visit still occupies this table, so a token kept
  from an earlier party stops working the instant staff close the visit
  (`409 POS_QR_SESSION_OVER`). The **printed card is untouched and stays
  reusable** — the next party scans the same card and opens a new visit.
- **A visit cannot be closed to make money disappear.** Closing refuses while an
  `OPEN` or `BILLED` order exists, or while any submission is still undecided.

---

## 4. Submission is not acceptance

`POST /api/guest/qr/t/:token/order` creates two facts that are **not** the same
fact: the order lines exist (so the table is honestly occupied and the till has
something to look at), and a `QrSubmission` is `SUBMITTED` but undecided. **No
KOT is cut.** The kitchen is told only when a member of staff accepts, through
the existing acceptance path.

Duplicate submissions cannot create duplicate orders or KOTs. The guarantee is a
unique index on `(companyId, idempotencyKey)`, not a pre-check — a double-tap
gets past any pre-check. Postgres holds the loser until the winner commits, so a
clash proves the winner is readable and is owed the answer the pre-check would
have given a moment later. The same key with **different** items is refused
(`409 POS_QR_KEY_REUSED`) rather than silently answered with the first order.

Prices are recomputed by the till's own resolver against the company the **card**
belongs to. The guest sends ids and quantities; every rupee comes from the
catalog. Menu prices are tax-exclusive, and the guest screen says "plus GST 5%"
because `total = subtotal − discount + tax`.

---

## 5. Floor-plan status is derived, never stored

`src/lib/qr/tableState.js` stores no status and offers no setter. Each state
names the evidence it requires:

| State | Evidence |
|---|---|
| `FREE` | the absence of everything else |
| `SEATED` | an open visit, nothing sent |
| `ORDERING` | a submission nobody has decided — **the kitchen has not been told** |
| `IN_KITCHEN` | accepted, a KOT cut, something still not served |
| `SERVED` | every active line served, no bill raised |
| `BILLED` | bill raised, money still owed |
| `PAID` | payments cover the bill |

A scan is not an order, a submission is not an acceptance, an acceptance is not
served food, and a bill is not a payment. A stored status column would be a
second copy of the truth and would start lying the first time a KOT was cut
without updating it.

---

## 6. Revocation, regeneration, deactivation, moving

- **Revoke** (`POST /api/table-qr/:id/revoke`, reason required, audited) sets
  `REVOKED`, clears `activeTableId` and stops the card resolving. Orders already
  placed on it keep pointing at it: revoking stops future use, it does not
  rewrite history.
- **Regenerate** (`POST /issue` with `regenerate: true`) revokes the live card
  with reason `Regenerated` and issues a new token at `rotation + 1`. The old
  card is revoked, never deleted. Without the flag a table that already has a
  live card is reported as `skipped`, so a bulk re-issue cannot silently
  invalidate cards that are already on tables.
- **Deactivating a table** makes its card unusable (`resolveCard` requires an
  `ACTIVE` table) while the row and its order history survive. A retired table is
  excluded from print sheets — its card must not be stuck on furniture — but its
  past orders still resolve.
- **Moving a table** is explicit rather than silent. The card keeps resolving to
  the right table; only the *text printed on it* is now wrong. `GET /table-qr`
  reports `placeStale: true` with `printedPlace` and `currentPlace`, so the
  manager is told to reprint instead of discovering a card labelled with the
  wrong section.

---

## 7. API surface

Staff — `/api/table-qr` (existing permissions; a branch-pinned user is confined
to their branch):

| Method | Path | |
|---|---|---|
| GET | `/` | cards per table, with `placeStale` |
| POST | `/issue` | single table or whole store; reports `issued`/`skipped` |
| POST | `/:id/revoke` | reason required, audited |
| GET | `/:id/png` | `image/png`, `Cache-Control: private, no-store` |
| GET | `/export.pdf` | print sheet, `layout=sheet\|single` |
| GET | `/visits`, POST `/visits/:id/close` | open parties; close a visit |
| GET | `/submissions`, POST `/submissions/:id/accept`, POST `/submissions/:id/reject` | the acceptance queue |

Floor plan — `/api/floors`: floors, indoor/outdoor sections, a draft/publish
layout with revisions, and table placement.

Guest — `/api/guest/qr` (public, mounted only when `POS_QR_BASE_URL` is set):

| Method | Path | |
|---|---|---|
| GET | `/t/:token` | store, table, place and the live menu. Writes nothing. |
| POST | `/t/:token/session` | start the table order, or join with the 4-digit code |
| GET | `/t/:token/order` | the shared bill, `sentToKitchen` per line, `awaitingStaff` |
| POST | `/t/:token/order` | submit a basket; `idempotencyKey` required |

The response carries `availability: 'MENU_STATUS_ONLY'`. Product is
company-scoped in this schema; there is no per-branch catalog and this lane does
not invent one, so "available" means ACTIVE in the tenant's menu. The payload
says so rather than implying a per-store stock system that does not exist.

---

## 8. What has been demonstrated

Suite: `./vcxfp test` — **751 passed / 751**, of which `tests/tableQr.test.js`
contributes 73 and `tests/floorplan.test.js` 16.

Several of those tests are negative controls: they invert a guard and assert the
**reason** for the refusal, because a test that only asserts "not 200" passes
just as happily when the refusal comes from a typo in the URL.

| Claim | Where |
|---|---|
| the same table label in different stores resolves to different tables | `tableQr.test.js` |
| invalid, revoked, retired-table and cross-store requests are refused, indistinguishably | `tableQr.test.js` |
| duplicate submissions produce one order and one KOT, including two phones racing | `tableQr.test.js` |
| QR orders arrive at the correct POS table and enter the acceptance queue | `tableQr.test.js` |
| a closed visit isolates the next party; the card stays reusable | `tableQr.test.js` |
| printed symbols decode to the configured URL | `tableQr.test.js` + `tests/fixtures/qrDecoder.js` |
| a bad `POS_QR_BASE_URL` refuses at boot, a good one does not | `tableQr.test.js` |

**The QR symbols are decoded by an independent reader.** `src/lib/qr` is
hand-written against ISO/IEC 18004 (no QR package is reachable here), so
`tests/fixtures/qrDecoder.js` imports nothing from `src/`: the Galois field, the
mask rules, the zigzag walk and the block geometry are all restated and the
Reed–Solomon syndromes are recomputed. A matching answer is two independent
implementations agreeing, not one agreeing with itself. Encoder and decoder were
additionally round-tripped across all 20 versions the encoder can emit, with a
negative control.

`tests/fixtures/pdfProbe.js` follows `startxref` → xref → each object offset and
throws if any recorded byte offset does not land on that object's header, so a
print sheet that merely opens in a forgiving reader still fails. Every symbol
drawn on a sheet is rebuilt from its rectangles and decoded.

### The two things no test above can prove

```
node scripts/qrDemoStage.mjs      # one demo restaurant on the dev DB; writes /tmp/qr-demo/cards.json
node scripts/qrDemoBrowser.mjs    # drives Chromium at a phone viewport; screenshots to /tmp/qr-demo/
node scripts/qrDemoArtifacts.mjs  # downloads the PNG and PDF a manager would print, and decodes them
```

The browser run talks to neither the database nor Express — it clicks what a
guest clicks, so it fails if the page does not render, if the proxy is wrong, if
a button is off screen, or if the SPA never routed `/t/<token>`. The artefacts
run proves the other half: that the image a member of staff downloads and sticks
on a table carries that URL. A card can be perfectly scannable and point at the
wrong store, or at localhost, and nothing else would notice.

`qrDemoStage.mjs` refuses to run against any database not named `vcx_floorplan`,
and rebuilds its own company each time, so a broken demo is fixed by re-running
it rather than by hand-editing rows.

---

## 9. Remaining dependencies

1. **`POS_QR_BASE_URL` must be set on the deployment** to a public https origin
   that resolves from mobile data, with TLS terminated for it. Until then QR
   ordering stays off and no guest route exists. This is an operator action, not
   a code change.
2. **Per-branch availability does not exist.** `availability:
   'MENU_STATUS_ONLY'` is the honest answer; a store that needs "sold out
   tonight" needs a per-branch catalog, which is outside this lane.
3. **Guest payment is not in this lane.** A party settles at the till through the
   existing payment path; the floor plan reads `PAID` from `Payment` rows.
4. **`scripts/qrDemo*.mjs` borrow a Chromium driver** from
   `/opt/atc/frontend/node_modules/playwright-core`, read-only. Nothing at
   runtime depends on it; on a box without it, those three scripts are the only
   thing that stops working.
