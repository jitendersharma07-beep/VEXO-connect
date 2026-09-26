# VEXO Connect Store Print Agent

The till-side consumer for the print and drawer queues. It claims jobs the
server has already rendered, writes ESC/POS bytes to a printer, and reports
what happened — including, when that is the truth, reporting nothing at all.

- **Version** `1.0.0`
- **Protocol** `2026-09-24.print-agents.v1`
- **Runtime** Node 20.11 or newer. No dependencies: `npm install` here installs
  nothing, and the installed bytes are the source in `src/`.

## What it does not do

The agent computes nothing that a receipt asserts. Every figure it prints is a
figure the server put in the document; if the subtotal and the tax lines do not
sum to the total, the paper shows that, because a till that silently corrects
its own bills is worse than one that prints a wrong bill — the wrong bill can be
found again.

It also never claims paper. `CONFIRMED` means *the agent wrote every byte and
the connection closed clean*. There is no `PRINTED` state anywhere in this
system and no UI copy should imply one.

## The three outcomes

Everything about this agent follows from the fact that a one-way byte stream to
a thermal printer cannot tell you whether paper came out.

| Outcome | What it means | What the agent says | Server result |
| --- | --- | --- | --- |
| `NOT_SENT` | The failure happened before a single byte reached the network or the device — refused connection, no such host, unopenable device | `report {ok:false}` | re-queued with backoff, or `FAILED` when attempts run out |
| `DELIVERED` | Every byte was written and the channel closed cleanly | `report {ok:true}` | `CONFIRMED` |
| `UNCERTAIN` | Writing had started and then something broke: a reset connection, a write that timed out, a crash mid-stream | **nothing at all** | the lease expires, the server sweeps the job to `UNCERTAIN`, a human resolves it |

Silence is the only correct expression of not knowing. The report body carries
one boolean, and `ok:false` means *print it again* — which is how a kitchen gets
two tickets for one dish. So an uncertain delivery is never reported and never
retried automatically.

A drawer command is the same shape with one extra distinction that matters:

- `ackAt` — the agent drove the connector pin. This is an acknowledgement.
- `drawerOpen` — a sensor on pin 3 was genuinely read. **Sent only when it was.**

Omitting `drawerOpen` leaves the server's claim at "acknowledged", which is the
truth when nothing observed the till. A `false` is also sent, because "the sensor
says the drawer did not move" and "nothing looked" are different facts and
collapsing them hides a jammed till. The `FILE` transport has no status channel
at all, so on that transport the agent can never observe a drawer and never
pretends to.

## Install

### Windows (the pilot store's till)

From an elevated PowerShell, in the unpacked release directory:

```powershell
.\install\windows-service.ps1 -Install `
  -Server https://pos.example.com `
  -EnrolCode pae_xxxxxxxxxxxx `
  -Transport TCP -PrinterHost 192.168.1.50 -PrinterPort 9100
```

A manager creates the agent in the VEXO console and the enrolment code is shown
once. The installer copies `src/` to `C:\Program Files\VEXO Print Agent`, locks
`C:\ProgramData\VexoPrintAgent` to SYSTEM and Administrators, enrols, registers
a startup scheduled task running as SYSTEM, and finishes by running `doctor`.

It is a scheduled task rather than a service because a Windows service must
answer the Service Control Manager's protocol and Node does not; wrapping it in
`nssm` or `node-windows` would work but would add the first dependency this
package has. See the comment at the top of the script.

**A USB printer needs a share.** The agent writes raw ESC/POS and cannot go
through a Windows print driver. Share the printer (Printers & Scanners → the
printer → Printer properties → Sharing → share name `POS80`) so that a UNC path
exists, then:

```powershell
node "C:\Program Files\VEXO Print Agent\src\cli.js" config set `
  printerTransport=FILE "printerHost=\\localhost\POS80"
```

If the unit has a LAN port, prefer it: `TCP` has a real-time status channel, so
the drawer sensor can be read, and `FILE` can never do that.

### Linux

```bash
sudo useradd --system --home-dir /var/lib/vexo-print-agent --create-home vexoprint
sudo cp -r agent /opt/vexo-print-agent
sudo install -m 0644 install/vexo-print-agent.service /etc/systemd/system/
sudo -u vexoprint node /opt/vexo-print-agent/src/cli.js enrol pae_xxxx \
     --server https://pos.example.com --home /var/lib/vexo-print-agent
sudo systemctl enable --now vexo-print-agent
```

Enrol before the first start, on either platform. An unenrolled agent refuses to
call an authenticated route at all — so it makes no request the server could log
as unauthorised — but it also looks perfectly healthy in `systemctl` and
`Task Scheduler` while printing nothing.

## Update

```powershell
.\install\windows-service.ps1 -Update      # Windows
```
```bash
sudo systemctl stop vexo-print-agent && sudo cp -r agent/src /opt/vexo-print-agent/ \
  && sudo systemctl start vexo-print-agent
```

Stopping is clean: the runner finishes the job it is writing, reports it, and
claims nothing more. The credential, config and journal are untouched — only
`src/` is replaced. Jobs queued during the restart wait; nothing is lost.

## Uninstall

```powershell
.\install\windows-service.ps1 -Uninstall             # keeps the state directory
.\install\windows-service.ps1 -Uninstall -Purge      # removes credential and journal
```
```bash
sudo systemctl disable --now vexo-print-agent
sudo rm /etc/systemd/system/vexo-print-agent.service
sudo -u vexoprint node /opt/vexo-print-agent/src/cli.js uninstall --purge --yes
```

Removing the till does not revoke its credential — **revoke the agent in the
VEXO console as well.** Without `--purge` the journal is kept, because an
unfinished entry in it is the only local record that bytes were in flight when
the agent stopped.

## Commands

| Command | What it is for |
| --- | --- |
| `enrol <code> --server <url>` | Exchange the one-time code for this till's credential |
| `run [--once]` | The service loop: heartbeat, claim, print, report |
| `selftest [--out <file>]` | Print the character ruler — see below |
| `render --kind <receipt\|kot> --in <doc.json> [--out <file>] [--bytes]` | Turn a document into paper-shaped text with no printer at all |
| `drawer --yes` | One test pulse, with the sensor pin read before and after. Opens a real till |
| `status [--remote]` | What this agent knows about itself |
| `doctor [--json]` | Nine checks, each with a verdict and a reason |
| `config show` / `config set k=v [k=v …]` | Read and change stored settings; unknown keys are refused, not stored |
| `uninstall [--purge] --yes` | Remove local state |
| `version` | Agent and protocol versions |

### Exit codes

Meant to be read by a script, and distinct for the reason the whole agent is
built the way it is:

| Code | Meaning |
| --- | --- |
| `0` | OK |
| `1` | Usage error |
| `2` | A check failed (`doctor`) |
| `3` | `NOT_SENT` — nothing reached the printer |
| `4` | `UNCERTAIN` — bytes may be on paper; nobody knows how many |

`3` and `4` are deliberately different. A monitoring script that treats them
alike has thrown away the only distinction that matters.

## The character ruler, and why width is not a guess

**Run `selftest` at every new site, before the first real ticket.**

```bash
node src/cli.js selftest
```

It prints a tens marker, a digit ruler and a row of hashes exactly as wide as the
configured column count, in Font A — the same mode a KOT prints in. The number of
the last column visible on the paper is this roll's width. Put that number in
`PrintTarget.widthChars` in the console.

Characters-per-line from a browser print does **not** measure this. That path
rasterises through the Windows driver, so its line length is a CSS property of
the page, not a property of the print head. Nothing printed through a driver can
answer the question, which is the reason this agent ships a self-test at all.

The strip also says so on itself: *"If this strip printed, the agent formed
ESC/POS bytes and the transport delivered them. It does NOT prove any later job
printed."*

## Settings

`config show` lists every key with its current value, secrets masked. The ones a
site actually touches:

| Key | Default | Notes |
| --- | --- | --- |
| `serverUrl` | — | Set by `enrol` |
| `printerTransport` | `TCP` | `TCP` or `FILE`. `FILE` means `printerHost` is a device, port or UNC share |
| `printerHost` / `printerPort` | — / `9100` | **Local diagnostics only.** Print jobs carry their own target from the server and ignore these. They are also the last-resort route for a drawer command, which arrives with a pin and two durations but no address |
| `drawerPin` | `2` | The connector pin the kick fires. A store wired to pin 5 that leaves this at the default gets a kick on a pin nothing is connected to — silent and invisible, which is why `doctor` reports it out loud |
| `drawerOnMs` / `drawerOffMs` | `50` / `200` | Pulse shape |
| `drawerOpenLevel` | `high` | Which level on pin 3 means open. Wiring-dependent, so it is a setting and not an assumption: open the drawer by hand and run `doctor` to confirm |
| `readDrawerSensor` | `true` | Set false only where a sensor is known to be absent and its readings are noise |
| `widthCharsOverride` | `null` | Overrides the server's `widthChars` for every target. For a site whose measured ruler disagrees with the server record — fix the server row instead wherever you can |
| `timeZone` | unset | **Set this.** The receipt document carries no store timezone, so an unset value means the agent prints the host machine's zone |
| `heartbeatMs` / `pollMs` / `maxClaim` | `30000` / `2000` / `3` | The 30 s beat is against a 90 s staleness window, so two may be lost before the server calls the till offline. A claimed batch shares ONE 60 s lease, so `maxClaim` stays small enough that the slowest plausible printer finishes inside it |

State lives in one directory — `C:\ProgramData\VexoPrintAgent` or
`/var/lib/vexo-print-agent`, or `$VEXO_AGENT_HOME`:

```
config.json         settings, 0600
credentials.json    agentId and secret, 0600 from the moment it is created
journal.jsonl       one fsynced line per phase of every job
agent.log           rotated at logRetainBytes (8 MB)
```

## Diagnostics

```bash
node src/cli.js doctor
```

Nine checks: state directory, server URL, credential, clock skew, server
credential, printer reachable, printer status, journal, printable width. Each
reports `PASS`, `FAIL` or `SKIP` **with a reason** — a `SKIP` says what was
missing, so "no printer configured" never reads as "printer fine".

`doctor` is safe to run on a live printer in a busy store: the printer status
check is a `DLE EOT 1` real-time status query, which is the one thing that can be
asked of a printer without putting a mark on the roll.

## Tests

```bash
npm test
```

67 tests, no dependencies, no network, no printer:

- `test/delivery.test.js` — the three outcomes against a fake printer that
  closes cleanly, holds the connection open, resets mid-stream, accepts a
  prefix and closes, or reads nothing at all.
- `test/semantics.test.js` — the runner's judgements against a recording
  server: agent stopping, expired leases, duplicate jobs in one claim, a report
  that throws, and crash recovery from the journal.
- `test/client.test.js` — the bytes of the conversation, against a fake fetch:
  an omitted `drawerOpen` is absent from the JSON, a `false` one is present, and
  the credential travels as one bearer token and never in a body.
- `test/render.test.js` — what ends up on the roll, at 48 columns and at 32,
  including what a KOT does *not* carry: the server sends no table name, no
  station and no usable order type, so those assertions are about absence and
  will fail — deliberately — the day the server starts sending them.

The end-to-end test — the shipped client and runner against `createApp()` on a
real port, with a real TCP printer — is `backend/tests/printAgentClient.test.js`,
because it needs a database. It runs with the backend suite.

## Crash recovery

On start, the agent reads its journal and sorts what it finds into three:

- **Bytes were in flight** (`WRITING` with no `WROTE`). Never re-delivered and
  never reported. Left to expire into `UNCERTAIN`, where a human looks at the
  paper and decides. This is the single most important behaviour in the agent.
- **Written but unreported** (`WROTE`, no `REPORTED`). Reported `ok:true` with
  `delivered before restart`.
- **Claimed but not started** (`CLAIMED` only). Reported `ok:false`
  `AGENT_RESTARTED`, which re-queues it cleanly — no byte was written, so there
  is no paper to duplicate.
