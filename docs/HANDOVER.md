# VEXO Connect — client handover pack

Internal ATC document. What was delivered, what was proven, what is still owed,
and the exact steps to put a café on this system.

Names: the product is **VEXO Connect**, the operator the screens name is
**VEXO**, and the company is **ATC Infocom Solutions Pvt. Ltd.** This document
says "ATC" where it means the team doing the work, and "VEXO" where it is
quoting something the client will actually see on screen.

The two documents the client actually receives are `guide-owner.md` and
`guide-cashier.md`. This one stays with ATC.

---

## 1. The build being handed over

| | |
|---|---|
| URL | `https://atcworkspace.com/pos` |
| Health | `https://atcworkspace.com/pos/api/health` → `{"status":"ok","service":"atc-pos-api"}` |
| Release | **`543a220`** — `phase2-integration`, the touchscreen-UI and 80 mm print release. Built and deployed 18:17 UTC from a worktree pinned at that commit, never from a shared tree |
| Backend | Image `pos-prod-backend:20260922-integration-543a220` (`f000ba8e3e89`), container created **18:17:02 UTC**. Also tagged `:latest` |
| Frontend | Image `pos-prod-frontend:20260922-integration-543a220` (`40a41c4e0c09`), container created **18:17:13 UTC**. Also tagged `:latest` |
| Frontend bundle | `assets/index-BYmQsKta.js`, sha256 `4a3bbd1ed1bd64fd…`, **434862 bytes** — hashed off the public URL, which is what the client actually receives. Carries `pos-print-page-size` ×1 and `beforeprint` ×1 (the print fix) **and** `reports/activity` ×4 + `Discounts, voids and refunds` ×2, so this build is a superset of `f014ab5` and the activity report did not regress |
| Stylesheet | `assets/index-D4XA2h9n.css` — contains `@page{size:80mm auto;margin:0}` and `.print-area{…width:72mm;max-width:72mm;…padding:0 2mm…}` |
| Database migrations applied | 8, unchanged. `select count(*) from _prisma_migrations where finished_at is not null` → **8**, and the backend log reads `8 migrations found in prisma/migrations` / `No pending migrations to apply.` Postgres was never restarted (up 20 h across this deploy) |

### Rollback targets — NOT the running build

Listed separately because the previous version of this table mixed the two, and
the images it named as *current* had by then become the *rollback* pair. Anyone
reading it during an incident would have rolled "back" onto what the table
called live.

| | |
|---|---|
| Backend rollback | `pos-prod-backend:rollback-20260922-preprintfix` → `055f9ae7f23f` |
| Frontend rollback | `pos-prod-frontend:rollback-20260922-preprintfix` → `0db76709b98b` |
| What that pair is | The `f014ab5` build that ran 16:37 → 18:17 UTC |
| Database | `/home/atc-noc/pos-backups/pre-printfix-20260922.dump`, 75551 bytes. Verified to **parse**, not merely exist: `PGDMP` magic, 182 TOC entries, 22 tables carrying data (`pg_restore --list` via a throwaway `postgres:16-alpine`) |

> **Tag-name hazard.** Three tags point at `055f9ae7f23f` — `rollback-20260922`,
> `rollback-20260922-preintegration` and `rollback-20260922-preprintfix` — because
> two sessions independently pinned the same running pair before deploying.
> They are interchangeable *today*. Roll back by **image ID**, not by tag name:
> the undated `rollback-20260922` will be reused and will drift.

**This release fixed a live defect.** Production was serving
`.print-area{width:80mm}` together with `@page{margin:4mm}` — 80 mm of content
inside a 72 mm printable window, silently cutting every right-aligned value off
the paper: the TOTAL's paise, the invoice number, every line amount. An "80 mm"
roll is 80 mm of paper but only ~72 mm imageable (576 dots @ 203 dpi); the rest
is dead margin under the head's edges.

### Printing: fixed in the browser, PENDING on hardware

The fix above is proven by Chromium print emulation and by PDFs generated at the
80 mm page size — 47/47 geometric checks, including that the page height follows
the content (155 mm long bill vs 66 mm KOT) rather than a fixed form. Artefacts:
`/home/atc-noc/pos-uat-screens/`.

**No receipt or KOT from this build has ever reached a thermal printer.**
Physical printing is **NOT TESTED** and stays that way until a device is
available. Per-site sign-off lives in `frontend/docs/HARDWARE-CHECKLIST.md`.

Not implemented, and not to be offered as settings: silent printing (every job
raises the browser dialog), app-triggered paper cut, cash-drawer kick, and
automatic receipt-to-counter / KOT-to-kitchen routing. The operator may pick any
printer in the dialog and change it per job, but nothing stops a KOT printing at
the counter. Each would be a new integration — a local print agent or an ESC/POS
bridge. See §6 for the standing limitation entries.

**This table went stale four times in one afternoon** — twice while this very
section was being edited. At 14:49 UTC another session deployed `1ca40bc` +
`1e64b24` while the paragraph below was being written to say they were missing
from production. The correction to *that* was committed at 15:06, by which
point it was already wrong again: `817b438` + `0084936` had gone out at 15:03,
and the sentence announcing them as undeployed outlived the deploy by three
minutes.

A fifth and sixth time, both differently, and both worth keeping because they
are the two cases a commit-based check cannot see:

- **15:21 — new containers, same images.** Applying the healthchecks recreated
  the backend and frontend from the images they were already running. No image
  ID moved, no code changed, and the service was restarted anyway.
- **15:41 — new image, same content.** Another session rebuilt and redeployed
  the frontend. Its image ID moved (`b4e84ea39f19` → `39205084de0e`) with no
  commit behind it — `git log` was unchanged — and the bundle it serves still
  hashes to `6989289f…`. A rebuild yields fresh layer digests whether or not a
  byte of output differs, so **an image ID is not evidence that anything
  shipped.** Hash the artefact.
- **16:37 — a seventh time, and the reason the table above was rewritten.**
  `f014ab5` merged the activity report and was built and deployed from a pinned
  worktree. Every row of the old table — both commits, both image IDs, the
  bundle name, its hash and its size — became wrong at once. This is the
  ordinary case, not an exotic one: a normal release invalidates the whole
  table, which is why the rows are now written as *evidence* (how each was
  measured) rather than as bare values.

**The release is now frozen at `f014ab5`** for client UAT. See §9 for who may
deploy during the freeze.

One number in that row invites a wrong conclusion, so it is written out:
`deploy/prod-verify.mjs` reports the bundle as 429947 while the file is 430357
bytes. Nothing is truncated — the script measures a decoded JavaScript string,
whose length counts UTF-16 units, and the difference is the multi-byte
characters in it (₹ and the é in café among them). Compare hashes, not sizes.

So: it is the most perishable thing in this document. Production is redeployed
by whoever is working on it and the table does not update itself. Treat every
row as a claim to re-check, and re-check it by **content** — image tags and
directory names have both lied here already. The reproduce recipe below is the
check, and it takes about a minute.

**Nothing is outstanding** — but that is two questions, not one, and git can
only answer the first.

**Is every code change in the image?** Git answers this, because the image was
built from a commit:

```sh
git log --oneline <deployed-commit>..HEAD -- \
  frontend/ backend/src backend/prisma backend/scripts \
  backend/package.json backend/package-lock.json
```

using the commit you just *proved* by rebuild, not the one this table claims.
Empty output is the only acceptable answer. It was empty at 15:54 UTC against
`9b85da3` with the pathspec exactly as written above, and `compose --dry-run`
reported all three services `Running`.

**Scope that pathspec deliberately, and keep it in step with the Dockerfile.**
`backend/Dockerfile` copies exactly four things — `package*.json`, `prisma`,
`src`, `scripts` — and the pathspec is that list, which is why the lockfile is
named explicitly alongside `package.json`: a dependency change ships in the
image without touching a line of `src`. It errs the other way too. Because
`backend/tests/` never enters the image, a bare `-- frontend/ backend/` reports
a test-only commit as an undeployed change, sending someone into a
build-and-deploy cycle that cannot alter one byte of the running service.
Widen or narrow it only when the Dockerfile does.

One caution about editing that line at all: **a pathspec that matches nothing
reports clean**, identically to a pathspec that matches everything and finds
nothing outstanding. A typo here does not fail — it just stops looking, quietly
and permanently. After changing it, confirm each path is real:

```sh
for p in frontend/ backend/src backend/prisma backend/scripts \
         backend/package.json backend/package-lock.json; do
  printf '%-28s %s\n' "$p" "$(git log --oneline -1 -- "$p")"
done
```

Every line must name a commit. A blank one is a path git has never heard of.

**Is the compose file applied?** Git cannot answer this one, and adding
`docker-compose.prod.yml` to the pathspec above does not fix it — it makes
things worse. Applying a compose file records no commit, so `b75b062`, which
added the healthchecks *after* the deployed image commit, appears in that log
forever whether or not anyone ran `up -d`. "Empty output is the only
acceptable answer" stops being reachable, and a check that can never come back
clean is a check people learn to skip. Ask docker instead:

```sh
docker compose --dry-run -f docker-compose.prod.yml up -d
```

Every service `Running` means the file on disk is what is running. Any service
`Recreate` is drift, and names the service that needs `up -d`. Dry-run mutates
nothing — checked at 15:28 UTC that all three containers kept their creation
timestamps and no stray container was left behind.

**That check has been shown capable of failing.** One character in a scratch
copy of the file — backend healthcheck `interval: 30s` → `31s`, run with
`--project-directory` pointed back at the repo so `.env` still resolves — made
it print `Recreate` for the backend alone, with postgres and frontend still
`Running`. Three green `Running` lines mean nothing without that.

One ordering rule survives, because it will apply again the next time
`817b438`-shaped work ships: **its two halves are not symmetric.** Backend
first is inert and harmless — the API returns a field nothing reads. Frontend
first is the one to avoid, because the page renders perfectly and the banner
never appears: `existing.postClose` is simply absent, which on screen is
indistinguishable from "this day is clean". A frontend-only deploy of a
feature like this does not fail, it goes quiet. Ship the backend first, or
ship both. The 15:03 deploy recreated both containers together.

The frontend commit is not read off an image tag or a directory name. Both lie
— the worktree this was first traced through was named `atc-pos-deploy-269b0f5`
and had already been deleted by the time it was looked at. It is proven by
rebuilding the candidate commit and getting a **byte-identical** bundle. Run at
15:07 UTC against `0084936`, which is how the row above was established:

```sh
git worktree add --detach /tmp/v 0084936
ln -s "$PWD/frontend/node_modules" /tmp/v/frontend/node_modules
cd /tmp/v/frontend && VITE_BASE_PATH=/pos/ npx vite build   # trailing slash — see below
docker exec pos-prod-frontend-1 ls /usr/share/nginx/html/assets/   # get the live name
docker cp pos-prod-frontend-1:/usr/share/nginx/html/assets/index-BKEWKpgq.js /tmp/live.js
cmp /tmp/live.js dist/assets/index-BKEWKpgq.js && echo REPRODUCED

# Clean up — DELETE THE SYMLINK FIRST. `git worktree remove --force` deletes
# the directory tree, and the link it is about to walk over points at the real
# frontend/node_modules.
rm /tmp/v/frontend/node_modules
git worktree remove --force /tmp/v
```

**`VITE_BASE_PATH` must end in a slash.** `vite.config.js` passes it straight to
`base`, and `lib/api.js` builds the API root as `` `${import.meta.env.BASE_URL}api` ``.
Given `/pos` the bundle calls `/posapi` and every request 404s; given `/pos/` it
calls `/pos/api` and works. The two builds differ by **three bytes** in 415 kB.
Nothing warns you — the build succeeds, the hash merely changes, nginx serves
it, the login screen paints normally, and the only symptom is that signing in
does nothing at all. Worth knowing before it happens during a real deploy.

**The backend has no bundle to hash**, so it gets the same treatment a
different way: digest the whole source tree on both sides and compare. Not one
file — a single changed file is exactly what a stale image would still get
right, since most of a deploy is unchanged:

Compare it in two parts, because they fail differently — a file added or
dropped shows up in the listing while every remaining hash still matches, and
an edited file shows up in the content while the listing looks untouched:

```sh
# 1. the same files exist on both sides
docker exec pos-prod-backend-1 find /app/src -type f -printf '%P\n' | sort | sha256sum
find backend/src -type f -printf '%P\n' | sort | sha256sum

# 2. those files hold the same bytes
docker exec pos-prod-backend-1 find /app/src -type f -exec sha256sum {} + > /tmp/img-src.txt
find backend/src -type f -exec sha256sum {} + > /tmp/tree-src.txt
cut -c1-64 /tmp/img-src.txt  | sort | sha256sum
cut -c1-64 /tmp/tree-src.txt | sort | sha256sum
```

At 15:44 UTC against `9b85da3`: listings `f8e33f7f…`, contents `1434a3d1…`.
The paths are cut away before hashing in step 2 precisely because they differ
(`/app/src/...` against `backend/src/...`); step 1 is what covers them.

This only proves the image matches the **working tree**, so it is worth
something only when `git status --porcelain` is empty for `backend/` —
otherwise it proves the image matches somebody's uncommitted edit, which is a
different and much worse fact. Check that first.

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
(`guide-owner.md` §2), or via VEXO Console → Companies for the company shell. Create each
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
- [ ] Every correction above appears in **Reports → Discounts & voids** against
      the name that made it — this is the check that closes the loop, because
      until it is done "it is all recorded" is an untested claim
- [ ] Apply a discount and remove it: the person shows **1 discount, 1 removed**,
      not 2 discounts

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

**Devices — tablet or larger only**
- [ ] Cashier screen usable at the till's actual resolution
- [ ] Owner dashboard readable on the owner's laptop or tablet

> This line used to read "laptop **and phone**", which contradicted
> `guide-owner.md` §9 and limitation 12 in this document — both of which say
> plainly that the POS needs a tablet or larger. It was the only place in the
> pack that invited the client to test on a phone, and a checklist that asks
> for something the product does not do produces a failed acceptance against a
> build that is behaving exactly as designed. Below 768 px the sidebar is
> `hidden … md:flex` and only the logo replaces it, so there is no navigation
> at all. **Do not hand the client a phone as part of UAT.**

---

## 5. What has been verified, and how

Separated by kind of evidence, because they are not equally strong.

### Automated tests — mocked, not a real provider

Backend suite: **235 passed / 235**, 7 files (foundation 22, money 13,
logRedaction 7, phase2 53, razorpay 53, razorpayFlow 32, gateway 55), run
against the dev test database and re-measured at 16:45 UTC **from the merged
tree at `f014ab5`** — not from the lane branch, because the runbook's
precondition is that the tree being built is the tree that went green. The
rise from 227 is one file: `phase2` 45 → 53, the activity report arriving with
its own tests. The other six are unchanged, which is the point — a feature
that moves counts it has no business moving is a feature that touched
something it should not have. Money arithmetic, order lifecycle, RBAC, tenant
scoping, licence gating, refund states, log redaction, and the gateway adapter
**against a mock**. Re-measure rather than quoting this number — it has been stale in this document three times, and was
stale again by two within the hour this line was last corrected:

```sh
cd backend
env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  DATABASE_URL='postgresql://atc_pos:<dev-db-password>@127.0.0.1:5439/atc_pos_test?schema=public' \
  POS_JWT_SECRET="$(openssl rand -hex 32)" \
  NODE_ENV=test LOG_LEVEL=silent npx vitest run
```

`<dev-db-password>` is `POSTGRES_PASSWORD` in `docker-compose.yml` — a
throwaway development credential on a loopback-only port, nothing to do with
production, which publishes no host port at all.

`POS_JWT_SECRET` is not optional. Without it vitest reports a confident, much
smaller pass count instead of an error.

Unmerged branches carry their own counts, and mixing them with the release's
is how this number goes stale. `phase2-reconcile-tests` is no longer one of
them: its five reconciliation commits were integrated into `phase2-integration`,
which measures **253 / 253**, 7 files, re-measured at `d1bb888` against its own
database. The whole rise from 235 is gateway 55 → 73 — recovery, the webhook
race, and delivery-versus-replay — and the other six files still sum to 180,
which is the check worth doing: reconciliation that moved a count it has no
business moving would have touched something it should not have.

That is a statement about **that branch**, and about nothing else. It is not a
statement about production, which is an earlier build, has no gateway provider
configured at all, and is untouched by this work — the webhook routes are not
even mounted there. Two of those 18 were failing when written, and are
what found the two gateway defects written up in `docs/RAZORPAY-SANDBOX.md` —
one of which, a capture settled in a foreign currency closing an INR bill at
face value, was on the **webhook** path, not only on the new route.

Run an unmerged branch against **its own** database, not `atc_pos_test`. Two
suites sharing one database delete each other's sessions mid-run, and the
symptom is not a clash — it is every authenticated test failing with "your
session has expired", which reads exactly like a broken auth change.

A mock has no MVCC and no second connection, so it cannot answer the two
questions a handover turns on: a lost update between racing connections, and one
branch's token against another branch's row. Those are answered in §5.3.

### Real Razorpay sandbox — the money legs are now verified

**This section said "incomplete — the webhook was never delivered" until
2026-09-22 evening. That is no longer true and must not be quoted.** The
blocker was found and fixed: the account had **0 webhooks registered**, and the
registration script sent `events` as an array where the API wants a
name→enabled map. Every tunnel hostname expiring was a symptom that hid it.

Verified against the live TEST account, on order `cmucyvfuj002t1grlxxb6smh6`
/ `order_TfAcLrKPDwVYez`, ₹105:

| Leg | Provider's record | POS record |
|---|---|---|
| Capture | `pay_TfAz6n5mPXApUi` `captured=true` | genuine event `TfAzJXOLfmOqii`, 18:09:13Z → **exactly one** `Payment`, ₹105, `GATEWAY`, `receivedById=null`, order `PAID` |
| Refund | `rfnd_TfB3TLNRxpbgl5` `processed` ₹40 | genuine event `TfB42UGWqm3vNh` → `Refund` `SUCCEEDED` |
| Replay | same bytes, twice each — as a provider retry and under a fresh event id | totals held at `payments=1/105 refunds=1/40` |

The refund was **partial on purpose**: a full refund is a weak test, because
code ignoring the requested amount and returning the whole payment would look
perfect. ₹40 of ₹105 forces the figure to survive every hop.

`receivedById=null` is the load-bearing detail — no cashier is credited,
because no human recorded it. The order went `PAID` on the provider's word.

What is still **not** verified against the provider, stated so it cannot be
read as covered:

- The **payment-intent reconcile route** (the pull half, for a capture whose
  webhook never arrives). Proved against the test adapter, 18 tests, not yet
  run against a real captured payment. Branch `phase2-reconcile-tests`.
- A genuine captured ₹105 from 11:54Z — `pay_Tf4bqZCtM4GOU2` — is still
  unrecorded, from before the webhook existed. That route is its remedy and
  closing it is a deliberate act for the release owner. **Do not hand-write a
  `Payment` row.**

None of this changes the client position: **gateway payment is switched off**
and the production stack has no `POS_GATEWAY_PROVIDER` at all, so there is no
gateway to enable by accident. It unblocks turning it on later.

Full evidence, including how to tell a genuine event row from a synthetic one:
`docs/RAZORPAY-SANDBOX.md`.

**The dev backend has moved off 5010** — it is on 5015, with a webhook capture
proxy on 5014. Do not pin either in source; read them from the sandbox doc at
the time of the run. A node process serves whatever was on disk when it loaded
the module, so restart it before any sandbox run rather than assuming it
carries the current tree. It is a *development* backend, unrelated to the
production containers, and another session may own it.

### Against the running production server

An acceptance run drives the deployed server over HTTP — real router, real
middleware, real RBAC, real Postgres at its real isolation level. It refuses to
run unless the target company is `isDemo = true`, never touches `pos.admin`, and
creates its own accounts with a password that is never printed.

**Run 2026-09-22 16:44 UTC, `deploy/uat-acceptance.mjs` against
`https://atcworkspace.com/pos` on `f014ab5`: 24 PASS · 0 FAIL · 2 NOT TESTED.**
Authenticated throughout — every check below is a signed-in HTTP call, not a
health probe.

| Area | Checks | Result |
|---|---|---|
| Sign-in, three roles | 1.1 | PASS |
| Permission boundaries | 1.2, 1.3, 4.3, 4.5, 5.1, 5.2 | PASS — console, user list, sales reports, day-close commit, refunds and voids all 403 to the wrong role |
| Branch isolation | 1.4, 1.5, 4.2 | PASS — cashier B gets 403 on branch A's order and 0 rows in its list |
| Billing arithmetic | 2.4, 3.1 | PASS — 2 × ₹100 + 5% GST = ₹210, invoice `BSC-CP/26-27/00004` |
| Duplicate payment | 3.2 | PASS — double-clicked payment accepted once, 1 row, ₹210 |
| Durability | 3.3 | PASS — billed order unchanged on re-read |
| Receipt / KOT | 2.3, 2.5, 7.1, 7.2 | PASS — KOT created and retrievable, receipt carries lines, totals, payment and the DEMO flag |
| Day close | 4.4 | PASS — expected ₹210 = cash ₹210 − refunds ₹0 |
| Sales reconciliation | 4.1 | PASS — report ₹210 = database ₹210 |
| Refund reconciliation | 5.3, 5.4 | PASS — partial refund issued; report ₹10 = database ₹10 |
| Razorpay gateway | 6.1 | **NOT TESTED** — route not mounted (HTTP 404). Correct: the gateway is deliberately off |
| Thermal printer layout | 7.3 | **NOT TESTED** — no printer attached to this deployment |

Neither NOT TESTED is a defect. 6.1 is the gateway being off *by design* and is
re-asserted as a negative control on every run; 7.3 needs hardware nobody here
has.

**A defect in the harness was found by checking its own claim.** The script
printed `temporary UAT accounts deleted`; the table said otherwise — three
accounts were still present and **ACTIVE**. The cleanup was
`delete … .catch(() => {})` followed by an unconditional success message, and
the delete can never succeed for a run that reaches billing: `Order.openedById`,
`Refund.byId`, `PaymentIntent.createdById`, `DayClose.closedById` and
`PosSession.userId` are all `ON DELETE RESTRICT`. That constraint is right —
whoever took the money must not be erasable — so the fix went into the script:
revoke sessions, attempt the delete, fall back to `DISABLED`, and **report which
of the two actually happened**. The three accounts from run `3f4301` were
neutralised by hand the same way; `DISABLED` is refused at login
(`auth.js`) and on every authenticated request (`middleware/auth.js`), both
confirmed in the deployed source.

The lesson generalises past this script: **a cleanup path that cannot fail
visibly is not a cleanup path.** Check the table, not the log line.

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

**Reports → Discounts & voids**, the same way, after the 16:37 UTC deploy of
`f014ab5`. The bundle was fetched from `https://atcworkspace.com/pos/` and
render-checked at `sha256 c1d15e81…45ef63` — 25 of 25, including the
discount-versus-removal distinction, both viewport sizes, the truncation
warning, the empty range, and no console errors. Then the bundle file was
moved aside and the run repeated: **2 of 19**, aborting at the first filter
click. The checks depend on that file rather than passing off the SPA
fallback.

Two traps found doing it, both of which produce a confident false green:

- **A local `frontend/dist` is not the deployed bundle, even at the same
  commit.** The two differ: the Docker build injects `baseURL:"/pos/api"` and
  a local `npm run build` leaves `"/api"`. Identical source, different bytes,
  different content hash. A render check against `frontend/dist` therefore
  proves nothing about production. Fetch the bundle from the live URL and
  render *that*.
- **An anonymous request cannot tell you whether a route is mounted.** Auth
  middleware runs before routing, so `GET /pos/api/reports/activity` returns
  401 — and so does `GET /pos/api/reports/nosuchthing`. The 401 that looks
  like "mounted and correctly gated" is identical to the 404 case. Prove a
  mount by reading the route table in the running image, or with a
  credentialed call; never by the status code of an unauthenticated one.

### Rate limiting, measured against production rather than read off the config

Worth its own section because a config file said the right thing while the
running system did the wrong one, and no test in the suite could see it.

`express-rate-limit` keys on `req.ip`. `app.js` had `trust proxy` set to `1`,
but production runs **two** proxies that each append to `X-Forwarded-For` —
the host nginx for `atcworkspace.com` and the nginx inside the frontend
container. So `req.ip` resolved to the docker bridge gateway, `172.28.0.1`,
for every client in the building. One shared key meant:

- `loginLimiter`, 10 failed sign-ins per 15 minutes, **shared by everyone**.
  One cashier mistyping their password ten times would have refused sign-in to
  the whole shop, owner included, mid-service.
- `globalLimiter`, 300 requests a minute, as the budget for every till, phone
  and dashboard together rather than per device.

Neither would have appeared in testing. Both limiters `skip` under
`NODE_ENV=test`, and a single-device check never collides with itself.

Measured, not inferred. A request over the public URL and one over loopback —
two unrelated client addresses — drew down the same counter, `299 → 295 →
294`. After `9b85da3` set the hop count to 2, the same two paths keep separate
counters: loopback `299 → 298` while the public one independently read `296`.

The audit trail was wrong for the same reason, plus one of its own:
`clientIp()` preferred the `X-Real-IP` header, which the container nginx
overwrites with its own view. Every audit and session row recorded
`172.28.0.1` — which proxy delivered the request, never who made it. The
before and after sit in adjacent rows of the same table, same probe, same
query:

```
15:41:25  LOGIN_FAILED  172.28.0.1    <- before
15:45:22  LOGIN_FAILED  20.20.20.1    <- after
```

`20.20.20.1` is the edge router, which is the correct answer for a request
that left this host and came back in over the public URL.

Both halves of the fix were proved load-bearing: reverting either one alone
reddens the new `foundation.test.js` case, and each time it fails with the
production symptom — `expected '172.28.0.1' to be '203.0.113.77'` — rather
than a generic mismatch. The test also feeds a forged `X-Forwarded-For` entry,
which counting from the right leaves harmlessly to the left of the two entries
the proxies guarantee.

**Rows already written keep the old value.** Nothing backfills them, and they
should not be read as a claim about where those requests came from.

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

   **Confirmed on production, 2026-09-23**, rather than read off the source.
   `deploy/discount-probe.mjs` signed in as `demo.cashier@atcpos.example`,
   opened a ₹165 order on `BSC-CP` and applied `{type:'PERCENT', value:100}`:
   `HTTP 200`, order total `₹0`, discount `₹165`. The probe order was voided by
   the owner immediately afterwards so it never reads as trade. The route is
   `POST /orders/:id/discount`, gated by `operate` in
   `backend/src/api/routes/orders.js:47` — `CUSTOMER_OWNER`, `BRANCH_MANAGER`
   **and `CASHIER`** — and validated only for value range, never for magnitude
   or for who is asking.

   **There is no customer-admin control over this, and none is hidden
   anywhere.** This was asked as a separate question and answered separately:

   - Five candidate owner-facing surfaces were probed with an owner token —
     `/settings`, `/company/settings`, `/permissions`, `/roles`,
     `/company/permissions`. All five returned **HTTP 404**. There is no
     policy endpoint to find.
   - `PosUser` carries only `role`; there is no per-user permission column and
     no `customPermissions`-style override. `Company` carries no discount
     policy field. So there is nowhere to store a threshold even if a screen
     existed to set one.
   - The **UI does not gate it either** — the discount control on `Sell.jsx`
     is offered to every role that can operate an order. That is at least
     consistent: the screen is not pretending to a restriction the API would
     not enforce, which would be the worse failure.

   So the honest statement to a client is: discounts are **detected, not
   prevented.** Read the rest of this item as describing a detective control,
   and note that ATC still needs the owner's threshold before any preventive
   one can be built.

   What softens it, and what does not:

   - Every discount **is** recorded, with who applied it, what they applied,
     to which order, and from where — `ORDER_DISCOUNT_SET` for a whole bill,
     `ORDER_ITEM_UPDATE` carrying `lineDiscount` for a single line. So the
     history exists from day one, and whenever the threshold is chosen there
     is something to check it against.
   - **The owner can now read that record**, at **Reports → Discounts & voids**
     (`ad7a1e2` + `ed6226e`, frontend + backend). This was the sharpest item on
     this list until it shipped, because "discounts are audited" sounds like a
     control anyone can check and for months nobody could — the table was
     written since day one and read by nothing. `deploy/audit-queries.sql` is
     still there for questions the screen does not answer (failed sign-ins per
     account, for one).
   - The recording is **best effort, not transactional.** `audit()` wraps its
     insert in try/catch so an audit failure can never fail a customer's
     bill, which is the right trade. It does mean a missing row is not proof
     an action did not happen — a failed write leaves only a `pos audit write
     failed` warning in the backend log. The screen says this in a footnote
     and the API returns `bestEffort: true` beside every answer. Read those
     results as a lower bound.
   - It reads **at most 1,000 events** per range and reports `truncated` rather
     than quietly shortening the list — a silently trimmed list is how an owner
     concludes a cashier did nothing unusual.
2. **Daily closing deliberately does not lock the day** — but it now says when
   it has stopped being true. `817b438` + `0084936`, **deployed** at 15:03 UTC
   and verified afterwards against the running build, not the working tree.
   Unlike items 9 and 13 this one has a *backend* half, and both containers
   were recreated together; the ordering trap is in §1.

   Locking was the obvious fix and it is the wrong one. A cashier who cannot
   record cash they have already been handed will take it and keep it out of
   the system, which is worse than a stale figure. So nothing is refused.
   Instead the closing reports its own drift: a banner on `/reports/day-close`
   naming what was recorded after the count, when the last of it landed, and
   how far the drawer is now from what that closing said — with card, UPI and
   online money called out separately, because it never entered the drawer at
   all. The 30-day list carries it too (`0084936`): a **stale** badge on the
   row and a `staleDays` count in the summary. That second half matters more
   than it looks — the banner only describes the date currently on screen, and
   a closing that drifted last Tuesday is seen by nobody unless the list says
   so.

   It is derived from timestamps already stored, so **closings filed before
   this change report correctly too**, and no money write path was touched. The
   filed record is never rewritten — it is frozen on purpose, and the banner
   says so and points at a correction.

   What this does not do: it does not stop anyone recording late money, does
   not file the correction for you, and does not alert anybody — it surfaces
   on a page somebody has to open. It also only looks back 30 days, because
   that is the window the list queries.

   Evidence, measured rather than asserted: backend 225/225 across 7 files
   (day-close 12) — the count **as it stood at that commit**, deliberately not
   updated to match §3, since it records what this change was tested against
   rather than what the suite totals today. Five perturbations of
   `postCloseFor` reddened exactly the new tests and left the pre-existing
   day-close tests green, each restored byte-identical by sha256 afterwards.

   Three of those five were worth the trouble on their own, because they found
   a gap rather than confirming one. The refund half of `postCloseFor` had no
   test at all: `expectedCashDelta` is `cashTaken - cashRefunded`, and changing
   that one operator to `+` left **all 44 other tests green**. That is the
   direction that costs money — a closing would report the drawer as *up* after
   cash was handed back, sending a manager to look for takings that were
   actually paid out. The other two: a GATEWAY refund must count as activity
   without moving any cash figure, and a PENDING refund must not count at all,
   which `schema.prisma` had been asserting in a prose comment and nothing had
   been enforcing. All three now redden one named test and nothing else.

   The screens were rendered, not reasoned about — 34/34 in
   `/tmp/pos-render/render-postclose.mjs` across mixed,
   refund-only, card-only, clean-day and absent-field fixtures; the same set
   against a **pre-feature** bundle (`269b0f5`, which was what production was
   serving when the control was run) scores 15/34, with every assertion naming
   the feature red and only the controls green.

   Re-run against the **deployed** bundle after the 15:03 deploy, by the same
   method as items 9 and 13 — pulled out of the running container, `--prefix
   /pos` — it is 34/34. The backend half was checked separately, because a
   green frontend harness is fed by fixtures and would score 34/34 against a
   backend that never sends the field: `postCloseFor` appears 3× and
   `staleDays` 1× in `/app/src/api/routes/reports.js` inside the running
   container, whose digest matches the repo.

   That seam deserves naming, because it is the one place this evidence could
   have been circular. The render fixtures and the screen that reads them were
   written from the same reading of the same backend file, so a misreading
   would have been consistent across both and invisible in a green harness.
   What breaks the circle is that the backend tests assert field names against
   a real HTTP response from the real app and a real Postgres — and as of the
   refund test, **all eight fields** the screen reads (`payments`, `refunds`,
   `ordersBilled`, `expectedCashDelta`, `cashTaken`, `cashRefunded`,
   `nonCashTaken`, `lastAt`) are pinned there. Before it, two were not.

   Two things that control run caught, worth repeating because neither would
   have shown up any other way. First, two of my own assertions passed with no
   banner on screen at all — the closer's name and "file a correction" are
   printed elsewhere on the page regardless, so they were reading the page
   rather than the thing under test; both are now scoped to the banner element.
   Second, the longer day-column text squeezed the money columns until the
   ink gap between EXPECTED and COUNTED fell from 15px to **2px** at 1440.
   Fixed in the same commit and held at 13px across 1440/1024/768, stale or
   clean, zero page overflow at each.
3. **Every payment is a manual record.** Nothing is verified with a bank. See
   `guide-owner.md` §10 — this is stated to the client, not hidden.
4. **No offline mode.** No connection, no billing.
5. **Printing is browser-based** and has not been tested against any physical
   printer. §7.
6. **Backups are on the same disk as the database.** There is no off-host copy.
   This survives a bad migration; it does not survive losing the server. The
   procedure for fixing it is now written out in `BACKUP-RESTORE.md` §8 — it is
   waiting on a destination and a public key, both of which only the owner can
   supply. Written and unrun is better than unwritten, and worse than done.
7. **No alerting on a failed backup.** Someone must look.
8. ~~Reconciliation zero KPIs, Branches "0 of 0", Team browser-locale dates.~~
   Fixed in `652732f` and **deployed** (§1). Verified against the bundle pulled
   back out of the running container — not the working tree, which builds
   something else entirely — in six scenarios, every assertion paired with one
   that catches its inverse: 45/45.
9. ~~Six licence dates render in the browser's timezone.~~ All six fixed —
   `20dc41d` (Dashboard, ATC company detail) and `1ca40bc` (`Layout.jsx` top
   bar, the three on `Licensing.jsx`). **Fixed and DEPLOYED** — another session
   shipped it at 14:49 UTC, and it is verified against the bundle production is
   serving, not inferred from the commit graph. See the last paragraph.

   Worth keeping the method rather than the result. The harness that proved
   this originally used the unfixed top bar as its control — so fixing the bug
   destroyed the only thing that could make the harness go red. It was rebuilt
   around a control app code cannot reach: a raw `toLocaleDateString()`
   evaluated *inside the page*, which must **disagree** across the two
   timezones, or `timezoneId` is not being applied and every green is worthless.

   Running it against pre-fix code before trusting it was what earned its keep.
   It went red on "is rendered" but **green** on "does not slip a day" — the
   assertion named after the bug was the one assertion blind to it, because
   unfixed code emits `3/31/2027` and no `/30 Mar/` regex will ever match that.
   A third check per date now asserts the raw numeric rendering, taken from the
   page itself, does not appear on it. That took the pre-fix run from 6 red to
   14; the extra 8 were the top bar on screens whose own dates were fine.

   Final: 27/27 green on the fixed build, 14 red on the pre-fix build, and
   **27/27 green on the bundle production is serving right now** — pulled out
   of the running container and rendered, which is how "deployed" is known
   rather than assumed. Re-run at 15:09 UTC against `index-BKEWKpgq.js`, after
   the 15:03 deploy replaced the bundle this was first proved on. Re-running it
   was not ceremony: "the fix is an ancestor of what shipped" is a claim about
   the commit graph, and the graph is not what the café loads.

   ```sh
   docker cp pos-prod-frontend-1:/usr/share/nginx/html /tmp/pos-render/dist-live
   POS_DIST=/tmp/pos-render/dist-live POS_BASE=/pos node /tmp/pos-render/render-dates.mjs
   ```

   `POS_BASE=/pos` is not optional and its absence does not look like a
   configuration mistake. Without it the harness serves the live `index.html`,
   which asks for `/pos/assets/…`, and the SPA fallback answers with
   `index.html` **labelled `text/javascript`**. The app never boots, all 24
   date assertions go red on "is rendered" — and the three CONTROL assertions
   stay green, because they are raw `toLocaleDateString()` evaluated in the
   page and do not need the app at all. That reads exactly like a real
   regression. It is the base-path trap in §1 wearing a different hat.
10. ~~The product name is unsettled.~~ Settled, and it is **VEXO Connect**.
    Production was redeployed at 14:02 UTC on 2026-09-22 with the rebrand
    (`f94b9ce`, `269b0f5`), so the live site now says "VEXO Connect" and
    "ATC POS" appears nowhere in it. Two further deploys have landed on top
    since, so this was re-checked against the bundle currently served rather
    than assumed to carry forward: `index-BKEWKpgq.js` contains "VEXO Connect"
    once and "ATC POS" zero times. The two client documents were rewritten to
    match: re-counted 2026-09-22, `guide-owner.md` and `guide-cashier.md`
    carry **31** occurrences of "VEXO" between them (27 + 4) and "ATC POS"
    zero times. The metric is named here on purpose — the previous figure was
    a bare "24" against no stated basis, and a number nobody can reproduce
    cannot be checked when it drifts. It has now drifted, which is the
    argument for naming it: it read 26 until the audit-reader lane merged,
    which added six mentions to `guide-owner.md` (§1 and §8) and deleted one —
    the sentence "Everything VEXO does is written to an audit log you can be
    shown", which was not true — §9 below is the corrected version, and
    `guide-owner.md` §1 now says plainly that a VEXO *read* leaves no trace.
    Net +5. Re-take the count from the repo root with:

    ```sh
    cat docs/guide-owner.md docs/guide-cashier.md | grep -o 'VEXO'    | wc -l
    cat docs/guide-owner.md docs/guide-cashier.md | grep -o 'ATC POS' | wc -l
    ```

    The second number is the one that matters, and it must stay zero. The
    first will move every time the guides are edited, and that is fine — it
    is a checksum on the rebrand, not a target.

    Two things this did **not** change, deliberately: the URL is still
    `atcworkspace.com/pos`, and the footer still credits ATC Infocom Solutions
    Pvt. Ltd. A café owner therefore meets three names, so `guide-owner.md`
    now opens by saying plainly that they are the same people.

    If the rebrand was not intended, the documents and the deploy have to be
    reverted **together** — they are consistent with each other now, which
    means neither can be rolled back on its own.
11. **No pull-based payment recovery.** If a gateway `payment.captured` webhook
    is missed, nothing polls the provider to find out. Only relevant once the
    gateway is switched on, and it should be built before it is.
12. **There is no navigation below 768 px.** Measured on the deployed bundle at
    twelve widths: at 768 px a cashier on the Sell screen has four nav links;
    at 767 px they have **zero** — the sidebar is `hidden … md:flex` and
    nothing replaces it. The page itself is fine, with no horizontal overflow
    even at 320 px, which is exactly why this was nearly missed: the layout
    does not *look* broken, it is simply unusable, because a cashier on a phone
    cannot reach Orders to reprint a bill. **The POS needs a tablet or larger**
    — said plainly in `guide-owner.md` §9. A mobile menu is a small change if
    the client wants phones, and `Layout.jsx` is the only file it touches.
13. ~~**No error boundary.**~~ Fixed 2026-09-22 in `1e64b24` and **deployed**
    at 14:49 UTC in the same push as item 9 — 18/18 green against the bundle
    pulled out of the running container, re-confirmed at 15:09 UTC against
    `index-BKEWKpgq.js` after the 15:03 deploy, same method and same
    `POS_BASE=/pos` caveat as item 9. The measured
    before-and-after: a 200 whose body the Dashboard could not render left the
    page with **zero characters of text**, and now leaves a readable screen of
    951 with the sidebar still usable. React 18 unmounts the whole tree on an
    uncaught render error, which is why the old failure was a genuinely blank
    white page rather than a broken-looking one.

    There are two boundaries and they cover different things. The inner one is
    inside `Layout`'s `<main>`, so the navigation survives a single screen
    crashing; it is keyed on the pathname so the error **resets** when the
    cashier navigates, instead of latching onto every subsequent screen. The
    outer one in `main.jsx` catches what the inner cannot, because the inner is
    a child of it: a throw in `Layout` itself, in the auth provider, or in the
    router. Both are exercised by `render-errorboundary.mjs`, and the two cases
    are told apart by whether the sidebar and footer survive — detecting merely
    that "an error screen appeared" would not distinguish them.

    The error screen leads with plain English and puts the exception last,
    labelled as the line to read out. That ordering is deliberate: a cashier who
    can only tell support "it says something went wrong" is no better off than
    one staring at a white page, so the technical string stays — just not first.

    **What this does not do.** It does not catch errors thrown in event handlers
    or in async code, which is most of them — an axios rejection inside a click
    handler is still caught where it happens, by the per-page `try/catch` and
    `ErrorNote`. This is not a general safety net and should not be described to
    the client as one. It guarantees one narrow thing: a *render* failure
    degrades to a readable screen instead of a white one.

14. **The billing chain has been proved over HTTP, not through a browser.**
    Order → KOT → bill → manual payment → partial refund → sales
    reconciliation has been driven end to end against the deployed URL and
    verified in the database, and individual screens have been rendered and
    checked (items 8, 9, 12, 13 above). What has *not* happened is one
    continuous run where a person's clicks produce that whole chain. The
    harness for it is written — accounts provisioned per run and neutralised
    afterwards, an isolated till with no prior activity for the day-close, a
    wrong-password control, a double-click control, and a cross-branch
    isolation control — and it has never been executed, because script
    execution is blocked in the environment it was written in.

    The distinction matters in one specific direction. HTTP proves the server
    does the right thing when asked correctly. It does not prove the screen
    asks correctly — a button wired to the wrong handler, a form that submits
    twice, a total that renders stale after a refund all pass an HTTP suite
    untouched. Treat the billing chain as **server-verified, not
    cashier-verified**, and have a human click through one full sale, one
    refund and one closing before the client is left alone with it.

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
7. **The till hardware** — what the cashier will actually look at: screen size
   and resolution, touch or mouse, and whether it sits portrait or landscape.
   The layout has been checked at 1440×900 on a desktop browser. That is not a
   claim about a 10-inch tablet, and the difference is the kind that is only
   found by looking. One line of answer is enough — "15.6" landscape
   touchscreen, 1920×1080" — and it decides whether any layout work is needed
   before the client sees the screen.

Only if online payment is wanted:

8. **The client's own Razorpay merchant account**, with test credentials first.
   ATC then completes the sandbox sequence in §5.2 — a real captured payment, a
   duplicate webhook, and a real refund — before any live key is installed.
   **Live payments stay off until that is done and the client authorises it in
   writing.**

---

## 9. ATC operational controls

### Release freeze and the single deployment owner

**Production is frozen at `f014ab5` for the duration of client UAT.** The
build that the client is being asked to accept is the build that was measured
in §5, and anything deployed on top of it invalidates that measurement.

The rule, in one sentence: **one person deploys, and during the freeze that
person deploys nothing.**

What the freeze covers, and what it does not:

| Action | During the freeze |
|---|---|
| `docker compose -f docker-compose.prod.yml build` / `up -d` against `pos-prod` | **Deployment owner only**, and only to roll back |
| Merging to `main` | Allowed — merging is not deploying |
| Committing, branching, working in a lane | Allowed |
| Editing `/home/atc-noc/atc-pos` (the shared tree) | Allowed by its owner; it is **not** what production runs |
| `docker volume rm` / `docker volume prune` | **Forbidden.** Dangling POS volumes are an owner decision, not a cleanup |
| Enabling the gateway | **Forbidden.** See "Live payments cannot happen" below |
| nginx, certbot, DNS for `atcworkspace.com` | **Forbidden** — that is the vexoconnect.com release, deliberately separate |

Why a single owner rather than a convention. The frontend service builds from
`context: ./frontend`, which is the **working tree**, not a git ref. Two people
deploying from two trees produce two different bundles from the same commit
hash and neither can prove which one is serving. The counter-measure is
procedural, not technical: deploy from a pinned worktree, and have exactly one
person doing it.

Ending the freeze takes three things, in order:

1. The client returns a GO on the UAT in §4.
2. The deployment owner re-reads §1 for the current bundle hash and byte size,
   so the *next* release has a stated predecessor rather than a remembered one.
3. Rollback anchors are re-pinned before the new build, because the old ones
   point at `f014ab5` and will be wrong the moment it is superseded.

Two sets of tags matter, and they point in opposite directions:

```
# roll BACK off f014ab5 — the build that preceded it
pos-prod-frontend:rollback-20260922-preactivity   39205084de0e
pos-prod-backend:rollback-20260922-preactivity    96a494e650b3

# roll back TO f014ab5 — what the next release must be able to return to
pos-prod-frontend:20260922-merge-f014ab5          0db76709b98b
pos-prod-backend:20260922-merge-f014ab5           055f9ae7f23f
```

The second pair is the one people forget. `latest` moves with every build, so
a release that only tags `latest` leaves the build it replaced reachable by
image ID alone — and an untagged image is eligible for `docker image prune`,
which has already happened once on this host, leaving production running an
image the daemon no longer held and nothing to roll back to. Pin a dated tag
**before** `compose build`, not after.

- **VEXO Console → Companies** — every tenant, its licence, branch count and
  staff. That is the label on the screen; the role badge reads "VEXO Admin".
- **Licence** — plan, expiry, branch entitlement, additional-branch add-ons.
  Expiry is computed from `expiresAt` at read time, so it cannot be missed by a
  failed job and cannot be postponed except by changing the date.
- **ATC is read-only inside a customer's data**, and is refused the daily
  closing outright.
- **ATC changes are audited; ATC reads are not.** The six actions that alter a
  tenant — create company, change its status, issue a licence, add a branch
  add-on, change licence status, create a user — each write a `PosAuditLog` row
  naming the ATC admin who did it. `GET /pos/api/atc/companies` and
  `GET /pos/api/atc/companies/:id` write nothing, and the second returns that
  tenant's branches and its staff emails, roles and last-login times. So an ATC
  admin can read a customer's staff list and leave no trace. Tell a client that
  plainly; do not tell them every access is logged.
- Showing *these* rows to a client still means running
  `deploy/audit-queries.sql` (below). **Reports → Discounts & voids** reads the
  same table but deliberately only the money that moves without a sale behind
  it — discounts, voids, refunds. ATC actions are not in it and should not be:
  it is a tenant's screen, and `COMPANY_STATUS_CHANGE` is not a tenant's
  business. Query 5 lists every action present, which is where the ATC ones
  appear.
- In production that table holds **zero** ATC rows today, which is expected
  rather than alarming: the single tenant was seeded straight into the database
  instead of being created through the console. The consequence is that the ATC
  audit path had never been watched run anywhere until the suite was made to
  check it — `foundation.test.js`, "audits what ATC changes, and records nothing
  when ATC only looks", which asserts both halves of the bullet above and was
  confirmed to go red when the `COMPANY_CREATE` write is removed.
- Audit queries, read-only and safe during service:

  ```sh
  # ATC-side review, every tenant
  docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos \
    < deploy/audit-queries.sql

  # answering one customer — pass their company, printed by query 0
  docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos \
    -v company=<companyId> < deploy/audit-queries.sql
  ```

  **Use the scoped form before showing anything to a client.** The file spans
  every company by default, which is right for ATC and wrong the moment the
  output leaves this building. `guide-owner.md` §5 now tells owners to ask for
  this, so the unscoped form is a standing way to hand one customer another's
  cashier names.

  Two things about the scope are not obvious and are written into the file
  beside the queries. Rows with a null `companyId` vanish under it — on
  2026-09-22 the scope took `LOGIN_FAILED` from 36 rows to 4 and `LOGIN_SUCCESS`
  from 23 to 18, the missing sign-ins being ATC's own, since a VEXO
  administrator belongs to no company. And query 4 is deliberately left
  unscoped, because a failed sign-in against an address that does not exist
  resolves no company, so scoping would drop precisely the attack signal while
  keeping the ordinary forgotten passwords.

  Run query 0 first either way — it is a control, and if its `correct_ist`
  column is not `stored` + 5:30 the rest of the output should not be trusted.
- Logs: `docker compose -f docker-compose.prod.yml logs backend`.
- Restart: `docker compose -f docker-compose.prod.yml up -d --no-deps backend`
  — `restart` alone re-runs the old container with the old environment.
- Config drift: `docker compose --dry-run -f docker-compose.prod.yml up -d`.
  All `Running` means the running stack matches the file; any `Recreate` names
  a service whose config was edited but never applied. Read-only. See §1 for
  why git cannot answer this and for the control that proves the check works.
- The POS stack is `pos-prod` and publishes only `127.0.0.1:8110`. Nothing here
  touches the other ATCWorkspace services.

### Runtime, as measured

| | |
|---|---|
| Restart policy | `unless-stopped` on all three containers |
| Docker at boot | `enabled` |
| Survives reboot | **observed** — Postgres has been up since the host's last boot, not restarted by hand |
| Health endpoint | `GET /pos/api/health` → 200 |
| Container healthcheck | **All three**, added `b75b062` and applied 15:21 UTC — `docker ps` reports `(healthy)` for postgres, backend and frontend |

That last row was a gap until 15:21 UTC: a node process that has stopped
accepting requests still reports `Up`, so `docker ps` could not tell a working
till from a wedged one. (Timestamp from the container's own creation time, not
from when the green was noticed a few minutes later — the backend's
`start_period` is 60s, so `healthy` necessarily lags the deploy.)

**Read the row for exactly what it claims.** Compose does *not* restart a
container for failing its healthcheck — that needs a watchdog nobody has
asked for yet. What this buys is an honest answer to "is it serving?" and
correct `depends_on` ordering. Anyone reading `(healthy)` as "it will heal
itself" will be wrong at the worst possible moment.

Each probe uses a client its own image actually has, which was checked in the
running containers rather than assumed: `node:20-bookworm-slim` ships neither
`curl` nor `wget`, and `nginx:1.27-alpine` ships `wget` and no `node`. A
healthcheck invoking a binary the image lacks reports unhealthy forever, which
looks identical to the fault it was added to catch.

It was proved able to fail before being trusted, because a check that has
never gone red is decoration. Same image, same probe, one difference — pointed
at a port nothing listens on — in a throwaway compose project that cannot
reach the production stack:

```sh
docker compose -f deploy/healthcheck-negctl.yml up -d
docker inspect -f '{{.State.Health.Status}}' pos-healthcheck-negctl-deadport-1
docker compose -f deploy/healthcheck-negctl.yml down
```

That file lives in the repo rather than `/tmp` on purpose: a control that
evaporates on reboot cannot be re-run by whoever inherits this, and an
unrunnable control is the same as no control. Its `test:` block must stay
byte-identical to the backend's in `docker-compose.prod.yml` — if they drift
it stops being a control and becomes a test of a probe nothing uses.

`unhealthy`, exit code 1 on both retries, while the real backend on the same
image reports `healthy`. Both halves are needed: the green alone would not
distinguish a working probe from one that cannot fail.

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

### The demo catalog was edited directly in the database, 2026-09-22

Recorded here because it was done by hand, outside the application, and the
application's own history does not show it.

**What was wrong.** Two acceptance-harness products were left `ACTIVE` in the
demo company and were rendering on the cashier's Sell screen, with two dead
category chips beside them. They were found by looking at a screenshot, not by
a test — nothing asserts that the demo catalog contains only demo items.

**The four records.**

| Record | Id | Change |
|---|---|---|
| Product "UAT Filter Coffee 1279c8" | `cmucxdysh001jv86urn3glsmo` | `ACTIVE` → `ARCHIVED`, category → Hot Coffee |
| Product "UAT Filter Coffee 3f4301" | `cmucwmqni000fv86u714v1etw` | `ACTIVE` → `ARCHIVED`, category → Hot Coffee |
| Category "UAT Coffee 1279c8" | `cmucxdyrp001gv86uzaonzbct` | deleted |
| Category "UAT Coffee 3f4301" | `cmucwmqmh000cv86u5k5pw6wm` | deleted |

**Why archive and not delete.** `OrderItem.productId` is `ON DELETE RESTRICT`
and each product carries one real order line. Archiving is also what the
application itself does — `catalog.js` `DELETE /products/:id` sets
`status: 'ARCHIVED'` rather than removing the row. `GET /products` defaults to
`status: 'ACTIVE'`, so archived items leave the till, and `orders.js` refuses
to add a non-`ACTIVE` product to a new order. The categories were only
deletable *after* the products were moved off them, for the same FK reason.

**Before and after.**

| | Before | After |
|---|---|---|
| Active products | 25 | 23 |
| Archived products | 0 | 2 |
| Categories | 9 | 7 |
| Active products matching `uat\|recon\|probe\|test` | 2 | 0 |
| `BSC-CP/26-27/00004` | PAID, ₹210.00, 1 line | unchanged |
| `BSC-CP/26-27/00005` | PAID, ₹210.00, 1 line | unchanged |

The order rows are the control: a cleanup that altered a historical total
would have been the wrong cleanup.

**No application audit entry exists for any of it, and none was fabricated.**
Measured rather than assumed:

- Audit rows for these four ids: **4** — `CATEGORY_CREATE` and
  `PRODUCT_CREATE` ×2, written through the API by the harness owner accounts
  when the records were made.
- Audit rows at or after the archive, with a minute of grace either side: **0**.
- `PRODUCT_ARCHIVE` / `CATEGORY_DELETE` / any catalog mutation action anywhere
  in `PosAuditLog`, ever: **0**.

So the trail for these four records ends at creation. Read on its own it says
they still exist, and it is wrong. That is the cost of reaching past the
application, and it is the reason the same fix should go through the API if it
ever has to be done again — an owner signing in and archiving from
**Catalog** produces the row that this did not.

**Post-cleanup acceptance: NOT RUN.** `deploy/uat-acceptance.mjs` last returned
24 PASS / 0 FAIL / 2 NOT TESTED *before* these records changed. The rerun that
would confirm the catalog edit broke nothing was attempted and refused by the
environment. Nothing here is regression-checked; the evidence above is direct
database observation only.
