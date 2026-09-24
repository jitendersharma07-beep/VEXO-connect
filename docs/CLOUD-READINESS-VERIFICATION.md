# Cloud readiness verification

Run 2026-09-24 on `atc-noc` against an isolated staging stack built from this
tree. Scope: public HTTPS access, permanent real platform-admin access, email
password recovery, tenant and store isolation, the complete operational flow,
and backup/recovery. Physical printer acceptance is deliberately out of scope
and stays NOT TESTED until paper is observed.

**Verdict: NOT READY for owner acceptance.** Three blockers, listed at the end.
Nothing here blocks the product's core; what is blocked is *cloud* readiness —
reaching it over the internet, and recovering an account or an archive without
an administrator standing next to the machine.

> **Update 2026-09-24T19:20Z — blocker 2 is closed in code.** The owner directed
> `x/accounts` to be merged; it was, and email password recovery now works end to
> end. See [After the merge](#after-the-merge--email-recovery-now-works) at the
> foot of this document. The verdict stays **NOT READY**, because one of the two
> remaining blockers is unchanged and recovery still has no mail provider to
> deliver through. Everything between here and that section describes the
> pre-merge build and is kept as written.

## The build that was tested

| | |
|---|---|
| Branch / commit | `x/cloud-readiness` @ **`1c7e8e6`** — identical to `main` and `github/main` at the time of the run |
| Frontend bundle | `dist/assets/index-aCB18xDB.js`, sha256 `4d8f8d25…96d19d`, API root `/api` |
| Migrations | 21 applied, shadow-DB diff clean |
| Databases | `vcx_staging` (app), `vcx_staging_test` (suite), `vcx_staging_shadow` — all created for this run, all on the existing loopback dev Postgres |
| Backend suite | **628/628 pass, 22/22 files, 0 skipped** |

`main` has since advanced 3 commits to `e78928a`. One of those touches backend
source (`0115898`, a catalog guard); the other two are documentation and QA
artifacts. **Anything below is evidence about `1c7e8e6`, not about `e78928a`.**

Production was not deployed to, written to, or read from. No other worker's
lane or worktree was modified.

## Result

| Area | Result | Tested build | Evidence | Remaining action |
|---|---|---|---|---|
| HTTPS / public access | **BLOCKED** | `1c7e8e6` | `evidence/02-*` | No approved public staging hostname exists. Exact DNS/proxy/TLS change-set is prepared and **not applied**; owner approves, then re-run. |
| Real platform admin + customer provisioning | **PASS** (defect CR-1 found and fixed) | `1c7e8e6` | `evidence/03-*` | Ship CR-1. "Enabled modules" per licence is **not implemented** — product decision, not a defect. |
| Email delivery + password reset | **BLOCKED** | `1c7e8e6` | `evidence/04-*` | The capability is absent from this build (0 occurrences in the shipped bundle). A complete implementation sits on unmerged lane `x/accounts`. Merge decision is the owner's; then verify with authorized inbox access. |
| Tenant / store isolation | **PASS** — 58/58 probes | `1c7e8e6` | `evidence/05-*` | None. Inventory scope untestable here because inventory is not in this build. |
| Billing / payment / inventory / reporting | **PASS for what this build implements** | `1c7e8e6` | `evidence/06-*` | Three sub-checks are **NOT IN THIS BUILD** (recipe/modifier consumption, stock quantity/unit handling, restocking policy) — they live on unmerged lane `x/inventory`. Re-run after merge. |
| Encrypted backup restore | **PASS** for schedule + restore (16/16); **BLOCKED** for decryption | archive `pos-prod-20260923T211456Z` | `evidence/07-*` | One owner-run command closes the decryption half. Destination-side deletion protection is **NOT VERIFIED**. |
| Physical printer acceptance | **NOT TESTED** | — | — | Stays NOT TESTED until observed paper output exists. Never claim from emulation. |

Evidence directory: `/home/atc-noc/vcx-cloudready-local/evidence/` on `atc-noc`.
It is kept **outside this repository on purpose** — it records host addresses,
a backup destination, a key fingerprint and staging account names, and this
repository is public. No password, code, token or SMTP credential appears in
either place.

## What each result rests on

### Public access — BLOCKED

Ten candidate hostnames were resolved; every plausible staging name is
NXDOMAIN. There is no approved public staging hostname to verify, so public
HTTPS, external-network access, cross-device browser checks and cookie/CORS
behaviour against a real origin could not be tested — they are blocked, not
failed.

Per the brief the production route was **not** touched. The prepared change-set
(`evidence/02-public-access-changeset-PROPOSED.md`) is a review artifact: DNS
record, nginx server block, certificate issuance, and the application-side
`APP_URL` / `CORS_ORIGIN` / `COOKIE_SECURE` changes that must land with it.
Nothing in it has been applied.

What *was* verified, on the loopback edge that fronts the candidate: the SPA,
its assets and the API are served from one origin through a single reverse
proxy, the session cookie is `HttpOnly`, and the edge serves the `1c7e8e6`
bundle by hash. Cookie `Secure` is absent only because the loopback origin is
plain HTTP; the change-set sets it.

### Real platform admin — PASS, after CR-1

`POS_SUPER_ADMIN` was the one role no API could mint: the user route filters it
out of the assignable enum, and the platform console creates companies,
licences and *customer owners* but has no operator-creation route. The only
platform administrator was the single address hardcoded in `prisma/seed.js`.
The owner could not hold admin access under their own verified address, and no
deployment could hold a second operator — so the account that cannot be created
was also the account that cannot be replaced.

CR-1 takes the operator identity from `POS_SEED_ADMIN_EMAIL` /
`POS_SEED_ADMIN_NAME`, defaulting to the previous values so existing
deployments are unchanged, and rejects a malformed address before it reaches
the database — a typo would otherwise mint an operator nobody can sign in as
and no API can delete. Two operators now exist.

Verified live afterwards: first sign-in, forced password change, old password
refused, sign-out revoking the cookie, sign back in, and full platform-console
control after re-login. Customer owners cannot self-issue a licence, read the
platform console, forge a tenant through a header or a query parameter, or
reach another tenant's store — each refusal was checked against a positive
control so that a 404 proves the isolation boundary answered rather than a
route that always 404s. The last platform administrator cannot be disabled or
deleted from any customer-facing API.

### Email password recovery — BLOCKED

Not "untested": absent. `auth.js` declares `/login`, `/logout`, `/me` and
`/change-password` and nothing else; there is no mail library in
`package.json`; and the built bundle contains **0 occurrences** of any
recovery string. That last check is the one that matters — the shipped artifact
has no entry point, so this is not a configuration gap that could be switched
on.

The build does have administrator-driven reset, which was verified PASS
end-to-end including session invalidation and the requirement that a reset
must not alter roles, tenant membership or licences. It is not self-service and
sends no email.

A complete implementation — recovery routes, mailer, SMTP client, TOTP,
invitation-based operator bootstrap and its tests — exists on `x/accounts`
@ `73ed837`, which is **not an ancestor of `main`**. It was not verified here:
it is another worker's active lane carrying its own migration, and merging it
is a release decision, not a verification step.

No mail was sent to any address during this verification. A provider
"accepted" response would not have counted as delivery proof in any case.

### Isolation — PASS

Two staging tenants with owner/manager/cashier accounts and multiple stores
each. 58 probes across UI and direct API: cross-tenant reads and writes,
identifier substitution in path, query and header, branch-scoped users against
unauthorized stores, and reports, exports, customer records and settings under
the same scope. Hidden menu items were checked to be backed by server-side
authorization rather than only by the client. The pre-existing demo tenant was
left untouched.

Inventory scope is **NOT TESTABLE** on this build because inventory is not in
it — an earlier draft of the isolation evidence said the subsystem "does not
exist", which was wrong and is corrected in place. It exists on the unmerged
`x/inventory` lane.

### Operational flow — PASS for what is implemented

A browser walkthrough from company and store setup through product and tax
configuration, order, KOT, bill, payment, receipt and reports to day close,
plus partial payment, void and refund. Amounts and states were reconciled in
five places — API response, receipt, database, report and day close — and they
agree exactly, including the day-close figures, which are stored as paise
integers while order totals are decimals.

Retries were checked to not duplicate payments, invoices or kitchen tickets:
a replayed payment with the same idempotency key answers 200 with the existing
payment rather than 201 with a new row, and a replayed kitchen decision on a
stale version is a no-op while a *conflicting* one is refused.

Manual/sandbox payment methods only. No real charge was made.

Defect CR-2 was found here and fixed: a duplicate kitchen station returned a
500 from a database constraint; it now returns 409 from an explicit check
inside the same transaction.

Three required sub-checks are **not in this build and are reported as
unfinished features rather than counted as passed**: recipe and modifier
consumption, inventory quantity/unit handling, and the refund restocking
policy. The instruction not to automatically restock prepared food is
consequently moot here and must be re-checked when `x/inventory` merges.

### Backup and recovery — PASS for restore, BLOCKED for decryption

The obsolete "not installed" claim is not repeated. The timer and service are
both enabled and active, the schedule is nightly with a randomized delay and
`Persistent=true`, and the last run — 21 hours before this check — exited 0 on
both steps. Nothing was reinstalled, and no archive, key or revocation
certificate was deleted.

A real production archive was restored into a **new, uniquely-named, empty**
database and reconciled against that archive's own manifest rather than against
the live database — live is the backup plus every sale since, so comparing
against it would fail the drill the moment the café sells anything, which is
precisely when backups start to matter. **16/16 PASS**: size, checksum and
format; 23/23 table counts; payment total to the paisa; migration state with no
migration left half-applied; staff logins with usable password hashes; foreign
keys and indexes; no payment orphaned from its order.

Two of those checks are about the drill itself rather than the data. A
**truncated archive must fail**, and it does — `pg_restore` defaults to logging
errors, continuing and exiting 0, which is how a half-restored database gets
called a successful restore; with `--exit-on-error` the negative control exits
1 and leaves **0 tables**, not a database that looks complete. And the retained
archive is **byte-identical after the drill**, so testing it did not consume it.

The restore script contains no `DROP` of any kind and leaves both databases in
place for inspection, so it cannot destroy anything by being wrong about a name.

**Decryption is BLOCKED, not passed by inference.** No encrypted archive exists
on this host to open — the staging directory is cleared after each successful
ship, correctly — and the private key is passphrase-protected, which was
verified without asking for the passphrase by offering an empty one and having
it refused. The encryption *mechanism* round-trips under a rehearsal key; that
proves the mechanism, not that archives encrypted to the owner's key can be
opened, which is the thing that matters.

One reviewed, guarded, self-logging owner-run command closes it. It exists at
`/home/atc-noc/vcx-cloudready-local/owner-verify-backup-decrypt.sh`, passes
`bash -n`, every tool it calls is present, and its manifest parsing was run
against the real manifest and returned the correct hash. It works only inside a
fresh temporary directory it removes on exit, deletes no archive or key,
touches no database, fails closed at every step, and prints a single `RESULT:`
line — which is the only thing that needs to be sent back. The passphrase is
never requested in chat, written to disk, or echoed.

Destination location, deletion protection and key custody are reported
separately in the evidence, as required. The short version: the sender declines
to prune the destination, but that is a **voluntary** control, not an enforced
one, and destination-side enforcement is **NOT VERIFIED** because verifying it
would require using a host this task was instructed not to use. A successful
copy does not prove those controls, and it is not treated as proving them.

## Defects fixed in this branch

| ID | Defect | Fix |
|---|---|---|
| **CR-1** | No deployment could have a platform administrator other than one hardcoded address, and none could hold a second operator — an unrecoverable lockout risk | `backend/prisma/seed.js` — operator identity from `POS_SEED_ADMIN_EMAIL` / `POS_SEED_ADMIN_NAME`, defaults preserved, malformed address rejected before insert |
| **CR-2** | Creating a duplicate kitchen station returned 500 from a raw constraint violation | `backend/src/api/routes/kitchen.js` — explicit pre-check inside the existing transaction, returning 409 |

Both are backward-compatible and additive. The full suite was re-run after
them: **628/628, 0 skipped**.

### On the suite total

An intermediate run showed 17 files failing and 509 tests skipped, every
failure reading `The table public.PhoneOrderEvent does not exist`. That was not
a regression: the test database had never had migrations applied (0 tables
against the app database's 55). A `testmigrate` step was added to the local
runner, migrations were applied, and the suite returned to 628/628 with nothing
skipped. No test was deleted, disabled or rewritten to make it pass.

## Findings raised, not fixed

These are custody and configuration matters at the host or destination, outside
this repository and outside this task's authority to change.

| ID | Finding |
|---|---|
| **CR-3** | The backup tooling's own comment states the design control is *"this host cannot do it — that is the point of the key direction"*. The secret key is in fact on this host, on the same machine that takes the dumps and holds the plaintext copies. The passphrase is genuine and doing real work, so this is not an open door — but it is one factor where the design claims two. The fix is custody, not code. |
| **CR-4** | The backup destination is reached with the operator's general-purpose SSH key, while a dedicated key pair for exactly this job already exists beside it, unused. Consequently anything that can SSH as the operator can also delete the off-site archives — which is why deletion protection reads "not verified *and unlikely*" rather than merely "not verified". |
| **CR-5** | "The backups are encrypted" is true only of the off-site copy. The retained local archives are plaintext dumps at mode 600. Reasonable — the working copy has to be usable — but stated so the sentence is never read more broadly than it is true. |

## Unfinished capabilities — explicitly not counted as passed

- **Email password recovery** — absent from this build (`x/accounts`, unmerged).
- **Inventory, recipes, modifiers, restocking** — absent from this build
  (`x/inventory`, unmerged).
- **Per-licence enabled modules** — no such concept exists. The schema carries
  plan, status, dates, branch limit and add-ons; there is no per-module
  entitlement field anywhere, and no route sets one. Feature gating exists at
  the *user* level, which is not interchangeable: a permission decides what an
  employee may do inside a tenant that already has the feature; it cannot
  express "this customer did not buy KDS".
- **Physical printing** — browser print only, unobserved on paper.

## Blockers to owner acceptance

1. **No approved public staging hostname.** Until one exists, nothing about
   public HTTPS access can be verified. The change-set is prepared and awaits
   approval; it must not be applied over the production route.
2. **No email password recovery in the candidate.** The owner decides whether
   `x/accounts` merges into the release. Verifying delivery then additionally
   needs SMTP credentials and authorized inbox access or explicit owner
   confirmation — a provider "accepted" response is not delivery proof.
3. **Encrypted archive decryption unproven.** One owner-run command, already
   written and checked, closes it. Send back only the `RESULT:` line.

Not blockers, but they gate specific claims rather than the release: physical
printing stays NOT TESTED; destination-side deletion protection stays NOT
VERIFIED; and inventory-dependent flow checks must be re-run once that lane
merges.

## Reproducing this

The staging stack is driven by `/home/atc-noc/vcx-cloudready-local/vcxcr`
(`setup | migrate | testmigrate | seed | test | migsql | build | up | down |
status`). It writes only to the three `vcx_staging*` databases and overlays
node_modules by symlink rather than installing, so it shares nothing with any
other lane. The restore drill is `restore_drill.py` in the same directory.

Production activation remains subject to the owner's approval of the tested
release, separately from this verification.

## After the merge — email recovery now works

The owner directed `x/accounts` to be merged rather than left as a release
decision. This section records that, and supersedes the "Email password
recovery — BLOCKED" section above. It does **not** supersede anything else.

Tested build: `x/cloud-readiness` @ **`98c11a2`** = `8482de9` + `x/accounts`
@ `6ceab72`. Bundle rebuilt: `index-TZS0KpMt.js` (636.4 kB, up from 612.6 kB).
Migrations: 22 applied. Full evidence: `evidence/04-email-password-recovery.md`,
section "After the merge".

### The merge was not trivial, and that is the finding

`x/accounts` was ~7 hours behind `main` and **four files conflicted**. Two of
them were quiet enough to be worth naming:

- `vitest.config.js` auto-merged into **two `globalSetup` keys**. That is
  silent last-wins in JavaScript, not an error, so one of the two lanes' setup
  mechanisms would have vanished with no failing test to say so.
- `backend/tests/globalSetup.js` was an add/add of two different safeguards —
  this lane's cross-worktree advisory lock, and the accounts lane's
  truncate-at-start. Picking either side would have silently dropped a real
  protection. Both are kept, with the truncate ordered *after* lock acquisition.

`schema.prisma` was resolved as a union and then verified as one rather than
eyeballed: all 100 models and enums from both sides present, every single-side
model byte-identical to its origin, and no semantic line dropped from the 17
models both lanes touched.

### What now passes

| Evidence | Result |
|---|---|
| Regression suite, merged tree | **774/774 pass, 28/28 files, 0 skipped** (was 628/22) |
| `deploy/accounts-journey.mjs` — real bundle, headless Chromium, real SMTP conversation | **47/47 PASS, 0 FAIL** |

The journey is the load-bearing evidence: it proves the *screens* are wired to
the endpoints, which the unit suite cannot. Code delivered to a mailbox and read
back out of the SMTP conversation; 8-digit code accepted; new password set
through the browser; the replaced password 401s; the recovered password signs
in; every session revoked; and an unregistered address answered byte-identically
to a registered one, so the screen is not an account oracle.

### What is still blocked — and it is not the code

Real-provider delivery is **unproven**. Every message went to a loopback sink
that relays nothing.

The reason is now measured rather than assumed: **no SMTP sender is configured
anywhere in the estate.** A read-only search for a live `SMTP_HOST` / `MAIL_HOST`
/ `EMAIL_HOST` assignment across the POS trees, `/opt/atc`, Netstay, AGR and
VEXO ONE returns zero hits in a real env file — every match is a `.env.example`
or a deployment document. Only key presence was checked; no values were read.

So this is an owner input of the same shape as the Netstay SMS gap, and the code
fails **closed** on it rather than pretending: with `SMTP_HOST` unset,
`POST /api/auth/forgot-password` answers `503 POS_MAIL_NOT_CONFIGURED` and the
platform-admin bootstrap refuses to create an administrator nobody can reach.
`docs/ACCOUNTS-GO-LIVE.md` §1 is the exact configuration. Credentials go in the
deployment's secret store — **not into chat, a tracked file, or a terminal that
keeps scrollback.**

### One regression this merge introduces

`deploy/e2e-workflow.mjs`, the till money-path harness, **is now blocked.** It
seeded its staff from the temporary password `POST /api/users` used to return,
and by design that password no longer exists. The script refuses with the recipe
for wiring a sink rather than failing deep in the money path — loud, not silent.
Section 6's evidence did not run through it and is unaffected, but anyone
re-running it on the merged tree will hit this.

### Revised blockers

1. **No approved public staging hostname** — unchanged.
2. ~~No email password recovery in the candidate~~ → **merged and passing.**
   Now: **no mail provider configured anywhere in the estate**, so delivery to a
   real inbox cannot be proven. Owner input, not code.
3. **Encrypted archive decryption unproven** — unchanged.

**Verdict is unchanged: NOT READY for owner acceptance.** Blocker 2 moved from
"the feature does not exist" to "the feature exists, is tested end to end, and
has nothing to send through", which is a materially better position but is not
the same as closed.
