# Production deployment — single owner

Same reasoning as `GATEWAY-TESTING-OWNER.md`, applied to the other piece of
shared mutable state nobody can undo: the `pos-prod` stack and the database
behind it. This file is in the repo, so every session sees it without being
told to look.

**Owner of the v1.0.1 production deployment: session `896234f0`, from
2026-09-23 06:20Z.**

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
