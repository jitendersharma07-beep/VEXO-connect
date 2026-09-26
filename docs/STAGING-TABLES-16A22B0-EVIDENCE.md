# pos-stgtbl @ 16a22b0 — observed results and GO/NO-GO

Everything below was observed on 2026-09-26. Nothing is inferred.

## Access

| | |
|---|---|
| **URL** | `http://127.0.0.1:8113/pos/` |
| **API** | `http://127.0.0.1:8113/pos/api/health` |
| **Reachability** | **loopback only** on atc-noc. Not a public hostname, not bound to any public interface. |
| **From elsewhere** | SSH tunnel: `ssh -L 8113:127.0.0.1:8113 atc-noc` then open `http://127.0.0.1:8113/pos/` |
| **Compose** | `docker compose -f /home/atc-noc/pos-stg-tables-16a22b0/docker-compose.staging.yml <cmd>` |

## Artifact identity

```
commit 16a22b00157406eade8c5096daedda560f738eef   tag stg/tables-16a22b0
tree   7b2ab2e8e0f2288859a90c38e4cc70c394696ed0
       = main 728a57c + x/tables 12fa573
```

`./repo` is a `git archive` extraction — no `.git`, so no branch could move under
the build and no dirty worktree could leak in.

| Image | ID |
|---|---|
| `pos-stgtbl-backend:16a22b0` | `sha256:8d447bc864fc8656bea2e0c816146ad00a1fd2f558ce5c12ea13f302a56a1b52` |
| `pos-stgtbl-frontend:16a22b0` | `sha256:67e30e27923f5f389521eb63c6595230edaa297556bea9a3348ee43b498ffbf3` |

## A. Pre-deploy gates on the artifact — all PASSED

| Gate | Result |
|---|---|
| Full backend suite, fresh DB, full migration chain | **57 files / 1767 tests / 0 skipped / exit 0** (1031s) — `/tmp/vcxc-full-16a22b0.log` |
| ↳ my three table suites inside that run | tablesMerge **32**, billSplit **32**, tablesTransfer **20** |
| FINISH identity (run certifies the committed source) | worktree clean, HEAD `16a22b0`, tree `7b2ab2e8`; `mergeBill.js` `27a17a5e…`, `tablesMerge.test.js` `d9d47da5…` |
| Migration ledger | 43 on disk, **43 applied, 0 unfinished, 0 rolled back** |
| My migration checksum | ledger `803b04e3…` **== disk sha256** |
| Schema drift (`migrate diff`) | *"This is an empty migration."* — zero drift |
| Frontend build | exit 0, 1711 modules |

The full-suite run mattered: the lane gate only proved `x/tables` against the base
it branched from, while `main` had moved 13 commits — including `09127b1`, which
centralised 34 test files onto a shared `wipeAll()` precisely because per-file
wipe lists break "when somebody else merges". My five lane files still carry
per-file wipes. That was an untested interaction; it was measured, and it passed.

## B. Deployed-environment gates — PASSED

| Check | Observed |
|---|---|
| Containers | **4/4 healthy** (postgres, backend, frontend, edge) |
| `migrate deploy` in the real image | all **43** applied, mine (`20260926091200_order_status_merged`) last |
| Ledger in the deployed DB | 43 applied, 0 unfinished; checksum `803b04e3…` matches |
| `OrderStatus` in the deployed DB | `OPEN,BILLED,PAID,VOID,REFUNDED,MERGED` — appended last, no value's sort order moved |
| **API health incl. content type** | `200` + **`Content-Type: application/json; charset=utf-8`**, body `{"status":"ok","service":"atc-pos-api"}` — and the handler runs a real `SELECT 1`, so this proves DB connectivity, not just liveness |
| `/api/config` | `{"appName":"VEXO Connect","product":"atc-pos","vendor":"ATC Infocom Solutions Pvt. Ltd."}` |
| Prefix-less negative control | `GET /api/health` → **404 text/html** (fails loudly instead of reading as a pass) |
| `/pos` → `/pos/` | **301** |
| Frontend SPA | `200 text/html`; assets carry the `/pos/` prefix; hashed JS resolves `200 application/javascript` |
| Build cross-check | image CSS hash `index-BDCmYbcq` **==** standalone build gate's. (JS hash differs only because the image builds with `VITE_BASE_PATH=/pos/`.) |
| Security headers | HSTS, `X-Content-Type-Options: nosniff`, COOP, CORP, `Referrer-Policy: no-referrer` |
| Anonymous refusals | `401` on `/api/auth/me`, `/api/orders`, `/api/tables`, `/api/reports/sales`, `/api/kitchen/queue`; `401` on a garbage bearer |
| Peer non-interference | all four peer stacks still healthy, same images/ports, uptimes predating mine; 8110/8111/8112/8210 all still `200`; my volume `pos-stgtbl_pos_stgtbl_pgdata` separate |

## C. The functional matrix — EXECUTED against the deployed stack

The fixture blocker is cleared. The seed was run against the isolated
`pos_stgtbl` database only, and the whole matrix then ran through the real
`/pos/` edge as five phases:

```
run-20260926-134237.log      235 checks passed · 0 failed · all five phases exit 0
```

| Phase | Result | What it proves about *this deployment* |
|---|---|---|
| 1 — login, forced password change, role isolation | **33 / 0** | 4 seeded roles authenticate through the nginx prefix strip and cookie-path rewrite |
| 2 — transfer, split, **merge** | **41 / 0** | the verb the migration was for, money-conserving, on the real compiled Prisma client |
| 3 — QR → KOT, kitchen, billing, payment, refund | **56 / 0** | the anonymous guest path end to end, then the till |
| 4 — promotions | **52 / 0** | authoring authority, targeting, discount arithmetic, limits |
| 5 — sales report, day close, activity log | **53 / 0** | every figure verified *differentially* |

Why this is a separate claim from the 1767 unit tests: those prove the routes
against the code. These prove them against **this** artifact's compiled client,
this migrated database, and this reverse proxy. The scripts live in `verify/` here
and are committed at `deploy/stg-tables-verify/` in the repo; all are re-runnable,
each resetting its own fixtures through real routes.

**The fixtures.** `docker exec pos-stgtbl-backend node prisma/seed.js`, pasted by
the owner (`db:seed` is deny-listed to me), writing only to `pos_stgtbl`. Seed
passwords went to `secrets/` at `0600`, never to a scrollback; the harness then
rotated them and wrote `secrets/creds-rotated.txt`, also `0600`.

One correction to an earlier revision of this document, recorded rather than
quietly overwritten: it claimed the seed creates **one** dining table. It creates
**ten** — **6** in Connaught Place (the manager's branch) and **4** in Cyber Hub,
counted in the deployed database. That is enough for transfer, split and merge
without the scripts fabricating rows, though only just: six tables is what forced
phase 2 to free the floor between blocks (below). The earlier figure was read
from the seed's summary line rather than from the deployed floor list.

### What was observed, by area

**Login and role isolation (33).** All four roles → `200` with the right role.
`mustChangePassword` is **true** on seeded accounts (the seed mints generated
passwords, `prisma/seed.js:58`) and correctly gates *discount approval only*, not
ordinary reads — proven, so a later 403 cannot be blamed on it. Credentials were
then rotated the way a real first sign-in does; re-login works on the new
password only. Refusals are **403, not 404**, and two controls make that mean
something: `CUSTOMER_OWNER GET /api/users` → 200 (so the CASHIER 403 is a
permission) and a bogus sibling route → 404 (so 403 is not the catch-all).
Neither refused POST created anything. Exactly **two** negative logins, run last,
because the limiter is 10 failures / 15 min / IP.

**Transfer · split · merge (41).**

| | Observed |
|---|---|
| transfer | `T2 → T3` 200; total unchanged **441.00 to the paise**; covers (`pax=3`) travelled with the party; source table now FREE and destination occupied — so it moved, it did not copy |
| transfer refusals | onto an **occupied** table → 409 (that is merge's job); CASHIER **can** transfer by design (`permissions.js:266`); the ATC/VEXO operator **cannot** → 403 |
| split | **252.00 + 567.00 = 819.00** conserved; original keeps its id so prior payments/KOTs still resolve; the moved line genuinely left A and arrived on B; both cheques non-zero |
| split refusal | ATC operator → 403, and the **same body** from a CASHIER succeeds — so the 403 is the role, not a malformed request |
| **merge** | **126.00 + 378.00 → 504.00** conserved; emptied source is **`MERGED`**, survivor still `OPEN`; source carries zero money and zero items; source table freed |
| merge refusals | into itself → 400; a `MERGED` bill is terminal (add item 409, issue bill 409); ATC operator → 403 |
| `MERGED` is real | `GET /api/orders?status=MERGED` → **200** and returns the merged-away bill — the enum value survives a real SQL filter through the deployed image's client, not just a response body |

**QR → KOT and the kitchen (25 of phase 3).** The printed card's URL uses this
deployment's own origin, so `POS_QR_BASE_URL` is genuinely wired. The anonymous
landing works with **no auth**. A guest session returns a token and sets **no
cookie** — correct: guest identity is an `X-Guest-Token` header by design
(`guestQr.js:16`), so CSRF has no lever. Party isolation holds: the host is shown
the join code, a second phone with **no** code is refused 409, a **wrong** code
is refused distinguishably, the **right** code joins the *same* visit (200, not
201 — no second party), and the joiner is not made a host, so the code is not
re-shareable onward. A basket without the guest token → 401. The QR order is
priced **from the catalog, not the phone** (2 × 120 = 240 pre-tax). The **KOT is
cut by acceptance**, not submission; re-firing is refused 409 and the order still
lists exactly one KOT. The line appears on the kitchen board. A stale version on
a state change → 409, so optimistic concurrency holds.

**Billing, payment, refund (17 of phase 3).** Invoice `BSC-CP/26-27/00012`
issued; billing did **not** move the money; a BILLED order refuses new items. A
partial CARD payment of 147.00 dropped `amountDue` by exactly that; an
over-payment → 400; both tenders recorded as two rows, not one merged row; the
table released on PAID. Refund without a reason → 400; over-refund → 400; a
manager refund of 110.25 recorded exactly. Receipt renders and carries the
invoice number.

**Promotions (52).** Authority is genuinely split three ways: a CASHIER holds
`promo.apply` only and cannot author (403) or read the catalogue (403). A DRAFT
campaign is refused at the till with **no money moved**. Publish stamps
`publishedAt` without bumping the version; store targeting bumps it to 2, a
wrong-store spend → 409, and adding the store makes the **same** campaign
spendable — that pairing is the control. The arithmetic: on subtotal 840 the 10%
discount is **exactly 84**, and tax lands at **37.80 on the discounted base**,
not 42 on the gross. The redemption row snapshots the campaign version.
Double-apply → 409 with no doubling; removal reverses to zero and keeps the row
as `REVERSED`; a second removal → 404. Min-spend refuses at 409 and then the
same campaign applies once the bill grows. Two non-stackable campaigns: the
second is refused, the bill keeps the first. `totalLimit: 1` refuses the second
bill at `redemptionCount 1 of 1`. Archive is terminal (edit 409, spend 404).

**Reports, day close, activity log (53).** Every figure is verified as a
**delta**, because a frozen aggregator can pass an "is a number" check but cannot
pass a difference. A CASH bill of 720 + 36 tax moved `grossItems +720`,
`tax +36`, `collected +756`; `netSales == grossItems − discounts + tax` held;
`byMethod` summed exactly to `collected`; `byCategory` grew by exactly 720 with
no unnamed category. The negative control: a **VOIDed** bill moved none of
gross/tax/net/collected but is still counted as a void. A 25.00 refund moved
`refunds` by 25 and left `netSales` and `grossItems` untouched — the drawer
changes, the sale does not get rewritten. Day close: `expectedCash == cashSales
− cashRefunds` (**4394 = 5376 − 982**); a 100-over count with no note is refused
400 with the operator-readable *"The count is off by 100.00 (over). Add a note
explaining it."*; exact filing 201 recording `closedBy`; refiling without
`correctsId` → 409 telling the operator to file a correction; the correction 201
carries its variance; superseded closings are retrievable with
`includeSuperseded=true` while the default view shows one. The activity log
carries the void and the refund with `actorEmail` on **every** event. Reporting
catalogue lists 20 reports; a bogus key → 404.

### One finding for the owner — not a pass, not a defect

`POST /api/promotions?companyId=<tenant>` as **POS_SUPER_ADMIN returned 201**. A
platform operator can author a campaign inside a customer's tenant. This is
consistent with the code — the gate is the `promo.write` action, and
`ROLE_ACTIONS` grants `POS_SUPER_ADMIN` every action key; it is *not* a role
denylist like `tables.js:46` uses for the floor verbs, where the same operator is
correctly refused 403.

Containment **was** asserted and does hold: the campaign lands `DRAFT`
(unspendable) and is scoped to the named tenant, and the operator must name that
tenant or the request is rejected 400 before any gate (`auth.js:75`).

So money cannot move from this. But "who may author a tenant's discounts" is a
**business-policy decision, not a harness decision**, and the floor verbs already
establish that this codebase sometimes wants the platform role excluded. Recorded
for a decision rather than asserted either way. A `BRANCH_MANAGER` authoring
attempt returned 403, also recorded rather than asserted, for the same reason.

### The red checks along the way were the harness, not the app

Getting to 235/0 took roughly twenty failing checks. **Every one of them was my
assertion being wrong, not the application.** That is worth recording, because the
alternative — quietly relaxing an assertion until it passes — would have produced
the same green log and proved nothing. Each correction is commented in the script
that carries it. The instructive ones:

| My assertion | What the app actually does |
|---|---|
| guest identity rides in a **cookie** | it is an `X-Guest-Token` **header**, deliberately: "a header the browser never attaches on its own needs no CSRF defence" (`guestQr.js:16`) |
| `mustChangePassword === false` after seeding | the seed mints generated passwords, so demanding a change is **correct** (`prisma/seed.js:58`) |
| a CASHIER cannot transfer / merge | a cashier works the floor by design (`permissions.js:266`); the role that *is* refused is the ATC operator |
| `netSales == subtotal − discounts` | `netSales += order.total`, so it is **tax-inclusive** (`lib/orders.js`) |
| `includeSuperseded=1` | the schema is `z.enum(['true','false'])` — the literal string |
| `POST /orders/:id/items` takes `{items:[…]}` | it takes **one flat line** |
| re-archiving frees a promo code | `companyId_code` is unique with **no status condition** — an archived campaign owns its code forever, correctly, because an old bill still points at it |

Three refusals that I first treated as failures turned out to be features, and
were promoted into **additional** assertions rather than reset past: party
isolation on a second phone (4 new checks), the till refusing to double-print a
KOT (2), and refusing to re-cook an already-cooking line (1).

Three harness bugs of my own are also fixed rather than tolerated: `check()` prints
its detail on **PASS** as well as FAIL, so five green lines were printing details
phrased as the failure they were not; phase 2 crashed on the first clean
end-to-end run because the transfer and split blocks consumed five of the branch's
six tables, starving the merge fixture — the fixture was starved by its
predecessors, nothing about merge was wrong; and phase F's missing-`DATABASE_URL`
probe never actually removed the variable (see below).

## C2. Phase F — the production boot guards — PASSED

The gap this closes: staging runs `NODE_ENV=development` (§D), which is exactly
the branch that **skips** the guards in `config/env.js` that would refuse a
misconfigured *production* deploy. Shipping a production change set without
exercising them would mean the first time they ever run is against production.

```
run-bootguards-20260926-142721.log      20 passed · 1 failed · exit 1   (the probe bug, below)
run-bootguards-20260926-142812.log      22 passed · 0 failed · exit 0   (after the fix)
```

Both logs are kept. The failing one is not embarrassing, it is the evidence that
the gate can actually fail — a phase that has only ever been seen green tells you
nothing about whether it would catch anything.

It is pure configuration validation: `config/env.js` is imported in a child
process inside the **production image** with a candidate environment, and the
result recorded. **No server starts, no socket opens, no database is touched, no
hostname is published.** The baseline values are shapes, not credentials —
`x`×48, `a`×64, `https://pos.example.com/pos`.

The test is **two-sided on purpose**: "production config loads" alone would also
pass if every guard had been deleted, so each refusal is asserted **by its own
message** as well. A refusal with the wrong message means a different guard fired
and this one may be gone.

| Guard | Refusal message observed |
|---|---|
| `POS_QR_BASE_URL` over http | *must be an https:// origin outside test and development* |
| …pointing at loopback | *host "127.0.0.1" is not reachable from a customer's phone* |
| …pointing at `.local` | *host "till.local" is not reachable from a customer's phone* |
| …carrying a query string | *must not carry a query string or fragment* |
| simulator terminal connector | *Terminal connector "sim-approve" cannot be used in production* |
| test gateway provider | *Gateway provider "test-approve" cannot be used in production* |
| short `POS_JWT_SECRET` | *must be at least 32 characters* |
| truncated `POS_PAYMENT_SECRET_KEY` | *must be 64 hex characters (32 bytes)* |
| absent `DATABASE_URL` | *Missing required environment variable: DATABASE_URL* |
| gateway provider with no webhook secret | *POS_GATEWAY_PROVIDER is set but POS_GATEWAY_WEBHOOK_SECRET is missing* |

Plus the accept path (production-shaped config **loads**), and one check that
earns §D its place: **development really does accept the loopback QR base**, so
the deviation documented there is demonstrated rather than asserted.

**One correction, recorded not quietly fixed.** The missing-`DATABASE_URL` check
failed on the first run — *"LOADED — guard is not armed"*. The guard is armed:
`env.js:15` is `DATABASE_URL: required('DATABASE_URL')` and `required()` throws on
a falsy value. **The probe was wrong.** It implemented "this variable must be
absent" by dropping the key from the `docker exec -e` list — but `-e` can only
*set or override* a variable, never *unset* one, and the container already carries
its own `DATABASE_URL` from compose. So the flag's absence meant "do not override
it", `env.js` found a perfectly good URL, and the harness read that as a missing
guard. Fixed with `env -u DATABASE_URL` inside the container. The message
assertion is what makes the fix trustworthy: had `env` itself failed, the probe
would still have "refused", but with the wrong message, and the sub-check would
have caught it.

That makes **21 of 21** red checks across this whole matrix attributable to the
assertion rather than the application.

### Run it yourself

```bash
cd /home/atc-noc/pos-stg-tables-16a22b0/verify && node 06-prod-boot-guards.mjs
```

Re-runnable and side-effect-free, so it costs nothing to repeat against a future
artifact — and it should be, since it is the only gate that speaks to production
configuration rather than to this deployment.

## D. The one deliberate deviation from production

**`NODE_ENV=development`.** Forced by this environment's constraints — loopback
only, no TLS, no public hostname — because `config/env.js` puts its
http/localhost whitelist on the *safe* environments and would otherwise refuse to
boot twice over:

```
env.js:309  POS_QR_BASE_URL must be an https:// origin outside test and development
env.js:316  POS_QR_BASE_URL host "127.0.0.1" is not reachable from a customer's phone
```

Those refusals are correct and cannot be satisfied without publishing a hostname,
which this task forbids.

**What it does not cost:** the rate limiter keys on `NODE_ENV === 'test'` alone
(`middleware/rateLimit.js:8`), as do `display.js:38` and the integrations adapter
override (`adapters/index.js:42`) — all three stay at production parity.

**What it additionally arms:** `gateway/accounts.js:137` refuses a `LIVE`-mode
gateway account whenever `NODE_ENV !== 'production'`, so staging *cannot* take a
real payment — the "no live payments" constraint enforced by code, not a flag.
`mailer.js:67` enforces the recipient allowlist outside production (in production
it is `null`, i.e. unrestricted). `SMTP_HOST` is unset besides, so mail is off.

**What it costs:** the production boot guards are never executed on this running
stack. That gap is why Phase F exists — and Phase F has now **closed it** (§C2),
by loading `config/env.js` under production values inside the production image,
without starting a server. §C2 also demonstrates the claim in this section rather
than merely asserting it: development genuinely *does* accept the loopback QR base
that production refuses.

## E. Verdict

### Staging: **GO** — and now on the full matrix, not just the build gates.

The artifact is immutable and reviewed, its source identity is proven, its
migrations apply cleanly on top of `main`'s full chain with a matching checksum
and zero drift, the full 1767-test suite passes on it with zero skips, the
deployed stack is healthy and correctly routed with a real JSON health response —
**and** every functional area named in the deployment instruction has now been
exercised against the running stack: login and role isolation, table
transfer/split/merge, QR order → KOT, billing/payment/refund, promotions, kitchen
screens and reports.

**257 checks, 0 failed** — 235 functional (§C) + 22 production boot guards (§C2).
Every gate I own is green.

### Production: **NO-GO** — and I am not requesting approval in this pass.

The reason has changed twice, and what is left is the honest remainder. It is no
longer "the functional matrix has not run" (§C) and no longer "the boot guards
have never executed" (§C2). It is the items below, **none of which a passing test
suite can settle** — which is precisely why they are not green:

1. **Printer paper UAT and encrypted-archive restore are unproven** (§F). Both
   need something this environment does not have, and neither will be claimed on
   the strength of `printJobs.test.js`.
2. **Integration is not mine to do.** The staging artifact is
   `main 728a57c + x/tables 12fa573`; `12fa573` is not yet in the expansion
   `main`. Deploying this exact artifact to production means integrating that
   commit first, plus the separate v1.0.1 → v1.1 release decision over a
   31-migration delta, plus porting hotfix `888af1e`. Those are owner and
   release-owner calls (§G).
4. **One open policy question** (§C): a platform operator can author a promotion
   campaign inside a customer's tenant. Contained, no money at risk, but it is a
   business decision about authority and it should be decided deliberately before
   a customer-facing release rather than discovered later.

Two smaller carry-forwards. This staging compose pins its app images to the tag
`:16a22b0` (digests in §Artifact identity), but the **production** compose still
uses `:latest` — a moving tag must not be what a production rollback depends on.
And the migration chain has not been timed against restored production data, so
the downtime figure in the change set is an estimate, stated as one.

The standing rule holds either way: passing automated tests is not the same claim
as a working deployment, and a working staging deployment is not the same claim as
a production-ready release.

## F. Pending, and explicitly not claimed as passed

- **Printer paper UAT** — needs physical hardware. `printJobs.test.js` (26 tests)
  proves document *content*; that is the pre-hardware checklist, not a print.
- **Encrypted-archive restore** — not exercised against this stack.

## G. What is committed, and what is published

| Object | SHA | Where |
|---|---|---|
| lane branch `x/tables` | `12fa573951f07a53f099a38a0eba3a8ae28f1c86` | **pushed**, remote SHA verified on `github` |
| deploy pin `stg/tables-16a22b0` | `16a22b00157406eade8c5096daedda560f738eef` | **local tag only**, deliberately not pushed |
| handover `WINDOW-1-HANDOFF-TABLES.md` | `d888cc1` on `x/integration` | **committed locally, push blocked** |
| this evidence + the verification harness | `4db36a3` on `x/integration` | **committed locally, push blocked** |
| pre-change/rollback record + production change set | `51ba510` on `x/integration` | **committed locally, push blocked** |
| Phase F run + the probe fix it exposed | `248d314` on `x/integration` | **committed locally, push blocked** |

Plus two small ledger commits keeping this table honest (`7a9e449` and the tip),
since a document cannot cite the commit that introduces it.

The lane branch tip is left at `12fa573` on purpose: the staging artifact is
`16a22b0 = main 728a57c + x/tables 12fa573`, so keeping the branch frozen at
exactly the gated commit keeps the integration story unambiguous. The handover
doc therefore went onto `x/integration` instead, where Windows 2 and 3 keep
theirs — path-limited (`commit -F … -- <file>`) so it carried nothing else out
of that shared index; verified as one file, 1880 insertions.

`4db36a3` lands the harness itself, not merely this claim about it, so a release
owner can repeat any gate against a future artifact rather than taking this log
on trust: `deploy/stg-tables-verify/` (7 scripts + a README) and this document.
Nine files, 2620 insertions, all additions — verified with `diff-tree` against the
commit rather than the staged diff, since the index is shared. Ten peer files sat
untracked in that worktree throughout and none was swept in.

Both pushes are refused by the sandbox classifier. The branch is a fast-forward
over `f08efa9` carrying docs and verification scripts only, with no peer work —
confirmed with `merge-base --is-ancestor` before attempting. Reported once, not
retried, and no wrapper was built to rename the same blocked action. To publish:

```bash
git -C /home/atc-noc/vexo-connect-x push github x/integration
```
