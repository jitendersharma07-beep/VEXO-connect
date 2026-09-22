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
| Dev chain 5177 → 5010 → dev Postgres | **Verified** — a unique marker sent through vite appeared verbatim in the backend log |
| Unsigned webhook is refused | **Verified** — HTTP 400 from the public hostname |
| `payment.authorized` does not create a Payment | **Verified** — recorded with `skippedReason`, no `Payment` row |
| A webhook is registered on the account | **NO** — the account reports **0 webhooks**. Nothing will ever be delivered until this is fixed. |
| Automatic capture actually honoured | **Verified** — a real card payment reads back `status=captured`, `captured=true`, order `paid` |
| A captured payment does **not** settle the order without a webhook | **Verified** — and deliberate; see below |
| Webhook delivery, signature, and application | **Not verified** — blocked on the 0-webhooks row |
| Refund create / settle / replay | **Not verified** |

Everything in the unverified rows is backed only by a stub of Razorpay's API
and by published documentation. That proves the wire format and the failure
handling; it proves nothing about a real account.

**That "0 payments" note is now out of date: the account holds 5 payments as of
2026-09-22, all from the run described below, all on `order_Tf48NDUY0t0Xfu`.**
Refunds are still 0. Events in `/tmp/pos-demo/webhook-capture.jsonl` whose ids
start `evt_probe_` are synthetic posts from a local probe, not Razorpay
deliveries; they were briefly misread as genuine, which is why they are called
out here.

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

**5012 is authoritative.** It is the one the tunnel forwards to, and the only
one with `POS_WEBHOOK_CAPTURE` set. 5011 is an earlier instance of the same
script with capture disabled; it is still listening and still harmless — nothing
routes to it from outside — but it receives nothing and proves nothing. If only
one proxy is running, use 5012.

Capture exists for one specific test. Proving that a redelivered event is
refused needs the exact bytes Razorpay signed plus its signature header;
anything synthesised here would only prove our own HMAC round-trips. The file
is written `0600` because a signed body stays replayable for as long as the
secret stands.

`cloudflared` is not installed on this box. Installing it downloads and runs a
binary that accepts traffic from the internet, which is an owner's decision, so
it is deliberately left out of every script here:

```
curl -fsSL -o ~/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/bin/cloudflared
```

A quick tunnel needs no Cloudflare account and prints a hostname like
`https://<random-words>.trycloudflare.com`. That hostname lasts only as long as
the process — when it restarts, the webhook URL in the Razorpay dashboard has to
be updated to match.

## 3. Register the webhook

Check first, because "I configured it" and "the account has it" have already
disagreed once here:

```
cd /home/atc-noc/atc-pos && node backend/scripts/dev-webhook-register.mjs --list
```

That asks Razorpay directly and prints how many webhooks the account actually
has, with their URLs and events. `0` means no delivery will ever happen, no
matter what the dashboard appeared to accept.

The same script can register it, which also makes the secret match a property
of the setup rather than something to re-verify:

```
node backend/scripts/dev-webhook-register.mjs --url https://<hostname>/api/gateway/webhook
```

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
