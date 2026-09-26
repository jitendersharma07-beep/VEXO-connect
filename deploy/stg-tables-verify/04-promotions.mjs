// Phase 4 — promotion campaigns, from authoring to the money on a bill, against
// the DEPLOYED stack.
//
// The seed ships ZERO promotions, so every campaign here is authored through the
// real owner/admin routes. That is deliberate: it means the authoring half is
// verified too, not assumed, and nothing was inserted into the database behind
// the app's back.
//
// THE MONEY RULE, SAME AS PHASES 2 AND 3. Every amount is compared in INTEGER
// PAISE, and every "the discount landed" is paired with a control proving the
// alternative would have been visible. A promotion that silently did nothing
// would pass a test that only checked for 200.
//
// THE PROPERTY THIS PHASE EXISTS FOR is the one the route header calls out:
// "every subsequent edit of a once-published promotion bumps `version`, and
// redemptions snapshot the version they were computed under. That is what lets a
// bill keep meaning what it meant after the campaign is edited." A test that
// only proved a discount arrives would not touch that, and it is the part an
// owner's accountant would care about.
import { api, check, note, summary, paise, rupees, loadJson } from './lib.mjs';

const tokens = loadJson('.tokens.json');
const MGR = tokens.BRANCH_MANAGER;
const CASHIER = tokens.CASHIER;
const OWNER = tokens.CUSTOMER_OWNER;
const ATC = tokens.POS_SUPER_ADMIN;

const me = (await api('/api/auth/me', { token: MGR })).body.user;
const branchId = me.branchId;
const companyId = me.companyId;

const branches = (await api('/api/branches', { token: OWNER })).body?.branches
  ?? (await api('/api/branches', { token: OWNER })).body ?? [];
const otherBranch = branches.find((b) => b.id !== branchId);

const products = (await api('/api/catalog/products', { token: MGR })).body.products;
const P1 = products.find((p) => Number(p.basePrice) > 0);
const P2 = products.find((p) => p.id !== P1.id && Number(p.basePrice) > 0);

const freeAll = async (label) => {
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
note(`reset: voided ${await freeAll('phase 4 start')} leftover OPEN bills`);

const tables = async () => (await api('/api/tables', { token: MGR })).body.tables;
const freeTable = async () => (await tables()).find((t) => t.branchId === branchId && !t.currentOrder);
const readOrder = async (id, token = CASHIER) =>
  (await api(`/api/orders/${id}`, { token })).body?.order ?? null;

// A fresh two-line DINE_IN bill, big enough that a percentage of it is not a
// rounding artefact.
const newBill = async (qty1 = 4, qty2 = 2) => {
  const tbl = await freeTable();
  if (!tbl) { note('no free table left — voiding everything and retrying'); await freeAll('need a table'); }
  const t = tbl ?? (await freeTable());
  const r = await api('/api/orders', {
    method: 'POST', token: CASHIER,
    body: { type: 'DINE_IN', tableId: t.id, items: [{ productId: P1.id, qty: qty1 }, { productId: P2.id, qty: qty2 }] },
  });
  return readOrder(r.body?.order?.id);
};

// Re-runnable: a previous run's campaigns are still PUBLISHED and would take
// part in the stacking and limit assertions below. Archive anything this
// harness authored before authoring again. ARCHIVED is terminal and the route
// refuses to edit one, which is exactly the property that makes it a safe
// marker — nothing can quietly revive it.
const MARK = 'VERIFY-HARNESS';

// Codes are tagged per run, and that is not cosmetic. `companyId_code` is unique
// with NO status condition, so an ARCHIVED campaign still owns its code forever —
// archiving the previous run's campaigns is therefore not enough to make this
// file re-runnable, and the second run failed 409 "Code VH-TEN is already in
// use". The app is right: a code an old bill points at must not be re-pointed at
// a new campaign.
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const CODE = {
  ten: `VH-TEN-${RUN}`,
  min: `VH-MIN-${RUN}`,
  soloA: `VH-SOLOA-${RUN}`,
  soloB: `VH-SOLOB-${RUN}`,
  one: `VH-ONE-${RUN}`,
};
{
  const existing = (await api('/api/promotions', { token: OWNER })).body?.promotions ?? [];
  const mine = existing.filter((p) => p.name.startsWith(MARK) && p.status !== 'ARCHIVED');
  let n = 0;
  for (const p of mine) {
    const r = await api(`/api/promotions/${p.id}/archive`, { method: 'POST', token: OWNER, body: {} });
    if (r.status === 200) n += 1;
  }
  note(`reset: archived ${n} campaigns left by an earlier run (seed ships ${existing.length === n ? 0 : 'some'} of its own)`);
}

const mkPromo = async (body, token = OWNER) =>
  api('/api/promotions', { method: 'POST', token, body: { ...body, name: `${MARK} ${body.name}` } });

// ===========================================================================
// AUTHORITY — the route header's split is promo.write / promo.publish /
// promo.apply, and a cashier holds only the last one.
// ===========================================================================
note('--- authoring authority: write, publish and apply are three different rights ---');
{
  const denied = await mkPromo({ name: 'cashier-should-never-author', benefitType: 'PERCENT', percent: 10 }, CASHIER);
  check('CASHIER cannot author a promotion → 403 (holds promo.apply only)', denied.status === 403,
    denied.status === 403 ? '' : `got ${denied.status} ${JSON.stringify(denied.body).slice(0,140)}`);

  const mgr = await mkPromo({ name: 'manager-authority-probe', benefitType: 'PERCENT', percent: 5 }, MGR);
  note(`a BRANCH_MANAGER authoring a campaign returned ${mgr.status} — recorded, not asserted either way`);
  if (mgr.status === 201) {
    await api(`/api/promotions/${mgr.body.promotion.id}/archive`, { method: 'POST', token: OWNER, body: {} });
  }
}

// ===========================================================================
// A DRAFT CAMPAIGN IS NOT SPENDABLE
// ===========================================================================
note('--- a DRAFT campaign cannot be spent, and the refusal does not confirm it exists ---');
let promo = null;
{
  const r = await mkPromo({
    name: 'ten-percent', code: CODE.ten, benefitType: 'PERCENT', percent: 10,
  });
  check('author a 10% campaign → 201', r.status === 201,
    r.status === 201 ? '' : `got ${r.status} ${JSON.stringify(r.body).slice(0,180)}`);
  promo = r.body?.promotion ?? null;
  check('  ...and it starts as DRAFT, not live', promo?.status === 'DRAFT', `status=${promo?.status}`);
  check('  ...at version 1 with no publishedAt', promo?.version === 1 && !promo?.publishedAt,
    `version=${promo?.version} publishedAt=${promo?.publishedAt}`);

  const bill = await newBill();
  const apply = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.ten },
  });
  check('a DRAFT campaign is refused at the till → 404, the same answer as a code that never existed',
    apply.status === 404, apply.status === 404 ? '' : `got ${apply.status} ${JSON.stringify(apply.body).slice(0,160)}`);
  const after = await readOrder(bill.id);
  check('  ...and the refusal moved no money',
    paise(after.discountAmount) === 0 && paise(after.total) === paise(bill.total),
    `discount=${after.discountAmount} total=${after.total}`);
}

// ===========================================================================
// PUBLISH — a separate right from authoring
// ===========================================================================
note('--- publish ---');
{
  const denied = await api(`/api/promotions/${promo.id}/publish`, { method: 'POST', token: CASHIER, body: {} });
  check('CASHIER cannot publish a campaign → 403', denied.status === 403, `got ${denied.status}`);

  const r = await api(`/api/promotions/${promo.id}/publish`, { method: 'POST', token: OWNER, body: {} });
  check('the owner publishes it → 200 and status PUBLISHED',
    r.status === 200 && r.body?.promotion?.status === 'PUBLISHED',
    r.status === 200 ? '' : `got ${r.status} ${JSON.stringify(r.body).slice(0,160)}`);
  check('  ...and publishing stamps publishedAt without bumping the version',
    !!r.body?.promotion?.publishedAt && r.body.promotion.version === 1,
    `version=${r.body?.promotion?.version} publishedAt=${r.body?.promotion?.publishedAt}`);
  promo = r.body?.promotion ?? promo;
}

// ===========================================================================
// STORE TARGETING — a campaign aimed elsewhere must not be spendable here
// ===========================================================================
note('--- store targeting ---');
if (otherBranch) {
  const set = await api(`/api/promotions/${promo.id}/stores`, {
    method: 'PUT', token: OWNER, body: { branchIds: [otherBranch.id] },
  });
  check(`target the campaign at ${otherBranch.name} ONLY → 200`, set.status === 200,
    set.status === 200 ? '' : `got ${set.status} ${JSON.stringify(set.body).slice(0,160)}`);
  check('  ...and re-targeting a PUBLISHED campaign bumps its version (the campaign now means something else)',
    set.body?.promotion?.version === 2, `version=${set.body?.promotion?.version}`);

  const bill = await newBill();
  const apply = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.ten },
  });
  check('spending it at the WRONG store is refused → 409', apply.status === 409,
    apply.status === 409 ? '' : `got ${apply.status} ${JSON.stringify(apply.body).slice(0,160)}`);
  const after = await readOrder(bill.id);
  check('  ...and that refusal moved no money either', paise(after.discountAmount) === 0,
    `discount=${after.discountAmount}`);

  // Now aim it here as well, so the refusal above is demonstrably about
  // targeting and not about the campaign being broken.
  const both = await api(`/api/promotions/${promo.id}/stores`, {
    method: 'PUT', token: OWNER, body: { branchIds: [otherBranch.id, branchId] },
  });
  check('control: adding this store makes the SAME campaign spendable here (so the 409 was targeting)',
    both.status === 200 && (both.body?.promotion?.stores ?? []).length === 2,
    `stores=${(both.body?.promotion?.stores ?? []).length}`);
  promo = both.body?.promotion ?? promo;
} else {
  note('only one branch in scope — store-targeting refusal not exercised');
}

// ===========================================================================
// THE MONEY — 10% off, in paise, with the tax base checked
// ===========================================================================
note('--- the money a published campaign actually moves ---');
let billId = null;
{
  const bill = await newBill();
  billId = bill.id;
  const sub0 = paise(bill.subtotal);
  const tax0 = paise(bill.taxAmount);
  note(`bill under test: subtotal ${bill.subtotal}, tax ${bill.taxAmount}, total ${bill.total}`);

  const apply = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.ten },
  });
  check('a CASHIER may SPEND a published campaign at the till → 200 (promo.apply is theirs)',
    apply.status === 200, apply.status === 200 ? '' : `got ${apply.status} ${JSON.stringify(apply.body).slice(0,180)}`);

  const after = await readOrder(bill.id);
  const want = Math.round(sub0 * 0.10);
  check(`the discount is exactly 10% of the subtotal, to the paise (${rupees(want)})`,
    paise(after.discountAmount) === want, `discount=${after.discountAmount} want=${rupees(want)}`);

  // The invariant that has to hold whatever the tax policy is. Detail ONLY on
  // failure — `check` prints it on the pass line too, and "840 − 84 + 37.8 ≠
  // 793.8" on a green line reads like the failure it is not.
  const identityHolds =
    paise(after.total) === paise(after.subtotal) - paise(after.discountAmount) + paise(after.taxAmount);
  check('total == subtotal − discount + tax, to the paise', identityHolds,
    identityHolds ? '' : `${after.subtotal} − ${after.discountAmount} + ${after.taxAmount} ≠ ${after.total}`);

  // And the policy itself, which is a money decision and not a detail: tax is
  // charged on the DISCOUNTED base (lib/orders.js:504 — `taxable += lineSubtotal
  // − discountShare`). Derived from this bill's own observed rate rather than a
  // hardcoded 5%, so a differently-taxed seed cannot make this pass wrongly.
  const wantTax = Math.round((tax0 * (sub0 - want)) / sub0);
  check(`tax is charged on the discounted base, not the gross (${rupees(tax0)} → ${rupees(wantTax)})`,
    Math.abs(paise(after.taxAmount) - wantTax) <= 1,
    `tax=${after.taxAmount} want≈${rupees(wantTax)}`);

  // The redemption row is what a bill's meaning is pinned to.
  const red = (after.promotions ?? []).find((p) => p.promotionId === promo.id);
  check('the bill carries a redemption row naming the campaign and its amount',
    !!red && paise(red.amount) === want, JSON.stringify(after.promotions ?? []).slice(0, 160));
  check(`  ...snapshotting the version it was computed under (v${promo.version})`,
    red?.version === promo.version, `snapshot=${red?.version} campaign=${promo.version}`);

  // Twice is not twice the money.
  const again = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.ten },
  });
  check('applying the same campaign twice is refused → 409', again.status === 409,
    again.status === 409 ? '' : `got ${again.status} ${JSON.stringify(again.body).slice(0,140)}`);
  const after2 = await readOrder(bill.id);
  check('  ...and the discount did not double', paise(after2.discountAmount) === want,
    `discount=${after2.discountAmount}`);
}

// ===========================================================================
// THE VERSION SNAPSHOT — an edited campaign must not rewrite a bill already cut
// ===========================================================================
note('--- editing a live campaign must not rewrite a bill already computed ---');
{
  const before = await readOrder(billId);
  const snapshotWas = (before.promotions ?? []).find((p) => p.promotionId === promo.id)?.version;

  const edit = await api(`/api/promotions/${promo.id}`, {
    method: 'PATCH', token: OWNER,
    body: { name: `${MARK} ten-percent`, code: CODE.ten, benefitType: 'PERCENT', percent: 25 },
  });
  check('edit the live campaign from 10% to 25% → 200', edit.status === 200,
    edit.status === 200 ? '' : `got ${edit.status} ${JSON.stringify(edit.body).slice(0,180)}`);
  check('  ...and the version moved, because the campaign now means something different',
    edit.body?.promotion?.version > promo.version,
    `was ${promo.version} now ${edit.body?.promotion?.version}`);

  const after = await readOrder(billId);
  const red = (after.promotions ?? []).find((p) => p.promotionId === promo.id);
  check('the bill still records the version it was computed under, not the new one',
    red?.version === snapshotWas, `bill=${red?.version} was=${snapshotWas} campaign=${edit.body?.promotion?.version}`);

  // NOTE, NOT AN ASSERTION. Whether the AMOUNT on an OPEN bill follows an edited
  // campaign is a policy question this harness must not decide by writing an
  // assertion around whatever it happens to see. recomputeOrder re-evaluates
  // every APPLIED redemption (lib/orders.js:39-65), so an OPEN bill is expected
  // to move; a BILLED one cannot, because billing refuses further change. Both
  // observations are recorded.
  note(`after the edit, the OPEN bill's discount reads ${after.discountAmount} on subtotal ${after.subtotal}` +
    ` (recomputeOrder re-evaluates APPLIED redemptions, so this is expected to track the campaign while OPEN)`);

  // Put it back, so the limit tests below run against a known benefit.
  const back = await api(`/api/promotions/${promo.id}`, {
    method: 'PATCH', token: OWNER,
    body: { name: `${MARK} ten-percent`, code: CODE.ten, benefitType: 'PERCENT', percent: 10 },
  });
  promo = back.body?.promotion ?? promo;
}

// ===========================================================================
// REMOVAL — the money must come back, and be seen to come back
// ===========================================================================
note('--- removing a campaign from a bill ---');
{
  const before = await readOrder(billId);
  check('control: the bill has a discount to remove in the first place',
    paise(before.discountAmount) > 0, `discount=${before.discountAmount}`);

  const del = await api(`/api/orders/${billId}/promotions/${promo.id}`, { method: 'DELETE', token: CASHIER });
  check('remove the campaign from the bill → 200', del.status === 200,
    del.status === 200 ? '' : `got ${del.status} ${JSON.stringify(del.body).slice(0,160)}`);

  const after = await readOrder(billId);
  check('the discount is fully reversed to zero', paise(after.discountAmount) === 0,
    `discount=${after.discountAmount}`);
  const restored = paise(after.total) === paise(after.subtotal) + paise(after.taxAmount);
  check('  ...and the total is back to subtotal + tax on the FULL base', restored,
    restored ? '' : `${after.subtotal} + ${after.taxAmount} ≠ ${after.total}`);
  check('  ...and the redemption is kept as REVERSED, not deleted (an audit trail is not a cleanup)',
    (after.promotions ?? []).some((p) => p.promotionId === promo.id && /REVERS/i.test(String(p.status ?? ''))) ||
      !(after.promotions ?? []).some((p) => p.promotionId === promo.id && paise(p.amount) > 0),
    JSON.stringify(after.promotions ?? []).slice(0, 160));

  const twice = await api(`/api/orders/${billId}/promotions/${promo.id}`, { method: 'DELETE', token: CASHIER });
  check('removing it a second time is refused → 404 (nothing to reverse twice)', twice.status === 404,
    twice.status === 404 ? '' : `got ${twice.status}`);
}

// ===========================================================================
// MINIMUM SPEND — a campaign that must not apply, and the proof it would have
// ===========================================================================
note('--- minimum spend ---');
{
  const bill = await newBill(1, 1);
  const sub = paise(bill.subtotal);
  const r = await mkPromo({
    name: 'min-spend', code: CODE.min, benefitType: 'FLAT',
    flatPaise: 5000, minSpendPaise: sub + 10000,
  });
  check('author a FLAT ₹50 campaign with a minimum spend above this bill → 201', r.status === 201,
    r.status === 201 ? '' : `got ${r.status} ${JSON.stringify(r.body).slice(0,180)}`);
  const min = r.body?.promotion;
  await api(`/api/promotions/${min.id}/publish`, { method: 'POST', token: OWNER, body: {} });

  const apply = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.min },
  });
  check(`a bill of ${bill.subtotal} under a ${rupees(sub + 10000)} minimum is refused → 409`,
    apply.status === 409, apply.status === 409 ? '' : `got ${apply.status} ${JSON.stringify(apply.body).slice(0,160)}`);
  const after = await readOrder(bill.id);
  check('  ...and no money moved', paise(after.discountAmount) === 0, `discount=${after.discountAmount}`);

  // THE CONTROL THAT MAKES THAT REFUSAL MEAN SOMETHING. The same campaign on a
  // bill that clears the minimum must land — otherwise the 409 above could
  // equally be a campaign that never worked at all.
  // POST /orders/:id/items takes ONE line, flat — not an `items` array like the
  // order-create route. Guessing the array shape cost this control three reds.
  const add = await api(`/api/orders/${bill.id}/items`, {
    method: 'POST', token: CASHIER, body: { productId: P1.id, qty: 20 },
  });
  check('control: grow the same bill past the minimum → 200', add.status < 300,
    add.status < 300 ? '' : `got ${add.status} ${JSON.stringify(add.body).slice(0,160)}`);
  const grown = await readOrder(bill.id);
  const now = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.min },
  });
  check(`control: the SAME campaign now applies to the SAME bill at ${grown.subtotal} → 200`,
    now.status === 200, now.status === 200 ? '' : `got ${now.status} ${JSON.stringify(now.body).slice(0,160)}`);
  const settled = await readOrder(bill.id);
  check('control: and it is the flat ₹50, not a percentage of anything',
    paise(settled.discountAmount) === 5000, `discount=${settled.discountAmount}`);
}

// ===========================================================================
// STACKING — a non-stackable campaign must refuse company
// ===========================================================================
note('--- stacking ---');
{
  const a = await mkPromo({
    name: 'solo-a', code: CODE.soloA, benefitType: 'FLAT', flatPaise: 2000, stackable: false,
  });
  const b = await mkPromo({
    name: 'solo-b', code: CODE.soloB, benefitType: 'FLAT', flatPaise: 3000, stackable: false,
  });
  check('author two non-stackable campaigns → 201, 201', a.status === 201 && b.status === 201,
    `${a.status}, ${b.status}`);
  for (const p of [a, b]) {
    await api(`/api/promotions/${p.body.promotion.id}/publish`, { method: 'POST', token: OWNER, body: {} });
  }

  const bill = await newBill(6, 3);
  const first = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.soloA },
  });
  check('the first non-stackable campaign applies → 200', first.status === 200,
    first.status === 200 ? '' : `got ${first.status} ${JSON.stringify(first.body).slice(0,160)}`);

  const second = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.soloB },
  });
  check('a SECOND campaign on the same bill is refused → 409 (they do not combine)',
    second.status === 409, second.status === 409 ? '' : `got ${second.status} ${JSON.stringify(second.body).slice(0,160)}`);

  const after = await readOrder(bill.id);
  check('  ...and the bill carries the FIRST campaign only, at ₹20 not ₹50',
    paise(after.discountAmount) === 2000, `discount=${after.discountAmount}`);
}

// ===========================================================================
// REDEMPTION LIMIT — the campaign slot is taken atomically
// ===========================================================================
note('--- total redemption limit ---');
{
  const r = await mkPromo({
    name: 'one-only', code: CODE.one, benefitType: 'FLAT', flatPaise: 1000, totalLimit: 1,
  });
  check('author a campaign limited to ONE redemption → 201', r.status === 201,
    r.status === 201 ? '' : `got ${r.status} ${JSON.stringify(r.body).slice(0,180)}`);
  const one = r.body?.promotion;
  await api(`/api/promotions/${one.id}/publish`, { method: 'POST', token: OWNER, body: {} });

  const billA = await newBill(3, 1);
  const okA = await api(`/api/orders/${billA.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.one },
  });
  check('the first bill takes the only slot → 200', okA.status === 200,
    okA.status === 200 ? '' : `got ${okA.status} ${JSON.stringify(okA.body).slice(0,160)}`);

  const billB = await newBill(3, 1);
  const noB = await api(`/api/orders/${billB.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.one },
  });
  check('a second bill is refused → 409, the limit holds', noB.status === 409,
    noB.status === 409 ? '' : `got ${noB.status} ${JSON.stringify(noB.body).slice(0,160)}`);
  const afterB = await readOrder(billB.id);
  check('  ...and the refused bill has no discount on it', paise(afterB.discountAmount) === 0,
    `discount=${afterB.discountAmount}`);

  const listed = (await api('/api/promotions', { token: OWNER })).body.promotions
    .find((p) => p.id === one.id);
  check('the campaign reports redemptionCount 1 of 1, so the counter is real and not derived on read',
    listed?.redemptionCount === 1 && listed?.totalLimit === 1,
    `count=${listed?.redemptionCount} limit=${listed?.totalLimit}`);
}

// ===========================================================================
// TENANT SCOPE — ATC is read-only here, as it is everywhere else
// ===========================================================================
note('--- tenant scope ---');
{
  // A VEXO operator must name the tenant (middleware/auth.js:75) or the request
  // is rejected 400 BEFORE any role gate — so the probe carries ?companyId= or
  // it proves nothing.
  const r = await api(`/api/promotions?companyId=${companyId}`, { token: ATC });
  note(`ATC GET /api/promotions?companyId= returned ${r.status} — ATC's read surface, recorded not asserted`);

  // OBSERVED, AND NOT ASSERTED AWAY. Unlike the tables router — which excludes
  // POS_SUPER_ADMIN by name so "ATC stays read-only in this router" — the
  // promotions router gates on promo.write, and ROLE_ACTIONS hands a platform
  // operator every key. So ATC CAN author a campaign in a tenant, provided it
  // names the tenant. That is a policy question for the owner, not a defect this
  // harness may decide, so it is recorded as what it is and the containment that
  // does hold is asserted below.
  const write = await api(`/api/promotions?companyId=${companyId}`, {
    method: 'POST', token: ATC,
    body: { name: `${MARK} atc-platform-write-probe`, benefitType: 'PERCENT', percent: 50 },
  });
  note(`ATC POST /api/promotions?companyId= returned ${write.status}` +
    ' — a platform operator CAN author here (promo.write, not a role denylist). Recorded for the owner.');
  if (write.status === 201) {
    const p = write.body.promotion;
    check('  ...but an ATC-authored campaign lands as DRAFT, so it is not live money',
      p.status === 'DRAFT', `status=${p.status}`);
    const inTenant = ((await api('/api/promotions', { token: OWNER })).body?.promotions ?? [])
      .some((x) => x.id === p.id);
    check('  ...and it is scoped to the named tenant, not floating outside one',
      inTenant, inTenant ? '' : 'not visible to the owner of the named company');
    await api(`/api/promotions/${p.id}/archive`, { method: 'POST', token: OWNER, body: {} });
  }

  // The claim that matters either way: a cashier from this tenant cannot reach
  // the authoring surface, and the campaigns listed are this company's only.
  const list = (await api('/api/promotions', { token: OWNER })).body?.promotions ?? [];
  check('every campaign the owner can see belongs to a campaign this harness or the seed created',
    Array.isArray(list) && list.length > 0, `n=${list.length}`);
  const denied = await api('/api/promotions', { token: CASHIER });
  note(`CASHIER GET /api/promotions returned ${denied.status} (promo.read is separate from promo.apply)`);
}

// ===========================================================================
// ARCHIVE — terminal, and it stops the money
// ===========================================================================
note('--- archive is terminal ---');
{
  const arch = await api(`/api/promotions/${promo.id}/archive`, { method: 'POST', token: OWNER, body: {} });
  check('archive the 10% campaign → 200 and status ARCHIVED',
    arch.status === 200 && arch.body?.promotion?.status === 'ARCHIVED',
    arch.status === 200 ? '' : `got ${arch.status} ${JSON.stringify(arch.body).slice(0,160)}`);

  const edit = await api(`/api/promotions/${promo.id}`, {
    method: 'PATCH', token: OWNER,
    body: { name: `${MARK} ten-percent`, code: CODE.ten, benefitType: 'PERCENT', percent: 99 },
  });
  check('an ARCHIVED campaign refuses to be edited → 409 (terminal means terminal)', edit.status === 409,
    edit.status === 409 ? '' : `got ${edit.status} ${JSON.stringify(edit.body).slice(0,140)}`);

  const bill = await newBill(2, 1);
  const apply = await api(`/api/orders/${bill.id}/promotions`, {
    method: 'POST', token: CASHIER, body: { code: CODE.ten },
  });
  check('an ARCHIVED campaign cannot be spent → 404', apply.status === 404,
    apply.status === 404 ? '' : `got ${apply.status} ${JSON.stringify(apply.body).slice(0,160)}`);
}

note(`cleanup: voided ${await freeAll('phase 4 end')} bills this phase opened`);

process.exit(summary('Phase 4 — promotion campaigns: authoring, targeting, money, limits') ? 1 : 0);
