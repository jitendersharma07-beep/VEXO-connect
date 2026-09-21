# Running the POS against a Razorpay TEST account

Everything here is dev-box only. No step writes to a `.env`, touches the
`pos-prod-*` stack, or changes anything a deployment reads. The production edge
is nginx and is not involved at any point.

**Nothing in this repository has ever spoken to Razorpay.** The adapter is
verified against a stub of Razorpay's API and against Razorpay's published
documentation — which proves the wire format and the failure handling, and
proves nothing about a real account. Until the run at the bottom of this page
is done, treat the gateway as unverified.

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
cd /home/atc-noc/atc-pos && node backend/scripts/dev-webhook-proxy.mjs
```

Then expose **the proxy's port, 5011** — not 5010:

```
# terminal 2 — the tunnel
cloudflared tunnel --url http://127.0.0.1:5011
```

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

Razorpay dashboard → **Settings → Webhooks → Add New Webhook**.

```
URL     https://<the-hostname-cloudflared-printed>/api/gateway/webhook
Secret  the same string typed at the third prompt in step 1
```

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
