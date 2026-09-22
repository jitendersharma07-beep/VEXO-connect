# ATC POS — backup and restore runbook

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

**This has not been done yet.** Until it is, backups are manual, which means
they are not happening.

```sh
sudo cp /home/atc-noc/atc-pos/deploy/systemd/atc-pos-backup.service /etc/systemd/system/
sudo cp /home/atc-noc/atc-pos/deploy/systemd/atc-pos-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atc-pos-backup.timer

# prove it once — do not wait until 02:30 to find out
sudo systemctl start atc-pos-backup.service
systemctl status atc-pos-backup.service --no-pager
journalctl -u atc-pos-backup.service -n 40 --no-pager

# and prove the file it produced is restorable
node /home/atc-noc/atc-pos/deploy/pos-backup.mjs --drill
```

The unit runs as `atc-noc`, who must be in the `docker` group:

```sh
id -nG atc-noc | tr ' ' '\n' | grep -x docker    # must print: docker
```

It deliberately does **not** run as root. Nothing here needs it, and a
root-owned backup directory is one more thing a recovery has to fight at the
worst possible moment.

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

**Not proven:**

- **`deploy/pos-backup.mjs` has never been run end to end.** Every invocation,
  including `--check`, was refused by the sandbox in which it was written. Each
  individual operation it performs was carried out by hand and worked; the
  script as a program has not executed once. Treat §2's `systemctl start` as
  its first real run and read the output.
- **The schedule is not installed.** §2 is an outstanding action.
- The post-deploy dump has **not** been restore-drilled — only its table list
  was verified.
- There is no off-host copy of anything. Both dumps and the database they came
  from are on the same disk. That is not a backup policy, it is a
  faster-to-restore copy, and it does not survive the loss of this machine.

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
2. **No alerting.** §3.
3. **No restore-time objective.** Nobody has timed a full §5-C recovery. Until
   someone has, "how long would we be down" has no answer.
4. **The `.env` has no second copy.** §1.
5. **Schedule not installed.** §2.
