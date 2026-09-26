// Phase 2 — transfer, split and merge on the DEPLOYED stack.
//
// This is the lane's own feature set, so it gets the strictest treatment. Every
// money assertion is in INTEGER PAISE (lib.mjs `paise`), because comparing the
// API's decimal strings as floats is exactly how a rounding error becomes a
// passing test.
//
// The three verbs are checked for the property each one exists to preserve:
//   transfer — the money and the covers must arrive unchanged at the new table
//   split    — the paise must be conserved across original + new cheque
//   merge    — the paise must be conserved, the emptied bill must reach the new
//              terminal MERGED status, and the freed table must actually free
//
// Every conservation check is PAIRED with a negative control, because "total
// before == total after" also passes if nothing moved at all.
import { api, check, note, summary, paise, rupees, loadJson } from './lib.mjs';

const tokens = loadJson('.tokens.json');
const MGR = tokens.BRANCH_MANAGER;
const CASHIER = tokens.CASHIER;
const OWNER = tokens.CUSTOMER_OWNER;
const ATC = tokens.POS_SUPER_ADMIN;

// --- make the phase re-runnable --------------------------------------------
// "Fix failures and repeat only necessary gates" is only possible if a gate can
// actually be repeated. A previous run leaves tables occupied, so every OPEN
// order is voided first — through the real route, not by writing rows.
{
  const open = (await api('/api/orders?status=OPEN', { token: MGR })).body?.orders ?? [];
  let voided = 0;
  for (const o of open) {
    const r = await api(`/api/orders/${o.id}/void`, {
      method: 'POST', token: MGR, body: { reason: 'verify harness reset between runs' },
    });
    if (r.status === 200) voided += 1;
  }
  if (open.length) note(`reset: voided ${voided}/${open.length} leftover OPEN orders from a previous run`);
}

// --- fixtures --------------------------------------------------------------
const tablesRes = await api('/api/tables', { token: MGR });
const products = (await api('/api/catalog/products', { token: MGR })).body.products;
const myBranch = tablesRes.body.tables[0].branchId;
const free = tablesRes.body.tables.filter((t) => t.branchId === myBranch && !t.currentOrder);
check('seed gave at least 4 free tables in the manager\'s branch (transfer+split+merge need 3+)',
  free.length >= 4, `free=${free.length}`);
check('seed gave at least 2 priced products', products.length >= 2, `products=${products.length}`);

const P1 = products.find((p) => Number(p.basePrice) > 0);
const P2 = products.find((p) => p.id !== P1.id && Number(p.basePrice) > 0);
note(`using ${P1.name} @ ${P1.basePrice} and ${P2.name} @ ${P2.basePrice}`);

const openOrder = async (tableId, items) => {
  const r = await api('/api/orders', {
    method: 'POST', token: CASHIER,
    body: { type: 'DINE_IN', tableId, items },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`open order failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.order ?? r.body;
};
const readOrder = async (id, token = CASHIER) => (await api(`/api/orders/${id}`, { token })).body?.order ?? null;
const totalPaise = (o) => paise(o.total);

// A VEXO operator must name the tenant it is acting on (auth.js:75) or the
// request is rejected 400 BEFORE any role gate runs. So every ATC refusal below
// carries ?companyId=, otherwise the 400 would masquerade as a passing refusal
// while proving nothing about the guard.
let COMPANY_ID = null;
const asAtc = (p) => `${p}${p.includes('?') ? '&' : '?'}companyId=${COMPANY_ID}`;
{
  const me = await api('/api/auth/me', { token: MGR });
  COMPANY_ID = me.body?.user?.companyId;
  check('resolved the tenant companyId for the ATC-refusal probes', !!COMPANY_ID, '');
}

// Frees every table by voiding open bills through the real route, so a
// permission probe later in the file still has fixtures to work with.
const freeAllTables = async (label) => {
  const open = (await api('/api/orders?status=OPEN', { token: MGR })).body?.orders ?? [];
  let n = 0;
  for (const o of open) {
    const r = await api(`/api/orders/${o.id}/void`, {
      method: 'POST', token: MGR, body: { reason: `verify harness: ${label}` },
    });
    if (r.status === 200) n += 1;
  }
  return n;
};

// ===========================================================================
// TRANSFER
// ===========================================================================
note('--- transfer ---');
{
  const from = free[0], to = free[1];
  const order = await openOrder(from.id, [{ productId: P1.id, qty: 2 }, { productId: P2.id, qty: 1 }]);
  const before = await readOrder(order.id);
  const beforePaise = totalPaise(before);

  // Put covers and a server on it, so the transfer has something to carry.
  const svc = await api(`/api/tables/${from.id}/service`, {
    method: 'POST', token: MGR, body: { pax: 3 },
  });
  check('service: set pax=3 on the source table → 200', svc.status === 200, svc.status === 200 ? '' : `got ${svc.status} ${JSON.stringify(svc.body).slice(0,120)}`);

  const t = await api(`/api/tables/${from.id}/transfer`, {
    method: 'POST', token: MGR, body: { toTableId: to.id },
  });
  check(`transfer ${from.name} → ${to.name} → 200`, t.status === 200,
    t.status === 200 ? '' : `got ${t.status} ${JSON.stringify(t.body).slice(0,160)}`);

  const after = await readOrder(order.id);
  // The detail response nests the table as `table`, and does NOT carry pax —
  // covers ride on the FLOOR list (tables.js:93), which is the screen that
  // needs them. Asserting `after.pax` was my error, not a missing field.
  check('transfer: the order now sits on the destination table',
    after?.table?.id === to.id, `table.id=${after?.table?.id} want=${to.id}`);
  check(`transfer: total unchanged to the paise (${rupees(beforePaise)})`,
    totalPaise(after) === beforePaise, `${totalPaise(after)} vs ${beforePaise}`);

  // Negative control. "Destination now holds the order" is only meaningful if
  // the source is genuinely empty — otherwise a copy would pass too.
  const fresh = (await api('/api/tables', { token: MGR })).body.tables;
  const src = fresh.find((x) => x.id === from.id);
  const dst = fresh.find((x) => x.id === to.id);
  // Covers live under currentOrder.service (publicService, service.js:156), not
  // flat on currentOrder. Second wrong path in this file, same root cause: I was
  // guessing field names instead of reading the serialiser.
  check('transfer: covers travelled with the party (pax still 3 on the floor list)',
    dst?.currentOrder?.service?.pax === 3, `pax=${dst?.currentOrder?.service?.pax}`);
  check('control: the source table is now FREE (a copy would leave it occupied)',
    !src.currentOrder, `source currentOrder=${JSON.stringify(src.currentOrder)?.slice(0,60)}`);
  check('control: the destination table now reads occupied',
    !!dst.currentOrder, `dest currentOrder=${JSON.stringify(dst.currentOrder)?.slice(0,60)}`);

  // Refusal: transferring onto a table that already has a bill must not merge
  // silently. That is what /merge is for, and conflating them would lose money.
  const other = free[2];
  await openOrder(other.id, [{ productId: P1.id, qty: 1 }]);
  const clash = await api(`/api/tables/${to.id}/transfer`, {
    method: 'POST', token: MGR, body: { toTableId: other.id },
  });
  check('transfer onto an OCCUPIED table is refused (that is merge\'s job, not transfer\'s)',
    clash.status >= 400 && clash.status < 500, `got ${clash.status}`);

  // A CASHIER *may* transfer, deliberately: permissions.js:266 says "a cashier
  // gets all three floor actions". A first draft of this file asserted 403 and
  // was wrong about the policy — recorded rather than quietly flipped, because
  // the interesting question is who is refused, and that is the ATC operator.
  const cash = await api(`/api/tables/${to.id}/transfer`, {
    method: 'POST', token: CASHIER, body: { toTableId: free[3].id },
  });
  check('CASHIER CAN transfer — a cashier works the floor (permissions.js:266)',
    cash.status === 200, `got ${cash.status}`);

  // The refusal that matters: ATC/VEXO operators are read-only in this router
  // (tables.js:46, "the platform role is NOT" in the list), even though
  // ROLE_ACTIONS hands POS_SUPER_ADMIN every action key.
  const atcMove = await api(asAtc(`/api/tables/${free[3].id}/transfer`), {
    method: 'POST', token: ATC, body: { toTableId: to.id },
  });
  check('POS_SUPER_ADMIN (ATC operator) cannot move a tenant\'s party → 403',
    atcMove.status === 403, `got ${atcMove.status} ${JSON.stringify(atcMove.body).slice(0,110)}`);
}

// ===========================================================================
// SPLIT
// ===========================================================================
note('--- split ---');
{
  const tbl = (await api('/api/tables', { token: MGR })).body.tables
    .find((t) => t.branchId === myBranch && !t.currentOrder);
  const order = await openOrder(tbl.id, [
    { productId: P1.id, qty: 2 },
    { productId: P2.id, qty: 3 },
  ]);
  const before = await readOrder(order.id);
  const beforePaise = totalPaise(before);
  const lines = before.items ?? [];
  check('split fixture: the order has 2 lines to divide', lines.length === 2, `lines=${lines.length}`);

  const moved = lines[1];
  const s = await api(`/api/orders/${order.id}/split`, {
    method: 'POST', token: MGR, body: { itemIds: [moved.id] },
  });
  check('split one line onto a second cheque → 200/201',
    s.status === 200 || s.status === 201,
    s.status < 300 ? '' : `got ${s.status} ${JSON.stringify(s.body).slice(0,200)}`);

  const chequeId = s.body?.cheque?.id ?? s.body?.order?.id ?? s.body?.newOrderId ?? s.body?.id;
  check('split: the response names the new cheque', !!chequeId, JSON.stringify(s.body).slice(0, 160));

  if (chequeId) {
    const a = await readOrder(order.id);
    const b = await readOrder(chequeId);
    const sum = totalPaise(a) + totalPaise(b);
    check(`split: paise CONSERVED — ${rupees(totalPaise(a))} + ${rupees(totalPaise(b))} = ${rupees(beforePaise)}`,
      sum === beforePaise, `${sum} vs ${beforePaise}`);
    // The original keeping its id is the design decision that keeps payments,
    // KOT references and audit rows resolving after a split.
    check('split: the original order KEEPS its id (so prior payments/KOTs still resolve)',
      a.id === order.id, `${a.id} vs ${order.id}`);
    check('split: the new cheque is a different order', b.id !== order.id, '');

    // The paired negative control. Conservation alone would also hold if the
    // line never moved, so assert the line actually left.
    const stillOnA = (a.items ?? []).some((i) => i.id === moved.id);
    const nowOnB = (b.items ?? []).some((i) => i.id === moved.id);
    // check() prints the detail on PASS as well as FAIL, so a detail phrased as
    // the failure makes a green line read red. Pass '' when the claim holds.
    check('control: the split line LEFT the original (else conservation is vacuous)',
      !stillOnA, stillOnA ? 'line still on the original' : '');
    check('control: ...and ARRIVED on the new cheque', nowOnB, nowOnB ? '' : 'line is on neither order');
    check('control: both cheques are non-zero (a 0 + full split proves nothing)',
      totalPaise(a) > 0 && totalPaise(b) > 0,
      `a=${totalPaise(a)} b=${totalPaise(b)}`);

    // ATC operators are read-only on a customer's money. This needs its OWN
    // two-line order: attempting it on the post-split original (one line left)
    // returns 400 from assertSplittable BEFORE the role gate is reached, so the
    // first draft's 400 proved nothing about the guard either way.
    const t2 = (await api('/api/tables', { token: MGR })).body.tables
      .find((x) => x.branchId === myBranch && !x.currentOrder);
    const victim = await openOrder(t2.id, [{ productId: P1.id, qty: 1 }, { productId: P2.id, qty: 1 }]);
    const vLines = (await readOrder(victim.id)).items;
    const atc = await api(asAtc(`/api/orders/${victim.id}/split`), {
      method: 'POST', token: ATC, body: { itemIds: [vLines[0].id] },
    });
    check('POS_SUPER_ADMIN (ATC operator) cannot split a tenant\'s bill → 403',
      atc.status === 403, `got ${atc.status} ${JSON.stringify(atc.body).slice(0,120)}`);
    // Control: the same body from a permitted role succeeds, so the 403 is the
    // role list and not a malformed request.
    const okSplit = await api(`/api/orders/${victim.id}/split`, {
      method: 'POST', token: CASHIER, body: { itemIds: [vLines[0].id] },
    });
    check('control: the SAME body from a CASHIER succeeds, so the 403 was the role and not the body',
      okSplit.status === 200 || okSplit.status === 201, `got ${okSplit.status}`);
  }
}

// ===========================================================================
// MERGE  — the verb that needed the MERGED enum value
// ===========================================================================
note('--- merge ---');
{
  // The branch has 6 tables and the transfer + split blocks above leave five of
  // them occupied, so on a clean end-to-end run this block used to find ONE free
  // table, fail its own fixture check, and then crash on `dst.id` being
  // undefined. The fixture was starved by its predecessors; nothing about merge
  // was wrong. Free the floor first — same reset the permission probes below
  // already do, and for the same reason.
  note(`merge fixture: freed ${await freeAllTables('free tables for the merge fixture')} bills first`);
  const fresh = (await api('/api/tables', { token: MGR })).body.tables
    .filter((t) => t.branchId === myBranch && !t.currentOrder);
  check('merge fixture: 2 free tables available', fresh.length >= 2, `free=${fresh.length}`);
  const src = fresh[0], dst = fresh[1];

  const sOrder = await openOrder(src.id, [{ productId: P1.id, qty: 1 }]);
  const dOrder = await openOrder(dst.id, [{ productId: P2.id, qty: 2 }]);
  const sBefore = totalPaise(await readOrder(sOrder.id));
  const dBefore = totalPaise(await readOrder(dOrder.id));
  note(`merge fixture: source ${rupees(sBefore)} + destination ${rupees(dBefore)} = ${rupees(sBefore + dBefore)}`);

  // Refusal first: merging a table into itself is a no-op that must not be
  // answered 200, or a mis-tap silently "succeeds".
  const self = await api(`/api/tables/${src.id}/merge`, {
    method: 'POST', token: MGR, body: { toTableId: src.id },
  });
  check('merging a table into ITSELF is refused', self.status >= 400 && self.status < 500, `got ${self.status}`);

  const m = await api(`/api/tables/${src.id}/merge`, {
    method: 'POST', token: MGR, body: { toTableId: dst.id },
  });
  check(`merge ${src.name} → ${dst.name} → 200`, m.status === 200,
    m.status === 200 ? '' : `got ${m.status} ${JSON.stringify(m.body).slice(0,200)}`);

  const sAfter = await readOrder(sOrder.id);
  const dAfter = await readOrder(dOrder.id);

  check(`merge: paise CONSERVED — ${rupees(sBefore)} + ${rupees(dBefore)} → ${rupees(totalPaise(dAfter))}`,
    totalPaise(dAfter) === sBefore + dBefore,
    `${totalPaise(dAfter)} vs ${sBefore + dBefore}`);

  // THE POINT OF THE WHOLE MIGRATION. The emptied bill needs a terminal status
  // that is not VOID (a merged bill was not voided — its money was collected on
  // the other cheque) and not PAID (nothing was tendered against it).
  check('merge: the emptied source bill is MERGED (the new terminal status)',
    sAfter?.status === 'MERGED', `status=${sAfter?.status}`);
  check('merge: the surviving bill is still OPEN', dAfter?.status === 'OPEN', `status=${dAfter?.status}`);

  // Paired control: conservation plus "source is MERGED" would still hold if
  // the items had been duplicated rather than moved.
  check('control: the merged-away bill now carries ZERO money (items moved, not copied)',
    totalPaise(sAfter) === 0, `source total=${sAfter?.total}`);
  check('control: the merged-away bill has no remaining items',
    (sAfter?.items ?? []).length === 0, `items=${(sAfter?.items ?? []).length}`);

  const after = (await api('/api/tables', { token: MGR })).body.tables;
  check('control: the source table is FREE after the merge',
    !after.find((t) => t.id === src.id)?.currentOrder, '');
  check('control: the destination table is still occupied',
    !!after.find((t) => t.id === dst.id)?.currentOrder, '');

  // A MERGED bill is terminal: it must not accept new items.
  const poke = await api(`/api/orders/${sOrder.id}/items`, {
    method: 'POST', token: CASHIER, body: { productId: P1.id, qty: 1 },
  });
  check('a MERGED bill is terminal — adding an item is refused',
    poke.status >= 400 && poke.status < 500, `got ${poke.status}`);

  // And it must not be billable or payable.
  const bill = await api(`/api/orders/${sOrder.id}/bill`, { method: 'POST', token: CASHIER, body: {} });
  check('a MERGED bill cannot be issued as a bill', bill.status >= 400 && bill.status < 500, `got ${bill.status}`);

  // Merge is gated by canTransfer, the SAME action as transfer (tables.js:519),
  // which is why the action reads "Move or merge a party between tables". So a
  // CASHIER can merge too. A first draft asserted 403 and pointed it at the
  // now-free source table, which returned 409 for having no open bill — the
  // permission gate was never reached. Both errors were mine.
  // This branch only has 6 tables and the phase has used them all, so free them
  // before the permission probes rather than reading undefined off the list.
  note(`permission probes: freed ${await freeAllTables('free tables for the merge permission probes')} bills first`);
  const freeNow = (await api('/api/tables', { token: MGR })).body.tables
    .filter((t) => t.branchId === myBranch && !t.currentOrder);
  check('merge permission probe: 3 free tables available', freeNow.length >= 3, `free=${freeNow.length}`);
  const [c1, c2, c3] = freeNow;
  await openOrder(c1.id, [{ productId: P1.id, qty: 1 }]);
  await openOrder(c2.id, [{ productId: P2.id, qty: 1 }]);
  await openOrder(c3.id, [{ productId: P1.id, qty: 1 }]);

  const cashMerge = await api(`/api/tables/${c1.id}/merge`, {
    method: 'POST', token: CASHIER, body: { toTableId: c2.id },
  });
  check('CASHIER CAN merge — merge shares table.transfer with transfer (tables.js:519)',
    cashMerge.status === 200, `got ${cashMerge.status} ${JSON.stringify(cashMerge.body).slice(0,120)}`);

  // And the ATC operator is refused here too, on a table that genuinely has an
  // open bill so the role gate is the thing being tested, not a 409.
  const atcMerge = await api(asAtc(`/api/tables/${c2.id}/merge`), {
    method: 'POST', token: ATC, body: { toTableId: c3.id },
  });
  check('POS_SUPER_ADMIN (ATC operator) cannot merge a tenant\'s bills → 403',
    atcMerge.status === 403, `got ${atcMerge.status} ${JSON.stringify(atcMerge.body).slice(0,110)}`);
}

// ===========================================================================
// The MERGED value as the DEPLOYED DATABASE sees it
// ===========================================================================
note('--- MERGED is real in this deployment, not just in the response body ---');
{
  // A status string in JSON could come from application code alone. This asks
  // the orders list to filter on it, which pushes the value into a real SQL
  // enum comparison against the migrated column.
  const r = await api('/api/orders?status=MERGED', { token: MGR });
  check('GET /api/orders?status=MERGED → 200 (the enum value survives a real SQL filter)',
    r.status === 200, `got ${r.status} ${JSON.stringify(r.body).slice(0,140)}`);
  const list = r.body?.orders ?? [];
  check('  ...and it returns the merged-away bill', list.length >= 1 && list.every((o) => o.status === 'MERGED'),
    `n=${list.length}`);
}

process.exit(summary('Phase 2 — transfer, split, merge') ? 1 : 0);
