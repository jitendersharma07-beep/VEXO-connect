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
| Backend commit | **`9b85da3`**. Proven by digest, not by tag: `/app/src` in the running container and `backend/src` in the working tree agree on both the file listing (`f8e33f7f…`) and the set of content hashes (`1434a3d1…`). Image `pos-prod-backend:20260922-proxy-hops` (`96a494e650b3`), container created 15:42 UTC |
| Frontend commit | **`0084936`**, image `39205084de0e`, container created 15:41 UTC by another session |
| Frontend bundle | `assets/index-BKEWKpgq.js`, sha256 `6989289f…`, 420234 bytes. Unchanged by that 15:41 rebuild — re-hashed off the public URL at 15:46 UTC and identical to the byte-for-byte reproduction from `0084936` |
| Rollback tags | `pos-prod-backend:rollback-20260922-1543` (`b4de17df52df`, the backend live before 15:42), `pos-prod-frontend:rollback-20260922-1501` (`173962d8e5f1`) |
| Database migrations applied | 8, unchanged. This deploy carried no migration and the boot log says so: `8 migrations found` then `No pending migrations to apply.` |

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

One number in that row invites a wrong conclusion, so it is written out:
`deploy/prod-verify.mjs` reports the bundle as 419854 while the file is 420234
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

**Devices**
- [ ] Cashier screen usable at the till's actual resolution
- [ ] Owner dashboard readable on the owner's laptop and phone

---

## 5. What has been verified, and how

Separated by kind of evidence, because they are not equally strong.

### Automated tests — mocked, not a real provider

Backend suite: **227 passed / 227**, 7 files (foundation 22, money 13,
logRedaction 7, phase2 45, razorpay 53, razorpayFlow 32, gateway 55), run
against the dev test database and re-measured at 15:52 UTC. Money arithmetic,
order lifecycle, RBAC, tenant scoping, licence gating, refund states, log
redaction, and the gateway adapter **against a mock**. Re-measure rather than
quoting this number — it has been stale in this document three times, and was
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

**Before running that sequence, restart the dev backend on 5010.** As of 15:30
UTC the process serving it (pid 2502017) started at 11:07:59, and the
double-click payment fix landed at 12:29 in `7dbe58e` — so it is running
pre-fix code and will reproduce a bug that is already fixed in the tree. This
is not a guess from a file timestamp: a node process serves whatever was on
disk when it loaded the module, and that commit is an hour and a half younger
than the process. It is a *development* backend, unrelated to the production
containers; left alone deliberately, because another session may own it.

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
   This survives a bad migration; it does not survive losing the server.
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
    carry 26 occurrences of "VEXO" between them and "ATC POS" zero times. The
    metric is named here on purpose — the previous figure was a bare "24"
    against no stated basis, and a number nobody can reproduce cannot be
    checked when it drifts.

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
