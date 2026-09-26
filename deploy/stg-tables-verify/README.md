# Staging verification matrix — candidate `16a22b0` (tables lane)

Six phases that exercise a **deployed** VEXO Connect stack through its real
reverse proxy, plus its production configuration. Observed on
`pos-stgtbl @ 16a22b0`, 2026-09-26:

```
235 checks passed · 0 failed · phases 1-5 exit 0     (functional, against the running stack)
 22 checks passed · 0 failed · phase F  exit 0     (production boot guards, config only)
```

Full evidence, including the GO/NO-GO verdict, is in
[`docs/STAGING-TABLES-16A22B0-EVIDENCE.md`](../../docs/STAGING-TABLES-16A22B0-EVIDENCE.md).

## Why this exists alongside the 1767-test backend suite

The unit suite proves these routes **against the code**. This proves them
**against a deployment**: through the nginx `/pos/` prefix strip and cookie-path
rewrite, the built image's compiled Prisma client, and a really-migrated
database. Those are different claims and must not be conflated — a green unit
suite has never once caught a mis-wired `POS_QR_BASE_URL` or a missing enum value
in a deployed DB.

| Phase | Covers |
|---|---|
| `01-auth.mjs` | login, the forced password change, role isolation, tenant scope |
| `02-tables.mjs` | table transfer, split bill, **merge** (incl. the `MERGED` enum against real SQL) |
| `03-commerce.mjs` | QR order → submission → KOT → kitchen board; bill, payment, refund, receipt |
| `04-promotions.mjs` | authoring authority, store targeting, discount arithmetic, stacking, limits |
| `05-reports.mjs` | sales report, day close and corrections, activity log |
| `06-prod-boot-guards.mjs` | the production-only `config/env.js` guards (see caveat below) |

## Running it

The harness needs a `secrets/` directory **one level up from itself**, holding a
`creds.txt` of `email password` lines for the four seeded roles. That directory
is deliberately **outside this repository** and must stay that way — so run the
harness from the staging deployment directory, not from a source checkout:

```bash
cd <staging-dir>            # e.g. ~/pos-stg-tables-16a22b0
cp -r <repo>/deploy/stg-tables-verify verify
mkdir -p secrets && chmod 700 secrets
( umask 077; docker exec <backend-container> node prisma/seed.js > secrets/seed-output.txt 2>&1 )
# transcribe the four `email password` pairs into secrets/creds.txt (0600)

POS_BASE=http://127.0.0.1:8113/pos node verify/01-auth.mjs   # then 02 … 05
```

`POS_BASE` defaults to `http://127.0.0.1:8113/pos`. Point it at whichever stack
you are gating; always include the path prefix, because probing the container at
`/` skips the very rewrites this harness exists to test.

Phase 1 writes `.tokens.json` and `.ids.json` at `0600` for the later phases, so
no phase re-logins and burns the rate limiter (10 failures / 15 min / IP).
Phase 1 also **rotates** the seeded passwords — because the seed mints generated
ones and correctly demands a change — and writes `secrets/creds-rotated.txt` at
`0600`. It prefers that file on subsequent runs.

## All five phases are re-runnable

This is a requirement, not a convenience: "fix failures and repeat only the
necessary gates" is only possible if a gate can actually be repeated. Each phase
resets its own fixtures **through real routes** — voiding open bills, closing open
dining visits, archiving leftover campaigns, chaining a day-close correction, and
tagging promotion codes per run (an archived campaign owns its code forever, by
design, since an old bill still points at it).

## Reading the output

`check()` prints its detail on **PASS as well as FAIL**. So a detail phrased as
the failure — `"840 + 42 ≠ 882"` — makes a green line read like a red one. Pass
`''` when the claim holds. Several early false alarms in review were exactly this.

## `06-prod-boot-guards.mjs` — the phase that is *not* about this deployment

Staging runs `NODE_ENV=development` (forced: `config/env.js` refuses a non-https,
loopback `POS_QR_BASE_URL`), which is precisely the branch that **skips** the
production boot guards. Without this phase, the first time those guards ever run
would be against production.

So it runs them here as pure configuration validation: `config/env.js` is imported
in a child process **inside the production image** with a candidate environment,
and the result recorded. **No server starts, no socket opens, no database is
touched, no hostname is published.** The baseline values are *shapes*, not
credentials — `x`×48, `a`×64, `https://pos.example.com/pos`.

**Two-sided on purpose.** "Production config loads" would also pass if every
guard had been deleted, so each refusal is asserted **by its own message** too. A
refusal carrying the wrong message means a different guard fired and the intended
one may be gone. That design earned its keep immediately: when the
missing-`DATABASE_URL` probe was fixed, the message assertion is what proved the
fix was real rather than an unrelated error masquerading as a refusal.

One phase-F check exists to demonstrate rather than assert the deviation above:
**development genuinely does accept** the loopback QR base that production
refuses.

### The `docker exec -e` trap this phase walked into

A null override means "this variable must be **absent**". The first draft
implemented that by dropping the key from the `-e` list — which does not work, and
produced a false FAIL reading *"guard is not armed"*.

`docker exec -e` can only **set or override** a variable, never **unset** one, and
the container already carries its own `DATABASE_URL` from compose. Omitting the
flag therefore meant "do not override it": `env.js` found a perfectly good URL and
loaded. The guard was armed the whole time (`env.js:15`,
`DATABASE_URL: required('DATABASE_URL')`). `env -u VAR` inside the container is
what actually removes it.

## A red check is a hypothesis about the harness too

Twenty-one checks failed while this matrix was being written. **Every single one
was the assertion being wrong, not the application** — guest identity is a header
and not a cookie; a cashier is *supposed* to be able to transfer and merge;
`netSales` is tax-inclusive; `docker exec -e` cannot unset a variable. Each
correction is commented in the file that carries it rather than silently flipped,
because the alternative — relaxing an assertion until it passes — yields the same
green log and proves nothing.

So treat a red line here as a hypothesis about **either** the app **or** the
check, and find out which before touching either. Track record so far: 21–0 in
favour of the app.

Three refusals turned out to be features and were promoted into *additional*
assertions: party isolation on a second phone, the till refusing to double-print a
KOT, and refusing to re-cook an already-cooking line.
