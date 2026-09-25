// Pure unit tests for the per-licence module gate. No DB, no HTTP.
//
// The gate decides between two values that are already on the request — the
// action the route asked for, and the modules the tenant's licence carries — so
// it is tested here rather than through a route. That is not a convenience:
// no module lane is merged into this candidate yet, so there is no real
// `inventory.*` endpoint to drive. Testing the decision directly is the only
// way to prove the refusal works BEFORE the first module arrives, which is the
// order that matters. A gate first exercised by the lane it is meant to gate is
// a gate nobody ever saw refuse anything.
import { describe, it, expect } from 'vitest';
import { requiredModuleFor, EXTENSION_POINTS, ACTION_KEYS } from '../src/lib/permissions.js';
import { requireAction } from '../src/middleware/permissions.js';

// Drives the middleware and reports which way it went. asyncHandler routes a
// throw into next(err), so "refused" and "allowed" are both a next() call and
// have to be told apart by the argument.
const run = (action, req) =>
  new Promise((resolve) => {
    requireAction(action)(req, {}, (err) => resolve({ allowed: !err, err }));
  });

const reqFor = ({ modules = [], role = 'OWNER', can = true, license } = {}) => ({
  user: { id: 'u-1', role },
  perm: { role, can: () => can },
  license: license === undefined ? { modules } : license,
  companyScope: { id: 'c-1' },
});

describe('requiredModuleFor', () => {
  it('maps every declared extension point to its module', () => {
    expect(EXTENSION_POINTS.length).toBeGreaterThan(0);
    for (const point of EXTENSION_POINTS) {
      expect(requiredModuleFor(`${point.prefix}thing.read`)).toBe(point.module);
    }
  });

  it('leaves core POS actions unclaimed', () => {
    expect(requiredModuleFor('org.store.read')).toBeNull();
    expect(requiredModuleFor('permission.write')).toBeNull();
    expect(requiredModuleFor('order.refund')).toBeNull();
  });

  // The prefix carries its dot for this reason. On a bare 'inventory' both of
  // these would be gated by an entitlement their author never asked for, and
  // the failure would be a 403 on a core action — read as a permissions bug,
  // nowhere near the licence.
  it('does not claim an action that merely starts with a module name', () => {
    expect(requiredModuleFor('inventoryless.read')).toBeNull();
    expect(requiredModuleFor('inventory')).toBeNull();
    expect(requiredModuleFor('kitchenware.write')).toBeNull();
  });

  it('is not fooled by a non-string action', () => {
    expect(requiredModuleFor(undefined)).toBeNull();
    expect(requiredModuleFor(null)).toBeNull();
    expect(requiredModuleFor({ startsWith: () => true })).toBeNull();
  });
});

describe('the gate inside requireAction', () => {
  it('refuses a module action the licence does not carry, and names the module', async () => {
    const { allowed, err } = await run('inventory.item.read', reqFor({ modules: [] }));
    expect(allowed).toBe(false);
    expect(err.status).toBe(403);
    // Its own code: "renew your licence" and "you never bought this" are
    // different instructions and the screen must not give the first for the
    // second.
    expect(err.code).toBe('POS_MODULE_NOT_LICENSED');
    expect(err.details).toEqual({ module: 'INVENTORY' });
    expect(err.message).not.toMatch(/expired|suspended/i);
  });

  it('allows the same action once the licence carries that module', async () => {
    const { allowed, err } = await run(
      'inventory.item.read',
      reqFor({ modules: ['INVENTORY'] }),
    );
    expect(err).toBeUndefined();
    expect(allowed).toBe(true);
  });

  // Entitlement is per module, so holding one is not holding another.
  it('does not let one entitled module unlock a different one', async () => {
    const { err } = await run('kitchen.station.write', reqFor({ modules: ['INVENTORY'] }));
    expect(err.code).toBe('POS_MODULE_NOT_LICENSED');
    expect(err.details).toEqual({ module: 'KITCHEN' });
  });

  // No licence is not "all modules". This is the direction the whole gate
  // exists to get right.
  it('fails closed when there is no licence at all', async () => {
    const { allowed, err } = await run('inventory.item.read', reqFor({ license: null }));
    expect(allowed).toBe(false);
    expect(err.code).toBe('POS_MODULE_NOT_LICENSED');
  });

  it('fails closed when the licence predates the column and has no modules array', async () => {
    const { err } = await run('purchase.order.write', reqFor({ license: {} }));
    expect(err.code).toBe('POS_MODULE_NOT_LICENSED');
    expect(err.details).toEqual({ module: 'PURCHASE' });
  });

  // The narrowness of the gate, asserted rather than assumed: an empty modules
  // list is the default on every licence ever issued, so if the gate reached
  // core actions it would lock out every existing tenant on upgrade.
  it('leaves core actions alone on a licence with no modules', async () => {
    for (const action of ['org.store.read', 'order.refund', 'permission.write']) {
      const { allowed, err } = await run(action, reqFor({ modules: [] }));
      expect(err, `${action} was refused`).toBeUndefined();
      expect(allowed).toBe(true);
    }
  });

  // Ordering, which is a behaviour and not an implementation detail: a cashier
  // with no inventory permission must be told they lack permission, not that
  // their employer has not bought the module. The second is a sales conversation
  // and it is not theirs to have.
  //
  // Both checks have to FAIL for this to be a test of the order. An earlier
  // version of this test entitled the module and only withheld the permission,
  // so the entitlement check passed either way and the assertion held whichever
  // order the middleware used — it was green against the inverted code. Caught
  // by negative control, which is the only reason it is written this way.
  it('answers a permission refusal as a permission refusal, even for a module action', async () => {
    const { err } = await run('inventory.item.read', reqFor({ modules: [], can: false }));
    expect(err.code).toBe('POS_FORBIDDEN');
  });

  // The companion case, and a different claim: permission held, module not
  // bought. Nothing about the order, but it is the refusal the owner acts on.
  it('answers an entitlement refusal as an entitlement refusal when the permission is held', async () => {
    const { err } = await run('inventory.item.read', reqFor({ modules: [], can: true }));
    expect(err.code).toBe('POS_MODULE_NOT_LICENSED');
  });

  // A platform operator repairs licences, so it cannot be locked out by one.
  it('lets a VEXO operator through regardless of the tenant licence', async () => {
    const { allowed } = await run(
      'inventory.item.read',
      reqFor({ role: 'POS_SUPER_ADMIN', modules: [] }),
    );
    expect(allowed).toBe(true);
  });
});

// A tripwire, deliberately. Today no action key sits under a module prefix, so
// this gate changes the behaviour of nothing in this candidate — that is a
// claim worth holding to an assertion rather than a sentence in a report.
//
// When a module lane merges its keys this test goes RED. That is the point: it
// is the moment the gate stops being inert, and the moment every licence and
// test fixture that should reach the new module needs the entitlement added.
// Read a red here as "the module arrived", delete this test, and check the
// fixtures.
describe('the gate is inert in this candidate', () => {
  it('has no action key under any module prefix yet', () => {
    const claimed = ACTION_KEYS.filter((key) => requiredModuleFor(key) !== null);
    expect(claimed).toEqual([]);
  });
});
