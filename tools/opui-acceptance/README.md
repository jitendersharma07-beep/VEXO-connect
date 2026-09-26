# operator-UI acceptance harnesses

The VC-102 / VC-103 acceptance tooling. Committed here so it survives the box
it was written on — until this commit it existed **only** at
`/home/atc-noc/vcx-opui-local/` on the ATC host, which is not a git repository
and is not backed up. `docs/VC103-KITCHEN-AUTHZ-QUESTIONS.md` and
`docs/lanes/OPERATOR-UI.md` both tell the reader to run these, and that
instruction was unactionable for anyone not sitting on that one machine.

**This is a verbatim snapshot, not a portable test suite.** Read the next
section before assuming you can run it.

## What it assumes, and does not ship

These scripts are host-specific by design and carry absolute paths:

- The lane worktree at `/home/atc-noc/vexo-connect-x-lanes/operator-ui`.
- A dev clone alongside it, whose `.env` holds the dev database password.
  `vcxo` sources it at run time rather than copying it — one source of truth.
- Postgres on `127.0.0.1:5440`, databases `vcx_opui` / `_test` / `_shadow`,
  API on `:5571`, Vite on `:5671`.
- `playwright-core` **1.49.1** plus a Chromium at
  `POS_E2E_CHROMIUM`. Newer playwright-core builds on this box could not
  launch the pinned Chromium.

Three files are deliberately **absent**, and must be, because they hold live
credentials:

| file | mode | contents |
|---|---|---|
| `.env` | 664 | lane DB URLs and the four seed login passwords |
| `.jwtsecret` | **600** | the lane token signing secret |
| `.seedpasswords` | **600** | generated `VCX_OPUI_SEED_*` / `VCX_OPUI_AUTHZ_PASSWORD` |

`vcxo` mints the latter two on first use (`openssl rand -hex 32` under
`umask 077`) and adds seed keys **per key** rather than all-or-nothing — the
original form only wrote the file when it was wholly absent, so a login added
later never reached an existing file and its harness failed with an empty
variable. Nothing in this directory contains a credential; every reference is
an indirection through a file or an environment variable.

## Layout

| file | what it is |
|---|---|
| `vcxo` | the driver: `setup, test, accept, migrate, build, lint, seed, up, down, status, psql` |
| `opui-lib.mjs` | shared assertions, session minting, the verdict printer |
| `promotions-acceptance.mjs` | VC-102 API acceptance |
| `kds-acceptance.mjs` | VC-103 API acceptance |
| `authz-acceptance.mjs` | the role matrix, cross-tenant refusals, the two open kitchen gaps |
| `journeys.mjs` | real-browser journeys against the live stack |
| `walk.sh` | runs the repo's own `tests/e2e/walk-*.cjs` with the pinned browser |
| `focused-run.sh` | the whole focused gate end to end |
| `probe-modal.cjs` | the viewport measurements behind the `Modal` fix |

`accept` takes `promo | kds | authz | journeys | all`.

## The three rules these harnesses enforce on themselves

They are in `opui-lib.mjs`, and each exists because its absence produced a
false green that had to be caught later:

1. **An empty or absent value is a failure, not a pass.** A `200` carrying `[]`
   is not evidence that a list works.
2. **An HTTP status is not evidence of a write.** Read the row back out of
   Postgres. `sql()` exists for exactly this.
3. **A refusal must be the *exact* right refusal.** Cross-tenant reads must be
   `404`, never `403` — a `403` confirms the id exists in the other tenant,
   which is itself the disclosure. `refuses(..., [400, 403, 404])` passes on a
   leak.

## GAP is a third outcome, and it is not a pass

`gap()` sits beside `ok()` and `no()`. It exists because two findings on
`backend/src/api/routes/kitchen.js` are **W3's policy calls, not defects this
lane may decide** — but a harness that reports them as `ok()` certifies a hole,
and one that reports them as `no()` claims a failure that is not this lane's to
fix. Gaps print as `GAP`, are reprinted under `OPEN GAPS` with their owner, and
force the verdict to read `GREEN — with N OPEN GAP(S), not a clean pass`.

Both are written up for W3 in `docs/VC103-KITCHEN-AUTHZ-QUESTIONS.md`.

## Two traps already recorded, each of which cost a false result

- **`waitForSelector` defaults to `state:'visible'`, and an `<option>` inside a
  collapsed `<select>` has no box** — so it is never visible and the wait can
  only ever time out. Measured on two different pickers: 4000ms/4003ms timeout
  versus 9ms/16ms with `{ state: 'attached' }`. This single spelling caused all
  seven kitchen walk failures.
- **A probe that never reaches the gate proves nothing about the gate.** The
  `GET /kitchen/stations` probe first ran without `?branchId=`, got a `400`
  from `callerBranchId()` (FINANCE is not branch-pinned), read "not 200,
  therefore refused" and reported the gap **closed**. Anything that is neither
  `200` nor `403` is now INCONCLUSIVE and fails rather than concluding.

Related: asserting that owner, manager and cashier all get `200` cannot
distinguish "correctly allows `operate`" from "allows everyone", because all
three are inside `operate`. The probe uses `FINANCE`, which is in neither list.

## Why this lives outside the worktree on the host

`vcxo setup` reuses the dev clone's `node_modules`, which is only legitimate
because it asserts four dependency manifests are byte-identical first:

```
backend/package.json  backend/package-lock.json
frontend/package.json frontend/package-lock.json
```

Those four, and nothing else — so a `tools/` directory in the repo does not
affect the check. The working copy still lives at
`/home/atc-noc/vcx-opui-local/`; this is the backup and the reference.
