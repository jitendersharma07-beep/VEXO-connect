# Accounts go-live: platform administration, onboarding, invitations, recovery

What an operator does to take this from "implemented and tested" to "a real
customer can be onboarded". Written to be followed in order, once.

Everything below is **implemented and verified against a local SMTP sink**.
The one thing that is **not** proven is delivery through a real provider,
because no mailbox credentials exist on the deployment yet. Step 1 is that
configuration, and nothing else here works until it is done — deliberately.

---

## 1. Configure the sender (the only outstanding owner input)

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
SMTP_HOST=<provider host>
SMTP_PORT=587
SMTP_SECURITY=starttls          # or tls with port 465
SMTP_USERNAME=<mailbox user>
SMTP_PASSWORD=<mailbox password or app password>
MAIL_FROM=VEXO Connect <no-reply@vexoconnect.com>
APP_URL=https://<production host>/pos
```

Notes that are enforced, not advice:

- `SMTP_SECURITY=none` is **refused** outside development and test — it would
  put the mailbox password on the wire.
- `APP_URL` must be absolute and **https** in production. Every emailed link is
  built from it and never from a request `Host` header, so a forged `Host`
  cannot redirect a recovery link.
- `SMTP_HOST` without `MAIL_FROM` is refused, as is `SMTP_USERNAME` without
  `SMTP_PASSWORD`. Half a configuration fails at boot rather than at the first
  customer.
- The sending domain must be authorised for that sender (SPF/DKIM) or the mail
  is accepted here and dropped at the far end.
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
  reactivate a suspended account or bypass MFA.

---

## 6. What is proven, and what is not

**Proven.** 785 backend tests across 29 files, and `deploy/accounts-journey.mjs`:
47 checks driving the real built bundle in headless Chromium against a real
backend over HTTP, reading mail out of a real SMTP conversation, on a fresh
database. It covers bootstrap → last-admin protection → company → licence →
owner invitation → accept → sign-in → recovery by code → hiring a colleague by
emailed code → the oracle check.

The oracle check is stronger than it was. `accountRecoveryOutage.test.js` holds
it **while the mail provider is failing** — a registered address and an
unregistered one answer identically when SMTP refuses the connection, where
previously the registered one returned 500 and the unregistered one 200. That
difference was readable by anyone, and it appeared precisely during a
misconfiguration: the state step 1 of this document walks through.

```
# fresh, migrated database required — the script asserts it and refuses otherwise
VITE_BASE_PATH=/pos/ npm --prefix frontend run build
DATABASE_URL=... node deploy/accounts-journey.mjs
```

**Not proven.** Delivery through a real provider. Every message so far has gone
to a local sink that relays nothing — and that includes the journey script
itself, which **overwrites** `SMTP_HOST` with a loopback sink at line 145. It
will pass identically against a correctly configured provider and against no
provider at all, so it cannot be the evidence for this item. Nor can any
backend test. Only a mailbox can.

Step 1 is the gap, and after step 1 the first real evidence is the bootstrap
invitation arriving in the owner's mailbox.

**Which mailbox is an open question.** This document has said
`support@vexoconnect.com`; the cloud-readiness brief supplies
`ai.atcinfo@gmail.com`. They are not the same address and nothing here can
choose between them — the second is the account this work was requested from,
the first is a product address that may not exist yet. Confirm it explicitly
before sending, because §1's allow-list safety net is inert in production and
a mistyped address becomes a real message to a real stranger.

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
