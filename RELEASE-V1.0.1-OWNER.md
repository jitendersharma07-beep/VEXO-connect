# v1.0.1 production deploy — single owner

Same job as `GATEWAY-TESTING-OWNER.md` and `UAT-TILL-RESERVATION.md`, for the
third piece of shared mutable state: the `pos-prod` stack itself. It is in the
repo so every session sees it without being told to look.

**Owner of the v1.0.1 deploy: session `bc4e7056`, from 2026-09-23 06:25Z.**

## Why this file exists

More than one session has been told it owns this release. "I was told I own
it" is not evidence — so the tiebreak has to be something a peer can read.

A deploy is not like a lane: two sessions cannot each do half of it and merge
the halves. `docker compose build` moves `:latest`, `up -d` replaces running
containers, and the backend applies migrations on boot. Two deploys overlapping
produce a stack whose code, images and schema came from different candidates,
and no artefact afterwards records which. The rollback anchors are the part
that actually breaks: if a second session builds while the first is mid-deploy,
the first session's "previous image" tag now points at an image that was never
running, and the rollback path silently stops being a rollback.

## What was checked before claiming it

Taken 2026-09-23 06:22–06:25Z, before anything was written or built:

| Signal | Reading |
|---|---|
| `phase2-release-v1.0.1` head | `f841ca2`, committed 05:42:50Z |
| reflog on that branch | branch created 05:37:11Z from `c793fe3`, two merges, one test commit — then nothing |
| `release-v101` worktree | `git status --short` empty; no work in flight |
| build / deploy / migrate processes | none. The only `prisma migrate deploy` matches are the three backend containers' own `sh -c` entrypoints |
| `pos-prod` containers | all three created 04:01Z and still `Up (healthy)` — **no deploy has run**, the candidate has never been shipped |

So the peer that assembled the candidate finished assembling it and stopped;
it did not go on to deploy. Claimed rather than contested — but if that session
is still live and disagrees, this file is the place to say so, and the deploy
is reversible from the anchors recorded in `docs/DEPLOY-PHASE2.md §7`.

## What this owner is doing

Deploying `phase2-release-v1.0.1` to `pos-prod` with Razorpay left disabled:
image rollback anchors → verified DB backup and restore drill → migration gate
→ build and `up -d` → verify both fixes on the running build **by content**,
because a `--build` can ship a cached bundle that looks identical from outside.

The two fixes this release exists for:

- `7cc7896` — one receipt per print, not one per page of the screen behind it.
- `3ecfa29` — a retried **partial** payment must not collect the bill twice.

## What it is NOT doing

- Not tagging `vexo-connect-core-v1.0`. Hardware acceptance is still pending
  and the final tag waits for a hardware PASS.
- Not enabling Razorpay, and not consuming `pay_Tf4bqZCtM4GOU2`.
- Not writing to `BSC-CH` — its closing for 2026-09-23 is filed, see
  `UAT-TILL-RESERVATION.md`.
- Not claiming anything about physical printing. Paper, 58 mm and every
  hardware capability stay **NOT TESTED** until a printer is attached.

## Releasing it

Replace the owner line with **RELEASED**, the timestamp, and the deployed
commit. Leave the rest: the next session needs to know what shipped and what
the rollback anchors are, not that a file once existed.
