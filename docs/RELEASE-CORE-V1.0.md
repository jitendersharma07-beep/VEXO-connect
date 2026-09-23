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
| Candidate commit | `91f3fac` — reconciled, see below |
| Branch | `phase2-integration` |
| Application code actually deployed | `847423d` |
| Running images | `pos-prod-backend:core-v1.0-rc-847423d` → `3a994795fbf1`, `pos-prod-frontend:core-v1.0-rc-847423d` → `44f405c5d6e1` |
| Proposed tag (NOT created) | `vexo-connect-core-v1.0` |

The candidate advanced from `510cb42` to `91f3fac` during the closing sweep:
`6dcf20c` added this pack, `7838805` added the discount-approval browser
harness, `18ff43f` bounded the container logs, `0c13497` closed the backup and
rotation gates, `317449d` replaced the argued restart-persistence claim with an
observed one, `c793fe3` recorded the final integrity sweep, `e0258d7` merged
the peer lane, `20afdef` corrected §8 to state print capability as a code fact,
and `91f3fac` added the recommended hardware spec.

`20afdef` is the last commit whose build inputs are byte-identical to the
deployed image. `91f3fac` adds one file that is inside a build context but
cannot reach the artefact; that is proved, not assumed, below. Either is
taggable — `91f3fac` is the one to tag if the hardware recommendation should
ship with the release.

### Why two hashes, and why that is not a discrepancy

Production was built at 02:22:35Z, between `847423d` (02:13:11Z) and `40c4e91`
(02:33:49Z), so the running image was built from `847423d`. The candidate is
the later `91f3fac`.

`git diff 847423d..91f3fac` touches only `deploy/` harnesses, `docs/`,
`frontend/docs/`, one root markdown, and `docker-compose.prod.yml` — which is
orchestration read by the daemon at container-create time, not application code
baked into a layer, and which is already applied to the running stack.

#### Equivalence proved over the inputs the Dockerfiles actually read

The earlier version of this argument listed paths from memory. It has been
redone from the build files themselves, because two inputs were missing from
that list and either could have invalidated it.

`backend/Dockerfile` copies `package.json`, `package-lock.json*`, `prisma`,
`src` and `scripts`, under a `.dockerignore` of `node_modules`, `tests`, `*.md`,
`.env*`. **`frontend/Dockerfile.prod` — not `Dockerfile` — does `COPY . .` with
no `.dockerignore` at all**, so the *entire* `frontend/` tree is a build input:
`vite.config.js`, `tsconfig`, `index.html`, `nginx.conf`, `public/`, both
manifests. It also takes a build **arg**, `VITE_BASE_PATH`, which Vite inlines
into the bundle — a value (`/pos/`) that lives in `.env` and never appears in
any source file.

Compared by git tree hash, which covers full recursive content:

| Input | `847423d` | `91f3fac` | |
|---|---|---|---|
| `frontend` (whole tree — `COPY . .`) | `1b075b8fe2b2` | `544996351087` | **differs — see below** |
| `backend/package.json` | `7d0a19b4f0f9` | `7d0a19b4f0f9` | same |
| `backend/package-lock.json` | `22f28b6d6a4f` | `22f28b6d6a4f` | same |
| `backend/prisma` | `0e925b9e5488` | `0e925b9e5488` | same |
| `backend/src` | `ad8d2da409f8` | `ad8d2da409f8` | same |
| `backend/scripts` | `d31967f64513` | `d31967f64513` | same |
| `backend/Dockerfile` | `2b1c4afa4872` | `2b1c4afa4872` | same |
| `backend/.dockerignore` | `98c1fcdac608` | `98c1fcdac608` | same |

The compose `build:` stanzas — context, dockerfile name and `args` — are
unchanged too: the **only** difference in `docker-compose.prod.yml` between the
two commits is the `x-logging` anchor and its three `logging:` references, which
are runtime options, not build inputs.

#### The one input that differs, and why it cannot change the artefact

Because `frontend/Dockerfile.prod` has no `.dockerignore`, `frontend/docs/` is
inside the build context, and `91f3fac` edited `frontend/docs/HARDWARE-CHECKLIST.md`.
So the honest statement is that seven of eight inputs are byte-identical and the
eighth is not. What follows is why that delta is inert, argued from the build
file rather than from intent.

`git diff --name-only 847423d 91f3fac -- frontend` returns exactly one path:

```
frontend/docs/HARDWARE-CHECKLIST.md
```

Every input Vite reads is unchanged — checked individually, not inferred from
the parent tree:

| | `847423d` | `91f3fac` |
|---|---|---|
| `frontend/src` | `7bb410c40837` | `7bb410c40837` |
| `frontend/public` | `69909a5af50e` | `69909a5af50e` |
| `frontend/index.html` | `727627cd158c` | `727627cd158c` |
| `frontend/package-lock.json` | `32af966cfe74` | `32af966cfe74` |
| `frontend/vite.config.js` | `2b51f9933d2b` | `2b51f9933d2b` |

`package.json`, `tailwind.config.js`, `postcss.config.js` and `nginx.conf` match
as well. `vite.config.js` sets no `publicDir` override and no copy plugin, so
nothing outside `index.html`'s import graph and `public/` can enter `dist`.

And `Dockerfile.prod` is two-stage. The runtime stage copies `/app/dist` and
`nginx.conf` and nothing else, so the whole builder filesystem — `frontend/docs/`
included — is discarded. The running container's web root is the proof:

```
/usr/share/nginx/html: 50x.html  assets  favicon.svg  index.html
/usr/share/nginx/html/assets: index-BtquQISu.js  index-C042CUnc.css
```

No `docs` directory ships. The delta's entire effect is a cache miss on the
builder stage's `COPY . .` layer.

So a rebuild at `91f3fac` produces the same served bundle. The running containers
are the candidate's code and **no rebuild is owed**. Tagging `20afdef` instead
avoids even the cache miss, at the cost of leaving the hardware recommendation
out of the tagged tree.

Zero changes under `backend/src`, `backend/prisma`, `backend/scripts`,
`backend/package.json`, `frontend/src` or `frontend/public`.

The original five-file comparison against `510cb42` was:

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

The lane `~/atc-pos-lanes/integration` is **clean** at `91f3fac`. The earlier
note here — that `deploy/discount-approval-run.mjs` was an untracked concurrent
harness — is now obsolete: it was committed as `7838805` and is part of the
candidate.

### The branch divergence — RECONCILED 2026-09-23

It is settled, and the detail is kept because the shape of it explains the
commit graph. Two branches had each committed the *same* log-rotation change:
mine as `18ff43f`, the peer session's as `76d8062`. Identical `git patch-id`
(`46dc726c…`), so the compose file merged with no conflict and no content
change. The deployed checkout `~/atc-pos` also held one uncommitted file,
`deploy/uat-acceptance.mjs`, last touched fourteen hours earlier.

Both were preserved rather than discarded. The loose file was committed on its
own branch as `d899cc6`, attributed to its author; then `phase2-gateway` was
merged into `phase2-integration` as `e0258d7`, resolving two documentation
conflicts hunk by hunk on merit — including one where the peer was right and
this lane was wrong, and their correction was kept in full.

`git log phase2-integration..phase2-gateway` is now **empty**: the release
branch is a strict superset and there is exactly one branch to tag.

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
3. ~~**The newest backup is behind the candidate schema.**~~ **CLOSED
   2026-09-23 03:58Z.** `pos-prod-20260923T035811Z.dump` was taken against the
   current 11-migration schema and restored into an isolated scratch database
   (`atc-pos-dev-db:pos_restore_verify`, never production). `pg_restore
   --exit-on-error` returned 0, all 23 tables and every row count matched the
   manifest exactly, and `_prisma_migrations` read 11 finished / 0 failed. The
   scratch copy was dropped afterwards so no second copy of production survives.

   **Independently corroborated** by a second session, one minute earlier and
   without coordination: `pos-prod-core-v1.0-freeze-20260923-0357.dump`, 97,751
   bytes, `pg_dump rc=0`, dumped to a file *inside* the container and copied out
   so two sha256 digests could agree (`132614112d2f4ba2…`) — a shell redirect
   cannot tell a short write from a complete one, and this host has zeroed files
   mid-write on ENOSPC before. That copy was restored into a **throwaway
   `postgres:16-alpine` container started with `--network none`**, which is a
   stronger isolation claim than a scratch database in a reachable cluster: it
   could not have written to production had the command been wrong. It proved
   its own isolation (`getent` resolves no production host) before the restore.
   `pg_restore --exit-on-error` returned 0; all 42 foreign keys were created
   **and validated**, which is referential integrity checked rather than
   assumed; 0 invalid indexes; an app-shaped `Order`/`Branch`/`Payment` join ran
   on the restored rows. Every one of 13 table counts, the money totals
   (`orders=2603.39 paid=1695.23 discount=375.60`), the licence, the BSC-CH
   closing and the discount-UAT order matched live **line for line**. Container
   and its anonymous volume destroyed afterwards; the live cluster was confirmed
   to still hold only `atc_pos` and `postgres`.

   Two dumps taken a minute apart, restored by different methods into different
   isolated clusters, agreeing exactly, is materially better evidence than
   either run alone — and it cost nothing but the second session's time.
4. **No off-host backup copy — status: PENDING, and it stays PENDING.**
   Every dump lives on the same disk as the database it protects: the freeze
   dump `pos-prod-core-v1.0-freeze-20260923-0357.dump` is on the same
   `ubuntu--vg-ubuntu--lv` volume as `/var/lib/docker` and the Postgres data
   directory. One disk loss takes the database and every backup of it together.
   This is the single largest operational risk in the product and it is not a
   code problem.

   **What was done for the freeze does not close this.** The restore
   verification used a throwaway container on `--network none` — an *isolated*
   destination, not a *separate* one; it lived and died on the same host and
   the same disk. Isolation proved the dump restores; it proves nothing about
   surviving the loss of this machine.

   `docs/BACKUP-RESTORE.md` already carries the procedure and a hash-verified
   `scp` script. **Writing a procedure is not evidence of a copy.** This item
   closes only when both of these exist and are recorded:

   - a backup present on a destination that does not share this host's disk,
     power or landlord, with its hash matched against the local original; and
   - a **restore performed from that off-host copy** into a scratch database,
     verified the way the local one was — `pg_restore --exit-on-error`, FK
     validation, and representative counts matched against production.

   Until both are on the record, quote this as **PENDING**, not as "documented"
   or "scripted". Neither of those is a backup.
5. ~~**Container logs are unbounded.**~~ **CLOSED 2026-09-23 04:01Z** by
   `18ff43f`. All three `pos-prod` services now carry `json-file` with
   `max-size=10m`, `max-file=5` — a hard 50 MB per container, 150 MB for the
   stack. Verified on the running containers via `docker inspect`. Existing
   logs were archived to
   `atc-backups/pos-prod/logs-pre-rotation-20260923T040500Z` before the
   recreate rather than truncated. The daemon still has no
   `/etc/docker/daemon.json`, so **every other stack on this host remains
   unbounded** — that was left alone deliberately, as it is outside VEXO
   Connect's blast radius and would need a daemon restart.
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

**Nothing has been bought yet.** The owner asked for the best configuration
rather than supplying one, so the buy-to recommendation lives in
`frontend/docs/HARDWARE-CHECKLIST.md` §0, chosen line by line against the
constraints in §8.0 below — 80 mm roll with 72 mm printable, Epson TM-T82/T88,
USB for a single counter, Windows 11, Chrome or Edge at 100 % zoom, 1366×768 or
larger. Buy to that and this section runs as written with no code change.

> **Corrected 2026-09-23.** The previous version of this section listed a cash
> drawer group ("drawer opens on cash payment", "manual open drawer works for an
> authorised role", "drawer opening is audited") and an app-triggered paper cut.
> **None of those features exists in this build**, so they were not pending
> hardware — they were pending *implementation*, and a checklist that asks an
> operator to verify them sets them up to report a defect against something that
> was never built. Read §8.0 before scheduling anything.

### 8.0 What this build can actually do at a printer

Established from the source, not from a prior document: the whole print path is
`window.print()` in `frontend/src/components/Receipt.jsx`, plus a `@page` size
rule computed in `frontend/src/lib/printPageSize.js`. Neither the backend nor
the frontend has any raw-device path — `grep` finds no ESC/POS byte sequence
anywhere in `backend/src` or `frontend/src`, and no dependency that could open
one: backend carries argon2, prisma, express, helmet, jsonwebtoken, pino and
zod; frontend carries axios, lucide-react, react, react-router-dom and vite.
No `escpos`, no `serialport`, no `node-thermal-printer`, no `usb`.

| Capability | State | Why |
|---|---|---|
| Receipt + KOT rendered for an 80 mm roll | **Implemented** | 72 mm printable window (576 dots @ 203 dpi), `PAPER_MM = 80` |
| Per-job page height | **Implemented** | Measured off a detached clone at print width; a KOT asks ~66 mm, a long bill ~155 mm, so the roll is not over-fed |
| Chromium `@page` workaround | **Implemented** | Chromium silently rejects `size: 80mm auto` and falls back to US Letter; `beforeprint` rewrites it with a concrete height |
| Ctrl+P as well as the app's Print button | **Implemented** | Both routes go through the same `beforeprint` hook |
| **58 mm paper** | **NOT SUPPORTED** | Width is fixed at 80/72 mm in two places. A 58 mm roll needs a code change, not a setting |
| **ESC/POS raw output** | **NOT IMPLEMENTED** | No code, no library, no device path |
| **App-triggered paper cut** | **NOT IMPLEMENTED** | Would need ESC/POS `GS V` |
| **Cash-drawer kick** | **NOT IMPLEMENTED** | Would need ESC/POS `ESC p` through the printer's drawer port. There is no drawer feature to audit or to permission |
| **Silent printing** | **NOT IMPLEMENTED** | Every job raises the browser print dialog |
| **Receipt-to-counter / KOT-to-kitchen routing** | **NOT IMPLEMENTED** | One print path; the operator picks the printer in the dialog, per job |

The printer's **own** auto-cut may still fire at end of page — that is the
driver cutting, not the application asking. It is worth observing (§8.1 item 9)
precisely because it is the printer's behaviour and varies by model.

If the customer needs silent print, auto-cut, drawer kick or two-printer
routing, each is a **new integration** — a local print agent or an ESC/POS
bridge — and must be scoped as new work. None is a configuration setting, and
none should be described to the customer as included.

### 8.1 Thermal printer — runnable against this build

1. Printer is connected, powered, loaded, and visible in the browser's print dialog.
2. Bill an order and print. The receipt physically emerges.
3. Header: business name, branch, address, GSTIN — legible, not clipped.
4. Every line item appears with quantity, unit price and line total.
5. Discount line shows when a discount applied, with the correct amount.
6. Tax breakup is correct and legible.
7. Grand total matches the till screen to the paisa.
8. Invoice number and timestamp print, and match the database row.
9. **Observe** what the paper does after the footer: does the printer cut, and
   does it cut after the last line rather than mid-receipt? Record the model's
   behaviour — this is the driver's, not the app's.
10. Measure the printed content width with a ruler — expect ~72 mm.
11. Print a KOT and a long receipt back to back. The paper fed should differ
    between them; a large constant feed on both means the driver is imposing a
    fixed form instead of the requested height. Record the model.
12. Each ticket emerges as **one** piece of paper — a receipt in two parts was
    paginated, which on a roll means cut in half.
13. Reprint the same bill — identical output, **no new invoice number allocated**.
14. Print with the printer offline — the UI reports the failure and does not
    silently claim success, and the order is not corrupted.
15. Print a wide item name and a 3-digit quantity — no wrap that loses characters.
16. The five verbatim strings survive printing (`DEMO — sample data…`,
    `MANUAL PAYMENT RECORD…`, `GATEWAY PAYMENT…`, `REFUND REQUESTED…`,
    `REFUND HANDED BACK…`), and a *requested* refund does not read as returned.

### 8.2 End to end on hardware

17. Full counter run: order → KOT → bill → print → cash → refund → day close.
    **No drawer step** — there is no drawer integration to exercise.
18. Day close totals match the physical cash counted, the count being entered by
    hand as the software expects.
19. Pull the printer's power mid-print and recover — no duplicate invoice, no
    lost order.

### 8.2.1 Two demo discount policies are deliberately left in place

They were created through the owner UI for the Phase-3 acceptance run and are
**kept, not cleaned up**, so that discount approval can be re-tested on the
counter hardware without re-configuring anything. Read as exact production
state, 2026-09-23:

| Level | Subject | Grants | Branch |
|---|---|---|---|
| `USER` | `demo.cashier@atcpos.example` | line + order discount, ceiling **10 %** | `BSC-CP` |
| `USER` | `demo.manager@atcpos.example` | **may approve up to 20 %** | `BSC-CP` |

Scope, stated so nobody widens it by accident:

* Both rows are `level = USER`. They attach to **one named demo account each**
  and nothing else. There is no `COMPANY` row and no `BRANCH` row, so no other
  operator inherits anything from them.
* They reach **only the `BSC-CP` branch**, through those users' own branch.
  `BSC-CH` is untouched.
* Every field they do not set reads `inherit`, which falls through to the code
  floor in `discountPolicy.js` — and that floor is **DENY** for `CASHIER` and
  `BRANCH_MANAGER`. Deleting these two rows therefore removes permission; it
  cannot accidentally grant any.
* They govern demo accounts in the demo tenant. No real customer operator is
  affected by either row.

Reversal is a UI action, not a SQL one: the owner's discount-policy screen has
a **Clear** control per subject. Do not delete the rows by hand — the screen
writes the audit row that records who removed the permission.

Cash drawer opening, its role permission and its audit row; app-triggered cut;
silent print; automatic printer routing; 58 mm paper. Each is new work. They are
named here so that their absence from §8.1/§8.2 reads as deliberate rather than
as an oversight.

When every check in §8.1 and §8.2 passes, and only then, create the tag:

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
* **Gateway is off** — proven four ways, not one: no `POS_GATEWAY_PROVIDER` in
  the running container's environment (and `gatewayEnabled` is exactly
  `Boolean(env.POS_GATEWAY_PROVIDER)`), `POST /api/gateway/razorpay/webhook`
  answers **404** because `app.js` only mounts the router when enabled, and the
  data agrees: zero `PaymentIntent`, zero `GatewayWebhookEvent`, zero
  non-`MANUAL` payments or refunds, zero `providerRef` set anywhere.
* **Discount approval, browser UAT** — executed against production by the peer
  session (`7838805`) and then verified here independently from the resulting
  production rows rather than from their report. Order
  `cmudkf6v200a6n36y33wo1mxd`, ten `ORDER_DISCOUNT_*` audit rows between
  03:50:53 and 03:51:37: within-limit set (0 → 10%) with no approver;
  above-limit refused at 25%; `BAD_PASSWORD` refused **with the next row's
  `before` still reading 10%**, which is what proves no mutation; over-limit
  approver refused at 40% with the approver's own 20% ceiling recorded;
  authorised approval 10% → 15% by `demo.manager` (`BRANCH_MANAGER`) with a
  reason; and a replay landing 15% → 15% rather than compounding. Every row
  carries requester, role, ceiling and `branchId`. The order finished VOID with
  **no payment attached**, and the newest payment on the whole database predates
  the run by seven minutes — the UAT moved no money.
* **Log rotation** — `max-size=10m`, `max-file=5` confirmed on all three running
  containers after recreate; stack healthy, frontend `/` 200 and `/api/health`
  200 through the real proxy path; database row counts identical across the
  Postgres recreate.
* **Restart persistence — now OBSERVED, not argued** (2026-09-23 04:04Z). The
  round-trip that execution policy refused earlier went through on a later
  attempt, so this no longer rests on the config being declarative. All three
  containers were restarted in dependency order with `docker restart` —
  deliberately *not* `compose restart`, because `docker restart` does not
  re-read `docker-compose.prod.yml`. Surviving it therefore proves the options
  are persisted in each container's own `HostConfig`, which is the stronger
  claim and the one that actually matters after an unplanned reboot.

  | | |
  |---|---|
  | window | 28s total, each container healthy 6s after its own restart |
  | after | `{"max-file":"5","max-size":"10m"}` on all three — unchanged |
  | health | `/pos/` 200, `/pos/api/health` 200 `{"status":"ok"}` |
  | schema | `migrate deploy` re-ran on boot and stayed a no-op — "No pending migrations to apply", 11 finished / 0 unfinished |
  | data | `Order=14 Payment=10 Refund=5 DayClose=1 PosAuditLog=291`, identical before and after |

* **The cap is enforced, not merely accepted.** `docker inspect` only proves the
  daemon *took* the option. A throwaway container on `1m × 3` was given 60,000
  lines (~7 MB): 14,189 survived, the oldest were dropped, and readback held at
  1.49 MB. The ceiling is real. Production is `10m × 5` = **50 MB per
  container, 150 MB for the stack**, against a measured backend rate of
  ~116 KB/hour (~2.8 MB/day) — roughly 18 days of backend history, and the
  durable record is the audit table and the dump, not stdout.

### 9.1 Final integrity sweep, and the three things it flagged

Run read-only against live production on 2026-09-23. The schema side is clean:
**42 of 42 foreign keys created *and* validated** (`convalidated`, so none is a
`NOT VALID` shell that never checked the existing rows), **0 invalid indexes**,
**0 unvalidated constraints**, 11 migrations finished. Every orphan check and
every money check returned zero: no order without a branch, no item/payment/
refund without an order, no policy without a subject, no PAID order underpaid,
no refund exceeding what was paid, `total = subtotal − discount + tax` on all
14 orders, no VOID order holding money, and no discount exceeding its subtotal,
approved without an approver, or approved by a non-user.

Three counters came back non-zero. All three were chased to ground, and none is
a data defect — but they are written down here so the next reader does not have
to re-open them.

1. **"users without a company: 1"** — this is the `POS_SUPER_ADMIN`, whose
   `companyId` is `NULL` and whose column is nullable *by design*: the platform
   operator sits outside every tenant. All 15 tenant users have a real company.
   The check was phrased too broadly; the data is right.

2. **"audit rows without an actor: 52"** — 46 `LOGIN_FAILED` (no actor is
   knowable at a failed login) and 6 `PASSWORD_ROTATED` written by the
   2026-09-21 rotation script, which runs from the CLI with no web session and
   records `{"source":"scoped-rotation","demoCredential":true}`. **No other
   action type is ever missing an actor.** Known limitation, not corruption.

3. **"audit rows without a role: 100"** — `actorRole` is *new in this release*
   (migration `20260922200000_audit_actor_role`) and was deliberately not
   backfilled. The cut-over is exact: the last roleless row is 02:23:26 and the
   first roled row is 02:29:48 on 2026-09-23, with **zero** roleless rows after
   it. All 139 post-deploy rows carry a role, including all 13 rows of the
   Phase-3 acceptance order. The single roleless `ORDER_DISCOUNT_SET` is from
   2026-09-22 18:53, before the deploy. This is a forward-only column addition
   behaving exactly as designed.

   Inside that set, 32 rows name an `actorId` that no longer exists. That is
   intentional too: **`PosAuditLog` carries no foreign key at all**, so the
   audit trail outlives the user it describes. The 11 vanished actors are the
   pre-release demo tenant — and the orders they touched are gone with them
   (`entityIds still present in "Order": 0`), so the 9 money-shaped rows among
   them describe no live financial row. The live ledger is self-consistent
   independently of them.

   The residual limitation is honest and small: for audit rows written before
   2026-09-23 02:29, the actor's *role at the time* was never captured, and for
   those 32 demo rows the actor can no longer be named at all.
