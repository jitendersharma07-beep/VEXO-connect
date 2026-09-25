# Payments and POS peripherals — readiness

What is built, what is proven, and by what. One document; if something is not in
here it has not been done.

**Tested source identity.** The payment and peripheral work was built on branch
`x/payments` on top of `d5b1cb0`, and has since been merged onto `main` — which
by then carried the accounts lane — as the combined candidate. Every number in
this document was re-measured on that merge, not carried over from the lane.
Both commits are recorded at the bottom under "Delivered commit".

**Where the work was done.** On the POS host. The lane was built in
`~/vexo-connect-x-lanes/payments` against `vcx_payments{,_test,_shadow}`; the
merge was integrated and re-verified in `~/vexo-connect-x-lanes/int-payments`
against `vcx_payint{,_test,_shadow,_fresh,_pop}`, all on `127.0.0.1:5440`. No
production database, no `vexo-lab`, and no real customer transaction was
involved at any point.

The one external system touched is the Razorpay **test** account named in the
sandbox columns below, using credentials that live outside this repository. It
has now been **written** to as well as read: tier 3 below creates unpaid orders
of ₹1.00 on that test account. No live key is reachable by any of those scripts
— each refuses anything but an `rzp_test_` key before its first request — and no
payment was ever captured or refunded.

---

## 1. How to read the matrix

Several different things get called "tested", and conflating them is how a shop
ends up discovering at a counter that something was never tried. **Built** says
the code exists and is wired into a route or a command the product actually
calls; it is not evidence that anything works. Evidence is graded in five tiers,
kept separate and never merged:

| Tier | What it means | Where it stands |
| --- | --- | --- |
| **1 — Automated / simulator** | Covered by the test suite in this repository, run on this host, against simulated providers and devices. Proves our logic; proves nothing about anyone else's wire format or hardware. | **923 tests, all passing** on the tested SHA `d49b7b6`. §6 |
| **2 — Provider sandbox, reads** | Real Razorpay **test** account, over the network, GET only. Proves the provider's wire format really is what we assumed. | **9 checks, all passing.** §6 |
| **3 — Provider sandbox, writes** | Real Razorpay **test** account, creating real orders. Proves the provider *accepts* what we send, not merely that our stub echoes it. | **16 checks, all passing.** §6 |
| **4 — Physical device** | A physical card terminal, printer or cash drawer did the thing. | **Nothing in this document claims this.** §8, §9 |
| **5 — Live activation** | Real money, real customers, a `LIVE` credential on a production server. | **Not reachable.** §8 |

Tiers 1–3 are software verification and are done. Tier 4 needs hardware and, for
card terminals, a vendor SDK that does not exist in this build. Tier 5 needs
tier 4 plus a commercial onboarding. Neither is a coding task.

A specific consequence worth stating in the matrix' own terms: a simulator
passing tier 1 is **not** a working card or tap-to-pay integration. The only
terminal connector that runs in this build is a simulator, and it is labelled as
one in code, in the operator-facing catalogue and in §4.

---

## 2. Payment methods and tenders

| Capability | Built | Automated | Sandbox | Hardware |
| --- | --- | --- | --- | --- |
| Cash, with tendered/change | yes | yes | n/a | pending |
| Provider-confirmed UPI (online, webhook-settled) | yes | yes | yes — webhook leg proven 2026-09-22 | pending |
| Manually recorded UPI / card (cashier saw the customer's phone) | yes | yes | n/a | pending |
| Card, present, through a terminal | yes — shared backend only | yes, against a simulator | **no connector exists** | pending |
| Contactless / tap, through a terminal | yes — shared backend only | yes, against a simulator | **no connector exists** | pending |
| Tap-to-phone / SoftPOS | **no** — registered as unavailable, with its dependency stated | the refusal is tested | no | no |
| Wallets (provider-enabled) | yes — mapped to `OTHER` where the provider reports one | yes | partially — depends on what the account enables | pending |
| Payment links / hosted checkout handoff | yes | yes | yes | pending |
| Partial payments, several per bill | yes | yes | n/a | pending |
| Split tender — cash + digital on one bill | yes | yes | n/a | pending |
| Overpayment rules and change | yes | yes | n/a | pending |
| Full and partial refunds | yes | yes | yes — a genuine `refund.processed` settled a refund 2026-09-22 | pending |
| Reconciliation against provider settlement data | yes | yes | read paths proven 2026-09-25 | pending |

**The distinction the brief asks for, in the schema.** A payment carries four
independent columns, not one overloaded "type":

- `method` — CASH, CARD, UPI, WALLET, OTHER. *What instrument.*
- `channel` — MANUAL, GATEWAY, TERMINAL. *What route it came in by.*
- `entrySource` — MANUAL_ENTRY, PROVIDER_CONFIRMED, TERMINAL_CONFIRMED,
  RECONCILED. *Who says it happened.*
- `provider` + `accountId` — *whose merchant account it settles into.*

So a card payment a cashier typed in by hand (`CARD / MANUAL / MANUAL_ENTRY`)
and one a terminal confirmed (`CARD / TERMINAL / TERMINAL_CONFIRMED`) are
different rows with different evidence, on the same bill, for the same amount,
on the same day. A database CHECK constraint stops the two from being mixed up —
a GATEWAY row cannot claim MANUAL_ENTRY. `tests/terminal.test.js` asserts the
pair is distinguishable rather than taking the columns' existence on trust.

---

## 3. Payment attempts, recovery and the uncertain cases

| Requirement | Built | Automated | Sandbox |
| --- | --- | --- | --- |
| One live attempt per bill; a second request resumes the first | yes | yes | n/a |
| Idempotency key per attempt, unique per order | yes | yes | n/a |
| Provider reference mapped to company, store, terminal, order and amount | yes | yes | yes — the receipt we sent reads back off the provider's own record |
| PENDING / SUCCEEDED / FAILED / CANCELLED / **UNCERTAIN** outcomes | yes | yes | yes — an unpaid order reads PENDING, not success |
| Authenticated callbacks, signature verified against the right tenant's secret | yes | yes | yes — a genuine delivery applied 2026-09-22 |
| Amount and currency checked on the callback before anything is written | yes | yes | n/a |
| Server-side status verification, not the browser's word | yes | yes | yes |
| Duplicate callbacks | yes — unique index on `(provider, eventId)` | yes | n/a |
| Delayed and out-of-order callbacks | yes | yes — a declined-then-cash-then-late-success sequence ends with one payment | n/a |
| Network interruption recovery that does not re-charge | yes | yes | n/a |
| Status enquiry that cannot double-post | yes | yes | n/a |
| Refund limits — cumulative, against the remaining refundable amount | yes | yes | yes |

**What "uncertain" means here, because it is the whole point.** When a reader or
a provider cannot say whether a card was charged, the attempt is recorded as
UNCERTAIN, the bill's amount due does not move, no payment row is written, and
the cashier is told in words:

> The reader could not say whether this card was charged. Do NOT record this
> payment by hand — ask the customer to check their statement, or run the status
> check again.

There is no code path that converts an uncertain digital attempt into a
successful manual payment. A terminal timeout writes nothing. A browser success
screen writes nothing — only a verified provider callback or an explicit
server-side status enquiry does, and the enquiry refuses to settle unless the
provider names the charge.

**Two failure modes are deliberately kept apart** and are tested separately,
because they have different correct responses: "we could not ask" (the reader is
unreachable — `502`, nothing changes, retry later) and "we asked and it does not
know" (UNCERTAIN — stop, escalate to a human).

---

## 4. Providers and connectors

The adapter contract is one shape for both surfaces: `startPayment` / `getStatus`
/ `cancel` / `createRefund`, with **capabilities declared per provider**, not
inferred from which methods happen to be defined.

### Online gateway — Razorpay

| Path | Automated | Sandbox |
| --- | --- | --- |
| `createSession` (open a payable order) | yes | yes — 2026-09-22, predecessor repo |
| `verifyWebhook` (settle from a callback) | yes, 53 tests | yes — genuine `payment.captured` applied |
| `createRefund` | yes | yes — genuine `refund.processed` settled |
| `getStatus` (status enquiry) | yes | **yes — 2026-09-25, 9/9, this tree** |
| `fetchSettlement` (reconcile) | yes | **yes — 2026-09-25** |
| `verifyCredentials` (does this key work?) | yes | **yes — 2026-09-25, including a wrong secret rejected for the stated reason** |
| `cancel` | **not offered** — Razorpay publishes no endpoint that voids an order. `capabilities.cancel` is `false`. Nothing was invented to fill the gap. |

Re-run the read probe at any time; it is read-only, moves no money, and prints
verdicts rather than evidence:

```
node backend/scripts/razorpay-sandbox-read-probe.mjs [path/to/sandbox.env]
```

**Not yet proven against the account:** taking a sandbox payment through a
*tenant-configured* merchant account. The write paths were verified when
credentials came from the environment; this tree changed them to come from the
tenant's own row. The routing is covered by tests, not by the provider.

### Card terminals — nothing is enabled, and nothing can be

`backend/src/lib/terminal/index.js` registers four vendor connectors. Every one
of them declares `available: false`, every capability `false`, and a sentence
naming exactly what it is waiting for:

| Connector | Waiting on |
| --- | --- |
| Pine Labs | integration documentation, merchant credentials and a test device |
| Ezetap | integration documentation, merchant credentials and a test device |
| Mswipe | integration documentation, merchant credentials and a test device |
| SoftPOS (tap to phone) | a certified tap-to-phone SDK and its per-device-model certification |

Calling one raises `CONNECTOR_UNAVAILABLE` and names the vendor and the
dependency. `GET /api/devices/reader-connectors` returns the same list, so the
gap is visible in the product rather than only in the source.

**The only connector that runs is a simulator**, it is named `sim`, it is
labelled a simulator in the catalogue, and `config/env.js` throws at boot if
`NODE_ENV=production` names it. It is not a provider integration and this
document does not present it as one. What it proves is the shared backend: the
attempt lifecycle, the idempotency, the races, the uncertain handling — all of
which is vendor-independent and all of which is done.

**Having Razorpay working does not give a shop card-present acceptance.** The
online checkout integration collects money through a browser or a payment link.
It does not drive a terminal, read a chip or accept a tap. Those need a terminal
connector, a device, and that vendor's certification, which is a different
integration with different hardware. `capabilities.cardPresent` and
`capabilities.contactless` on the Razorpay adapter are both `false` for exactly
this reason.

### Merchant credential isolation

Credentials are stored per company, and optionally per store, in
`PaymentProviderAccount`:

- The key secret is encrypted at rest with `POS_PAYMENT_SECRET_KEY`. It is
  write-only over the API — it never comes back in a response, a list, or an
  audit row. The audit row holds a fingerprint, which is enough to prove two
  accounts differ or that a rotation changed something.
- Resolution runs store → company, and a store row **ends the search** even when
  it is switched off. "This outlet stopped taking online payments" and "this
  outlet's money now goes to head office" are different instructions and only
  one of them was given.
- A stored account is **inactive until an operator switches it on**, after
  checking the provider's dashboard. A half-configured account cannot start
  taking payments by accident.
- A tenant with an inactive account does **not** fall back to the deployment's
  shared environment credentials. That fallback exists only for a tenant that
  has configured nothing at all — which is the single-account deployment. This
  is the specific failure the brief names, and it is closed by a test with a
  negative control.
- A webhook signed with tenant B's genuine secret cannot settle tenant A's
  attempt. It answers with the same wording as a reference that does not exist,
  so the reply does not confirm that another tenant holds it.
- A `LIVE`-mode account refuses to resolve on a server that is not production.

---

## 5. Cash drawer and peripherals

Built on the existing Store Agent, not a second agent. The drawer channel rides
the same `/api/print-agents` mount, so a shop keeps one base URL and one
credential for both queues.

| Requirement | Built | Automated | Hardware |
| --- | --- | --- | --- |
| Company / store / till / device binding | yes | yes | pending |
| Capability check before a command is queued | yes | yes | pending |
| Authenticated commands with unique ids, expiry and audit rows | yes | yes | pending |
| Drawer opens tied to a committed cash receipt or an authorised cash refund | yes | yes | pending |
| Permission-controlled manual open, with a stored reason | yes | yes | pending |
| **No** automatic open for card/UPI payment, KOT print, or receipt reprint | yes | yes | pending |
| Repeated clicks collapse to one command | yes — unique `(branchId, idempotencyKey)` | yes | pending |
| Duplicate delivery to the agent | yes — claim/lease | yes | pending |
| Cross-store commands refused | yes | yes | pending |
| Honest status for unsupported / disconnected / failed / uncertain | yes | yes | pending |

**Acknowledgement is not confirmation.** The agent reporting that it drove the
pin is a claim about the printer, not about the drawer. The status vocabulary
says so in words:

- `ACKNOWLEDGED` — *the printer accepted the pulse; this printer has no drawer
  sensor, so whether the drawer actually opened is not known.*
- `ACKNOWLEDGED_NOT_OPENED` — *the printer accepted the pulse but the drawer
  sensor did not report the drawer open.*

Only a supported sensor produces a confirmed-open. An uncertain or expired
command is **not replayed** when the agent reconnects — it is left for a human,
because a drawer that springs open ten minutes later next to an unattended till
is worse than one that did not open.

**Hardware settings are bounded, not free-form.** There is no column holding raw
bytes and no shell execution anywhere in the path. The stored profile chooses:

- a **pin**: 2 or 5, the two the connector carries. Nothing else is accepted.
- an **on-duration**: 10–200 ms. ESC/POS would accept up to 510 ms; a drawer
  solenoid is a coil sized for a brief pulse, and holding it longer cooks the
  coil.
- an **off-duration**: 10–510 ms. This one is a wait, not a current, so it keeps
  the protocol's full range.

The wire command is the ESC/POS generalised pulse `ESC p m t1 t2`. There is no
unauthenticated drawer endpoint: every route requires an authenticated POS user
with `drawer.open`, or an enrolled agent presenting its own credential.

### Permissions

Four new action keys, so that taking cash and re-pointing settlements are
separate authorities:

| Key | Who has it by default |
| --- | --- |
| `payment.account.read` | Finance, Regional Manager, Branch Manager, and above |
| `payment.account.write` | the tenant's own administration only |
| `drawer.open` | anyone who may record a payment, cashiers included |
| `drawer.open.manual` | Branch Manager and above — **not** cashiers |

Finance reads the merchant configuration because reconciling settlements means
knowing which account they landed in. It holds neither drawer key: a Finance
login cannot open a till.

`drawer.open` rides with `payment.record` deliberately: a cashier taking notes
must be able to open the till to put them in, and a permission model that says
otherwise is one the shop works around by wedging the drawer open. Opening the
till with *no sale behind it* is the movement worth authorising separately, and
that is `drawer.open.manual`.

---

## 6. Test evidence

### Tier 1 — the combined regression gate

The whole suite on **`d49b7b6`**, the tested SHA, on this host, against
`vcx_payint_test`, on 2026-09-25. Run twice on that same commit:

```
run 1                            run 2
Test Files  32 passed (32)       Test Files  32 passed (32)
     Tests  923 passed (923)          Tests  923 passed (923)
  Duration  210.35s                 Duration  195.55s
```

**923 passed, 0 failed, 0 skipped**, both times. That is this lane's 761 plus
the accounts lane's files, with nothing lost on either side: 32 files and the
per-file counts sum to exactly 923. Nothing is skipped — vitest prints a
separate `skipped` tally when anything is, and neither run has one. The only
occurrence of the word in either log is inside a *passing* test's name,
`globalLimiter skipped (NODE_ENV=test at load)`.

The gate had already passed on the merge commit `54a55f3`, before the tier-3
probes and this document's corrections were committed. It was re-run on
`d49b7b6` rather than carried forward, so that the SHA recorded here is the SHA
actually tested and not its parent.

An earlier run reported the same 923 but printed `[test-db-lock] LOST the lock
mid-run — results are not trustworthy, re-run alone` partway through, so it was
**discarded rather than reported**. The runs above hold the advisory lock for
their whole duration, and that is not taken on trust in either direction:

- run 2's complete output was captured to a file, and the only `[test-db-lock]`
  lines in it are `acquired as vcx-test-lock:2147196` and `emptied 61 tables`.
  There is no loss note anywhere in it — absence at the tail would have proved
  nothing, because the heartbeat prints mid-run.
- `pg_stat_activity` was sampled every two seconds across both runs (341 and
  343 samples). The only `vcx-test-lock:*` identity on the database in each was
  that run's own — `2124111`, then `2147196`, the latter matching the
  `acquired as` line exactly. A competing run registers that name *before* it
  takes the lock, so a second participant would have appeared in the samples
  whether or not it won the lock.

The cause of the discarded run's report was not established and is recorded in
§8 as a tooling item. What matters here is that the gate of record is one whose
own harness did not disown it.

The 105 tests this lane added are:

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/terminal.test.js` | 49 | connector availability, attempt lifecycle, one-live-attempt, multi-till races, uncertain outcomes, mixed tenders, card-present refunds, tenant isolation, permissions |
| `tests/drawer.test.js` | 33 | binding, capability checks, command expiry, duplicate clicks and deliveries, cross-store refusal, disconnected agents, manual-open permission and reason, no-auto-open rules |
| `tests/paymentAccounts.test.js` | 23 | credential storage and secrecy, store-over-company resolution, inactive accounts, environment fallback confinement, cross-tenant webhooks, permissions, credential verification |

Existing suites carrying the gateway: `tests/razorpay.test.js` (53),
`tests/razorpayFlow.test.js` (32).

#### The five behaviours, named individually

The gate's default reporter prints only slow tests, so "923 passed" is an
aggregate and not evidence for any particular claim. The four behaviour-bearing
suites were therefore re-run with `--reporter=verbose` — **137 passed, 0
failed** — so each of these is a named passing line in a run log rather than an
inference:

| Behaviour | Proven by | Its control |
| --- | --- | --- |
| The right tenant's and store's merchant account is selected | *binds an attempt to its OWN company's account*; *prefers the store account over the company one*; *uses the environment pair only for a tenant that has configured nothing* | the three are mutually exclusive: each asserts the other two did **not** happen |
| An inactive or missing account cannot borrow another merchant's credentials | *does NOT climb past a switched-off store account to the company one*; *refuses outright rather than falling back to the shared environment pair*; *does not start taking payments the moment a credential is stored*; *refuses to settle A's attempt on a delivery signed with B's secret* | *still honours the deployment-wide secret for a tenant with no account* — the fallback does exist, so refusing it above is a decision and not an outage |
| Duplicate, delayed and out-of-order callbacks do not duplicate settlement | *applies a redelivered capture exactly once*; *applies a capture redelivered under a NEW event id exactly once too*; *stores a refund.processed that arrives before the reference was recorded*; *ignores a payment.failed that arrives after the capture*; *will not settle a refund twice, however often refund.processed arrives*; *polling twice cannot pay twice*; *two tills polling the same attempt at the same instant record it once* | *records refund.created without settling anything*, and *does not settle on payment.authorized* — events that must land and change nothing |
| An uncertain terminal outcome stays unresolved until something verifies it | *leaves an UNCERTAIN attempt open, unresolved, and says so in words*; *an unreachable reader changes NOTHING about the attempt*; *never treats a word it does not recognise as approval*; *refuses to record a success the reader would not name a charge for*; *an UNCERTAIN attempt that later turns out to have been charged is still recorded once* | *reports PENDING while nobody has presented a card* — the same path reaching a definite answer |
| A retried drawer command cannot fire a second pulse | *a double-clicked cash sale is one command*; *five sequential clicks are still one command*; *a replayed claim returns the same commands rather than leasing them twice*; *an expired command is EXPIRED, and an agent reconnecting later never gets it*; *a lease that runs out is UNCERTAIN, never back in the queue*; *a confirmed command is not re-fired for the same sale either*; *a failed delivery is FAILED and is never retried on its own* | *a command still in date is dispatched — the control for the next test*, and *two genuinely different manual opens are two commands* — suppression is not the answer to everything |

The drawer row has a second control that matters more than the rest: *an agent
claiming a drawer opened cannot make it so without a declared sensor*. An
acknowledgement is recorded as an acknowledgement. Only a declared sensor
promotes it to "opened", and *with a declared sensor, open and not-open are told
apart* is the pair that shows the sensor path is real rather than always-true.

### Tier 2 — provider sandbox, reads

Against the real Razorpay test account, re-run from the merged tree on
2026-09-25: **9 checks passed, 0 failed.** GET only.
`scripts/razorpay-sandbox-read-probe.mjs`.

Its load-bearing control: `verifyCredentials` is asked with a deliberately wrong
secret and must come back false **for the stated reason** that Razorpay rejected
the credentials. "Rejected" and "could not be asked" are different answers, and a
function returning `{ok:true}` unconditionally would have passed the positive
check alone.

### Tier 3 — provider sandbox, writes

New in this integration, and the tier the delivery had listed as unproven.
Against the real Razorpay test account on 2026-09-25: **16 checks passed, 0
failed.** `scripts/razorpay-sandbox-write-probe.mjs`. Three unpaid orders of
₹1.00 are created per run; nothing is captured or refunded.

What it establishes that the stubs could not:

- `createSession` creates an order Razorpay accepts, and the **amount in paise,
  the currency, our receipt and the `pos_order_id` note all round-trip onto the
  entity** — so a settlement arriving later can be traced back to its bill.
- A fresh order reads back as unpaid: `getStatus` answers `PENDING` and
  `fetchSettlement` answers unsettled **with a reason** rather than throwing.
- A create whose answer was lost **adopts the order already under its receipt
  instead of posting a second one**, and exactly one order exists afterwards.
- Two orders under one receipt is a state Razorpay permits, and the adapter
  **raises rather than picking one** — and does not report that as a provider
  refusal, so no reserved money is released on it.
- A create Razorpay refuses is classified as refused, carrying the provider 4xx
  that is the evidence for the claim, and is not marked retryable.

The last two are the ones worth having: `providerRefused` is the flag
`orders.js` decides an intent's fate on, and it is now measured true when the
provider really refused and false when the provider never answered.

**A defect this tier found, which no stub could have.** Razorpay's
`GET /v1/orders?receipt=` is a *lagging* index. Fetch-by-id answers immediately,
but the same order does not appear under its own receipt for **7.7 s, 16.0 s,
30.0 s and 32.8 s** across four samples, with no ceiling established.
`findOrderByReceipt` runs immediately after the failed POST it is recovering
from, so in practice it returns nothing and the original error is rethrown.

No retry loop was added, and that is a deliberate choice rather than an omission:
waiting an unbounded index out would hold a cashier at the till at the one moment
the payment has already gone wrong. The failure is in the safe direction and
stays there — the intent is left open with `providerRef` null, so nothing is
recorded as settled, and the customer is never handed the unseen order's id, so
the orphan cannot be paid. What it costs is an unpaid order left at Razorpay,
which wants a reconciliation sweep somewhere waiting is free. That is item 1 in
§8.

### Migrations

Migrations reproduce the schema with no drift — verified on the merge by diffing
the applied migrations against the Prisma schema on a throwaway shadow database,
which returned an empty migration. Two rehearsals were run on isolated
databases, neither of them the one the tests use:

- **Fresh** (`vcx_payint_fresh`, dropped and recreated first): all 27 migrations
  applied from empty, this lane's three last. Migration numbering needed no
  renumbering — they sort after the accounts lane's, so history stays
  append-only and nothing already applied was rewritten.
- **Populated** (`vcx_payint_pop`): main's 22 migrations applied first, then four
  payment cases seeded in raw SQL, money fingerprinted, then this lane's three
  migrations applied on top. **16 of 16 properties held.** The payment and refund
  digests were byte-identical before and after, so the backfill moved no money;
  a cash receipt stayed `MANUAL_ENTRY`, a cashier-typed card payment stayed
  `MANUAL_ENTRY`, a webhook-evidenced one became `PROVIDER_CONFIRMED` and a
  recovery-evidenced one became `RECONCILED` — the two gateway rows distinguished
  rather than stamped alike — and the new CHECK constraint came out `convalidated
  = t`, so it was proven against the existing rows and not merely trusted.

  The populated rehearsal carries a positive control, because it needs one: a
  staging mistake that applies *nothing* reads exactly like a database already up
  to date. It asserts the pre-state tables exist before seeding. That control
  fired during development and caught precisely that — Prisma does not follow a
  symlinked migration directory, and reports "No pending migrations to apply"
  when handed one.

Two things worth naming because they were found by these tests rather than by
reading the code:

1. An owner could not see or edit a **store-scoped** merchant account. Prisma
   renders `{}` inside an `OR` array as a term matching nothing, so the route's
   scope filter collapsed to "company-wide rows only" and returned `404` for a
   row that was plainly the owner's. Measured with a throwaway probe, then
   fixed in `src/api/routes/paymentAccounts.js`.
2. Three new suites aborted in the full run but passed alone, because their
   database reset did not clear a table an *earlier* suite had filled. Passing
   in isolation is not passing.

---

## 7. Setting it up

### 7.1 Database

```bash
cd backend
npx prisma migrate deploy
```

Three migrations belong to this work and are additive — no applied migration was
edited:

```
20260924900000_payments_enum_values
20260924900100_payments_and_peripherals
20260924900200_terminal_reader_binding
```

Run them and the schema change together; a deploy that ships the code without
the migration will fail at the first payment.

### 7.2 Environment

Nothing here is required to *start* the server. Each variable switches on a
capability, and the shipped state with all of them unset is a deployment that
takes cash and refuses everything else with an honest reason.

| Variable | Effect if unset | Notes |
| --- | --- | --- |
| `POS_GATEWAY_PROVIDER` | no online payments; `/api/gateway` is not even mounted | `razorpay` in production |
| `POS_GATEWAY_KEY_ID` / `POS_GATEWAY_KEY_SECRET` | single-account deployments have no credentials | ignored for any tenant that configures its own account |
| `POS_GATEWAY_WEBHOOK_SECRET` | callbacks cannot be verified, so none are accepted | per-account secrets take precedence |
| `POS_PAYMENT_SECRET_KEY` | per-tenant merchant accounts cannot be stored at all — the API refuses rather than storing plaintext | **64 hex characters (32 bytes).** Validated at boot; a truncated paste fails to start instead of failing at a counter |
| `POS_TERMINAL_PROVIDER` | terminal routes refuse with `NOT_CONFIGURED` | no real value exists yet — see §8 |

Generate the encryption key:

```bash
openssl rand -hex 32
```

Store it wherever this deployment keeps its other secrets. **It is not
recoverable**: losing it means every stored merchant credential must be
re-entered. Rotating it requires re-entering them too — there is no re-wrap path
and deliberately so, since one would need both keys live at once.

### 7.3 Per-tenant merchant account

Once, per company, by someone holding `payment.account.write`:

1. `POST /api/payment-accounts` with the provider, mode (`TEST` or `LIVE`), key
   id, key secret and — optionally — a `branchId` to scope it to one store.
2. `POST /api/payment-accounts/:id/verify`. This asks the provider whether the
   credentials authenticate. It stamps a verification only on a yes; a "could
   not ask" is recorded as a note and not as a pass.
3. `PATCH /api/payment-accounts/:id { "active": true }`. Until this, the account
   settles nothing. Do it after confirming on the provider's dashboard that the
   key belongs to this shop.

Changing the key id, secret or mode clears the verification stamp. A green tick
next to a credential that was replaced underneath it is worse than no tick.

### 7.4 Cash drawer

1. Enrol the Store Agent as usual — same base URL and credential as printing.
2. Register the drawer against a printer under
   `PATCH /api/drawer/targets/:id`, choosing pin `2` or `5` and an on-duration
   between 10 and 200 ms. Start at pin 2 and 50 ms; that throws every mechanism
   we have notes for.
3. Grant `drawer.open.manual` to whoever is allowed to open the till without a
   sale. Cashiers do not get it by default.

### 7.5 Card terminal

Not configurable. `POS_TERMINAL_PROVIDER` has no valid production value, because
no vendor connector has been implemented — see §8.

---

## 8. What is still needed, and from whom

Items 1–3 are work in this repository. Everything from 4 onwards is outside it —
a credential, an approval, an SDK or a piece of hardware — and no amount of
coding moves them.

### In this repository

1. **A reconciliation sweep for orders created by a lost create.** Established by
   measurement in §6, tier 3: Razorpay's receipt index lags a create by seconds
   to tens of seconds, so the inline recovery in `findOrderByReceipt` usually
   misses and leaves an unpaid order at the provider. Nothing is mis-settled and
   the orphan cannot be paid, so this is tidiness and reconciliation rather than a
   money bug — which is why it is not being fixed inline, where the wait would be
   charged to a cashier standing at a till. The sweep wants to run somewhere
   waiting is free: for each intent left open with `providerRef` null and a
   `failureReason`, look the receipt up once the index has caught up, and either
   adopt the single order found or record the ambiguity.
2. **One sandbox payment through a tenant-configured account.** Tier 3 proves the
   write paths with credentials handed to the adapter directly; the resolution
   from a tenant's stored row is proven only at tier 1. Closing this needs
   somebody to open Checkout on a test tenant and pay it with a test card. It is
   the cheapest outstanding item and it needs no new access. Until it is done,
   **automatic capture remains intended-but-unconfirmed** — the Orders API does
   not echo the capture settings back, so acceptance of them is not evidence they
   are honoured, and the only proof is a real payment arriving as
   `payment.captured` rather than `payment.authorized`.
3. **The `[test-db-lock] LOST the lock mid-run` report in `tests/globalSetup.js`
   is not trustworthy as a signal.** It fired once (§6) on a run where no
   competing run existed, and did not reproduce. The heartbeat asks whether
   *this backend* holds the lock via `pg_backend_pid()`, so a pool that reconnects
   reports a lost lock indistinguishably from a lock genuinely taken by someone
   else. Both are worth knowing and they are not the same thing. This is shared
   test tooling that arrived with the accounts lane and is deliberately left
   untouched here rather than changed inside a payments integration.

### Provider credentials and onboarding

4. **Razorpay live merchant onboarding**, per customer whose settlements must go
   to their own bank account. Sandbox is proven, reads and writes both; live is a
   commercial and KYC step, not a technical one.
5. **Which wallets and payment methods each merchant account enables** — this is
   a dashboard setting per account, and it decides what the wallet row in §2
   actually means for a given shop.

### Card terminal — the largest gap

There is **no terminal-provider adapter in this build.** Pine Labs, Ezetap and
Mswipe are registered as connectors that each refuse and name their missing
dependency; the only connector that runs is a simulator, and it is labelled one.
Nothing below is optional if physical card or tap acceptance is wanted.

6. **A vendor decision.** Which one a customer uses is usually decided by their
   acquiring bank, so this is a commercial choice first.
7. **That vendor's integration documentation**, which is generally released only
   under a partner agreement and is not publicly available.
8. **That vendor's device SDK or local-network protocol specification** — the
   thing an adapter is actually written against. This is the single missing input
   that makes items 6–10 a sequence rather than a shopping list.
9. **Merchant credentials for that vendor**, separate from Razorpay's.
10. **A physical test device of the exact model** the shops will use. Terminal
    SDKs differ per model, not just per vendor.
11. **Certification**, where the vendor requires it before a device may run a
    third-party integration.

Until 6–11 exist, the shared backend is complete and the vendor adapter is a
stated dependency rather than a stub pretending to work.

### SoftPOS / tap-to-phone

12. **A certified tap-to-phone SDK licence**, plus **per-device-model
    certification**. This is a separate certification regime from the terminal
    SDKs above and is usually the slowest item on this list.

### Hardware for physical acceptance

13. A **receipt printer** with a drawer connector — exact model, for the pulse
    profile.
14. A **cash drawer** with the matching cable, and whether it is wired to pin 2
    or pin 5.
15. Whether that drawer has an **open sensor**. Without one, the product can
    only ever report "the printer accepted the pulse", and the §5 status
    vocabulary is the honest ceiling.
16. A **card terminal**, once 6–11 are settled.

### Then, and only then

17. **Physical acceptance** — §9.
18. **Live payment acceptance**: switch a verified account to `LIVE` mode on a
    production server, and take one real payment under supervision with a
    refund rehearsed. Not reachable until 4 and 17 are done.

No secret, key, or credential appears anywhere in this document or in this
repository. The Razorpay test credentials the sandbox probe reads live outside
the repository in a `0600` file, and the probe refuses to run on a live key and
prints verdicts rather than values.

---

## 9. Physical acceptance checklist

To be run once with the actual hardware on a counter, by someone who can see the
drawer and hold a card. Each line is a yes/no with a witness.

**Cash drawer**

1. Take a cash payment. The drawer opens once.
2. Click the pay button five times fast. The drawer opens **once**, not five
   times.
3. Take a card payment. The drawer does **not** open.
4. Print a KOT. The drawer does **not** open.
5. Reprint a receipt. The drawer does **not** open.
6. Manual open as a manager, with a reason. The drawer opens; the reason and the
   operator are on the audit trail.
7. Manual open as a cashier. Refused.
8. Unplug the Store Agent's network. Request an open. The product says the
   device is unreachable — it does not claim the drawer opened.
9. Reconnect. The expired command is **not** replayed; the drawer stays shut.
10. Send a drawer command for store A from store B. Refused.
11. If the drawer has a sensor: hold the drawer shut and pulse it. The status
    reads `ACKNOWLEDGED_NOT_OPENED`, not a success.

**Card terminal** (only once a vendor connector exists)

12. Tap a card. The amount on the reader matches the bill.
13. Complete it. Exactly one payment lands on the bill, as
    `CARD / TERMINAL / TERMINAL_CONFIRMED`.
14. Decline a card. The bill's amount due does not move.
15. Start a payment and pull the reader's power mid-transaction. Run the status
    check. The product either names the outcome or says UNCERTAIN — it must
    never record a payment on a timeout.
16. If it says UNCERTAIN: confirm on the vendor's dashboard whether the card was
    charged, then reconcile by hand. Do not record it as a manual payment.
17. Cancel an attempt before the customer taps. The reader clears.
18. Refund a card-present payment. The remaining refundable amount falls by
    exactly that much and will not go below zero.

**Receipt and reports**

19. The receipt shows the split tender correctly for a cash + card bill.
20. Daily closing counts the terminal payment in the right bucket, and a
    manually recorded card payment in a distinguishable one.
21. Cash-in-drawer expected on the day close matches what is physically counted.

---

## Delivered commit

| | |
| --- | --- |
| Lane branch | `x/payments`, built from `d5b1cb0` |
| Lane delivered | `1703cd6` — "Complete the payment and peripheral backend, and separate what each tender proves" |
| Lane head | `86a6762` |
| Merged onto | `584de37` on `main`, which carries the accounts lane |
| Merge commit | `54a55f3` — "Merge x/payments into main: tenders that say what confirmed them, and a drawer that admits what it does not know" |
| Integration branch | `x/payments-integration` |
| Verification commit | `d49b7b6` — "Verify the payment integration against the real provider, and correct what the sandbox disproved" |
| **Tested SHA** | **`d49b7b6`** — 32 files, 923 tests, 0 failed, 0 skipped, run twice (§6) |

The tested SHA is `d49b7b6`. The commit after it changes only the three lines of
this table and the tier-1 paragraphs in §6 that name the SHA — no source, no
schema, no test. It could not be tested before it existed, and re-testing to
record a third SHA would only move the problem along by one commit.

Two conflicts, both additive, resolved by keeping both sides: `config/env.js`,
where the accounts lane's SMTP block and this lane's payment-secret and
terminal-connector keys were appended at the same point and both boot-time
validation blocks shared one closing brace; and `schema.prisma`, where `Company`
gained relations from both lanes and both appended models to the end of the file.
`app.js`, `permissions.js` and `tests/phase2.test.js` merged without conflict and
were checked rather than assumed — all 46 permission keys survive, every payment
route is still mounted, and `prisma migrate diff` reports an empty migration.

Two contracts were checked against the newer `main` and deliberately left alone:
licensing already gates every `/api` route through `rbac.js`'s `licenseUsable`
call, so the payment routes inherit it; and `licenseHasModule` has no callers, so
there is no payments entitlement to honour and inventing one would be a guess.
