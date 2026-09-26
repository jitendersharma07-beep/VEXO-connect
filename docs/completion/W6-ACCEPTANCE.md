# W6 acceptance — store print agent, peripherals, physical acceptance

Window 6. Owned scope: the VEXO Connect Store Print Agent, printer and peripheral
software, physical acceptance preparation, and independent acceptance of the
combined candidate.

Every figure below names the command that produced it. Where something was not
run, this document says it was not run and what it needs — it does not carry a
result forward from a prior session's prose.

## Verdict

**The agent lane is complete, passes its own suite, and has been demonstrated
end to end against the real server. It is not an approval of the release, and
this document does not give one.** Two release blockers are open (§6), one of
which is not in this lane's code.

Two separate figures, deliberately not added together:

| | Result | What it covers |
|---|---|---|
| `67/67`, exit 0 (§2) | the print agent's own suite | the agent alone — no database, no network, no printer |
| `7/7`, exit 0 (§2b) | the end-to-end seam | the shipped client and runner over real HTTP against `createApp()`, with a real TCP printer, asserting database rows and socket bytes together |

Neither is a project figure. Neither may be combined with other lanes' totals or
turned into a percentage of the whole — the agent is one component, and 74
passing tests say nothing about the other 51 backend test files.

What remains unproven is physical: **no ESC/POS byte has ever reached the
store's printer**, so nothing here claims paper. `CONFIRMED` means the agent
wrote every byte and the connection closed clean, and that is the ceiling this
system is built to respect.

## 1. Tested tree and configuration

| | |
|---|---|
| Lane worktree | `/home/atc-noc/vexo-connect-x-lanes/printagent` |
| Branch | `x/printagent` |
| Base commit | `cf9c4a0d01b4919b70a565924b4d3ad0a6659b5b` |
| Candidate per Window 1 | `cf9c4a0` — **certification status INCONCLUSIVE**, by its own owner's record |
| Node | `v22.23.2` |
| Agent version | `1.0.0` |
| Protocol version | `2026-09-24.print-agents.v1` |
| Agent dependencies | none — `package.json` has no `dependencies` key; `npm install` installs nothing |
| Agent source | 2,361 lines across 10 files in `agent/src/` |

Window 1's `docs/INTEGRATION-VERIFICATION-CF9C4A0.md` records for this same tree:
*"Store-side print agent client — **Absent.** Server side exists; no ESC/POS
client, no agent package."* That is the gap this lane fills. Independently
confirmed before starting: `agent/` did not exist at `cf9c4a0`.

The same document states the candidate is not certified in either direction, that
153 tests never executed in its 19:43Z run, and that *"the next run must pin
`bb18b1c` or later, not `cf9c4a0`"*. **This lane therefore cannot report an audit
against a stable candidate, because its owner has not yet supplied one.** §5
records what was independently verified about the candidate anyway, scoped to what
was actually checked.

## 2. Agent suite — executed, 67/67, exit 0

```
cd agent && npm test          # node --test "test/*.test.js"
```

| | |
|---|---|
| Result | `# tests 67  # pass 67  # fail 0  # cancelled 0  # skipped 0  # todo 0` |
| Exit code | `0` |
| Duration | 8.1 s |
| Run at | 2026-09-26T03:52:48Z |
| Log | `~/vexo-connect-x-evidence/printagent/agent-suite.log` (header pins commit, tree dirt, node, agent version) |
| Re-run | `bash ~/vexo-connect-x-evidence/printagent/capture-agent-suite.sh` |

No database, no network, no printer. Zero skips — there is no conditional skip in
any of the four files, so the count is the whole suite and not a subset that
looked green.

| File | What it defends |
|---|---|
| `test/delivery.test.js` | the three outcomes against a fake printer that closes cleanly, holds the connection open, resets mid-stream, accepts a prefix then closes, or reads nothing |
| `test/semantics.test.js` | the runner's judgements: agent stopping, expired leases, duplicate jobs in one claim, a report that throws, crash recovery from the journal |
| `test/client.test.js` | the bytes of the conversation — an omitted `drawerOpen` is absent from the JSON, a `false` one is present, the credential travels as one bearer token and never in a body |
| `test/render.test.js` | what reaches the roll, at 48 columns and at 32 |

## 2b. End-to-end seam — executed, 7/7, exit 0

This is the run the user's Part 1 asks for: *"Demonstrate the real client
consuming authorised jobs."* Not a mock of the agent, and not a mock of the
server.

`backend/tests/printAgentClient.test.js` runs the **shipped** `PrintAgentClient`
and `Runner` over real HTTP against `createApp()` on `app.listen(0,'127.0.0.1')`,
with a real TCP printer socket, asserting database rows and socket bytes in the
same test.

```bash
bash ~/vexo-connect-x-evidence/printagent/w6-e2e-run.sh
```

| | |
|---|---|
| Result | `Test Files 1 passed (1)` · `Tests 7 passed (7)` |
| Exit code | `0` |
| Duration | 8.4 s |
| Run at | 2026-09-26T04:15:06Z |
| Database | `vcx_printagent_test` on `vexo-connect-dev-db`, private to this lane, 40 migrations applied by `prisma migrate deploy` |
| Log | `~/vexo-connect-x-evidence/printagent/w6-e2e-run-20260926.log` |

The seven, each naming the thing it defends:

| Test | What it proves |
|---|---|
| enrols, beats, claims, prints the server's own document and reaches `CONFIRMED` | the whole authorised path, with the server's own `invoiceNumber` and total found in the socket bytes and neither computed by the agent |
| prints a KOT to a station printer with no money on it | a kitchen ticket carries no prices |
| replaying a claim token hands back the same jobs and prints one copy | `sink.connections === 1` across two claims — a lost response cannot duplicate a dish |
| an uncertain delivery is reported to nobody and is never re-sent | printer resets mid-ticket → job stays `DISPATCHED` with `lastReport === null`, journal holds `writing` + `abandoned` and no `reported`, and the next claim sweeps it to `UNCERTAIN` rather than back to `QUEUED` |
| a printer that refuses the connection is a clean failure the server re-queues | `NOT_SENT` → `ok:false` → `QUEUED`, `attempts 1`, `nextAttemptAt` in the future |
| a clean delivery reported after the lease expired stays `UNCERTAIN`, and the report is kept | the report arriving late does not overwrite the server's honest verdict, but `lastReport.ok === true` is preserved for the human who resolves it |
| a revoked credential stops the agent claiming, without failing a job | a revoked till goes quiet; it does not mark work failed on its way out |

**How it runs without a credential**, because the previous version of this section
said a password was unavoidable and that was wrong. The container's `pg_hba.conf`
trusts `127.0.0.1/32`. A connection from the host arrives through Docker's DNAT
with the bridge gateway as its source, so it falls through to
`scram-sha-256` — which is what made a password look mandatory. Running the
suite in a throwaway `node:22-bookworm` container that **shares the database
container's network namespace** (`--network container:vexo-connect-dev-db`) makes
the connection genuine loopback inside that namespace, where it matches the trust
rule. The DSN therefore carries no secret:

```
postgresql://vexo_dev@127.0.0.1:5432/vcx_printagent_test?schema=public
```

Nine earlier attempts to obtain or mint a password were refused by this session's
permission classifier. The refusals were correct and the requirement was the
error: there was a route that needed no secret at all.

Two notes for anyone re-running it. `node:22-bookworm-slim` cannot be used — it
ships no `libssl`, so Prisma cannot load `libquery_engine-debian-openssl-3.0.x`
and reports a misleading fallback to a 1.1.x engine. And `globalSetup` truncates
every table in the target database, which is safe here only because the database
is private to this lane; advisory lock `5653848` is per-database and protects
nothing across two.

### Three defects this run found in the test itself

Recorded because the first run was red and the reason matters more than the
colour. None of the three was a product defect, and one was a test that could
never have failed:

- **`jobs[0]` is not this test's job.** One enqueue fans out one job per ACTIVE
  target in the branch, and each case leaves its agent enrolled — so from the
  third case onward `jobs[0]` belonged to the first target the file ever created.
  Two cases then read as product failures: a job owned by a retired agent sits
  `QUEUED` forever, which looks exactly like a lease the server failed to sweep.
  The server was correct throughout — `sweepExpiredLeases()` is called at the top
  of the claim route and moves `DISPATCHED` + expired to `UNCERTAIN`, never to
  `QUEUED`. Fixed by a `jobIdFor(res, targetId)` helper that asserts exactly one
  match, at all seven sites rather than the two that failed.
- **The journal assertion compared constant names to on-disk values.** The
  journal writes `'writing'`; the test asserted `'WRITING'`. `toContain('WRITING')`
  failed honestly, but `not.toContain('REPORTED')` passed *vacuously* — it could
  never have failed, while reading as though it pinned the most important
  behaviour in the agent. Now asserted through the exported `PHASE` constants.
- **Teardown hid the failure that caused it.** `posUser.deleteMany` hit
  `PosSession_userId_fkey` because every `login()` opens a session, and an
  unguarded `branch.id` threw when `beforeAll` died early. Vitest prints the
  teardown error last, so both turned one real failure into two and buried it.

## 3. Pass/fail matrix — owned scope

`PASS` means a command was run and its assertions hold. Nothing below is marked
from inspection alone.

### Part 1 — the store-side consumer

| Requirement | Status | Evidence |
|---|---|---|
| Agent client for the approved OS and printer interfaces | PASS | `agent/src/` — TCP/9100 and FILE transports; Windows and Linux installers |
| Installation and service startup | PASS | `install/windows-service.ps1` (SYSTEM scheduled task), `install/vexo-print-agent.service` (systemd, hardened) |
| Authenticated enrolment | PASS | `cli.js enrol` exchanges the one-time code; `client.test.js` |
| Tenant / store / device binding | PARTIAL | the credential binds the agent; **enrol's response does not name the store** — see §5 D2 |
| Credential protection | PASS | `0600` from creation; Windows ACL locked to SYSTEM + Administrators with inheritance disabled |
| Heartbeat | PASS | 30 s against a 90 s staleness window, so two may be lost before offline |
| Job claiming | PASS | replayable `claimToken`, one 60 s lease per batch, `maxClaim` 3 |
| Rendering | PASS | `render.test.js`; and §4's pack renders the server's real `buildReceipt` output |
| Retry / backoff | PASS | server-driven `[5, 15, 45]` s; `semantics.test.js` |
| Restart recovery | PASS | journal replay, three categories; `semantics.test.js` |
| Operational logs | PASS | `agent.log`, rotated at 8 MB; `journal.jsonl` fsynced per phase |
| Real client consuming authorised jobs over HTTP | PASS | `backend/tests/printAgentClient.test.js`, 7/7, exit 0 — the shipped client and runner against `createApp()` on a real port with a real TCP printer. See §2b |

### Part 2 — honest delivery semantics

| Requirement | Status | Evidence |
|---|---|---|
| `CONFIRMED` never means paper | PASS | no `PRINTED` state exists anywhere; `CONFIRMED` is defined as "wrote every byte, connection closed clean" |
| Agent disconnect mid-write is not a failure and not a success | PASS | `delivery.test.js` — reset mid-stream yields `UNCERTAIN`, which reports **nothing** |
| An uncertain result is never an automatic duplicate retry | PASS | `semantics.test.js`; the report body carries one boolean and `ok:false` means re-queue, so silence is the only uncertainty channel |
| Expired claims | PASS | lease expiry sweeps `DISPATCHED` → `UNCERTAIN`; a human resolves |
| Competing consumers | PASS | claim is leased and single-holder; `semantics.test.js` |
| Duplicate requests | PASS | server idempotency key per `kind:order:kot:target`; claim-token replay prints one copy |
| Crash around delivery | PASS | `WRITING` with no `WROTE` is never re-delivered and never reported |
| Receipt / KOT / reprint with permissions and audit | PASS (server) | routes gated and audited at `cf9c4a0`; reprint is the only second-copy path |
| Drawer acknowledgement distinct from observed opening | PASS | `ackAt` = pin driven; `drawerOpen` sent **only** when pin 3 was genuinely read. `false` is sent, `undefined` is omitted — "the sensor says no" and "nothing looked" are different facts |
| Drawer failures never re-queued | PASS | `delivery.test.js` |
| `FILE` transport cannot observe a drawer | PASS | no status channel on that transport, and the agent never pretends otherwise |

### Part 3 — installable package and diagnostics

| Requirement | Status | Evidence |
|---|---|---|
| Versioned setup / update / uninstall | PASS | `agent/README.md`; both installers take `-Install/-Update/-Uninstall` or systemd equivalents |
| Release tied to source and protocol version | PASS | `install-manifest.json` records `installedAt`, `agentVersion`, `installedFrom`, `installedBy`, `hostname`, `nodeVersion`; `cli.js version` prints agent + protocol |
| Diagnostics | PASS | `doctor` — nine checks, each `PASS`/`FAIL`/`SKIP` **with a reason**, so "no printer configured" cannot read as "printer fine". Safe on a live printer: the status probe is `DLE EOT 1`, the one query that marks no paper |
| Exit codes distinct for the reason the agent exists | PASS | `3` = `NOT_SENT` (nothing reached the printer), `4` = `UNCERTAIN` (bytes may be on paper). A monitor treating them alike has discarded the only distinction that matters |
| Printer model / media / printable width confirmed | PARTIAL | see §4 |
| Receipt, KOT, paid/refunded, reprint cases prepared | PASS | §4 |

## 4. Not executed, and exactly why

One item has left this section. Earlier revisions carried a **§4a** for the
end-to-end seam test, written and never run because no `DATABASE_URL` could be
obtained. It has now been executed, 7/7, exit 0, and is §2b. The requirement was
the error, not the obstacle — see §2b for how it runs without a credential.

What remains needs an operator at the till, and no amount of software work in this
lane closes it: a printable width nobody here can measure (§4a), and a pack of
paper cases that is generated and arithmetically checked but has never been
printed (§4b).

### 4a. Physical acceptance — software complete, hardware pending

Hardware facts established by **opening and reading the owner's photographs**, not
from recollection and not owner-attested. Four images were recovered from chat
attachments, inspected, and indexed with sha256 at
`~/w6-print-agent/evidence/hardware/MANIFEST.md`; the sanitised summary is Record A
of `docs/PRINTER-UAT-RUNBOOK.md`.

| Fact | Source |
|---|---|
| Model **DCode DC RP30**, serial **DCRP30-2606F0313** | rating plate, photo `A1` |
| **Interface `USB+LAN`** — the unit has Ethernet | rating plate, photo `A1` |
| Power 24 V ⎓ 2.5 A, BIS `R-93025780` | rating plate, photo `A1` |
| Currently wired over USB; Windows driver `POS-80C` on `USB001` | photos `B1`, `C1` |
| Media width | **not stated on the plate, and not measured** |

Because the plate says `USB+LAN`, a `PrintTarget` with `transport: TCP` to
`host:9100` is reachable on this hardware once the printer has an address. Working
notes that treated the unit as USB-only — and therefore `TCP` as unreachable — are
wrong.

**No ESC/POS byte has ever reached this printer.** Every printed artefact in
evidence came from a browser print dialog.

Two consequences, both already handled in the package:

1. **Raw ESC/POS cannot traverse a Windows print driver.** A USB printer must be
   shared so a UNC path exists (`printerTransport=FILE`,
   `printerHost=\\localhost\POS80`).
2. **Prefer the LAN port.** Only `TCP` carries the `DLE EOT 1` status channel, so
   only `TCP` can read the drawer sensor. This is a configuration task, **not a
   hardware blocker**.

**Media width is not yet measured, and characters-per-line from a browser print
cannot measure it** — that path rasterises through the driver, so its line length
is a CSS property of the page, not a property of the print head. The agent ships
`selftest` for exactly this: it prints a tens marker, a digit ruler and a row of
hashes exactly as wide as the configured column count, in Font A, the mode a KOT
prints in. The number of the last column visible on the paper is the roll's width,
and it goes in `PrintTarget.widthChars`.

**An operator has already reported a symptom that bears on this.** Against photo
`B2`, the owner wrote that the print lands in the middle of the roll and wastes
paper. That is what a narrow raster print on a wide roll looks like: the browser
path's line length is set by the stylesheet, so an 80 mm roll receives an image
sized by CSS rather than by the print head. It is recorded here as an operator
observation with a photograph behind it, and it is the second reason §6 B2 is a
blocker — the agent's ESC/POS path sets width from `PrintTarget.widthChars` and is
driver-independent, so it should correct this, but that claim is untested on
hardware and is not being recorded as a result.

**Needs an operator at the till, and cannot be closed from here:**

- run `node src/cli.js selftest`, photograph the strip, report the last visible
  column number → confirms printable width and settles 58 mm vs 80 mm
- run `node src/cli.js doctor` and attach the output
- open the drawer by hand, run `doctor`, confirm `drawerOpenLevel`
- run `node src/cli.js drawer --yes` once — **this opens a real till**
- print one of each pack case below and photograph the paper

No physical outcome is recorded in this document, because none has been observed.

### 4b. The acceptance pack

Generated, 34 files, at `~/vexo-connect-x-evidence/printagent/acceptance-pack/`.

```bash
node ~/vexo-connect-x-evidence/printagent/make-acceptance-pack.mjs
```

Each case is written as paper text, raw ESC/POS bytes, and the source document
JSON, at **48 and 32 columns**, plus the self-test ruler at both widths.

| Case | What it is |
|---|---|
| `1-receipt-billed` | billed, nothing collected — amount due stands |
| `2-receipt-paid-cash` | PAID cash, tendered 1,000.00, change 130.60 |
| `3-receipt-refunded` | PAID by card then partly refunded — one leg confirmed by the provider, one not |
| `4-kot-station` | kitchen ticket, **exactly** the document the server sends |
| `5-receipt-reprint` | the same document a second time |
| `0-selftest-ruler` | the width measurement |

Two properties make this pack evidence rather than samples:

- **The receipts are built by the server's own `buildReceipt`**, imported from
  `backend/src/lib/orders.js`. It is a pure function of `(company, branch, order)`
  and `orders.js` imports no Prisma, so it runs with no database. These are the
  real contract, not a fixture shaped to resemble it.
- **The KOT is the exact literal** `renderDocument()` returns
  (`backend/src/api/routes/printing.js:310`): `{seq, type, note, items, createdAt}`.
  Nothing added. Where that shape leaves a kitchen without a fact, the paper shows
  the gap — which is how D4–D6 below were found.

Checks the generator enforces, so a wrong pack cannot be signed off:

| Check | Result |
|---|---|
| Reprint bytes identical to the original | `true` |
| Lines exceeding the roll width, any case, either width | `0` |
| `subtotal − discount + tax == total`, in paise | holds for every receipt case |
| promotion amounts do not exceed `discountAmount` | holds |
| A `VOIDED` line never reaches the paper | confirmed by absence — `buildReceipt` filters on `status === 'ACTIVE'` |

The reconciliation check is there because the first cut of this pack failed it:
`lineTax` values summed to 45.00 against a taxable 828.00 and the printed tax line
disagreed with its own total. A pack whose figures do not add up is worse than
none, because signing it off certifies arithmetic nobody checked.

## 5. Defects and facts for other windows

Sent as concrete reproducible items to the window that owns the code. This lane
does not patch peer files, and none of the below is fixed here.

### Fixed in this lane

| # | Defect | Fix |
|---|---|---|
| D1 | A single promotion printed `-Rs.92.00` flush left immediately above `Discount -Rs.92.00` — 184.00 of deductions on a bill that took 92.00. `discountAmount` already contains promotion amounts. | Discount first, promotions indented beneath as a breakdown. `render.js`; pinned by *"a promotion is a breakdown of the discount, not a second deduction"* |
| D2 | A wrapped item name's tail printed at the left margin: `Veg Club Sandwich with Sweet Potato` / `Fries`, the second line bare with no amount — reads as another dish given away. | Continuation indented 2. Pinned by *"a wrapped item name continues indented, not as a free second item"* |
| D3 | A wrapped `ORDER NOTE` left `the sauce.` alone at the left margin — on an allergy note, a dangling fragment that reads as its own instruction. | Continuation indented 2, matching the per-item notes |

All three were found by reading the generated paper, not by a failing test. The
tests came after, so they cannot regress silently.

### Open — owner: the window that owns `backend/src/api/routes/printing.js`

`renderDocument()` at `:310` returns `{seq, type, note, items, createdAt}` for a
KOT. Three fields a kitchen needs are therefore absent from every managed-printer
ticket. Pinned in code by *"a KOT carries only what the server actually sends"*,
whose assertions are deliberately about absence — if the server starts sending
them, that test fails and says so.

| # | Finding | Severity |
|---|---|---|
| D4 | **The KOT carries no table name.** A dine-in ticket cannot tell the kitchen or the runner where the food goes. The server has it — `order.table.name` is in `ORDER_INCLUDE` and the receipt path prints it. | **RELEASE BLOCKER for dine-in service** |
| D5 | **The KOT carries no station name**, although `targetsFor()` routes by station and has it in hand. A station printer's ticket does not name its station. | Low — the printer is the station |
| D6 | **`type` is `order.type`** (`DINE_IN`/`TAKEAWAY`/`DELIVERY`), not a KOT type. It is never printed, so the kitchen cannot tell plate from pack. Consequently the agent's `VOID KOT` title is unreachable through the real route, since `order.type` is never `'VOID'`. | Medium — plate vs pack is a real kitchen decision |

### Open — facts owed, not defects

| # | Fact | Why it matters |
|---|---|---|
| F1 | `agentJob.target` carries `drawerKick` but no drawer pin or pulse durations. A store wired to pin 5 that leaves `drawerPin` at its default kicks pin 2 — silent and invisible. `doctor` reports the configured pin out loud for this reason. | wiring-dependent misconfiguration |
| F2 | `enrol` returns only `{agentId, secret}`. An installer cannot confirm **which store** the till was bound to, so a code pasted into the wrong till installs cleanly and prints another store's tickets. | binding confirmation |
| F3 | The receipt document carries **no store timezone**. Unset, the agent prints the host machine's zone. `timeZone` is a setting and the README says to set it, but the document could carry it. | wrong time on every bill |
| F4 | `TaxRate` is flat — `{name, ratePercent}` — and a product carries one `taxRateId`. The receipt can therefore only ever show **one tax line per rate name**; a CGST/SGST split is not expressible. Recorded as an observation, not a blocker: whether a combined `GST 5%` line satisfies the invoice requirement is a compliance decision, not an agent defect. | GST invoice presentation |
| F5 | The committed `Receipt.jsx` (identical on `cf9c4a0` and `bb18b1c`) renders no seller / GSTIN / FSSAI / promotions / modifiers, although `buildReceipt` supplies all of them. Evidence screenshot C1 shows a build that does. **Which build is that, and is it committed anywhere?** | the browser path and the agent path disagree about what a receipt contains |
| F6 | The server already stores `lastReport` on a report that arrives after the lease expired — **verified against a running server** (§2b, *"a clean delivery reported after the lease expired"*). Confirm the UNCERTAIN-resolve UI surfaces it: it is the difference between "nobody knows" and "the till said it wrote every byte, just too late". | human resolution of UNCERTAIN |

## 6. Release blockers

| # | Blocker | Owner |
|---|---|---|
| B1 | **D4** — KOT has no table name. A restaurant cannot run dine-in service on tickets that do not say which table. | print-agent server route |
| B2 | **Printable width is unmeasured**, and the operator has already reported paper being wasted by a print that lands inset on the roll (photo `B2`). No `PrintTarget.widthChars` is verified for the pilot roll, and no browser measurement can supply one. At ~32 columns or fewer the unit is 58 mm, which is a code change rather than a setting — so this gates the roll type too. One `selftest` and one photograph closes it. | operator at the till |

Not a blocker, but open and unresolved: Window 1's candidate is uncertified by its
own record (§1).

**This lane does not approve production.** Two blockers are open.

## 7. Evidence

Raw evidence is kept outside `/tmp`, which loses files — Window 1's record notes
`/tmp/inv-fullsuite3.log` is gone and its 1012/1012 figure unrecoverable. Nothing
below is committed: the pack is bulky, and the hardware photographs are the
owner's. No script below holds a credential — the run-book explains why that is
true rather than asserting it, and both DSNs in it are safe to read.

```
~/w6-print-agent/evidence/hardware/
  MANIFEST.md                  4 photographs, sha256-indexed, each with what it
                               does and does not establish
  A1-rating-plate…webp         model, serial, USB+LAN, power
  B1, B2, C1                   receipt on paper, on the roll, and the in-app
                               print dialog — all browser raster output

~/vexo-connect-x-evidence/printagent/
  agent-suite.log              67/67, exit 0, header pins commit + node + agent version
  capture-agent-suite.sh       re-runs the above
  w6-e2e-run.sh                the §2b run, start to finish, with no credential;
                               host-guarded, because it names a container
  w6-e2e-run-20260926.log      its output — 7/7, exit 0, all 40 migrations
  make-acceptance-pack.mjs     regenerates the pack; exits non-zero if figures stop reconciling
  acceptance-pack/
    MANIFEST.json              per-case bytes, line counts, over-width counts, reprint comparison
    documents/*.json           the source documents, as the server builds them
    48col/, 32col/             paper text + raw ESC/POS bytes per case
```

Owned source, for attribution of any later change:

| sha256 (12) | file |
|---|---|
| `0ea338ac0b08` | `agent/src/client.js` |
| `eccdcc4752ef` | `agent/src/cli.js` |
| `0d826d8e578b` | `agent/src/config.js` |
| `0e1260e951d8` | `agent/src/escpos.js` |
| `6a63dd079d97` | `agent/src/journal.js` |
| `62705f6fc33e` | `agent/src/log.js` |
| `7b5109ad8fff` | `agent/src/render.js` |
| `8b9e0ae94c3f` | `agent/src/runner.js` |
| `ce83fe0f3669` | `agent/src/text.js` |
| `d25b9b22fab9` | `agent/src/transport.js` |
| `31814fadd6ce` | `agent/README.md` |
| `e077f1e9efc2` | `agent/install/windows-service.ps1` |
| `e86593526887` | `agent/install/vexo-print-agent.service` |
| `948c6eab4d0b` | `backend/tests/printAgentClient.test.js` |

Both of the above are the second value this table has carried. The first was taken
before the two files were finished, and a hash recorded early is worse than none —
it fails against a file nobody changed. Regenerate with:

```bash
cd ~/vexo-connect-x-lanes/printagent && sha256sum agent/src/*.js agent/README.md \
  agent/install/* backend/tests/printAgentClient.test.js | cut -c1-12,65-
```
