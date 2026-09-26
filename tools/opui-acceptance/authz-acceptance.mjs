// x/operator-ui acceptance — AUTHORIZATION and TENANCY for the two operator
// surfaces this lane builds: VC-102 promotions and VC-103 kitchen display.
//
// This is the harness that decides whether the screens' gates are honest. The
// frontend hides controls; hiding is presentation and proves nothing. What
// matters is that for every (role, route) pair the server's answer and the
// screen's offer agree — a screen that offers a button the server refuses is a
// defect, and a screen that hides a button the server would have allowed is a
// different defect.
//
// It asserts RESOLVED permissions, read from GET /api/permissions/me, not the
// role's baseline from the catalog. Those differ: customPermissions REPLACE a
// baseline rather than extending it, and a registered action in the catalog is
// not evidence of a mounted route. The only trustworthy answer to "may this
// caller do this" is the caller's own /permissions/me plus the route's reply.
//
// Cross-tenant is checked with a second company created for the purpose, and
// the expected answer is 404 — not 403. A 403 on another tenant's id confirms
// the id exists, which is the leak itself.
//
// Writes only to this lane's private database, through the API. Touches no
// production system, no vexo-lab, and no other lane's data.

import {
  sessions, client, check, ok, no, section, verdict, refuses, admits, truthy,
  makeRivalTenant, login, sql, gap,
} from './opui-lib.mjs';

const main = async () => {
  const s = await sessions();
  const api = {
    owner: client(s.owner), manager: client(s.manager), cashier: client(s.cashier),
    companyAdmin: client(s.companyAdmin), regionalManager: client(s.regionalManager), finance: client(s.finance),
  };

  // The owner is company-wide (branchId null, asserted below), so every
  // kitchen route falls back to callerBranchId()'s explicit-branchId path and
  // 400s without one. manager and cashier are pinned and need no such param —
  // passing it for them too would just be redundant, not wrong, but leaving it
  // off keeps each call honest about what that role actually needs.
  const branchesForOwner = await api.owner.get('/branches');
  const ownerBranchId = branchesForOwner.data?.branches?.[0]?.id;
  truthy('owner can resolve at least one branch id (needed for company-wide kitchen calls)', ownerBranchId);

  // ---------------------------------------------------------------- identity
  section('the three seeded principals are who we think they are');
  check('owner role', s.owner.user.role, 'CUSTOMER_OWNER');
  check('manager role', s.manager.user.role, 'BRANCH_MANAGER');
  check('cashier role', s.cashier.user.role, 'CASHIER');
  // The owner is company-wide (branchId null); the other two are pinned to a
  // branch. The kitchen screens depend on exactly this: callerBranchId() falls
  // back to req.user.branchId and 400s when there is none, which is why the
  // owner has to pass a branch explicitly and the other two must not need to.
  check('owner is company-wide (no branch)', s.owner.user.branchId === null, 'true');
  truthy('manager is pinned to a branch', s.manager.user.branchId);
  truthy('cashier is pinned to a branch', s.cashier.user.branchId);

  // -------------------------------------------------- resolved, not baseline
  section('resolved promo.* actions, read from /permissions/me');
  const perms = {};
  for (const who of ['owner', 'manager', 'cashier', 'companyAdmin', 'regionalManager', 'finance']) {
    const r = await api[who].get('/permissions/me');
    if (r.status !== 200) {
      no(`${who}: GET /permissions/me → ${r.status}`);
      continue;
    }
    const actions = r.data?.actions;
    if (!Array.isArray(actions)) {
      no(`${who}: /permissions/me returned no actions array`);
      continue;
    }
    perms[who] = new Set(actions);
    const promo = actions.filter((a) => a.startsWith('promo.')).sort();
    ok(`${who} resolves ${actions.length} actions; promo.* = [${promo.join(', ') || 'none'}]`);
  }

  // The screen gates New/Edit on promo.write and publish/pause/archive on
  // promo.publish. Whatever the roles happen to hold, the screen must agree
  // with the server — so the matrix below is derived from /permissions/me and
  // then checked against the routes themselves.
  section('promo.* gates: the route agrees with /permissions/me');
  for (const who of ['owner', 'manager', 'cashier', 'companyAdmin', 'regionalManager', 'finance']) {
    if (!perms[who]) continue;
    const canRead = perms[who].has('promo.read');
    const canWrite = perms[who].has('promo.write');

    const list = await api[who].get('/promotions');
    if (canRead) await admits(`${who} holds promo.read → GET /promotions`, list);
    else await refuses(`${who} lacks promo.read → GET /promotions`, list, 403);

    const create = await api[who].post('/promotions', {
      name: `Authz probe ${who} ${Date.now()}`,
      benefitType: 'PERCENT',
      percent: 5,
      precedence: 100,
      stackable: false,
    });
    if (canWrite) {
      if (await admits(`${who} holds promo.write → POST /promotions`, create)) {
        // Clean up immediately: this harness is about gates, not fixtures.
        const id = create.data?.promotion?.id;
        if (id) sql(`delete from "Promotion" where id = '${id}'`);
      }
    } else {
      await refuses(`${who} lacks promo.write → POST /promotions`, create, 403);
    }
  }

  // ------------------------------------------------------- kitchen: role gates
  // kitchen.js gates with requireRole, NOT requireAction, so there is no
  // kitchen.* action in /permissions/me to mirror. The client therefore copies
  // the role lists, and this section is what keeps those copies honest:
  //   operate   = CUSTOMER_OWNER, BRANCH_MANAGER, CASHIER   (board, item state)
  //   managerUp = CUSTOMER_OWNER, BRANCH_MANAGER            (stations, routes, overview)
  section('kitchen role gates match kitchen.js operate/managerUp');
  const managerUp = new Set(['owner', 'manager']);
  for (const who of ['owner', 'manager', 'cashier', 'companyAdmin', 'regionalManager', 'finance']) {
    const qs = who === 'owner' ? `?branchId=${ownerBranchId}` : '';
    const ov = await api[who].get(`/kitchen/overview${qs}`);
    if (managerUp.has(who)) {
      await admits(`${who} is managerUp → GET /kitchen/overview`, ov);
    } else if (who === 'companyAdmin' || who === 'regionalManager') {
      // OPEN GAP, not a pass. kitchen.js gates with a hardcoded
      // requireRole('CUSTOMER_OWNER','BRANCH_MANAGER') allowlist, not
      // requireAction(). These two roles resolve broad promo.write/promo.publish
      // (companyAdmin) or promo.apply (regionalManager) through the ROLE_ACTIONS
      // baseline in permissions.js — see the promo.* sections above — and that
      // baseline has no effect here because kitchen.js never consults it. The
      // allowlist predates both roles and was never extended.
      //
      // The 403 below is REAL and is asserted, so a future loosening shows up
      // here as a failure rather than passing unnoticed. What it is not is
      // evidence of a correct control: nobody decided these roles should be
      // locked out of the kitchen, the allowlist simply never mentioned them.
      // Until the owner of kitchen.js states the intended policy this is an
      // unresolved question, and gap() is what stops it reading as settled.
      const got = ov.status === 403;
      if (!got) no(`${who} → GET /kitchen/overview returned ${ov.status}, not the 403 this gap predicts`);
      gap(
        `${who} is locked out of the kitchen by an allowlist that predates the role (403)`,
        'kitchen.js (backend, outside x/operator-ui) — policy decision required',
        'Is exclusion intended, or is the allowlist stale? Frontend mirrors the '
        + 'three-role list so the UI never offers a screen the server will refuse; '
        + 'the backend question is untouched by that.',
      );
    } else {
      await refuses(`${who} is not managerUp → GET /kitchen/overview`, ov, 403);
    }
  }

  // OPEN GAP, not a pass. GET /kitchen/stations carries no role gate at all —
  // only requirePosAuth + resolveCompanyScope — while every sibling route on
  // the same router carries operate or managerUp.
  //
  // The previous spelling of this section called admits() on each role and
  // printed three PASS lines. That was wrong in a way worth naming: the three
  // roles it probed (owner, manager, cashier) are all inside `operate`, so they
  // would be admitted by a properly gated route too. The assertion could not
  // distinguish "correctly allows operate" from "allows everyone", and it was
  // reported as a pass for a route with no gate.
  //
  // So the probe below uses a role in NEITHER allowlist. That is the only
  // principal whose 200 proves the gate is absent rather than merely generous.
  section('GET /kitchen/stations has no role gate at all (open gap)');
  for (const who of ['owner', 'manager', 'cashier']) {
    const qs = who === 'owner' ? `?branchId=${ownerBranchId}` : '';
    const st = await api[who].get(`/kitchen/stations${qs}`);
    await admits(`${who} is in operate, so a correctly gated route admits it too → GET /kitchen/stations`, st);
  }
  // ?branchId= is NOT optional here, and leaving it off is how this probe lied
  // on its first run. FINANCE is not a BRANCH_PINNED_ROLE, so callerBranchId()
  // throws badRequest('branchId is required') before any gate is consulted —
  // the probe got a 400, the code read "not 200, therefore refused", and
  // reported the gap CLOSED. A 400 means the request never reached the gate; it
  // is not evidence of anything about authorization.
  const ungated = await api.finance.get(`/kitchen/stations?branchId=${ownerBranchId}`);
  if (ungated.status === 200) {
    gap(
      'GET /kitchen/stations admits a role in NEITHER operate NOR managerUp (finance → 200)',
      'kitchen.js (backend, outside x/operator-ui) — missing requireRole',
      'Every sibling route on this router is gated; this one is not, so any '
      + 'authenticated role in the company can enumerate station names. Tenancy '
      + 'still holds (resolveCompanyScope) — the cross-tenant section below '
      + 'proves a rival gets none — so this is over-exposure inside one company, '
      + 'not a tenancy leak.',
    );
  } else if (ungated.status === 403) {
    // If the owner has since gated it, say so loudly rather than quietly
    // continuing to describe a gap that no longer exists.
    ok('GET /kitchen/stations now refuses a non-operate role (403) — the gap appears CLOSED, update the handoff');
  } else {
    no(`GET /kitchen/stations probe is INCONCLUSIVE: finance got ${ungated.status}, which is neither 200 (gap open) nor 403 (gap closed) — the request likely never reached the role gate`);
  }

  // ------------------------------------------------------------ cross-tenant
  section('cross-tenant: a rival company must get 404, never 403 and never 200');
  const rival = await makeRivalTenant();
  const rs = await login(rival.email, rival.password);
  const rapi = client(rs);
  check('rival is its own company', rs.user.companyId === s.owner.user.companyId, 'false');

  // A promotion that genuinely exists, in tenant A.
  const mine = await api.owner.post('/promotions', {
    name: `Tenancy probe ${Date.now()}`,
    benefitType: 'PERCENT',
    percent: 7,
    precedence: 100,
    stackable: false,
  });
  const mineId = mine.data?.promotion?.id;
  if (!truthy('tenant A created a promotion to probe against', mineId)) {
    verdict('vcxo accept authz');
    return;
  }

  // The rival's own list must not contain it, and must not error.
  const rlist = await rapi.get('/promotions');
  if (await admits('rival → GET /promotions', rlist)) {
    const ids = (rlist.data?.promotions ?? []).map((p) => p.id);
    check("tenant A's promotion is absent from the rival's list", ids.includes(mineId), 'false');
  }

  // 404 is the required answer on every verb. A 403 would confirm existence.
  await refuses('rival → PATCH tenant A promotion', await rapi.patch(`/promotions/${mineId}`, {
    name: 'hijacked', benefitType: 'PERCENT', percent: 1, precedence: 100, stackable: false,
  }), 404);
  await refuses('rival → PUT tenant A promotion stores', await rapi.put(`/promotions/${mineId}/stores`, {
    branchIds: [rival.branchId],
  }), 404);
  await refuses('rival → PUT tenant A promotion rules', await rapi.put(`/promotions/${mineId}/rules`, {
    rules: [],
  }), 404);
  await refuses('rival → POST publish tenant A promotion', await rapi.post(`/promotions/${mineId}/publish`), 404);
  await refuses('rival → POST archive tenant A promotion', await rapi.post(`/promotions/${mineId}/archive`), 404);

  // And the rival's kitchen is empty rather than tenant A's.
  //
  // Tenant A must actually OWN a station for this to test anything. It did not:
  // the seed ships zero KitchenStation rows and the other harnesses clean theirs
  // up, so "the rival sees none of tenant A's stations" was passing against an
  // empty set, and the line that looked like a guard —
  // ok(`(tenant A has ${n} station row(s))`) — passed unconditionally and
  // printed 0. A note is not a guard. Build the thing to be hidden first, and
  // fail if it could not be built.
  const probeStation = await api.owner.post('/kitchen/stations', {
    branchId: ownerBranchId, name: `Tenancy probe station ${Date.now()}`,
  });
  const probeStationId = probeStation.data?.station?.id ?? null;
  truthy('tenant A has a station for the rival to fail to see', probeStationId);
  const rst = await rapi.get('/kitchen/stations');
  if (probeStationId && await admits('rival → GET /kitchen/stations', rst)) {
    const stations = rst.data?.stations ?? [];
    const aStations = Number(sql(
      `select count(*) from "KitchenStation" where "companyId" = '${s.owner.user.companyId}'`,
    ));
    check('tenant A genuinely has stations to hide, so the next check is not vacuous', aStations > 0, 'true');
    check("rival sees none of tenant A's stations", stations.length, 0);
    check("tenant A's station id is absent from the rival's payload",
      stations.some((x) => x.id === probeStationId), 'false');
  }
  if (probeStationId) sql(`delete from "KitchenStation" where id = '${probeStationId}'`);

  // A branch id from tenant A, offered by the rival, must 404 too — the branch
  // is the scoping key the kitchen board is addressed by.
  const aBranch = sql(
    `select id from "Branch" where "companyId" = '${s.owner.user.companyId}' limit 1`,
  );
  // Exactly 404. The previous [400, 403, 404] contradicted this harness's own
  // rule that a refusal must be the RIGHT refusal: a 403 would confirm the
  // branch exists, which is itself the cross-tenant disclosure being tested,
  // and a 400 would mean the request died before the tenancy check. The browser
  // journey asserts the same single code against the same route, and the server
  // does answer 404 — so accepting three codes only bought the freedom to pass
  // when the answer got worse.
  const rboard = await rapi.get(`/kitchen/overview?branchId=${aBranch}`);
  await refuses("rival → GET /kitchen/overview scoped to tenant A's branch", rboard, 404);

  // Tidy the probe row away so repeated runs do not accumulate fixtures.
  sql(`delete from "Promotion" where id = '${mineId}'`);

  verdict('vcxo accept authz');
};

main().catch((e) => {
  console.error(`\nharness error: ${e.message}`);
  process.exit(2);
});
