# Gap — `MULTI_GST`, `BRANDS` and `REGIONS` are not enforced entitlements

**Window 6, 2026-09-26. Recorded, NOT fixed.** Commit
`f672c564e5139ed76519375d186f24addbd64d36` (the store-scope authorisation fix)
does **not** address any of this and does not claim to. Nothing below is a
security hole — permission gating on these routers is correct and is now proven
by test. This is a **commercial / packaging** gap: three features documented as
sold separately are in practice available to every tenant.

---

## 1. The claim on the routers

Three routers carry a first-line entitlement label:

| File | Label |
|---|---|
| `backend/src/api/routes/gstRegistrations.js:1` | `ENTITLEMENT(MULTI_GST)` |
| `backend/src/api/routes/brands.js:1` | `ENTITLEMENT(BRANDS)` |
| `backend/src/api/routes/regions.js:1` | `ENTITLEMENT(REGIONS)` |

Read as a header comment, these say "this router is behind a purchased module".

## 2. Why nothing enforces them

Entitlement is enforced in exactly one place — inside `requireAction`, in
`backend/src/middleware/permissions.js`:

```js
const module = requiredModuleFor(action);
if (module && req.user.role !== 'POS_SUPER_ADMIN' && !licenseHasModule(req.license, module)) {
  throw moduleNotLicensed(module);
}
```

The gate fires only when `requiredModuleFor(action)` returns a module name. That
function is a pure prefix match over `EXTENSION_POINTS`
(`backend/src/lib/permissions.js:200-219`):

```js
export const EXTENSION_POINTS = Object.freeze([
  { module: 'INVENTORY', prefix: 'inventory.' },
  { module: 'PURCHASE',  prefix: 'purchase.'  },
  { module: 'KITCHEN',   prefix: 'kitchen.'   },
  { module: 'DELIVERY',  prefix: 'delivery.'  },
]);

export const requiredModuleFor = (action) => {
  const point = EXTENSION_POINTS.find((p) => action.startsWith(p.prefix));
  return point ? point.module : null;
};
```

`MULTI_GST`, `BRANDS` and `REGIONS` are **not modules**. There is no
`multi_gst.`, `brand.` or `region.` extension point. The actions these routers
gate on are all in the `org.` family:

```text
org.legalEntity.read   org.legalEntity.write
org.gst.read           org.gst.write
org.store.read         org.store.write
org.brand.read         org.brand.write
org.region.read        org.region.write
```

No `org.*` key can start with `inventory.`, `purchase.`, `kitchen.` or
`delivery.`, so `requiredModuleFor` returns `null` for every one of them and the
`if (module && …)` branch is never entered. **The labels are comments with no
mechanism behind them.**

Consequence: a tenant whose `License.modules` is `[]` has full read/write access
to GST registrations, brands and regions, subject only to role/permission —
which is exactly what the test fixtures demonstrate.

## 3. This is already pinned by test, deliberately

`backend/tests/orgIdentity.test.js` (in commit `f672c56`) builds tenant
**Alpha Hospitality with `modules: []`** on purpose, and every positive case in
the `READ_MATRIX` / `WRITE_MATRIX` groups passes against it. So the suite
**documents the current behaviour as behaviour**, not as an accident:

- If someone later wires these three into real modules, those tests go red and
  the change is forced to be deliberate.
- The entitlement group carries a control assertion —
  `requiredModuleFor('inventory.item.read') === 'INVENTORY'` — so the
  "`org.*` → null" results cannot be a broken import silently returning `null`
  for everything.

## 4. Same class, four more labels

The same mismatch exists for four other labels, listed for completeness so
whoever fixes this fixes it once:

| Label | Files | Actions it would need to cover |
|---|---|---|
| `DEVICES` | `devices.js`, `terminals.js` | `device.*`, `terminal.*` |
| `DRAWER` | `drawer.js` | `drawer.*` |
| `INTEGRATIONS` | `integrations.js`, `loyalty.js`, `lib/integrations/index.js` | `integration.*`, `loyalty.*` |
| `PHONE_ORDERS` | `phoneOrders.js`, `lib/phoneOrders.js` | phone-order actions |

Of the nine distinct `ENTITLEMENT(...)` labels in the repo:

- **`INVENTORY` is real and enforced** — `inventory.` is an extension point, and
  `tests/licenseModuleGate.test.js` proves the gate fires for it.
- **`CORE` is correctly a no-op** (`invitations.js`, `legalEntities.js`,
  `permissions.js`, `users.js`) — core POS needs no entitlement.
- **The other seven name modules that do not exist:** `MULTI_GST`, `BRANDS`,
  `REGIONS`, `DEVICES`, `DRAWER`, `INTEGRATIONS`, `PHONE_ORDERS`.

`PURCHASE`, `KITCHEN` and `DELIVERY` are declared extension points with no
router label, i.e. the reverse gap — the mechanism exists and nothing is
currently claimed to sit behind it in these files.

## 5. What a fix would have to decide (not decided here)

This is a product/pricing decision, which is why it is recorded rather than
patched:

1. **Are these three actually separately sold?** If multi-GST, brands and
   regions are part of the base product for a multi-store customer, the correct
   fix is to **delete the misleading labels**, not to add gates. That is the
   cheaper and possibly the right answer.
2. **If they are sold separately**, each needs an `EXTENSION_POINTS` entry plus
   an action prefix that actually matches. The current `org.` family cannot be
   prefix-matched selectively — `org.brand.*` and `org.region.*` would have to
   be either renamed (a breaking change to stored `PermissionRule.action` values
   and to `customPermissions` arrays) or `requiredModuleFor` extended from
   prefix matching to an explicit per-action map.
3. **Fail-closed is already the established direction.** `requireAction`
   documents that a missing licence means core POS only, so newly gating an
   action would immediately refuse it for every existing tenant whose
   `License.modules` does not list the new module. Any fix needs a licence
   backfill for existing customers in the same change, or it is an outage for
   them.
4. **`POS_SUPER_ADMIN` bypasses entitlement by design** (see the role check in
   the gate), so support access is unaffected either way.

## 6. Scope statement

- **Not a security defect.** Role and permission gating on all four identity
  routers is correct and is now covered by positive and negative tests in
  `tests/orgIdentity.test.js` (59 tests), including cross-tenant PATCH refusals
  that additionally assert the target row is unchanged in the database.
- **Not fixed by `f672c56`.** That commit changes one `where` clause in
  `resolveStoreInScope` and adds two test files. It touches no entitlement code
  and no licence data.
- **Owner:** product/packaging decision first (question 1 above), then whichever
  window owns `lib/permissions.js`. Window 6 is not taking it.
