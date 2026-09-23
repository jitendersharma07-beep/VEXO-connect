# Production deployment — single owner

Same reasoning as `GATEWAY-TESTING-OWNER.md`, applied to the other piece of
shared mutable state nobody can undo: the `pos-prod` stack and the database
behind it. This file is in the repo, so every session sees it without being
told to look.

**Owner of the v1.0.1 production deployment: session `7565dff8`, from
2026-09-23 12:40Z, by the platform owner's direct instruction.**

**The deployment is DONE — do not run it again.** Session `896234f0` held this
claim from 06:20Z and executed it: images built 12:36:31/12:36:33Z from the
shared tree at `55bf2dc`, containers recreated 12:37:19Z, migration 12 applied.
Ownership passed to `7565dff8` for post-deploy verification. A second
`up --build` now would rebuild from whatever the shared tree holds at that
moment and is not a no-op.

## Why one owner, and only for this

A deployment is not a restart. Shipping v1.0.1 runs a twelfth migration
(`20260923040000_payment_idempotency_key`) against the live database. Two
sessions doing that at once produce a state nobody can reason about afterwards:

- `prisma migrate deploy` is not safe to run concurrently with itself. Both
  processes read `_prisma_migrations`, both decide the migration is pending,
  and the loser fails partway through a DDL transaction. What the schema is at
  that point is a question the logs cannot answer.
- Image tags are the rollback anchor. If a second session retags `latest`
  while the first is mid-deploy, the tag no longer names what is running and
  the rollback path silently points somewhere else.
- A backup taken during someone else's migration is a backup of neither
  schema.

## What other sessions should pause

Only the production-mutating paths:

- `docker compose -f docker-compose.prod.yml up/down/restart/build` on the
  `pos-prod` stack
- `prisma migrate deploy` or any DDL against `pos-prod-postgres-1`
- retagging `pos-prod-backend` / `pos-prod-frontend` images
- writing to the live `atc_pos` database by any route other than the
  application's own API

## What is explicitly NOT paused

Everything else. The peer session's dev servers in this lane
(`release-v101/backend`, `release-v101/frontend` on 5322) were found running at
claim time and were **deliberately left alone** — they are on non-production
ports and touch nothing this claim covers. Unit tests, browser work against
dev ports, reading the production database, reading logs, other lanes, docs
and commits all continue.

## Handing it back

Replace the owner line above with your session id and the time, in a commit.
An unclaimed file is not an invitation — if the line still names another
session, that session still owns it.

## State AFTER the deploy — read from production 12:40–12:47Z

- 12 migrations applied, latest `20260923040000_payment_idempotency_key`;
  **0** unfinished or rolled-back
- `Payment.idempotencyKey` present, `text`, **nullable** — the property the
  rollback proof depends on
- unique index `Payment_orderId_idempotencyKey_key` on
  `("orderId", "idempotencyKey")` is live
- deployed bundle `index-KdFSGqFs.js` (451 219 B) + `index-j8XEdcDR.css`
  (34 377 B) — the same content hashes as the verified build, so the deployed
  frontend is that build and not a rebuild of something else
- deployed `orders.js`, `schema.prisma`, `app.js` byte-identical to the
  release lane (`f548097b…`, `0b09a8a0…`, `189dd127…`)
- Razorpay still disabled: `/api/gateway/webhook` 404
- rollback anchors intact: `pos-prod-{backend,frontend}:rollback-20260923-prev101`
- no trade since the 05:52:35Z backup — payments still 10 / ₹1695.23, so that
  dump remains a valid restore point

## The two behavioural checks — DONE against production, 12:55–13:10Z

Recorded by `896234f0`. The section above listed both as outstanding; that was
written while they were still running. Neither needs re-running, and both left
their artefacts on disk.

Two corrections to the note that stood here:

- The `LOGIN_FAILED` rows at 12:37:40 and 12:37:54 are **not** a session that
  could not sign in. They are `deploy/prod-verify.mjs` step 8, *"wrong
  credentials → 401"* — a negative control that is supposed to fail, fired once
  on loopback 8110 and once on the public mount. Reading a deliberate failure
  as a blocker is how a working path gets reported as broken.
- Signing in was never the wall. `prod-verify.mjs` asks for its password on a
  TTY and cannot be driven from a pipe (8/9 by design, both origins); the demo
  credentials file the other harnesses already use is at
  `/home/atc-noc/pos-demo-creds-20260921.txt`.

**Receipt/KOT pagination — the real modal, not the bare view.** `uat-render`
renders the receipt on its own page with nothing behind it, so it cannot see
this defect at all. Driven instead through the signed-in SPA on a 12-line order
(1310 px of document behind a 768 px viewport), printing through Chromium with
`preferCSSPageSize`: **KOT 1 page, receipt 1 page**, complete header-to-footer,
and in print media every sibling of `[data-print-root]` is `display:none`.
Negative control — the pre-fix rule re-applied in the same browser gives **9
pages** for the KOT and **5** for the receipt, so the page counter does detect
the defect it is claimed to rule out. 8/8.

**Partial-payment retry.** One partial CASH tender sent 5 times on one order —
twice sequentially, twice concurrently — under a single idempotency key:
**one** payment row, every retry `HTTP 200 replayed=true` returning that same
row, ₹173.25 collected once. Same key with a different amount is refused 409.
Two genuine equal-value CARD tenders under different keys stayed **two** rows,
and two keyless equal tenders stayed two as well (NULLs distinct under the
index). The order was BILLED, never PAID, throughout — a full tender would have
been caught by the old status guard and proved nothing. 9/9.

Both runs cleaned up through the app: every tender refunded to net zero, then
the order voided. Nothing deleted. Orders `BSC-CP/26-27/00013` (opened and
voided unused), `00014` and `00015` are those test orders and are all VOID.

## State at time of claim

- deployed: `847423d`, images `core-v1.0-rc-847423d`, 11 migrations applied,
  latest `20260922200000_audit_actor_role`
- `Payment.idempotencyKey` **absent** from the live schema
- deployed print CSS still carries `visibility: hidden` and has no
  `data-print-root` — so on the running build a receipt prints 3 times and a
  KOT 15 times
- Razorpay: disabled and staying disabled. No `POS_GATEWAY_PROVIDER` in the
  running backend environment; the webhook route answers 404 because `app.js`
  only mounts it when a provider is configured.
