# main moved: accounts/access landed. Two things will break your next run.

**From:** the `x/accounts` session
**Date:** 2026-09-24 ~20:10
**Pushed:** `github` `main` `7ab9cee..584de37` (merge commit `584de37`)
**To:** everyone, but especially whoever is mid-flight in this worktree

I did **not** touch this worktree. Nothing of yours was read, moved, staged or
reverted; the merge was made on a detached HEAD in my own lane and pushed from
there. The only thing I added here is this file.

**We have diverged, and you will need a merge rather than a pull.** When I
started you had `phoneOrders.js` and `phoneOrders.test.js` modified but
uncommitted; by the time I finished you had committed them as `dd15369`, which is
still unpushed. So your local `main` is `dd15369` (on `7ab9cee`) and the remote
is now `584de37`. Your push will be rejected, and that rejection is not a
problem — your commit is intact and nothing I did can have lost it.

The good news, checked rather than assumed: `git merge-tree 584de37 dd15369`
comes back **clean, no conflicts**. My merge does not touch `phoneOrders.js` at
all. So:

```
git fetch github && git merge github/main     # clean, per the above
```

Please **do not** rebase or force-push over `584de37` to tidy the graph — it is
a merge commit with 64 files behind it and it is what the accounts work's
verification is pinned to.

## 1. Run the migration before your next test run

`prisma/schema.prisma` moved: one new migration
(`20260924170000_accounts_access`), and six new **scalar** columns on models you
may already be using — `License.graceDays`, `License.modules`,
`License.maxTerminalsPerBranch`, `License.maxDevicesPerBranch`,
`PosUser.emailVerifiedAt`, `PosUser.pendingEmail`.

```
cd backend
npx prisma migrate deploy      # against YOUR test database
npx prisma generate
```

Skip this and the generated client and the database disagree, which surfaces as
failures in whatever file happens to run first — not as anything resembling a
migration error. The new columns are all nullable or defaulted, so existing rows
and existing fixtures are unaffected.

## 2. `POST /users` no longer returns a temporary password

This is the one likely to bite. It used to answer with a plaintext temporary
password, and anything that seated a user by reading that value out of the
response now gets nothing. Colleagues are hired by emailed code instead: the
invitation goes out, they set their own password.

If you have a fixture or script doing this, the replacement is
`backend/scripts/lib/maildrop.js` — `redeemEmailedCode({ dir, email, password, post })`
reads the code out of a capture folder and completes verify → reset for you.
`deploy/e2e-workflow.mjs` was converted this way and is the worked example;
`deploy/e2e-isolated.sh` shows the sink wiring (start the sink *before* the
backend — `config/env.js` decides its mail transport once, at load).

There is deliberately no test-only path that hands back a credential, so please
don't add one: a back door that exists for tests exists in production too.

## 3. `tests/globalSetup.js` gained a TRUNCATE

Your advisory lock is untouched and still does its job — I kept it and put my
change *after* it. Once the lock is held, the database is emptied
(`_prisma_migrations` excluded). That clears residue a **crashed** earlier run
leaves behind, which the per-file `wipe()` helpers have no statement for and
which shows up as RESTRICT foreign-key failures naming tables the failing file
never touched.

Order matters and is commented in the file: truncating before acquiring the lock
would be the very corruption the lock exists to prevent.

## Where it stands

818 backend tests across 29 files, green on the exact tree that is now `main`
(tree `14d8b24` — I checked the pushed tree hash against the tested one rather
than assuming). Migrations apply clean to an empty database and
`prisma migrate diff` reports no difference against `schema.prisma`.

**Not proven, and not claimed anywhere in the docs:** delivery through a real
mail provider. Every message so far has reached a local SMTP sink that relays
nothing. `docs/ACCOUNTS-GO-LIVE.md` §1 is the configuration step and it is the
owner's to make — the first real evidence will be the bootstrap invitation
arriving at the owner's mailbox. Please don't mark the accounts work as live
until that has happened.

## Update 2026-09-25: two more commits on the lane, and main is still yours

`x/accounts` is now `4eca256` (`9c43b4d..4eca256`, pushed). Two commits, both
small: the mail provider is pinned to a measured value, `.gitignore` now covers
`.env.*`, and two tests were added. 820 backend tests green, and
`deploy/accounts-journey.mjs` 46/46 on a fresh database.

**I have not touched `main`, deliberately.** The graph today:

```
github/main   584de37      (my merge, intact — still the remote tip)
main (yours)  dd15369      (local only, unpushed, diverged)
x/accounts    4eca256      (pushed)
```

`584de37` is not an ancestor of `4eca256` — the lane carries on from `9c43b4d`,
which `584de37` merged. So bringing these two commits to main is a merge, not a
fast-forward, and doing it while your `dd15369` is unpushed would have put a
third head in front of you. Re-checked today, not assumed:
`git merge-tree 584de37 dd15369` is still **clean, zero conflicts**.

So the order that costs you least: merge `github/main` into your `main`, push,
then merge `x/accounts`. Or tell me to do the second half and I will. Either way
`dd15369` is safe — nothing here has ever been in a position to lose it.

One thing worth knowing if you touch the accounts docs: MFA is **not** wired up.
The schema has `TotpCredential` and `MfaRecoveryCode` and `src/lib/totp.js` is
implemented and unit-tested, but nothing in `src/` imports any of it. The go-live
doc used to imply otherwise and no longer does.

---

## Update 2026-09-25 ~04:15: main moved again — and it was not me

Read this bit first, because the advice in my earlier updates is now **out of
date in one specific way**: I kept telling you to merge `github/main` at
`584de37`. That is no longer the tip.

```
github/main      ea04c07    <- moved. NOT my doing; see below
main (yours)     f874d4e    local only, unpushed, still diverged
x/accounts       97186b1    pushed (was 4eca256; four commits now ahead of main)
```

On revisions, so the evidence below is not misread: the **full suite was run on
`8519e11`**, and `97186b1` adds one **documentation-only** commit on top of it —
`git diff --name-only 8519e11 97186b1` is exactly `docs/ACCOUNTS-GO-LIVE.md` and
nothing else. So the 820-green result stands for the current tip, and I have not
re-run 820 tests to validate a markdown edit.

`ea04c07` was published from `x/w2-integration-close` (lane `…/w2-close`). It
**merged my `584de37`**, so the accounts merge is intact inside it — `584de37` and
`9c43b4d` are both still ancestors of `github/main`. Nobody force-pushed and
nothing was rewritten. I have still **not** merged to `main` myself, deliberately,
and I am not going to: you own that integration.

**Your `dd15369` is still safe**, and I checked rather than assuming:
`git merge-base --is-ancestor dd15369 f874d4e` → yes, so it is carried inside your
current local head. Neither `dd15369` nor `f874d4e` is an ancestor of `ea04c07`,
which just means your work is still unpushed — not that anything happened to it.

**Re-checked against the new tip, just now, not carried over from yesterday:**

```
git merge-tree ea04c07 f874d4e      -> 0 conflict markers
```

Clean. And the reason is concrete rather than lucky: the six `x/w2-integration-close`
commits touch `backend/src/api/routes/catalog.js`, three test files, two docs and
the `frontend/qa/` harness — **`phoneOrders.js` is not among them** (`git diff
--name-only 584de37 ea04c07 | grep -i phoneorders` is empty). So the advice
stands with one substitution:

```
git fetch github && git merge github/main     # ea04c07 now, not 584de37
```

Still please **do not** rebase or force-push over `ea04c07`.

## The reviewed Accounts delta that is *not* yet in main

This is the handover. Four commits, `9c43b4d..97186b1`, **7 files**, and it is
**documentation, tests and one code comment** — no runtime behaviour changes at
all:

| File | What changed | Runtime? |
|---|---|---|
| `docs/ACCOUNTS-GO-LIVE.md` | the bulk of it — corrections below | no |
| `.env.example` | added the 8 `SMTP_*`/`MAIL_*` variables, which the accounts lane introduced and never documented | no |
| `.gitignore` | `.env` → `.env` + `.env.*` + `!.env.example` | no |
| `backend/src/config/env.js` | **comment only** — one over-claim rewritten | **no** |
| `backend/scripts/verify-mail-delivery.mjs` | new, not imported by anything; run by hand | no |
| `backend/tests/accountRecovery.test.js` | +1 test | tests only |
| `backend/tests/platformAdmin.test.js` | +1 test | tests only |

**Zero file overlap** with everything `main` changed since `584de37` — checked with
`comm -12` over the two name lists, not by eye. So this should merge as cleanly as
the last one, whenever you or the w2 owner want it. **I am not merging it.** If you
would rather I did the merge once your own work is pushed, say so and I will.

**Verified on the exact pushed tree**, `8519e11`:

- **820 backend tests, 29 files, green**, exit 0. Working tree clean, and I
  confirmed no tracked file was modified during or after the run, so the run
  really does cover `8519e11` and not some intermediate state.
- Remote tree hash `7fefbfc35ef9a61f62e7c0062489d60e4c76f652` equals the local
  one — I compared the pushed tree rather than trusting that `git push` said OK.
- Secret sweep over the diff clean, **with a positive control** proving the grep
  fires on a planted `SMTP_PASSWORD=…` line. This repo is public.

## Why the doc changed so much: four claims of mine were wrong

If you have quoted the accounts mail documentation anywhere, these are the bits to
re-check. All four were *inference stated as fact*, which is my error, and all four
are now measured or explicitly marked unverified:

- **DMARC.** I wrote that a record with no `p=` is "invalid, and receivers that
  parse strictly ignore the whole record". RFC 9989 says the opposite about the
  first half: `p` is RECOMMENDED, not required, and a missing `p` in an otherwise
  valid record is *"treated as if it included `p=none`"*. The record is inert, but
  for a different reason — with no valid `p` **and** no `rua`, the receiver
  *"applies no DMARC processing to this message"*. Practical upshot: no policy is
  enforced **and** no aggregate reports are generated, so there is no feedback
  channel to debug delivery with.
- **Guaranteed rejection.** I wrote that a `@vexoconnect.com` message relayed
  through ATC's server is mail "the recipient never sees". RFC 7208 §8.4:
  *"disposition of SPF fail messages is a matter of local policy."* A fail is a
  signal, not an outcome.
- **This host's IP.** I argued from `103.168.211.243` not being SPF-authorised.
  Category error: when submitting through a smarthost, the IP a receiver evaluates
  is the **relay's**, not ours. Removed, not softened.
- **The SPF record itself is malformed.** Newly found: it is published as
  `" v=spf1 ip4:103.168.211.147 -all "` — with a **leading space**. Confirmed
  against `ns1`/`ns2.atcinfocom.in` directly as well as `8.8.8.8`, so it is in the
  zone and not a resolver artifact. RFC 7208 §4.5 discards records that do not
  begin with exactly `v=spf1`; read strictly, the domain has *no* SPF record and
  the `-all` never applies. Whether real implementations trim whitespace I did
  **not** test, so it is recorded as unknown rather than decided either way. It is
  a one-character DNS fix, it is **proposed for the owner**, and **no DNS record
  has been touched.**

Genuinely verified and worth keeping: the TLS certificate *does* validate for
`mail.vexoconnect.com` (CN is `www`, but the SAN covers it and `-verify_hostname`
returns 0), our client cannot be talked out of checking it, the envelope sender is
a bare address because `addrOf()` strips the display name, and reverse DNS is
forward-confirmed. Still **not** verified, and no longer implied anywhere: the
relay's egress IP, whether it DKIM-signs on submission, and whether the mailbox is
permitted to send as `no-reply@`.

## Three statuses, which I had been letting read as one

The go-live doc now keeps these apart, and the distinction is the point:

| | Status | State |
|---|---|---|
| A | Accounts software vs a **local SMTP sink** | **PASS** (820 tests, journey 46/46) |
| B | The **running staging stack** | **not established** — the cloud-readiness lane's |
| C | A **real mailbox** receiving an invitation/reset | **NOT DONE** — owner input |

Two things I want on the record because I previously implied otherwise:

- The 46-check journey is **isolated** — own database, own sink — so it **does not
  prove the staging 502 is fixed.** Staging's `/api/health` does now answer **200**,
  so that report is *stale*, but a health endpoint is not the accounts endpoints and
  is certainly not a mail configuration. I have left
  `PEER-NOTE-ACCOUNTS-ON-STAGING.md` in the `cloud-readiness` lane asking its owner
  for the check, since the only probe that would settle it writes rows in their
  environment.
- **"Recovery mints no session" is not MFA enforcement.** It is the narrower claim
  that recovery cannot *bypass* login. I checked the approved requirements rather
  than assuming: **nothing in `docs/` asks for MFA, 2FA or a second factor at all.**
  The `TotpCredential`/`MfaRecoveryCode`/`totp.js` scaffolding came from my own
  `ccf8423`, unrequested and imported nowhere. So there is no approved enforcement
  to finish, and I did not invent any.

One flag for the w2 owner, and it is a wording issue rather than a defect:
`docs/W2-INTEGRATION-CLOSE.md` says recovery "is wired" and cites
`src/lib/{totp,userAuthority}.js`. The recovery half is correct. `totp.js` is not
wired, and that citation could easily harden into "MFA is available" in a
readiness verdict. Worth a sentence there.

Lastly, a real gap that is *not* mine to close: **F-3** in
`docs/CLIENT-HANDOVER-SCOPE.md`. `requirePosAuth` reads `mustChangePassword` into
`req.user` (`middleware/auth.js:51`) and never gates on it, so the first-login
change is enforced by the browser alone. It is narrower than it reads, though — I
checked every writer, and **no current code path** pairs `mustChangePassword: true`
with a usable password (`users.js:213` and `users.js:363` both pair it with a hash
no string satisfies; `auth.js:205`, `invitations.js:191` and
`accountRecovery.js:256` set it false). So the exposure is rows predating the
accounts lane. It is marked "Open — owner decision", the fix touches every route,
and it belongs to the authentication owner — reported, not taken.
