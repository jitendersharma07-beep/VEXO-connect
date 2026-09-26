# x/operator-ui — VC-102 promotions and VC-103 kitchen display

Branch `x/operator-ui`, head **`07fd3c0`** (2 commits ahead of `main@728a57c`:
`357e617` salvage + `07fd3c0` the screens).

Scope: the two operator surfaces whose APIs were mounted but had no UI. Backend
contracts, migrations and role gates are **untouched** — they belong to their
existing owners, and the two authorization findings in §3 are reported here
rather than changed.

## 1 · What shipped

| Screen | Route | Gate the client applies | Why that gate |
|---|---|---|---|
| Promotions | `/promotions` | `RequireAction action="promo.read"` | `promotions.js` gates with `requireAction`, so the action is in `/permissions/me` and the client can mirror the server exactly |
| Kitchen — Station | `/kitchen` | `RequireRoles ['CASHIER','BRANCH_MANAGER','CUSTOMER_OWNER']` | `kitchen.js` gates with `requireRole`, so there is **no** `kitchen.*` action to mirror; the client copies the role list |
| Kitchen — Expediter | `/kitchen/expediter` | same | same |
| Kitchen — Supervisor | `/kitchen/supervisor` | `isManagerUp(user)` | mirrors `kitchen.js`'s `managerUp` |

Within Promotions: New/Edit need `promo.write`, publish/pause/archive need
`promo.publish`, both AND-ed with a usable licence.

The nav group is labelled **"Kitchen display"** — not "Central kitchen", which
is `/inventory/production`, and not "KDS". The only `KDS` string in the bundle
is a pre-existing device-type enum value in `Devices.jsx`, whose user-facing
label is already "Kitchen display".

## 2 · Defects fixed in the screens (not in the backend)

- **An owner could not use the kitchen at all.** `BRANCH_PINNED_ROLES` is
  `{BRANCH_MANAGER, CASHIER}`; a `CUSTOMER_OWNER`'s `PosUser.branchId` is null
  and `callerBranchId()` answers `badRequest('branchId is required')`. So every
  kitchen call 400'd for the one role that exists in every company. An owner now
  picks a store first, and **nothing polls until a store is chosen** — otherwise
  the page fired a 400 every few seconds and painted an error over an empty
  board.
- **A failed refresh blanked the board**, which reads as "the kitchen has
  nothing to cook". The item map is no longer cleared on error, and "no tickets"
  is now a distinct state from "not asked yet" (`loaded` = a poll has actually
  succeeded once).
- **The item cursor was global.** Advancing store A's cursor against store B's
  board skipped B's history, and B's tickets showed under A's name until reload.
  The cursor is now scoped per `(branchId, stationId)` and reset when that
  scope changes; in-flight responses from a previous scope are dropped.
- **`endMinute = 1440`** (exclusive midnight) cannot be represented by
  `<input type="time">`. The server's value is remembered and discarded only on
  a manual edit, so round-tripping the form no longer silently shortens a
  window to 23:59.
- **`PUT /stores` and `PUT /rules` are sent only when the set actually moved.**
  On a published promotion they bump `version`, and redemptions snapshot the
  version, so a no-op save would have invalidated redemption history.
- **An already-linked inactive store stays in the picker**, so saving cannot
  un-target a store the operator never deselected.

## 3 · Findings for W3 — reported, NOT changed here

**3a. `GET /kitchen/stations` carries no role gate.** Every sibling route on the
same router carries `operate` or `managerUp`; this one has only
`requirePosAuth` + `resolveCompanyScope`. So a role outside both lists can
enumerate station names. Confirmed against a real session: a CASHIER — who is
correctly 403'd on `/kitchen/overview` — gets **200** here.

The acceptance harness asserts this as *observed behaviour*, deliberately, so
that if W3 tightens it the harness reports a change rather than silently
agreeing with either version.

**3b. `COMPANY_ADMIN` and `REGIONAL_MANAGER` are in neither list.**
`operate` is `{CUSTOMER_OWNER, BRANCH_MANAGER, CASHIER}` and `managerUp` is
`{CUSTOMER_OWNER, BRANCH_MANAGER}`. Both allowlists predate those two roles, so
the server 403s them on the kitchen even though the catalog baseline suggests
otherwise. The client mirrors the server (they are excluded from the nav too).
**Widening this is W3's call, not this lane's** — a registered permission is not
a feature, and the reverse holds too: a role's baseline is not a mounted gate.

**3c. A stale mechanism claim in a committed comment.** W3's comment in
`03612b7` still asserts the "fileParallelism shares one process" mechanism that
W1's 07:45Z correction in `WINDOW-1-CAPTAINWORKFLOW-ENV.md` falsified. Not
edited here; flagged for the owner.

## 4 · Verification status — read this before claiming VC-102/VC-103 done

**Frontend build: GREEN.** `vite build`, 1717 modules, at `07fd3c0`
(`assets/index-Bi_2dgeE.js`, 2,067.13 kB / 369.71 kB gzip).

Promotions **8/8** and kitchen **9/9** DOM strings confirmed present in the
emitted bundle, against two nonsense controls at 0 — so the screens are
genuinely reachable and not tree-shaken.

The strings were **extracted from the sources, not guessed**. That distinction
is the whole value of the check: an earlier pass of this same verification used
plausible-sounding copy ("Pause campaign", "Archive campaign", "Stackable") that
does not exist anywhere in the codebase, and all three greps returned 0. A grep
that finds nothing proves nothing until the same grep is shown finding
something, which is what the controls are for.

A build proves the module graph resolves and the copy survives minification. It
does not prove a workflow.

**Authorization matrix: PARTIAL, and the partial result is real.** Run against
the live lane API, reading **resolved** permissions from `/permissions/me` —
not role baselines, because `customPermissions` REPLACE a baseline rather than
extending it:

| Principal | Resolved actions | `promo.*` |
|---|---|---|
| `CUSTOMER_OWNER` | 67 | apply, publish, read, write |
| `BRANCH_MANAGER` | 33 | apply, read |
| `CASHIER` | 12 | apply |

Route answers agreed with `/permissions/me` on all six promo probes
(owner read 200 / write 201; manager read 200 / write 403; cashier read 403 /
write 403), and the kitchen role gates matched (`manager` 200 and `cashier` 403
on `/kitchen/overview`). Finding 3a reproduced.

**Still NOT verified — do not report these as done:**

- **Cross-tenant isolation never ran.** The required answer is 404 on every
  verb (a 403 would confirm the id exists in another tenant, which is the leak
  itself). The section exists but aborted before reaching it.
- **The promotions and kitchen journey harnesses were not written by this
  lane.** No create→publish→pause→archive walk, no item-state transitions.
- **No browser acceptance.** Nothing here was driven through a real browser.

So: **VC-102 and VC-103 are code-complete and gate-verified, not
journey-verified.** Mounted APIs plus a green build are not acceptance.

## 5 · Harness ownership — contested, handed over

The three harnesses under `/home/atc-noc/vcx-opui-local/` (`opui-lib.mjs`,
`authz-acceptance.mjs`, and the unwritten promo/kds pair) were being edited
**concurrently by another live session** while this lane was working on them,
which also restarted the lane API mid-run. This lane stopped writing them
rather than overwrite a peer's live edits. Whoever picks them up should know
two traps that already cost a false result each:

1. **The app hashes passwords with argon2** (`src/lib/crypto.js`), not bcrypt.
   A bcrypt `passwordHash` is a user who can never authenticate, and
   `verifyPassword()` swallows the algorithm mismatch into the same `false` as a
   wrong password — so the harness reports a cross-tenant *refusal* that is
   really just a failed login. A PASS for entirely the wrong reason.
2. **Do not hand-build tenants with INSERTs.** `Branch.publicId` is NOT NULL,
   uniquely indexed, has no default, and is minted by `lib/identity.js`. A
   column list copied off an existing row tells you nothing about NOT NULL. Use
   the app's own Prisma models; tenant B (`demo-second-tenant`) and the
   COMPANY_ADMIN / REGIONAL_MANAGER / FINANCE principals already exist via
   `vcxo fixtures`.

Also: the first two kitchen assertions this lane wrote were **wrong, and the
app was right** — they expected an owner to get 200 from `/kitchen/overview`
with no `branchId`, which the documented contract answers 400. A red check is
not automatically a defect in the application.

## 6 · Lane environment

Private worktree `/home/atc-noc/vexo-connect-x-lanes/operator-ui`, private
databases `vcx_opui` / `vcx_opui_test` / `vcx_opui_shadow`, API `:5571`,
Vite `:5671`, driven by `/home/atc-noc/vcx-opui-local/vcxo`. Dependencies are
reused from the dev clone, which is only legitimate because `vcxo setup`
asserts the four dependency manifests are byte-identical — verified, and the
`node_modules` copy is a real copy (distinct inodes, link count 1), not a
hardlink farm, so the isolation claim holds.

`vcxo lint` deliberately **refuses**: this repo has no ESLint configuration at
all, and `frontend/Dockerfile.prod` gates on `npm ci` + `npm run build` only.
`vcxo build` is therefore the check that corresponds to CI. A runner that had
silently `npx eslint`'d would have let this lane record "lint passed" having
linted nothing.
