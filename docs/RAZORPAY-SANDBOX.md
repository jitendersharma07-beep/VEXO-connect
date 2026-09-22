# Running the POS against a Razorpay TEST account

Everything here is dev-box only. No step writes to a `.env`, touches the
`pos-prod-*` stack, or changes anything a deployment reads. The production edge
is nginx and is not involved at any point.

## What has actually been proven against a real account

Keep this section honest; it is the only thing standing between "we tested it"
and a surprise on a live counter. As of 2026-09-22:

| | Status |
| --- | --- |
| Credentials authenticate | **Verified** — `razorpay-sandbox-check.sh`, HTTP 200 |
| Outbound reachability to `api.razorpay.com` | **Verified** |
| `createSession` payload accepted, returns an `order_…` | **Verified** |
| `capture_options` shape accepted | **Verified**, and found to be *optional* — see below |
| Tunnel exposes the webhook path and nothing else | **Verified** — 14 external probes, twice, plus traversal and query-string variants |
| Dev chain 5177 → backend → dev Postgres | **Verified** — a unique marker sent through vite appeared verbatim in the backend log. The backend port has moved (5010 → 5015) and the capture proxy sits on 5014; do not pin either in source |
| Unsigned webhook is refused | **Verified** — HTTP 400 from the public hostname |
| `payment.authorized` does not create a Payment | **Verified** — recorded with `skippedReason`, no `Payment` row |
| A webhook is registered on the account | **Verified** — `TfAWnBvpcGixwX`, active, 4 events. Was **0 webhooks**; the registration script was sending `events` as an array when the API wants a name→enabled map |
| Automatic capture actually honoured | **Verified** — a real card payment reads back `status=captured`, `captured=true`, order `paid` |
| A captured payment does **not** settle the order without a webhook | **Verified** — and deliberate; see below |
| Webhook **receiver** — signature, replay window, storage, idempotency, money | **Verified against locally-signed deliveries**, 26/26 — see below. Not a statement about Razorpay. |
| Webhook **delivery** from Razorpay | **Verified** — `payment.captured` event `TfAzJXOLfmOqii`, 2026-09-22 18:09:13Z, applied to one `Payment` |
| Refund create / settle / replay against the provider | **Verified** — `rfnd_TfB3TLNRxpbgl5` `processed`, settled by genuine `refund.processed` event `TfB42UGWqm3vNh` |
| Payment-intent reconcile (the pull half, for a webhook that never arrives) | **Covered by test, not yet exercised against the account** — 18 tests, branch `phase2-reconcile-tests`. See "The ₹105 that was stranded" |

Every row marked Verified is backed by the provider's own record, not by a
stub — see "The delivery leg, closed" below for the evidence and for how to
tell a genuine row from a synthetic one. The one row that is **not** a claim
about the provider says so in its own words: the reconcile route has been
proved against the test adapter and has not yet pulled a real capture in.

### Synthetic deliveries and genuine ones prove different things

Both legs are now verified, so this section is no longer about a gap. It is
about not letting the two kinds of evidence be quoted as if they were one —
the synthetic suite is still the only thing that covers the refusal cases, and
it is still not a statement about Razorpay.

`backend/scripts/webhook-chain-verify.mjs` sends 26 deliveries it signs itself
with the real webhook secret, through the real proxy, the real route, the real
adapter, into the real dev database. 26/26 pass. Nothing is stubbed — a test
that stubs `verifyWebhook` proves its own stub — so it also checks live that
the stored secret and the running backend's secret still agree.

Read it as **"if Razorpay reaches us, we handle it correctly"** and never as
**"Razorpay reaches us"** — that second claim is now true, but it is proved by
the genuine event in the table above, not by anything in this script. Every
line it prints is labelled SYNTHETIC for that reason. What it covers:

- six refusals, sent separately so each fails for its own reason: unsigned,
  wrong signature, body edited after signing, stale, future-dated, missing
  event id. None is stored as an event row; all six are audited.
- a signed capture creates exactly one `GATEWAY` payment, credits no cashier,
  keeps the `pay_…` without which no refund is possible, and closes the order.
- a signed `refund.processed` settles a `PENDING` gateway refund, and only then
  unwinds the order to `REFUNDED`.
- **four ways to deliver the same money twice, none of which do.** Identical
  redelivery, a second event id for the same capture, a re-opened intent with
  its payment intact, and the same two for the refund.

One result there is worth carrying into any incident. The route **cannot reach**
its own last-resort `Payment.intentId` unique index, because three application
checks stop a duplicate first — `already settled`, then `order is PAID, not
BILLED`, then `order has no amount due`. The index is therefore probed directly
against the database rather than through the route, since a backstop the route
cannot reach is not evidenced by asking the route.

### Telling a genuine event row from a synthetic one

This section used to read "Every webhook event row in the dev database today is
synthetic — Razorpay has never delivered a webhook to this POS." That was true
when written and is now false, so the rule for telling them apart matters more
than it did.

**A genuine Razorpay event id is bare alphanumeric** — `TfAzJXOLfmOqii`,
`TfB42UGWqm3vNh`. Everything this tooling mints carries an underscore:
`evt_probe_…` from the ingress probes, `evt_SYNTH…` from the chain verifier
(deleted when it finishes), `replay_…` from the replay script. The working test
is `^[A-Za-z0-9]+$`.

State that rule the wrong way round and it does real damage in both directions.
Reading `evt_…` as the genuine marker promotes the four `evt_probe_` rows —
every one skipped with "no intent matches this provider reference" — into
provider evidence, which is the misreading this document was written to stop.
And a filter of `!/^evt_/`, which looks equivalent, let the replay script
re-ingest its own `replay_` deliveries: on the second run it counted six
genuine deliveries instead of two and was testing only itself.

The dev database currently holds two genuine event rows, neither skipped:

    18:09:13.538Z  TfAzJXOLfmOqii  payment.succeeded  processed
    18:13:42.189Z  TfB42UGWqm3vNh  refund.succeeded   processed

### The first real payment, and what it proved

A ₹105 test-mode card payment was driven through the genuine checkout widget
(headless Chromium — the adapter returns `checkoutUrl: null`, so there is no URL
a script can post to). Razorpay's own record: `pay_Tf4bqZCtM4GOU2`,
`status=captured`, `captured=true`, order `paid`, `amount_paid=10500`.

At that same moment the POS held the order at `BILLED`, the intent at `PENDING`,
and had **no `Payment` row**.

That is correct, and the reason is worth stating plainly: nothing here settles an
order on the browser's say-so. The checkout handler returned a valid
`razorpay_payment_id` *and* a valid signature, and the POS still did not record
payment, because only a webhook does that. A browser can be closed mid-redirect,
or lied to; the webhook is the provider speaking for itself.

**The gap this exposes is operational, not a bug.** A webhook that is merely
*late* — tunnel restarted, retries exhausted — leaves exactly this state: the
customer has paid and the POS shows the bill as due. There is no pull-based
reconcile for payments. `/:id/refunds/:refundId/reconcile` exists but covers
refunds only. Until a payment equivalent exists, a missed `payment.captured`
has to be caught by a human comparing the Razorpay dashboard against the day's
outstanding bills. **Do not hand this to a café without telling them that.**

Four things about the real checkout that no stub would have taught us, all of
which cost a failed attempt each:

- **The account takes domestic cards only.** The universal test number
  `4111 1111 1111 1111` fails with `international_transaction_not_allowed`,
  `source=business`, at `step=payment_initiation`. Use Razorpay's domestic
  card `5267 3181 8797 5449`. For an Indian café the account setting is right
  and the card is what has to change.
- **The checkout rejects patterned phone numbers.** Both `9999999999` and
  `9876543210` are refused as "not a valid mobile number" — they are
  format-valid Indian mobiles, so this is a fake-pattern blacklist. It also
  refuses them *silently* inside `prefill`, which is why the contact modal
  appears at all when a number was supplied.
- **Test-mode OTP is `1111`,** at an Axis Bank simulator, and the attempt has a
  visible ~3-minute timeout.
- **`payment_cancelled` / `source=customer` can be a lie.** It was reported
  when an automated retry typed the OTP into an already-filled field. It reads
  like a customer abandoning the payment and was nothing of the kind — worth
  remembering before trusting that reason code in a report.

One documented claim has already turned out to be wrong, which is the reason
this table exists. The adapter used to carry a comment saying Razorpay rejects
`{ capture: 'automatic' }` unless `capture_options` accompanies it. Asked
directly, the sandbox accepts all five forms tried — with the options, without
them, with either sub-field missing, and with no `payment` block at all. The
block is still sent, because an order with no payment block inherits the
dashboard's capture setting and that is a checkbox outside this repository, but
it is sent as a deliberate pin rather than to satisfy a requirement. Note also
that the Orders API does not echo these settings back, so its 200 is not
evidence they are honoured — only a payment arriving as `payment.captured`
rather than `payment.authorized` proves that.

### The delivery leg, closed

The blocker was never the tunnel, the proxy or the receiver. It was that the
account had **0 webhooks registered**, and the registration script had a write
path that disagreed with its own read path: it sent `events` as an array, and
the API wants a map of name→enabled. Sent as an array the API replies
`Invalid event name/names: 1, 2, 3` — it has enumerated the array indices and
reported them as if they were event names, which points at the values rather
than the shape. The script's own `show()` had always *read* events back as an
object, so the correct shape was sitting in the same file.

Fixed in `d1e8027`. Webhook `TfAWnBvpcGixwX`, active, four events.

What then happened end to end, on order `cmucyvfuj002t1grlxxb6smh6` /
`order_TfAcLrKPDwVYez`, ₹105:

| Leg | Provider's record | POS record |
|---|---|---|
| Capture | `pay_TfAz6n5mPXApUi` `captured=true` | event `TfAzJXOLfmOqii` → **exactly one** `Payment`, ₹105, `GATEWAY`, `receivedById=null` |
| Refund | `rfnd_TfB3TLNRxpbgl5` `processed` ₹40 | event `TfB42UGWqm3vNh` → `Refund` `SUCCEEDED`, same id |

`receivedById=null` is the load-bearing detail: no cashier is credited, because
no human recorded it. The order went `PAID` on the provider's word alone.

The refund was **partial on purpose**. A full refund is a weak test — code that
ignored the requested amount and returned the whole payment would look perfect.
₹40 of ₹105 forces the figure to survive POS paise → Razorpay paise → the
`refund.processed` webhook → the POS row.

**Replaying the genuine bytes changed nothing**, which is the part worth
keeping. The original body, signature and event id were replayed out of the
capture log, twice each: once as a provider retry (same event id) and once
under a fresh event id, which a retry cannot produce and the unique index
cannot see. Totals held at `PAID payments=1/105 refunds=1/40` throughout.

The two failed in *different* places, and the difference is the useful finding:

- `payment.captured` was refused **HTTP 400 on the replay window**, before any
  duplicate check ran, because its `created_at` was outside the 300s tolerance.
  Stale captures always land here.
- `refund.processed` was inside the window, reached the guards, and was
  absorbed as a no-op with `skippedReason: "refund already succeeded"`.

Asserting HTTP 200 — as the replay script did at first — marks the *stronger*
outcome as a failure. What has to hold is that the totals did not move and the
POS made a deliberate decision, not that it returned any particular status.

A signature alone would not have stopped the second case: the bytes are
genuine, so it verifies. A system trusting the signature by itself would have
paid twice.

### Two defects the reconcile tests found

Branch `phase2-reconcile-tests`. Both were written as failing tests against
code that already looked right, and both are fixed in the two commits before
the test commit. Recording them because each is the kind of thing that passes
review and fails on a counter.

**A capture settled in a different currency closed the bill.**
`applyGatewayEvent` compared `amountPaise` against the intent and nothing else.
`amountPaise` is a bare integer and integers carry no units, so 10500 US cents
and 10500 paise compared **equal** — a USD capture closed an INR bill at face
value and every downstream total was then wrong by the exchange rate. Both
adapters had always reported `currency`; both call sites dropped it. The test
that found it recorded a ₹420 `GATEWAY` payment against a `USD` answer and
marked the order `PAID`.

The fix went into the shared `applyGatewayEvent`, in front of the amount
comparison, so it closes the hole on the **webhook path as well** — the
production-facing one. The recovery route also refuses it a layer earlier so an
operator gets a 409 naming the reason instead of a silent skip.

Negative control, both directions: remove the route branch and the applier
still refuses and still writes no payment; remove the applier check and the
webhook path settles the foreign-currency capture. Each layer is load-bearing,
and the applier is the one protecting the money.

**A paid bill could be reported as "not applied".** The reconcile route flagged
`alreadyRecorded` only when the unique index threw. That is one of two race
windows:

| | What happens | Before |
|---|---|---|
| Webhook commits **after** this transaction read the intent | P2002 on `Payment.intentId`, caught | `alreadyRecorded: true` |
| Webhook commits **before** it read the intent | `applyGatewayEvent` sees `SUCCEEDED`, returns a `skippedReason`. No index touched, nothing thrown, the catch never ran | bare `recorded: false` |

Money was correct either way — exactly one `Payment`, written by the webhook.
But in the second window a caller could not tell "already paid, nothing to do"
from a real refusal like "settled amount does not match the intent"; both
arrived as `recorded: false` plus a reason string. **A manager told "not
applied" about a bill the customer has already paid goes looking to take the
money again**, which is the one outcome this route exists to prevent. It now
decides on the `Payment` row rather than on which code path was taken, because
that is the fact being reported.

The race is tested deterministically rather than with a sleep: the test adapter
accepts a function-valued settlement, and the hook **delivers the webhook
before it answers**, so the delivery is guaranteed to have committed while the
recovery is in flight. A wall-clock race test almost never lands in that window.

---

## 1. Store the test credentials — once

```
cd /home/atc-noc/atc-pos && bash backend/scripts/razorpay-sandbox-setup.sh
```

Three hidden prompts. The values go straight into
`backend/.secrets/razorpay-sandbox.env` at mode `0600`, in a directory at `0700`.

What that script guarantees, and how each guarantee is enforced rather than
asserted:

| Promise | How it is enforced |
| --- | --- |
| Secrets never reach a transcript | It prints only `PASS`, `FAIL` and instructions. No value is echoed back, not even on error. |
| Secrets never reach shell history or `/proc` | They are typed at a prompt, never passed as arguments. |
| A pasted block cannot appear on screen | Terminal echo is turned off *before* the first prompt, not by `read -s` once it is already running. |
| A pasted block cannot silently answer the next prompt | Input typed ahead of a prompt is drained and discarded. |
| Git cannot see the file | `git check-ignore` is run on the exact path, and the script refuses to write if git does not confirm. The `.gitignore` line alone is not trusted. |
| A live key cannot be used | The `rzp_test_` prefix is required and `_live_` is rejected, before anything is written. |

To replace the credentials later, run the same command; it asks before
overwriting. To remove them, delete the file.

## 1a. Check they actually work — before the demo, not during it

```
cd /home/atc-noc/atc-pos && bash backend/scripts/razorpay-sandbox-check.sh
```

"Stored" and "correct" are different claims, and only the second one matters. A
typo in the key secret stays invisible until the first checkout, where it
surfaces in front of whoever is running the demo. This asks Razorpay instead,
read-only: it lists payments with `count=1` and looks at nothing but the status
code. No order is created and no money moves.

It prints a verdict, never a response body — the body of a 200 is real payment
data and the body of a 401 quotes the key id back. The credential reaches curl
through its stdin config parser rather than `-u`, so it is not in
`/proc/<pid>/cmdline` even for the life of the request.

A `401` means the stored key id and secret do not match, or the key was
revoked; re-run the setup script. A failure to connect is reported as a
connectivity answer and explicitly *not* as a verdict on the credentials.

## 1b. Is the dashboard you are looking at the same account?

```
cd /home/atc-noc/atc-pos && bash backend/scripts/dev-key-id-compare.sh
```

An empty dashboard has two explanations — nothing happened, or you are looking
at a different Razorpay account — and they call for opposite responses. This
settles it in one step: paste the Key Id from the dashboard (Settings → API
Keys) at a hidden prompt. It prints `MATCH` or `NO MATCH` and nothing else.

The configured key id is never displayed. It could be — a key id is publishable,
it is handed to the browser on every checkout — but scrollback from this box
gets pasted into chats, so the value travels in rather than out.

## 2. Give Razorpay somewhere to deliver webhooks

Razorpay posts events from the internet, so it needs a public HTTPS URL that
reaches this box. **Do not point a tunnel at the backend.** The backend serves
the entire POS — login, catalog, orders, reports — and a tunnel to it publishes
all of that.

Point the tunnel at the webhook-only proxy instead
(`backend/scripts/dev-webhook-proxy.mjs`). It forwards exactly
`POST /api/gateway/webhook`, answers 404 to everything else, and drops cookies
and authorization headers rather than relaying them, so the public hostname is
not a way into the POS. It relays the body as raw bytes, because the signature
is an HMAC over exactly what Razorpay sent and re-serialising it would
invalidate every event.

```
# terminal 1 — the proxy
cd /home/atc-noc/atc-pos && POS_WEBHOOK_PROXY_PORT=5012 \
  POS_WEBHOOK_CAPTURE=/tmp/pos-demo/webhook-capture.jsonl \
  node backend/scripts/dev-webhook-proxy.mjs
```

Then expose **the proxy's port** — not 5010:

```
# terminal 2 — the tunnel
cloudflared tunnel --url http://127.0.0.1:5012
```

### Which port is authoritative

Earlier reports named both 5011 and 5012, which is worth settling because the
tunnel points at exactly one of them and a webhook aimed at the other is simply
never delivered.

Between the two of them, **5012** — it is the only one of that pair with
`POS_WEBHOOK_CAPTURE` set, and 5011 receives nothing and proves nothing.

**Both are now superseded by 5014.** §2a has the full list of what is
listening and why 5014 is the one to point a tunnel at; the short version is
that 5011 and 5012 sit in front of a backend that has been serving code from
11:07:59 since before three payment-related commits landed. The rule this
section exists to enforce has not changed — one port is authoritative and a
webhook aimed at any other is silently lost — only the answer has.

Capture exists for one specific test. Proving that a redelivered event is
refused needs the exact bytes Razorpay signed plus its signature header;
anything synthesised here would only prove our own HMAC round-trips. The file
is written `0600` because a signed body stays replayable for as long as the
secret stands.

`cloudflared` **is** now installed, at `/home/atc-noc/bin/cloudflared`
(2026.9.1). It used to be absent, and the install line is kept below for a
rebuilt box:

```
curl -fsSL -o ~/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/bin/cloudflared
```

**Starting it is a human step, and stays one.** An agent session will not launch
it: a process that accepts traffic from the internet on someone else's box is
the owner's decision, not a convenience to automate, and the permission layer
refuses it — three times, as of this writing. That is the correct outcome and
not a bug to route around. The one line to run is in §2a.

A quick tunnel needs no Cloudflare account and prints a hostname like
`https://<random-words>.trycloudflare.com`. That hostname lasts only as long as
the process — when it restarts, the webhook URL in the Razorpay dashboard has to
be updated to match.

## 2a. What is already running, and the one line nobody has run

Ports here have multiplied because several sessions have each stood up their
own, and a webhook aimed at the wrong one is simply never delivered. As of
2026-09-22 17:30:

| Port | What | Owner | Code |
| --- | --- | --- | --- |
| 5010 | backend, gateway ON | an earlier session | **stale** — booted 11:07:59, three commits ago |
| 5011 | proxy, no capture | an earlier session | — |
| 5012 | proxy, capture to `/tmp/pos-demo/` | an earlier session | — |
| 5013 | backend, gateway OFF | an earlier session | orphaned |
| **5014** | **proxy, capture to the lane's `.secrets/`** | **this lane** | current |
| **5015** | **backend, gateway ON** | **this lane** | current, `33323ce` + this branch |

Nothing above was restarted or killed to make room. The earlier processes
belong to other sessions and are left alone; this lane took its own two ports
instead, against the same dev database.

**Use 5014.** It is the only proxy whose capture file sits beside the
credentials at mode `0600`, and the only one in front of a backend running code
from this decade. Bring the pair up from a lane worktree with:

```
deploy/sandbox-backend-up.sh                      # backend on 5015
POS_WEBHOOK_PROXY_PORT=5014 \
  POS_WEBHOOK_CAPTURE=backend/.secrets/webhook-capture.jsonl \
  node backend/scripts/dev-webhook-proxy.mjs      # proxy on 5014
```

Everything up to this point is done. The single blocking line, which a human
runs and leaves running:

```
/home/atc-noc/bin/cloudflared tunnel --url http://127.0.0.1:5014
```

It prints `https://<random-words>.trycloudflare.com`. That hostname is the only
missing input to step 3; nothing else in this document is waiting on anything.

## 3. Register the webhook

Check first, because "I configured it" and "the account has it" have already
disagreed once here:

```
node backend/scripts/razorpay-webhook-register.mjs --list
```

Use `razorpay-webhook-register.mjs`. `dev-webhook-register.mjs` beside it is the
earlier one and takes a full `--url`; the current script takes a bare hostname,
reuses the stored secret so it cannot be mistyped, refuses a non-`rzp_test_`
key, refuses a second webhook for a URL that already has one, and reads its
credentials from the shared `.secrets` directory rather than from beside
whichever worktree it was copied into.

```
node backend/scripts/razorpay-webhook-register.mjs <the-hostname-cloudflared-printed>
```

`--list` asks Razorpay directly and prints how many webhooks the account
actually has, with their URLs and events. `0` means no delivery will ever
happen, no matter what the dashboard appeared to accept. It has read `0` every
time it has been run, including at 17:28 on 2026-09-22.

Registering from the script rather than the dashboard also makes the matching
secret a property of the setup instead of something to re-verify: it reuses the
stored value and never prints it.

Otherwise, by hand: Razorpay dashboard → **Settings → Webhooks → Add New
Webhook**.

```
URL     https://<the-hostname-cloudflared-printed>/api/gateway/webhook
Secret  the same string typed at the third prompt in step 1
```

The secret field is the one to be careful with. A mistyped secret does not fail
visibly — deliveries arrive and are refused, which looks identical to a webhook
that was never configured. If step 5 shows events arriving but never applying,
suspect this field before suspecting the code.

Tick **exactly these four events**:

```
payment.captured
payment.failed
refund.processed
refund.failed
```

That is the complete set this build maps — `EVENT_MAP` in
`backend/src/lib/gateway/razorpay.js`. Any other event is accepted, stored and
deliberately not applied.

`payment.authorized` is the one worth understanding before ticking it. An
authorized payment is **not** a captured one: the money is blocked on the
customer's card and the merchant has not received it. This build never settles
an order on it, so if it arrives it lands in reconciliation for a human — which
is the right outcome for "the customer believes they have paid, and we have not
been paid".

## 4. Start the POS

```
# terminal 3 — backend, owns the terminal, Ctrl-C stops it
cd /home/atc-noc/atc-pos && bash backend/scripts/dev-gateway-up.sh

# terminal 4 — frontend
cd /home/atc-noc/atc-pos/frontend && npx vite --host 127.0.0.1 --port 5177 --strictPort
```

`dev-gateway-up.sh` picks up the stored credentials automatically, re-checking
the file's mode and its invisibility to git before it uses them. It refuses to
start if something already holds port 5010 — naming the process rather than
killing it — and refuses if the dev database is behind on migrations, because a
backend whose code is ahead of its schema does not fail at boot, it fails at the
first refund on a column that is not there.

## 4a. Reaching that POS from a browser

Both dev servers bind `127.0.0.1` on purpose, so there is no URL on this box
that a browser elsewhere can open. That is not an oversight to work around: the
dev backend serves the whole POS with a live gateway attached, and the one
public hostname in this setup is deliberately webhook-only.

Forward the port over SSH instead — it changes nothing on the server and needs
no SSH config edit:

```
# on YOUR machine, in its own terminal, leave it running
ssh -N -L 5177:127.0.0.1:5177 atc-noc@20.20.20.55
```

Then open **`http://127.0.0.1:5177/pos/`** in your browser. Razorpay Checkout
works from `127.0.0.1` in test mode.

Two URLs that will *not* work, and are worth naming because both look right:

| URL | What it actually is |
| --- | --- |
| `https://atcworkspace.com/pos` | The **production** POS — a different deployment, different database, gateway not configured at all. Signing in there produces no request on 5010. |
| `http://<this box>:5177/pos/` | Nothing. Vite is bound to loopback; there is no listener on the LAN address. |

If a sign-in seems to work but nothing appears in the dev backend's log, it went
to production. That is the same confusion this section exists to prevent, and
the absence of a log line is evidence of *where* the request went, not that no
request was made.

Sign in as **`sandbox.owner@atcpos.dev`** — `CUSTOMER_OWNER` can both take a
payment and issue a refund, so one account covers the whole run. Its password
was randomly generated by the seed script, so set one you know:

```
cd /home/atc-noc/atc-pos && node backend/scripts/dev-sandbox-password.mjs --check   # shows scope, changes nothing
cd /home/atc-noc/atc-pos && node backend/scripts/dev-sandbox-password.mjs           # two hidden prompts
```

It is scoped to the `@atcpos.dev` accounts in the "Razorpay Sandbox (Dev)"
company in the dev container, and it cannot reach production — the prod
database publishes no host port.

## 5. The run that actually verifies the gateway

Until every line below is ticked, the adapter is verified against documentation
only. Work through it in order; each step depends on the one before.

- [ ] **Checkout** — bill an order, choose the online method, get a payment
      intent. The order must stay **due**: nothing is paid until Razorpay says so.
- [ ] **Pay** the Razorpay checkout with a test card.
- [ ] **`payment.captured` webhook** arrives and is applied. The order becomes
      PAID and `Payment.providerRef` holds a `pay_…` id — not the `order_…`.
      This is the one to watch most closely: a refund posts to the `pay_…`, so
      if the wrong id is stored, refunds fail later and for an obscure reason.
- [ ] **Receipt** shows the payment.
- [ ] **Refund** part of the order. It must be created **PENDING**, and the
      amount must be held — not shown as returned.
- [ ] **`refund.processed` webhook** arrives; the refund settles.
- [ ] **Duplicate refund replay** — redeliver the same event. It must be
      recorded as a duplicate and applied exactly once.

Record what actually happened, not what was expected. If a step behaves
differently from the stub, the stub is wrong and the fix belongs in
`tests/razorpay.test.js` as well as in the adapter.

### The precise checkout step, for whoever has to click it

A human has to do this part. The adapter returns `checkoutUrl: null` by design —
Razorpay has no hosted page for this flow, the browser opens the Checkout widget
with the order id — so there is no URL a script can post to, and no way to
automate it that would still be evidence of the real thing.

**Point the frontend at the right backend first.** The dev server defaults to
`http://localhost:5010`, which is the stale instance. Driving checkout there
opens the intent on 5010 while the webhook arrives at 5015, and the delivery is
recorded with `no intent matches this provider reference` — a failure that looks
like a broken integration and is only a mismatched port:

```
VITE_DEV_API=http://127.0.0.1:5015 npm run dev --prefix frontend
```

Then, in the browser:

1. Sign in at `http://127.0.0.1:5177/pos/` as `sandbox.owner@atcpos.dev`.
2. Sell screen → add any item → **Bill**. The order goes to `BILLED`.
3. Choose the **online / card** payment method. A `PaymentIntent` opens and a
   real `order_…` is created on the Razorpay account. **The bill must still read
   as due** — if it flips to paid here, stop, because something settled an order
   on the browser's say-so.
4. In the Razorpay widget, pay with the **domestic** test card:
   `5267 3181 8797 5449`, any future expiry, any CVV.
   - `4111 1111 1111 1111` will fail with `international_transaction_not_allowed`.
     The account setting is correct for an Indian café; the card is what has to
     change.
   - If it asks for a phone number, do not use `9999999999` or `9876543210` —
     both are refused as fake patterns. Any other valid Indian mobile works.
5. OTP is **`1111`** at the Axis Bank simulator. Type it once and wait. The
   attempt times out in about three minutes, and re-typing into an already-filled
   field produces `payment_cancelled` with `source=customer`, which reads like
   the customer gave up and is nothing of the kind.
6. The widget reports success. **Now watch the POS, not the widget.** The order
   becomes `PAID` only when the `payment.captured` webhook arrives and verifies.
   That is the whole test.

Then check both sides rather than one:

```
node deploy/sandbox-evidence.mjs --env <the 0600 credentials file>   # provider side
node backend/scripts/razorpay-webhook-register.mjs --list            # deliveries are configured
```

and in the POS, the new `Payment` row must be `channel=GATEWAY`, hold a `pay_…`
in `providerRef`, and have **no** `receivedById` — no member of staff handled
this money.

### The ₹105 that was stranded, and the route built to close it

`pay_Tf4bqZCtM4GOU2` is a genuine captured ₹105 that had no `Payment` row,
because it was paid at 11:54 when the account had **0 webhooks registered**.
Registering one afterwards does not recover it: webhooks fire for events after
registration, and with none registered there were no delivery attempts to
replay from the dashboard either.

This section used to end "there is no supported way to pull a missed capture
in — leave it stranded". That was correct when written. It is now out of date,
and the thing it recommended against is the thing that got built deliberately:

    POST /api/orders/:id/payment-intents/:intentId/reconcile     (manager+)

It asks the provider what happened to one attempt and records the payment only
if the provider's own API says the charge was **captured**. It is the pull half
of a system that was otherwise entirely push, and it exists because a delivery
that never arrives is a failure mode no amount of care inside the webhook route
can fix — this ₹105 being the proof.

What has not changed is the rule underneath: **do not hand-write a `Payment`
row.** A row with no verified provider evidence behind it is exactly what this
design refuses to create, and it would sit in the database indistinguishable
from a real one. The route is not an exception to that rule, it is the
supported way of satisfying it — it routes through the same
`applyGatewayEvent`, with the same account, order, amount, currency and
amount-due checks, that the webhook uses. There is still exactly one place in
this codebase where a `GATEWAY` payment row is written.

Three things keep it from becoming a second, weaker way to record money:

- **It proves the answer is ours.** `receipt` and `pos_order_id` are values the
  POS itself sent at `createSession`, compared against our own row rather than
  against configuration — so a key rotated to point at the wrong account fails
  the check instead of passing it silently.
- **It never fabricates a webhook event.** It does write a
  `GatewayWebhookEvent`, which is what gives it idempotency, but on
  `source: 'RECOVERY'` — an enum with **no default**, so a row cannot acquire
  the `WEBHOOK` label by omission. Nobody delivered this; we went and asked, and
  the row says so.
- **It is a manager action, not a sweep.** A background job settling orders
  unattended would be making that judgement with nobody in front of the
  customer.

Closing this particular ₹105 is still a deliberate act for the release owner,
not something to slip into a verification run. But it is now a supported
operation rather than a stranded row.
