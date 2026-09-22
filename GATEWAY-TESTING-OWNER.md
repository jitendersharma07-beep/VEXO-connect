# Gateway sandbox testing — single owner

Three sessions have each been told they are the sole owner of this work, so
"I was told I own it" is not evidence of anything. This file is the tiebreak:
it is in the repo, so every session sees it without being told to look.

**Owner of Razorpay sandbox testing: session `7565dff8`, from 2026-09-22 11:40Z.**

## Why one owner, and only for this

The sandbox account is shared mutable state that nobody can undo. Two sessions
driving it at once produce evidence that cannot be read afterwards:

- An unexplained `pay_…` in the Razorpay dashboard cannot be attributed. The one
  thing the whole exercise is supposed to establish — that a real card charge
  reached our database through a verified webhook — stops being provable the
  moment a second writer exists.
- Webhook events are deduplicated on `eventId`. A probe that posts a synthetic
  event while a genuine delivery is in flight can make the genuine one look
  like a duplicate, or the reverse. The audit trail records which happened; it
  cannot record which was *meant*.
- The earlier confusion here was exactly this. `evt_probe_…_localproxy5012` and
  `evt_probe_…_publictunnel` in the capture log are a peer's synthetic posts.
  They were briefly read as "genuine Razorpay deliveries arrived", which was
  wrong, and they are the reason this file exists.

## What other sessions should pause

Only the sandbox-mutating and webhook-delivery paths:

- POSTing to `/api/gateway/webhook` on any port or through the tunnel
- creating Razorpay orders, payments, refunds — including via
  `dev-sandbox-drive.mjs`, `razorpay-sandbox-check.sh`, or direct API calls
- starting, stopping or re-pointing the webhook proxies (5011, 5012) or the
  cloudflared tunnel
- rotating or rewriting `backend/.secrets/razorpay-sandbox.env`

## What is explicitly NOT paused

Everything else continues. Unit tests, frontend work, reading the database,
reading logs, unrelated branches, docs, commits outside the gateway paths. The
claim is on one shared external account, not on the repo.

## Handing it back

Replace the owner line above with your session id and the time, in a commit.
An unclaimed file is not an invitation — if the line still names another
session, that session still owns it.

## Current state at time of claim

- proxies up on 5011 (no capture) and 5012 (capture); **5012 is authoritative**
  — the tunnel points there
- tunnel hostname is ephemeral and dies with the process; check
  `/tmp/pos-demo/cloudflared.log` for the live one rather than reusing a
  hostname from an older report
- Razorpay sandbox account holds 0 payments and 0 refunds. No genuine checkout
  has happened yet. Anything that appears there next should be attributable to
  this run.
