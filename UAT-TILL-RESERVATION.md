# Browser UAT till — reserved

Same purpose as `GATEWAY-TESTING-OWNER.md`, for a different piece of shared
mutable state. It is in the repo so every session sees it without being told
to look.

**RELEASED 2026-09-23 08:23 IST.** `Brew Street Café — Cyber Hub` (`BSC-CH`),
demo company, was held for the browser acceptance run by the session running
`~/pos-bsc-ch-uat/run.mjs` from 08:09 IST. That run filed its closing on
business date `2026-09-23` and is done. **No till is reserved right now** — but
read the next section before writing to `BSC-CH` *today*.

> **Owner changed 2026-09-23 08:20 IST.** The integration lane (branch
> `phase2-integration`) held this from 00:28 IST and never ran — its writing
> pass was refused by its own session's command classifier five times. While it
> was blocked, another session took the till and used it, which is the right
> outcome: a reservation is meant to stop two runs colliding, not to park a
> till behind a lane that cannot move. Recorded rather than contested.

## Status 2026-09-23 08:23 IST — SPENT, closing filed. Released.

The run finished. `BSC-CH` on business date `2026-09-23` is closed:

| | |
|---|---|
| order | `BSC-CH/26-27/00001` — opened 08:09:27, billed 08:13:32 |
| total | ₹189.00 (no discount) |
| payment | ₹189.00 CASH at 08:16:23 |
| refund | ₹10.00, part refund — order correctly stays `PAID` |
| day closing | **filed 08:22:47 IST**, `cmudicq7o0024n36yaq3ygcv5` — counted ₹179.00, float ₹0.00, expected ₹179.00, **variance ₹0.00**, 1 bill |

Independently cross-checked through the production sales report UI by the
integration lane at 08:19 IST: report reads net ₹189 / refunds ₹10, and the
database agrees to the paisa. That is a read, not a write.

**This reservation is now released** — see *Releasing it* below. It is kept
here rather than deleted because the release is the useful part of the record:
the next run needs to know the date was spent, not that a file once existed.

**`BSC-CH` on `2026-09-23` is finished — do not write to it again today.** Not
because anything is reserved any more, but because the closing is permanent and
already filed. A further order on this till today would sit outside it, and a
second closing would only be recordable as a correction against a run that was
deliberately proved correct. **The next run needs a fresh business date**, on
this till or any other.

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

As of 08:23 IST this reads `orders=1 closings=1` — the finished state. Nothing
further is expected to move on this till today. If a later reader sees
`closings=2`, a correction was filed after the fact and the run's headline
result needs re-reading before it is quoted.

## The business date rolls at midnight IST

`businessDate` is a text `YYYY-MM-DD` in IST. Running after midnight is not a
problem and is arguably cleaner — the date rolls and the zero-activity
precondition resets by itself. Take the date from the recheck above rather
than from this file.

## Releasing it

Delete this file, or replace the owner line. Once the run has filed its
closing the reservation has served its purpose: that business date on that
till is spent either way, and the next run needs a fresh date, not this file.
