# VC-101 Customer Display — handover (sprint v1.1)

A second screen at the counter that shows the customer their order live:
items, quantities, discounts, tax and total, then a payment ask, then a
thank-you. **Conditional for the release**: it lands as one `--no-ff`
merge, so dropping it at the 48-hour freeze is a single clean revert that
cannot delay Core.

## How it is used

- **Cashier / manager / owner:** open **`/display/pair`** on the till,
  generate the six-digit code (single use, five-minute life). Owners pick
  the branch; pinned roles get their own.
- **Customer screen:** open **`/display`** on the customer-facing device,
  type the code. The screen idles on the branch welcome and follows
  whatever order the paired cashier has on the Sell screen.
- **Unpairing is signing out.** The display lives exactly as long as the
  cashier's sign-in; sign-out blanks and unpairs it on its next poll, and
  the next shift pairs afresh with a new code.

## The contract (agreed with the Core session before any shared file moved)

- `POST /api/display/pair-code` (staff, Sell-screen roles) → code.
- `POST /api/display/pair` (unauthenticated, own rate limiter, login
  pattern) → display token: JWT, `aud=vexo-customer-display`, bound to the
  minting cashier's `PosSession`. Every poll re-checks that session in the
  database — sign-out or disabling the user is real revocation. A staff
  JWT can never pass the audience check; a display token has no session
  row under its own hash, so every staff route answers it 401. The
  verifier sets `req.display`, never `req.user` — no role gate or discount
  guard can treat a display as a principal.
- `PUT /api/display/state {orderId|null}` (staff) — points the caller's
  station. Cross-company reads as 404, cross-branch as 403.
- `GET /api/display/state` (display token) — IDLE | ACTIVE | THANKYOU.
  ETag/304; the page polls 2s active / 10s idle and honours 429.

**Every figure comes from `serializeOrder` over the stored order rows** —
the same §6 math the bill uses; nothing is recalculated in the route or
the browser (line rows show stored qty / unit price / line discount; sums
live in the totals block). The response is an **allowlist**: order status,
invoice number, ACTIVE items as `{name, qty, unitPrice, lineDiscount}`,
subtotal, discountAmount, taxAmount, total, due. Never: discount
approver/reason, void reasons, staff emails, payment methods, policy
ceilings. PAID → one THANKYOU poll, then IDLE; VOID/REFUNDED → straight to
IDLE (a voided bill is not thanked).

Stations are `branch × cashier`. Codes, tokens and pointers are all
station-scoped, so cross-counter and cross-branch reads are impossible by
construction — proven in the suite, not assumed.

## Accepted limits (documented, by design)

- The station pointer and outstanding codes are in-memory (single backend
  instance, which is how this product deploys). A backend restart blanks
  the display until the cashier's next action on the sale re-points it,
  and kills unminted codes. Pairings themselves survive restarts — the
  token is stateless and its session row is in the database.
- One display mirrors one cashier's station. Two displays CAN pair to the
  same station and mirror it identically — but on settlement, whichever
  polls first consumes the THANKYOU flip and clears the pointer, so the
  other goes straight to IDLE. No figure or field beyond the allowlist is
  exposed either way. (Surfaced by the Core session's RC integration
  review; accepted for v1.1 — one screen per counter is the intended
  deployment.)

## Acceptance results (2026-09-23)

- `backend/tests/customerDisplay.test.js`: **13/13** — pairing lifecycle
  (single-use, expiry, dead-session mint), credential separation both
  directions, exact response allowlist, **field-by-field equality against
  `GET /api/orders/:id`** through items, discount, bill, partial and final
  payments, station isolation (same branch / other branch / other
  company), sign-out kill.
- Full backend run with the mount in place: **381/381**.
- Browser walkthrough `tests/e2e/walk-display.cjs` (two isolated
  contexts, till + display): **8/8 steps** — pair, idle, mirror with the
  till's own total demanded on the display, billed payment ask with
  invoice number, thank-you carrying the settled total, dwell back to
  idle, sign-out landing on the pairing screen. Screenshots archived with
  the sprint evidence.
- Receipt/KOT fix `7cc7896`: ancestor of this branch; print path untouched.
- Independent verification on the merged RC (lab, fresh databases, run by
  the Core session, not by the author): backend **384/384**, frontend
  build clean, and an HTTP end-to-end harness **52/52** including nine
  display checks written outside this suite — mint, redeem without a
  staff credential, single-use code, part-paid mirroring, exact-key
  allowlist, both directions of token cross-use, cross-branch PUT,
  PAID → THANKYOU → IDLE, and sign-out killing the display.
- **Browser evidence ACCEPTED by the owner (2026-09-23): 17/17 on the
  atc-noc isolated dev stack** (`~/vexo-connect-dev`, 127.0.0.1:5350/5351, 12
  migrations), run by session `7565dff8` — Run A 8/8 (this walkthrough,
  unmodified) and Run B 9/9 (quantity update, part payment without a
  thank-you, sign-out revocation). Source `1d5407b` (code ≡ `5ac675a`); every
  exercised code path is byte-identical to RC-1 `7faa9d6`. **Not a lab run and
  not full RC browser acceptance** — it did not run on the lab, nor against a
  stack built from RC-1, and the untested display behaviours stay listed as
  limitations in `docs/RELEASE-HANDOVER-CHECKLIST.md`, §VC-101 evidence.

## Commits

`7872e5b` API + tests · `2b34084` display screen, pair page, walkthrough ·
`5ac675a` the single marked Sell.jsx block (file owned by the Core
session; integrated by agreement).

Integrated into the lab RC `sprint/client-handover-rc` as replayed commits
`0a98c97` / `46b1940` / `ca0d983` / `3e9e4ec` under one `--no-ff` merge
`629461b`; the conditional drop at the freeze is `git revert -m 1 629461b`.
