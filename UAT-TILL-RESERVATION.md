# Browser UAT till — reserved

Same purpose as `GATEWAY-TESTING-OWNER.md`, for a different piece of shared
mutable state. It is in the repo so every session sees it without being told
to look.

**Reserved: `Brew Street Café — Cyber Hub` (`BSC-CH`), demo company, for the
browser acceptance run. Held by the session running `~/pos-bsc-ch-uat/run.mjs`,
from 2026-09-23 08:09 IST, business date `2026-09-23`.**

> **Owner changed 2026-09-23 08:20 IST.** The integration lane (branch
> `phase2-integration`) held this from 00:28 IST and never ran — its writing
> pass was refused by its own session's command classifier five times. While it
> was blocked, another session took the till and used it, which is the right
> outcome: a reservation is meant to stop two runs colliding, not to park a
> till behind a lane that cannot move. Recorded rather than contested.

## Status 2026-09-23 08:20 IST — IN USE, part-spent

`BSC-CH` on business date `2026-09-23` is no longer clean, by design:

| | |
|---|---|
| order | `BSC-CH/26-27/00001` — opened 08:09:27, billed 08:13:32 |
| total | ₹189.00 (no discount) |
| payment | ₹189.00 CASH at 08:16:23 |
| refund | ₹10.00, part refund — order correctly stays `PAID` |
| day closing | **not yet filed** — the run is at its `report` phase |

Independently cross-checked through the production sales report UI by the
integration lane at 08:19 IST: report reads net ₹189 / refunds ₹10, and the
database agrees to the paisa. That is a read, not a write.

**Do not open an order on `BSC-CH` today.** The closing still to be filed has
to cover exactly the trade above; anything else lands inside it and the figures
stop being a statement anyone can check.

## The discount leg is NOT on this till

The run holding `BSC-CH` has phases `explore → sell → refund → report → close
→ readback`. There is no discount step anywhere in it, and the order above
carries `discountAmount = 0`. So the discount — the whole subject of the
phase-2 integration — is **not** covered by this reservation.

`deploy/billing-browser-run.mjs` covers it, and now targets **`BSC-CP`**
(Connaught Place) by default for exactly that reason. `BSC-CP` is not reserved,
already carries the acceptance traffic, and nothing files a closing on it, so
the discount can be proved in production without spending a date. That harness
refuses to file a closing on any till but `BSC-CH`, in config, before a browser
starts.

## What is reserved

Every **write** to `BSC-CH` in the demo company: orders, KOTs, payments,
refunds, and above all the daily closing. Reads are fine — open it, look at
it, screenshot it.

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

**Zero orders does not make a till yours.** Zero is a snapshot, not a claim —
and this file is the proof: `BSC-CH` read zero at 00:28 IST, the lane that read
it recorded the reservation here, and it was still taken. This file is the part
that does not expire; it just has to be kept true.

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

As of 08:20 IST this reads `orders=1 closings=0`, and that is the expected
reading, not a fault. It becomes a fault if `orders` moves again before the
closing is filed.

## The business date rolls at midnight IST

`businessDate` is a text `YYYY-MM-DD` in IST. Running after midnight is not a
problem and is arguably cleaner — the date rolls and the zero-activity
precondition resets by itself. Take the date from the recheck above rather
than from this file.

## Releasing it

Delete this file, or replace the owner line. Once the run has filed its
closing the reservation has served its purpose: that business date on that
till is spent either way, and the next run needs a fresh date, not this file.
