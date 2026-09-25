# VEXO Connect v1.1 — release and handover checklist (go / no-go)

The single sign-off sheet for the 72-hour sprint. It **references** the
authoritative documents rather than repeating them:
`docs/CLIENT-HANDOVER-SCOPE.md` (scope, owners, blockers — owned by the Core
session) and `docs/RELEASE-V1.1-RC.md` (the deployment procedure). If this
sheet and either of those disagree, they win and this sheet is stale.

As of 2026-09-23. Feature freeze ≈ 2026-09-25 14:00 UTC — no new modules, no
code changes to verified areas; documentation only after the freeze.

## Three tiers of "verified" — never report a line above its tier

| Tier | Means | Holds today |
|---|---|---|
| **RC-verified** | Proven on the lab against the merged candidate, fresh databases | Every Included row below |
| **Deployed-verified** | Proven on production after the deployment owner deploys RC-1 | **Nothing.** Production runs v1.0.1. |
| **Hardware-verified** | Observed on physical devices — paper out of a real printer | **The printer and its driver only** (owner photos, 2026-09-25): DCode DC RP30 self-test, and a Windows test page through `POS-80C` on `USB001`. **No VEXO output on paper** — see §Physical printer. |

## The candidate

| | |
|---|---|
| Branch | `sprint/client-handover-rc` — lab `vexo-lab`, `~/atc-pos` |
| **Code-final** | **`114ffc9`** (`114ffc9d592022132579d4264b87048f1778bfd8`). Everything after it is `docs/` only — check with `git diff --name-only 114ffc9 HEAD`. Moved on 2026-09-23 from `a1e5228`, whose only code successor is a one-line day-close fix in `frontend/src/pages/DayClose.jsx`. |
| Tip at time of writing | `5659243` (docs). The **release-final sha is stamped at the freeze**, after the last documentation commits land; it is not known yet and is not invented here. |
| Package for the deployment owner | `/home/atc-noc/pos-rc-v1.1-rc1-20260923/` — bundle, `RELEASE-V1.1-RC.md`, `CLIENT-HANDOVER-SCOPE.md`, README, `SHA256SUMS` (**re-verified OK 2026-09-23**) |
| Migrations | 13 (v1.0.1 has 12). New: `20260923160000_refund_method` — one nullable column, rollback proven 8/8 |

## Go / no-go

| # | Item | Tier reached | Status |
|---|---|---|---|
| 1 | Core flows — orders, billing, payments, retry-safety, refunds, reports, day close, isolation | RC-verified | ✅ suite 384/384; e2e 52/52 |
| 2 | **Discount policy** — see §Discount close-out | RC-verified | ✅ **CLOSED** |
| 3 | Core defects found this sprint: day-close cash refunds (`5f8ef01`), zero-ceiling grant (`20c6904`), and a saved day close reported as "Could not file the closing" (`114ffc9`; also live in deployed v1.0.1 since `2c3acb1`) | RC-verified; `114ffc9` found and re-checked by Window 1's browser run on an RC-1-built stack | ✅ fixed, each moved a check FAIL → PASS |
| 4 | **VC-101 customer display** — see §VC-101 evidence | RC-verified (HTTP, lab) + browser-verified 17/17 on exercised-path-identical code (original box) | ✅ **INCLUDED, owner-accepted; browser evidence ACCEPTED by the owner** 2026-09-23 (atc-noc dev stack, not a lab run, not full RC browser acceptance); one display per counter |
| 5 | Physical receipt / KOT print | Browser-verified, **plus** hardware/driver hardware-verified (owner photos 2026-09-25) | ⏳ **STILL PENDING.** Run-book row 8 (hardware + Windows driver path) is **VERIFIED**; rows 1–7 and 9–11 — VEXO's own receipt, KOT and reprint on paper — are untested. A printer that self-tests proves the unit, not our output. `docs/PRINTER-UAT-RUNBOOK.md` |
| 6 | Off-host encrypted backup | Scheduling and restore **re-measured 2026-09-24** — see §Off-host backup, which supersedes the `9ff94ac` bullets | 🟨 **Partly done** — installed, running, restore proven 16/16; **decryption still unproven** and destination-side deletion protection not verified |
| 7 | Client onboarding (menu, stores, staff) | — | ⛔ **Blocked** — client data pack not supplied (B2) |
| 8 | Reconcile against Product Master Specification v1.1 | — | ⛔ **Blocked** — document not held by anyone (B1) |
| 9 | RC-1 in production | — | ⏸ **Owner decision**, then the deployment owner (B3) |
| 10 | **Cloud readiness** — public HTTPS, real platform admin, email recovery, isolation, flow, backup restore | Staging-verified on `atc-noc` against `x/cloud-readiness` @ `5550e1b` — **a different candidate from this sheet's `114ffc9`**. Superseded 2026-09-24T19:20Z; the `1c7e8e6` reading is kept in §Cloud readiness below | ⛔ **NOT READY** — 3 blockers: no approved public staging hostname; **no mail provider configured anywhere in the estate** (the recovery feature itself now passes); archive decryption unproven. See `docs/CLOUD-READINESS-VERIFICATION.md` |

**Release is GO at the RC tier** for rows 1–4. Rows 5–10 do not block the
candidate; they block specific claims — printing on paper, a backup that
survives the host, real client data, anything on production, and reaching the
product over the internet.

Row 10 is scored against a **different tree** from the rest of this sheet and
is not comparable to rows 1–4. It is recorded here because cloud readiness is a
release gate the sheet otherwise has no row for, not because the two candidates
have been reconciled — they have not.

## Cloud readiness — row 10 after the accounts merge

Recorded 2026-09-24T19:20Z. This **supersedes the `1c7e8e6` reading of row 10**
on the email blocker only; the other two blockers are unchanged and the earlier
reading stays in `docs/CLOUD-READINESS-VERIFICATION.md` because the verdict
moved, not because it was wrong.

The owner directed `x/accounts` to be merged. It was — `x/cloud-readiness` is
now `5550e1b`: `8482de9` (everything rows above describe) merged with
`x/accounts` @ `6ceab72`, then with its next commit `650be16`. The first merge
did **not** go cleanly; four files conflicted and were resolved by hand. The
second was clean.

- **Email password recovery: the software half is PASS**, staging-verified.
  Regression suite on the merged tree **785/785 in 29 files** (up from 628/22),
  and the lane's own browser harness `deploy/accounts-journey.mjs` is **47/47,
  0 failures** — headless Chromium against the real built bundle
  (`index-TZS0KpMt.js`) over HTTP, reading every recovery code out of a real
  SMTP conversation rather than fabricating one. Code delivery, code validity,
  single-use, expiry, resend and attempt limits, session revocation, address
  non-disclosure, and "reset alters no role, tenant, licence or MFA" all hold.
- **Real-provider inbox delivery: still BLOCKED, and now measured rather than
  assumed.** Every message in every run went to a loopback SMTP sink that
  relays nothing. A read-only search across the whole estate finds **no live
  `SMTP_HOST` / `MAIL_HOST` / `EMAIL_HOST` assignment in any real env file** —
  every hit is a `.env.example` or a deployment document. No values were read.
  So this is an owner input, not a code defect; the code fails **closed**
  (`503 POS_MAIL_NOT_CONFIGURED`) rather than pretending. Closing it is
  `docs/ACCOUNTS-GO-LIVE.md` §1, and the credentials must not be pasted into
  chat.
- **The merged `schema.prisma` was verified to be a union, not a pick** —
  all 100 models and enums from both sides present, every single-side model
  byte-identical to its origin, and for the 17 models both lanes touched no
  semantic line dropped from either side. This is the control on the hand
  resolutions; the 774-test run is the second.
- **One regression this merge introduced — fixed upstream and taken.**
  `deploy/e2e-workflow.mjs`, the till money-path harness, was blocked: it seeded
  its staff from the temporary password `POST /api/users` used to return, and by
  design that password no longer exists anywhere. The accounts lane fixed it
  seven minutes later (`650be16`) by giving the harness a real local mail drop,
  so it now seats staff through the same emailed-code path a real deployment
  uses. That commit is merged here at **`5550e1b`**, suite re-run **785/785 in
  29 files**. It still **cannot be run on `atc-noc`**: `deploy/e2e-isolated.sh`
  refuses on this hostname because production POS runs here, and that guard was
  not bypassed. Row 1's evidence did not run through that harness and is
  unaffected.

**Tier note:** this is staging-verified on `atc-noc` against a merged
cloud-readiness tree. It is **not** RC-verified — none of it ran on the lab or
against `114ffc9`, and the two candidates are still unreconciled.

### Row 10 continued — 2026-09-25T02:15Z, at `17058b9`

Suite is now **790/790 in 30 files**, up from 785/29. The extra file is a fix,
not a feature.

- **An account-existence oracle was found in the recovery route and closed
  (`17058b9`).** `POST /auth/forgot-password` answered an unregistered address
  `200` *before attempting any send*, but let an SMTP failure for a registered
  address escape as a `500`. So the address non-disclosure recorded as PASS
  above was **conditional on the mail provider being healthy** — and it broke
  precisely during a misconfiguration or an outage, which is both the state the
  estate is in right now and the state it will pass through when the owner
  first configures a provider. Anyone could read account membership off the
  status code. All delivery failures now answer identically and the operator is
  told through the log; `ChallengeThrottled` still surfaces deliberately.
  `accountRecoveryOutage.test.js` holds it against a real `ECONNREFUSED` rather
  than a mock, with positive controls that the send was genuinely attempted and
  that the registered path reached it. Reverting the fix turns 3 of its 5 tests
  red — verified, not assumed.
- **All three remaining blockers now have prepared, reviewed procedures** —
  `evidence/02-public-access-changeset-PROPOSED.md`,
  `evidence/04b-mail-provider-owner-procedure.md`,
  `evidence/07b-recovery-owner-procedure.md`. Each is NOT APPLIED and names the
  one owner input it needs. Two traps worth pulling up into this ledger: the
  staging TLS cert must be a **separate** `certbot certonly` and never an
  `--expand` of the production cert (which covers only `atcworkspace.com` and
  `www`, no wildcard, and which production HTTPS depends on); and
  `/home/atc-noc/atc-pos/.env` is currently mode **664**, so it must be
  `chmod 600` *before* an `SMTP_PASSWORD` is written into it.
- **CR-3 is more serious than "a finding".** The backup **secret** key
  `0F05CA51AEC13029` is in the `atc-noc` keyring — on the backup host, which is
  where `docs/BACKUP-RESTORE.md` explicitly says it must not be ("not this
  server"). The off-host archives exist to survive losing atc-noc; whoever
  reaches atc-noc gets both the key and, via the shipping SSH key, write access
  to the off-host copies. Until the key is held somewhere else, "can the owner
  recover if this box dies?" is **no**, independently of whether the decryption
  test passes. Nothing was moved — key material is the owner's to relocate.
- **The till harness stays NOT RUN on this host,** and no compatible host
  exists. `deploy/e2e-isolated.sh:19` refuses on `atc-noc` because production
  POS genuinely runs here; the only other reachable machines are vexo-lab
  (excluded by the brief), a reassigned laptop, and the owner's workstation.
  The guard was not bypassed and the script was not edited. Section 6's
  money-path evidence continues to rest on its earlier run against `1c7e8e6`.

**Scope note, because a green suite invites over-reading.** Everything in row 10
is about *cloud readiness*: public reachability, real mail, recoverable
backups, and the accounts paths around them. It is **not** evidence that
inventory, payments, provider integrations or hardware are complete — physical
printing in particular stays NOT TESTED until observed paper output exists, and
payment work remains on sandbox/manual methods. Production activation stays
subject to the established deployment approval.

### Encrypted off-host recovery — BLOCKED → **PASS**, 2026-09-25T03:57:11Z

The owner ran `owner-verify-backup-decrypt.sh`. It fetched
`pos-prod-20260924T211406Z.tar.gpg` from the off-host destination, matched its
sha256 against the shipping receipt, decrypted it with the backup key, and
confirmed the dump inside hashes to the `dumpSha256` its manifest recorded —
`45cc0768…2638e33d`, the same value computed from the plaintext dump on this
host beforehand. Logged in `.owner-verify.log`; full output and analysis in
`evidence/07b-recovery-owner-procedure.md`.

**This closes the third of row 10's three blockers.** Remaining: no approved
public staging hostname, and no mail provider configured.

Worth recording about *how* it passed, because both nearly made it fail for the
wrong reason:

- The script originally named the 2026-09-23 archive and the hash from a
  receipt the nightly run had since overwritten. It compares against that
  receipt **before** decrypting, so it would have aborted with a hash mismatch
  having never invoked `gpg` — reported as a recovery failure when nothing was
  wrong with the backups. Re-pointing it to a fully corroborated archive was
  the difference between a real answer and a bookkeeping one.
- The run's first line was `no local copy; fetching from atc@20.20.20.57`. The
  "prefer a local copy" branch is dead — shipping removes the archive, leaving
  only the plaintext dump — so every run pulls over SSH. That leg had no
  rehearsal behind it, since this session was scoped out of vexo-lab. It worked,
  which also independently confirms the off-host copy and the shipping path are
  real rather than just logged.

Preservation, checked after the run: 24 files still in `~/atc-backups/pos-prod/`,
secret key still in the keyring, and the `mktemp -d` removed by its `EXIT` trap,
so no decrypted production dump was left on disk. No secret appeared in the
output.

**CR-3 is NOT resolved by this and must not be read as resolved.** The run used
the backup key *on the backup host*. It proves the archives and the passphrase
are sound; it says nothing about recovering after losing `atc-noc`, which is the
scenario off-host copies exist for. While `0F05CA51AEC13029` lives only in the
`atc-noc` keyring — where `docs/BACKUP-RESTORE.md` says it must not be — the
answer to "can the owner recover if this box dies?" is still **no**. Two
different claims; one is now closed and one is open.

## VC-101 evidence — with provenance

- **HTTP behaviour, RC-verified on the lab**: Window 1's harness, written
  outside the author's suite — DSP-1..8 and ISO-9 in 52/52 — plus the
  author's 13/13 inside 384/384.
- **Browser behaviour — pairing, cart updates, payment completion,
  sign-out: 8/8 in real Chromium**, two isolated browser contexts (till and
  display), `tests/e2e/walk-display.cjs`; screenshots d-01..d-09 in
  `~/vexo-connect-dev/.devlogs/vc101-shots/`. It ran on the **original-box
  dev stack, not on the lab**, and it tests **RC-1's VC-101 code exactly**:
  all eight VC-101 files (`display.js`, `displayAuth.js`, `displayState.js`,
  `CustomerDisplay.jsx`, `PairDisplay.jsx`, `displayClient.js`, `Sell.jsx`,
  `App.jsx`) are byte-identical (sha256) to the RC, and the only RC change
  to a file the display reads, `lib/orders.js`, is refund-only
  (`publicRefund.method` plus two new helpers) — fields the display
  allowlist never serves.
- **Why not on the lab**: attempted 2026-09-23 through an SSH tunnel and
  failed 0/8 — **not a product defect**. The lab backend's `CORS_ORIGIN` is
  pinned to exactly `http://localhost:5177`; Vite forwards the browser's
  Origin (`changeOrigin: false`), so a tunnel on any other local port is
  refused as CORS (a 500 in the lab log at `app.js:62`). Local port 5177 on
  the original box is held by another session's sandbox, and the lab has no
  browser tooling. Direct and proxied logins on the lab both answered 200.
  Getting a browser run *on the lab* needs either that port freed or the
  lab CORS widened — both outside this session's ownership during the freeze.
- **VC-101 browser evidence ACCEPTED by the owner (2026-09-23): 17/17 on the
  atc-noc isolated dev stack** (`~/vexo-connect-dev`, :5350/:5351, 12
  migrations), source `1d5407b`, exercised paths byte-identical to RC-1. It is
  **not a lab run and not full RC browser acceptance**; the untested display
  behaviours below stay listed as limitations. Run by session
  `7565dff8`: Run A at 15:36Z, `tests/e2e/walk-display.cjs` unmodified, 8/8;
  Run B at 15:38Z, `walk-display-qty-partial.cjs`, 9/9 — a quantity update
  re-priced on till and display, a part payment asks for the balance and does
  not thank the customer, settlement, sign-out revocation. **Environment: the
  original box `atc-noc` (20.20.20.55), isolated dev stack `~/vexo-connect-dev`
  — API 127.0.0.1:5350, Vite 127.0.0.1:5351, Postgres 5440 — not the lab,**
  whatever its evidence folder is called. **Source:
  `sprint/vc101-customer-display` @ `1d5407b`**, tree clean; its code is
  identical to `5ac675a` (every later commit is docs). Corroborated from
  machine records rather than the report: the runner scripts
  (`POS_E2E_BASE=http://127.0.0.1:5351`, sourcing `~/vexo-connect-dev/.env`);
  this box's backend log (HeadlessChrome, host `127.0.0.1:5351`, zero 5xx,
  logout 200 → display 401 within 4 s in both runs); and dev orders
  `BSC-CP/26-27/00002` (₹283.50) and `00003` (Cappuccino ×2, ₹378.00, paid
  ₹189.00 + ₹189.00). **Coverage of RC-1 `7faa9d6`:** every code path the 17
  steps executed is byte-identical to the RC. The display files, `Sell.jsx`
  and `App.jsx` match. Every RC change to `routes/orders.js` sits in the
  refunds route, the gateway-reconcile select or an import — none in the
  create, items, quantity, bill or payments handlers the runs used — and the
  `lib/orders.js` changes are refund-only. Evidence: package folder
  `vc101-browser-evidence-atc-noc-dev/` (renamed from `lab-browser-evidence/`,
  because the old name was itself a lab label; the report inside is unchanged
  and pinned in `SHA256SUMS`).
- **Still not verified in a browser** — these stay listed as limitations: (a) no browser has driven the *customer display* on a stack *built from*
  RC-1, with migration 13 applied and the RC's Prisma client (the tested
  tree has 12 migrations, RC-1 has 13). Window 1's browser run on an
  RC-1-built stack covered refund and day close, not the display; (b)
  nothing ran on the lab dev host itself (F-9: the lab accepts only
  `http://localhost:5177`); (c) the RC-only screens — the refund dialog's
  "Returned as" and the cash-only day close — are Core's gate: Window 1
  reports 10/10 in a browser on an RC-1-built stack after `114ffc9`, which
  is not re-verified here; (d) display behaviour outside the
  gate's four areas is HTTP- or design-level only: a discount line on the
  display, void → idle, the "Reconnecting…" strip on network loss, and idle
  after a backend restart; (e) two displays on one station is out of scope
  (F-8).

**Deployment scope: ONE customer display per counter.** Two displays on one
station mirror the same bill, but only the first to poll after payment
shows the thank-you (F-8, documented; no data exposure).

**Drop path, if ever needed:** `git revert ae98beb`, then
`git revert -m 1 629461b` — executed on the lab, 371/371 and 43/43, Core untouched.

## Discount close-out — exact result

- **Author-side focused run on the lab RC** (tip `5659243`, migrations 13/13,
  `atc_pos_test`, coordinated with Window 1 so the shared test database was
  not truncated mid-run): **98/98** — `discounts` 50/50, `discountSettings`
  31/31 including the new zero-ceiling case, `discountConcurrency` 5/5,
  `approvalSecrecy` 12/12 (vitest 2.1.9, 15.2 s). These four files contain
  the changed code (`20c6904`); this was not a rerun of unchanged suites.
- **Window 1, after `20c6904`, at `a1e5228` on a fresh database**: POL-1..4,
  DISC-1..8, ISO-2 all green.
- **What `20c6904` enforces**: a discount permission (line/order) or an
  approval authority is refused **at save (HTTP 400)** when its resolved
  ceiling is zero on **either** side — percent or rupee. Before, only a
  both-zero grant was refused, so "allowed, up to 0%" and "10% or ₹0" saved
  with 200 and then denied every discount at the till. Resolution at the
  till is unchanged.
- **Open but not defects**: F-4, where a company default also narrows the
  owner (by design; now in `docs/QUICK-GUIDE.md`); and known limitation 9,
  where the approval-failure throttle is in-memory per process.
- **Verdict: discount-policy verification CLOSED at the RC tier.**

## Off-host backup — Window 2's status (read from its own record)

No live session reports as Window 2. This comes from its work product,
`~/vexo-connect-ops`, branch `ops/offhost-backup-readiness` @ `33ee8c2`,
`docs/OPS-HANDOVER.md` §4:

- Nightly dump: timer enabled and active, 02:30 IST, last run succeeded,
  14-day retention.
- **Off-host restore drill: VERIFIED 2026-09-23** on the real production
  dump — pg_restore exited 0, 23 tables and 586 rows match, the payment
  total matches to the paisa (₹4 467.52). Two negative controls prove it
  detects a broken dump and a falsified manifest.
- **Permanent encrypted off-host copy: NOT DONE.** The tooling passes 14/14
  with a *throwaway* key only. `offhost-backup.sh` exits 3 (MISSING INPUT)
  until the owner supplies a **GPG public key**. The candidate destination
  (the lab) is on the same /24, so it is not confirmed off-site.
- Not in RC-1 and not a build input.

**Current record — Window 2, `docs/OPS-HANDOVER.md` §0 @ `9ff94ac`.** It
supersedes the bullets above, which reflect `33ee8c2`:

- **Retained encrypted copy: EXISTS — NOT COMPLIANT.** One copy on vexo-lab,
  shipped 15:04:27Z by another backup session, intact (sha256 `52335566…`),
  but encrypted to key `…0F05CA51AEC13029`, whose **unprotected private half
  is on the POS host**. It is also stored under an unrestricted login, so it
  is not append-only. It must be re-sent after the owner supplies a new key.
- **Scheduling: prepared, NOT installed — on purpose** until a real success.
- **Restore: rehearsed 21/21 with throwaway keys, not done for real** — a
  real restore needs the owner's Mac key.
- **Off-site separation: UNCONFIRMED** (same /24), and the destination is
  not append-only yet (it needs a dedicated account).
- **Root disk: URGENT — owner** (§7 P1). Read on `atc-noc` 2026-09-23: 88% of
  98 GB used.

A report by session `7565dff8`
(`vc101-browser-evidence-atc-noc-dev/LAB-BROWSER-EVIDENCE.md` §5) calls that copy "DONE". Window 2's own record does not, and Window 2's
record governs. Status and remediation stay with Window 2 and the owner.

**Re-measured on `atc-noc` 2026-09-24 by the cloud-readiness verification.**
This supersedes the `9ff94ac` bullets above on the points it names, and is
measurement on this host rather than a reading of another session's record.
Full working: `docs/CLOUD-READINESS-VERIFICATION.md` §Backup and recovery.

- **Scheduling: INSTALLED, enabled, active, and succeeding** — the "prepared,
  NOT installed" bullet is obsolete. Nightly with a randomized delay and
  `Persistent=true`; the last run exited 0 on both steps, 21 hours before the
  check. Nothing was reinstalled and no archive, key or revocation certificate
  was deleted. Local retention holds 11 archives.
- **Restore: DONE FOR REAL — 16/16.** A real production archive restored into a
  new isolated database and reconciled against *that archive's manifest*, not
  against live: 23/23 table counts, payment total to the paisa, migration state
  with none half-applied, staff password hashes, foreign keys, indexes, no
  orphaned payment. Two controls carry the weight: a truncated archive exits 1
  and leaves **0 tables** (`--exit-on-error`, without which `pg_restore` logs
  and exits 0), and the retained archive is byte-identical afterwards. So "not
  done for real" no longer holds; it needed no Mac key, because restore and
  decryption are separate questions.
- **Key custody: half the `9ff94ac` bullet is wrong.** The private half *is* on
  this host — that much stands, and it contradicts the shipping tool's own
  comment that "this host cannot do it". But it is **not unprotected**: it is
  passphrase-protected, proven without asking for the passphrase by offering an
  empty one and having it refused. One factor where the design claims two, not
  an open door.
- **Decryption: still UNPROVEN, and marked BLOCKED rather than inferred.** No
  encrypted archive exists on this host to open (the staging directory is
  cleared after each successful ship, correctly), and the encryption mechanism
  round-trips only under a *rehearsal* key — which proves the mechanism, not
  that archives encrypted to the owner's key can be opened. One reviewed,
  guarded owner-run command closes it; it is written, checked, and prints a
  single `RESULT:` line.
- **Off-site separation: UNCONFIRMED — confirmed still unconfirmed.** The
  destination is the lab box, so the only off-site copy of the POS production
  database lands on the estate's virtualization lab, one host serving as both
  lab and disaster-recovery target. Not verified from the destination side:
  this task was instructed not to use that host, so destination facts were read
  from local configuration and the sender's own receipts only.
- **Deletion protection: NOT VERIFIED, and unlikely.** The sender declines to
  prune, but that is voluntary, not enforced. The job authenticates with the
  operator's **general-purpose SSH key** while a dedicated key pair for exactly
  this job sits unused beside it — so anything that can SSH as the operator can
  delete the off-site archives. The control that would make retention
  enforceable is a `command="…",restrict` entry at the destination, which is
  out of scope here and is reported rather than made.
- **"The backups are encrypted" is true only of the off-site copy.** The
  retained local archives are plaintext dumps at mode 600 — reasonable, since
  the working copy has to be usable, but stated so the sentence is not read
  more broadly than it is true.
- **Root disk: still URGENT, and now worse.** Re-read **2026-09-25T06:03Z:
  94% of 98 GB — 5.7 GB free.** The 09-23 and 09-24 readings were both 88%
  (12 GB free), so this is the first movement, and it is in the wrong
  direction: **half the headroom is gone in a day.** The P1 does not merely
  stand, it has tightened.
  One volume backs `/`, `/tmp` and `/var/lib/docker`, and
  `pos-prod-postgres-1` lives on it — ENOSPC there crash-loops production
  databases. **A deploy that builds images consumes this same space**, so the
  figure is a go/no-go input and not just an estate-hygiene note.
  Non-destructive headroom exists if it is wanted: `docker system df` reports
  **2.755 GB reclaimable** across images and **679 MB** across volumes.
  Reclaiming is a deletion and therefore the owner's call, not a session's.

## Physical printer — Window 3's result

Window 3 is this session (ownership map in the scope document). **Partial
result, 2026-09-25.** The owner supplied physical photographs; the record
splits in two, and the split is the whole point of this section.

| | Evidence | Status |
|---|---|---|
| **The unit and the driver path** — run-book row 8 | Owner photographs: a DCode DC RP30 **self-test print**, and a **Windows test page** through the `POS-80C` driver on `USB001` | ✅ **hardware-verified** |
| **VEXO's own output** — run-book rows 1–7, 9–11: receipt, KOT, reprint | none | ⏳ **PENDING** |

**Why this does not close the item.** A self-test is generated by the
printer's own firmware and a Windows test page is generated by the driver —
neither passes through VEXO. They prove the unit takes paper, the ribbon/head
works, the USB path is live and the driver is installed correctly. They say
nothing about *our* column alignment, our wrap at the paper width, our cut
length, or the 9 px refund labels. Those are the failures the run-book exists
to catch, and none of them can be seen in these two photographs.

So printing still ships as "browser print, untested on paper" unless rows 1–7
and 9–11 are observed, exactly as before — what changed is that a *failure*
would now be attributable to our output rather than to the hardware, which is
worth having before anyone starts debugging.

**One check is seconds of work off the photograph already taken**, and it is
the only one here with a software consequence: count the characters per line on
the self-test. At **≤32 chars** the unit is 58 mm, not 80 mm — which is a code
change, not a setting. Nobody has read it off the image yet.

**Archival gap, stated rather than papered over.** I have **not seen the
photographs**; they are not on disk anywhere in this estate that I can find.
This row is recorded as **owner-attested**, not as something any session
inspected. If they are filed into the evidence set later, this section should
be re-read against them.

## Deployment-owner handoff

**Deployment owner: session `7565dff8`.** Ownership passed from `896234f0`
(which deployed v1.0.1) for post-deploy verification, per `DEPLOY-OWNER.md`
@ `6000b6c`. That file scopes the grant to *v1.0.1 post-deploy
verification*, so **the owner should confirm that `7565dff8` also takes the
v1.1 deploy** before anyone acts on it. One deployment owner at a time; no
other session deploys.

Nothing in this sprint has deployed. When the owner approves RC-1, the
deployment owner:

1. Verifies the package: `cd /home/atc-noc/pos-rc-v1.1-rc1-20260923 && sha256sum -c SHA256SUMS`.
2. Confirms code-final: `git diff --name-only 114ffc9 <release-final>` lists `docs/` only.
3. Follows `docs/RELEASE-V1.1-RC.md` §2 — tag `rollback-v101` images
   **before** building, take and verify the backup, and gate on **exactly one**
   unapplied migration (`20260923160000_refund_method`) — any other → STOP.
4. Keeps `.env` with `VITE_BASE_PATH=/pos/` and **no** `POS_GATEWAY_PROVIDER`
   (Razorpay stays off).
5. Decides VC-101 with the owner (owner-accepted; drop path above).
6. Records the result. Only then may any line move to **deployed-verified**.

**Not to be done by anyone in this sprint:** a production deploy without the
owner's go-ahead, enabling Razorpay, changing payment calculations, or
deleting demo financial records (bills 00009 and 00011 wait on the owner's
A/B choice, `docs/DEMO-DATA-CORRECTION.md`).
