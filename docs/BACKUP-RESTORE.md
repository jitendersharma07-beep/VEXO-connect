# VEXO Connect — backup and restore runbook

Until 2026-09-22 there was no backup of this database anywhere. A café billing
on this system keeps its entire sales history, its staff accounts, its licence
and its cash closings in one Docker volume on one disk. This document is the
policy that changes that, and — more importantly — the procedure for the day it
is needed.

Two things are worth stating before any of the commands:

- **A dump that has never been restored is an assumption, not a backup.** The
  drill in §4 is not optional polish; it is the step that converts files into
  backups. Everything else here is plumbing around it.
- **Restoring is a business decision before it is a technical one.** Every order
  and payment taken since the dump is destroyed by a restore, and invoice
  numbers already printed on customers' receipts get reissued to different
  sales. §5 says this again, louder, in the place where it matters.

---

## 1. What is covered

| | |
|---|---|
| Database | `pos-prod-postgres-1`, Postgres 16, compose project `pos-prod` |
| Volume | `pos-prod_pos_pgdata` |
| Backup script | `deploy/pos-backup.mjs` |
| Schedule | `deploy/systemd/atc-pos-backup.{service,timer}` — 02:30 IST daily |
| Backups land in | `/home/atc-noc/atc-backups/pos-prod` (mode 700) |
| File names | `pos-prod-<UTC stamp>.dump` + `.manifest`, both mode 600 |
| Retention | 14 days, but never fewer than 3 files and never the newest |

**Covered:** everything in the database, via `pg_dump -Fc`.

**Not needed:** the `pos-prod` stack has no uploads volume and no bind mounts —
check `docker-compose.prod.yml` before trusting that sentence again. A
pg_dump-only policy stops being complete the moment a volume is added, and it
stops silently.

**Deliberately NOT covered: `/home/atc-noc/atc-pos/.env`.** It holds
`POSTGRES_PASSWORD`, `POS_JWT_SECRET` and the gateway keys. A database restored
without it cannot even be connected to, so it is genuinely part of recovery —
but copying a credentials file into a data directory is how secrets end up in
seventeen places. The manifest records its SHA-256 instead, so a recovery can
tell whether the `.env` in hand is the one that matched the dump without this
directory ever holding the secret.

> **The `.env` needs its own home.** Right now the only copy is on this host,
> next to the database it protects — so the one failure that destroys the
> database destroys the key to the backup as well. Put a copy in the password
> manager or wherever ATC keeps its credentials of record. This is an owner
> action; it is not something a script should do.

### Why the script is built the way it is

- `pg_dump` runs **inside** the container over the unix socket. The password
  never reaches argv, the host, or this process, and client and server are the
  same major version by construction.
- The table list is read **from the database**, never written in the script. A
  hand-kept list silently stops covering the newest table, and the newest table
  is the one nobody has the habit of checking. (This is not hypothetical: when
  the script was written, production was six migrations behind the repo, and a
  script naming `DayClose` would have refused to run at all.)
- The file is written to `.part` and renamed **only after being read back** and
  found to contain every table the live database reported. Checking one
  well-known table would pass a dump of the wrong database; checking all of
  them makes it a comparison rather than a smoke test.
- Free space is checked first and the run **refused** if tight. This box shares
  one filesystem between `/`, `/tmp` and `/var/lib/docker`; filling it
  crash-loops every database on the host. A backup job that causes the outage
  is not a safety measure.
- Retention never empties the directory and never deletes the newest file
  regardless of age. A rule that can delete the last copy is a data-loss
  mechanism wearing a hygiene costume.

---

## 2. Install the schedule (one time, as root)

**Done — 2026-09-22 13:33 UTC.** The timer is `enabled`, the first run produced
`pos-prod-20260922T133322Z.dump`, and that dump has been restore-drilled (§6).
Kept here because it is what you repeat on the next machine, and because the
verification steps are the part worth copying.

**Run this on the server, over SSH.** Obvious until it isn't: the paths below
exist only on the POS host, and `systemctl` does not exist on macOS at all. A
block pasted into a laptop terminal prompts for the *laptop's* password, refuses
the server's, and looks for all the world like "sudo is rejecting my password".
Check the shell prompt says `atc-noc@atc-noc` before you type anything.

```sh
sudo install -m 644 -o root -g root \
  /home/atc-noc/atc-pos/deploy/systemd/atc-pos-backup.service \
  /home/atc-noc/atc-pos/deploy/systemd/atc-pos-backup.timer \
  /etc/systemd/system/ && echo "STEP1 copy PASS" || echo "STEP1 copy FAIL"

sudo systemctl daemon-reload && echo "STEP2 reload PASS" || echo "STEP2 reload FAIL"

sudo systemctl enable --now atc-pos-backup.timer && echo "STEP3 enable PASS" || echo "STEP3 enable FAIL"

test "$(systemctl is-enabled atc-pos-backup.timer)" = enabled && echo "STEP4 enabled PASS" || echo "STEP4 enabled FAIL"

# prove it once — do not wait until 02:30 to find out
sudo systemctl start atc-pos-backup.service
ls -t /home/atc-noc/atc-backups/pos-prod/*.dump | head -1

# and prove the file it produced is restorable
node /home/atc-noc/atc-pos/deploy/pos-backup.mjs --drill
```

One `echo` per step, rather than one `&&` chain across all of them: `sudo`
asks for a password once and the rest of a chain inherits the failure silently,
so a mistyped password at the top leaves you reading a success message printed
by a later command that never ran.

**A new `.dump` filename is the only proof the service ran.** Not the exit code,
and emphatically not `systemctl show`: asked about a unit that does not exist at
all, it answers `Result=success` and `ExecMainStatus=0`, because those are its
defaults for a unit it has never heard of. That is a green tick for a service
that was never installed. `systemctl is-enabled` answers `not-found` and is the
one to trust; a dump file with a newer timestamp is better still, because it is
the artefact rather than a claim about it.

The unit runs as `atc-noc`, who must be in the `docker` group:

```sh
id -nG atc-noc | tr ' ' '\n' | grep -x docker    # must print: docker
```

It deliberately does **not** run as root. Nothing here needs it, and a
root-owned backup directory is one more thing a recovery has to fight at the
worst possible moment.

There are two `node` installs on this box. The unit pins `/usr/bin/node`,
because a service must not depend on whether nvm happened to be sourced; your
interactive shell gets nvm's. They are the same version today, so a hand-run
`--drill` and the nightly run behave identically — but an nvm upgrade moves one
and not the other, so check both if the two ever disagree:

```sh
/usr/bin/node --version; node --version
```

The timer is `Persistent=true`, so a backup missed while the box was off is
taken at the next boot rather than skipped — the most likely reason the machine
was off is also the most likely reason you will want the backup.

---

## 3. Day to day

```sh
cd /home/atc-noc/atc-pos

node deploy/pos-backup.mjs --check    # report state, write nothing
node deploy/pos-backup.mjs            # take a backup and verify it
node deploy/pos-backup.mjs --drill    # restore the newest one and prove it matches
```

`--check` **fails** if the newest backup is more than 26 hours old. That is the
monitoring hook: it is how a schedule that quietly stopped running announces
itself.

### There is no alerting — this is a known gap

Nothing pages anyone if the nightly run fails. `systemctl start` failures land
in the journal and stay there. Until that is wired into whatever the NOC
already watches, someone must look:

```sh
systemctl list-timers atc-pos-backup.timer --all
journalctl -u atc-pos-backup.service --since '2 days ago' --no-pager
```

The smallest honest fix is a weekly job that runs `--check` and delivers the
PASS/FAIL line somewhere a human reads. It is not done.

---

## 4. Prove the backup restores (the drill)

```sh
node deploy/pos-backup.mjs --drill
```

It restores the newest dump into a **throwaway** database in the *development*
container (`atc-pos-dev-db`), never in production's own — a restore rehearsal
that runs inside the thing it is insuring is one typo away from being the
incident. It then compares, against the live database:

- every table's row count;
- the sum of `Payment.amount` — a row count proves the rows arrived and says
  nothing about whether the amounts came with them;
- the number of `PosUser` rows with an intact password hash — who can log in.

The drill database is dropped and the temporary dump removed afterwards,
including on failure: a drill that leaves a copy of production lying around in
a dev database has created the problem it was checking for.

`pg_restore`'s default is to log an error, carry on, and **exit 0**. The drill
passes `--exit-on-error`. Any manual restore must do the same, or a
half-restored database reports success.

Run the drill after every schema migration, and before any handover.

---

## 5. Restoring

Three different situations, and they are not the same emergency. Pick
deliberately.

### A. A deploy went wrong; the data is fine

Do **not** touch the database. Roll the code back. See
`docs/DEPLOY-PHASE2.md` §6 — phase-2 tables are additive, so a code rollback
does not require a database rollback.

Current image anchors:

| Tag | Built | What it is |
|---|---|---|
| `pos-prod-{backend,frontend}:20260922-dayclose` | 2026-09-22 12:52 | **running now** — day-close + 6 gateway migrations |
| `pos-prod-backend:20260921-m1-scripts` | 2026-09-21 03:37 | phase-2 milestone 1 |
| `pos-prod-{backend,frontend}:pre-phase2` | 2026-09-20 | last phase-1 build |

**Tag the running images before every build.** `compose build` moves `:latest`
and orphans the previous image; an orphaned image gets pruned, and then
production is running something the daemon no longer has and there is no
rollback target. This has already happened once on this stack. The
`20260922-dayclose` tags above were applied retrospectively, after a build that
did not pin one.

### B. The database is wrong but still exists

`docs/DEPLOY-PHASE2.md` §6, "Full database rollback". Read it in full — it
covers stopping the writer first, why `pg_restore --clean` is not enough, and
what `DROP SCHEMA public CASCADE` costs. **Owner approval required.**

### C. The database is gone — disk, volume or host lost

This is the one §6 does not cover, because there is no current database to dump
first. Everything since the last backup is already gone; the job is to lose no
more.

```sh
cd /home/atc-noc/atc-pos
```

**0.** Confirm you have the `.env`, and that it is the right one:

```sh
sha256sum .env      # compare against "envSha256" in the manifest beside the dump
```

A different `POS_JWT_SECRET` is survivable — every issued session becomes
invalid and staff log in again. A different `POSTGRES_PASSWORD` is not: the
stack will not start against a restored volume that expects the old one.

**1.** Bring up **only** Postgres. Not the whole stack: the backend's start
command is `npx prisma migrate deploy && node src/index.js`, and against an
empty database that creates a fresh schema which then collides with the one in
the dump.

```sh
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml ps postgres     # wait for (healthy)
```

**2.** Restore into the empty database the entrypoint just created.

```sh
DUMP=/home/atc-noc/atc-backups/pos-prod/pos-prod-<stamp>.dump
docker cp "$DUMP" pos-prod-postgres-1:/tmp/restore.dump
docker exec pos-prod-postgres-1 sh -lc \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error /tmp/restore.dump'
echo "rc=$?"      # MUST be 0
docker exec pos-prod-postgres-1 rm -f /tmp/restore.dump
```

Remove the container-side copy even if the restore failed — it is a full copy
of production data sitting on a container filesystem.

**3.** Compare against the manifest **before** letting anyone in.

```sh
docker exec pos-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAF, -c "
  select (select count(*) from \"Company\"),
         (select count(*) from \"Branch\"),
         (select count(*) from \"PosUser\"),
         (select count(*) from \"Order\"),
         (select count(*) from \"Payment\"),
         (select coalesce(sum(amount),0)::text from \"Payment\"),
         (select count(*) from _prisma_migrations where finished_at is not null)"'
```

**4.** Start the application.

```sh
docker compose -f docker-compose.prod.yml up -d
curl -fsS https://atcworkspace.com/pos/api/health
docker compose -f docker-compose.prod.yml logs --tail 40 backend
```

`migrate deploy` applies anything the image has that the dump predates. That is
forward-only and is what you want.

**Restore forward, never backward.** The image must be at or after the dump's
`migrationsApplied`. Restoring a *newer* dump under an *older* image leaves
columns in the database that the code does not know about and, worse, migration
rows the image cannot account for. If both the image and the data must go back,
move them back together.

**5.** Afterwards, every time:

- Re-run the credential rotation in `docs/DEPLOY-PHASE2.md` §5. The restored
  password hashes are the ones from the dump; any rotation done since is undone,
  and old passwords are valid again.
- Check `InvoiceCounter`. If it rewound past invoice numbers that have already
  been printed on customers' receipts, those numbers will be reissued to
  different sales. That is a GST-visible duplication and it cannot be fixed by
  restoring again — decide what to do about it before taking the next order.
- Delete any account you do not recognise. See the caveat in §6.
- Run `node deploy/pos-backup.mjs` immediately, so the recovered state has a
  backup of its own.

---

## 6. What has actually been proven, and what has not

Stated separately on purpose. The difference between "implemented" and
"verified" is the whole point of a backup policy.

**Proven, by doing it:**

- A dump of production taken at 12:50 UTC on 2026-09-22, before that day's
  deploy: `pos-prod-20260922T125500Z.dump`, 55 819 bytes. Read back with
  `pg_restore --list` — all 19 tables the database had at the time.
- **That dump was restored** into a throwaway `pos_restore_drill` with
  `--exit-on-error` and matched production exactly: Company 1, Branch 2,
  PosUser 4, Order 0, Payment 0, License 1, PosAuditLog 39, four password
  hashes intact, company name `Brew Street Café (Demo)`. The only difference,
  `_prisma_migrations` 2 vs 8, was the deploy that landed four minutes after
  the dump — the drill was right and production had moved.
- A second dump after that deploy: `pos-prod-20260922T131500Z.dump`, 72 763
  bytes, SHA-256 `dc5305cc…`, read back with `pg_restore --list` — all 22
  tables. Manifest written beside it.
- **The schedule is installed and has run.** 2026-09-22 13:33 UTC:
  `systemctl is-enabled` → `enabled`, next fire 21:01 UTC (02:31 IST). The unit
  produced `pos-prod-20260922T133322Z.dump` with a manifest recording 22 tables,
  8 migrations and 4 staff logins.
- **`deploy/pos-backup.mjs` has executed end to end**, for the first time, as
  that unit. Its own output: container running, directory mode 700, 19 327 MB
  free, 22 tables / 148 rows, archive lists all 22 tables, retention kept 4 and
  expired 0.
- **That dump was restore-drilled and passed.** `pg_restore` with
  `--exit-on-error` into a throwaway `pos_restore_drill`; all 22 tables restored
  to the counts the manifest recorded; 4 staff logins survived with their
  password hashes intact; the drill copy was dropped afterwards.

**Not proven:**

- **The money comparison is vacuous.** `paymentAmountSum` is 0, because no real
  sale has been taken yet. A drill that matches 0 against 0 has demonstrated
  nothing about money. **Re-run `--drill` once the café has billed for a day**;
  that is the run that actually tests whether takings survive a restore, and
  until it happens this row belongs under "not proven" rather than above.
- There is no off-host copy of anything. Both dumps and the database they came
  from are on the same disk. That is not a backup policy, it is a
  faster-to-restore copy, and it does not survive the loss of this machine.
- Nobody has restored into a *rebuilt* host, only into a container that was
  already running. §5-C is written but has not been walked end to end.

**The drill's baseline is the manifest, not live.** Worth understanding before
reading a failure. A backup restores to the database as it *was*; live is that
database plus everything written since, so comparing the two fails every backup
for the crime of being older than now. Measured here on 2026-09-22, before this
was corrected: a byte-perfect restore reported PosUser 10 vs 4 and PosAuditLog
59 vs 69 and concluded "NOT proven restorable". Nothing was wrong with the
backup. Live is still read, but only to report how far the database has moved on
since — which is the data-loss window, and the number an operator actually
wants.

**Caveat on `pos-prod-20260922T131500Z.dump`:** it was taken while another
acceptance probe was mid-run, so it very likely contains two short-lived probe
accounts whose passwords nobody holds. They are inert rows in the demo tenant,
but delete them after any restore from that file. It is also the reason not to
take a backup while a probe is running.

---

## 7. Known gaps

1. **No off-host copy.** Highest-value next step by a wide margin. One `scp` to
   another machine, or an object store with a write-only credential, changes
   this from "survives a bad migration" to "survives losing the server".
   **The procedure is now written out in §8** — it is waiting on one decision
   (where to) and one key, both of which only the owner can supply.
2. **No alerting.** §3.
3. **No restore-time objective.** Nobody has timed a full §5-C recovery. Until
   someone has, "how long would we be down" has no answer.
4. **The `.env` has no second copy.** §1.
5. **The drill has never seen real money.** §6. Re-run `--drill` after the first
   full day of billing.

---

## 8. Getting a copy off this host

**Status: written, not yet run.** Nothing in this section has been executed,
because it cannot be until someone names a destination. Treat every command
below as a draft to be tested the day the destination exists, not as something
already working. The rest of this document distinguishes carefully between
proven and assumed, and this section is entirely on the assumed side.

### Why this is the gap worth closing first

The nightly dump and the database it was taken from are on the same disk, in
the same machine, in the same room. That arrangement survives a bad migration,
a dropped table and a broken deploy — which is most of what goes wrong, and is
why it was worth building. It does not survive the one failure that ends a
business: the machine is gone, stolen, encrypted by someone else, or simply
does not come back.

The good news is that this is cheap. A POS dump of this café is **about 70 KiB**
and the whole retained set is **under 300 KiB**. There is no bandwidth problem,
no storage cost worth discussing, and no reason to sample or thin the data. A
decade of daily backups would fit in a few hundred megabytes.

### What must be true of the destination

1. **It is somewhere else.** A second machine in the same rack protects against
   a disk failure and nothing else. If the destination shares a room, a mains
   supply or a landlord with the POS host, it is a second copy, not an off-host
   copy. Say so plainly rather than quietly counting it.
2. **The POS host cannot erase its own history.** If the credential stored here
   can delete what it uploaded, then whoever takes this host also takes the
   backups. Use an append-only bucket policy, or on an SSH destination a
   `restrict` + forced-command key that only permits writes.
3. **It receives ciphertext.** The dump contains staff password hashes, customer
   order history and company registration details. It leaves this host encrypted
   or it does not leave.

### The encryption choice, and why it is this way round

Encrypt to a **public key whose private half never touches this machine**.

That is the whole point. Symmetric encryption — `gpg --symmetric`, or
`openssl enc` with a passphrase — requires the passphrase to sit on the POS host
so the nightly job can run unattended. Anyone who takes the host takes both the
archives and the means to read them, and the encryption has bought nothing
against the threat it was added for.

With a keypair, this host holds only the public key. It can write backups it
cannot itself read. Recovery needs the private key, which lives with the owner.

**The owner generates the keypair, on the owner's own machine, and sends only
the public half.** Not because ATC cannot generate one, but because a private
key generated here would have to be transmitted to the owner to be useful — and
secrets that get transmitted get pasted into chat windows and ticket systems.
The only key material that should ever cross is the half that is safe to
publish.

On the owner's machine, once:

```sh
gpg --quick-generate-key "VEXO Connect backups <you@example.com>" rsa4096 encr never
gpg --armor --export "VEXO Connect backups" > vexo-backup-public.asc   # send this
gpg --armor --export-secret-keys "VEXO Connect backups" > KEEP-OFFLINE.asc
```

`KEEP-OFFLINE.asc` and its passphrase go wherever you keep things you cannot
afford to lose, which is not this server and not an inbox. **If that key is
lost, every off-host backup is unreadable.** That is the correct behaviour and
it is also the obvious way to lose everything, so write down where it went.

On the POS host, once:

```sh
gpg --import vexo-backup-public.asc
gpg --list-keys                      # note the key ID for the step below
```

### The procedure

Run after the nightly backup, not instead of it. §2's timer still owns taking
the dump; this only copies what that produced.

```sh
#!/bin/sh
# Ship the newest POS backup off this host. Encrypt, send, verify, then stop.
set -eu

SRC=/home/atc-noc/atc-backups/pos-prod
STAGE=/home/atc-noc/atc-backups/outbound
RECIPIENT='VEXO Connect backups'       # the imported public key
DEST_USER=''                           # <- owner supplies
DEST_HOST=''                           # <- owner supplies
DEST_PATH=''                           # <- owner supplies
SSH_KEY=/home/atc-noc/.ssh/pos_backup_offhost

[ -n "$DEST_HOST" ] || { echo "no destination configured — see BACKUP-RESTORE.md §8"; exit 2; }

mkdir -p "$STAGE"; chmod 700 "$STAGE"

# Newest dump and its manifest. The manifest is what makes a restored copy
# checkable, so it travels with the dump, never separately.
DUMP=$(ls -1t "$SRC"/pos-prod-*.dump | head -1)
MANIFEST="${DUMP%.dump}.manifest"
STAMP=$(basename "$DUMP" .dump)

tar -C "$SRC" -cf - "$(basename "$DUMP")" "$(basename "$MANIFEST")" \
  | gpg --batch --yes --trust-model always --encrypt --recipient "$RECIPIENT" \
        --output "$STAGE/$STAMP.tar.gpg"

sha256sum "$STAGE/$STAMP.tar.gpg" | awk '{print $1}' > "$STAGE/$STAMP.tar.gpg.sha256"

rsync -a --chmod=F600 -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=yes" \
  "$STAGE/$STAMP.tar.gpg" "$STAGE/$STAMP.tar.gpg.sha256" \
  "$DEST_USER@$DEST_HOST:$DEST_PATH/"

# Verify the bytes that arrived, not the bytes that were sent. An rsync that
# exits 0 has told you the transfer did not error, which is a different claim.
REMOTE=$(ssh -i "$SSH_KEY" "$DEST_USER@$DEST_HOST" "sha256sum $DEST_PATH/$STAMP.tar.gpg" | awk '{print $1}')
LOCAL=$(cat "$STAGE/$STAMP.tar.gpg.sha256")
[ "$REMOTE" = "$LOCAL" ] || { echo "FAIL: off-host copy does not match ($STAMP)"; exit 1; }

rm -f "$STAGE/$STAMP.tar.gpg" "$STAGE/$STAMP.tar.gpg.sha256"
echo "PASS: $STAMP copied off-host and verified by hash"
```

Once it has been run by hand successfully, add it to the tail of
`atc-pos-backup.service` as a second `ExecStart=`, so the copy cannot silently
drift out of step with the dump it belongs to.

### Proving it, which is the part everyone skips

An off-host copy nobody has ever decrypted is a tar file of unknown value. The
drill in §4 exists because the same was true of the local dumps. Repeat it for
the remote ones, **on the owner's machine, with the owner's private key**, and
make it a calendar item rather than an intention:

```sh
scp DEST_USER@DEST_HOST:DEST_PATH/pos-prod-YYYYMMDDTHHMMSSZ.tar.gpg .
gpg --decrypt pos-prod-YYYYMMDDTHHMMSSZ.tar.gpg | tar -xf -
# then §4's drill against the extracted .dump
```

The first time this is done, record how long the whole path took — download,
decrypt, restore, verify. That number is the restore-time objective this project
does not yet have (§7.3), and it is impossible to guess and easy to measure.

### What is still needed to finish this

Everything below is a decision or a credential that ATC cannot make or create
on the owner's behalf:

| # | Needed | Why it cannot be decided here |
|---|---|---|
| 1 | **Where the backups go** — a host + SSH user + path, or an object-store endpoint + bucket | It is a cost and trust decision about the owner's data |
| 2 | **Confirmation it is physically elsewhere** | Only the owner knows where their other machines are |
| 3 | **The GPG public key** (`vexo-backup-public.asc`) | The private half must be generated by, and stay with, the owner |
| 4 | **An SSH key authorised at the destination**, ideally write-only | Requires access to the destination's `authorized_keys` |
| 5 | **How many days to retain off-host** | Local policy is 14 days / minimum 3; off-host can afford far longer at this size |
| 6 | **Whether `.env` should travel too** (encrypted) | §7.4: the dump alone cannot rebuild a running system without those secrets, but it is the owner's call whether a copy of them leaves the host at all |

Item 3 is the one to start with: it is free, takes a minute, and nothing else
can be tested without it.
