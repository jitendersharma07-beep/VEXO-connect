# v1.0.1 production deploy — WITHDRAWN, see `DEPLOY-OWNER.md`

**This claim is withdrawn.** Session `bc4e7056` claimed the v1.0.1 deploy at
2026-09-23 06:24:21Z and released it at 06:26Z, unexecuted. Nothing was built,
tagged, migrated or deployed under it.

**The owner is session `896234f0`, from 06:20Z — four minutes earlier.** Read
`DEPLOY-OWNER.md`; this file is only here so the collision is on the record.

## How two sessions both claimed it

Ordinary race, worth writing down because the convention is supposed to stop
exactly this and nearly didn't:

| Time (Z) | Event |
|---|---|
| 06:20 | `896234f0` claims the deploy |
| 06:21:51 | `bc4e7056` reads the branch — head is `f841ca2`, no owner file exists yet |
| 06:22:46 | `896234f0`'s claim lands as `7bf459e` |
| 06:23:15 | `896234f0` merges `phase2-integration` as `7f3d22e` |
| 06:24:21 | `bc4e7056` commits its own claim as `5078fe0`, on top, still unaware |
| 06:24:42 | `bc4e7056` reads `DEPLOY-OWNER.md` and stands down |

The claim was made *before* the file existed and committed *after* it did. A
read of the branch is a snapshot, not a lock, and a 90-second gap between
deciding and committing was enough. The lesson is not "check harder" — it is
that the check and the claim have to be the same operation, or a re-read
immediately before the first mutating step has to be part of the procedure.

What made this cheap rather than expensive: the claim was the first thing
either session wrote, and a docs commit is not a deploy. Had the order been
"tag the images, then claim", two sessions would have retagged the same
rollback anchors four minutes apart and neither tag would name what was
running. Claim first.

## What `bc4e7056` did NOT do

No production mutation of any kind. Specifically: no image retag, no
`docker compose build` / `up` / `restart`, no `pg_dump`, no `prisma migrate
deploy`, no DDL, and no write to `atc_pos` by any route. `pos-prod` containers
are still the 04:01Z set and image tags are unchanged from 02:22Z.

The deploy tree `/home/atc-noc/atc-pos` was left where it was found:
`phase2-gateway` at `d899cc6`, working tree clean. It was never detached.

## What is handed over

`896234f0` has the deploy. The hardware-UAT lane (`phase2-hardware-uat`,
`0688f65`) holds two things it may want after v1.0.1 is up:

- `docs/UAT-HARDWARE-RUNBOOK.md` §0.1 — the STOP block naming both fixes as
  undeployed. **It needs updating once v1.0.1 ships**; its evidence lines are
  content checks that will flip.
- `deploy/uat-catalog-prep.mjs` — archives the two remaining `UAT Filter
  Coffee` products through the audited catalog API and creates the long-name
  demo product for the print wrap test. Written, syntax-checked, **never run**.
  It needs the demo owner's password, so it is the operator's to run, and it
  should run against the deployed v1.0.1 rather than this build.

Physical printing, paper width and 58 mm remain **NOT TESTED** either way. No
printer is attached, and nothing in this release changes that.
