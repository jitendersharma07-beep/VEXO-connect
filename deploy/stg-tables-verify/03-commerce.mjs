// Phase 3 — QR order → KOT → kitchen, then billing, payment and refund, on the
// DEPLOYED stack.
//
// This is the money path, so the same rule as phase 2 applies: every amount is
// compared in INTEGER PAISE, and every "it worked" has a control proving the
// alternative would have been visible.
//
// The QR half matters here in a way it cannot in a unit test: the guest routes
// are the only ones reached WITHOUT a bearer token, through the same nginx
// prefix. If the prefix strip or the cookie-path rewrite were wrong, this is
// where it would show.
import { api, check, note, summary, paise, rupees, loadJson } from './lib.mjs';

const tokens = loadJson('.tokens.json');
const MGR = tokens.BRANCH_MANAGER;
const CASHIER = tokens.CASHIER;
const OWNER = tokens.CUSTOMER_OWNER;

const me = (await api('/api/auth/me', { token: MGR })).body.user;
const branchId = me.branchId;

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
note(`reset: voided ${await freeAll('phase 3 start')} leftover OPEN bills`);

// A dining VISIT is a separate row from the order and from the card — that is
// the design (tableQr.js: "the printed card is untouched and stays usable").
// So voiding bills is not enough to make this phase re-runnable: a visit left
// OPEN by an earlier run makes the table `joinRequired`, and a fresh session is
// then correctly refused 409 POS_QR_JOIN_CODE_REQUIRED. Close them the way a
// member of staff would.
const closeVisits = async (label) => {
  const open = (await api('/api/table-qr/visits?status=OPEN', { token: MGR })).body?.visits ?? [];
  let n = 0;
  for (const v of open) {
    const r = await api(`/api/table-qr/visits/${v.id}/close`, {
      method: 'POST', token: MGR, body: { reason: `verify harness: ${label}` },
    });
    if (r.status === 200) n += 1;
  }
  return n;
};
note(`reset: closed ${await closeVisits('phase 3 start')} leftover OPEN dining visits`);

const tables = () => api('/api/tables', { token: MGR }).then((r) => r.body.tables);
const freeTable = async () => (await tables()).find((t) => t.branchId === branchId && !t.currentOrder);
const readOrder = async (id, token = CASHIER) => (await api(`/api/orders/${id}`, { token })).body?.order ?? null;
const totalPaise = (o) => paise(o.total);

// ===========================================================================
// KITCHEN STATION — the seed ships none, so the board has nowhere to route to
// ===========================================================================
note('--- kitchen station and routing ---');
let stationId = null;
{
  const existing = (await api('/api/kitchen/stations', { token: MGR })).body?.stations ?? [];
  note(`seed shipped ${existing.length} kitchen stations — creating one if absent`);
  if (existing.length) {
    stationId = existing[0].id;
  } else {
    const r = await api('/api/kitchen/stations', {
      method: 'POST', token: MGR,
      body: { name: 'Hot Pass', targetPrepSeconds: 600, isDefault: true },
    });
    check('create a kitchen station → 201', r.status === 201, r.status === 201 ? '' : `got ${r.status} ${JSON.stringify(r.body).slice(0,140)}`);
    stationId = r.body?.station?.id;
  }
  check('a kitchen station exists to route KOT lines to', !!stationId, '');

  // A CASHIER must not be able to reconfigure the kitchen.
  const denied = await api('/api/kitchen/stations', {
    method: 'POST', token: CASHIER, body: { name: 'should-never-exist' },
  });
  check('CASHIER cannot create a kitchen station → 403', denied.status === 403, `got ${denied.status}`);
}

// ===========================================================================
// QR ORDER → KOT
// ===========================================================================
note('--- QR order → submission → accepted onto a bill → KOT → kitchen board ---');
{
  const tbl = await freeTable();
  const issue = await api('/api/table-qr/issue', {
    method: 'POST', token: MGR, body: { tableId: tbl.id },
  });
  check(`issue a QR card for ${tbl.name} → 200/201`, issue.status < 300,
    issue.status < 300 ? '' : `got ${issue.status} ${JSON.stringify(issue.body).slice(0,160)}`);

  // The route returns `issued: [...]` and deliberately does NOT hand back a bare
  // token — the card carries `url: qrUrlFor(token)` (tableQr.js:76), so the
  // token is read off the URL tail. Guessing `card.token` was my error.
  //
  // And a table that ALREADY has a live card is `skipped`, not re-issued
  // (`rotate` is off by default) — correct behaviour that made the second run of
  // this file fail where the first passed. So fall back to the live card.
  let card = issue.body?.issued?.[0] ?? null;
  if (!card) {
    const listed = (await api('/api/table-qr', { token: MGR })).body?.tables ?? [];
    const row = listed.find((t) => t.tableId === tbl.id);
    card = row?.qr ?? row?.activeQr ?? row?.card ?? null;
    note(`card already live for ${tbl.name} (rotate is off by default) — reusing it`);
  }
  const token = card?.url ? card.url.split('/t/').pop() : null;
  check('the issued card carries a guest URL containing the token', !!token,
    token ? '' : JSON.stringify(issue.body).slice(0, 160));

  // A deployment-level check the unit suite cannot make: the printed URL is
  // built from POS_QR_BASE_URL, so this proves THIS stack would print a card a
  // phone could actually resolve — and that it is the staging origin, not a
  // leaked production hostname.
  check('the printed QR URL uses this deployment\'s own origin (POS_QR_BASE_URL is wired)',
    card?.url?.startsWith('http://127.0.0.1:8113/pos/t/'), `url=${card?.url}`);

  if (token) {
    // The guest side, with NO bearer token at all. This is the anonymous path
    // through the same /pos/ prefix.
    const land = await api(`/api/guest/qr/t/${token}`);
    check('GET /api/guest/qr/t/:token with NO auth → 200 (the anonymous guest path works)',
      land.status === 200, `got ${land.status} ${JSON.stringify(land.body).slice(0,140)}`);
    // The table name is at `store.tableName` (guestQr.js storeOf). The guest
    // payload deliberately carries no tableId/branchId/companyId at all — only a
    // display name — so there is nothing in it for a phone to tamper with.
    // `table.name` was my guess and it was wrong.
    check('  ...and it names the table the card belongs to',
      land.body?.store?.tableName === tbl.name,
      land.body?.store?.tableName === tbl.name ? '' : JSON.stringify(land.body?.store ?? land.body).slice(0, 160));

    const sess = await api(`/api/guest/qr/t/${token}/session`, { method: 'POST', body: {} });
    check('open a guest session → 200/201', sess.status < 300,
      sess.status < 300 ? '' : `got ${sess.status} ${JSON.stringify(sess.body).slice(0,180)}`);

    // A SECOND CORRECTION, RECORDED RATHER THAN QUIETLY FIXED. A first draft
    // carried the guest session on a cookie and got three red checks. The app is
    // right and the assertion was wrong: guest identity travels in an
    // X-Guest-Token HEADER by design (guestQr.js:16 — "A cookie on a public
    // origin would need CSRF defences; a header that the browser never attaches
    // on its own needs none"). So the ABSENCE of Set-Cookie is the CORRECT
    // observation, and it is asserted as such below rather than asserted away.
    const guestToken = sess.body?.guestToken;
    check('the session hands back a guest token (the one time the plaintext exists off the phone)',
      typeof guestToken === 'string' && guestToken.length > 20,
      guestToken ? '' : JSON.stringify(sess.body ?? '').slice(0, 160));
    check('  ...and sets NO cookie — a public-origin credential is a header, so CSRF has no lever',
      !sess.headers.get('set-cookie'),
      sess.headers.get('set-cookie') ? `set-cookie=${sess.headers.get('set-cookie')}` : '');

    // --- party isolation, found the hard way -------------------------------
    // The first run of this block failed 409 POS_QR_JOIN_CODE_REQUIRED because a
    // previous run had left the visit open. That refusal is a FEATURE, so it is
    // now asserted deliberately instead of merely reset away: possession of a
    // card is not permission to read what the table has already ordered.
    check('  ...the host is shown the 4-digit join code to read out',
      /^\d{4}$/.test(String(sess.body?.visit?.joinCode ?? '')) && sess.body?.visit?.guest?.isHost === true,
      sess.body?.visit?.guest?.isHost === true ? '' : JSON.stringify(sess.body?.visit ?? '').slice(0, 160));
    {
      const code = sess.body?.visit?.joinCode;
      const nocode = await api(`/api/guest/qr/t/${token}/session`, { method: 'POST', body: {} });
      check('a second phone with NO join code is refused 409 (a card is not permission to read the party\'s bill)',
        nocode.status === 409 && nocode.body?.error?.code === 'POS_QR_JOIN_CODE_REQUIRED',
        nocode.status === 409 ? '' : `got ${nocode.status} ${JSON.stringify(nocode.body).slice(0,140)}`);

      const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
      const bad = await api(`/api/guest/qr/t/${token}/session`, { method: 'POST', body: { joinCode: wrong } });
      check('a WRONG join code is refused 409 and distinguishably (limit is 10 guesses, not unlimited)',
        bad.status === 409 && bad.body?.error?.code === 'POS_QR_JOIN_CODE_WRONG',
        bad.status === 409 ? '' : `got ${bad.status} ${JSON.stringify(bad.body).slice(0,140)}`);

      const joined = await api(`/api/guest/qr/t/${token}/session`, { method: 'POST', body: { joinCode: code } });
      check('the RIGHT join code joins the same visit → 200 (not 201, so no second party was created)',
        joined.status === 200 && joined.body?.visit?.visitId === sess.body?.visit?.visitId,
        joined.status === 200 ? '' : `got ${joined.status} ${JSON.stringify(joined.body).slice(0,140)}`);
      check('  ...and the joiner is not the host, so the code is not re-shareable onwards',
        joined.body?.visit?.guest?.isHost === false && joined.body?.visit?.joinCode === null,
        `isHost=${joined.body?.visit?.guest?.isHost} joinCode=${joined.body?.visit?.joinCode}`);
    }

    const gHeaders = guestToken ? { 'x-guest-token': guestToken } : {};
    const basket = { items: [{ productId: P1.id, qty: 2 }], note: 'from the QR verify harness' };

    // CONTROL FIRST: the same basket with no guest token must be refused. Run
    // BEFORE the accepted submission, so the 201 below cannot be explained by
    // the route simply not checking.
    {
      const anon = await api(`/api/guest/qr/t/${token}/order`, {
        method: 'POST', body: { idempotencyKey: `verify-anon-${Date.now()}`, ...basket },
      });
      check('control: the same basket WITHOUT the guest token → 401 POS_QR_GUEST_REQUIRED',
        anon.status === 401 && anon.body?.error?.code === 'POS_QR_GUEST_REQUIRED',
        anon.status === 401 ? '' : `got ${anon.status} ${JSON.stringify(anon.body).slice(0,140)}`);
    }

    const idem = `verify-${Date.now()}`;
    const submit = await api(`/api/guest/qr/t/${token}/order`, {
      method: 'POST', headers: gHeaders, body: { idempotencyKey: idem, ...basket },
    });
    check('the guest submits an order from the phone → 200/201', submit.status < 300,
      submit.status < 300 ? '' : `got ${submit.status} ${JSON.stringify(submit.body).slice(0,200)}`);

    // A retry on a flaky mobile connection must not order twice.
    {
      const retry = await api(`/api/guest/qr/t/${token}/order`, {
        method: 'POST', headers: gHeaders, body: { idempotencyKey: idem, ...basket },
      });
      const same = retry.body?.submission?.id === submit.body?.submission?.id;
      check('  ...and re-sending the same idempotency key returns the SAME submission, not a second order',
        retry.status === 200 && same,
        same ? '' : `got ${retry.status} ${retry.body?.submission?.id} vs ${submit.body?.submission?.id}`);
    }

    // Submitting does NOT cut a KOT. That is the documented promise: the order
    // rows exist so the table is honestly occupied, but the kitchen has not been
    // told until a member of staff accepts.
    {
      const lines = submit.body?.submission?.order?.lines ?? [];
      check('  ...and no line reads sentToKitchen yet (sending ≠ being cooked)',
        lines.length >= 1 && lines.every((l) => l.sentToKitchen === false),
        lines.length ? '' : 'no lines on the submission');
    }

    // A guest order is a SUBMISSION, not a bill. The staff side accepts it.
    // Match THIS table — a leftover SUBMITTED row from an earlier run would
    // otherwise be accepted in its place and every assertion after it would
    // silently be about the wrong order.
    const subs = await api('/api/table-qr/submissions', { token: MGR });
    const queue = subs.body?.submissions ?? [];
    const sub = queue.find((s) => s.tableId === tbl.id) ?? null;
    check(`the submission for ${tbl.name} appears on the staff queue`,
      subs.status === 200 && !!sub, sub ? '' : `status=${subs.status} n=${queue.length}`);

    if (sub) {
      check('control: the submission is PENDING before anyone accepts it',
        /PENDING|NEW|SUBMITTED/i.test(String(sub.status)), `status=${sub.status}`);
      const acc = await api(`/api/table-qr/submissions/${sub.id}/accept`, {
        method: 'POST', token: CASHIER, body: {},
      });
      check('a cashier accepts the QR submission onto a bill → 200', acc.status === 200,
        acc.status === 200 ? '' : `got ${acc.status} ${JSON.stringify(acc.body).slice(0,180)}`);

      const orderId = acc.body?.order?.id ?? acc.body?.orderId;
      check('accepting the submission produced a real order', !!orderId, orderId ? '' : JSON.stringify(acc.body).slice(0, 160));

      // A THIRD CORRECTION, RECORDED RATHER THAN QUIETLY FIXED. A first draft
      // then fired a KOT explicitly and got 409 "No new items to send to the
      // kitchen" — while the KOT list already showed n=1. The app is right: the
      // KOT is cut BY ACCEPTANCE, through the same routeKotItems the till uses
      // (tableQr.js /submissions/:id/accept). So acceptance returning a kotId is
      // the real assertion, and that 409 is the till refusing to double-print.
      check('  ...and acceptance is what cut the KOT (the kitchen is told here, not at submit)',
        typeof acc.body?.kotId === 'string' && acc.body.kotId.length > 0,
        acc.body?.kotId ? '' : `kotId=${JSON.stringify(acc.body?.kotId)}`);

      if (orderId) {
        const o = await readOrder(orderId);
        const expected = paise(Number(P1.basePrice) * 2);
        check(`QR order priced from the catalog, not the phone (2 × ${P1.basePrice} before tax)`,
          paise(o.subtotal) === expected, `subtotal=${o.subtotal} want=${rupees(expected)}`);

        // --- KOT ---
        const kot = await api(`/api/orders/${orderId}/kot`, { method: 'POST', token: CASHIER, body: {} });
        check('re-firing the KOT is refused 409 "no new items" (acceptance already sent it — no double print)',
          kot.status === 409, kot.status === 409 ? '' : `got ${kot.status} ${JSON.stringify(kot.body).slice(0,180)}`);

        const kots = await api(`/api/orders/${orderId}/kots`, { token: CASHIER });
        check('the order lists exactly one KOT, so the double-fire created nothing',
          kots.status === 200 && (kots.body?.kots ?? []).length === 1,
          `n=${(kots.body?.kots ?? []).length}`);

        // --- the kitchen board actually shows it ---
        const board = await api(`/api/kitchen/stations/${stationId}/board`, { token: MGR });
        check('the kitchen board for the station → 200', board.status === 200, `got ${board.status}`);
        const items = board.body?.items ?? [];
        // Pin to THIS order's line. The board legitimately carries lines from
        // earlier runs still mid-prep, and `items[0]` picked one of those — which
        // produced a 409 "Cannot move a IN_PREP item to IN_PREP" that looked like
        // a state-machine bug and was in fact my harness grabbing the wrong row.
        const mine = items.filter((x) => x.orderId === orderId);
        check('QR → KOT → this order\'s line is ON the kitchen board (the whole chain, end to end)',
          mine.length >= 1, `board items=${items.length} for this order=${mine.length}`);

        // Advance one line through the board's own state machine, using the
        // version it reports — an optimistic-concurrency field, so a wrong
        // version must be refused rather than silently winning.
        const it = mine[0];
        if (it) {
          check(`  ...and it starts un-cooked, so IN_PREP is a real transition`,
            it.state !== 'IN_PREP', `state=${it.state}`);

          const bad = await api(`/api/kitchen/items/${it.id}/state`, {
            method: 'POST', token: MGR, body: { to: 'IN_PREP', version: it.version + 99 },
          });
          check('a STALE version is refused on a kitchen state change (optimistic concurrency holds)',
            bad.status >= 400 && bad.status < 500, `got ${bad.status}`);

          const good = await api(`/api/kitchen/items/${it.id}/state`, {
            method: 'POST', token: MGR, body: { to: 'IN_PREP', version: it.version },
          });
          check('the correct version advances the line to IN_PREP → 200', good.status === 200,
            good.status === 200 ? '' : `got ${good.status} ${JSON.stringify(good.body).slice(0,140)}`);

          const again = await api(`/api/kitchen/stations/${stationId}/board`, { token: MGR });
          const now = (again.body?.items ?? []).find((x) => x.id === it.id);
          check('  ...and the board reports the new state back',
            now?.state === 'IN_PREP', `state=${now?.state}`);
        }
      }
    }
  }
}

// ===========================================================================
// BILLING → PAYMENT → REFUND
// ===========================================================================
note('--- bill, pay, refund ---');
{
  note(`reset: voided ${await freeAll('before the billing run')} bills`);
  const tbl = await freeTable();
  const created = await api('/api/orders', {
    method: 'POST', token: CASHIER,
    body: { type: 'DINE_IN', tableId: tbl.id, items: [{ productId: P1.id, qty: 2 }, { productId: P2.id, qty: 1 }] },
  });
  const order = created.body.order;
  const before = await readOrder(order.id);
  const due = totalPaise(before);
  note(`bill under test: subtotal ${before.subtotal}, tax ${before.taxAmount}, total ${before.total}`);

  // Tax must be a real computed component, not zero.
  check('the bill carries a non-zero tax component (the seed ships GST rates)',
    paise(before.taxAmount) > 0, `tax=${before.taxAmount}`);
  const arith = totalPaise(before) === paise(before.subtotal) - paise(before.discountAmount) + paise(before.taxAmount);
  check('total == subtotal − discount + tax, to the paise', arith,
    arith ? '' : `${before.subtotal} − ${before.discountAmount} + ${before.taxAmount} ≠ ${before.total}`);

  // --- issue the bill ---
  const bill = await api(`/api/orders/${order.id}/bill`, { method: 'POST', token: CASHIER, body: {} });
  check('issue the bill → 200', bill.status === 200, bill.status === 200 ? '' : `got ${bill.status} ${JSON.stringify(bill.body).slice(0,160)}`);
  const billed = await readOrder(order.id);
  check('the billed order is BILLED', billed.status === 'BILLED', `status=${billed.status}`);
  check('the billed order carries an invoice number', !!billed.invoiceNumber, `invoice=${billed.invoiceNumber}`);
  check('billing did not move the money', totalPaise(billed) === due, `${totalPaise(billed)} vs ${due}`);

  // A billed order must not accept new items — the invoice is already printed.
  const late = await api(`/api/orders/${order.id}/items`, {
    method: 'POST', token: CASHIER, body: { productId: P1.id, qty: 1 },
  });
  check('a BILLED order refuses new items (the invoice is already out)',
    late.status >= 400 && late.status < 500, `got ${late.status}`);

  // --- underpay, then settle: proves amountDue is tracked, not assumed ---
  const partPaise = Math.floor(due / 3);
  const part = await api(`/api/orders/${order.id}/payments`, {
    method: 'POST', token: CASHIER,
    body: { method: 'CARD', amount: Number(rupees(partPaise)) },
  });
  check(`a partial CARD payment of ${rupees(partPaise)} → 201`, part.status === 201,
    part.status === 201 ? '' : `got ${part.status} ${JSON.stringify(part.body).slice(0,160)}`);
  const mid = await readOrder(order.id);
  check('the order is still BILLED while money is outstanding', mid.status === 'BILLED', `status=${mid.status}`);
  check(`amountDue fell by exactly the payment (${rupees(due)} − ${rupees(partPaise)})`,
    paise(mid.amountDue) === due - partPaise, `due=${mid.amountDue}`);

  // Overpaying the remainder must be refused, or the till drifts.
  const over = await api(`/api/orders/${order.id}/payments`, {
    method: 'POST', token: CASHIER,
    body: { method: 'CARD', amount: Number(rupees(due)) },
  });
  check('a payment larger than the amount due is REFUSED (till cannot drift)',
    over.status >= 400 && over.status < 500, `got ${over.status}`);

  // Settle the rest in cash.
  const rest = due - partPaise;
  const settle = await api(`/api/orders/${order.id}/payments`, {
    method: 'POST', token: CASHIER,
    body: { method: 'CASH', tendered: Number(rupees(rest)) },
  });
  check(`settle the remaining ${rupees(rest)} in CASH → 201`, settle.status === 201,
    settle.status === 201 ? '' : `got ${settle.status} ${JSON.stringify(settle.body).slice(0,160)}`);

  const paid = await readOrder(order.id);
  check('the fully-settled order is PAID', paid.status === 'PAID', `status=${paid.status}`);
  check('amountPaid == total, to the paise (split tender across CARD + CASH)',
    paise(paid.amountPaid) === due, `paid=${paid.amountPaid} total=${paid.total}`);
  check('amountDue is now zero', paise(paid.amountDue) === 0, `due=${paid.amountDue}`);
  check('the order records BOTH tenders, not one merged row',
    (paid.payments ?? []).length === 2, `payments=${(paid.payments ?? []).length}`);
  check('control: the table is released once the bill is PAID',
    !(await tables()).find((t) => t.id === tbl.id)?.currentOrder, '');

  // --- refund ---
  const refundPaise = Math.floor(due / 4);
  const noReason = await api(`/api/orders/${order.id}/refunds`, {
    method: 'POST', token: MGR, body: { amount: Number(rupees(refundPaise)) },
  });
  check('a refund without a reason is refused (the audit trail needs one)',
    noReason.status >= 400 && noReason.status < 500, `got ${noReason.status}`);

  const cashierRefund = await api(`/api/orders/${order.id}/refunds`, {
    method: 'POST', token: CASHIER,
    body: { amount: Number(rupees(refundPaise)), reason: 'verify harness refund probe', method: 'CASH' },
  });
  note(`a CASHIER refund attempt returned ${cashierRefund.status} — recorded, policy noted below`);

  const ref = await api(`/api/orders/${order.id}/refunds`, {
    method: 'POST', token: MGR,
    body: { amount: Number(rupees(refundPaise)), reason: 'verify harness: partial refund', method: 'CASH' },
  });
  check(`a manager refunds ${rupees(refundPaise)} → 200/201`, ref.status < 300,
    ref.status < 300 ? '' : `got ${ref.status} ${JSON.stringify(ref.body).slice(0,180)}`);

  const refunded = await readOrder(order.id);
  const seen = paise(refunded.amountRefunded) + paise(refunded.amountRefundPending);
  check(`the refund is recorded (refunded + pending == ${rupees(refundPaise)})`,
    seen === refundPaise * (cashierRefund.status < 300 ? 2 : 1),
    `refunded=${refunded.amountRefunded} pending=${refunded.amountRefundPending}`);

  // Over-refunding is the mirror of over-paying and must be refused too.
  const overRef = await api(`/api/orders/${order.id}/refunds`, {
    method: 'POST', token: MGR,
    body: { amount: Number(rupees(due)), reason: 'verify harness: over-refund control', method: 'CASH' },
  });
  check('refunding MORE than was collected is refused', overRef.status >= 400 && overRef.status < 500,
    `got ${overRef.status}`);

  // --- the receipt renders for a real, paid, partially refunded bill ---
  const rec = await api(`/api/orders/${order.id}/receipt`, { token: CASHIER });
  check('the receipt renders for the settled bill → 200', rec.status === 200, `got ${rec.status}`);
  check('  ...and it carries the invoice number',
    JSON.stringify(rec.body).includes(String(billed.invoiceNumber)), '');
}

process.exit(summary('Phase 3 — QR→KOT, kitchen, billing, payment, refund') ? 1 : 0);
