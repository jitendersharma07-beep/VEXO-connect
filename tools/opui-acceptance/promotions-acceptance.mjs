// x/operator-ui acceptance — PROMOTIONS (VC-102) lifecycle and data integrity,
// against the landed contract in backend/src/api/routes/promotions.js.
//
// authz-acceptance.mjs already proves WHO may call these routes. This harness
// assumes a caller who may (the seeded owner, who holds promo.write and
// promo.publish) and instead proves that what the route does to Postgres is
// exactly what the contract promises:
//   - benefit and schedule fields land unmodified (code upper-cased, percent
//     as Decimal(6,3), dates/minutes/weekday mask exact);
//   - PUT /:id/rules and PUT /:id/stores REPLACE IN FULL — a second call with
//     a different set leaves none of the first set behind — and both dedupe
//     and validate their ids belong to this tenant;
//   - PATCH re-validates and rewrites the WHOLE representation (there is no
//     partial-update path — bodySchema requires the same fields PATCH or
//     POST, and toData() writes every one of them);
//   - a promotion's first publish freezes publishedAt for every later
//     re-publish;
//   - archive is a one-way door: every write route refuses an archived
//     promotion, including archive itself;
//   - a duplicate code is refused on both create and edit, independent of
//     case.
//
// Every mutation is confirmed by reading the row back out of Postgres, not by
// trusting the HTTP status — the same rule opui-lib.mjs states and
// authz-acceptance.mjs follows: a 200 over a rolled-back transaction reads
// identically to a 200 over a committed one from the client's side of the
// wire.
//
// Writes only to this lane's private database, through the API (except the
// final cleanup), and removes every row it creates so repeated runs do not
// accumulate fixtures.

import {
  sessions, client, check, section, verdict, refuses, admits, truthy, sql, sqlBool,
} from './opui-lib.mjs';

const main = async () => {
  const s = await sessions();
  const owner = client(s.owner);
  const companyId = s.owner.user.companyId;

  const branchesRes = await owner.get('/branches');
  const branches = branchesRes.data?.branches ?? [];
  truthy('owner can see at least two branches (needed for store replace-in-full)', branches.length >= 2 || undefined);
  const [branchA, branchB] = branches;

  // Real menu rows from the seeded tenant, looked up rather than hard-coded,
  // so a reseed that changes ids does not silently stop testing anything.
  const categoryId = sql(`select id from "Category" where "companyId" = '${companyId}' order by id limit 1`);
  const productId = sql(`select id from "Product" where "companyId" = '${companyId}' order by id limit 1`);
  const product2Id = sql(
    `select id from "Product" where "companyId" = '${companyId}' and id <> '${productId}' order by id limit 1`,
  );
  truthy('demo company has a category to build an item rule against', categoryId);
  truthy('demo company has at least two products to build item rules against', productId && product2Id);

  const createdIds = [];
  const epochOf = (iso) => Math.floor(new Date(iso).getTime() / 1000);

  // ---------------------------------------------------------------- create
  section('create: benefit + full schedule fields land in Postgres exactly as sent');
  let body = {
    name: `Acceptance Promo ${Date.now()}`,
    code: `acc${Date.now().toString(36)}`, // lower-case on purpose — the route upper-cases it
    benefitType: 'PERCENT',
    percent: 15,
    minSpendPaise: 50000,
    maxBenefitPaise: 20000,
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: '2026-12-31T23:59:59.000Z',
    weekdayMask: 62, // Mon–Fri: bit0=Sun … bit6=Sat → 2+4+8+16+32
    startMinute: 540, // 09:00 IST
    endMinute: 1260, // 21:00 IST
    channel: 'DINE_IN',
    stackable: true,
    precedence: 200,
    totalLimit: 100,
    perCustomerLimit: 2,
  };
  const create = await owner.post('/promotions', body);
  if (!(await admits('owner creates promoA with a full schedule', create))) {
    verdict('vcxo accept promo');
    return;
  }
  const id = create.data?.promotion?.id;
  if (!truthy('promoA got an id back', id)) {
    verdict('vcxo accept promo');
    return;
  }
  createdIds.push(id);

  check('code is upper-cased before it reaches Postgres', sql(`select code from "Promotion" where id = '${id}'`), body.code.toUpperCase());
  check('status defaults to DRAFT', sql(`select status from "Promotion" where id = '${id}'`), 'DRAFT');
  check('version starts at 1', sql(`select version from "Promotion" where id = '${id}'`), '1');
  check('benefitType', sql(`select "benefitType" from "Promotion" where id = '${id}'`), 'PERCENT');
  check('percent is stored as Decimal(6,3)', sql(`select percent from "Promotion" where id = '${id}'`), '15.000');
  check('flatPaise stays null for a PERCENT promotion', sqlBool(`select "flatPaise" is null from "Promotion" where id = '${id}'`), true);
  check('minSpendPaise', sql(`select "minSpendPaise" from "Promotion" where id = '${id}'`), body.minSpendPaise);
  check('maxBenefitPaise', sql(`select "maxBenefitPaise" from "Promotion" where id = '${id}'`), body.maxBenefitPaise);
  check('startsAt', sql(`select extract(epoch from "startsAt")::bigint from "Promotion" where id = '${id}'`), epochOf(body.startsAt));
  check('endsAt', sql(`select extract(epoch from "endsAt")::bigint from "Promotion" where id = '${id}'`), epochOf(body.endsAt));
  check('weekdayMask', sql(`select "weekdayMask" from "Promotion" where id = '${id}'`), body.weekdayMask);
  check('startMinute', sql(`select "startMinute" from "Promotion" where id = '${id}'`), body.startMinute);
  check('endMinute', sql(`select "endMinute" from "Promotion" where id = '${id}'`), body.endMinute);
  check('channel', sql(`select channel from "Promotion" where id = '${id}'`), body.channel);
  check('stackable', sqlBool(`select stackable from "Promotion" where id = '${id}'`), true);
  check('precedence', sql(`select precedence from "Promotion" where id = '${id}'`), body.precedence);
  check('totalLimit', sql(`select "totalLimit" from "Promotion" where id = '${id}'`), body.totalLimit);
  check('perCustomerLimit', sql(`select "perCustomerLimit" from "Promotion" where id = '${id}'`), body.perCustomerLimit);

  // -------------------------------------------------------- PATCH is a full replace
  // bodySchema.parse() on PATCH runs the exact same schema POST does — there
  // is no partial-update path — and toData() writes every one of its keys.
  // A caller that PATCHes with only the changed field would either 400 (a
  // required field vanished) or silently null out everything it left off.
  // This harness always resends the complete current representation, the
  // same discipline the reviewed Promotions.jsx submit path follows.
  section('PATCH replaces the whole representation, not a merge');
  body = { ...body, name: `${body.name} (edited)`, percent: 20 };
  await admits('owner edits promoA (still DRAFT)', await owner.patch(`/promotions/${id}`, body));
  check('the edited percent lands in Postgres', sql(`select percent from "Promotion" where id = '${id}'`), '20.000');
  check('version does not bump before the first publish', sql(`select version from "Promotion" where id = '${id}'`), '1');

  // ------------------------------------------------------------- item rules
  section('item rules: PUT /:id/rules replaces in full');
  await admits(
    'owner sets 2 item rules',
    await owner.put(`/promotions/${id}/rules`, {
      rules: [
        { kind: 'INCLUDE_CATEGORY', categoryId },
        { kind: 'INCLUDE_PRODUCT', productId },
      ],
    }),
  );
  check('2 item rules exist', sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${id}'`), 2);
  check(
    'the category rule is exactly as sent',
    sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${id}' and kind = 'INCLUDE_CATEGORY' and "categoryId" = '${categoryId}' and "productId" is null`),
    1,
  );
  check(
    'the product rule is exactly as sent',
    sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${id}' and kind = 'INCLUDE_PRODUCT' and "productId" = '${productId}' and "categoryId" is null`),
    1,
  );

  await admits(
    'owner replaces the rule set with a single different rule',
    await owner.put(`/promotions/${id}/rules`, { rules: [{ kind: 'EXCLUDE_PRODUCT', productId: product2Id }] }),
  );
  check('the old 2 rules are gone, replaced by exactly 1', sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${id}'`), 1);
  check(
    'the surviving rule is the new one, not a leftover',
    sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${id}' and kind = 'EXCLUDE_PRODUCT' and "productId" = '${product2Id}'`),
    1,
  );

  section('item rule validation the route enforces before touching Postgres');
  await refuses(
    'a category rule must not also carry a productId',
    await owner.put(`/promotions/${id}/rules`, { rules: [{ kind: 'INCLUDE_CATEGORY', categoryId, productId }] }),
    400,
  );
  await refuses(
    'a product rule must not also carry a categoryId',
    await owner.put(`/promotions/${id}/rules`, { rules: [{ kind: 'INCLUDE_PRODUCT', productId, categoryId }] }),
    400,
  );
  await refuses(
    'a category rule naming a category outside the tenant is refused',
    await owner.put(`/promotions/${id}/rules`, { rules: [{ kind: 'INCLUDE_CATEGORY', categoryId: 'nonexistent-category-id' }] }),
    400,
  );
  await refuses(
    'a product rule naming a product outside the tenant is refused',
    await owner.put(`/promotions/${id}/rules`, { rules: [{ kind: 'INCLUDE_PRODUCT', productId: 'nonexistent-product-id' }] }),
    400,
  );
  check('the rule set from before the rejected calls is untouched', sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${id}'`), 1);

  // ----------------------------------------------------------------- stores
  section('stores: PUT /:id/stores replaces in full and dedupes');
  await admits('owner targets both branches', await owner.put(`/promotions/${id}/stores`, { branchIds: [branchA.id, branchB.id] }));
  check('2 store links exist', sql(`select count(*) from "PromotionStore" where "promotionId" = '${id}'`), 2);

  await admits(
    'owner re-targets with a duplicated branch id',
    await owner.put(`/promotions/${id}/stores`, { branchIds: [branchA.id, branchA.id] }),
  );
  check('duplicate branch ids are deduped to 1 row', sql(`select count(*) from "PromotionStore" where "promotionId" = '${id}'`), 1);
  check(
    'the surviving link is branch A, not a phantom row',
    sql(`select count(*) from "PromotionStore" where "promotionId" = '${id}' and "branchId" = '${branchA.id}'`),
    1,
  );

  await admits('owner clears the store list back to "every store"', await owner.put(`/promotions/${id}/stores`, { branchIds: [] }));
  check('an empty branchIds list leaves zero store rows (no rows = every store)', sql(`select count(*) from "PromotionStore" where "promotionId" = '${id}'`), 0);

  await refuses(
    'a branch id outside the tenant is refused',
    await owner.put(`/promotions/${id}/stores`, { branchIds: ['nonexistent-branch-id'] }),
    400,
  );
  check('the rejected store call left no rows behind', sql(`select count(*) from "PromotionStore" where "promotionId" = '${id}'`), 0);

  // -------------------------------------------------------------- lifecycle
  section('lifecycle: DRAFT → PUBLISHED → PAUSED → PUBLISHED → ARCHIVED');
  await admits('owner publishes promoA', await owner.post(`/promotions/${id}/publish`));
  check('status is PUBLISHED', sql(`select status from "Promotion" where id = '${id}'`), 'PUBLISHED');
  check('publishedAt is set by the first publish', sqlBool(`select "publishedAt" is not null from "Promotion" where id = '${id}'`), true);
  const firstPublishedAtEpoch = sql(`select extract(epoch from "publishedAt")::bigint from "Promotion" where id = '${id}'`);

  body = { ...body, name: `${body.name} (published edit)` };
  await admits('owner edits promoA after it is live', await owner.patch(`/promotions/${id}`, body));
  check('editing a published promotion bumps version', sql(`select version from "Promotion" where id = '${id}'`), '2');

  await admits('owner pauses promoA', await owner.post(`/promotions/${id}/pause`));
  check('status is PAUSED', sql(`select status from "Promotion" where id = '${id}'`), 'PAUSED');

  await admits('owner republishes promoA from PAUSED', await owner.post(`/promotions/${id}/publish`));
  check('status is PUBLISHED again', sql(`select status from "Promotion" where id = '${id}'`), 'PUBLISHED');
  check(
    'publishedAt is frozen at the FIRST publish, not bumped by the second',
    sql(`select extract(epoch from "publishedAt")::bigint from "Promotion" where id = '${id}'`),
    firstPublishedAtEpoch,
  );

  await admits('owner archives promoA', await owner.post(`/promotions/${id}/archive`));
  check('status is ARCHIVED', sql(`select status from "Promotion" where id = '${id}'`), 'ARCHIVED');

  section('archive is terminal: every write route refuses an archived promotion');
  await refuses('re-archiving an already-archived promotion', await owner.post(`/promotions/${id}/archive`), 409);
  await refuses('publishing an archived promotion', await owner.post(`/promotions/${id}/publish`), 409);
  await refuses('pausing an archived promotion', await owner.post(`/promotions/${id}/pause`), 409);
  await refuses('PATCHing an archived promotion', await owner.patch(`/promotions/${id}`, body), 409);
  await refuses('setting rules on an archived promotion', await owner.put(`/promotions/${id}/rules`, { rules: [] }), 409);
  await refuses('setting stores on an archived promotion', await owner.put(`/promotions/${id}/stores`, { branchIds: [] }), 409);
  check('status is still ARCHIVED after every refused attempt', sql(`select status from "Promotion" where id = '${id}'`), 'ARCHIVED');
  check('version did not move from any of the refused attempts', sql(`select version from "Promotion" where id = '${id}'`), '2');

  // ---------------------------------------------------------- duplicate code
  section('duplicate code is refused on create and on edit, independent of case');
  const codeA = sql(`select code from "Promotion" where id = '${id}'`);
  await refuses(
    "creating a second promotion with promoA's code, different case",
    await owner.post('/promotions', {
      name: `Acceptance Promo Dup ${Date.now()}`,
      code: codeA.toLowerCase(),
      benefitType: 'FLAT',
      flatPaise: 5000,
    }),
    409,
  );

  const bBody = {
    name: `Acceptance Promo B ${Date.now()}`,
    code: `accb${Date.now().toString(36)}`,
    benefitType: 'FLAT',
    flatPaise: 5000,
  };
  const createB = await owner.post('/promotions', bBody);
  if (await admits('owner creates promoB with its own distinct code', createB)) {
    const bId = createB.data?.promotion?.id;
    createdIds.push(bId);
    await refuses("editing promoB to steal promoA's code", await owner.patch(`/promotions/${bId}`, { ...bBody, code: codeA }), 409);
    await admits(
      "editing promoB while resending its OWN unchanged code (not a false self-collision)",
      await owner.patch(`/promotions/${bId}`, { ...bBody, name: `${bBody.name} (renamed)` }),
    );
    check("promoB kept its own code", sql(`select code from "Promotion" where id = '${bId}'`), bBody.code.toUpperCase());
  }

  // --------------------------------------------------- cross-field validation
  section('cross-field validation the route enforces via superRefine (400s)');
  const probeName = `Acceptance Probe ${Date.now()}`;
  await refuses('FLAT benefit missing flatPaise', await owner.post('/promotions', { name: probeName, benefitType: 'FLAT' }), 400);
  await refuses('PERCENT benefit missing percent', await owner.post('/promotions', { name: probeName, benefitType: 'PERCENT' }), 400);
  await refuses(
    'FLAT benefit must not also carry percent',
    await owner.post('/promotions', { name: probeName, benefitType: 'FLAT', flatPaise: 1000, percent: 10 }),
    400,
  );
  await refuses(
    'startsAt at or after endsAt',
    await owner.post('/promotions', {
      name: probeName, benefitType: 'PERCENT', percent: 5,
      startsAt: '2026-06-01T00:00:00.000Z', endsAt: '2026-01-01T00:00:00.000Z',
    }),
    400,
  );
  await refuses(
    'startMinute at or after endMinute',
    await owner.post('/promotions', { name: probeName, benefitType: 'PERCENT', percent: 5, startMinute: 1000, endMinute: 500 }),
    400,
  );
  await refuses(
    'startMinute set without a matching endMinute',
    await owner.post('/promotions', { name: probeName, benefitType: 'PERCENT', percent: 5, startMinute: 540 }),
    400,
  );
  await refuses(
    'weekdayMask of 0 is refused — "no days" is not representable, null means every day',
    await owner.post('/promotions', { name: probeName, benefitType: 'PERCENT', percent: 5, weekdayMask: 0 }),
    400,
  );
  check('none of the rejected probes created a row', sql(`select count(*) from "Promotion" where name = '${probeName}'`), 0);

  // -------------------------------------------------------------- cleanup
  // PromotionItemRule and PromotionStore both carry onDelete: Restrict on
  // their promotion relation, so children must go before the parent — a
  // plain `delete from "Promotion"` here would throw a foreign-key error
  // instead of quietly leaving fixtures behind.
  section('cleanup: this harness is about contracts, not fixtures');
  for (const pid of createdIds) {
    sql(`delete from "PromotionItemRule" where "promotionId" = '${pid}'`);
    sql(`delete from "PromotionStore" where "promotionId" = '${pid}'`);
    sql(`delete from "Promotion" where id = '${pid}'`);
    check(`promotion ${pid} is gone after cleanup`, sql(`select count(*) from "Promotion" where id = '${pid}'`), 0);
  }

  verdict('vcxo accept promo');
};

main().catch((e) => {
  console.error(`\nharness error: ${e.message}`);
  process.exit(2);
});
