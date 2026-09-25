# Integration verification — Swiggy, Zomato, Reelo, TallyPrime

Lane `x/providers`. Date: 2026-09-24, revised 2026-09-25. Worktree
`/home/atc-noc/vexo-connect-x-lanes/providers`. Code under test: `a4de95d`,
the last code commit of the revision; this document is the commit after it.

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
| **Swiggy** | NOT STARTED | BLOCKED | n/a | NOT STARTED | NOT STARTED |
| **Zomato** | IMPLEMENTED-UNVERIFIED | BLOCKED | ACCEPTED | NOT STARTED | NOT STARTED |
| **Reelo** | IMPLEMENTED-UNVERIFIED | BLOCKED | ACCEPTED | NOT STARTED | NOT STARTED |
| **TallyPrime** | IMPLEMENTED-UNVERIFIED | BLOCKED | ACCEPTED | NOT STARTED | NOT STARTED |

No row says ACCEPTED for implementation, and none can until a provider has
answered. "Automated test: ACCEPTED" means the tests listed in §6 ran and
passed — it is a claim about this code's behaviour against a deterministic test
adapter, and **not** a claim that any provider has ever accepted a request.

Swiggy's implementation cell reads **NOT STARTED**, not BLOCKED-forever. The
first revision of this document said Swiggy was not integrable. That was wrong,
and §2 retracts it. Nothing has been built because the request and response
shapes are not published anywhere we can read — not because the route does not
exist.

### Why the whole column of provider access is BLOCKED

Three of these need the **client's own** merchant credentials, which are issued
to the restaurant, not to the POS vendor. None were supplied. This is not a code
blocker and no amount of implementation work clears it.

Swiggy is blocked one step earlier, and the difference matters when someone
plans the work: for Zomato, Reelo and Tally the contract is known and only the
credential is missing, so the day a credential arrives there is something to
point it at. For Swiggy the contract itself is unpublished, so a credential
alone would not be enough — a partner agreement or a middleware contract has to
come first. §7 lists both kinds in one place.

### 1.1 Capability matrix, corrected

Read out of `src/lib/integrations/providers.js` on 2026-09-25 rather than
transcribed, so this table and the running code cannot disagree. Four grades, and
the distinction between the middle two is the whole point of having them:

| Grade | Means |
|---|---|
| **SPECIFIED** | The provider documents the request and the response. We can build against it and know what we will get back. |
| **PATH_ONLY** | The provider offers the operation and we know the endpoint, but the field schema is behind a partner login. The gap is access, not capability. |
| **UNSPECIFIED** | We cannot see the contract at all. Not a statement that it does not exist. |
| **NOT_OFFERED** | The provider does not offer it. A statement about the provider, made only where the documentation is complete enough to support it. |

| Capability | Swiggy | Zomato | Reelo | TallyPrime |
|---|---|---|---|---|
| Receive orders | UNSPECIFIED | PATH_ONLY | — | — |
| Push order status | UNSPECIFIED | PATH_ONLY | — | — |
| Cancellation | UNSPECIFIED | PATH_ONLY | — | — |
| Callback signature | UNSPECIFIED | PATH_ONLY | NOT_OFFERED (no webhooks) | — |
| Menu push | UNSPECIFIED | PATH_ONLY † | — | — |
| Price update | — | PATH_ONLY † | — | — |
| Item availability / stock | UNSPECIFIED | PATH_ONLY † | — | — |
| Outlet online / offline | — | PATH_ONLY † | — | — |
| Settlement | UNSPECIFIED | **NOT_OFFERED** | — | — |
| Refunds | — | **NOT_OFFERED** | — | — |
| Customer lookup | — | — | SPECIFIED | — |
| Balance lookup | — | — | SPECIFIED | — |
| Bill sync | — | — | SPECIFIED | — |
| Redeem | — | — | SPECIFIED | — |
| Reversal | — | — | SPECIFIED | — |
| Sale return | — | — | SPECIFIED | — |
| Bulk export / import | — | — | **NOT_OFFERED** | — |
| Sales voucher | — | — | — | SPECIFIED |
| Ledger masters | — | — | — | SPECIFIED |
| Acknowledgement | — | — | — | SPECIFIED |
| Credit note · receipt · purchase | — | — | — | PATH_ONLY |
| GST breakup · cost centre | — | — | — | PATH_ONLY |
| Idempotency | — | — | — | **NOT_OFFERED** |

Counts, from the same read: `SWIGGY operable=false {UNSPECIFIED: 7}` ·
`ZOMATO operable=true {PATH_ONLY: 8, NOT_OFFERED: 2}` ·
`REELO operable=true {SPECIFIED: 6, NOT_OFFERED: 3}` ·
`TALLY operable=true {SPECIFIED: 3, PATH_ONLY: 5, NOT_OFFERED: 1}`.

**† offered by Zomato, not built here.** These four carry a separate
`notImplementedHere` note in the registry, kept apart from the grade so the two
are never read as one thing. Zomato offers them; this lane has not implemented
them. Recording that as `NOT_OFFERED` — which the first revision did — blames the
provider for our gap and, worse, tells the next engineer not to bother looking.

The three grades that are genuinely claims *about a provider* are the four bold
`NOT_OFFERED` cells, and each is argued in place: Zomato settlement and refunds
in §3, Reelo bulk export in §4, Tally idempotency in §5. Every other cell is a
statement about what we can currently see or have currently built.

---

## 2. Swiggy — blocked on access, not impossible

**A previous revision of this document said Swiggy "does not publish a
partner/merchant POS API" and headed this section "refused". That was a blanket
conclusion drawn from the absence of public documentation, and it is withdrawn.**
Absence of published documentation is evidence about what a vendor puts on the
open web. It is not evidence about what exists behind a partner agreement, and
stating the second while having only measured the first is the kind of error that
gets a real integration cancelled.

What is actually established, and how strongly:

| Claim | Strength |
|---|---|
| Swiggy publishes no first-party POS/merchant API documentation on the open web | **Verified.** Searched; nothing found. This is the only first-party finding |
| A Swiggy third-party order-management API for POS vendors *exists* | **Attested, not published.** A former Swiggy API product manager's public account describes building it — order APIs, a cloud menu API, staging accounts, partner support. Dated, and not first-party documentation |
| The route is real and in commercial use | **Corroborated.** Middleware vendors document Swiggy as an upstream channel they already integrate, which they could not do without one |
| The wire contract — endpoints, auth, payload shapes | **Unknown.** Nothing here. This is why every Swiggy capability stays `UNSPECIFIED` |

So the registry still reads:

```
SWIGGY  operable=false  {"UNSPECIFIED":7}
```

— but `UNSPECIFIED` now means **"we hold no wire contract"**, and explicitly not
"Swiggy lacks the feature". The portal still refuses to render a settings form,
which remains right: boxes that save to nothing are worse than an honest refusal.
Screenshot: `owner-02-swiggy-blocked.png`.

**The route to a working Swiggy integration**, graded, in
`lib/integrations/providers.js` under `alternatives`:

1. **Direct** — apply to Swiggy as a POS/technology partner for the
   order-management API. Strongest outcome, slowest, and gated on a commercial
   conversation the POS vendor cannot start alone: Swiggy contracts with the
   restaurant.
2. **Middleware (strongest evidence)** — UrbanPiper, which documents Swiggy as a
   supported channel and is independently corroborated by a third-party connector
   that lists it as an upstream. One integration, a per-outlet fee, and
   UrbanPiper's contract with Swiggy does the work ours cannot.
3. **Middleware (marketing claims only)** — LimeTray, Restroworks, QueueBuster
   advertise Swiggy connectivity without publishing an integration contract.
   Plausible, unverified.
4. **Not an API route** — Petpooja's iframe-style embedding is not a POS
   integration and should not be counted as one.
5. **Ruled out** — Deliverect does not cover Swiggy in this market.

**One trap, recorded so nobody walks into it.** AI-generated and
content-farm pages describing a "Swiggy Partner API" with specific OAuth/PKCE
flows and endpoint paths do circulate. Those details are fabricated. Quoting them
to a buyer, or coding against them, produces an integration that cannot work and
a credibility problem that outlasts it. **Never invent or borrow an endpoint for
this provider.**

---

## 3. Zomato

Documented: the partner order-push and status callbacks, addressed by path.
Zomato publishes **no signature scheme** for inbound callbacks, so inbound
authentication is a shared header value compared in constant time — that is the
whole of it, and the portal says so in as many words rather than implying a
signature is being verified.

```
ZOMATO  operable=true  {"PATH_ONLY":8,"NOT_OFFERED":2}
```

### Menu management, rechecked (2026-09-25)

Rechecked against Zomato's official POS developer documentation, because the
earlier pass was summarised in a way that conflated two different things. The
correction:

- **Menu, price, stock and outlet online/offline are all provider-supported.**
  51 documentation pages were reviewed. Menu push, price update, item stock
  toggle and restaurant delivery-status get/set are documented flows, and their
  *semantics* are published too — a menu push is a **full-snapshot upsert**, the
  stock flag is **ignored on items that already exist**, an item switched off
  comes back on at a **provider-defined window**, and outlet offline is
  **bidirectional** (Zomato's own dashboard can move it, so the POS is not the
  only writer). Those four behaviours are now recorded as `menuSemantics` in the
  registry, because each of them is a way an integration silently does the wrong
  thing.
- **Settlement and refunds remain `NOT_OFFERED`, and this was confirmed rather
  than assumed.** Zero settlement pages across the 51; settlement is a dashboard
  download only. So settlement reconciliation here is an **explicitly labelled
  statement import**, never a recalculation of Zomato's figures.
- **What our adapter has not built** is now listed separately, as
  `notImplementedHere` in the registry. Previously a reader could not tell
  "Zomato does not offer this" from "we have not written it", which is the
  distinction that decides whether a gap is a commercial problem or a sprint.

`PATH_ONLY` means the route and flow are documented but the exact request and
response bodies are not; those are confirmed against the client's account before
go-live.

### Duplicate events, and distinct events arriving out of order

These are two different problems and only the first was previously solved.

**Duplicates** are handled by storing every inbound event under a unique
`(connectionId, externalEventId)` and treating the Prisma `P2002` collision as
the detection, not as an error. A redelivered callback cannot produce a second
invoice, payment or kitchen ticket.

**Out-of-order was a live defect, found by taking the instruction seriously that
event-id uniqueness proves nothing about ordering.** Both events are genuine and
distinct, so no uniqueness constraint can see the problem. Two faults were found
and fixed:

1. **A cancellation that arrived before the order it cancelled was dropped.** The
   handler had no aggregator order to apply the state to, so it skipped the event.
   The placement then arrived, and the POS created an order and a kitchen ticket
   for an order Zomato had already killed. Fixed with a nullable
   `AggregatorOrder.placementReceivedAt`: a state change with no placement now
   creates a row that records the state and says, by that column being null, that
   no order has been seen. When the placement arrives and the recorded state is
   terminal, **no Order and no KOT are created** — a
   `TERMINAL_BEFORE_PLACEMENT` discrepancy is raised for the operator instead. A
   non-terminal early state (an `ACCEPTED` that overtook its placement) still
   materialises normally and keeps its advanced state.
2. **`applyState` read the row, decided the transition was legal, then wrote** —
   with no guard that the row had not moved in between. Two app processes both
   pass that decision against the same snapshot. Fixed with a compare-and-set on
   `state` in the UPDATE; the loser reports that the order moved under it and
   overwrites nothing.

The day reconciliation was widened at the same time, because a row with no
placement has no `placedAt` to file it under and a cancellation that overtook its
own order would have been **invisible in the day's report**. Such rows are now
counted separately as `awaitingPlacementCount`, with their external ids listed,
and are excluded from the money totals — they are not orders.

Tests: §6.

**Not done:** discrepancies are exposed by `GET /:provider/discrepancies` and can
be resolved through the API, but **the portal UI does not render them**. An
operator cannot currently see a `TERMINAL_BEFORE_PLACEMENT` row without an API
client. Listed in §7.

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

### What the 100,000-row run proves, and what it does not

The scale run is **100,000 synthetic rows in the lane's private database**, never
against Reelo. It is reported in §6 as a test result and it must not be read as
migration evidence. Keeping the two apart matters, because "we imported 100,000
customers" is the sentence somebody will remember.

**It does prove:** the importer completes at that size without exhausting memory
or a transaction budget; the totals reconcile exactly
(`fetched = matched + created + skipped + failed`); an interrupted run resumes
from its cursor instead of restarting; re-running the same file changes nothing;
and no provider call is made at any point during an import.

**It does not prove anything about the client's own data.** Specifically, still
unknown until a real export is in hand:

- **The column layout.** The importer recognises a set of header aliases and
  **refuses the whole run** on a header it cannot map, rather than writing
  100,000 rows into the wrong columns. Reelo's actual export header has not been
  seen here. A new alias may be a one-line change — or the export may be XLSX or
  multi-sheet, which is a larger change.
- **How many rows carry an unreadable phone number.** The synthetic rows are all
  valid. A real export contains landlines, duplicates, `+91` variants, blanks and
  test records. Each becomes an exception row, and the exception count on the real
  file is the number nobody can predict from this run.
- **Whether the export carries a points column at all.** If it does not, every
  balance is imported as unknown — which is handled and is honest, but means the
  cached figure the reconciliation compares against does not exist.
- **Whether one Reelo profile appears against two phone numbers.** The unique
  index catches it and reports it; the number of such collisions in the client's
  account is unknown.

So the migration is **rehearsed, not performed**. The first real run must be a
preview against the client's genuine file, with the exception report read before
anybody types `IMPORT CUSTOMERS`.

### What must be obtained from the client, exactly

This is the complete list for the loyalty migration. None of it is a code
dependency; all of it is the client's to authorise.

| # | What | From whom | Why it is needed |
|---|---|---|---|
| 1 | **A full customer export from their existing Reelo account** — CSV, one row per customer, containing at minimum the mobile number and the current points balance. Ideally also the Reelo customer id, name, tier and points expiry. | The client, from their own Reelo dashboard, or Reelo support on the client's written request | The POS API offers no bulk export (`bulkExport: NOT_OFFERED`), so there is no other way to read the existing ~100,000 customers and balances |
| 2 | **The Reelo customer id column in that export.** | Same | Without it, customers are still matched by phone at the till, but the POS cannot pin a customer to a specific Reelo profile, so a balance lookup relies on Reelo's own phone matching |
| 3 | **Written confirmation of the export's as-of date and time.** | The client | The imported balance is stored as a snapshot with a timestamp. An undated snapshot cannot be reconciled against anything later |
| 4 | **Reelo POS API credentials for the client's account** (API key / token as Reelo issues them), supplied through the project's secret mechanism and never in chat or a ticket. | The client, or Reelo on the client's request | The till reads balances live. Without these the import still runs, but every balance displays as `UNKNOWN` |
| 5 | **The client's written authorisation to run the real import**, naming the file. | The client / owner | The run creates customer records in the client's live POS. Preview needs no authorisation; the real run does |
| 6 | **Confirmation from Reelo that a POS integration on this account will not trigger enrolment messages or welcome campaigns.** | Reelo support | The importer sends nothing itself, and this is verified by test. What it cannot control is a campaign rule inside the client's own Reelo account reacting to API activity — the one messaging risk that is not ours to close |

Item 6 is the one most easily forgotten and the only one with a customer-visible
failure mode: 100,000 people receiving an unexpected message.

---

## 5. TallyPrime

The documented and supported method: **XML over HTTP to the local TallyPrime
instance** (all releases), or native JSON on 7.0+, default port 9000, with the
company loaded. There is no cloud API. This is why the connector is a
locally-queued pusher and not a client of a remote service.

```
TALLY  operable=true  {"SPECIFIED":3,"PATH_ONLY":5,"NOT_OFFERED":1}
```

- **Stable external references.** Each posting carries the POS invoice number as
  its voucher number and reference, so a human can reconcile the two systems by
  eye and a re-send is recognisable. It is derived from the order, not from the
  attempt, so it is identical across every retry — which is what makes the
  lookup below possible at all.
- **Acknowledgements are distinguished from sends.** `SENT` means we wrote to
  Tally; `ACKNOWLEDGED` means Tally's response was parsed and confirmed the
  voucher was created. A connector that stops at `SENT` reports success for
  vouchers Tally rejected.
- **Operator-visible error queue.** Failures surface as sanitized provider text
  in "Queued work" with attempts, next attempt and a per-row retry
  (`owner-03-tally-error.png`).

### `idempotency: NOT_OFFERED` — and why local dedupe did not cover it

**This was a live duplicate-invoice defect and the previous revision of this
document described the thing that does not fix it.** It said duplicate prevention
is "held on our side" by the unique index on
`AccountingPosting(connectionId, sourceType, sourceId, docType)`, "however many
times the queue retries". The first half is true and the conclusion does not
follow.

That index stops a second posting **row** existing. A retry reuses the one row, so
the index is never consulted and never fires. It therefore does nothing about the
case that matters: **Tally accepts the import and the acknowledgement is lost on
the way back.** The queue classifies that as UNKNOWN, retries it, Tally has no
duplicate detection, and the client has two sales for one bill. No local dedupe
key can prevent this, because the duplicate is created in the other system.

**What now happens on a send that returns no answer** — `recoverLostAck` in
`adapters/tally.js`:

| Situation | Action |
|---|---|
| Connection refused / host unreachable | Tally read no bytes, so nothing was applied. **Plain automatic retry**, as before — a back-office PC rebooting must not require a human |
| No answer, but the request was delivered (timeout, reset, 5xx) | **Ask Tally.** A `Day Book` export for the voucher's date is read and searched for the voucher number |
| — voucher **found** | Success. Recorded `ACKNOWLEDGED`, `externalMasterId` filled in from Tally's own handle when the export carries one, and **the voucher is not sent again** |
| — voucher **not found** | **Stop, and do not resend.** The posting goes to the operator queue with the reason in plain words. Absence in an export is weaker evidence than presence — the Day Book may have answered for a period we did not ask for — and resending on that evidence risks a duplicate sale. A person decides, using the retry control |
| — Tally will not answer the read either | No verdict. Fall through to the original error and let the backoff run; it will be asked again later |
| Tally answered and **rejected** the import | Nothing was applied, so nothing is looked up. Tally's own wording is shown |

`Day Book` is used because it is a collection type **verified valid against this
client's TallyPrime**. That is not a detail: an unrecognised collection type does
not return an error, it *wedges* Tally's HTTP server until somebody clears it at
the console. Guessing a report name here would take the client's accounting
offline.

**No exactly-once claim is made.** This is at-least-once delivery with a
confirmation read and a human gate on the ambiguous case. The honest statement is
that a lost acknowledgement no longer silently duplicates a sale.

### LAN-only access — and why rejecting URL schemes did not establish it

**Also a live defect, and the previous revision described the weaker check as
though it were the guarantee.** It said the host field "refuses a URL scheme
outright, so the host field cannot be pointed at a public address". Rejecting
schemes does not establish that, and the gap was demonstrated: the field accepted
`8.8.8.8`, `tally.example.com`, the bare integer `134744072`, the hex
`0x8080808` and the octal dotted-quad `010.010.010.010` — **all of which the
WHATWG URL parser reads as 8.8.8.8**, and all of which would have sent an
unauthenticated voucher write to a public address.

Tally has **no authentication of any kind**, so anything that can reach port 9000
can write into the client's books. The policy now lives in
`lib/integrations/lanHost.js` and is enforced at two gates:

1. **On save** — the zod refinement canonicalises the host through the same
   parser an attacker would rely on, then requires a private address or a
   recognised local suffix (`.local`, `.lan`, `.internal`, `.home.arpa`).
   100.64/10 CGNAT is deliberately excluded: it is carrier space, not the shop's.
2. **Immediately before every call** — the host is resolved, and the call is
   refused unless **every** answer is private. Resolution failure is a refusal.
   The request is then dialled at **the verified address, not the name** — handing
   the name to `fetch` would make it resolve a second time, and a second
   resolution can return a different answer than the one just approved.

Verified by execution, refusals **each paired with a positive control** (a real
HTTP server on loopback answering the way Tally answers), because a gate that
refuses everything passes a list of refusals. Those positive controls are what
found two further defects: a successful Tally import was being read as a rejection
(`<ERRORS>0</ERRORS>`, the success count, was matching the error-text pattern),
and the resolved address was not actually being dialled.

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
bash /home/atc-noc/vcx-providers-local/vcxp test
```

Result: **Test Files 23 passed (23) · Tests 747 passed (747)**, duration 676.76s,
log `/tmp/vcxp-full-gate2.log`. This lane's file is **119** of those tests and
563.97s of that duration, including the 100,000-row scale test (461.4s at
217 rows/s).

The command matters. The first revision of this document reported
`vcxp test tests/integrations.test.js` — one file — as the full suite. Run
properly at the same commit, the suite came back **17 files failed**, every error
a foreign-key violation caused by this lane's own leftover rows breaking the
cleanup in files that have never heard of its tables. Fixed inside this lane's
file, by clearing its twelve tables in `afterAll`; no other test file was edited.
`docs/lanes/PROVIDERS.md` §9 item 6 has the detail.

What this lane's 119 tests cover, in the task's own terms:

| Requirement | Covered by |
|---|---|
| Tenant isolation | Cross-company reads and writes on every surface, each with a positive control proving the neighbour's own data *is* visible to them |
| Invalid authentication | Wrong header value, missing header, and a constant-time comparison path |
| Duplicate callbacks | Replayed events asserted to produce no second invoice, payment and no second kitchen ticket. **Not** stock: this build has no stock engine, so there is no stock movement to duplicate and nothing was asserted about one — see §7 and the limitations table |
| Out-of-order events | A cancellation arriving before its own placement, and a superseded event arriving after a newer one, each asserted to leave no Order and no kitchen ticket behind |
| Retries after an outage | Queue backoff `[30s,60s,120s,300s,600s,30m,60m]`, `maxAttempts 8`, lock expiry at 5 min, DEAD state |
| Cancellations | Provider-initiated cancel after acceptance, and the refusal path when the order is already closed |
| Loyalty adjustments | Redeem, reversal and sale-return, plus the assertion that an unknown balance reads UNKNOWN and never 0 |
| Duplicate accounting postings | One bill → one voucher across repeated queue runs |
| Audit trail | Newest-first ordering, actor identity, tenant isolation, provider filter, and that **no credential material reaches the response** |

### Browser acceptance

```
node /home/atc-noc/vcx-providers-local/shootIntegrations.mjs /tmp/vcx-integrations-shots4
```

Result: **62 checks passed, 0 failed; 8 distinct screenshots.** Six checks were
added after the screenshots showed that correcting Zomato's capability grades had
made the settings screen *less* honest — the page displayed the grade alone, so
"menuPush PATH_ONLY" read as a promise to sync a menu nobody has built. Each new
check is paired with a control: Reelo has nothing unbuilt to admit, so its panel
must be absent, which stops the check passing on a page that prints the text for
everybody.

Three role runs — `CUSTOMER_OWNER` (all eight actions), `BRANCH_MANAGER`
(read + job retry), `FINANCE` (read + discrepancy resolution) — each asserting
**both** directions: what the role may do is present, and what it may not do is
absent. A sentinel secret value is asserted absent from the whole rendered
document.

### Migration rehearsal

```
bash /home/atc-noc/vcx-providers-local/rehearseMigration.sh
```

Result: **NOT RE-RUN — the recorded PASS does not cover this tree.**

`vcxp migsql` proves the migrations reproduce `schema.prisma` on an *empty*
database. The rehearsal proves the part that actually breaks: this lane adds
`ALTER TABLE "Order" ADD COLUMN "channel" NOT NULL DEFAULT 'POS'`, so the
migrations are applied to a database **already populated** with two companies,
branches, users, customers and priced orders. On 2026-09-24 that returned
**REHEARSAL: PASS** (12 checks): order count unchanged, order money
byte-identical (357.00), every pre-existing order backfilled to `channel = POS`,
**no** pre-existing order attributed to a provider, **no** loyalty links invented
for existing customers, and a second `migrate deploy` a clean no-op.

That result is real and it is **stale**. It was measured before migration 3
existed, so it says nothing about it — and migration 3 is the one migration here
whose entire content is a backfill, which is exactly the class the rehearsal was
built to catch. Reading the script before re-running it showed it would not have
covered migration 3 anyway: it stripped only the two migrations it knew about, so
its "state before this lane" stage would have retained a migration depending on a
table that stage never creates, and died on the first step.

The script is now corrected. Migration 3 gets a stage of its own, because a
backfill applied in the same step as the migration that *creates* the table runs
its `UPDATE` over an empty table and proves nothing. Stage B stops before it,
three `AggregatorOrder` rows go in with `createdAt` spread over nine days, and
stage C applies it and asserts every row's `placementReceivedAt` equals **its
own** `createdAt` — deliberately spread, because identical rows cannot distinguish
a per-row copy from a blanket `SET … = now()`. It also asserts the column is
absent beforehand, so the backfill cannot pass by having already happened, and
that the three order states are unchanged, since normalising a state would
destroy the cancellation this migration exists to preserve.

Executing it is **BLOCKED**: refused twice by this environment's command
classifier, and a denied command is recorded here rather than retried under
another spelling. It drops and recreates a scratch database
(`vcx_providers_rehearsal`, lane-private, no worktree file touched), which is the
likely reason for the refusal and a fair reason to read it before trusting it.
One command, outstanding for the owner; nothing else in this lane depends on it.

### Schema drift

```
bash /home/atc-noc/vcx-providers-local/vcxp migsql
```

Result: `-- This is an empty migration.` — no drift between the migrations and
`schema.prisma`.

---

## 7. Provider-access dependencies — the consolidated list

Everything this lane cannot finish by writing code, in one place. Nothing else in
this document adds an item that is not here.

Two kinds, and they are not interchangeable. A **commercial** item needs somebody
to sign, ask or approve; no amount of engineering shortens it. A **technical**
item is a fact or a file we do not have yet, and arrives the moment someone sends
it. Ordered by what stops the most work.

| # | Obtain | From | Kind | Unblocks | Without it |
|---|---|---|---|---|---|
| 1 | Swiggy POS-partner onboarding — or a middleware contract (UrbanPiper is the strongest corroborated route) | Swiggy, or the middleware vendor | Commercial | Swiggy in its entirety: the request/response shapes, the callback contract, the credential | Nothing can be built. Endpoints must not be guessed, and §2 records fabricated Swiggy endpoints already circulating |
| 2 | Zomato partner documentation pack + credentials | The client's Zomato partner account | Technical (pack) + Commercial (account) | The 8 `PATH_ONLY` request/response bodies, and the inbound callback header value | The paths are known from the public developer documentation; the bodies are not, so no request can be assembled |
| 3 | One real Reelo CSV export | The client's Reelo account | Technical | The importer's column mapping, which is written to the documented shape and **unconfirmed against a real file** | The 100,000-customer migration cannot be run for real. See §4 |
| 4 | Which exported column carries Reelo's own customer id | The client, or Reelo support | Technical | Stable identity for the ~100,000 existing customers | Matching falls back to phone number alone, and two profiles sharing a phone cannot be told apart |
| 5 | A written as-of date and time for the export | The client | Technical | Honest balance provenance | An imported balance has no age, so nobody can say how stale a cached figure is |
| 6 | **Written confirmation from Reelo that connecting a POS will not trigger enrolment messages or welcome campaigns** | Reelo | Commercial | Turning the Reelo connection on at all | This is the one item whose failure is visible to ~100,000 of the client's customers. It is a messaging risk, not a data risk, and it cannot be tested from here |
| 7 | Reelo POS API credentials, delivered through the project's secret mechanism | The client's Reelo account | Commercial | Live lookups, redemptions and reversals | Balances stay `UNKNOWN`; the code deliberately never shows a guessed zero |
| 8 | Reelo's auth-header scheme, confirmed in writing | Reelo | Technical | Correct authentication on every call | One documented request carries an auth-key header and the rest carry identity in the body. The portal makes the header optional and sends nothing when blank |
| 9 | Written authorisation naming the export file, from the client | The client, countersigned by the owner | Commercial | Running the real import | A bulk import of real customers is explicitly reserved to the owner |
| 10 | A reachable TallyPrime instance with the client's company loaded | The client's back office | Technical | Voucher reconciliation, and the Day Book recovery path against a real Tally | The recovery path is exercised against a loopback HTTP server that speaks Tally's XML. That proves our half of the conversation and nothing about theirs |
| 11 | An XML export of a real voucher of each type | The client's Tally | Technical | Enabling credit-note, receipt, purchase, GST and cost-centre tags | Those posting types stay off. Only the confirmed shapes are sent |
| 12 | The client's chart of accounts — exact ledger and voucher-type names | The client's Tally | Technical | Postings landing in the right ledger | Tally rejects an unknown ledger name, so a wrong name is a failed posting, not a silent misposting |
| 13 | Two PANs for Tally's group-entity handling, if in scope | The owner | Commercial | Inter-company ledgers | Out of this lane's scope; noted so it is not rediscovered later |
| 14 | Approval of the prepared changes for live activation | **The owner** | Commercial | Production activation, live financial transactions, the real-customer import, and any external message | Everything above stays a rehearsal |

Items 1 and 6 are the two worth escalating first: 1 because it is the longest
lead time and no engineering runs in parallel with it, 6 because it is the only
one whose failure mode is visible to the client's customers.

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
