# Browser UAT till — reserved

Same purpose as `GATEWAY-TESTING-OWNER.md`, for a different piece of shared
mutable state. It is in the repo so every session sees it without being told
to look.

**Reserved: `Brew Street Café — Cyber Hub` (`BSC-CH`), demo company, for the
browser acceptance run. Held by the integration lane, branch
`phase2-integration`, from 2026-09-23 00:28 IST, business date `2026-09-23`.**

> Taken over from the release-verify lane (branch `phase2-release-docs`),
> which reserved it at 2026-09-22 23:10 IST for business date `2026-09-22`
> and did not run. That lane is idle — clean worktree at `9b5020e`, no node
> process — and its date has expired with the midnight roll, so this is a
> re-reservation for a new date rather than a contested hand-off. Rechecked
> at 00:28 IST: BSC-CH reads 0 orders ever, 0 today, 0 closings today.

## What is reserved

Every **write** to `BSC-CH` in the demo company: orders, KOTs, payments,
refunds, and above all the daily closing. Reads are fine — open it, look at
it, screenshot it.

`Brew Street Café — Connaught Place` (`BSC-CP`) is **not** reserved and is
untouched by this run. It already carries the HTTP acceptance traffic and is
the branch the isolation checks read *from*.

## Why a branch needs reserving at all

A `DayClose` is permanent and there is one per (branch, business date). The
run has to file a real one to prove the commit path, and the only honest place
to file it is a till whose entire trade for that date is the run's own —
otherwise the closing covers someone else's activity and the figures on it are
not a statement anyone can check.

So the harness refuses to start if the chosen till has **any** order or **any**
closing for the business date. That rail is doing its job when it fires, but it
means a single stray test order from another window, at any point before the
run, silently costs the day.

**Cyber Hub having zero orders does not make it mine.** Zero is a snapshot, not
a claim. As of 2026-09-22 23:10 IST it reads 0 orders ever, 0 today, 0 closings
today — and that sentence expires the moment somebody else writes to it. This
file is the part that does not expire.

## Recheck immediately before running

Do not trust the numbers above. They were true when written.

```sh
docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos -tA <<'SQL'
select 'BSC-CH today: orders=' || (select count(*) from "Order" o join "Branch" b on b.id=o."branchId"
    where b.code='BSC-CH'
      and (o."createdAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date
          = (now() at time zone 'Asia/Kolkata')::date)
    || ' closings=' || (select count(*) from "DayClose" d join "Branch" b on b.id=d."branchId"
    where b.code='BSC-CH'
      and d."businessDate" = to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD'));
SQL
```

Both must read `0`. If either does not, find out who wrote it before doing
anything else — the harness will refuse anyway, and it is right to.

## The business date rolls at midnight IST

`businessDate` is a text `YYYY-MM-DD` in IST. This file was written at
**23:10 IST**, so the reservation for `2026-09-22` has under an hour left in
it. Running after midnight is not a problem and is arguably cleaner — the
date becomes `2026-09-23` and the zero-activity precondition resets by itself.
Just take the date from the recheck above rather than from this file.

## Releasing it

Delete this file, or replace the owner line. Once the run has filed its
closing the reservation has served its purpose: that business date on that
till is spent either way, and the next run needs a fresh date, not this file.
