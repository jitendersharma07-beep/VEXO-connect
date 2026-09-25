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

> **Update 2026-09-25T02:40Z — six rows reconciled at `bcfa6ed`.** The candidate
> is now **`bcfa6ed`** (code identical to `17058b9`), suite **815/815 in 32
> files**. See [Reconciliation](#reconciliation--2026-09-25t0240z-at-bcfa6ed) at
> the foot of this document. Read it before quoting any row above: one bullet
> there was **factually wrong**, two rows claimed more coverage than they had,
> and the commit the brief named (`5550e1b`) is two code-generations stale. The
> verdict stays **NOT READY** on the same three blockers.

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
| Real platform admin + customer provisioning | **PASS** for the *software* — ⚠ **superseded, see [Reconciliation](#reconciliation--2026-09-25t0240z-at-bcfa6ed) items 1 and 3**: this is not a statement that the owner holds an account, and the "enabled modules" note below is wrong | `1c7e8e6` | `evidence/03-*` | Ship CR-1. ~~"Enabled modules" per licence is **not implemented** — product decision, not a defect.~~ → the field always existed and the gate is now implemented; provisioning and UI remain scope gaps. |
| Email delivery + password reset | **BLOCKED** — ⚠ **superseded, see [After the merge](#after-the-merge--email-recovery-now-works)**: now **PASS** for the software, **BLOCKED** only for real-provider delivery | `1c7e8e6`; superseded by `98c11a2` | `evidence/04-*` | The capability is absent from this build (0 occurrences in the shipped bundle). A complete implementation sits on unmerged lane `x/accounts`. Merge decision is the owner's; then verify with authorized inbox access. |
| Tenant / store isolation | **PASS** — 58/58 probes, all **authenticated** and all pre-merge — ⚠ **superseded, see [Reconciliation](#reconciliation--2026-09-25t0240z-at-bcfa6ed) item 5**: the merged *unauthenticated* recovery paths were not covered by these, and are now covered separately | `1c7e8e6`; extended at `bcfa6ed` | `evidence/05-*`; `backend/tests/authTenantIsolation.test.js` | Inventory scope untestable here because inventory is not in this build. |
| Billing / payment / inventory / reporting | **PASS for what this build implements** — re-checked at `bcfa6ed`, still accurate | `1c7e8e6` | `evidence/06-*` | Three sub-checks are **NOT IN THIS BUILD** (recipe/modifier consumption, stock quantity/unit handling, restocking policy) — they live on unmerged lane `x/inventory`, confirmed **not an ancestor** of the candidate. Re-run after merge; see [Reconciliation](#reconciliation--2026-09-25t0240z-at-bcfa6ed) item 4. |
| Encrypted backup restore | **PASS** for schedule + restore (16/16); **BLOCKED** for decryption — ⚠ **superseded, see [Reconciliation](#reconciliation--2026-09-25t0240z-at-bcfa6ed) item 6**: the rehearsal round-trip is not evidence about the owner's actual archive, and closing decryption does not close recoverability | archive `pos-prod-20260923T211456Z` | `evidence/07-*` | One owner-run command closes the decryption half. Destination-side deletion protection is **NOT VERIFIED**. Key custody (CR-3) is the larger issue. |
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
| **CR-6** | *(added `bcfa6ed`)* `placementNames` resolves a branch or region by bare global id with no `companyId` filter. **Not a live leak** — the create path refuses a foreign branch with 404 before that code runs — so it is recorded rather than patched, there being no failing test to justify the change. Defence in depth for whoever edits that function next. |
| **CR-7** | *(added `bcfa6ed`)* The schema comment on `License.modules` — *"A module absent here is refused at the permission layer, not merely hidden"* — was a **false guarantee**: nothing read the column on any request path. Now true, via `requireAction`. Logged as a finding and not merely a fix, because a comment asserting a control that does not exist is worse than no comment: it reads as a thing already thought about. |

## Unfinished capabilities — explicitly not counted as passed

- **Email password recovery** — absent from this build (`x/accounts`, unmerged).
- **Inventory, recipes, modifiers, restocking** — absent from this build
  (`x/inventory`, unmerged).
- **Per-licence enabled modules** — ⚠ **this bullet was factually wrong; see
  [Reconciliation](#reconciliation--2026-09-25t0240z-at-bcfa6ed) item 3.**
  ~~no such concept exists … there is no per-module entitlement field anywhere~~
  — `License.modules` always existed and `licenseHasModule` always read it. What
  was missing was the *enforcement*, which is now implemented in `requireAction`.
  What remains unfinished: no route or script can set `modules`, and no screen
  hides an unlicensed module. The sentence below stands and is why the gate is
  not folded into `can()`: a permission decides what an employee may do inside a
  tenant that already has the feature; it cannot express "this customer did not
  buy KDS".
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

The lane then advanced once more and **`650be16` is also merged here**, at
**`5550e1b`** — a clean merge, no conflicts, suite re-run green. It changes no
product code; it fixes the till harness this merge broke, described at the foot
of this section. The browser journey below was run against `98c11a2` and has not
been re-run against `5550e1b`; the suite has.

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
| Regression suite, merged tree | **774/774 pass, 28/28 files, 0 skipped** at `98c11a2` (was 628/22); **785/785 in 29 files** at `5550e1b` |
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

### The staging stack now runs the merged tree

The journey above ran on its own throwaway stack. The **persistent** staging
stack was afterwards restarted onto the merged tree so the two agree, and was
re-checked at the edge `http://127.0.0.1:8120/`:

- it serves the merged bundle `index-TZS0KpMt.js`;
- `POST /api/auth/forgot-password` answers **`503 POS_MAIL_NOT_CONFIGURED`** —
  the fail-closed behaviour above, observed on the real stack rather than
  inferred from the source;
- a bad-credential login still answers `401 POS_UNAUTHENTICATED`, so the merged
  Prisma client and the `vcx_staging` schema agree.

Before the restart the stack was briefly **mixed** — the rebuilt bundle was
already being served by the edge while the backend still ran pre-merge code, and
that same endpoint answered `404`. Worth naming because a rebuilt frontend does
not restart the API, and the mismatch is invisible until a route is probed.

### One regression this merge introduced — since fixed upstream and taken

`deploy/e2e-workflow.mjs`, the till money-path harness, was blocked by the
merge. It seeded its staff from the temporary password `POST /api/users` used to
return, and by design that password no longer exists. The script refused with
the recipe for wiring a sink rather than failing deep in the money path — loud,
not silent.

The accounts lane fixed it seven minutes later (`650be16`, "Unblock the till
harness by giving its stack a mailbox, not a back door"): the harness now gets a
real local mail drop and seats its staff through the same emailed-code path a
real deployment uses, rather than through a bypass. That commit is **merged
here** and the suite re-run as its control — **785/785 in 29 files**, up from
774/28, the increase being the new `maildrop.test.js`.

**It still cannot be run on this host, for an unrelated and correct reason.**
`deploy/e2e-isolated.sh:19` refuses when `hostname` is `atc-noc`, because this
host runs production POS — confirmed, `pos-prod-frontend-1`, `pos-prod-backend-1`
and `pos-prod-postgres-1` are up here. The guard was not bypassed and the script
was not edited. The harness targets the `atc-pos-dev-db` Postgres on :5439,
which is a different product's dev stack from this lane's :5440. So the money
path stays evidenced by section 6's own run against `1c7e8e6`, and re-running it
through this harness needs a host that is not the production host.

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

## Reconciliation — 2026-09-25T02:40Z, at `bcfa6ed`

The owner read a 774-test copy of this document and asked for six specific
corrections. Each is below with what was actually measured. This section
supersedes the rows and bullets it names and nothing else; the pre-merge
evidence above is kept as written, because it is still the evidence for what it
describes.

### The candidate, and why the brief's numbers were stale

The brief named "tested code `5550e1b`, 785/785". That was two code-generations
behind by the time it was read:

| Commit | What it is | Suite |
|---|---|---|
| `5550e1b` | the tree the brief names | 785 / 29 files |
| `9779d28` | documentation only — code identical to `5550e1b` | — |
| `17058b9` | **real code change**: `accountRecovery.js` + `accountRecoveryOutage.test.js` | 790 / 30 files |
| `bcfa6ed` | documentation only — code identical to `17058b9` | — |
| working tree | `bcfa6ed` + this section's three source files and two test files | **815 / 32 files, exit 0, 207.97s** |

So the candidate is **`bcfa6ed`**, whose *code* is `17058b9`. Quoting `5550e1b`
would attribute to it an account-existence oracle fix it does not contain.

The 815 is the peer's 790 plus the 14 and 11 added below. It is the control for
the claim that a new entitlement check now sits on the path of **every**
permission-gated action and broke nothing: 32 files' worth of existing behaviour
is unchanged with the gate in place.

### 1. The provisioning software passes. The owner does not yet have access.

These are two claims and the row above ran them together. Separated:

- **The software is tested.** CR-1 made the operator identity configurable
  (`POS_SEED_ADMIN_EMAIL` / `POS_SEED_ADMIN_NAME`), and
  `scripts/bootstrap-platform-admin.mjs` is driven as a real subprocess, not
  mocked. That much is PASS and stays PASS.
- **No account exists under the owner's confirmed real address.** Nothing in
  this workstream created one, and it could not have.

The reason it could not is worth stating, because it makes items 1 and 2 one
blocker rather than two. `bootstrap-platform-admin.mjs` never chooses, prints,
stores or mails a password — it mints an invitation and the recipient chooses
their own password on the accept page. So it **refuses with exit 1 when mail is
not configured**, in its own words: *"A platform administrator who never receives
the link is not a partial success — it is an account nobody can sign in to."*

That refusal is correct and must not be worked around. Its consequence is that
**the owner's permanent admin access cannot be created until blocker 2 closes.**
Row "Real platform admin + customer provisioning — PASS" is true of the
software; it was never a statement about the owner holding an account.

### 2. Real-inbox delivery stays OPEN.

What was observed is a loopback SMTP sink on this host, plus
`deploy/accounts-journey.mjs` at 47/47 against a real SMTP conversation — with
that sink. A sink accepting a message proves the code composed one and handed it
off. It does not prove any of the things that actually fail in production:

- that a real provider accepts it (SPF / DKIM / DMARC alignment, sender
  reputation, and the fact that no mail provider is configured anywhere in the
  estate);
- that it lands in an inbox rather than a spam folder;
- that the 8-digit code survives an HTML-mangling client intact.

A provider's "accepted" response is not delivery either — the document already
says so under blocker 2 and that sentence stands. **This half stays OPEN until
an actual inbox is observed receiving a code that then works.** Test-mailbox
success does not close it, and the 47/47 must not be read as if it did.

### 3. Per-licence enabled modules — the record was wrong, and the gate is now real.

Two corrections, one of fact and one of substance.

**The record's claim is false.** "No such concept exists… there is no per-module
entitlement field anywhere" was wrong when it was written.
`License.modules String[] @default([])` was already in the schema and
`licenseHasModule` already read it. What was missing was never the field.

**What was missing was the enforcement**, and the schema's own comment promised
it: *"A module absent here is refused at the permission layer, not merely
hidden."* Nothing read `modules` on any request path, so that sentence was a
false guarantee — the worst kind of gap, because it reads as a control that has
been thought about.

Now implemented, in three files:

| File | Change |
|---|---|
| `src/lib/permissions.js` | `requiredModuleFor(action)` — maps an action key to its module via the existing `EXTENSION_POINTS` prefixes, or `null` for core POS |
| `src/lib/errors.js` | `moduleNotLicensed(module)` — 403 `POS_MODULE_NOT_LICENSED`, carrying the module in `details` so a screen can name it without parsing prose |
| `src/middleware/permissions.js` | `requireAction` checks the entitlement **after** the permission and **before** the route body |

Four design decisions worth naming, because each is a place this could have
been built wrong:

1. **After the permission, not before.** A refusal has to say the true reason.
   "You do not have permission" and "your subscription does not include this"
   send the owner to two different people.
2. **In `requireAction`, not in each module's router.** One gate on the path
   every action already takes cannot be forgotten by the next lane that mounts a
   router. Per-router gates can.
3. **Fails closed on a missing licence.** No licence is not "all modules". The
   empty default means core POS only, so every licence sold before that column
   existed keeps working and none silently acquires a module it never paid for.
4. **The prefix keeps its dot.** On a bare `inventory` a future
   `inventory_count.x` naming slip would match the wrong module and be gated by
   an entitlement its author never meant to require.

Coordination with the module lanes is by construction rather than by message:
`EXTENSION_POINTS` is their declared seam, and the gate is wired **before** any
of their action keys exist, so the first lane to add keys is enforced on arrival
instead of whenever somebody remembers. `backend/tests/licenseModuleGate.test.js`
is 14 tests and includes a deliberate tripwire asserting that **no** action key
currently maps to a module — it goes red the day a module lane merges, which is
the signal to delete it and check the licence fixtures.

Six negative controls, each reverted:

| # | Inversion | Result |
|---|---|---|
| NC-1 | fail open on a missing licence | the 2 fail-closed tests went red |
| NC-2 | gate removed | the 4 refusal tests went red |
| NC-3 | entitlement checked before permission | **green — the test was vacuous** |
| NC-4 | prefix without its dot | the dot-guard test went red |
| NC-5 | operator exemption removed | the operator test went red |
| NC-6 | a real module action key added | the tripwire fired, naming it |

NC-3 is the one worth recording. My own ordering test entitled the module and
withheld only the permission, so the entitlement check passed in either order
and the assertion held **against the inverted code**. It was rewritten so both
checks fail and the order alone decides the answer; the hole is documented in
the test file so it is not reintroduced. An assertion is not evidence until the
instrument is shown to register the thing it measures — and here it did not.

**The honest limits, which keep this an open scope gap rather than a closed
item:**

- **No action keys carry a module prefix today**, so the gate refuses nothing in
  practice. It is a guarantee made true in advance, not a capability delivered.
- **Nothing can set `modules`.** `licenseSchema` in
  `src/api/routes/atc.js:172` accepts plan, dates, branch limit and notes — and
  no `modules`. No route, script or seed writes the column. Entitling a customer
  to a module today means editing the licence row by hand.
- **The gate is backend-only.** No screen hides an unlicensed module, so a
  customer without one would see controls that answer 403.

Which of those to build is a product decision — which plans include which
modules — not a defect. It is tracked here as the explicit scope gap the owner
asked for.

### 4. Inventory is still not integrated.

Measured, not assumed: `git merge-base --is-ancestor x/inventory HEAD` reports
**not an ancestor**. There is no integrated revision.

So **billing → stock consumption → reports cannot be verified**, and the reason
is not that the check was skipped: the tree to run it against does not exist.
Row "Billing / payment / inventory / reporting" stands exactly as written,
including the three sub-checks marked NOT IN THIS BUILD. Nothing has become
possible since.

The lane is active, not abandoned — its suite was observed running in its own
worktree at 02:31Z while this reconciliation was being written. The merge
remains the owner's decision, and this document should not be read as asking for
it.

### 5. Isolation — which checks actually cover the merged authentication code.

The record says "Tenant / store isolation — **PASS**, 58/58 probes". Both
numbers are real. Neither is about the code the merge brought in, for one
structural reason:

**Every one of the 58 probes was authenticated, and all of them predate the
merge** (`1c7e8e6`). An authenticated endpoint's isolation rests on the
`companyId` in the session. An *unauthenticated* endpoint has no session, so its
isolation rests entirely on what the submitted token or address is bound to —
a different mechanism, which the 58 could not have tested and did not.

Coverage after checking each suite:

| Path | Covered before? | By what |
|---|---|---|
| Invitation accept / lookup | **Yes** | `invitations.test.js` is genuinely two-tenant: a foreign store 404s on create, a foreign invitation is indistinguishable, listing is own-tenant only, and the accepted user's company and every assignment are asserted |
| Password recovery (request / verify / reset) | **No** | `accountRecovery.test.js` is effectively single-tenant. Its extra companies test *eligibility*, and its "refuses another account's code" pits two users who are **both inside company A** |

The gap is now closed by **`backend/tests/authTenantIsolation.test.js`** — 11
tests across two active tenants, asserting that a recovery code is bound to one
account in one tenant, that a reset authorization moves exactly one password,
that the request endpoint is not a tenant oracle, that one address belongs to at
most one tenant, and that the invitation and reset token namespaces do not
cross.

Two assertions in it are deliberately stricter than they look. The other
tenant's password hash is compared **byte for byte**, because a rehash of the
same plaintext would pass a login check and still mean the reset had reached
into the wrong tenant's row. And the three public answers — tenant A, tenant B,
an unregistered address — are compared as whole bodies, because a leak here is
a difference, not a message.

Five negative controls, each reverted:

| # | Inversion | What it proved |
|---|---|---|
| NC-A | challenge lookup unscoped from the user | **handed out a real, usable reset token for the wrong tenant's account** |
| NC-B | session revocation made global | the surviving-session assertion caught it |
| NC-C | account taken from the request body | the ignored-extra-fields tests caught it |
| NC-D | tenant name added to the public answer | the byte-identical-bodies test caught it |
| NC-E | eligibility re-check dropped at reset | the suspended-mid-flight test caught it |

One finding raised and **not** fixed: `placementNames` resolves a branch or
region by bare global id with no `companyId` filter. It is not a live leak — the
create path refuses a foreign branch with 404 before that code is reached — so
patching it would be a change with no failing test behind it. Recorded as
defence in depth, for whoever touches that function next.

### 6. Restore rehearsal is not decryption of the owner's archive.

The record's row runs three separate claims together. Split:

| Claim | Status |
|---|---|
| Schedule and restore *mechanism* | **PASS**, 16/16 — proven against a dump this host made |
| Encryption round-trip with a **rehearsal** key | a different artifact, and not evidence for the line below |
| Decryption of the **actual owner-encrypted off-site archive** | **NOT DONE** |

The third cannot be attempted here at all: a search of this host for `*.gpg`
finds **no local ciphertext**. The recipient key
`2B64FAF2AD2F917F2E2185F60F05CA51AEC13029` is present with its secret half, RSA
4096, passphrase-protected — which is itself finding CR-3.

And CR-3 has been restated by the backup workstream in a way that changes what
closing this would mean. The backup secret key lives **on the backup host**,
where `docs/BACKUP-RESTORE.md` says it must not. So the question the owner
actually cares about — *can we recover if this box dies?* — answers **no today,
whatever the decryption test returns.** Closing the decryption half closes the
decryption half. It does not close recoverability.

One practical note: `owner-verify-backup-decrypt.sh` has changed since the
evidence above described it (3981 → 5574 bytes, 02:08Z). Read the script, not
this document's summary of it, before running it.

### Verdict

**Unchanged: NOT READY for owner acceptance**, on the same three blockers.
What changed is that two rows are now honest about what they cover, one false
guarantee in the schema has been made true, and the isolation claim has evidence
for the code the merge brought in.

**This section is about cloud readiness only.** A green 815 is not evidence that
inventory, payments, providers or physical printing are done — the first is not
merged, and the last has never been observed on paper. Nothing here supports
labelling the portal complete.

## Owner inputs still needed — the consolidated list

Everything that could be done without the owner has been done. What is left is
exactly three inputs, and each one unblocks a specific claim. The procedures
themselves are already written and reviewed by the backup/accounts workstream —
`evidence/02-public-access-changeset-PROPOSED.md`,
`evidence/04b-mail-provider-owner-procedure.md`,
`evidence/07b-recovery-owner-procedure.md` — and **none is applied**. This list
does not duplicate them; it names the decisions and values only the owner holds.

### Input 1 — a public staging hostname

| | |
|---|---|
| **Needed** | One hostname the owner approves for staging, e.g. `staging-pos.<domain>`, and confirmation that its DNS A record may point at this host's public IP |
| **Unblocks** | Blocker 1 — every claim about reaching the portal over the internet, and HTTPS end to end |
| **Procedure** | `evidence/02-public-access-changeset-PROPOSED.md` |
| ⚠ **Trap** | The staging certificate must be a **separate `certbot certonly`** issuance. It must **never** be an `--expand` of the production certificate, which covers only `atcworkspace.com` and `www` — an `--expand` would rewrite a certificate that currently serves production |

### Input 2 — a real mail provider

| | |
|---|---|
| **Needed** | SMTP host, port, username, password, and the `From` address to send as. Plus **authorized access to one real inbox** to observe a delivered code — or the owner's explicit confirmation that a code arrived and worked |
| **Unblocks** | Blocker 2's remaining half (item 2 above), **and item 1** — the owner's own permanent admin account cannot be created until mail works, because `bootstrap-platform-admin.mjs` correctly refuses to mint an administrator it cannot send an invitation to |
| **Procedure** | `evidence/04b-mail-provider-owner-procedure.md` |
| ⚠ **Trap** | `/home/atc-noc/atc-pos/.env` is mode **664** today. `chmod 600` it **before** an `SMTP_PASSWORD` goes in, or the credential lands world-readable |
| **Then also needed** | The owner's confirmed real email address, to pass as `POS_SEED_ADMIN_EMAIL`. Ask for it at that point — not before, since the script would refuse anyway |

### Input 3 — decryption access

| | |
|---|---|
| **Needed** | The passphrase for key `0F05CA51AEC13029`, entered **by the owner** on a host of their choosing — not supplied to this workstream — and the `RESULT:` line sent back. Plus a decision on where the backup secret key should actually live |
| **Unblocks** | Blocker 3, the decryption half only |
| **Procedure** | `evidence/07b-recovery-owner-procedure.md`; re-read `owner-verify-backup-decrypt.sh` first, it changed at 02:08Z |
| ⚠ **Do not read it as more than it is** | Per CR-3, the backup secret key is on the backup host, where `docs/BACKUP-RESTORE.md` says it must not be. **"Can we recover if this box dies" answers no until custody is fixed**, whatever this test returns. The custody decision is the larger of the two and is also the owner's |

### Not owner inputs, tracked separately

These are decisions but not blockers, and none of them is waiting on a value:

- **Merge `x/inventory`?** Until then, billing → stock → reports stays unverified
  (item 4). Owner's call; this document does not ask for it.
- **Which plans include which modules**, whether a route should set
  `License.modules`, and whether the UI should hide an unlicensed module
  (item 3). Product decisions; the enforcement they would rely on now exists.
- **Physical printing** stays NOT TESTED until paper is observed. No input closes
  this — it needs hardware.
