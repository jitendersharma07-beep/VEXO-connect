# W2 — release task, 2026-09-25

Continues the release task after publication. **This is not a re-audit of the publication**;
`docs/W2-INTEGRATION-CLOSE.md` holds that and its numbers stand unchanged. This file holds
only what came after it: the blocker ledger read back verbatim, the one software item that
was actionable and is now closed, the identity of the running staging candidate, the D-6
decision, and the disk remedy.

Everything below was measured on 2026-09-25 between 04:20Z and 04:40Z on `atc-noc`. Where a
figure is quoted from another session's document rather than measured here, it says so.

---

## 1. Blockers B1–B6, verbatim

Source: `docs/CLIENT-HANDOVER-SCOPE.md:45-50` — the table is quoted exactly as written,
including its file order, which is B1, B2, B3, B4, B6, B5. Both copies on this box
(`w2-close` and `cloud-readiness`) are byte-identical at 17022 bytes, so there is no newer
version of this ledger to read.

| # | Blocker, verbatim | What it blocks, verbatim | Who can clear it, verbatim |
|---|---|---|---|
| B1 | **Product Master Specification v1.1 is not held by anyone.** It was searched for across both machines, the handover package, every session transcript, artifacts and docs. Window 3 confirms the same. | Reconciling this scope against the spec. Every "Included" row below is included **on code evidence**, not on a spec line. | Owner: supply the document. |
| B2 | **No client data pack**: menu, store details, staff list, GST treatment, licence terms. | Real onboarding. Every row of `docs/CLIENT-ONBOARDING-CHECKLIST.md` is BLOCKED, and demo output is labelled DEMO. | Owner / client |
| B3 | **The RC-1 deployment decision.** RC-1 adds migration 13 (`20260923160000_refund_method`, one nullable column). `7565dff8`'s written grant covers only v1.0.1 post-deploy verification. | Anything reaching production. | Owner — approve RC-1 **and** confirm who deploys it — then the deployment owner |
| B4 | **No compliant off-host backup.** Quoted from Window 2's own record (`~/vexo-connect-ops`, `docs/OPS-HANDOVER.md` §0 @ `9ff94ac`; status and remediation stay with Window 2): the tooling is DONE and verified. One retained encrypted copy **EXISTS but is NOT COMPLIANT**: it was shipped 15:04:27Z and encrypted to key `…0F05CA51AEC13029`, whose **unprotected private half is on the POS host**. It is stored under an unrestricted login, so it is not append-only, and it is to be re-sent once the owner's new key exists. Scheduling is prepared, not installed. A real restore has been rehearsed, not done. Physical off-site separation is unconfirmed (same /24). None of this is in RC-1 or a build input. | A backup that survives losing the host. | Owner: a new key with its private half off the host, a dedicated append-only destination account, and an off-site location |
| B6 | **The production host's root disk is at 88% of 98 GB** (read 2026-09-23 ~15:50Z on `atc-noc`, which runs the POS). Window 2 marks it URGENT: 3–8 days to 95–100% at the measured rate. ~439 GB of unallocated volume-group space exists, so `lvextend` is the fix (`OPS-HANDOVER.md` §7 P1). | Everything on that host, the POS included. A full disk stops the database. | Owner |
| B5 | **Physical print test** is scheduled for 2026-09-24. | Moving printing from Conditional to Included. | Window 3, with a printer |

### Status: 6 open, 0 closed. None is software-actionable by this session.

Three of the six have moved since the ledger was written at 19:11Z on 24 Sep, and the ledger
does not yet say so. The movement is in other sessions' commits, not in this file, which is
why reading the ledger alone would understate progress on two and understate the danger on
the third.

| # | Still open because | Moved since the ledger was written | Exact next action |
|---|---|---|---|
| B1 | The document does not exist on either machine. Nothing in code can produce it. | No | Owner hands over Product Master Specification v1.1, or states that it is lost and the code-evidence scope is the scope. The second is a decision, not a gap, and it can be taken in one line. |
| B2 | Requires the client's own data. | No | Owner or client supplies the five items. Until then `docs/CLIENT-ONBOARDING-CHECKLIST.md` cannot have a single non-BLOCKED row, and every artifact stays labelled DEMO. |
| B3 | An approval, plus the naming of a deployer. | No | Owner approves RC-1 and names who deploys. Note the shape of the approval needed: the existing grant `7565dff8` is written for v1.0.1 *post-deploy verification*, so it cannot be stretched to cover RC-1 — this needs a new sentence, not a reinterpretation of an old one. |
| B4 | Key custody, append-only destination and off-site separation are all still as described. | **Yes, one clause.** "A real restore has been rehearsed, not done" is now done: at `3fbc35a` (04:00:07Z) the owner ran the decryption procedure and it passed end to end — archive fetched, matched its shipping receipt, decrypted, and the dump inside hashed to what its manifest recorded. That commit is explicit that this proves the archives and the passphrase and **says nothing about surviving the loss of the host**, because the run used the backup key on the backup host. | Owner: the three unchanged items — a new key with its private half off the host, a dedicated append-only destination account, an off-site location. The restore clause can be struck from B4's text; the blocker itself does not move. |
| B6 | Needs root on the host. | **Yes, and in the wrong direction.** The ledger's 88% was read 2026-09-23 ~15:50Z. Measured here at 04:20Z on 2026-09-25 it is **93%** — 98 G filesystem, 87 G used, **6.7 G available**, inodes 30%. That is five points in ~36 hours, consistent with `OPS-HANDOVER.md`'s upper "release burst" rate of ~2.5 GB/day rather than its base 1.5 GB/day. On that table 100% lands ~28 Sep. | Owner, one command pair, no deletion — see §5. This is now the most time-boxed item on the list. |
| B5 | The half that matters is untested. | **Yes, and it split in two.** At `856e179` (04:10:10Z) the run-book became Record A (printer hardware and the POS-80C driver on USB001, **VERIFIED**, owner-attested from photographs that session did not inspect) and Record B (VEXO's own receipt, KOT and reprint on paper, **PENDING**). A printer self-test and a Windows test page are both generated below our code, so neither says anything about VEXO's receipt width. | Window 3 with the printer: print a VEXO receipt, KOT and reprint on paper. **One sub-item is cheaper than that and should go first** — read the characters-per-line figure off the self-test photograph already taken. At ≤32 the unit is 58 mm, which `856e179` marks a STOP check and a **code change, not a setting**. That is the only B-blocker with a latent software consequence, and it is seconds of work to rule in or out. |

---

## 2. The one software item that was actionable — F-9, now closed

`docs/CLIENT-HANDOVER-SCOPE.md:117-130` files F-9 and classifies the status half of it as
"cosmetic and deferred". That classification was correct when written and is refuted by what
happened afterwards, so the fix was taken here.

**What F-9 is.** `backend/src/app.js` refused a browser whose `Origin` was not in
`CORS_ORIGIN` by calling back with a bare `new Error('Not allowed by CORS')`. A bare Error is
a stranger to `backend/src/middleware/error.js`, so it fell to the catch-all and left as
**500 `POS_INTERNAL_ERROR`, "Something went wrong handling that request"**.

**Why it stopped being cosmetic.** The staging session lost a debugging session to exactly
this: sign-in answered 500, which reads as a server fault, and the fault was one
`CORS_ORIGIN` value with the wrong port. The reason it was expensive is the line immediately
above the refusal:

```js
if (!origin) return callback(null, true);
```

No `Origin` header is not a browser, so every `curl` probe passes straight through and only a
real browser fails. A status that says "the server is broken" on the one request class that
cannot be reproduced from the command line is not a cosmetic defect; it is a defect in the
only diagnostic channel available.

**The fix**, `backend/src/lib/errors.js` and `backend/src/app.js`:

- a named refusal `originNotAllowed(origin)` returning **403 `POS_ORIGIN_NOT_ALLOWED`**,
  following the file's existing pattern for `gatewayNotConfigured` (501), `badGateway` (502)
  and `storageBusy` (503) — each an `AppError` carrying the reason it is not a 500;
- the message names the rejected origin and names `CORS_ORIGIN`, because those are the two
  facts the only person who can fix it needs. The origin is length-capped to 100 characters
  so a header cannot choose how much of itself comes back, and the reflection is safe:
  the refusal sets no `Access-Control-Allow-Origin`, so page JavaScript is blocked from
  reading the body it provoked. Only a non-browser client or the operator's own devtools
  can see it, which is precisely the audience;
- a side effect worth naming: as an `AppError` this no longer reaches
  `logger.error(… 'unhandled error')`. Before, anyone able to send a bogus `Origin` header
  could write error-level lines into an operator's log for free.

**Gate.** `backend/tests/corsOrigin.test.js`, 8 tests, **8 passed, exit 0**, 04:27:02Z,
duration 2.27 s. Scope was chosen per the standing rule that additional gates run only for
changed code:

- the change is two hunks — the `origin` callback's error path, and one added export. An
  added export cannot alter an existing importer, and `lib/errors.js` imports nothing, so no
  cycle is introduced;
- **no existing test could be affected, and that is verified rather than assumed**: a grep of
  `backend/tests/` for a request that sets an `Origin` header returns only the new file. The
  858/858 suite therefore never exercised this path, which is also why the 500 survived to
  production-candidate stage;
- the new file is self-guarding rather than merely green. It asserts the allowed origin is
  **echoed back** — a 200 alone would pass with the middleware deleted entirely — and it
  inverts the guard: a second app built with an allow-list matching nothing must 403 the
  previously-allowed origin while still waving through the header-less request. It also pins
  the header-less wave-through itself, so nobody removes the curl blind spot while believing
  they are tightening CORS, and pins that the refusal is still a refusal, because the obvious
  wrong way to make the message friendly is to approve the origin.

**Database.** This lane's own `vcx_w2close_test`, which had been removed from the dev
container since the 858/858 run and was recreated here. No migration was applied and none is
needed: every request in the file is `GET /api/health`, one `SELECT 1`, and `globalSetup`
derives its truncate list from `pg_tables` and skips when empty. So the gate ran against an
empty schema, which is tighter isolation than a seeded one — stated so the evidence is not
read as covering anything that touches a table. No peer database was named or touched.

**What this does not do.** F-9's other half — the ledger's F-3, first-login password change
being browser-only — is untouched and remains an owner decision. And a 403 does not make a
misconfigured deployment work; it makes it say what is wrong in one line instead of in a
debugging session.

---

## 3. The running staging candidate, and why it was not overwritten

| | |
|---|---|
| Lane | `/home/atc-noc/vexo-connect-x-lanes/cloud-readiness`, branch `x/cloud-readiness` |
| HEAD | **`fdaccdf`**, committed 2026-09-25 04:13:41Z. Re-read at 04:33Z, unchanged |
| URL | **`http://127.0.0.1:8120`** — nginx, **loopback only**. Confirmed by `ss -ltnp`: `127.0.0.1:8120`, not `0.0.0.0`. There is no public staging URL |
| Behind the edge | backend pid **2257874** on `127.0.0.1:5540`, started 04:02:43; vite preview pid **2101579** on `127.0.0.1:5640`. Both pids re-confirmed at 04:33Z — nothing was restarted by this session |
| Is the running code HEAD? | **Yes, for source.** Every commit since the backend started at 04:02:43 touches only `deploy/` and `docs/` — `git log --since` over `--name-only` returns those two directories and nothing else. So `backend/src` and `frontend/src` at `fdaccdf` are what is running |

**The authorized staging update was not run in the direction it was written, and that was the
finding rather than a refusal to work.** Published `main` is *behind* this lane, not ahead of
it. Checking `main` out here would have deleted five staging-only changes from a live stack
three sessions are using:

| Commit | What would have been lost |
|---|---|
| `17058b9` | recovery-oracle fix — stops a broken mail provider revealing which addresses are registered |
| `aa237e0` | licence module gate at the permission layer |
| `7d2020c` | tenant isolation over the merged recovery paths |
| `4780e1f` | 409 instead of 500 for a duplicate kitchen station |
| `97457ee` | the two staging invariants made non-revertible |

That is the opposite of "preserve required fixes and newer peer work", so the update was
coordinated instead of performed, in
`/home/atc-noc/vexo-connect-x-lanes/cloud-readiness/PEER-NOTE-CLOUD-READINESS-RECONCILE.md`
— appended to, never rewritten, claiming no file. The merge surface was measured first:
**5 conflicts**, and the frightening one is not dangerous. `schema.prisma` collides on
ordering and alignment only, proven by four independent counts agreeing across both sides —
22 migration directories, 59 models, 1029 field declarations, 131 enum members.

**Browser login is already established on the published tree, and by a positive control
rather than by inference.** The VC-104 and VC-105 harnesses drive real Chrome through the
real sign-in form: 75/75 and 48/48, `aborted: false`, `exitCode: 0`. `curl` could not have
established it, for the reason in §2 — `app.js` waves through a request with no `Origin`
header, so a CORS failure is invisible to every command-line probe and visible only to a
browser. That is why the harness evidence is reusable here and a fresh curl sweep would not
have been.

---

## 4. D-6 — the promotion-code reuse decision

Options and measurements are in `docs/VC104-BACKEND-DEFECTS.md:1264-1366`. That file belongs
to another session and is not edited from here. This is the decision it asks for.

### The whole decision is one question
**When a promotion is archived, does its code go back into the pool?**

Today the answer is no, silently: `@@unique([companyId, code])` on `model Promotion`
(`backend/prisma/schema.prisma`, and the route pre-check at
`backend/src/api/routes/promotions.js:167`) makes an archived promotion hold its code
forever, and nothing in the product says so.

### Recommendation: **YES** — option (1), whole, or not at all
A code is a thing a till operator types. Codes are short, memorable and therefore scarce, and
"SUMMER20 is already in use" pointing at a promotion archived two years ago is an answer
nobody can act on. Retiring a promotion should release the word.

### What YES costs, and what it does not
It does **not** drop uniqueness, and nothing about it is to make a test pass — no test drives
this. Uniqueness moves from "over all promotions that ever existed" to "over the promotions
that are currently usable", which is where the constraint has meaning. Nothing is deleted and
nothing is mutated: archived rows keep their code, their `redemptionCount` and every
redemption and invoice snapshot attached to them.

Four consequences, all real:

1. **The migration and the route change must ship together.** The index becomes unique only
   `WHERE status <> 'ARCHIVED'`, and the pre-check at `promotions.js:167` must become the
   matching `findFirst`. Either one alone is worse than doing nothing:
   - route only → the database still rejects the insert with Prisma `P2002`, and `P2002` is a
     stranger to `middleware/error.js`, so a clean **409 becomes a 500**. This is not a
     prediction: `backend/tests/storageBusy.test.js:104-107` already pins `P2002` as the
     example of a stranger that must stay 500;
   - index only → `prisma.promotion.findUnique({ where: { companyId_code: … } })` loses the
     compound key the generated client addresses it by, and the pre-check breaks outright.
2. **It cannot be expressed in `schema.prisma`.** Prisma's schema language has no predicate on
   `@@unique`, so the partial index has to be hand-written SQL inside the migration, and
   Prisma will read it as drift thereafter. That collides with the standing decision to
   standardise on Prisma migrations with hand-written SQL reserved for Timescale DDL — so YES
   needs either a named exception to that rule, or a second implementation of the same answer
   that stays inside it. A design that keeps the code on the archived row while freeing it for
   reuse without a partial index is possible but does not exist yet; it should not be invented
   inside a decision memo.
3. **One code may afterwards belong to several promotions across time.** Any report or lookup
   that groups by `code` must group by `id` instead. This is the change most likely to be
   missed, because it breaks quietly — two promotions' figures added together look like one
   successful promotion.
4. Archiving becomes a semantically heavier action, since it now releases a name. It deserves
   a confirmation that says so.

### What NO costs
NO is right if promotion codes are permanent identifiers in a system outside this product —
printed vouchers, a loyalty scheme, accounting. If such a system exists, reusing a code
corrupts its history and no amount of correctness inside VEXO fixes that. **Only the owner
knows whether one exists.** Choosing NO costs the honest refusal below, one paragraph of
documentation, and an archive confirmation that says the code will never be available again.

### Ship regardless of the answer
Option (3) — the honest refusal at `promotions.js:167-172`. Whatever the rule is, the message
must say it: today a duplicate code gives no hint that the collision is with something
archived and invisible. It pairs naturally with the `publishd` typo at `promotions.js:332`.
**Not done from here**: `promotions.js` and its pinned tests belong to another session, and
the single-integration-driver rule holds.

A fourth path — restore-to-DRAFT keeping the code, `redemptionCount` and history — is
undesigned and is not an answer to the question above; it changes how an archive is undone,
not whether the code is free.

---

## 5. Disk remedy — specific, and mostly not deletion

**Measured now:** 98 G filesystem, **87 G used, 6.7 G available, 93%**; inodes 30%. One
volume carries `/`, `/tmp` and `/var/lib/docker`, so this number is the whole box's headroom.

### The remedy is to grow the filesystem, and the space is confirmed present
Read-only, no sudo, verified here rather than quoted:

```
sda                         700G disk
├─sda1                        1G part /boot/efi
├─sda2                        2G part /boot
└─sda3                    508.9G part
  └─ubuntu--vg-ubuntu--lv   100G lvm  /
```

The LVM partition is **508.9 GiB and carries a single 100 GiB logical volume**, so roughly
**409 GiB is unallocated inside the volume group** — and a further ~188 GiB of `sda` is not
partitioned at all. This reconciles with `OPS-HANDOVER.md` §7 P1's "~439 GB unallocated, plus
~202 GB": the same space in decimal GB rather than GiB. Both readings now agree, which
retires the earlier caveat that this session could not confirm the claim; `vgs` and `lvs`
still need sudo, and only they give exact free extents.

Root is **ext4** (`/proc/mounts`), so it grows online with no unmount and no downtime:

```
sudo lvextend -L +200G /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

That is the whole fix for B6. It deletes nothing, needs no container restarted, and takes the
filesystem from 6.7 G free to ~207 G free — past the point where the ~2.5 GB/day release-burst
rate matters. **It needs root, which this session does not have.** It is the owner's single
highest-value action on this list.

### Reclamation by deletion was investigated and is not a remedy
Every `node_modules` under `vexo-connect-x-lanes` was sized, its symlinks dereferenced, and
every lane checked for live processes before anything was called removable.

**Total across all 21 lanes: ≈ 2.08 GB.** Deleting every byte of it moves 93% to 91% and
costs a reinstall in each lane. For contrast, `docker system df` reports images 21.67 GB,
local volumes 24.13 GB, containers 1.665 GB — **≈ 47.5 GB, roughly 55% of everything used**,
and it is off-limits by instruction: the volumes *are* the databases and the images include
the rollback images.

Five symlinks, dereferenced. These make four directories load-bearing for lanes other than
their own, and deleting a donor breaks every dependent silently:

| Symlink | Target | Consequence |
|---|---|---|
| `merge-a406/frontend/node_modules` | `foundation/frontend/node_modules` | donor, keep |
| `reporting/frontend/node_modules` | `foundation/frontend/node_modules` | donor, keep — and `reporting` is live |
| `w2-frontend/{backend,frontend}/node_modules` | `foundation/{backend,frontend}/node_modules` | donor, keep — and `w2-frontend` is live |
| `modlic/{backend,frontend}/node_modules` | `w2-close/{backend,frontend}/node_modules` | donor, keep |
| `vc104-salvage/backend/node_modules` | **`~/vexo-connect-dev/backend/node_modules`** | points into a **different product**. Out of scope; following it would damage the dev stack. Removing the symlink itself frees 0 bytes |

Live lanes, by `/proc/<pid>/cwd` cross-checked against `/proc/<pid>/comm` — the cross-check
matters, because a shell merely sitting in a lane reads as a live server without it, and
`w2-close|2214780|bash` is exactly that false positive:

**Live (10):** `cloud-readiness` (the staging stack), `floorplan`, `foundation`,
`int-payments`, `inventory`, `kitchen-int`, `menu-images`, `promotions`, `reporting`,
`w2-frontend`. Three are **mid-`vitest` right now** — `int-payments`, `inventory`,
`kitchen-int` — so their `node_modules` must not be touched at all.

**Not live, not a donor — the only genuinely safe set:** `main-merge` 279 M, `merge-a406`
backend 138 M, `slot-anchor` 138 M, `vc104-api` 136 M, `vc104-ui` 141 M, `vc105-api` 134 M,
`vc105-ui` 141 M, plus four small ones (`accounts`, `kitchen`, `payments`, `providers`,
≈ 123 M together). **≈ 1.2 GB, i.e. one percentage point.**

So the honest recommendation is: **do not delete lane `node_modules` as a capacity measure.**
It buys ~1.2 GB against a 6.7 GB deficit and a 2.5 GB/day burn, costs reinstalls, and risks a
donor mistake. Run `lvextend` instead. If something must be freed *before* root is available
to buy hours, the cheapest and least destructive is scratch under `/tmp` (1.1 G total), and
only each session's own: `/tmp/vc104-accept` 290 M and `/tmp/vc104-commit` 12 M are this
lane's, while `/tmp/fnd-base` and `/tmp/fnd-test` (275 M together) belong to the live
`foundation` session and `/tmp/claude-1000` 216 M is the runtime's.

Recorded and deliberately **not** proposed: the largest non-Docker consumers on the box are
other products — `netstay` 1.5 G, `vexo-website` 1.3 G, `vexo-lanes` 1.1 G — and
`~/pos-prod-frontend-pre-20260922.tar` is a rollback artifact. An 8 GiB swap file also sits
on this filesystem. Measured for completeness, untouched by rule. Also noted rather than
acted on: the dev Postgres container carries **40 databases**, many of them one-off probe
databases from earlier sessions, inside the off-limits 24 GB of volumes.

---

## 6. What is left, and who has it

**Owner decisions, all five independent of each other:**

1. **D-6** — does an archived promotion's code return to the pool? §4 recommends yes, and
   names the one thing only the owner knows: whether any outside system treats a promotion
   code as a permanent identifier. If yes to reuse, §4's consequence 2 also needs a ruling on
   the Prisma-migrations standard.
2. **B6 / disk** — run the two commands in §5. Most time-boxed item on the list.
3. **B3** — approve RC-1 and name the deployer, in a new sentence rather than by stretching
   `7565dff8`.
4. **B1, B2, B4** — supply the specification (or declare it lost), the client data pack, and
   the three backup-custody items.
5. **The staging lane's commits** — may they be published to `main`? **The "who drives it"
   half is now settled between sessions and needs nothing from the owner:** the staging
   session answered at 04:20Z that nobody drives it today, that publishing is the owner's
   call and they have not asked for it either, and that if the owner does ask, `w2-close` is
   the right place and this session is the right driver. So the only open half is the owner's
   yes or no. Two facts that belong with that decision:
   - their remote tip is still `3fbc35a`, and **three unpushed commits are interleaved by
     author** — `97457ee` (theirs), `856e179` (the printer session's), `fdaccdf` (theirs).
     There is no ordering in which one session pushes only its own work, so whoever pushes
     releases someone else's commit. They have declined to, on a public repo, and said so;
   - the merge is the natural moment to correct `globalSetup.js`'s stale `vcx_foundation_test`
     comment, which is already in the five-conflict set.

**Cheapest next action by anyone, in order:**

1. Read characters-per-line off the printer self-test photograph already taken. Seconds of
   work; at ≤32 it is a 58 mm unit and a code change, and B5's STOP check closes either way.
2. `lvextend` + `resize2fs` (owner, root).
3. The merge answer, which unblocks publishing five security and correctness fixes that
   currently exist only on a loopback-only staging stack.
4. Two one-liners, both held only because a session lacks a permission, neither urgent:
   - `git push github x/w2-integration-close:main` — verified here as a clean fast-forward
     `ea04c07..9f0716f` gaining exactly the two commits in this file, and refused by this
     session's command classifier for the third time on the `:main` target form while the
     bare branch push went through. Nothing is wrong with the command; the owner ran the
     identical line by hand two hours earlier and it worked;
   - `bash vcxcr edge` in the staging lane — the staging session found that the running edge
     bind-mounts a hand-placed copy of `staging-edge.conf` rather than the repo's, and their
     own assertion script had been checking a file nginx never opens. The two are
     byte-identical today and the live run is 13/13, so this is residue, not a fault. It
     needs a container recreate, which their session is blocked from doing: seconds of
     loopback downtime, no data involvement.
