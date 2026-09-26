# Window 6 → Window 1 handoff (2026-09-26)

Window 6 owns the Store Print Agent, printer/peripheral software, physical
acceptance preparation, and the independent audit of the combined candidate.

The full record, with every command and its true exit status, is
`docs/completion/W6-ACCEPTANCE.md`. This file is the actionable part: what is
decided, what is owed, and by whom. Nothing here is new evidence — every row
points at a section of that document.

**Headline, so it is not buried.** The agent lane is complete and proven end to end
against the real server. **This lane does not approve production.** Two release
blockers are open, the candidate is uncertified by its own record and now by
measurement, and its test harness does not finish deterministically.

## 1. Decisions Window 1 owes — nothing else can close these

| # | Decision | Why it cannot be answered here |
|---|---|---|
| Q1 | **Is Kiosk in v1.1 scope?** It is absent from the candidate: two incidental prose matches across the whole commit, no route, no role, no enum value, no screen. | A missing feature is a scope answer, not a test. This lane recorded **NOT VERIFIABLE** rather than a fail, because failing a feature nobody built is not a finding. §7h, A6 |
| Q2 | **Does `CAPTAIN` ship untested?** It is a six-permission bundle over existing order/KOT routes — including `order.item.void`, the right to void a line on someone else's order — and `CAPTAIN` appears in **0 of the candidate's 52 test files**. Its own schema comment says *"takes orders, cannot bill"*; nothing asserts that. | Writing those tests is implementation, and this lane must not become a second implementation owner |
| Q3 | **Does licence enforcement gate anything?** The mechanism is correct and fails closed (14/14), and by the suite's own final assertion it gates **no action** in this candidate. | Whether that is intended for v1.1 is a product decision. §7f, A3 |
| Q4 | **Does the API container ship running as root?** No `USER` directive, `/app` is `root:root`, confirmed by `id` inside the running container — and the base image already carries an unused `node` user at uid 1000. | A one-line `chown` + `USER node`, but it is a peer file. §7g, A7 |
| Q5 | **Which build produced evidence screenshot `C1`?** It renders seller / GSTIN / FSSAI / promotions / modifiers. The committed `Receipt.jsx` renders none of them, although `buildReceipt` supplies all of them. | The browser path and the agent path disagree about what a receipt contains, and this lane cannot tell which is the intended one. §5 F5 |

## 2. Release blockers

| # | Blocker | Owner |
|---|---|---|
| **B1** | **The KOT carries no table name.** `renderDocument()` at `printing.js:310` returns `{seq, type, note, items, createdAt}`. A dine-in ticket cannot tell the kitchen or the runner where the food goes. The server has it — `order.table.name` is in `ORDER_INCLUDE` and the receipt path already prints it. | the window owning `backend/src/api/routes/printing.js` |
| **B2** | **The print head's column count is unmeasured — 48 or 42.** The roll is not in doubt: the build supports 80 mm roll / 72 mm printable, and 58 mm is a code change rather than a setting. What is unmeasured is resolution across that width — 576 dots at 203 dpi or 512 at 180 dpi, i.e. 48 or 42 Font A columns. No browser measurement can supply it. | **operator at the till** — one `selftest` strip and one photograph |

B2 is an external dependency, stated precisely because the remit asks for that: it
needs a person at the physical printer, and until then **no row of physical
acceptance may be marked tested**. Window 3's 2026-09-24 revision of
`frontend/docs/HARDWARE-CHECKLIST.md` already withdrew the *"576 dots @ 203 dpi ←
what this build targets"* claim for the same reason, so this is two windows
independently reaching the same open question.

## 3. Audit findings, with owners

A1–A9 are in `W6-ACCEPTANCE.md` §7c–§7h, each with the command that establishes it.
The two that are time-sensitive:

| # | Finding | Action |
|---|---|---|
| **A1** | **The certification run in flight did not contain the fix it was meant to certify.** `vcx_integration_test` had 40 applied migrations and no `LoyaltyProfileLink` index; the 41st landed in that tree 36 s *after* the run started, and `d625370` was committed 53 s after that. So its bytes are not one commit, and whatever it reports about cascade timing describes the **unfixed** schema. | Re-run: `migrate deploy` first, assert the index exists, and run from a tree nothing is writing to. `git archive` costs seconds. §7d |
| **A9** | **The inventory suites truncate all 139 tables before every test** — `beforeEach`, not `beforeAll`, in all five files. 150 tests, so 150 whole-database truncates per full run, measured at ~2.1 s each against a 30 s `hookTimeout`. Three runs, four different failing tests, one identical `Hook timed out in 30000ms.`, never an assertion. | Move the wipe to `beforeAll`, or narrow it. `buildBaseFixture` already mints a unique tenant per call, so the isolation the global wipe provides mostly exists already. Saves ~5 minutes and removes the failure mode. §7c |

A9 is a **certification** blocker rather than a product one, and worth stating plainly:
a candidate whose suites report a different failure each run cannot be certified by
anyone, in any lane. It is also the cheapest open item to fix.

The remaining findings, in one line each: **A2** shared-database wipes delete each
other's rows (§7e) · **A3** licence gate has nothing behind it (§7f) · **A4** the image
runs Node `v20.20.2` while every figure in this programme came from Node 22, and
`backend/package.json` has no `engines` field although `agent/package.json` does
(§7g) · **A5** the frontend `.dockerignore` misses nested paths where the backend's
does not (§7g) · **A7** the API container runs as root (Q4 above) · **A8** `EXPOSE 5000`
against `PORT || 5010` (§7g).

## 4. What this lane verified on the candidate, so it is not re-run

Executed against `d625370`'s exact bytes — `git archive` into a tree outside every
lane, three files sha256-checked against `git show` first, and a database private to
this audit so no peer run could pollute it or be polluted by it.

| Suites | Result | Covers |
|---|---|---|
| `gateway`, `phoneOrders` | **153/153, exit 0** | payments, refunds, gateway reconciliation — the first measurement the money path has produced. §7a |
| 11 files | **281/281, exit 0** | tenant isolation, recovery, Table/QR, customer display, admin/company/user workflows, and the returned `reportingExceptions` fix. §7b |
| 17 files | **629/631, exit 1** | stock effects, reporting reconciliation, billing beyond the gateway. Every assertion that executed passed; both failures are A9. §7c |

1,065 candidate tests, counted once each. **This is audit coverage, not a project
score.** It may not be combined with other lanes' totals or turned into a percentage,
and a green suite is a statement about that suite and nothing wider.

**`d625370`'s index works — measured, because no suite can see it.** This is the good
news in this handoff and the reason A1 matters more rather than less.

| Measurement | Result |
|---|---|
| Unindexed delete, 6,000 → 12,000 customers | 5,679 ms → 20,173 ms: **3.55× for 2× the data**, an exponent of **N^1.83**. Quadratic is the right family and slightly strong |
| Index present, same 12,000 | **3,713 ms — 5.43× faster**, and faster in absolute terms than the unindexed run at *half* the size |
| Planner | `Bitmap Index Scan` with it, `Seq Scan` without, asked against a populated table |
| Extrapolated to 100,000 customers | **974–1,401 s**, which independently reproduces the 900 s overrun the commit message describes |
| The 41st migration on a **populated** table (100,000 customers / 200,000 links / 64 MB) | applied cleanly, all 300,000 rows survived. Prisma recorded **342 ms** — but a concurrent writer was blocked **6.714 s**, because the `SHARE` lock is held for the transaction Prisma wraps the migration in, not for the statement |

So the migration file's own note — *convert to `CREATE INDEX CONCURRENTLY` before a
large production table* — is correct in mechanism and now has a number against it. It
also means the self-reported duration of any Prisma migration understates its
write-blocking window; worth knowing before the production window is scheduled. §7d

Also established, first time in this programme: **the backend release image builds
(53.7 s, 13 layers, 162 MiB), boots, and answers `GET /health` with `200`** — which
also proves Prisma loaded its engine and reached Postgres. It ships no `.env`, no
`*.md` and no `_proof` asset. That is one container, one probe, an empty database and
no frontend image: evidence, not a certification. §7g

## 5. The print agent itself

Complete, and the parts Window 1 may need to integrate against:

- **The contract is unchanged.** Protocol `2026-09-24.print-agents.v1`, consumed as
  published: enrol → heartbeat → claim → report.
- **`CONFIRMED` is the ceiling and means "wrote every byte, connection closed clean".**
  There is no `PRINTED` state and this lane will not add one. An uncertain physical
  result reports **nothing** — silence is the only uncertainty channel, so an
  uncertain print can never become a false success or an uncontrolled duplicate.
- **Drawer acknowledgement is not drawer opening.** `ackAt` means the pin was driven;
  `drawerOpen` is sent only when the pin-3 sensor was genuinely read. `false` and
  `undefined` are different facts and both are transmitted as such.
- **Own suite 67/67, exit 0. End-to-end seam 7/7, exit 0** — the shipped client and
  runner over real HTTP against `createApp()`, with a real TCP printer, asserting
  database rows and socket bytes together.
- **Acceptance pack ready** — 10 cases at 48 and 42 columns, 0 over-width lines,
  reprint bytes byte-identical to the original. It renders the server's real
  `buildReceipt` output, not a mock.

Three defects the pack found by reading generated paper rather than by a failing test
(D1–D3) are fixed in this lane and now pinned by tests, so they cannot regress
silently. Three KOT content gaps (D4–D6) and six facts owed (F1–F6) are in §5 with
owners.

## 6. Not verified, and why — no row of this is a pass

- **No ESC/POS byte has ever reached the store's printer.** Nothing in this lane
  claims paper. Every physical row is NOT TESTED pending B2.
- **Restore-from-backup.** This lane took no backup and restored none, and no peer
  document claims a successful restore either — Window 3's handoff says so in those
  words. What *is* evidenced is that an encrypted archive ships and a nightly send is
  armed. The remaining step is **owner-gated**: the gpg private key is
  passphrase-protected, the proof has to happen on the owner's own machine, and the
  current destination is a host this lane is instructed not to access.
- **The frontend image** was never built, and the backend image was exercised by one
  health probe against an empty database.
- **Kiosk** — see Q1. Not a coverage gap.

## 7. If you cut a newer candidate

Say so and this lane will re-run the audit against it. The runs above are pinned to
`d625370` by sha256 and are not transferable to another commit — which is the whole
reason they were taken from an extracted tree rather than a working copy. Every
script is in `~/vexo-connect-x-evidence/printagent/`, host-guarded, and holds no
credential; the acceptance document explains why that is true rather than asserting
it.
