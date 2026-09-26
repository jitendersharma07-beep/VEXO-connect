# Per-test wipe: what it costs, and the invariant that keeps it cheap

Measured 2026-09-26. Subject: `94fec3d`, which changed `wipeAll()` from
`TRUNCATE ... RESTART IDENTITY CASCADE` over every table to a probe for dirty
tables followed by `DELETE` on only those.

This document exists because the cheap path depends on a property that is easy
to destroy by accident and produces no error when you do. See
[The invariant](#the-invariant) if you are reading this before changing the
helper.

At the time of writing the function lives in `backend/tests/helpers/`. The
invariant below travels with the `cachedPlan.probe` string, not with the file,
so a module move does not affect it.

## Why it was measured at all

`wipeAll()` runs in `beforeEach`, so it executes before every test in the files
that use it — roughly 150 calls per run across the five inventory suites. On
2026-09-26 it stopped being merely slow and started failing runs outright:
`Hook timed out in 30000ms` in `inventoryScheduler`'s `beforeEach`, which is
this function.

## Method

Both arms were run, rather than the new path alone — the same approach used for
the `LoyaltyProfileLink` cascade index, and for the same reason: a fix measured
only in its presence tells you nothing about what it bought.

- **Arm A** — the old statement, `TRUNCATE` over all 139 tables.
- **Arm B** — the new path, replicated statement for statement: probe,
  early-return when clean, else referential integrity off for one transaction,
  `DELETE` the dirty tables, reset sequences.

Two private databases, both freshly migrated: 139 tables, 532 indexes, 1
sequence. Another lane was running its own suite throughout (loadavg 11.9–14.5),
so cycles **interleaved** A and B and alternated which ran first — both arms had
to see the same load for the comparison to mean anything. Timing is server-side
via `clock_timestamp()`, which excludes client round trips.

## Results

Twelve cycles, each preceded by a fixture dirtying 7 of the 139 tables:

| arm | min | median | max |
|---|---|---|---|
| A — `TRUNCATE` | 1731.4 ms | **2223.5 ms** | 8853.0 ms |
| B — probe + `DELETE` | 160.1 ms | **174.0 ms** | 222.6 ms |

The clean case — a wipe with nothing to do, which is what most `beforeEach`
calls actually face:

```
A   14587 · 1599 · 2891 · 2387 · 2266 ms
B     154 ·  178 ·  182 ·  192 ·  164 ms
```

A single `TRUNCATE` of **14,587 ms against a database with nothing in it** is
49% of the 30,000 ms `hookTimeout` that was failing, and 73% of a 20,000 ms
`testTimeout`. The cost was never the rows. It is that `TRUNCATE` gives all 139
tables and their 532 indexes a fresh relfilenode on every call — ~671 files
created and unlinked, on a disk several lanes are running suites against.

## The invariant

**The probe's cost is query planning, not execution, and it is paid once per
backend only because the probe string never changes.**

The probe is a 139-branch `UNION ALL`, 14,618 characters. Splitting the two:

```
EXPLAIN ANALYZE   run 1   planning 167.70 ms   execution 5.83 ms    <- 97% planning
                  run 2   planning   8.61 ms   execution 2.90 ms
                  run 3   planning   8.33 ms   execution 2.98 ms

prepared stmt     #1 178.99 ms | #2 2.97 | #3 3.66 | #4 3.06 | #5 2.35 | #6 1.71 | #7 1.64 | #8 1.49
```

`cachedPlan.probe` is built once and reused, so every call sends a byte-identical
string and Postgres serves it from the prepared-statement plan cache. That is
the whole reason the steady-state cost is ~3 ms instead of ~179 ms.

**What breaks it.** Any change that makes the probe string vary between calls —
building it per call, filtering the table list by what the test is expected to
dirty, interpolating a timestamp or a test name, appending a comment. Each of
those defeats the plan cache and silently reinstates ~179 ms per call, which at
~150 calls is ~27 s per run. There is no error and no failing test; the suite
just gets slow again.

If you need to change the probe, keep it constant per process and measure
planning separately from execution — a wall-clock number alone will not show you
which half you changed.

## Steady-state cost

| | per call |
|---|---|
| old | 2,224 ms (median), every call |
| new — cold | 179 ms, once per backend |
| new — warm | 1.5–3.7 ms, every call thereafter |

At ~150 calls per run: **~334 s of `TRUNCATE` before, ~0.5 s after**, plus one
~179 ms plan for each connection the pool opens. Prisma retires idle connections
roughly every 300 s, so a long run pays that a handful of times. It is
per-backend, not per-call.

## The risk that was checked and not found

`DELETE` leaves dead tuples where `TRUNCATE` unlinks the relfilenode, and the
probe is `exists (select 1 from t)` — which on a table holding only dead tuples
must read every page to conclude "empty". That is a design that can look
excellent on the first call and degrade across a run, and it was the one thing
that would have sunk this change.

It did not occur. Arm B is flat across all twelve cycles (160–223 ms, no trend).
After twelve fill/wipe cycles B held 252 dead tuples against A's 48, and B's
database was *smaller* than A's — 16 MB against 17 MB.

**Caveat, stated rather than buried.** The fixture used here leaves 7 dirty
tables and a couple of dozen rows, which is the shape the suite actually
produces. A suite leaving thousands of rows per test would accumulate faster,
and the thing to watch in that case is the probe, not the deletes. It is bounded
by autovacuum, not by this design.

## Verdict

`94fec3d` is sound and the claim in its message holds. The `2274ms -> 6ms`
figure is the warm path and is correct; an early measurement of 174 ms was a
harness artefact — plpgsql `EXECUTE` re-plans on every call by design, so it
measured the cold path twelve times over.

## Evidence

Under `~/vexo-connect-x-evidence/integration/`:

- `20260926-0609Z-wipe-94fec3d-split.witness` — analysis
- `20260926-0609Z-wipe-94fec3d-split.log` — raw run
- `20260926-0609Z-wipe-94fec3d-split.sh.asrun` — the runner, as executed

Related, measured the same way: the `LoyaltyProfileLink` cascade index
(`d625370`) at `20260926-0518Z-index-split.witness` — 13,222 ms with the index
against 642,838 ms without.
