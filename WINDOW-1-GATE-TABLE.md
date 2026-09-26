# Window 1 — gate-by-gate status, and exactly what the owner must supply

**From:** the cloud-readiness / recovery lane
**Date:** 2026-09-26T07:00Z
**Branches:** `x/cloud-readiness` (evidence + deploy), `x/firstlogin-gate` (software)
**Deployed to production:** **nothing.** Production is v1.0.1 and untouched.

Sanitised for a public repository: `private: false`, re-confirmed today by an
unauthenticated API call returning 200. **No credential, recovery code, token,
passphrase or private key appears below**, and that is the claim that matters.

What this file does *not* claim, because the draft did and it was false: that
host addresses, the backup destination and the key fingerprint exist only in the
evidence directory outside Git. **All three are already in this public
repository** — measured one literal at a time, the key fingerprint in 4 tracked
files, the off-host destination in 4, the production host in 2. They are not
reproduced here, since a negative claim does not need to restate what it denies.

The distinction to hold on to: a GPG **public-key fingerprint is not a secret**
— fingerprints exist to be published and buy an attacker nothing without the
passphrase and the secret half, neither of which is anywhere in Git. So this is a
policy statement that was wrong, not a credential leak. The disclosure worth
weighing is §B and §C being documented together in public; see the note in the
verification ledger.

## The table

| # | Gate | Status | What it rests on |
|---|---|---|---|
| 1 | Scheduled backup + off-host shipping | **PASS** | Timer and service both enabled and active; ran successfully the night before each check |
| 2 | Restore of a plaintext dump into an isolated DB | **PASS** | 16/16, reconciled to its manifest |
| 3 | Encrypted archive opens, contents match the manifest | **PASS** | Owner-run 2026-09-25. Production key, production ciphertext |
| 4 | **Archive → decrypt → `pg_restore` → reconciled DB** | **PASS (mechanism)** / **PENDING-OWNER (production key)** | **22/22** on real production bytes inside a real `.tar.gpg`, plus a broken-on-purpose control run that failed exactly 3 rows and exited 1. The run used a *throwaway* recipient key |
| 5 | First-login enforcement is server-side | **PASS (written + tested @ `bad4896`)** / **PENDING deploy** | Was UI-only and bypassable — confirmed by getting a 201 from `POST /api/orders` with a temporary-password session. **30/30** on the gate suite and **194/194** across it plus 7 auth-adjacent suites, 0 skipped; 6 failures when the gate is neutered, and 9 of the 16 new config assertions fail against the pre-`bad4896` code. Merges clean onto `main` `728a57c`. **Not deployed.** See `WINDOW-1-FIRSTLOGIN-SHA.md` |
| 6 | Staging publish config is coherent | **PASS (in-repo)** / **PENDING-OWNER (hostname + TLS)** | Two silent defects fixed and verified in 3 configurations including a failing control |
| 7 | Real inbox delivery | **PENDING-OWNER** | Software is complete and race-safe. No provider credential exists on the box, so the endpoint answers 503 by design. **A second, independent blocker found since: `vexoconnect.com` publishes a malformed SPF record (leading space, so strict verifiers select no policy at all) that hard-fails from an IP which is not the domain's own, and a DMARC record with no `p=` tag. Needs no secret to fix, and must be fixed BEFORE the credential is spent or the test measures the wrong thing. See §A** |
| 8 | Key custody (CR-3) | **FAIL as designed / PASS as built** — **PENDING-OWNER** | The key works. It is on the one host its own design document forbids. **Untouched by this lane on purpose. See §B** |
| 9 | Backup destination deletion protection (CR-4) | **NOT VERIFIED** — **PENDING-OWNER** | Destination is reached with a general-purpose SSH key, so anything that can log in as the operator can also delete the off-host copies. **See §C** |
| 10 | **Owner can recover after losing `atc-noc`** | **NO** | Follows from gate 8 and is *not* closed by gates 3 or 4. This is the honest headline |

Gates 1–6 are as good as this lane can make them without an owner action.
Gates 7–10 cannot be closed by testing at all — each needs something only the
owner can provide. Those four are the whole remaining list.

### One correction to carry forward

An earlier reconciliation distinguished the 09-23 and 09-24 dumps as reconciling
"23" and "24" models. **Every manifest carries 23**, verified by counting `rows`
in all three nights. The dumps really are different artifacts (different day,
different sha256, 857 bytes apart) so the conclusion stood, but the number cited
for it was wrong.

**Two copies of that wrong number are still live and neither is mine to fix:**

| Where | Status |
|---|---|
| `docs/RELEASE-HANDOVER-CHECKLIST.md` line 285 — "102 726 bytes, 24 models" | **Tracked and published.** That file is currently uncommitted in another session's hands (it is named as theirs in `PEER-NOTE-PUSH-AUTHORISED.md`), so editing it here would either clobber their in-flight buffer or sweep their hunks into my commit. Left for them, flagged here |
| `PEER-NOTE-PUSH-AUTHORISED.md` line 76 — the same `23 \| 24` table | Untracked, never published. Cosmetic, but anyone reconciling from that note reaches the same error |

Corrected everywhere this lane owns: `evidence/07-backup-recovery.md`,
`evidence/07b-recovery-owner-procedure.md`, and the verification ledger.

Related, because it looks alarming and is not: the 09-24 and 09-25 dumps are the
**same length with different hashes**. `pg_dump -Fc` embeds a creation timestamp,
so unchanged content still produces different bytes. Equal size is not evidence
of a duplicate; unequal hash is not evidence the data changed.

---

## §A — Real inbox delivery (gate 7)

The software is done and was reviewed rather than assumed: codes are 8-digit,
stored as a keyed HMAC, single-use through a conditional update that is race-safe
under concurrent verification; reset tokens are 256-bit and unique; a resend
supersedes its predecessor rather than doubling the guessing budget. The endpoint
returns an identical response for a registered and an unregistered address.

It answers `503 POS_MAIL_NOT_CONFIGURED` today because `mailEnabled` is derived
from the presence of an SMTP host, and no provider file exists on the box.

### What the owner must supply — five items, and the last two are the ones that get missed

| | Item | Why it is owner-only, and what goes wrong without it |
|---|---|---|
| A1 | **SMTP password** | A real credential. Never in Git, never in a log, never pasted into chat. It belongs in an untracked file beside the config, mode `600` |
| A2 | **SMTP username, confirmed as the _full_ address** | A bare local part authenticates as nobody and the provider answers **535**. This is the single most common cause of "the config looks right and nothing sends" |
| A3 | **An external test inbox, named explicitly** | Delivery to an address on the company's own domain is handled by the local mail system and **proves nothing about SPF, DKIM or DMARC**. Without an outside address — a personal Gmail or similar — a PASS here would be measuring the wrong thing |
| A4 | **`MAIL_ALLOWED_RECIPIENTS`** | **Mandatory outside production: absent, the API will not boot.** The go-live document omits it, so following that document produces a service that fails to start and looks like a bad deploy |
| A5 | **`NODE_ENV=production`** | It is currently **never set**, so the API runs as `development`. That unlocks test payment-gateway adapters and permits plaintext SMTP. Setting it is what makes the other four safe |

A4 and A5 are the two that turn a correct-looking configuration into an outage or
a quietly-insecure one. Neither is a defect in the recovery code.

Fixed in this lane already: the staging runner used to force the password-reset
origin back to loopback, so reset links pointed at `127.0.0.1` no matter what the
caller exported. That is gate 6 and it is done.

### A second blocker, independent of the credential — and it needs no secret to fix

A1–A5 are about authenticating to a provider. They are not the only thing
standing between this gate and a PASS. **The sending domain's DNS cannot
currently pass an external inbox check**, which A3 is specifically there to test.
Checked against two independent resolvers (`1.1.1.1` and `8.8.8.8`), read-only:

| | `vexoconnect.com` — the `MAIL_FROM` domain in `docs/ACCOUNTS-GO-LIVE.md` | `atcworkspace.com` — the current `APP_URL` domain |
|---|---|---|
| SPF | **`" v=spf1 ip4:103.168.211.147 -all "`** — broken, see below | `"v=spf1 +a +mx +ip4:160.19.41.196 ~all"` — valid |
| DMARC | **`"v=DMARC1"`** — no `p=` tag, so invalid | `"v=DMARC1; p=none"` — valid, monitoring only |
| DKIM | present, selector `default`, RSA **1024-bit** | present, selector `default`, RSA **1024-bit** |
| MX | `mail.vexoconnect.com` | `atcworkspace.com` |

Three defects, in descending order of how badly they break the test:

1. **The SPF record begins with a space.** Confirmed byte-for-byte —
   `od -c` shows `"`, `space`, `v`, `=`, `s`, `p`, `f`, `1`. RFC 7208 §4.5 selects
   a record only if it *begins* with exactly `v=spf1`, so a strict verifier does
   not select this one at all and the domain reads as having **no SPF policy**.
   Lenient verifiers trim and then apply it. Both outcomes are wrong and they
   disagree with each other, which is the worst case for diagnosing a failure.
2. **`-all` authorises one IP, and it is not this domain's.** The only permitted
   sender is `103.168.211.147`, while `vexoconnect.com` resolves to
   `160.19.41.196` — and `atcworkspace.com`'s SPF is the record that authorises
   `160.19.41.196`. The two domains disagree about which host sends their mail.
   With a hard fail, anything sent from the wrong one is **rejected**, not
   spam-foldered.
3. **The DMARC record has no `p=` tag.** RFC 7489 requires it; a record without
   one is ignored, so `vexoconnect.com` effectively publishes no DMARC at all
   despite appearing to.

**Why this matters more than its severity suggests.** If the owner spends a real
credential on the A3 test today and sends from `no-reply@vexoconnect.com` to an
outside inbox, the likely result is a rejection or a spam folder — and the
obvious reading of that is "the recovery mail code is broken". It is not. The
code is reviewed and race-safe. **Fix the DNS before spending the credential,
or the test measures the wrong thing twice.**

Two cheap notes: the 1024-bit DKIM keys are below RFC 8301's recommended 2048
and both major receivers still accept them, so that is a nit rather than a
blocker; and a DKIM *public* key is public by definition, which is why the
selector is named here and nothing else about it is.

### Two accepted MEDIUM findings, recorded rather than silently fixed

Both are real, both are documented, neither is closed:

1. **Account-existence oracle on the throttle.** A repeated request for a
   *registered* address eventually answers 429; an unregistered one keeps
   answering 200, because the throttle is counted from rows keyed on a user id
   and an address with no account has no rows to count. An attacker distinguishes
   the two by persistence. The in-code comment defends the 429 on usability
   grounds and is right about usability, but it reasons about replay rather than
   enumeration and so misses this.
   **Why it is not fixed here:** closing it properly needs a throttle keyed on the
   *submitted address*, which means new storage for addresses that do not exist —
   a schema-touching change to a shared recovery flow. That is not a change to
   land late in a session on a lane that cannot run the full suite against it.
   The cheap alternative, swallowing the 429, closes the oracle by removing the
   one signal a waiting user needs, and should be a deliberate product decision
   rather than a side-effect of a security pass.
2. **Timing oracle.** Mail is sent inline before the response, so a registered
   address takes measurably longer than an unregistered one. Same class of leak,
   independent of the first. The fix is to send after responding.

---

## §B — Key custody, CR-3 (gate 8)

**Nothing in this lane moved, copied, re-encrypted or deleted any key material,
and that was deliberate.** A botched custody change does not degrade gracefully:
it loses every off-host archive permanently.

The design document is unambiguous and correct — the private key belongs
"wherever you keep things you cannot afford to lose, which is not this server".
It even explains why the *owner* generates the keypair: a key generated on the
server would have to be transmitted to be useful, and secrets that get
transmitted get pasted into chat windows. What deviates from the design is the
host, not the document: the secret half is in the backup host's keyring, on the
same machine that takes the dumps and keeps the plaintext copies.

So encryption at rest is doing less work than the architecture intends, and
gate 10 answers **no** regardless of how gates 3 and 4 went.

### The ordering constraint that matters more than the commands

> **Do not remove the existing key until a new archive has been proven to decrypt
> with the replacement.** Every archive already off-host is encrypted to the
> current key. Deleting or rotating it first makes all of them unrecoverable, and
> that is exactly the failure the off-host copies exist to prevent.

Safe order: generate the new keypair on the owner's machine → add it as a
**second** recipient so new archives are readable by both → let one nightly run
ship → prove that archive decrypts with the new key alone → *only then* consider
retiring the old one, and keep an offline copy of it for as long as archives
encrypted to it are still within retention.

### Commands for the owner's own machine

These run on the owner's laptop, **not** on the server. The guard is not
decoration: a Run button in a chat client executes on `atc-noc`, and that is how
a backup key came to be generated on the server in the first place.

```text
[ "$(uname -s)" = "Darwin" ] || { echo "STOP: run this on your own machine, not the server"; exit 1; }

gpg --full-generate-key          # RSA 4096, no expiry, strong passphrase
gpg --list-secret-keys --keyid-format=long
gpg --armor --export <NEW-KEY-ID> > vexo-backup-new.pub.asc
gpg --gen-revoke <NEW-KEY-ID> > vexo-backup-new.revoke.asc
```

Then send **only** `vexo-backup-new.pub.asc` to the server. The private key and
its passphrase never leave the laptop, and the revocation certificate is stored
offline, separately.

To check a key is actually passphrase-protected, ask the agent rather than
inspecting files — a key file's contents do not tell you whether the agent has
the passphrase cached:

```text
gpg-connect-agent 'keyinfo --list' /bye
```

What the owner must supply for this gate: **a decision and an exported public
key.** No value from this lane is needed, and no command here should be run by
anyone but the owner.

---

## §C — Backup destination protection, CR-4 (gate 9)

The off-host copy is reached with the operator's general-purpose SSH key, while a
dedicated key pair for exactly this job already exists beside it, unused. The
consequence is the one that matters: anything that can log in as the operator can
also delete the off-host archives — which is why deletion protection reads "not
verified *and unlikely*" rather than merely "not verified". Combined with gate 8,
one compromised host loses both the archives and the key that opens them.

Not verified here because verifying it means operating the destination host,
which this lane was scoped out of. Reported, not tested.

Change set, in increasing order of effort:

1. **Use the dedicated key that already exists** for the shipping job, instead of
   the operator's general key. Smallest possible change, removes the coupling
   between "can administer the box" and "can delete the backups".
2. **Constrain it at the destination** with a forced command and
   `restrict`/`no-pty` in `authorized_keys`, so that key can deposit an archive
   and cannot enumerate, overwrite or delete.
3. **Make the destination append-only** for that principal — the only version of
   this that survives a compromised source host. Pruning then has to run under a
   different principal, or not at all.

Rollback for all three is the same and is why they are safe to try: keep the
existing key authorised until the new path has shipped one archive successfully,
then withdraw it. Never remove the working path first.

---

## §D — Production change sets and rollback

Two pieces of software are complete, tested and **not deployed**.

### D1 — First-login enforcement (gate 5)

Branch `x/firstlogin-gate`, **tested tip `bad4896`** — not `af72be9`, which this
section originally described and which is superseded. Six files: the auth
middleware, an error constructor, two config values with boot-time guards, the
auth routes, `.env.example`, and a new module that is the single place a session
is minted. SHA, results and the control run: `WINDOW-1-FIRSTLOGIN-SHA.md`.

Shape of the change: the gate lives in the middleware that 29 feature routers
already mount, so one check covers all of them; a narrow variant is mounted on
exactly three routes a temporary session must still reach — read own identity,
change password, log out. Anything else mounted on that variant reopens the hole.
Leaving the temporary state revokes sibling sessions and re-mints the cookie, so
a shared temporary password stops working the moment it is replaced.

Deploy notes:
- **Boot-time guards, corrected in `bad4896`.** This bullet used to say that
  zero, non-numeric *or longer than a full session* all throw at startup. That
  was true of the **default** too, and it was a defect: a deployment setting
  `SESSION_TTL_HOURS` below 0.5 failed to boot citing
  `POS_TEMP_SESSION_TTL_MINUTES`, a variable absent from its own config. The
  default is now **capped** to the full session length. An **explicitly set**
  value that is too long, zero or non-numeric still throws, and now prints both
  numbers — that part remains intended.
- `SESSION_TTL_HOURS` is **also** guarded now, ahead of everything that divides
  by it. It previously accepted a typo: `Number('abc')` is `NaN`, every
  comparison against `NaN` is false, so the service booted clean and then
  returned **500 on every login** — `jwt.sign` throws on `expiresIn: 'NaNh'`.
  A bad value now fails the deploy instead of the users.
- There is **no hot reload** on the backend. A broken import on the boot path
  takes down the whole API, so this deploys as a normal restart, not a file drop.
- Clients need to handle one new error code by routing to the change-password
  screen instead of showing "no permission" — the user *has* the permission, they
  simply have not finished signing in.

Rollback: revert the six files and restart. There is no migration, no schema
change and no data transformation, so rollback is a code revert only — the
`mustChangePassword` column already existed and is untouched. Re-verified at the
integrated SHA: the diff contains no `prisma`, no migration and no `.sql` file,
the column is `boolean NOT NULL default false` in live production, and **0 of
16** production users carry the flag — so the gate is inert for every account
that exists today.

### D2 — Staging publish configuration (gate 6)

Three files under `deploy/`. Two values became overridable defaults instead of
unconditional assignments, and the safety property moved into the assertion
script rather than disappearing: the run fails unless the loopback edge origin is
still in the allow-list, so a caller may **add** a public origin and may not
silently drop the one whose absence produces a browser-only 500. Plain `http://`
on a public name stays refused, because the cookie is `Secure` by then and would
never come back.

Verified in three configurations — loopback default PASS, published `https://`
PASS, and a control with `http://` plus the edge origin removed **failing both
lines**. A loosened assertion that cannot fail is worse than the bug it replaced,
so the control is the point.

Rollback: revert the three files. They are read by a staging runner and an
assertion script; nothing in production reads them.

### D3 — Not required

Publishing a staging hostname needs DNS, `sudo`, and a certificate issued with a
deploy hook that reloads the proxy. It is prepared and **not applied**. A
frontend rebuild is *not* needed for it — the bundle derives its API base and its
display origin at runtime, which was checked rather than assumed.

---

## What this lane did not do

Stated plainly so nobody has to infer it:

- **Deployed nothing.** Production is v1.0.1.
- **Published no hostname**, issued no certificate, touched no DNS.
- **Moved, copied, re-encrypted and deleted no key material.**
- **Inserted no provider credential.** The 503 on password recovery is the
  correct answer for a box with no mail credential, not a defect.
- **Wrote to no production database.** Reads only, which standing authorisation
  covers; every restore went into a freshly-named throwaway database.
- **Rewrote no public history**, and does not propose it — see the disclosure
  note in the verification ledger. The effective remedy for CR-3 and CR-4 being
  publicly documented is to *close them*, not to unpublish them.

### One residue item to close

The restore verifier does not drop the databases it creates — by design, so that
it "cannot destroy a database by being wrong about a name". Its temp-directory
cleanup protects the decrypted *dump file*, not the *restored rows*. This lane's
runs therefore left six scratch databases holding a full copy of production,
staff password hashes included, in the dev Postgres container.

They are unreferenced and loopback-only, so the exposure was local rather than
reachable — but it does not expire on its own.

**Closed on the owner's instruction — all eight are gone.** Six from this lane's
encrypted-archive runs, then the older 09-24 plaintext drill's pair on a follow-up
instruction, the first of which held 16 staff password hashes with all 16
`passwordHash` values non-null. Each was dropped in its own statement rather than
in a loop, so each `DROP DATABASE` could be read against the intended name before
the next one ran. Afterwards a re-query for every drill prefix returns 0 rows, and
`atc_pos`, `atc_pos_test` and nine co-tenant lane databases were each confirmed
still present by name.

Not by counting, though. The total had already moved 94 → 98 between the two
rounds of drops, because co-tenant sessions create and drop test databases
continuously. **The proof is the re-query by name; the count is a coincidence that
happens to agree.**

### The durable fix — and a warning about your own verification run

A one-off cleanup does not close this. **Every restore drill leaves a copy of
production behind by default** — the verifier deliberately drops nothing, so that
it cannot destroy a database by being wrong about a name. That is the right trade,
but it makes cleanup a step someone has to remember, and two days of drills show
it is not being remembered.

This lane first recommended sweeping `vcx_restore%`, `vcx_rehearse%` and
`vcx_ctlmis%`. **That recommendation was wrong and is withdrawn.** It enumerated
the labels that happened to have been used, where the names are actually built as
`vcx_{label}_{stamp}` and `vcx_{label}neg_{stamp}` with `--label` supplied per
wrapper. Measured against ten residue names and ten that must survive:

| Sweep | Residue matched | Co-tenant DBs falsely matched |
|---|---|---|
| the three prefixes above | **5 / 10** | 0 |
| `^vcx_[a-z]+_[0-9]{8}t[0-9]{6}$` | **10 / 10** | **0 / 10** |

Among the five the old pattern missed are `vcx_ownerrestore%` and
`vcx_ownerrestoreneg%` — **the databases `owner-verify-backup-restore.sh` will
create when you run it to close the production-key gate in §B.** That run uses the
real production key against real production bytes, which makes it the one drill
whose residue matters most, and the sweep this lane recommended would have walked
straight past it. So: after that run, clean up behind it.

```bash
# list first — it is a delete, and the pattern is a safeguard, not a substitute
# for reading what it selected
docker exec vexo-connect-dev-db psql -U vexo_dev -d postgres -c \
  "SELECT datname, pg_size_pretty(pg_database_size(datname))
     FROM pg_database
    WHERE datname ~ '^vcx_[a-z]+_[0-9]{8}t[0-9]{6}$' ORDER BY datname;"
```

The shape also catches labels nobody has invented yet, and against the live
96-database list it matches 0 while leaving the other 91 `vcx_` databases alone —
lane and `_test` databases carry no `_YYYYMMDDtHHMMSS` stamp, and neither does
`vcx_w6_migpop_052517`, the nearest-miss name on the box.
