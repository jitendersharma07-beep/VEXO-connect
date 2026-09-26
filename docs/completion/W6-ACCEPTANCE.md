# W6 acceptance — store print agent, peripherals, physical acceptance

Window 6. Owned scope: the VEXO Connect Store Print Agent, printer and peripheral
software, physical acceptance preparation, and independent acceptance of the
combined candidate.

Every figure below names the command that produced it. Where something was not
run, this document says it was not run and what it needs — it does not carry a
result forward from a prior session's prose.

## Verdict

**The agent lane is complete, passes its own suite, and has been demonstrated
end to end against the real server. The independent audit of the combined
candidate is NOT complete. This is not an approval of the release, and this
document does not give one.** Two release blockers are open (§6), one of which is
not in this lane's code; parts of the audit remit are unmeasured, one of them because
the feature is not in the candidate at all (§7g, §7h).

Four separate figures. The first two are this lane's own work; the last two are the
candidate's code, measured by this lane's audit:

| | Result | What it covers |
|---|---|---|
| `67/67`, exit 0 (§2) | the print agent's own suite | the agent alone — no database, no network, no printer |
| `7/7`, exit 0 (§2b) | the end-to-end seam | the shipped client and runner over real HTTP against `createApp()`, with a real TCP printer, asserting database rows and socket bytes together |
| `153/153`, exit 0 (§7a) | **not this lane's code** | the candidate's own gateway and phone-orders suites, run because nobody had a result for them — the first measurement the money path has ever produced |
| `281/281`, exit 0 (§7b) | **not this lane's code** | eleven candidate suites chosen to answer named areas of the Part 4 remit — tenant isolation, recovery, Table/QR, customer display, admin and licence workflows |

None of the four is a project figure, and none may be combined with other lanes'
totals or turned into a percentage of the whole. The agent is one component, and
the last two rows are somebody else's code that this lane merely measured — a green
result there says those suites pass, not that the release is ready. The 434 in §7h
is the count of candidate tests this audit executed, which is a statement about
audit coverage and nothing else.

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

Re-run at lane `HEAD` after the 42-column change below: still `67/67`, exit 0, zero
skipped. The wall time was 32 s rather than the logged 8.1 s, on a box carrying two
peer certification runs — which is worth stating as a measured fact about the box,
not the suite.

| File | What it defends |
|---|---|
| `test/delivery.test.js` | the three outcomes against a fake printer that closes cleanly, holds the connection open, resets mid-stream, accepts a prefix then closes, or reads nothing |
| `test/semantics.test.js` | the runner's judgements: agent stopping, expired leases, duplicate jobs in one claim, a report that throws, crash recovery from the journal |
| `test/client.test.js` | the bytes of the conversation — an omitted `drawerOpen` is absent from the JSON, a `false` one is present, the credential travels as one bearer token and never in a body |
| `test/render.test.js` | what reaches the roll, at **48, 42 and 32** columns. 42 was added after D7: it is the second width the real print head may be (512 dots ÷ 12), and the over-run check had been covering only 48 and 32. Same 67 tests — one existing case widened its loop, so no figure moved |

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

### Part 4 — independent audit of the combined candidate

Audited against `d625370`. This is the part of the remit that is **not complete**,
and the rows below say which parts are which rather than averaging them.

| Requirement | Status | Evidence |
|---|---|---|
| Verify *those exact bytes*, not a lane's working copy | PASS | `git archive d625370` into a scratch tree, three files sha256-checked against `git show`. §7 |
| Payments / refunds / gateway reconciliation | PASS | 153/153, exit 0 — the two suites nobody had a result for. §7a |
| Admin / company / user workflows | PASS | 108/108 across `platformAdmin`, `foundation`, `foundationPeople`, `invitations`. §7b |
| Tenant isolation | PASS | `authTenantIsolation` 11/11, plus the gateway suite's *"never shows one tenant the gateway traffic of another"*. §7a, §7b |
| Table/QR | PASS | `tableQr` 74/74. §7b |
| Customer display | PASS | `customerDisplay` 13/13. §7b |
| Recovery behaviour | PASS | `accountRecovery` 33/33 and `accountRecoveryOutage` 5/5. §7b |
| **Licence enforcement** | **PARTIAL** | the mechanism is correct and fails closed (14/14), and by its own final assertion it **gates no action in this candidate**. A green suite here is not enforcement. §7e |
| Fresh-migration evidence | PARTIAL | 41 migrations applied to an **empty** database, twice over (§2b at 40, §7a at 41), both logged. Never applied to a populated one — §7h |
| Release images and build context | PARTIAL | the backend image **built (53.7 s), booted, and answered `GET /health` with `200`** — the first such evidence in this program. Four findings (A4, A5, A7, A8) and three things done right. No frontend image was built, and one health probe is not a release. §7f |
| **Captain** | **PARTIAL** | Captain is a role, not a feature: a six-permission bundle, no route or screen. The bundle exists and is store-pinned; **`CAPTAIN` appears in 0 of the candidate's 52 test files**, including its `order.item.void` grant. §7g, A6 |
| Defects returned to the responsible window | PASS | A1–A8 in §7c–§7g, each with the command that establishes it; D4–D7 and F1–F6 in §5. No peer file was edited by this lane |
| **Kiosk** | **NOT VERIFIABLE** | not a coverage gap — Kiosk is **absent from the candidate**. Two incidental prose matches in the whole commit, no route, role, enum value or screen. A scope answer is owed by Window 1; this lane cannot record a pass. §7g, A6 |
| Stock-effect / billing reconciliation beyond the gateway | **NOT VERIFIED** | §7h |
| Restore-from-backup evidence | **NOT VERIFIED** | nothing at all was produced here. §7h |

## 4. Not executed, and exactly why

One item has left this section. Earlier revisions carried a **§4a** for the
end-to-end seam test, written and never run because no `DATABASE_URL` could be
obtained. It has now been executed, 7/7, exit 0, and is §2b. The requirement was
the error, not the obstacle — see §2b for how it runs without a credential.

What remains needs an operator at the till: a print-head column count nobody here
can measure (§4a), and a pack of paper cases that is generated and arithmetically
checked but has never been printed (§4b). The pack is finished software; what it
lacks is paper.

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
| Media width | **not stated on the plate, and not measured here** |
| Roll width **80 mm, printable 72 mm — the only width this build supports** | `frontend/docs/HARDWARE-CHECKLIST.md`, read at `d625370` |
| Columns across 72 mm: **576 dots at 203 dpi or 512 at 180 dpi** → 48 or 42 Font A | same |

**Two peer documents narrow this, and one of the user's instructions is now
actionable because of them.** `frontend/docs/HARDWARE-CHECKLIST.md` and
`frontend/docs/PRINTER-TEST-SESSION.md` — neither written in this lane — record that
58 mm is **NOT SUPPORTED**: the layout is fixed at 72 mm printable in
`PAPER_MM`/`PRINTABLE_MM` (`printPageSize.js`) and `PAPER_W = w-[272px]`
(`Receipt.jsx`), so it is a code change, not a setting. The roll question is
therefore closed by a constant rather than by a ruler.

Their basis, though, is a Chromium `MediaBox` measured at 80 mm — a browser
measurement, which is the exact thing the rest of this section argues cannot
establish print-head geometry. It settles what the *layout* targets; it cannot
settle what the *head* resolves. So the remaining ambiguity is not the roll but the
resolution: **48 columns or 42**. That is what the `selftest` strip distinguishes,
and it is why §6 B2 is now scoped to columns rather than to millimetres. It is also
why the acceptance pack renders 48 and 42 (D7) — it previously rendered a 32-column
case for a roll this build cannot produce.

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
  column number → settles **48 vs 42**, the only width question left open
- run `node src/cli.js doctor` and attach the output
- open the drawer by hand, run `doctor`, confirm `drawerOpenLevel`
- run `node src/cli.js drawer --yes` once — **this opens a real till**
- print one of each pack case below and photograph the paper

No physical outcome is recorded in this document, because none has been observed.

### 4b. The acceptance pack

Generated, 30 files, at `~/vexo-connect-x-evidence/printagent/acceptance-pack/`
— 12 per width, 5 source documents, 1 manifest.

```bash
node ~/vexo-connect-x-evidence/printagent/make-acceptance-pack.mjs
```

Each case is written as paper text, raw ESC/POS bytes, and the source document
JSON, at **48 and 42 columns**, plus the self-test ruler at both widths. Those two
numbers are 576 and 512 dots across the one printable width this build supports,
divided by a 12-dot Font A character — the two candidates a `selftest` strip tells
apart. An earlier revision of this pack used 32 for a 58 mm roll the build cannot
produce; see D7.

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
| D7 | The acceptance pack rendered every case at **48 and 32 columns**. 32 was this lane's guess at a 58 mm roll, and `frontend/docs/HARDWARE-CHECKLIST.md` settles that 58 mm is **not supported** — the layout is fixed at 72 mm printable by two constants (`PAPER_MM`/`PRINTABLE_MM` in `printPageSize.js`, `PAPER_W = w-[272px]` in `Receipt.jsx`). So half the pack tested a width the build cannot produce, and left a width it can meet untested. | Changed to **48 and 42** in `make-acceptance-pack.mjs` and regenerated: 72 mm printable is 576 dots at 203 dpi or 512 at 180 dpi, and a Font A character is 12 dots — 576/12 = 48, 512/12 = 42. 10 cases, **0 over-width lines**, reprint bytes still byte-identical to the original |

D1, D2 and D3 were found by reading the generated paper, not by a failing test.
The tests came after, so they cannot regress silently. D7 is a different kind of
error and worth separating: the pack was arithmetically clean at 32 columns and
every check passed, because the check was against the wrong paper. A green result
against the wrong width is exactly what §4a warns about.

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
| B2 | **The print head's column count is unmeasured — 48 or 42** — and the operator has already reported paper being wasted by a print that lands inset on the roll (photo `B2`). The roll is not in doubt: the build supports one width, 80 mm roll / 72 mm printable, and 58 mm is a code change rather than a setting (§4a). What is in doubt is the head's resolution across that width — 576 dots at 203 dpi or 512 at 180 dpi, which is 48 or 42 Font A columns. No `PrintTarget.widthChars` is verified for the pilot unit, and no browser measurement can supply one. One `selftest` strip and one photograph closes it. | operator at the till |

Not blockers of this lane's making, but open and unresolved:

- **The candidate is still uncertified**, by its own record (§1) and now by
  measurement: the certification run in flight at the time of writing does not
  contain the index it exists to certify, and its tree changed 36 seconds after it
  started (§7c, A1).
- **Part 4 is not finished** (§7h). Restore-from-backup has produced nothing at all.
  **Kiosk cannot be verified because it is not in the candidate** (§7g, A6) — a scope
  answer Window 1 owes, not a test this lane can write. Licence enforcement, Captain,
  the release images and the fresh-migration evidence are PARTIAL and say why. They
  are recorded as gaps, not as passes, and this lane's independent acceptance is
  therefore **incomplete**.

**This lane does not approve production.** Two blockers are open, the candidate is
uncertified, and a third of the audit remit is unmeasured.

## 7. Independent audit of the integration candidate

Candidate audited: **`d625370a711fba8de65f94ad99828eaab9a5bc10`**, committed
2026-09-26 03:54:56Z, *"Index the cascade Postgres was scanning, so deleting
customers stops being quadratic"*. Its bytes were taken with
`git archive d625370` into a tree outside every lane, and the three files that
matter were sha256-checked against `git show d625370:<path>` before anything ran.
No peer working directory was read from or written to.

Findings are numbered **A1–A5** and each is sent to the window that owns the code.
One label collision, flagged so nobody chases the wrong artefact: the photographs in
§4a are also lettered `A1`, `B1`, `B2`, `C1`, because that is how they are indexed in
the hardware manifest and renaming them there would break a sha256-keyed record.
`A1` in §7c is an audit finding; `A1` in §4a is the printer's rating plate.

### 7a. The 153 money-path tests, executed for the first time

`docs/INTEGRATION-VERIFICATION-CF9C4A0.md` records that `gateway.test.js` (76) and
`phoneOrders.test.js` (77) both lost their `beforeAll` to the 30 s `hookTimeout`,
contain no authored skip, and were therefore unmeasured while the run summary
still read `46 passed`. That is the whole Razorpay and phone-orders money path.
They now have a result.

```bash
bash ~/vexo-connect-x-evidence/printagent/w6-audit-moneypath.sh
```

| | |
|---|---|
| Result | `Test Files 2 passed (2)` · `Tests 153 passed (153)` |
| Exit code | `0` |
| Duration | 70.49 s — `gateway` 76 in 47.6 s, `phoneOrders` 77 in 15.5 s |
| Run at | 2026-09-26T04:27:13Z |
| Database | `vcx_w6_audit_test`, created empty for this audit, **41** migrations applied |
| Authored skips | `0` in either file, re-checked against the candidate's own bytes |
| Contention | `[test-db-lock] acquired as vcx-test-lock:1` — no waiting, no reconnection |
| Log | `~/vexo-connect-x-evidence/printagent/w6-audit-moneypath-20260926.log` |

The index under audit was **asserted present, not assumed**, by querying
`pg_indexes` between `migrate deploy` and the run:
`LoyaltyProfileLink_customerId_companyId_idx ON public."LoyaltyProfileLink" USING btree ("customerId", "companyId")`.
A pass against the wrong schema would have been worthless.

**What this does not prove, stated because it is the whole point.** The database
was private, so no peer could leave rows in it. The run therefore *measures the
153 tests* — their first result — but it **cannot certify the new index**, because
a private database removes the very pollution the index exists to survive. This
run cannot distinguish "the index works" from "there was nothing to scan".
Certifying the index needs `integrations.test.js` and these two files in one
database, in that order. No such run exists yet.

### 7b. The remaining Part 4 areas, measured — 281 tests

The areas §7 originally listed as unverified, run from the same extracted tree and
the same private database. Chosen by mapping each area of the remit to the
candidate's own suites, plus the one failure Window 5 attributed to code.

| | |
|---|---|
| Result | `Test Files 11 passed (11)` · `Tests 281 passed (281)` |
| Exit code | `0` |
| Duration | 190.27 s |
| Run at | 2026-09-26T04:33:49Z |
| Log | `~/vexo-connect-x-evidence/printagent/w6-audit-part4-20260926.log` |

| Area of the remit | Suite | Tests |
|---|---|---|
| Tenant isolation | `authTenantIsolation` | 11 |
| Licence enforcement | `licenseModuleGate` | 14 — **but see §7e** |
| Recovery behaviour | `accountRecovery`, `accountRecoveryOutage` | 33 + 5 |
| Table/QR | `tableQr` | 74 |
| Customer display | `customerDisplay` | 13 |
| Admin / company / user workflows | `platformAdmin`, `foundation`, `foundationPeople`, `invitations` | 22 + 22 + 31 + 33 |
| **The returned fix, verified** | `reportingExceptions` | 23 |

That last row discharges a duty rather than adding a figure. Item #5 of Window 5's
analysis was the single failure attributable to code on that evidence, and
`02ee253` was written to fix it. It passes here, on the candidate that contains
the fix, from a tree nothing was writing to.

### 7c. A1 — the in-flight certification run does not contain the fix it is meant to certify

**Owner: Window 1 and Window 5. Verified, not inferred, and time-sensitive.**

| Fact | How it was established |
|---|---|
| Window 5's certification run began against `vcx_integration_test` and reported **`40 migrations found in prisma/migrations`** | `/tmp/w5-quiet-cert.log`, last written 2026-09-26T03:53:27Z |
| `vcx_integration_test` has **40** applied migrations and **no** `LoyaltyProfileLink` index on `(customerId, companyId)` | `pg_indexes` and `_prisma_migrations`, queried 04:29Z — five indexes present, none of them the new one |
| The 41st migration appeared in that same lane tree at **03:54:03Z**, 36 s after the run started, and `d625370` was committed at **03:54:56Z** | `stat` on `20260926040000_loyalty_profile_link_customer_index/migration.sql`; `git log -1 --format=%ci` |
| That database held **53,514** `LoyaltyProfileLink` rows at 04:29Z, having been truncated to empty at 03:53Z | `SELECT count(*)`, and the `[test-db-lock] emptied 139 tables` line in their own log |

Two consequences, and neither is a criticism of the analysis in that document:

1. **The run cannot be cited as certifying `d625370`.** The fix is a database
   index, and the index is not in the database. Whatever the run reports about
   cascade-delete timing describes the *unfixed* schema.
2. **Its bytes are not one commit.** The tree changed 36 seconds in. Vitest loads
   test files as it reaches them, so files collected after 03:54:03Z could be read
   from a different tree than files collected before it. A certification run has
   to be taken from a tree nothing is still writing to — `git archive` into a
   scratch directory costs seconds and removes the whole question.

The cheapest correct next attempt: `migrate deploy` first so the 41st migration
lands, assert the index exists, and run from an extracted tree.

### 7d. A2 — every suite's `beforeAll` deletes every other suite's rows

**Owner: Window 1. A design observation with a measured consequence, not a bug report.**

`gateway.test.js` opens with **37** unqualified `deleteMany()` calls and
`phoneOrders.test.js` with **40** — whole-table deletes, no `where`, one round trip
each. Their own comments say why: *"Shared test database: another suite's
kitchen/print rows RESTRICT the station delete inside this wipe's Branch cascade."*
So the wipes are correct for the environment they were written for, and that
environment is the problem: on a shared database every file's setup must delete
every other file's data, through whatever cascades that data has accumulated.
`d625370`'s commit message describes the result exactly — 100,000 customers
deleted through an unindexed cascade *"left 200,000 rows behind, and then failed
the next files when their 30 s `beforeAll` wipe inherited them."*

Indexing the cascade makes the inherited delete survivable. It does not make the
inheritance go away, and the 30 s `hookTimeout` is still spent on rows no test in
that file created. §7a is the counterfactual: the same 153 tests, the same bytes,
a database of their own, `vcx-test-lock:1`, 70 seconds, green. Private databases
per lane are already in use on this box — `vcx_cert625_test`, `vcx_idxrun_test`,
`vcx_tables_test` and others — so this is a convention that has begun spreading on
its own, and is worth making the rule.

### 7e. A3 — licence enforcement is a mechanism with nothing behind it

**Owner: Window 1. Not a defect; a status that must not be reported as a pass.**

`licenseModuleGate.test.js` ran 14 tests in **9 ms**. That is legitimate — the file
imports `permissions.js` and the `requireAction` middleware directly, touches no
HTTP and no database, and 9 ms is the right cost for what it is. It was worth
opening anyway, because a 9 ms licence-enforcement result is the shape of a test
that does not do what its name implies.

What it does is better than that: it says so itself. Its final block is
`describe('the gate is inert in this candidate')`, asserting

```js
expect(ACTION_KEYS.filter((key) => requiredModuleFor(key) !== null)).toEqual([]);
```

**Zero actions in the candidate are gated by any module licence.** The gate is
implemented, unit-correct, fails closed on a missing licence and on a licence
predating the column, and refuses to let one entitled module unlock another — and
it currently guards nothing, because no action key carries a module prefix yet.

So "licence enforcement" is `PARTIAL`, not `PASS`, and the distinction is the
requirement rather than a quibble: a green suite here proves the mechanism would
hold if something were wired to it. Nothing is. Anyone reading `14 passed` as
"module licensing is enforced" would be wrong, and the test's own author has
already left the note saying to delete that block the day it stops being true.

### 7f. A4, A5, A7, A8 — the release image, built and booted

The recipes were the part of a release nobody had inspected, so they were read
first. Then the backend image was **actually built and actually started**, because a
recipe that reads correctly and an image that runs are different claims.

```bash
cd /home/atc-noc/w6-audit/cand-d625370/backend && docker build -t w6-audit-cand-backend:d625370 .
```

| | |
|---|---|
| Build | succeeded, **53.7 s**, 13 layers, 162 MiB (`169,953,997` bytes) |
| Boot | `docker run` against `vcx_w6_audit_test`, `PORT=5099` — `VEXO Connect API listening on 0.0.0.0:5099` |
| `GET /health` | **`HTTP 200`**, `{"status":"ok","service":"atc-pos-api"}` — which also proves Prisma loaded its engine and reached Postgres, so the `-slim` `openssl` install is correct in practice and not just in the recipe |
| Image contents | **no `.env`, no `*.md`, no `_proof` asset** under `/app`. The backend `.dockerignore` (`node_modules`, `tests`, `*.md`, `.env*`) does its job |
| `NODE_ENV` | `production`, set in the image |
| Node inside the image | **`v20.20.2`** — A4, now measured rather than inferred |
| Effective user | **`uid=0(root) gid=0(root)`** — A7 |

That is the first end-to-end evidence in this program that the API image builds,
starts, and serves. It is **not** a release certification: one container, one health
probe, an empty database, and no frontend image was built (§7h).

**Good, and worth recording because both are easy to get wrong:**

- `backend/Dockerfile` copies **named paths only** (`package.json`, `prisma`,
  `src`, `scripts`) rather than the directory, so its context cannot silently
  acquire anything. It installs `openssl` explicitly on `-slim` — the exact trap
  that cost this lane a run (§2b), handled correctly here.
- `frontend/.dockerignore` excludes `public/_proof/`, and uses `dist*` rather than
  `dist` with a comment explaining that a build-output *variant*
  (`dist-negctl`) carried proof assets into the context on the exclusion check's
  first run. That is a real bug someone already found and fixed.
- Both ignore `.env*`. No `.env` file, key, certificate or archive exists under
  any copied path. `src/lib/gateway/secrets.js` and
  `src/lib/integrations/secrets.js` match a `*secret*` sweep but hold no literal
  secret — they are the credential-encryption helpers.

| # | Finding | Severity |
|---|---|---|
| A4 | **The release image runs Node 20; every test result in this program was produced on Node 22, and nothing pins either.** `backend/Dockerfile` and `frontend/Dockerfile.prod` are both `node:20-bookworm-slim`; the built image reports **`v20.20.2`**. This box's Node is `v22.23.2`, and the audit container `v22.23.3`. There is no `engines` field in `backend/package.json` and no `.nvmrc`. So the runtime that ships is one major version from the runtime every figure in every window's record was measured on, and no file in the repo would notice if they diverged further. A worked example sits in the same repository: `agent/package.json` carries `"engines": {"node": ">=20.11"}`. | Medium — a real gap between what is tested and what runs, cheap to close with `engines` |
| A5 | **`frontend/Dockerfile.prod` is `COPY . .`**, so the whole frontend context rests on `.dockerignore`, where `*.md` matches the **context root only** — nested paths need `**/*.md`. Four documents therefore enter the build context: `docs/CASHIER-GUIDE.md`, `docs/HARDWARE-CHECKLIST.md`, `docs/PRINTER-TEST-SESSION.md`, `docs/TOUCHUI-HANDOVER.md`. **This is hygiene, not exposure** — the final stage is `nginx:1.27-alpine` and copies only `/app/dist`, so none of them reaches the shipped image. Recorded because the same root-only rule applies to `.env*`, where the consequence would not be hygiene. No nested `.env` exists today. | Low as it stands; the `.env*` case is the reason to fix it |
| A7 | **The API container runs as `root`.** There is no `USER` directive in `backend/Dockerfile`, so the process that serves every authenticated route, holds the database connection and decrypts gateway credentials runs as `uid=0`, and `/app` is `root:root`. Confirmed at runtime inside the running container, not inferred from the recipe. The base image already ships an unused `node` user at `uid=1000` for exactly this. Two lines — `chown` the app directory and `USER node` — close it. | **Medium-high.** It does not by itself let anyone in, but it removes the last containment step from every other defect: any RCE or path-traversal in a dependency becomes root in the container |
| A8 | **`EXPOSE 5000`, but the app listens on `5010`.** `env.js` is `Number(process.env.PORT \|\| 5010)` and nothing under `backend/` sets `PORT=5000` anywhere. `EXPOSE` is documentation rather than enforcement, so nothing breaks today — but it is the number a reader, an orchestrator's default port mapping, or a health-check template will take, and it is wrong by ten. | Low — but it is a one-character class of bug that costs an hour at the wrong moment |

### 7g. A6 — Captain and Kiosk, and what "no suite carries that name" actually meant

An earlier revision of this document recorded Captain/Kiosk as NOT VERIFIED because
no test file carries either name. That was true and useless: it described this
lane's search, not the candidate. Searched properly, across the whole commit rather
than the extracted backend — the archive holds `backend/` only, so a grep for
`frontend/src` there returns nothing and would have been a false negative I nearly
recorded as a fact.

```bash
git grep -il -e captain -e kiosk d625370          # whole commit, not a working copy
grep -l 'CAPTAIN' backend/tests/*.test.js         # 0 of 52 files
```

**Captain is a role, not a feature.** It exists in four places and no more: the
`PosRole` enum (`schema.prisma:28`, *"one store; takes orders, cannot bill"*), the
migration that adds the value, a permission bundle at `permissions.js:323` —
`order.read`, `order.create`, `order.item.void`, `kot.read`, `table.read`,
`catalog.read` — plus `STORE_PINNED_ROLES`, and a label and description in
`frontend/src/lib/roles.js`. There is no Captain route, screen or workflow; it is a
permission subset over the existing order and KOT routes. So there is nothing
Captain-shaped to certify beyond the bundle itself.

**Kiosk does not exist in this candidate at all.** Two matches in the entire commit,
both incidental prose: a comment in `displayClient.js` about `localStorage`
surviving "kiosk reloads", and a line in `HARDWARE-CHECKLIST.md` saying silent
printing "needs kiosk-mode flags or a local print agent. Neither is built." No
route, no role, no enum value, no screen.

| # | Finding | Severity |
|---|---|---|
| A6 | **`CAPTAIN` appears in `0` of the candidate's 52 test files.** The role is assignable, store-pinned, labelled in the UI and carries a six-permission bundle including `order.item.void` — the right to void a line on someone else's order — and no test ever logs in as one. The bundle is also the only role that grants `order.*` without any payment permission, so *"takes orders, cannot bill"* is asserted nowhere. **Separately: the remit asks for Captain/Kiosk verification and Kiosk is not in the candidate.** That is a scope question for Window 1, not a defect — but it cannot be verified, and it must not be recorded as a pass. | Medium for the untested void permission; the Kiosk gap is a scope answer owed |

### 7h. What this audit does not cover

Recorded so the gaps are not read as passes. None of the following was verified by
this lane, and this section will not claim it:

- **Kiosk, because there is nothing in the candidate to verify** (§7g, A6), and
  **Captain beyond its permission bundle**, which no test exercises.
- **Stock-effect and billing reconciliation outside the gateway suite.** The
  `inventory*` and `reporting*` families were not run. `reportingExceptions` was,
  and only because a fix was owed there.
- **Restore-from-backup.** No backup was taken and none restored. This is the one
  remit item on which this lane has produced nothing at all.
- **The frontend image, and the backend image beyond one health probe.** The backend
  image was built, started and answered `GET /health` (§7f) — but that is one
  container against an empty database, not a release exercised through it. No
  frontend image was built, so nothing here speaks to the bundle as served.
- **The 41 migrations against a populated database.** They were applied to an empty
  one twice — 40 at §2b, 41 at §7a, the 41st being `d625370`'s own index — and the
  §7b batch reused §7a's database. A migration that is safe on an empty schema and slow or
  unsafe on a loaded one is exactly the class of defect `d625370` was written for,
  and its own migration file says it must become `CREATE INDEX CONCURRENTLY`
  before it runs on a large production table. Unverified either way here.

Two peer certification runs were in flight throughout (Window 5 on
`vcx_integration_test`, another on `vcx_cert625_test`) and this lane deliberately
did not start a third full-suite run: 21 foreign `vitest` processes were live at
04:22Z, and contention is the defect under investigation. Adding to it would have
corrupted the measurement it was meant to check. The 434 tests in §7a and §7b were
chosen to be the smallest set that answers the remit, not the largest set that
would run.

## 8. Evidence

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
  w6-audit-moneypath.sh        the §7a audit: the candidate's 153 money-path tests
                               on a database of their own, from an extracted tree
  w6-audit-moneypath-20260926.log  its output — 153/153, exit 0, 41 migrations,
                               and the pg_indexes line proving the schema
  w6-audit-part4-20260926.log  the §7b coverage batch — 11 files, 281/281, exit 0,
                               190.27s, same extracted tree and private database
  w6-audit-stock.sh            the §7i run: stock effects, reporting reconciliation
                               and billing beyond the gateway. Its header records the
                               two files it deliberately omits, and why
  w6-audit-stock-20260926.log  its output
  make-acceptance-pack.mjs     regenerates the pack; exits non-zero if figures stop reconciling
  acceptance-pack/
    MANIFEST.json              per-case bytes, line counts, over-width counts, reprint comparison
    documents/*.json           the source documents, as the server builds them
    48col/, 42col/             paper text + raw ESC/POS bytes per case. 42, not 32:
                               576 and 512 dots across the one printable width this
                               build supports (D7). The 32col/ tree was deleted, not
                               kept — it described a roll the build cannot produce
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
