# VEXO Connect Core v1.0 — release freeze pack

**Status: PREPARED, NOT DECLARED.** Software is frozen. The release tag
`vexo-connect-core-v1.0` has deliberately **not** been created, because physical
hardware acceptance (printer, cash drawer) has not been run. Everything in this
document is the state a tagger would need; nothing here authorises the tag.

Prepared 2026-09-23 on `phase2-integration`.

---

## 1. Candidate

| | |
|---|---|
| Candidate commit | `510cb42` |
| Branch | `phase2-integration` |
| Application code actually deployed | `847423d` |
| Proposed tag (NOT created) | `vexo-connect-core-v1.0` |

### Why two hashes, and why that is not a discrepancy

Production was built at 02:22:35Z, between `847423d` (02:13:11Z) and `40c4e91`
(02:33:49Z), so the running image was built from `847423d`. The candidate is
the later `510cb42`.

`git diff --stat 847423d..510cb42` touches five files and **none of them ship**:

```
UAT-TILL-RESERVATION.md
deploy/billing-browser-run.mjs
deploy/render-discount-screens.mjs
deploy/render-discount-till.mjs
docs/DEPLOY-PHASE2.md
```

`backend/Dockerfile` copies `package.json`, `prisma/`, `src/` and `scripts/` —
not `deploy/`, not `docs/`, not root markdown. So the image built at `847423d`
is identical in shipped content to one built at `510cb42`. Production is running
the candidate's application code. The delta is test harnesses and documentation.

This is worth restating at tag time: re-verify the diff still contains no
`backend/src`, `frontend/src` or `prisma` path before treating the two as equal.

### Working tree

Clean except one untracked file, `deploy/discount-approval-run.mjs`, which is a
**concurrent session's** discount-approval harness and was still being written
while this pack was assembled. It is not part of the candidate and must not be
swept into a release commit by anyone tidying the tree.

---

## 2. Migration inventory

Three-way agreement, verified rather than assumed:

* repository `backend/prisma/migrations/` — **11**
* the shipped image `/app/prisma/migrations` — **11**
* production `_prisma_migrations` — **11 rows, 0 unfinished, 0 rolled back, 0 with logs**

Names match exactly across all three.

| # | Migration | Applied (UTC) |
|---|---|---|
| 1 | `20260920000000_pos_foundation` | 2026-09-20 16:32 |
| 2 | `20260920180000_pos_phase2_orders` | 2026-09-21 02:56 |
| 3 | `20260921050000_pos_gateway_intents` | 2026-09-22 12:54 |
| 4 | `20260921060000_gateway_event_intent_relation` | 2026-09-22 12:54 |
| 5 | `20260921070000_refund_channel_and_status` | 2026-09-22 12:54 |
| 6 | `20260921080000_refund_idempotency_key` | 2026-09-22 12:54 |
| 7 | `20260921090000_payment_provider_ref` | 2026-09-22 12:54 |
| 8 | `20260922120000_day_close` | 2026-09-22 12:54 |
| 9 | `20260922190000_discount_policy` | 2026-09-23 02:24 |
| 10 | `20260922190000_gateway_event_source` | 2026-09-23 02:24 |
| 11 | `20260922200000_audit_actor_role` | 2026-09-23 02:24 |

Migrations 9–11 were applied by the container's own boot migrate at 02:24, which
is why they postdate the 02:22 image build.

---

## 3. Production images

| Role | Image ID | Tags |
|---|---|---|
| backend (running) | `3a994795fbf1` | `latest`, `core-v1.0-rc-847423d` |
| frontend (running) | `44f405c5d6e1` | `latest`, `core-v1.0-rc-847423d` |

**The `core-v1.0-rc-847423d` tags were added during this freeze prep and did not
exist before.** Until then the running images carried `latest` and nothing else,
which means the next `compose build` would have moved `latest`, orphaned them,
and left production with no image to roll back *to* — a state this project has
already been in once. If you take nothing else from this document: a running
production image with only a floating tag is not anchored.

### Rollback anchor

| Role | Image ID | Tag |
|---|---|---|
| backend | `f000ba8e3e89` | `rollback-20260923-prediscount` |
| frontend | `40a41c4e0c09` | `rollback-20260923-prediscount` |

That pair is commit `543a220` — Core as it stood immediately before the discount
policy feature.

---

## 4. Rollback procedure

Rolling the images back does **not** roll the database back. The anchor expects
**8** migrations; production has **11**. Old code against a newer schema is the
situation you are actually entering, so read section 4.2 before doing it.

### 4.1 The steps

```
cd /home/atc-noc/atc-pos            # the live-mount deploy tree
docker compose -p pos-prod stop backend frontend
docker image tag pos-prod-backend:rollback-20260923-prediscount  pos-prod-backend:latest
docker image tag pos-prod-frontend:rollback-20260923-prediscount pos-prod-frontend:latest
docker compose -p pos-prod up -d --no-deps backend frontend
```

Then confirm recovery before telling anyone it worked:

```
docker inspect pos-prod-backend-1 --format '{{.State.Health.Status}}'
docker exec pos-prod-backend-1 node -e "fetch('http://127.0.0.1:5000/api/health').then(async r=>console.log(r.status, await r.text()))"
```

To come forward again, retag `core-v1.0-rc-847423d` to `latest` and repeat.

### 4.2 The one hazard, stated precisely

Of the three migrations the rollback leaves stranded, two are harmless to older
code and one is not:

* `20260922200000_audit_actor_role` — adds `PosAuditLog.actorRole` **nullable,
  no default**. Old code omits it, the column goes NULL. Safe.
* `20260922190000_discount_policy` — adds a new `DiscountPolicy` table the old
  code never looks at, plus `Order.discountApprovedById`,
  `Order.discountApprovedAt`, `Order.discountReason`, all **nullable**. Safe.
* `20260922190000_gateway_event_source` — adds
  `GatewayWebhookEvent.source` **NOT NULL**, and then explicitly `DROP DEFAULT`.
  **Old code inserting a webhook event omits `source` and the INSERT fails.**

That third one is only a live hazard if the gateway is enabled while rolled
back. Today it is not: production has zero `GatewayWebhookEvent` rows, zero
`PaymentIntent` rows, no Razorpay environment keys, and the webhook route is
unmounted when no provider is configured. So the rollback is safe **in the
current configuration**, and stops being safe the moment Razorpay is switched
on. If you ever roll back with a live gateway, restore a `DEFAULT 'WEBHOOK'` on
that column first.

### 4.3 Data anchor

The newest database backup at freeze time is `pos-prod-20260922T210116Z.dump`,
whose manifest records **8** migrations — it predates 9–11. It is therefore a
valid restore target for the *rollback* image and **not** for the candidate.
See section 7.

---

## 5. Production smoke test

Run after any deploy or rollback. Every line is a check someone can fail.

1. `docker inspect pos-prod-backend-1 pos-prod-frontend-1 pos-prod-postgres-1 --format '{{.Name}} {{.State.Health.Status}}'` — three `healthy`.
2. `docker exec pos-prod-backend-1 node -e "fetch('http://127.0.0.1:5000/api/health').then(async r=>console.log(r.status, await r.text()))"` — `200 {"status":"ok","service":"atc-pos-api"}`.
3. Load `https://atcworkspace.com/pos/` — login screen renders, no console error.
4. Sign in as a cashier. The top bar shows the branch and the licence expiry.
5. Start a Takeaway order, add one item — subtotal and tax appear.
6. Apply a within-ceiling discount — it applies with no approval prompt.
7. Apply an above-ceiling discount — it is refused and the approval prompt appears.
8. Bill the order — an invoice number is issued, and it is one higher than the last.
9. Take a cash payment — the order reaches PAID.
10. Refund part of it as a manager — the refund records against that order only.
11. Open Sales Report for today — the figures match what you just did.
12. Check `_prisma_migrations`: `SELECT count(*) FILTER (WHERE finished_at IS NULL) FROM "_prisma_migrations";` — zero.
13. `docker logs pos-prod-backend-1 --tail 50 | grep -c '"level":50'` — zero errors.
14. Confirm redaction survived the deploy: the same log shows `"cookie":"[REDACTED]"` and no `"password"` key.

Steps 5–11 write rows. Run them in the demo tenant, never in a customer's.

---

## 6. Release notes draft — Core v1.0

**VEXO Connect Core** is the till. One company, its branches, its staff, and the
path from an order to a closed day.

**Ordering and billing.** Dine-in, takeaway and delivery orders; a table map for
dine-in; line items with per-line tax; KOT generation; order void with a reason.
Invoice numbers are allocated per branch per financial year from a counter and
are never re-issued.

**Payments.** Cash, card, UPI and "other", recorded manually by the person
taking the money. Partial and multiple payments per order. Manual payment entry
is deliberately distinguished from gateway-verified payment everywhere it is
displayed.

**Refunds.** Manager-and-above, bounded by what the order actually took, with a
reason. A refund can never exceed its order's total.

**Discounts with an approval ceiling.** A discount policy resolves
company → branch → individual, so a customer's owner sets the house rule, a
branch may tighten it, and one cashier may differ. Within a cashier's ceiling a
discount just applies. Above it, the till refuses and asks for an approver, who
authenticates with **their own** credentials — never a shared override code —
and who can only approve within their own limit. Every outcome is audited with
the requester, their role, the effective ceiling that applied, the approver, the
branch, the before and after amounts, and the reason. Approval passwords are
never stored or logged.

**Day close.** Opening float, counted cash, expected cash, variance, and a split
by tender. One closing per branch per business date. A closing says when it
stopped being true if activity lands after it.

**Reports.** Sales by day, by branch, by payment method; an activity screen that
reads the audit table.

**Licensing.** Per-company licence with an expiry, surfaced in the top bar in the
browser's timezone.

**Security.** Session-backed auth with server-side revocation; every request
re-reads the session and user rather than trusting the token. Tenant scope is
resolved server-side and is not client-supplyable. Role gates on every
money-moving route. Request logging redacts credentials.

---

## 7. Known limitations

Honest list. None of these is a defect; each is a boundary.

1. **Physical hardware is untested.** Printer and cash drawer have never been
   exercised against real devices. Print output is verified only as rendered
   HTML. See section 8.
2. **Razorpay is implemented but disabled and never sandbox-proven end to end.**
   Production carries no gateway keys, the webhook route is unmounted, and there
   are zero intents and zero webhook events. The adapter has unit and mock
   coverage only.
3. **The newest backup is behind the candidate schema.** At freeze time the
   latest dump recorded 8 migrations against production's 11. The nightly timer
   (`atc-pos-backup.timer`, 02:30 Asia/Kolkata) will close the gap on its next
   run; an on-demand run during this freeze was denied by execution policy. A
   restore from the current newest dump gives a schema three migrations old.
4. **No off-host backup copy.** Every dump lives on the same disk as the
   database it protects. This is the single largest operational risk in the
   product and it is not a code problem.
5. **Container logs are unbounded.** The daemon has no `/etc/docker/daemon.json`,
   so `json-file` runs without `max-size`, on a filesystem already at 83%, which
   also carries `/`, `/tmp` and every database volume. Slow-burning, but it fills.
6. **Request headers are logged under a denylist, not a whitelist.** `cookie`,
   `authorization` and `x-api-key` are redacted by name. A future
   credential-bearing header leaks until someone adds it to the list.
7. **Only `SUSPENDED` revokes live sessions.** Moving a company to `PENDING`
   blocks new logins but leaves existing sessions valid for up to 12 hours.
8. **Content-Security-Policy is off.** Helmet is on with HSTS, nosniff and
   frameguard; CSP is explicitly disabled.
9. **The discount approval throttle is per-process.** An in-memory map. Correct
   at one replica; the attempt budget multiplies if the API is ever scaled out.
10. **A seeded install creates a demo tenant.** Three demo users with random
    passwords, alongside the platform super-admin. Fine here; omit the demo
    tenant from a customer install.
11. **Seed prints generated passwords to stdout**, which under compose lands in
    the container log on disk.
12. **Deleting an order does not reclaim its invoice number.** Production shows
    gaps at BSC-CP 00001–00003 from purged UAT orders. No number is ever reused
    — the audit row survives the order — but gaps need explaining under GST.
13. **A platform super-admin can edit a customer's catalog and mint an owner.**
    Deliberate vendor capability; it should be contractual, not implicit.
14. **Manual refunds carry no idempotency key.** The column is nullable and only
    gateway refunds populate it; manual refund de-duplication relies on the
    operator.
15. **Multi-GST, inventory, recipe/BOM, purchase/GRN, delivery, KDS expansion,
    loyalty/CRM, aggregator integrations and central kitchen are out of Core**
    by design.

---

## 8. Hardware acceptance checklist

This is the only thing standing between the candidate and the tag. Run it on the
real counter, with the real devices, on the deployed build.

### Thermal printer

1. Printer is connected, powered, loaded, and visible to the browser's print dialog.
2. Bill an order and print. The receipt physically emerges.
3. Header: business name, branch, address, GSTIN — legible, not clipped.
4. Every line item appears with quantity, unit price and line total.
5. Discount line shows when a discount applied, with the correct amount.
6. Tax breakup is correct and legible.
7. Grand total matches the till screen to the paisa.
8. Invoice number and timestamp print, and match the database row.
9. Footer and cut: the paper cuts cleanly after the footer, nothing truncated.
10. Reprint the same bill — identical output, **no new invoice number allocated**.
11. Print a KOT to the kitchen printer, if a separate one is configured.
12. Print with the printer offline — the UI reports the failure and does not
    silently claim success, and the order is not corrupted.
13. Print a wide item name and a 3-digit quantity — no wrap that loses characters.

### Cash drawer

14. Drawer opens on cash payment.
15. Drawer does **not** open on card or UPI payment.
16. Manual "open drawer" works for an authorised role and is refused otherwise.
17. Drawer opening is audited.

### End to end on hardware

18. Full counter run: order → KOT → bill → print → cash → drawer → refund → day close.
19. Day close totals match the physical cash counted in the drawer.
20. Pull the printer's power mid-print and recover — no duplicate invoice, no lost order.

When every one of those passes, and only then, create the tag:

```
git tag -a vexo-connect-core-v1.0 <candidate> -m "VEXO Connect Core v1.0"
```

---

## 9. What was verified for this freeze, and how

So that the next reader does not re-derive it.

* **Migrations** — counted in the repo, inside the running image, and in
  `_prisma_migrations`. Three-way match, zero unfinished, zero rolled back.
* **Data integrity** — no duplicate payments (by order+method+amount, by
  `providerRef`, by `intentId`), no duplicate refunds (by `idempotencyKey`, by
  order+amount, by `providerRef`), no duplicate invoice numbers globally or per
  branch, no billed order without an invoice number, no orphan
  `OrderItem`/`Kot`/`Payment`/`Refund`, every line item summing to its order's
  subtotal and tax, `subtotal − discount + tax = total` on every order, every
  PAID order's payments equalling its total, no refund exceeding its order.
* **Day close** — the one closing recomputed from underlying rows as of its own
  `closedAt`: orders, cash sales and cash refunds all matched, variance zero.
* **Audit coverage** — every billed order, payment, refund, void and closing has
  its audit row. The only rows without an actor are `LOGIN_FAILED` (no
  authenticated actor by definition) and operator-script `PASSWORD_ROTATED`.
* **Credential hygiene** — zero credential-shaped keys in any audit `meta`, zero
  in the backend log; `BAD_PASSWORD` appears only as a refusal *reason code*.
* **Crash recovery** — production Postgres was genuinely interrupted twice on
  2026-09-21 and performed automatic WAL recovery both times, reaching "ready to
  accept connections" with no PANIC and no corruption, and the migration rows
  written before those crashes survived them. This is observed history, not a
  drill.
* **Gateway is off** — zero intents, zero webhook events, all payments
  `MANUAL`/`CASH`, and no Razorpay key in the backend container's environment.
