# `RELEASE-HANDOVER-CHECKLIST.md:285` — "24 models" is wrong, and so was my "23 models"

**From:** the cloud-readiness / backup-evidence session
**Date:** 2026-09-26
**Status:** untracked note. **I have not touched your file.**

`docs/RELEASE-HANDOVER-CHECKLIST.md` is modified in your working tree (13
insertions, 6 deletions uncommitted when I looked). Editing line 285 from here
would either clobber that buffer or sweep your hunks into my commit, so this is a
note rather than a patch. The one-word fix is yours to make whenever you next
touch the file.

## The line

```
102 726 bytes, 24 models, taken 09-24. A day apart, different bytes.
```

**Everything in that sentence is correct except `24 models`.** Verified against
the manifests on disk in `/home/atc-noc/atc-backups/pos-prod/`:

| Field | 09-23 manifest | 09-24 manifest | Your line |
|---|---|---|---|
| `dumpBytes` | 101 869 | 102 726 | ✅ both correct |
| `dumpSha256` | `74367d90…` | `45cc0768…` | ✅ both correct |
| `migrationsApplied` | 12 | 12 | — |
| `paymentAmountSum` | 4467.52 | 4467.52 | — |
| `staffLoginsWithHash` | 16 | 16 | — |
| **`rows` entries** | **23** | **23** | ❌ says 24 |

## Why it is worth fixing rather than shrugging at

The sentence uses the figure to *establish* that the two dumps are different
artifacts — "23 tables" on 09-23 against "24 models" on 09-24. That contrast
reads as a schema change between the two nights. **There was none.** The two
manifests have an identical key set, and the only per-model counts that moved
are:

```
PosAuditLog:  330 -> 355
PosSession:    84 ->  86
total rows:   588 -> 615
```

Audit log and sessions — observability, not schema and not trade. Payments,
migrations and staff logins are byte-identical across the two nights.

So **your conclusion is right and your evidence for it is wrong.** The dumps
genuinely are different bytes; they differ because 27 audit/session rows landed,
not because a model appeared. Anyone reconciling the two nights from this line
would go looking for a 24th model and not find one.

## The correct figure, and the noun that caused this

Three sources agree:

- the manifest `rows` map has **23** keys, on all three nights checked (09-23,
  09-24, 09-25), and `_prisma_migrations` is one of them
- the deployed v1.0.1 schema declares exactly **22** `model` blocks
- live production carries **23** base tables, of which one is
  `_prisma_migrations`

So: **23 tables = 22 Prisma models + `_prisma_migrations`.** `_prisma_migrations`
is a real table and not a model, which is the whole trap.

Suggested replacement, which avoids the noun entirely:

```
102 726 bytes, 23 tables, taken 09-24. A day apart, different bytes.
```

## I had the same error, one number off

My own docs said "all 23 models", which is the right count of manifest entries
under the wrong noun — only 22 of them are models. `restore_from_archive.py`
prints `all 23 models restored to their recorded counts`, so the loose noun
starts in the tool and propagates into whatever quotes it. I have corrected my
two copies (`docs/CLOUD-READINESS-VERIFICATION.md` and the evidence ledger) and
named the tool as the source rather than quietly fixing the word, because the
next person to quote that output will inherit it too.

Mentioning it so this does not read as one session correcting another: the figure
in your file is wrong by one, and mine was wrong by a noun.

## What I verified, and what I did not

Verified: manifest contents for three nights, the model count in the deployed
schema, and the live production table count. Production reads only — no writes,
nothing deployed, no dump moved or deleted.

Not verified: whether your uncommitted 13 insertions already fix this. If they
do, ignore all of the above.
