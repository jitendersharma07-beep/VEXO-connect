# Integration verification — Swiggy, Zomato, Reelo, TallyPrime

Lane `x/providers`. Date: 2026-09-24. Worktree
`/home/atc-noc/vexo-connect-x-lanes/providers`.

**Nothing in this lane has been merged, pushed, deployed or activated against a
live provider account.** No provider has been called. No customer has been
enrolled, credited, debited or messaged.

This document separates five things that are routinely collapsed into the word
"done". A provider can be fully implemented and tested and still be worth
nothing, because nobody has the credentials.

| | Meaning |
|---|---|
| **Implementation** | The code exists in this worktree and does what the provider's published documentation describes. |
| **Provider-account access** | The client's credentials for that provider are in hand. |
| **Automated test** | Executed vitest coverage in this lane, against the lane's own database. |
| **Provider sandbox** | A request has been made to the provider's own test environment and the provider answered. |
| **Live activation** | Switched on for real traffic. Requires the owner. |

---

## 1. The verdict, per provider

| Provider | Implementation | Provider-account access | Automated test | Provider sandbox | Live activation |
|---|---|---|---|---|---|
| **Swiggy** | BLOCKED | BLOCKED | n/a | NOT STARTED | NOT STARTED |
| **Zomato** | IMPLEMENTED-UNVERIFIED | BLOCKED | ACCEPTED | NOT STARTED | NOT STARTED |
| **Reelo** | IMPLEMENTED-UNVERIFIED | BLOCKED | ACCEPTED | NOT STARTED | NOT STARTED |
| **TallyPrime** | IMPLEMENTED-UNVERIFIED | BLOCKED | ACCEPTED | NOT STARTED | NOT STARTED |

No row says ACCEPTED for implementation, and none can until a provider has
answered. "Automated test: ACCEPTED" means the tests listed in §6 ran and
passed — it is a claim about this code's behaviour against a deterministic test
adapter, and **not** a claim that any provider has ever accepted a request.

### Why the whole column of provider access is BLOCKED

Every one of these needs the **client's own** merchant credentials, which are
issued to the restaurant, not to the POS vendor. None were supplied. This is not
a code blocker and no amount of implementation work clears it.

---

## 2. Swiggy — refused, with the reason

Swiggy does not publish a partner/merchant POS API. What is publicly documented
is the **consumer** ordering surface and an internal partner portal; neither is a
merchant POS integration, and the task explicitly forbids treating the former as
the latter or scraping the latter.

The registry therefore records all seven Swiggy capabilities as `UNSPECIFIED`,
which makes `operable = false`, and the portal **refuses to render a settings
form at all** rather than offering boxes that save to nothing:

```
SWIGGY  operable=false  {"UNSPECIFIED":7}
```

Screenshot: `owner-02-swiggy-blocked.png`.

The page states the reason and lists the alternatives (Swiggy's own POS-partner
onboarding, or an aggregator middleware that already holds a Swiggy contract).
**This is the honest outcome and should not be "fixed" by inventing endpoints.**

---

## 3. Zomato

Documented: the partner order-push and status callbacks, addressed by path.
Zomato publishes **no signature scheme** for inbound callbacks, so inbound
authentication is a shared header value compared in constant time — that is the
whole of it, and the portal says so in as many words rather than implying a
signature is being verified.

```
ZOMATO  operable=true  {"PATH_ONLY":6,"NOT_OFFERED":2}
```

`PATH_ONLY` means the route and flow are documented but the exact request and
response bodies are not; those are confirmed against the client's account before
go-live. Menu push and settlement statements are `NOT_OFFERED`.

**Duplicate, delayed and out-of-order callbacks** are handled by storing every
inbound event under a unique `(connectionId, externalEventId)` and treating the
Prisma `P2002` collision as the detection, not as an error. A replayed callback
therefore cannot produce a second invoice, a second payment, a second kitchen
ticket or a second stock movement — §6 tests this directly rather than reasoning
about it.

---

## 4. Reelo — and the ~100,000 existing customers

**Identity confirmed: reelo.io**, the loyalty/marketing platform, reached through
its published POS integration collection. Not "Relo". The client's account is
the same product.

```
REELO  operable=true  {"SPECIFIED":6,"NOT_OFFERED":3}
```

Six capabilities are fully specified (customer lookup, balance lookup, bill sync,
redeem, reversal, sale return). Three are `NOT_OFFERED` and this shapes the whole
migration design:

- **`bulkExport: NOT_OFFERED`** — Reelo's POS API cannot produce the existing
  customer list. Therefore the historical migration is **file-based**: the client
  exports from their own Reelo account and uploads it here. There is no code path
  that scrapes or pages the provider's production API for 100,000 customers, and
  the task's prohibition on stress-testing the provider is satisfied by
  construction, not by restraint.
- **`bulkImport: NOT_OFFERED`** — nothing is pushed back to Reelo.
- **`webhooks: NOT_OFFERED`** — POS-initiated only.

### The preservation guarantees

The mandatory requirement is that existing customers and their balances survive.
What the importer does and does not do:

- It **records** each customer's current balance against the POS customer. It is
  a read of the file, and the numbers in the file are taken as the truth.
- It **does not enrol** anyone with Reelo, **does not send** any message, and
  **does not recalculate, reset or re-credit** a single point. The portal states
  this on the screen above the file picker (`owner-04-reelo-import.png`), because
  the person clicking it is the person who needs to know.
- **Duplicate profiles** are prevented by a unique link per
  `(companyId, provider, externalCustomerId)` and per `(companyId, customerId,
  provider)`. Re-running the same file is a no-op, not a second profile.
- **Repeated credits** are prevented because the import writes *balance
  snapshots*, never loyalty operations. There is no code path in the importer
  that issues a credit.
- **Unknown is not zero.** `publicBalance` returns
  `{ points: null, source: 'UNKNOWN' }` when the balance is not known. A customer
  whose row failed to import is never shown as having zero points — that
  distinction is the difference between "we don't know yet" and "we wiped it".

### Resumable, previewable, with exceptions

The run is batched (`BATCH_SIZE = 500`) with the cursor held as the last
committed row, so an interrupted import resumes from row N rather than from the
top. **Preview is the default and the real run requires typing
`IMPORT CUSTOMERS`.** Rows that cannot be imported are written to an exception
table with a reason and are downloadable — they are not silently dropped.

Scale is proven against **100,000 synthetic rows in the lane's private
database** (§6), never against Reelo.

---

## 5. TallyPrime

The documented and supported method: **XML over HTTP to the local TallyPrime
instance** (all releases), or native JSON on 7.0+, default port 9000, with the
company loaded. There is no cloud API. This is why the connector is a
locally-queued pusher and not a client of a remote service.

```
TALLY  operable=true  {"SPECIFIED":3,"PATH_ONLY":5,"NOT_OFFERED":1}
```

- **`idempotency: NOT_OFFERED`** — Tally publishes no idempotency key. Duplicate
  prevention is therefore held **on our side**: `AccountingPosting` is unique on
  `(connectionId, sourceType, sourceId, docType)`, so one bill can produce one
  sales voucher and no more, however many times the queue retries.
- **Stable external references.** Each posting carries the POS invoice number as
  its voucher reference, so a human can reconcile the two systems by eye and a
  re-send is recognisable.
- **Acknowledgements are distinguished from sends.** `SENT` means we wrote to
  Tally; `ACKNOWLEDGED` means Tally's response was parsed and confirmed the
  voucher was created. A connector that stops at `SENT` reports success for
  vouchers Tally rejected.
- **Never exposed to the internet.** `lanHost` refuses a URL scheme outright, so
  the host field cannot be pointed at a public address. The portal explains this
  under the field rather than silently rejecting input.
- **Operator-visible error queue.** Failures surface as sanitized provider text
  in "Queued work" with attempts, next attempt and a per-row retry
  (`owner-03-tally-error.png`).

### Settlement and totals

Provider totals are **not** recalculated. Where an aggregator's figures differ
from ours the difference is raised as an `IntegrationDiscrepancy` for a human to
resolve; nothing is silently adjusted to make the two sides agree.

---

## 6. Executed evidence

Exact commands and their results. Everything ran against the lane-private
database `vcx_providers_test` on 127.0.0.1:5440.

### Backend suite

```
bash /home/atc-noc/vcx-providers-local/vcxp test tests/integrations.test.js
```

Result: **Test Files 1 passed (1) · Tests 80 passed (80)**, duration 611.48s,
including the 100,000-row scale test (528.4s at 189 rows/s).

What the 80 tests cover, in the task's own terms:

| Requirement | Covered by |
|---|---|
| Tenant isolation | Cross-company reads and writes on every surface, each with a positive control proving the neighbour's own data *is* visible to them |
| Invalid authentication | Wrong header value, missing header, and a constant-time comparison path |
| Duplicate callbacks | Replayed events asserted to produce no second invoice, payment, kitchen ticket or stock movement |
| Retries after an outage | Queue backoff `[30s,60s,120s,300s,600s,30m,60m]`, `maxAttempts 8`, lock expiry at 5 min, DEAD state |
| Cancellations | Provider-initiated cancel after acceptance, and the refusal path when the order is already closed |
| Loyalty adjustments | Redeem, reversal and sale-return, plus the assertion that an unknown balance reads UNKNOWN and never 0 |
| Duplicate accounting postings | One bill → one voucher across repeated queue runs |
| Audit trail | Newest-first ordering, actor identity, tenant isolation, provider filter, and that **no credential material reaches the response** |

### Browser acceptance

```
node /home/atc-noc/vcx-providers-local/shootIntegrations.mjs /tmp/vcx-integrations-shots
```

Result: **56 checks passed, 0 failed; 8 distinct screenshots.**

Three role runs — `CUSTOMER_OWNER` (all eight actions), `BRANCH_MANAGER`
(read + job retry), `FINANCE` (read + discrepancy resolution) — each asserting
**both** directions: what the role may do is present, and what it may not do is
absent. A sentinel secret value is asserted absent from the whole rendered
document.

### Migration rehearsal

```
bash /home/atc-noc/vcx-providers-local/rehearseMigration.sh
```

Result: **REHEARSAL: PASS** (12 checks).

`vcxp migsql` proves the migrations reproduce `schema.prisma` on an *empty*
database. The rehearsal proves the part that actually breaks: this lane adds
`ALTER TABLE "Order" ADD COLUMN "channel" NOT NULL DEFAULT 'POS'`, so the
migrations are applied to a database **already populated** with two companies,
branches, users, customers and priced orders. Verified after the fact: order
count unchanged, order money byte-identical (357.00), every pre-existing order
backfilled to `channel = POS`, **no** pre-existing order attributed to a
provider, **no** loyalty links invented for existing customers, and a second
`migrate deploy` is a clean no-op.

### Schema drift

```
bash /home/atc-noc/vcx-providers-local/vcxp migsql
```

Result: `-- This is an empty migration.` — no drift between the migrations and
`schema.prisma`.

---

## 7. What is blocked, and on whom

| # | Blocked item | Blocked on | Not blocked on |
|---|---|---|---|
| 1 | Swiggy, in its entirety | Swiggy publishing a partner POS API, or the client holding a Swiggy POS-partner contract | Any work in this repo |
| 2 | Zomato request/response bodies (`PATH_ONLY` × 6) | The client's Zomato partner account and its documentation pack | — |
| 3 | Zomato inbound header value | The client's account | — |
| 4 | Reelo export format | One real export file from the client's Reelo account. The importer's column mapping is written against the documented shape and is **unconfirmed against a real file** | — |
| 5 | Reelo auth-header scheme | Written confirmation from Reelo. One documented request carries an auth-key header and the rest carry identity in the body; the portal makes the header optional and does not send it when blank | — |
| 6 | Reelo historical migration of ~100,000 customers | A Reelo-side export, which is a support/commercial request — their POS API cannot produce it | — |
| 7 | Tally voucher reconciliation | A reachable TallyPrime instance with the client's company loaded. Credit-note, receipt, purchase, GST and cost-centre tags must be confirmed from an **XML export of a real voucher** before those posting types are enabled | — |
| 8 | Tally ledger and voucher-type names | The client's chart of accounts | — |
| 9 | Live activation of anything | **The owner.** Production activation, live financial transactions, real-customer bulk imports and external messages are explicitly reserved | — |

---

## 8. Assumptions to confirm

Listed because the Product Master Specification v1.1 PDF was not available and
the conservative option was taken in each case.

1. Aggregator orders post to the **existing** order/payment/invoice ledger with a
   channel marker. No parallel money ledger was created.
2. An unmapped provider outlet holds its orders as a discrepancy rather than
   guessing a branch from the outlet name.
3. Reelo balances are authoritative on Reelo's side; the POS holds a snapshot and
   a link, not a second balance of record.
4. Tally postings begin from a configured `postFrom` date, so switching the
   connector on does not back-post the client's entire history.
