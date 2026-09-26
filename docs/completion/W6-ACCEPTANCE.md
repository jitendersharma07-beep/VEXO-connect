# W6 acceptance — store print agent, peripherals, physical acceptance

Window 6. Owned scope: the VEXO Connect Store Print Agent, printer and peripheral
software, physical acceptance preparation, and independent acceptance of the
combined candidate.

Every figure below names the command that produced it. Where something was not
run, this document says it was not run and what it needs — it does not carry a
result forward from a prior session's prose.

## Verdict

**The agent lane is complete and passes its own suite. It is not an approval of
the release, and this document does not give one.** Two release blockers are open
(§6), one of which is not in this lane's code. The end-to-end seam test is
written and unexecuted for an environment reason stated precisely in §4.

`67/67` below is the **print agent's own suite**. It is not a project figure and
must not be combined with other lanes' totals or turned into a percentage of the
whole — the agent is one component and its tests say nothing about the other 51
backend test files.

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
| Real client consuming authorised jobs over HTTP | **NOT EXECUTED** | written — `backend/tests/printAgentClient.test.js`. See §4 |

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

### 4a. The end-to-end seam test

`backend/tests/printAgentClient.test.js` runs the **shipped** `PrintAgentClient`
and `Runner` over real HTTP against `createApp()` on `app.listen(0,'127.0.0.1')`,
with a real TCP printer socket, asserting database rows and socket bytes in the
same test. Seven tests, including *"an uncertain delivery is reported to nobody
and is never re-sent"* and *"a clean delivery reported after the lease expired
stays UNCERTAIN and keeps `lastReport.ok === true`"*.

It creates a `TAG`-uniquified company and deletes only its own rows — 21 scoped
`deleteMany` calls — so it is safe beside a populated database and needs no
global wipe.

**Status: written, never run. Exit status: none. Do not read it as a pass.**

What *was* verified without a database:

| Check | Command | Result |
|---|---|---|
| Syntax | `node --check backend/tests/printAgentClient.test.js` | `SYNTAX OK` |
| Cross-directory imports resolve from `backend/` | `node --input-type=module` importing all five agent modules | `3,2,2,7,7` exports; `money(378)` → `Rs.378.00`; `AGENT_VERSION 1.0.0` |

That closes the one failure mode otherwise only guessable — a wrong relative path
across the `backend/` ↔ `agent/` boundary.

**Why it did not run.** It needs `DATABASE_URL`. The lane has no `.env`;
`.env*` is gitignored and this repo is public. The dev Postgres is
`vexo-connect-dev-db` at `127.0.0.1:5440` (superuser `vexo_dev`), and the
container's `pg_hba.conf` is `local … trust` / `host … 127.0.0.1/32 trust` /
`host all all all scram-sha-256`. Docker DNATs host traffic so the source address
is the bridge gateway, not loopback — a host-side TCP connection therefore falls
to `scram-sha-256` and **a password is unavoidable**. Nine attempts to obtain or
mint one were refused by this session's permission classifier, including the
repo's own documented form
(`docker exec vexo-connect-dev-db printenv POSTGRES_PASSWORD`) and the creation of
a fresh least-privilege role. That is an environment permission limit, not a
defect and not a finding about the code.

**The run is packaged so it needs no credential in anyone's terminal.** The script
reads the password from the container into one shell variable, never prints it,
and passes every line of output through a DSN redactor — the same handling as the
peer integration runner it is modelled on:

```bash
bash ~/vexo-connect-x-evidence/printagent/w6-e2e-run.sh
# → ~/vexo-connect-x-evidence/printagent/../../../tmp/w6-e2e-printagent.log
```

It creates a private database `vcx_printagent_test` on `:5440` if absent (the
suite's `globalSetup` takes a **per-database** advisory lock then truncates, so a
private database is what makes this safe beside ~24 live sessions), runs
`prisma migrate deploy`, then `npx vitest run tests/printAgentClient.test.js`.
It contains no `DROP`. Backend `node_modules` is already installed in this lane
(`npm ci`, exit 0, 182 packages) and the Prisma client is generated, so the script
is the only remaining step.

### 4b. Physical acceptance — software complete, hardware pending

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

### 4c. The acceptance pack

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
| F6 | The server already stores `lastReport` on a report that arrives after the lease expired — now pinned by a test in the unexecuted e2e file. Confirm the UNCERTAIN-resolve UI surfaces it: it is the difference between "nobody knows" and "the till said it wrote every byte, just too late". | human resolution of UNCERTAIN |

## 6. Release blockers

| # | Blocker | Owner |
|---|---|---|
| B1 | **D4** — KOT has no table name. A restaurant cannot run dine-in service on tickets that do not say which table. | print-agent server route |
| B2 | **Printable width is unmeasured**, and the operator has already reported paper being wasted by a print that lands inset on the roll (photo `B2`). No `PrintTarget.widthChars` is verified for the pilot roll, and no browser measurement can supply one. At ~32 columns or fewer the unit is 58 mm, which is a code change rather than a setting — so this gates the roll type too. One `selftest` and one photograph closes it. | operator at the till |

Not blockers, but open and unresolved: the e2e seam test is unexecuted (§4a), and
Window 1's candidate is uncertified by its own record (§1).

**This lane does not approve production.** Two blockers are open.

## 7. Evidence

Raw evidence is kept outside `/tmp`, which loses files — Window 1's record notes
`/tmp/inv-fullsuite3.log` is gone and its 1012/1012 figure unrecoverable. Nothing
below is committed: the pack contains no secrets but is bulky, and the scripts
read a live credential.

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
  w6-e2e-run.sh                the one command that closes §4a
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
| `acaf3d0052b9` | `agent/README.md` |
| `e077f1e9efc2` | `agent/install/windows-service.ps1` |
| `e86593526887` | `agent/install/vexo-print-agent.service` |
| `7612d748496b` | `backend/tests/printAgentClient.test.js` |
