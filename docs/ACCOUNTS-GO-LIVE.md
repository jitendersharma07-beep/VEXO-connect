# Accounts go-live: platform administration, onboarding, invitations, recovery

What an operator does to take this from "implemented and tested" to "a real
customer can be onboarded". Written to be followed in order, once.

Everything below is **implemented and verified against a local SMTP sink**. That
is one of three separate statuses, and §6 keeps them apart on purpose:

| | |
|---|---|
| **A** Accounts software, against a local SMTP sink | **PASS** |
| **B** The running staging stack | **not established here — the staging owner's** |
| **C** A real mailbox receiving an invitation or reset | **NOT DONE** — needs owner input |

A passing A is not B, and neither is C. No mailbox credential exists on the
deployment yet, so nothing has left this box for the internet. Step 1 is that
configuration, and nothing else here works until it is done — deliberately.

---

## 1. Configure the sender (outstanding owner input)

> Two things are outstanding, not one: the mailbox **credential** below, and
> **confirmation of the recipient**. `support@vexoconnect.com` is used throughout
> this document because an earlier report named it — which is not the same as the
> owner confirming it exists and that they can open it. Searched for and not
> found: any independent record of that confirmation. Treat it as a placeholder
> until the owner says otherwise.
>
> The domain's MX is real, but an MX proves a domain accepts mail, not that a
> particular mailbox exists or that anyone reads it. There is no probe that
> settles this from here, which is why it is on the owner's list.

The product refuses to invent a way around a missing mailbox. With `SMTP_HOST`
unset, `mailEnabled` is false and every path that must reach a person refuses
in the open:

| Path | Behaviour with no mail |
|---|---|
| `scripts/bootstrap-platform-admin.mjs` | refuses; will not create an administrator nobody can reach |
| `POST /api/users` | `503 POS_MAIL_NOT_CONFIGURED` |
| `POST /api/users/:id/reset-password` | `503 POS_MAIL_NOT_CONFIGURED` |
| `POST /api/invitations` | refuses |

Set these on the backend service — in the deployment's secret store, **not** in
a tracked file, and not by pasting the password into a chat or a terminal that
keeps scrollback:

```
SMTP_HOST=mail.vexoconnect.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USERNAME=<mailbox user>          # <-- OWNER INPUT
SMTP_PASSWORD=<mailbox password>      # <-- OWNER INPUT, never into a chat
MAIL_FROM=VEXO Connect <no-reply@vexoconnect.com>
APP_URL=https://<production host>/pos
```

**Why `mail.vexoconnect.com` specifically, and not ATC's mail server.** The table
below separates what was *measured* from what is *inferred*, because an earlier
revision of this section blurred the two and drew a conclusion the evidence does
not support. Measured 2026-09-25, each value re-read rather than remembered.

**Verified** — observed directly, and where DNS is involved, confirmed against
the authoritative nameserver (`ns1/ns2.atcinfocom.in`) as well as a public
resolver, so a caching resolver cannot be the source:

| Fact | Value |
|---|---|
| `vexoconnect.com` MX | `mail.vexoconnect.com` |
| `mail.vexoconnect.com` A | `103.168.211.147` |
| Reverse DNS for `103.168.211.147` | `mail.vexoconnect.com` — forward-confirmed, which receivers check |
| `vexoconnect.com` SPF | `" v=spf1 ip4:103.168.211.147 -all "` — note the leading space; see below |
| Port 587 greeting | `220 ns1.atcinfocom.in ESMTP Postfix` |
| Advertises | `STARTTLS`, `AUTH PLAIN LOGIN` — what `smtpClient.js` implements |
| TLS certificate | Let's Encrypt, CN `www.vexoconnect.com`, **SAN includes `mail.vexoconnect.com`**; `openssl -verify_hostname mail.vexoconnect.com` → `Verify return code: 0 (ok)`. Valid 2026-09-24 → 2026-12-23 |
| Certificate validation in our client | **Enforced.** `tlsOptions` defaults to `{}` (`smtpClient.js:110`) and `mailer.js` never overrides it, so `rejectUnauthorized` stays at Node's default `true`; `servername: host` is set on both TLS paths (lines 133, 195). No env var anywhere in `src/` can weaken it |
| Envelope sender | **Correct.** `MAIL FROM:<…>` uses `addrOf(from)`, which strips a display name to a bare address — SPF is evaluated on the envelope, so `VEXO Connect <no-reply@…>` must not go on the wire verbatim, and does not |
| DKIM key published | `default._domainkey.vexoconnect.com` exists (`v=DKIM1; k=rsa; p=MIGf…`). Selectors `mail`, `dkim`, `k1`, `s1`, `selector1`, `google` are absent |

**Not verified** — do not restate these as facts:

| Open question | Why it is not settled from here |
|---|---|
| The relay's actual **outbound** IP | `103.168.211.147` is what the name resolves *to*. A relay's egress address need not equal its inbound A record. Only a `Received:` header at the receiving end proves it |
| Whether the relay **DKIM-signs** on submission | `smtpClient.js` does no signing — grepped, not assumed. A published key proves a key exists, not that this relay uses it. Only headers on an arriving message prove signing |
| Whether the mailbox may send as `no-reply@vexoconnect.com` | Needs the credential. Many providers refuse a `From` that differs from the authenticated mailbox, which would surface as a `550` on `MAIL FROM` or `DATA` |

**On the SPF record's leading space.** The published TXT is `" v=spf1 …"`, with a
space before `v=`. RFC 7208 §4.5 says to *"discard records that do not begin with
a version section of exactly `v=spf1`"*. Read strictly, this record is discarded,
the domain evaluates as having **no** SPF record, and the `-all` never applies —
the opposite of the hard-fail protection the rest of this section assumed.
Implementations vary in whether they trim leading whitespace, and which ones do
was **not** tested, so treat the record's effect as unknown rather than either
way. The trailing space is harmless (the ABNF is `record = version terms *SP`).
Correcting it is a one-character DNS edit, **and it is the owner's or the DNS
host's to make — it is proposed here, not done.**

**What this does and does not justify.** Submitting through the domain's own
authenticated server remains the right choice: it is the only host the SPF record
names, it has matching forward and reverse DNS, and it is where a DKIM signature
could be applied. What the earlier revision got wrong was the negative claim —
that a `@vexoconnect.com` message relayed through `mail.atcinfocom.in`
(`103.168.210.27`) would be "accepted here and never seen". That does not follow:

- RFC 7208 §8.4 is explicit that *"disposition of SPF fail messages is a matter
  of local policy."* A fail is a signal, not a rejection. Receivers may reject,
  defer, annotate a header, or file it in Junk.
- `vexoconnect.com` publishes **no enforcing DMARC policy** (below), so nothing
  instructs a receiver to act on the failure.
- This application server's own address (`103.168.211.243`, confirmed as this
  host's egress) is **irrelevant** to SPF when mail is submitted through a
  smarthost, because the sending IP a receiver evaluates is the relay's, not
  ours. Reasoning from our own IP was a category error.

Only the username and password are missing. Host, port, security, sender form
and certificate validation are verified above.

### Then prove it, before trusting it

```
node backend/scripts/verify-mail-delivery.mjs support@vexoconnect.com
```

It sends one real message through `sendMail()` — the same function invitations
and recovery use, outbox row included — and prints PASS/FAIL plus the provider's
queue id. It never prints the password, so the output is safe to paste.

It stops short of claiming success. **SMTP acceptance is not inbox delivery:**
SPF, DKIM and DMARC are judged by the receiving side, after the script has
exited 0. The script ends by naming the subject line to go and look for. Only a
human opening the mailbox closes that gap.

Notes that are enforced, not advice:

- `SMTP_SECURITY=none` is **refused** outside development and test — it would
  put the mailbox password on the wire.
- `APP_URL` must be absolute and **https** in production. Every emailed link is
  built from it and never from a request `Host` header, so a forged `Host`
  cannot redirect a recovery link.
- `SMTP_HOST` without `MAIL_FROM` is refused, as is `SMTP_USERNAME` without
  `SMTP_PASSWORD`. Half a configuration fails at boot rather than at the first
  customer.
- The sending domain should be authorised for that sender (SPF/DKIM). If it is
  not, the mail is accepted by the relay and its treatment at the far end is the
  receiver's choice — reject, quarantine, Junk, or deliver anyway. "Accepted
  here" genuinely tells you nothing about what the recipient sees, but the
  failure mode is *unpredictable*, not *guaranteed loss*.
- **`_dmarc.vexoconnect.com` is currently exactly `v=DMARC1`** — no `p=`, and no
  `rua=`. Checked against RFC 9989 (DMARC, Standards Track) rather than from
  memory, because the previous wording here was wrong. What the RFC actually
  says, in two parts that matter in this order:
  - `p` is *"RECOMMENDED for DMARC Policy Records"*, not mandatory, and *"if this
    tag is not present in an otherwise syntactically valid DMARC Policy Record,
    then the record is treated as if it included `p=none`."* So a missing `p` is
    **not** the fatal syntax error this document used to claim.
  - But the record is then subject to the rule for records lacking a valid `p`:
    if a `rua` is present with at least one valid URI the receiver *"MUST act as
    if a record containing `p=none` was retrieved and continue processing"* —
    **otherwise** *"the Mail Receiver applies no DMARC processing to this
    message."* This record has no `rua`, so the second branch applies.

  Net effect: DMARC is published but **inert** — no policy is enforced, and
  because there is no `rua`, no aggregate reports are produced either, so there
  is no feedback channel to diagnose delivery problems with. It does not block
  delivery, and it is a plausible contributor if invitations land in Junk while
  the delivery check above reports PASS. Note also that RFC 9989 permits
  receivers to *"accept email that fails the DMARC validation check even if the
  published Domain Owner Assessment Policy is `reject`"* — DMARC never
  guarantees an outcome in either direction.

  A record such as `v=DMARC1; p=none; rua=mailto:<a mailbox someone reads>` would
  make it active and start the reports. **This is a proposal requiring the
  owner's approval, not a step to carry out** — no DNS record has been changed,
  and none should be without that approval.
- `MAIL_ALLOWED_RECIPIENTS` is a non-production safety net (e.g.
  `*@vexoconnect.com`). Leave it **unset in production**; set it anywhere a
  copied-in production database could otherwise mail real customers.

Confirm the service booted with mail on before continuing. A boot failure here
is the configuration being rejected, not a bug.

---

## 2. Create the permanent platform administrator

Run inside the backend container, where `DATABASE_URL` and the `SMTP_*` values
above are already in the environment:

```
node scripts/bootstrap-platform-admin.mjs --email support@vexoconnect.com
node scripts/bootstrap-platform-admin.mjs --email support@vexoconnect.com --confirm
```

The first form is a **preview**: it prints what it would do and writes nothing.
Nothing is written and no mail is sent without `--confirm`.

What it does and does not do:

- It **invites**; it never chooses, prints, stores or mails a password. The
  recipient sets their own on the accept page, so the address is proven — the
  link only ever existed in that mailbox — and no credential passes through a
  terminal, a scrollback or a log.
- It is **safe to re-run**. Once the administrator exists it reports that and
  sends nothing.
- If the address already belongs to somebody, it **refuses** rather than
  promoting them. Platform access is never granted by email registration or by
  domain membership.

Then open the link in that mailbox, choose a password, and sign in. Accepting
an invitation issues **no session** — it ends at the sign-in page on purpose,
so possession of a link is never possession of an account.

### The last-administrator rule

The server refuses (`409`) to disable or demote the last active platform
administrator, and the console greys the button. Before removing anyone's
platform access, invite and activate a second administrator. This is the one
state the product cannot recover from a screen.

---

## 3. Onboard a real customer

In the VEXO console, in this order:

1. **New company** — name and slug.
2. **Issue licence** — plan, expiry, base branch limit. Do this *before*
   inviting the owner: a company with no licence is readable but not writable,
   so its owner can sign in, see everything, and be refused
   (`POS_LICENSE_MISSING`) the moment they try to do anything, including hiring
   their first colleague.
3. **Invite owner** — name and address. A single-use link is mailed; the screen
   shows no password because there is none.
4. The owner opens the link, sees who invited them and to what, chooses their
   own password, and lands on the sign-in page.

Invitations expire, can be **revoked**, and can be **resent** — a resend mints a
new link and kills the old one, and is refused inside a short cooldown so the
button cannot post somebody a message per press. An address that already holds
an account is refused at invite time rather than sent a link it could not
accept.

Demo tenants stay flagged `isDemo` and are not converted. No historical or
audit data is removed by any step here.

---

## 4. How staff accounts get their first password

An owner or admin adds someone on **Team**. The account is created immediately
with a credential **no string satisfies**, and the person is mailed an 8-digit
code. The screen that confirms this shows the address the code went to and
never a password — there is nothing to reveal, which is the point.

The emailed link opens the recovery page **already on the code step** with the
address filled in. The code itself is never in the URL; it is typed. (Starting
"Forgot password?" from the top instead would mint a second code that
supersedes the one in their hand, or hit the resend cooldown and refuse — so
the link matters.)

Until the code is redeemed the row shows **Awaiting password** on the roster.

**Resetting** someone's password works the same way: it cuts the old
credential, revokes every session immediately, and mails a code. The
administrator never holds the replacement. A reset against a **disabled**
account is refused — enable it first, or not at all — because recovery passes
over disabled users and the code could never be spent.

If the send fails, the account still exists and the response says so
(`sent: false`, with the reason); the failure is recorded in the outbox. The
person can use "Forgot password?" themselves.

---

## 5. Recovery, for reference

`/forgot-password`: ask → type the emailed code → choose a new password.

- 8-digit cryptographically random code, 10-minute expiry, 5 attempts,
  60 seconds minimum between resends, 5 codes per account per hour.
- Stored as a keyed verifier; never logged, never in a response body.
- **The same answer for registered and unregistered addresses**, so the screen
  is not an account oracle. Do not "improve" this by skipping ahead only for
  real accounts or wording the two cases differently.
- On success, every session is revoked.
- It works when a licence has **expired** — a lapsed renewal must not lock an
  owner out of the account they need in order to renew — and it does **not**
  reactivate a disabled or suspended account.
- **Recovery never issues a session.** A completed reset answers with a message
  and nothing else: no token, no cookie. The only way in is `POST /auth/login`,
  which is the single place in the codebase that mints a session. So recovery
  cannot walk past any gate that lives at login — present or future.

  Stated that way deliberately, because **MFA is not implemented in the login
  flow.** The schema has `TotpCredential` and `MfaRecoveryCode`, the audit enum
  has `MFA_LOGIN`, and `src/lib/totp.js` is implemented and unit-tested — but
  nothing in `src/` imports any of it (grepped, and re-grepped). There is no
  enrolment endpoint and no second factor at login.

  To be unambiguous about what the bullet above is worth: **"recovery does not
  mint a session" is not MFA enforcement.** It is a narrower claim — that
  recovery cannot *bypass* whatever login enforces. If login enforces nothing,
  there is nothing to bypass, and the property is still worth keeping because it
  is what stops a future second factor from being undone by the reset screen.

  **Checked against the approved requirements, not assumed:** no requirement for
  MFA, 2FA or a second factor exists in `docs/` at all — the only textual match
  is a hex string in an unrelated deploy note. The `TotpCredential`,
  `MfaRecoveryCode` and `totp.js` scaffolding was added by this lane's own commit
  `ccf8423`, unrequested, and is unused. So there is no approved enforcement to
  "finish": whether MFA should exist at all is an **owner decision**, and
  implementing it belongs to the authentication owner, not here. Nothing was
  built speculatively on the strength of scaffolding this lane itself introduced.

  The related gap that *is* on the record is **F-3** in
  `docs/CLIENT-HANDOVER-SCOPE.md`, and it is genuine: `requirePosAuth` reads
  `mustChangePassword` into `req.user` (`middleware/auth.js:51`) but never gates
  on it, so the flag is enforced by the browser alone. Checked rather than
  repeated: **no current code path can create the dangerous combination.** Every
  writer of `mustChangePassword: true` pairs it with a credential no string
  satisfies (`users.js:213`, `users.js:363`), and the paths that set a real
  password set the flag to `false` (`auth.js:205`, `invitations.js:191`,
  `accountRecovery.js:256`). The residual exposure is therefore rows predating
  this lane that hold the flag *and* a known password. F-3 is marked "Open —
  owner decision", the fix touches every route, and it sits with the
  authentication owner — so it is reported here, not taken.

---

## 6. What is proven, and what is not

**Proven.** 820 backend tests — the whole suite on the merged tree, not the
accounts files alone — and `deploy/accounts-journey.mjs`: 46 checks
driving the real built bundle in headless Chromium against a real backend over
HTTP, reading mail out of a real SMTP conversation, on a fresh database. It
covers bootstrap → last-admin protection → company → licence → owner invitation
→ accept → sign-in → recovery by code → hiring a colleague by emailed code →
the oracle check.

```
# fresh, migrated database required — the script asserts it and refuses otherwise
VITE_BASE_PATH=/pos/ npm --prefix frontend run build
DATABASE_URL=... node deploy/accounts-journey.mjs
```

**Proven: ordinary users cannot reach platform administration.** The `/api/atc`
router carries `router.use(requirePosAuth, requireAtc)`, and `requireAtc` tests
`req.user.role !== 'POS_SUPER_ADMIN'` directly. That distinction matters: a
*permission-key* gate can be widened by granting the key through
`customPermissions`, whereas a role comparison cannot be widened by any
administrator action short of changing the row's role.

Two tests hold it. One turns away a `CUSTOMER_OWNER` — the most senior role
inside a tenant — on four platform endpoints, and asserts no invitation was
created and no mail sent, so a refusal cannot have had side effects on the way.
The second enumerates the router's own stack and asserts **every** endpoint it
serves answers 403, which covers endpoints not yet written. That second test was
confirmed to work by planting a route above the `router.use` line — the one
realistic way to ship an unguarded platform endpoint — and watching it fail by
name (`GET /api/atc/negative-control-unguarded: expected 200 to be 403`) before
the route was removed. A guard test that has never been seen to fail is not
evidence.

**Proven: tenants cannot read each other.** Twenty cross-tenant tests across
fourteen files, including user management (`foundationPeople`) and invitations.
They assert the *right* refusal: another tenant's row reads as **404, identical
to a row that does not exist**, rather than 403. A 403 would confirm the record
exists and turn the endpoint into an existence oracle.

### Three statuses, deliberately not merged into one

These get conflated, and conflating them is how staging-only work gets described
as live. Each line below is a separate claim with separate evidence, and passing
one says nothing about the next.

| # | Status | State | Evidence, and its limit |
|---|---|---|---|
| **A** | Accounts **software** verified against a **local SMTP sink** | **PASS** | 820 backend tests + `accounts-journey.mjs` 46/46 on a fresh database. The sink is a real SMTP conversation, and it **relays nothing** — so this proves the software, and nothing about the internet |
| **B** | The **running staging stack** verified | **NOT ESTABLISHED — not ours to establish** | See below |
| **C** | **Real mailbox** invitation / reset verified | **NOT DONE** | Blocked on owner input: a mailbox credential in the secret store and a confirmed recipient. `support@vexoconnect.com` is still a **placeholder** — it is the address an earlier report named, which is not the owner confirming it exists and that they can open it |

**A does not imply B, and B does not imply C.** In particular: the 46-check
journey is an **isolated** harness that builds its own database and its own sink.
It says nothing whatsoever about the staging stack, and it **does not prove the
previously reported staging API 502 is fixed.**

**On B, and why this lane stops here.** Measured 2026-09-25, and the last line is
the reason the rest cannot be concluded from here:

- `http://127.0.0.1:8120/api/health` answers **200** `{"status":"ok","service":"atc-pos-api"}`.
  So the **502 report is stale** — but a health endpoint answering is not the
  accounts endpoints working, and it is not a mail configuration.
- That edge fronts `127.0.0.1:5540`, a `node src/index.js` whose cwd is the
  **`cloud-readiness` lane**, not this one. Staging belongs to that lane's owner.
- That lane is running an **older accounts revision**: `650be16` is an ancestor of
  its head, while `9c43b4d`, `584de37` and `4eca256` are **not**.
- The process started `04:02:43`; the lane's head commit is dated `04:03:25` —
  **42 seconds later.** The running code is therefore whatever was on disk at
  module-load time and is not provably the current checkout. Only that owner can
  say what is actually loaded.
- Staging's **mail configuration is unknown.** It cannot be read from here: the
  environment of another owner's process is not ours to read, and `mailStatus()`
  in `mailer.js` is surfaced by **no route**, so there is no endpoint that reports
  it either. *(That is a real operability gap and a fair thing to add later — a
  deployment should be able to answer "is mail configured" without someone
  reading its environment. It would need care not to disclose the username.)*

Two read-only probes were attempted and both were **discarded by their own
negative controls**, which is the only reason this section says "not established"
rather than something more confident:

1. `GET /api/atc/companies` → 401. But `/api/atc/definitely-not-a-route` → **401
   too**, because the router-level guard fires on the mount prefix before routing.
   The 401 distinguishes nothing.
2. `OPTIONS` on each accounts route → 204 with no `Allow` header. But
   `OPTIONS /api/definitely-not-a-route-xyz` → **204 as well**: CORS answers every
   preflight ahead of routing. Also distinguishes nothing.

A probe that returns the same answer for "present" and "absent" is not evidence.
The remaining way to discriminate would be a `POST` to a recovery or invitation
route, which **writes rows and can send mail in someone else's environment** — so
it was not done. **Verifying accounts on staging is the staging owner's call, on
their stack, and it is handed to them rather than assumed.**

**Unblocked, but not run here.** `deploy/e2e-workflow.mjs` (the till money-path
harness) used to seat its Cyber Hub staff from the temporary password that came
back from `POST /users`. That password no longer exists, so the harness briefly
refused rather than fail deep in the money path. `deploy/e2e-isolated.sh` now
starts `backend/scripts/mail-sink.mjs` alongside the backend and hands the
harness the capture folder, and the harness seats its staff the way a real
branch does: read the emailed code, set a password, sign in. No back door was
added — there is no test-only path that returns a credential, because a back
door that exists for tests exists in production too.

What that proves and what it does not: the mail half is proven, against a real
backend over real HTTP with a real capture folder. The money path behind it is
**still unrun on this host** — `deploy/e2e-isolated.sh` and the harness both
refuse on `atc-noc` because production POS runs here, and neither guard was
weakened. Run it on a host that is not `atc-noc`.

The folder the sink writes to holds live single-use codes. `e2e-isolated.sh`
drops it under `.devlogs/` and leaves it for inspection; treat old runs as spent
credentials and delete them.
