// x/operator-ui acceptance — KITCHEN DISPLAY (VC-103) contracts, against the
// landed backend in backend/src/api/routes/kitchen.js + backend/src/lib/kitchen.js.
//
// authz-acceptance.mjs proves WHO may call these routes. This harness assumes a
// caller who may, and proves what the routes DO:
//
//   - station create: (branchId,name) uniqueness is a 409 not a 500, and
//     `isDefault` is exclusive — the schema's @unique on defaultForBranch means
//     at most one default per store, and a new default must clear the old one;
//   - routing precedence is product-rule > category-rule > store default, and a
//     rule pointing at an ARCHIVED station falls back to the default instead of
//     dropping the ticket (lib/kitchen.js's stationById guard);
//   - KOT creation is the ONLY path that mints KitchenItem rows, one per order
//     line, and a replayed KOT cannot mint a second ticket;
//   - the transition contract: forward-only per canTransition(), a replay of an
//     applied decision is a 200 no-op (not a second write), a stale version is
//     409, an illegal target is 409, and CANCELLED demands a reason;
//   - board semantics: the full snapshot carries live states only, while
//     ?sinceSeq=N carries everything past N *including* terminal rows, which is
//     what makes a reconnect learn about lines that finished while it was away;
//   - the supervisor overview's numbers, recomputed independently in SQL rather
//     than compared against this harness's own idea of what it created — the
//     endpoint counts every row at the station, not just this run's.
//
// Every mutation is confirmed by reading the row back out of Postgres. A 200
// over a rolled-back transaction looks exactly like a 200 over a committed one
// from this side of the wire, so status codes are never the evidence.
//
// Fixtures are built through the real Order → OrderItem → KOT pipeline, never
// by INSERTing KitchenItem rows: routing, changeSeq and targetSeconds are all
// decided by routeKotItems(), and a hand-built row would be asserting this
// harness's assumptions back at itself. The one deliberate SQL write is
// archiving a station, flagged where it happens — kitchen.js exposes no
// endpoint that can archive one, and the fallback path cannot be reached
// without an archived station to fall back from.
//
// Writes only to this lane's private database, and removes every row it creates.

import {
  sessions, client, check, ok, no, section, verdict, refuses, admits, truthy, sql, sqlBool,
} from './opui-lib.mjs';

const main = async () => {
  const s = await sessions();
  const owner = client(s.owner);
  const manager = client(s.manager);
  const cashier = client(s.cashier);
  const companyId = s.owner.user.companyId;
  const stamp = Date.now().toString(36);

  // ------------------------------------------------------------------ setup
  section('fixture ground: a branch the pinned roles share, and real menu rows');
  const branchesRes = await owner.get('/branches');
  const branches = branchesRes.data?.branches ?? [];
  truthy('owner can list branches', branches.length >= 2 || undefined);
  const branchId = s.manager.user.branchId;
  truthy('manager is pinned to a branch (the board under test)', branchId);
  check('cashier is pinned to the same branch, so both see one board', s.cashier.user.branchId, branchId);
  const otherBranchId = branches.find((b) => b.id !== branchId)?.id;
  truthy('a second branch exists, for the branch-pin refusal below', otherBranchId);

  // Looked up, not hard-coded: a reseed that changes ids must not silently stop
  // testing routing. Espresso and Cappuccino must share a category for the
  // precedence proof to mean anything, which is asserted rather than assumed.
  const prodId = (name) =>
    sql(`select id from "Product" where "companyId" = '${companyId}' and name = '${name}'`);
  const catOf = (pid) => sql(`select "categoryId" from "Product" where id = '${pid}'`);
  const cappuccino = prodId('Cappuccino');
  const espresso = prodId('Espresso');
  const vegSandwich = prodId('Veg Sandwich');
  const coldBrew = prodId('Cold Brew');
  const masalaChai = prodId('Masala Chai');
  truthy('demo menu has Cappuccino', cappuccino);
  truthy('demo menu has Espresso', espresso);
  truthy('demo menu has Veg Sandwich', vegSandwich);
  truthy('demo menu has Cold Brew', coldBrew);
  truthy('demo menu has Masala Chai', masalaChai);
  const coffeeCat = catOf(cappuccino);
  check('Espresso shares Cappuccino\'s category (the rule the product rule must beat)', catOf(espresso), coffeeCat);
  check('Veg Sandwich is in a DIFFERENT category (so it reaches the default)', catOf(vegSandwich) !== coffeeCat, 'true');

  // Self-heal a prior run that died before its cleanup. Without this, leftover
  // ticket rows make the final "no kitchen ticket rows survive" assertion fail
  // for the previous run's reasons rather than this one's — and an assertion
  // that fails for last time's reasons teaches nothing about this time. Scoped
  // to the 'KDS ' station prefix this harness owns, and to the orders whose
  // ticket lines sit on those stations; it can reach nothing else.
  const preClean = () => {
    const stale = sql(`select id from "KitchenStation" where name like 'KDS %'`).split('\n').filter(Boolean);
    if (!stale.length) return 0;
    const inList = stale.map((x) => `'${x}'`).join(',');
    const orders = sql(`select distinct "orderId" from "KitchenItem" where "stationId" in (${inList})`)
      .split('\n').filter(Boolean);
    sql(`delete from "KitchenItem" where "stationId" in (${inList})`);
    if (orders.length) {
      const oList = orders.map((x) => `'${x}'`).join(',');
      sql(`delete from "OrderItemModifier" where "orderItemId" in (select id from "OrderItem" where "orderId" in (${oList}))`);
      sql(`delete from "OrderItem" where "orderId" in (${oList})`);
      sql(`delete from "Kot" where "orderId" in (${oList})`);
      sql(`delete from "Order" where id in (${oList})`);
    }
    sql(`delete from "KitchenRoute" where "stationId" in (${inList})`);
    sql(`delete from "KitchenStation" where id in (${inList})`);
    return stale.length;
  };
  const healed = preClean();
  if (healed) ok(`pre-clean removed ${healed} station(s) left by an interrupted earlier run`);

  const stationIds = [];
  const orderIds = [];
  const mkStation = async (name, extra = {}) => {
    const r = await owner.post('/kitchen/stations', { branchId, name, ...extra });
    const id = r.data?.station?.id;
    if (id) stationIds.push(id);
    return { res: r, id };
  };

  // --------------------------------------------------------------- stations
  section('stations: creation, duplicate-name refusal, and exclusive default');
  const bar = await mkStation(`KDS Bar ${stamp}`, { sortOrder: 10, targetPrepSeconds: 300 });
  const grill = await mkStation(`KDS Grill ${stamp}`, { sortOrder: 20, targetPrepSeconds: 900 });
  const retired = await mkStation(`KDS Retired ${stamp}`, { sortOrder: 90 });
  await admits('owner creates the Bar station', bar.res);
  await admits('owner creates the Grill station', grill.res);
  await admits('owner creates the station that will later be archived', retired.res);
  if (!truthy('Bar has an id', bar.id) || !truthy('Grill has an id', grill.id) || !truthy('Retired has an id', retired.id)) {
    verdict('vcxo accept kds');
    return;
  }
  check('Bar landed in Postgres on the right branch', sql(`select "branchId" from "KitchenStation" where id = '${bar.id}'`), branchId);
  check('Bar kept the targetPrepSeconds it was created with', sql(`select "targetPrepSeconds" from "KitchenStation" where id = '${bar.id}'`), 300);
  check('a station defaults to ACTIVE', sql(`select status from "KitchenStation" where id = '${bar.id}'`), 'ACTIVE');
  check('a station created without isDefault is not the default', sqlBool(`select "defaultForBranch" is null from "KitchenStation" where id = '${bar.id}'`), true);

  await refuses(
    'a second station with the same name in the same branch is a 409, not a raw P2002 500',
    await owner.post('/kitchen/stations', { branchId, name: `KDS Bar ${stamp}` }),
    409,
  );
  check('the refused duplicate did not create a second row', sql(`select count(*) from "KitchenStation" where "branchId" = '${branchId}' and name = 'KDS Bar ${stamp}'`), 1);

  // defaultForBranch is @unique, so "at most one default per store" is a schema
  // invariant; POST /stations clears the incumbent inside the same transaction.
  // Proven by taking the default away from one station with another.
  const passTemp = await mkStation(`KDS Pass Temp ${stamp}`, { sortOrder: 30, isDefault: true });
  await admits('owner creates a first default station', passTemp.res);
  check('the first default station holds the branch id', sql(`select "defaultForBranch" from "KitchenStation" where id = '${passTemp.id}'`), branchId);
  const pass = await mkStation(`KDS Pass ${stamp}`, { sortOrder: 40, isDefault: true, targetPrepSeconds: 600 });
  await admits('owner creates a second station also asking to be default', pass.res);
  check('the new station is now the default', sql(`select "defaultForBranch" from "KitchenStation" where id = '${pass.id}'`), branchId);
  check('the previous default was cleared, not left duplicated', sqlBool(`select "defaultForBranch" is null from "KitchenStation" where id = '${passTemp.id}'`), true);
  check('exactly one station in the branch is the default', sql(`select count(*) from "KitchenStation" where "defaultForBranch" = '${branchId}'`), 1);

  // A station on the OTHER branch, for the branch-pin refusal on the board.
  // callerBranchId() refuses an explicit branch that contradicts a pinned user,
  // so this one is created by the company-wide owner against the other branch.
  const foreignRes = await owner.post('/kitchen/stations', { branchId: otherBranchId, name: `KDS Other Branch ${stamp}` });
  await admits('owner creates a station on the other branch', foreignRes);
  const foreignId = foreignRes.data?.station?.id;
  if (foreignId) stationIds.push(foreignId);
  truthy('a station exists on the other branch', foreignId);

  section('GET /kitchen/stations lists ACTIVE stations for the branch, in sortOrder');
  const listed = await manager.get('/kitchen/stations');
  if (await admits('manager lists stations without needing a branchId (pinned)', listed)) {
    const names = (listed.data?.stations ?? []).map((x) => x.name);
    check('the branch\'s five new stations are all listed', names.filter((n) => n.endsWith(stamp)).length, 5);
    check('no station from the other branch leaks in', names.includes(`KDS Other Branch ${stamp}`), 'false');
    const orders = (listed.data?.stations ?? []).map((x) => x.sortOrder);
    check('stations come back in sortOrder', JSON.stringify(orders) === JSON.stringify([...orders].sort((a, b) => a - b)), 'true');
    const passRow = (listed.data?.stations ?? []).find((x) => x.id === pass.id);
    check('the default station is flagged isDefault in the payload', passRow?.isDefault, 'true');
  }

  // ----------------------------------------------------------------- routes
  section('routes: upsert in place on (branchId, matchKey), never a second row');
  const r1 = await owner.post('/kitchen/routes', { stationId: grill.id, categoryId: coffeeCat });
  await admits('owner points the Coffee category at Grill', r1);
  check('one route row exists for that category', sql(`select count(*) from "KitchenRoute" where "branchId" = '${branchId}' and "matchKey" = 'category:${coffeeCat}'`), 1);
  const r2 = await owner.post('/kitchen/routes', { stationId: bar.id, categoryId: coffeeCat });
  await admits('owner re-points the same category at Bar', r2);
  check('the re-point updated the existing row instead of adding one', sql(`select count(*) from "KitchenRoute" where "branchId" = '${branchId}' and "matchKey" = 'category:${coffeeCat}'`), 1);
  check('the surviving route now names Bar', sql(`select "stationId" from "KitchenRoute" where "branchId" = '${branchId}' and "matchKey" = 'category:${coffeeCat}'`), bar.id);

  await admits('owner points the Espresso PRODUCT at Grill', await owner.post('/kitchen/routes', { stationId: grill.id, productId: espresso }));
  await admits('owner points the Cold Brew product at the soon-to-be-archived station', await owner.post('/kitchen/routes', { stationId: retired.id, productId: coldBrew }));
  await refuses('a route naming neither a product nor a category', await owner.post('/kitchen/routes', { stationId: bar.id }), 400);
  await refuses('a route naming BOTH a product and a category', await owner.post('/kitchen/routes', { stationId: bar.id, productId: espresso, categoryId: coffeeCat }), 400);
  await refuses('a route naming a station outside the tenant', await owner.post('/kitchen/routes', { stationId: 'nonexistent-station-id', productId: espresso }), 404);

  // THE ONE DELIBERATE SQL WRITE. kitchen.js has no endpoint that archives a
  // station, and routeKotItems()'s stationById fallback — "a ticket must never
  // vanish because mapping went stale" — is unreachable without one. Archiving
  // here is setting up the precondition, not standing in for the code under
  // test: the assertion below is still about what routeKotItems() decides.
  sql(`update "KitchenStation" set status = 'ARCHIVED' where id = '${retired.id}'`);
  check('the station under the Cold Brew route is now ARCHIVED', sql(`select status from "KitchenStation" where id = '${retired.id}'`), 'ARCHIVED');
  const afterArchive = await manager.get('/kitchen/stations');
  check('an ARCHIVED station drops out of GET /kitchen/stations', (afterArchive.data?.stations ?? []).some((x) => x.id === retired.id), 'false');

  // ------------------------------------------------------- the KOT pipeline
  section('KOT routing: product rule beats category rule beats store default');
  const mkOrder = async (items) => {
    const r = await owner.post('/orders', { type: 'TAKEAWAY', branchId, items });
    const id = r.data?.order?.id;
    if (id) orderIds.push(id);
    return { res: r, id };
  };
  const o1 = await mkOrder([
    { productId: cappuccino, qty: 2 },
    { productId: espresso, qty: 1 },
    { productId: vegSandwich, qty: 1 },
    { productId: coldBrew, qty: 1 },
  ]);
  if (!(await admits('owner opens a takeaway order with four lines', o1.res)) || !truthy('order 1 has an id', o1.id)) {
    verdict('vcxo accept kds');
    return;
  }
  check('no kitchen ticket exists before the KOT is sent', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}'`), 0);

  const kot1 = await owner.post(`/orders/${o1.id}/kot`);
  await admits('owner sends the order to the kitchen', kot1);
  check('one kitchen ticket line per order line', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}'`), 4);

  const stationOf = (productName) =>
    sql(`select ki."stationId" from "KitchenItem" ki
         join "OrderItem" oi on oi.id = ki."orderItemId"
         where ki."orderId" = '${o1.id}' and oi.name = '${productName}'`);
  check('Cappuccino follows the CATEGORY rule → Bar', stationOf('Cappuccino'), bar.id);
  check('Espresso follows its PRODUCT rule → Grill, beating the category rule', stationOf('Espresso'), grill.id);
  check('Veg Sandwich has no rule at all → the store default', stationOf('Veg Sandwich'), pass.id);
  check('Cold Brew\'s route points at an ARCHIVED station → falls back to the default, ticket does not vanish', stationOf('Cold Brew'), pass.id);

  section('what routeKotItems() stamps on a new ticket line');
  check('every new line starts QUEUED', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}' and state = 'QUEUED'`), 4);
  check('every new line starts at version 1', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}' and version = 1`), 4);
  check('every new line has queuedAt set', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}' and "queuedAt" is not null`), 4);
  check('every new line got a non-zero changeSeq from the store cursor', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}' and "changeSeq" > 0`), 4);
  check('changeSeq values are distinct — the cursor advanced per line', sql(`select count(distinct "changeSeq") from "KitchenItem" where "orderId" = '${o1.id}'`), 4);
  check('targetSeconds is copied from the station that won the routing (Bar = 300)', sql(`select ki."targetSeconds" from "KitchenItem" ki join "OrderItem" oi on oi.id = ki."orderItemId" where ki."orderId" = '${o1.id}' and oi.name = 'Cappuccino'`), 300);
  check('targetSeconds for the Grill line is Grill\'s 900, not a global default', sql(`select ki."targetSeconds" from "KitchenItem" ki join "OrderItem" oi on oi.id = ki."orderItemId" where ki."orderId" = '${o1.id}' and oi.name = 'Espresso'`), 900);
  check('the store cursor exists and is at least as high as the highest line', sqlBool(`select c."lastSeq" >= max(ki."changeSeq") from "KitchenCursor" c, "KitchenItem" ki where c."branchId" = '${branchId}' and ki."orderId" = '${o1.id}' group by c."lastSeq"`), true);

  section('a replayed KOT cannot mint a second ticket line');
  await refuses('re-sending an order with nothing new', await owner.post(`/orders/${o1.id}/kot`), 409);
  check('still four ticket lines after the refused replay', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}'`), 4);

  section('a second KOT on the same order routes the new line and numbers itself');
  await admits('owner adds a Masala Chai to the open order', await owner.post(`/orders/${o1.id}/items`, { productId: masalaChai, qty: 1 }));
  const kot2 = await owner.post(`/orders/${o1.id}/kot`);
  await admits('owner sends the second KOT', kot2);
  check('the second KOT is seq 2', kot2.data?.kot?.seq, 2);
  check('five ticket lines now', sql(`select count(*) from "KitchenItem" where "orderId" = '${o1.id}'`), 5);
  check('the new Coffee line also followed the category rule → Bar', stationOf('Masala Chai'), bar.id);
  check('each ticket line maps to exactly one order line (orderItemId is unique)', sql(`select count(distinct "orderItemId") from "KitchenItem" where "orderId" = '${o1.id}'`), 5);

  // ------------------------------------------------------------ transitions
  section('transition contract: forward-only, replay is a no-op, stale is 409');
  const itemOf = (productName) =>
    sql(`select ki.id from "KitchenItem" ki join "OrderItem" oi on oi.id = ki."orderItemId"
         where ki."orderId" = '${o1.id}' and oi.name = '${productName}'`);
  const capItem = itemOf('Cappuccino');
  const vegItem = itemOf('Veg Sandwich');
  const stateOf = (id) => sql(`select state from "KitchenItem" where id = '${id}'`);
  const versionOf = (id) => sql(`select version from "KitchenItem" where id = '${id}'`);

  const toPrep = await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'IN_PREP', version: 1 });
  await admits('cashier starts prep on the Cappuccino line (operate role)', toPrep);
  check('state is IN_PREP in Postgres', stateOf(capItem), 'IN_PREP');
  check('version incremented to 2', versionOf(capItem), 2);
  check('startedAt was stamped', sqlBool(`select "startedAt" is not null from "KitchenItem" where id = '${capItem}'`), true);
  check('readyAt is still null — one timestamp per state entered', sqlBool(`select "readyAt" is null from "KitchenItem" where id = '${capItem}'`), true);
  check('lastActorId records who moved it', sql(`select "lastActorId" from "KitchenItem" where id = '${capItem}'`), s.cashier.user.id);

  const replay = await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'IN_PREP', version: 1 });
  if (await admits('the SAME decision replayed (same version, same target) is accepted', replay)) {
    check('and is reported as a replay, not a fresh write', replay.data?.replayed, 'true');
  }
  check('the replay did not bump version a second time', versionOf(capItem), 2);

  await refuses('a decision named on a stale version', await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'READY', version: 1 }), 409);
  check('the refused stale decision left the row where it was', stateOf(capItem), 'IN_PREP');
  await refuses('skipping READY: IN_PREP → SERVED is not a legal transition', await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'SERVED', version: 2 }), 409);
  check('the refused illegal transition left the version alone', versionOf(capItem), 2);

  await admits('IN_PREP → READY', await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'READY', version: 2 }));
  check('readyAt was stamped', sqlBool(`select "readyAt" is not null from "KitchenItem" where id = '${capItem}'`), true);
  await refuses('a READY line cannot be cancelled here — that is a till void', await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'CANCELLED', version: 3, reason: 'customer left' }), 409);
  await admits('READY → SERVED', await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'SERVED', version: 3 }));
  check('state is SERVED', stateOf(capItem), 'SERVED');
  check('servedAt was stamped', sqlBool(`select "servedAt" is not null from "KitchenItem" where id = '${capItem}'`), true);
  await refuses('SERVED is terminal', await cashier.post(`/kitchen/items/${capItem}/state`, { to: 'READY', version: 4 }), 409);
  check('all four prep timestamps survive on the finished line', sqlBool(`select "queuedAt" is not null and "startedAt" is not null and "readyAt" is not null and "servedAt" is not null from "KitchenItem" where id = '${capItem}'`), true);

  section('cancellation demands a reason and records who, why and when');
  await refuses('CANCELLED without a reason', await cashier.post(`/kitchen/items/${vegItem}/state`, { to: 'CANCELLED', version: 1 }), 400);
  check('the reasonless attempt did not cancel anything', stateOf(vegItem), 'QUEUED');
  await admits('CANCELLED with a reason, from QUEUED', await cashier.post(`/kitchen/items/${vegItem}/state`, { to: 'CANCELLED', version: 1, reason: 'out of bread' }));
  check('state is CANCELLED', stateOf(vegItem), 'CANCELLED');
  check('cancelledAt was stamped', sqlBool(`select "cancelledAt" is not null from "KitchenItem" where id = '${vegItem}'`), true);
  // WHO is lastActorId + the audit actor, WHY is the audit meta, WHEN is
  // cancelledAt — kitchen.js deliberately keeps the reason off the item row.
  check('the item row carries no reason column to have put it in', sqlBool(`select "delayReason" is null from "KitchenItem" where id = '${vegItem}'`), true);
  check('the WHY is in the audit row instead', sql(`select count(*) from "PosAuditLog" where action = 'KITCHEN_ITEM_STATE' and "entityId" = '${vegItem}' and meta->>'reason' = 'out of bread'`), 1);
  check('the audit row names the actor who cancelled', sql(`select "actorId" from "PosAuditLog" where action = 'KITCHEN_ITEM_STATE' and "entityId" = '${vegItem}' and meta->>'reason' = 'out of bread'`), s.cashier.user.id);
  check('the audit row records the from-state as well as the to-state', sql(`select meta->>'from' from "PosAuditLog" where action = 'KITCHEN_ITEM_STATE' and "entityId" = '${vegItem}' and meta->>'reason' = 'out of bread'`), 'QUEUED');
  await refuses('a bogus item id is 404, not 500', await cashier.post('/kitchen/items/nonexistent-item-id/state', { to: 'IN_PREP', version: 1 }), 404);

  // ------------------------------------------------------------------ board
  section('board: the full snapshot carries live states only');
  const barBoard = await cashier.get(`/kitchen/stations/${bar.id}/board`);
  if (await admits('cashier reads the Bar board', barBoard)) {
    const ids = (barBoard.data?.items ?? []).map((i) => i.id);
    check('the SERVED Cappuccino line is not on the live board', ids.includes(capItem), 'false');
    check('the still-QUEUED Masala Chai line is', ids.includes(itemOf('Masala Chai')), 'true');
    check('the board reports the store cursor', Number(barBoard.data?.seq) > 0, 'true');
    const chai = (barBoard.data?.items ?? []).find((i) => i.id === itemOf('Masala Chai'));
    check('a board row carries the line name for the screen', chai?.name, 'Masala Chai');
    truthy('a board row carries its KOT seq', chai?.kotSeq);
  }
  const passBoard = await cashier.get(`/kitchen/stations/${pass.id}/board`);
  if (await admits('cashier reads the Pass board', passBoard)) {
    const ids = (passBoard.data?.items ?? []).map((i) => i.id);
    check('the CANCELLED Veg Sandwich line is not on the live board', ids.includes(vegItem), 'false');
    check('the QUEUED Cold Brew line is', ids.includes(itemOf('Cold Brew')), 'true');
  }

  section('board: ?sinceSeq=N carries terminal rows too, so a reconnect catches up');
  const since0 = await cashier.get(`/kitchen/stations/${pass.id}/board?sinceSeq=0`);
  if (await admits('cashier replays the Pass board from seq 0', since0)) {
    const ids = (since0.data?.items ?? []).map((i) => i.id);
    check('the CANCELLED line IS included in a sinceSeq replay', ids.includes(vegItem), 'true');
    const seqs = (since0.data?.items ?? []).map((i) => Number(i.changeSeq));
    check('sinceSeq rows come back in changeSeq order', JSON.stringify(seqs) === JSON.stringify([...seqs].sort((a, b) => a - b)), 'true');
  }
  const head = Number(since0.data?.seq ?? 0);
  const sinceHead = await cashier.get(`/kitchen/stations/${pass.id}/board?sinceSeq=${head}`);
  if (await admits('cashier polls again from the cursor it was just given', sinceHead)) {
    check('a caller already at the head is told about nothing new', (sinceHead.data?.items ?? []).length, 0);
  }
  await refuses('a negative sinceSeq', await cashier.get(`/kitchen/stations/${pass.id}/board?sinceSeq=-1`), 400);
  await refuses('a non-numeric sinceSeq', await cashier.get(`/kitchen/stations/${pass.id}/board?sinceSeq=abc`), 400);
  await refuses('a bogus station id', await cashier.get('/kitchen/stations/nonexistent-station-id/board'), 404);
  await refuses(
    "a pinned cashier reading another branch's board gets 404 — not 403, which would confirm the station exists",
    await cashier.get(`/kitchen/stations/${foreignId}/board`),
    404,
  );

  // --------------------------------------------------------------- overview
  section('overview: every number recomputed independently in SQL');
  // A second order taken all the way to READY, so ordersKitchenReady has
  // something true to report and is not merely asserted to be zero.
  const o2 = await mkOrder([{ productId: cappuccino, qty: 1 }]);
  await admits('owner opens a second order', o2.res);
  await admits('and sends it to the kitchen', await owner.post(`/orders/${o2.id}/kot`));
  const o2Item = sql(`select id from "KitchenItem" where "orderId" = '${o2.id}'`);
  await admits('order 2 line → IN_PREP', await manager.post(`/kitchen/items/${o2Item}/state`, { to: 'IN_PREP', version: 1 }));
  await admits('order 2 line → READY', await manager.post(`/kitchen/items/${o2Item}/state`, { to: 'READY', version: 2 }));

  const ov = await owner.get(`/kitchen/overview?branchId=${branchId}`);
  if (await admits('owner reads the supervisor overview with an explicit branchId', ov)) {
    const rows = ov.data?.stations ?? [];
    truthy('the overview lists stations', rows.length || undefined);
    check('the ARCHIVED station is not in the overview', rows.some((r) => r.stationId === retired.id), 'false');
    for (const r of rows) {
      // Counts are recomputed over the whole station, exactly as the endpoint
      // does — not over "the rows this run created". If another fixture is
      // present the endpoint's number must still be the true one.
      check(
        `overview queued count for ${r.name} matches SQL`,
        r.queued,
        sql(`select count(*) from "KitchenItem" where "stationId" = '${r.stationId}' and state = 'QUEUED'`),
      );
      check(
        `overview inPrep count for ${r.name} matches SQL`,
        r.inPrep,
        sql(`select count(*) from "KitchenItem" where "stationId" = '${r.stationId}' and state = 'IN_PREP'`),
      );
      const oldest = sql(`select count(*) from "KitchenItem" where "stationId" = '${r.stationId}' and state = 'QUEUED'`);
      if (Number(oldest) === 0) {
        check(`${r.name} has no queue, so oldestQueuedAgeSec is null`, r.oldestQueuedAgeSec === null, 'true');
      } else {
        check(`${r.name} has a queue, so oldestQueuedAgeSec is a number`, Number.isInteger(r.oldestQueuedAgeSec), 'true');
      }
    }

    // orderKitchenReady(): every non-cancelled line READY or later, and at
    // least one such line — recomputed here in SQL over OPEN orders in this
    // branch, which is the same population kitchen.js scopes to.
    const expectedReady = sql(`
      select count(*) from (
        select ki."orderId"
        from "KitchenItem" ki
        join "Order" o on o.id = ki."orderId"
        where ki."branchId" = '${branchId}' and o.status = 'OPEN'
        group by ki."orderId"
        having count(*) filter (where ki.state <> 'CANCELLED') > 0
           and count(*) filter (where ki.state not in ('READY','SERVED','CANCELLED')) = 0
      ) t`);
    check('ordersKitchenReady matches an independent SQL recomputation', ov.data?.ordersKitchenReady, expectedReady);
    check('and it is genuinely non-zero, so the assertion above is not vacuous', Number(expectedReady) >= 1, 'true');
    check('the overview cursor matches the branch cursor row', ov.data?.seq, sql(`select "lastSeq" from "KitchenCursor" where "branchId" = '${branchId}'`));
    truthy('lastChangeAt is reported', ov.data?.lastChangeAt);
  }

  section('overview is managerUp; the board is operate');
  await admits('manager (pinned, no branchId needed) reads the overview', await manager.get('/kitchen/overview'));
  await refuses('cashier is operate but not managerUp → overview', await cashier.get('/kitchen/overview'), 403);
  await refuses('cashier cannot create a station', await cashier.post('/kitchen/stations', { name: `KDS Nope ${stamp}` }), 403);
  await refuses('cashier cannot create a route', await cashier.post('/kitchen/routes', { stationId: bar.id, productId: espresso }), 403);
  check('the refused cashier station create left no row', sql(`select count(*) from "KitchenStation" where name = 'KDS Nope ${stamp}'`), 0);
  await refuses('a company-wide owner must name a branch — the kitchen is per-store', await owner.get('/kitchen/overview'), 400);

  // ---------------------------------------------------------------- cleanup
  // FK order: KitchenItem first (it points at OrderItem/Kot with Cascade but at
  // KitchenStation with the default Restrict, so a station cannot go while a
  // ticket still names it), then the order tree, then routes, then stations.
  section('cleanup: this harness is about contracts, not fixtures');
  for (const oid of orderIds) {
    sql(`delete from "KitchenItem" where "orderId" = '${oid}'`);
    sql(`delete from "OrderItemModifier" where "orderItemId" in (select id from "OrderItem" where "orderId" = '${oid}')`);
    sql(`delete from "OrderItem" where "orderId" = '${oid}'`);
    sql(`delete from "Kot" where "orderId" = '${oid}'`);
    sql(`delete from "Order" where id = '${oid}'`);
    check(`order ${oid} and its ticket lines are gone`, sql(`select (select count(*) from "Order" where id = '${oid}') + (select count(*) from "KitchenItem" where "orderId" = '${oid}')`), 0);
  }
  for (const sid of stationIds) {
    sql(`delete from "KitchenRoute" where "stationId" = '${sid}'`);
    sql(`delete from "KitchenStation" where id = '${sid}'`);
  }
  check('every station this run created is gone', sql(`select count(*) from "KitchenStation" where name like 'KDS %${stamp}'`), 0);
  check('every route this run created is gone', sql(`select count(*) from "KitchenRoute" where "branchId" = '${branchId}'`), 0);
  check('no kitchen ticket rows survive the run', sql('select count(*) from "KitchenItem"'), 0);

  verdict('vcxo accept kds');
};

main().catch((e) => {
  console.error(`\nharness error: ${e.message}`);
  process.exit(2);
});
