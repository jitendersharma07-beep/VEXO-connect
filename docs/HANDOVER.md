# ATC POS — client handover pack

Internal ATC document. What was delivered, what was proven, what is still owed,
and the exact steps to put a café on this system.

The two documents the client actually receives are `guide-owner.md` and
`guide-cashier.md`. This one stays with ATC.

---

## 1. The build being handed over

| | |
|---|---|
| URL | `https://atcworkspace.com/pos` |
| Health | `https://atcworkspace.com/pos/api/health` → `{"status":"ok","service":"atc-pos-api"}` |
| Backend commit | `2c3acb1`, image `pos-prod-backend:20260922-dayclose`, deployed 12:54 UTC |
| Frontend commit | `652732f`, image `pos-prod-frontend:20260922-honest-screens`, deployed 13:41 UTC |
| Frontend bundle | `assets/index-CuAz2wOg.js` |
| Rollback tags | `pos-prod-backend:20260922-dayclose`, `pos-prod-frontend:rollback-20260922-1340` |
| Database migrations applied | 8 |

**The two halves are on different commits and that is deliberate.** `652732f`
changes three frontend screens and nothing else, so the backend was left alone
rather than restarted for no reason. Commits after `652732f` (`9bd3133`,
`ce841bb`) touch only `deploy/` and `docs/`.

Confirm before quoting any of this. Re-read it from the live site rather than
trusting the table — a docs table is a claim, the served bundle is the fact:

```sh
curl -fsS https://atcworkspace.com/pos/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
docker exec pos-prod-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null;"'
```

Deploy procedure, rollback and the migration gate: `docs/DEPLOY-PHASE2.md`.
Backups and recovery: `docs/BACKUP-RESTORE.md`.

---

## 2. Honest status, in three columns

The brief asked for "ready for demo" and "ready for actual café billing" to be
answered separately. They have different answers.

### Ready to demonstrate to a client, today

The whole billing workflow, on the seeded demo tenant: sign in, build an order,
send a KOT, discount it, bill it, take cash/card/UPI, print the receipt, reprint
from history, void, refund, close the day, read the owner's reports. Company and
branch isolation, role restrictions, licence expiry behaviour.

### Ready for a real café to bill on

The same workflow, subject to three things being done first, all listed in §7:
the client's own company and menu created, a printer proven against the real
hardware, and the demo tenant separated from the client's.

None of them is development work. All of them need information only the client
has. A fourth item stood here until 2026-09-22 — the backup schedule — and it
is now installed, run and drilled; see §5.

### Not ready, and out of scope for this handover

Gateway-verified online payment (§8), offline mode, inventory, aggregator
integration. These are later phases and the UI does not pretend otherwise —
there is no "Pay online" button on a tenant with no provider configured, rather
than a button that fails.

---

## 3. Provisioning a client — the procedure

**No password ever passes through chat, a ticket, or a shell history.** The
rotation script exists precisely so that it does not have to.

**1. Create the company, branches and staff** as the owner, through the UI
(`guide-owner.md` §2), or via ATC → Companies for the company shell. Create each
person with their real email address.

**2. Set their first passwords.** Preview first — it writes nothing:

```sh
docker exec pos-prod-backend-1 node scripts/rotate-pos-passwords.mjs \
  --emails owner@cafe.example,cashier@cafe.example
```

Then write, with the generated passwords going to a file rather than the
screen:

```sh
docker exec pos-prod-backend-1 node scripts/rotate-pos-passwords.mjs \
  --emails owner@cafe.example,cashier@cafe.example --confirm --out /tmp/pw.txt
docker cp pos-prod-backend-1:/tmp/pw.txt ./pw.txt
docker exec pos-prod-backend-1 rm -f /tmp/pw.txt
```

> **Copy the file out immediately.** `--out` writes *inside* the container. The
> next `docker compose up -d` replaces that container and the print-once
> passwords are gone with it, with the accounts already changed. This has
> happened.

Alternatively `--prompt` reads each password from the terminal with echo off
(needs `docker exec -it`), so nothing is generated and nothing is written down.

**3. Hand them over out of band** — password manager, or in person. Delete
`pw.txt` afterwards.

**4. Every real account keeps `mustChangePassword = true`**, which the script
sets by default. The user is forced to choose their own password on first
sign-in and ATC never knows it. **Never pass `--demo` for a real account** — it
disables that control, and it exists only for a shared demo login.

**5. Verify** one sign-in per role before handing over, and confirm the forced
password-change prompt appears.

---

## 4. Acceptance checklist

Walk this with the client. Every line is a thing to *do*, not to be told.

**Access**
- [ ] `https://atcworkspace.com/pos` loads, typed directly into a fresh browser
- [ ] Owner signs in; forced password change appears; new password works
- [ ] Cashier signs in; sees Sell and Orders, and **not** Catalog, Team, Licence
- [ ] Cashier typing `/pos/catalog` into the address bar is refused, not shown
- [ ] Refreshing on a nested page (e.g. `/pos/reports/day-close`) reloads it,
      not a 404

**A complete sale**
- [ ] Dine-in order on a table; tapping the same table resumes it
- [ ] Add items, change quantities, add a variant item
- [ ] Send KOT; kitchen ticket shows items and quantities, no prices
- [ ] Sent lines are quantity-locked
- [ ] Apply a bill discount, then a line discount; totals follow
- [ ] Bill; invoice number appears in branch format; order locks
- [ ] Record cash with tendered > total; change due is correct
- [ ] Receipt prints on the café's own printer at 80 mm
- [ ] Reprint the same receipt from Orders

**Money must not double**
- [ ] Double-click Bill — one invoice number, not two
- [ ] Double-click Record payment — one payment
- [ ] Reload mid-order; the order is still there with its items
- [ ] Restart the service; the order, bill and payment all survive

**Corrections**
- [ ] Manager voids a kitchen-sent line; it shows as voided, not deleted
- [ ] Manager refunds part of a payment; balance updates
- [ ] Voiding an order with collected money is **refused** until refunded
- [ ] Cashier cannot see or reach any of the three

**Separation**
- [ ] A second company's user cannot see the first's orders, menu or staff
- [ ] A branch manager sees only their branch; the owner sees both
- [ ] Money from a sale at one branch appears under that branch **only**

**Day end**
- [ ] Daily closing shows expected cash matching the day's cash sales
- [ ] Open orders are warned about
- [ ] A variance of ₹1 is refused without a note; accepted with one
- [ ] Filing again the same day creates a correction, not a duplicate
- [ ] Sales report for the day matches the closing

**Licence**
- [ ] Licence page shows plan and expiry
- [ ] With an expired licence: sign-in and reading still work, billing is
      refused with a clear message (test on a scratch tenant, not the client's)

**Devices**
- [ ] Cashier screen usable at the till's actual resolution
- [ ] Owner dashboard readable on the owner's laptop and phone

---

## 5. What has been verified, and how

Separated by kind of evidence, because they are not equally strong.

### Automated tests — mocked, not a real provider

Backend suite: **222 passed / 222**, 7 files (foundation 20, money 13,
logRedaction 7, phase2 42, razorpay 53, razorpayFlow 32, gateway 55), run
against the dev test database and re-measured at `1bcd200`. Money arithmetic, order lifecycle, RBAC, tenant scoping,
licence gating, refund states, log redaction, and the gateway adapter **against
a mock**. Re-measure rather than quoting this number:

```sh
cd backend
env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  DATABASE_URL='postgresql://atc_pos:<dev-db-password>@127.0.0.1:5439/atc_pos_test?schema=public' \
  POS_JWT_SECRET="$(openssl rand -hex 32)" \
  NODE_ENV=test LOG_LEVEL=silent npx vitest run
```

A mock has no MVCC and no second connection, so it cannot answer the two
questions a handover turns on: a lost update between racing connections, and one
branch's token against another branch's row. Those are answered in §5.3.

### Real Razorpay sandbox — incomplete

State it plainly rather than implying more:

- The adapter is written and unit-tested against a mock.
- A **real sandbox order was created** against Razorpay's live test endpoint.
- The **webhook was never delivered**, because no webhook is registered on the
  account. Every tunnel hostname supplied for that purpose has since expired.
- Therefore: `payment.captured` → order PAID with a real `pay_…` reference,
  duplicate-event suppression against real replays, and `refund.processed`
  settling a real refund are **not verified against the provider**.

This blocks nothing in this handover, because gateway payment is switched off
for the client. It blocks turning it on.

### Against the running production server

An acceptance run drives the deployed server over HTTP — real router, real
middleware, real RBAC, real Postgres at its real isolation level
(`deploy/uat-acceptance-container.mjs`). It refuses to run unless the target
company is `isDemo = true`, never touches `pos.admin`, creates its own accounts
with a password that is never printed, and removes everything it wrote
including on failure.

That run is owned by a parallel work stream and its results should be read from
its own output, not inferred from this document.

### Browser-rendered, not merely built

The daily closing page was rendered from the built bundle at 1440×1000,
1024×768 and 768×1024, reached by **typing the URL** rather than clicking the
nav — a nav click hides a missing route behind the menu. Checked: the page
renders, the expected-cash figure is right, the open-orders warning shows, the
history and correction badges render, nothing overflows horizontally, no console
errors. The variance arithmetic was driven in the browser: over, short, and the
note requirement releasing the button.

The harness was then pointed at a route that does not exist and **failed**.
A check that has never failed is a decoration, not evidence.

### Against the bundle production actually serves

The three fixes in `652732f` were re-verified after deployment against the
bundle **copied back out of the running container**, not against the working
tree. Those are different artefacts today — the tree builds a different product
name — so "the tree passes" would have been the wrong claim to make.

Six scenarios, 45 assertions, all green, each one paired with a sibling that
catches its inverse:

| | Condition | Must be true |
|---|---|---|
| A | no provider, no rows | KPI grid **absent** |
| B | no provider, one unpaid refund | KPI grid **present**, refund listed |
| C | provider live and clean | KPI grid **present**, all-clear shown |
| D | `branchLimit: 0` | must **not** say "of 0 allowed" |
| E | `branchLimit: 3` | must say "2 active of 3 allowed" |
| F | browser forced to New York | stamp still reads 22 Sept 01:00 IST |

A gate stuck open fails A. A gate stuck shut fails B, C and E. The pairing is
the point: either direction of breakage goes red, so a green means the gate is
deciding rather than merely defaulting.

The first run of this against production failed all six — every asset came back
as `index.html` because the deployed build is served under `/pos` and the
harness was rooted at `/`. Worth recording: the page still returned 200 and
still painted a shell, so a check that looked only at status codes would have
called a completely dead app healthy.

### Backup and restore

The nightly schedule is **installed and has run** (2026-09-22 13:33 UTC, next
fire 02:31 IST). `deploy/pos-backup.mjs` executed end to end for the first time
as that systemd unit and reported its own eight PASS lines.

The dump it produced was **restored into a throwaway database with
`--exit-on-error` and compared**: all 22 tables to the counts the backup itself
recorded, and 4 staff logins with their password hashes intact.

**The money comparison proved nothing**, and says so out loud in its own output:
`paymentAmountSum` is 0 because no real sale exists yet. Re-run `--drill` after
the first full day of billing — that is the run that tests whether takings
survive a restore. Full detail and caveats: `docs/BACKUP-RESTORE.md` §6.

---

## 6. Known limitations

Written down so they are disclosed rather than discovered.

1. **No cap on cashier discounts.** Any cashier can discount up to 100 % of a
   bill without approval. For a café this is a cash-shrinkage hole. The fix is
   small but ATC cannot pick the threshold — ask the owner for a number and a
   rule ("above 10 %, manager approves").
2. **Daily closing does not lock the day.** Sales can still be recorded against
   a closed date; the closing then no longer matches and needs a correction.
3. **Every payment is a manual record.** Nothing is verified with a bank. See
   `guide-owner.md` §10 — this is stated to the client, not hidden.
4. **No offline mode.** No connection, no billing.
5. **Printing is browser-based** and has not been tested against any physical
   printer. §7.
6. **Backups are on the same disk as the database.** There is no off-host copy.
   This survives a bad migration; it does not survive losing the server.
7. **No alerting on a failed backup.** Someone must look.
8. ~~Reconciliation zero KPIs, Branches "0 of 0", Team browser-locale dates.~~
   Fixed in `652732f` and **deployed** (§1). Verified against the bundle pulled
   back out of the running container — not the working tree, which builds
   something else entirely — in six scenarios, every assertion paired with one
   that catches its inverse: 45/45.
9. **Licence expiry in the top bar uses the browser's timezone.** Visible in
   production right now: the top bar reads "until 3/31/2027", which is US
   format, and the same licence would read 3/30/2027 from a New York browser.
   The same defect as the Team one fixed above, in `Layout.jsx`, which a
   parallel session has uncommitted — left alone rather than overwritten.
10. **The product name is unsettled.** Production says "ATC POS" and matches the
    guides. The working tree does not: it builds "VEXO Connect" throughout,
    including the page title. Whichever name ships, the guides and the screen
    must agree before a client sees either, and that is the owner's call, not a
    rename to be made quietly on the way past.
11. **No pull-based payment recovery.** If a gateway `payment.captured` webhook
    is missed, nothing polls the provider to find out. Only relevant once the
    gateway is switched on, and it should be built before it is.

---

## 7. What ATC must do before the client bills for real

1. ~~**Switch on the backup schedule.**~~ Done 2026-09-22; timer enabled, first
   run drilled. Two follow-ups remain and neither is optional for a café that
   has started taking money: **get a copy off this host** (right now the backups
   and the database share a disk), and **re-run `--drill` after the first day of
   real billing**, because today's drill compared a payment total of zero
   against zero.
2. **Create the client's own company and branches**, separate from
   `Brew Street Café (Demo)`. The demo tenant is `isDemo = true` and must stay
   that way: acceptance probes refuse to run anywhere else, and that refusal is
   what keeps them off client data.
3. **Prove the printer.** With the real machine and real paper, before opening.
   ATC has not tested any physical printer and must not claim to have.
4. **Renew or convert the licence.** Demo is `FREE_TRIAL`, expiring
   **2026-10-20**. A client billing past that date stops billing.

---

## 8. What ATC needs from the client

Ask for all of it at once. Everything else is finished.

1. **Company details** — legal name, trading name, address per branch, GSTIN,
   phone, and anything that must appear on the receipt footer.
2. **The menu** — items, categories, prices, sizes/variants, and **which GST
   rate applies to which item**. A spreadsheet is fine. ATC will not guess tax
   rates.
3. **Branch list** — names and the short code for each (the invoice prefix;
   permanent once billing starts).
4. **Staff list** — name, email, and role for each person.
5. **Printer make and model**, and whether the kitchen printer is a separate
   machine.
6. **A discount rule** — the cap above which a manager must approve (§6.1).

Only if online payment is wanted:

7. **The client's own Razorpay merchant account**, with test credentials first.
   ATC then completes the sandbox sequence in §5.2 — a real captured payment, a
   duplicate webhook, and a real refund — before any live key is installed.
   **Live payments stay off until that is done and the client authorises it in
   writing.**

---

## 9. ATC operational controls

- **ATC → Companies** — every tenant, its licence, branch count and staff.
- **Licence** — plan, expiry, branch entitlement, additional-branch add-ons.
  Expiry is computed from `expiresAt` at read time, so it cannot be missed by a
  failed job and cannot be postponed except by changing the date.
- **ATC is read-only inside a customer's data**, and is refused the daily
  closing outright. Every ATC access is written to the audit log and can be
  shown to the client.
- Logs: `docker compose -f docker-compose.prod.yml logs backend`.
- Restart: `docker compose -f docker-compose.prod.yml up -d --no-deps backend`
  — `restart` alone re-runs the old container with the old environment.
- The POS stack is `pos-prod` and publishes only `127.0.0.1:8110`. Nothing here
  touches the other ATCWorkspace services.

### Runtime, as measured

| | |
|---|---|
| Restart policy | `unless-stopped` on all three containers |
| Docker at boot | `enabled` |
| Survives reboot | **observed** — Postgres has been up since the host's last boot, not restarted by hand |
| Health endpoint | `GET /pos/api/health` → 200 |
| Container healthcheck | Postgres only |

The last row is a gap. The backend has an HTTP health endpoint but no Docker
`healthcheck`, so Docker cannot tell a wedged backend from a running one and
nothing restarts it. `depends_on: service_healthy` protects the *start* order
only. Wiring the endpoint into a container healthcheck is a compose change and
a container recreate — worth doing, but not in the middle of a handover week.

### Live payments cannot happen, and this is verifiable

Not a flag that could be flipped by accident: the credentials are not present.

```sh
docker exec pos-prod-backend-1 sh -c \
  'for v in POS_GATEWAY_PROVIDER POS_GATEWAY_KEY_ID POS_GATEWAY_KEY_SECRET \
            POS_GATEWAY_WEBHOOK_SECRET POS_GATEWAY_API_BASE; do
     val=$(printenv "$v"); [ -z "$val" ] && echo "$v=<unset>" || echo "$v=<set, ${#val} chars>"
   done'
```

All five read `<unset>` in production today. `gatewayEnabled` is
`Boolean(POS_GATEWAY_PROVIDER)`, so every gateway route refuses and the
"Pay online" button does not render at all. `config/env.js` additionally
refuses to boot with a provider set but no webhook secret — a half-configured
gateway is worse than none.
