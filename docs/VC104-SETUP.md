# VC-104 — lane setup and pinned base

**Status:** setup COMPLETE. W2 (`vc104-ui`) may start.
**Published by:** VC-104 W1 (backend / API contract owner), 2026-09-24.

---

## 1. The pinned base — read this before branching

**Base SHA: `bddbe82c098a6c5b18c2931e6c3495217011b133`** (short `bddbe82`).

Both VC-104 worktrees were created from this commit and nothing else:

| Lane | Path | Branch | HEAD at creation |
|---|---|---|---|
| Backend / API (W1) | `/home/atc-noc/vexo-connect-x-lanes/vc104-api` | `x/vc104-api` | `bddbe82` |
| Operator UI (W2) | `/home/atc-noc/vexo-connect-x-lanes/vc104-ui` | `x/vc104-ui` | `bddbe82` |

Both were clean (0 dirty files) at creation.

### Why not the SHA the handoffs name

`WINDOW-2-HANDOFF.md`, `WINDOW-3-HANDOFF.md` and `docs/PHASE1-EXIT-EVIDENCE.md`
all name **`4f2a91c`** as the agreed development base, and the Phase-1 exit gate
records "Clean pinned base — PASS".

**`4f2a91c` does not exist in this repository.** Verified three ways:

```
git cat-file -t 4f2a91c   -> fatal: Not a valid object name
git reflog --all | grep 4f2a91c   -> no match
git cat-file --batch-all-objects --batch-check   -> 1677 objects, 0 match 4f2a91c
git fsck --lost-found   -> no dangling commits
```

So the published base is unreachable and the "clean pinned base" line of the
exit gate cannot be satisfied as written. This is recorded as a blocker in
§6 — it is the owner's to resolve, not this lane's.

### What `bddbe82` actually is

`bddbe82` is the only commit in the repo whose content is exactly
**RC-1 + Foundation** — which is what VC-104 depends on.

```
38856d3  RC-1 code-final + docs        13 migrations   (base for every lane)
 |
 +-- a6c9685  printer runbook + print-request audit test
 |     |
 |     +-- cfa22e9  x/foundation HEAD: foundation + promotions + modifiers   18 migrations
 |
 +-- bddbe82  foundation candidate                                          16 migrations  <== PINNED
 |
 +-- 489b66a  x/integration HEAD: Phase-1 exit docs only                    13 migrations
```

The four candidates are **siblings off `38856d3`**, not a chain.

Content check: every foundation file is byte-identical between `bddbe82` and
`cfa22e9` (`lib/identity.js`, `middleware/permissions.js`, `middleware/device.js`,
routes `devices`/`permissions`/`brands`/`users`, `lib/invoice.js`). The only
divergences are promotions/modifiers additions:

| File | bddbe82 -> cfa22e9 | What the delta is |
|---|---|---|
| `schema.prisma` | +273 | promotions + modifiers models |
| `lib/permissions.js` | +22 | `promo.*` actions (VC-102) |
| `catalog.js`, `orders.js`, `lib/orders.js`, `money.js`, `app.js` | +~700 | promotions + modifiers |
| 9 test files | +4 each | promotion teardown in `wipe()` |

`cfa22e9` was rejected as the base for three reasons, all from its own commit
message and from measurement:

1. It is self-declared a mid-flight snapshot — "TAKEN WHILE THE TREE WAS LIVE",
   "not a claim of completion", "No test run backs this commit".
2. It carries **promotions and modifiers**, two unmerged peer streams. Its own
   message records that promotions is being built three times in three trees
   with three colliding migration timestamps.
3. Its test suite is red as committed: the `modifiers` migration creates
   `OrderItemModifier` with `ON DELETE RESTRICT`, and 11 of 12 `wipe()` helpers
   delete `orderItem` without clearing it first. The fix exists only as
   uncommitted work in the foundation worktree, and importing another worker's
   uncommitted changes is forbidden.

**Caveat, stated so it is not discovered later:** `bddbe82` was authored by W2
as a snapshot import of W1-foundation's then-uncommitted tree; its own message
says "source of truth remains Window 1 until their commit". It also does **not**
contain `a6c9685` (the printer runbook and the print-request audit test).
Neither affects VC-104, but if the owner re-pins the base, this lane rebases —
cheap now, expensive later.

---

## 2. Ports — the proposed pair was already taken

The brief proposed 5380/5381 for this lane. **Both are in use by the promotions
lane** (`node src/index.js` on 5380, its `vite preview` on 5381). They were left
untouched.

| Lane | API | Frontend | Status |
|---|---|---|---|
| `vc104-api` (W1) | **5384** | **5385** | verified free, bind loopback only |
| `vc104-ui` (W2) | **5382** | **5383** | verified free, as briefed |

Bind `127.0.0.1` only — never `0.0.0.0`.

Ports in use nearby at setup time: 5370/5371 (foundation demo), 5373 (w2-frontend),
5380/5381 (promotions).

---

## 3. Databases

Postgres: container `atc-pos-dev-db`, host `127.0.0.1:5439`, role `atc_pos`.

| Lane | Suite DB (`_test` suffix required) | Browser / demo DB |
|---|---|---|
| `vc104-api` (W1) | `atc_pos_vc104api_test` | `atc_pos_vc104api_demo` |
| `vc104-ui` (W2) | `atc_pos_vc104ui_test` | `atc_pos_vc104ui_demo` |

W1's two are **created**. W2 creates its own two — this lane does not provision
into a peer's namespace.

The suite guard is per-file: every test file refuses a `DATABASE_URL` that does
not end in `_test`. The demo DBs deliberately lack the suffix so a destructive
suite hard-refuses them. **Never point a suite at a peer's DB.**

---

## 4. Running the backend suite

No dotenv loader exists in the backend — export the variables.

```
DATABASE_URL=postgresql://atc_pos:<pw>@127.0.0.1:5439/atc_pos_vc104api_test
POS_JWT_SECRET=<at least 32 characters>
NODE_ENV=test LOG_LEVEL=silent
npx prisma generate && npx prisma migrate deploy && npx vitest run
```

The password is read from the container env at runtime; it is never written to
a file in this repo and never printed.

---

## 5. Migration timestamp range claimed by this lane

`LANE-BRIEF.md` ranges migration timestamps per lane so lanes never interleave
ambiguously. VC-104 postdates that table and has no range, so this lane claims:

**`20260924800000`–`20260924809999`** (`vc104-api`).

Unclaimed in the brief's table and clear of foundation (`1000xx`), promotions
(`2000xx`), kitchen (`3000xx`), inventory (`4000xx`), orders (`5000xx`),
firstlogin (`6000xx`) and cash (`7000xx`). W2 adds no migrations — schema and
migrations belong to W1.

**Old migrations are preserved. Nothing existing is renamed, edited or deleted.**

---

## 6. Blockers and owner decisions

| # | Item | Status |
|---|---|---|
| 1 | Published base `4f2a91c` does not exist; the Phase-1 exit gate's "clean pinned base PASS" rests on it | **BLOCKER — owner** |
| 2 | This lane pinned `bddbe82` on the evidence in §1. If the owner prefers `cfa22e9`, say so before code lands | **DECISION — owner** |
| 3 | `WINDOW-2-HANDOFF.md` / `WINDOW-3-HANDOFF.md` still direct other windows to branch off `4f2a91c` | **needs correction by their owner** |
| 4 | No module/tier entitlement mechanism exists yet (`LicensePlan` = FREE_TRIAL/SINGLE_STORE/MULTI_STORE only; `LicenseAddonKind` = ADDITIONAL_BRANCH only). `requireModule(key)` is the firstlogin lane's to build | see contract §3 |

Nothing has been committed, merged, pushed or deployed. `origin` is unchanged
(local bundle, push DISABLED).
