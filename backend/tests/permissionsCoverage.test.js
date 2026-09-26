// Is every action this build DECLARES actually ENFORCED anywhere?
//
// src/lib/permissions.js opens by asserting that "an action listed here is
// enforced somewhere", and until this file existed nothing checked it. The claim
// matters because the permissions SCREEN is generated from the same list: a key
// that no route consults still appears as a switch an administrator can turn on
// and off, and turning it off changes nothing. That is worse than a missing
// feature — it is a control that lies about being a control.
//
// WHY THIS IS A ROUTER WALK AND NOT A GREP
//
// The obvious version of this check greps for requireAction('x'). It is wrong in
// both directions, and the first draft of this audit shipped a "0 dead keys"
// answer that was entirely false because of it:
//
//   - FALSE NEGATIVE: gates are built through helpers and tables — `till('order.bill')`,
//     `...takeOrder` — so at the call site the argument is a VARIABLE and the
//     literal never appears next to requireAction.
//   - FALSE POSITIVE: a substring search matches the action name written in a
//     COMMENT. Every key discussed in prose reads as enforced.
//
// So requireAction tags its returned handler with `.posAction` (see
// src/middleware/permissions.js) and this file walks the MOUNTED express stack
// for that tag. It measures the app as assembled, which is the only thing that
// answers "would a request actually be refused".
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect } from 'vitest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('permissionsCoverage.test.js requires a DATABASE_URL ending in _test');
}

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// The guest-QR router is mounted only when this is set (see src/app.js), and an
// unmounted router's gates are invisible to the walk. Set here so the map is of
// the whole build rather than of whichever files ran before this one in the same
// worker — process.env is not reset between test files.
process.env.POS_QR_BASE_URL = process.env.POS_QR_BASE_URL || 'https://order.example.test';

const { createApp } = await import('../src/app.js');
const { ACTION_KEYS, actionMeta } = await import('../src/lib/permissions.js');

const app = createApp();

// Express 4 hangs the router off app._router; Express 5 off app.router. Read
// both rather than pinning to one, so an upgrade makes this test fail loudly
// instead of walking an empty stack and reporting perfect coverage.
const rootStack = app._router?.stack ?? app.router?.stack;

const gatedActions = () => {
  const found = new Set();
  const seen = new Set();
  const walk = (stack) => {
    for (const layer of stack || []) {
      if (seen.has(layer)) continue;
      seen.add(layer);
      if (layer.handle?.posAction) found.add(layer.handle.posAction);
      if (layer.handle?.stack) walk(layer.handle.stack);
      if (layer.route?.stack) walk(layer.route.stack);
    }
  };
  walk(rootStack);
  return found;
};

// Actions with NO requireAction gate on any mounted route, each with the reason
// it is absent. This is an explicit ledger, not a tolerance: set equality is
// asserted below, so adding a new unenforced key fails this test, and wiring one
// of these up fails it too — which is the point. The second case is a red test
// that means "good, now delete the line and update the doc".
//
// Measured 2026-09-26 against 49e1791 + the W3 gate change. 68 declared, 52
// mounted, 16 ungated, of which exactly one is enforced in a handler instead.
const UNGATED = {
  // Enforced, but INSIDE the route handler rather than as middleware:
  // src/api/routes/drawer.js asks req.perm.can('drawer.open.manual') directly,
  // because opening the drawer by hand is one branch of a route that also serves
  // the automatic open. A middleware gate there would refuse the legitimate half.
  'drawer.open.manual': 'handler-enforced (drawer.js), not middleware',

  // Read actions on routers that gate the WRITE and leave the read to tenant
  // scope alone. Defensible — these leak no money — but it does mean the
  // matching switches on the permissions screen do nothing.
  'catalog.read': 'read ungated; router relies on tenant scope',
  'order.read': 'read ungated; router relies on tenant scope',
  'kot.read': 'read ungated; router relies on tenant scope',
  'dayclose.read': 'read ungated; router relies on tenant scope',
  'report.sales.read': 'read ungated; reporting gates on its own module/licence',
  'report.tax.read': 'read ungated; reporting gates on its own module/licence',
  'report.audit.read': 'read ungated; reporting gates on its own module/licence',
  'report.payments.read': 'read ungated; reporting gates on its own module/licence',
  'report.inventory.read': 'read ungated; reporting gates on its own module/licence',

  // WRITES with no gate. These are the ones that matter, and they are listed
  // here rather than quietly wired up because switching one on is a policy
  // decision with a blast radius, not a missing line of code.
  'catalog.write': 'write ungated; catalog router still on requireRole',
  'order.void': 'write ungated; orders router voids via its own till() gate set',
  'refund.issue': 'write ungated; refunds gate on the payment/refund role list',
  'dayclose.perform': 'write ungated; day-close router still on requireRole',

  // THE ONE THE ASSIGNMENT NAMES. Declared, in CASHIER's and CAPTAIN's baseline,
  // and reachable from no route: the void of a SENT line is served by
  // POST /orders/:id/items/:itemId/void, which gates on the till action set and
  // not on this key. Deliberately left unreachable — see
  // docs/completion/W3-CAPTAIN.md §2. Wiring it would hand a revenue-affecting
  // authority to every existing cashier in every tenant silently on upgrade,
  // because it is in the CASHIER baseline and absent from DEFAULT_OFF. The
  // honest close is to remove it from those baselines, which is a product call.
  'order.item.void': 'DECLARED BUT UNREACHABLE ON PURPOSE — W3-CAPTAIN.md §2',

  // Platform-operator umbrella key. Operator reach is enforced by the
  // POS_SUPER_ADMIN role checks and the support-grant mechanism, not by this.
  'platform.tenant.manage': 'operator reach enforced by role + support grant',
};

describe('the permission map is enforced, not just declared', () => {
  it('walks a real mounted stack — if this finds nothing, the walk broke, not the app', () => {
    expect(rootStack, 'no express router stack found; the walk below would report perfect coverage').toBeTruthy();
    // A floor, so an express upgrade that moves the stack cannot make every
    // other assertion in this file vacuously true.
    expect(gatedActions().size).toBeGreaterThan(40);
  });

  it('never gates on an action that is not declared', () => {
    // A gate naming a key absent from ACTIONS can never pass: can() looks the
    // key up and no role's baseline contains it, so the route is dead for
    // everybody including the owner. A typo here is a silent outage.
    const ghosts = [...gatedActions()].filter((k) => !ACTION_KEYS.includes(k));
    expect(ghosts).toEqual([]);
  });

  it('every declared action is either gated or on the ungated ledger, exactly', () => {
    const gated = gatedActions();
    const ungated = ACTION_KEYS.filter((k) => !gated.has(k)).sort();
    const ledger = Object.keys(UNGATED).sort();

    // Set equality in both directions, reported as two readable diffs rather
    // than one opaque boolean.
    const undocumented = ungated.filter((k) => !ledger.includes(k));
    const nowEnforced = ledger.filter((k) => !ungated.includes(k));

    expect(
      undocumented,
      'these actions are enforced NOWHERE and are not on the ledger. Either gate them or ' +
        'add them to UNGATED with the reason, and record it in docs/completion/W3-CAPTAIN.md §2.',
    ).toEqual([]);
    expect(
      nowEnforced,
      'these are on the ungated ledger but now HAVE a gate. Good — delete them from UNGATED ' +
        'and update docs/completion/W3-CAPTAIN.md §2 so the count stays true.',
    ).toEqual([]);
  });

  it('every ungated entry carries a reason, and every key on the ledger is real', () => {
    for (const [key, reason] of Object.entries(UNGATED)) {
      expect(ACTION_KEYS, `${key} is on the ledger but is not a declared action`).toContain(key);
      expect(actionMeta(key), `${key} has no metadata`).toBeTruthy();
      expect(String(reason).length, `${key} needs a reason, not a placeholder`).toBeGreaterThan(20);
    }
  });

  it('the actions the Captain journey depends on ARE gated, not assumed', () => {
    // The whole W3 change is that these two stopped being role lists and became
    // actions. If either drops off the mounted map, the captain's handheld is
    // either wide open or refused again, and both are regressions.
    const gated = gatedActions();
    expect(gated.has('order.create'), 'POST /orders lost its requireAction gate').toBe(true);
    expect(gated.has('table.read'), 'the table/floor reads lost their requireAction gate').toBe(true);
  });

  it('order.item.void is still unreachable, so the documented gap cannot close by accident', () => {
    // Paired with the ledger above on purpose: this is the assignment's
    // "resolve by documenting, do not silently grant". If someone wires it up,
    // this test is the thing that makes them say so out loud.
    expect(gatedActions().has('order.item.void')).toBe(false);
    expect(ACTION_KEYS).toContain('order.item.void');
  });
});
