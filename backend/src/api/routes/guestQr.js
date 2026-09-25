// The guest side of table QR ordering (TQ-4). PUBLIC and unauthenticated: the
// only credential is the token printed on the card, plus a per-phone guest token
// this route issues.
//
// Everything a request is allowed to affect is derived from that printed token,
// server-side, and nothing else:
//
//   token -> TableQrCode -> (tableId, branchId) -> (branchId, companyId)
//
// There is deliberately no companyId, branchId or tableId anywhere in a request
// body or query. A guest cannot name a store, cannot name a table, and cannot
// name a price — the basket carries product ids and quantities, and the till's
// own resolveCatalogLine does the pricing. That is the single most important
// property in this file: there is no second pricing path.
//
// The guest token travels in an X-Guest-Token header rather than a cookie, on
// purpose. A cookie on a public origin would need CSRF defences; a header that
// the browser never attaches on its own needs none.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/errors.js';
import { guestQrLimiter } from '../../middleware/rateLimit.js';
import { recomputeOrder } from '../../lib/orders.js';
import { resolveCatalogLine, mergeCatalogItems, createLineData } from './orders.js';
import {
  hashGuestToken,
  hashSubmission,
  openOrJoinVisit,
  orderForVisit,
  publicVisitFor,
} from '../../lib/qr/visits.js';

const router = Router();
router.use(guestQrLimiter);

// One refusal for every reason a card might not work: revoked, never existed,
// table retired, store closed. A guest can do nothing about any of them and the
// staff-facing difference is an audit question, not a phone question. Keeping
// them indistinguishable also means the endpoint cannot be used to test whether
// a guessed token exists.
const cardNotUsable = () =>
  new AppError(
    404,
    'POS_QR_NOT_USABLE',
    'This code is not in use. Please ask a member of staff for a current one.',
  );

const guestAuthRequired = () =>
  new AppError(401, 'POS_QR_GUEST_REQUIRED', 'Start or join the table order first.');

// The visit this phone belonged to has been closed by staff, or the card was
// re-issued underneath it. Its own screen is the only place this matters, and it
// is a different screen from "you never had a session".
const guestSessionOver = () =>
  new AppError(
    409,
    'POS_QR_SESSION_OVER',
    'This table order has been closed. Scan the code again to start a new one.',
  );

/**
 * Resolves the printed token to a live card, its table and its store.
 *
 * The only lookup key is the token. `status: 'ACTIVE'` is in the WHERE clause
 * rather than checked afterwards so a revoked card is not even read, and the
 * composite relations mean the branch and table that come back cannot belong to
 * a different tenant than the card — the foreign key already refused that row at
 * write time.
 */
const resolveCard = async (token) => {
  const qr = await prisma.tableQrCode.findFirst({
    where: { token, status: 'ACTIVE' },
    include: {
      branch: { select: { id: true, name: true, city: true, status: true, companyId: true } },
      table: {
        select: {
          id: true,
          name: true,
          status: true,
          branchId: true,
          placements: {
            where: { layout: { status: 'PUBLISHED' } },
            select: {
              area: {
                select: { name: true, kind: true, floor: { select: { name: true } } },
              },
            },
            take: 1,
          },
        },
      },
    },
  });
  if (!qr) throw cardNotUsable();
  if (qr.branch.status !== 'ACTIVE') throw cardNotUsable();
  if (qr.table.status !== 'ACTIVE') throw cardNotUsable();
  return qr;
};

/**
 * Resolves the X-Guest-Token header to a guest of the visit open at THIS card's
 * table.
 *
 * The table check is what isolates parties. A token is looked up by hash, and
 * then its visit must still be OPEN and must still be the visit occupying this
 * table — so a token kept from an earlier party stops working the instant staff
 * close that visit, and a token from another table cannot be replayed here.
 */
const resolveGuest = async (req, qr) => {
  const raw = req.get('x-guest-token');
  if (!raw) throw guestAuthRequired();
  const guest = await prisma.diningVisitGuest.findUnique({
    where: { tokenHash: hashGuestToken(raw) },
    include: { visit: true },
  });
  if (!guest) throw guestAuthRequired();
  if (guest.visit.status !== 'OPEN') throw guestSessionOver();
  if (guest.visit.tableId !== qr.table.id) throw guestSessionOver();
  return guest;
};

const placeLine = (table) => {
  const area = table.placements?.[0]?.area ?? null;
  return [area?.floor?.name, area?.name].filter(Boolean).join(' · ');
};

const storeOf = (qr) => ({
  name: qr.branch.name,
  city: qr.branch.city,
  tableName: qr.table.name,
  place: placeLine(qr.table),
});

// --- menu -------------------------------------------------------------------

// ACTIVE only, at every level. The guest's menu and the submit path have to agree
// exactly: resolveCatalogLine refuses an archived product, variant, group or
// option, so showing one would produce an item a guest can tap and never order.
const ACTIVE = { status: 'ACTIVE' };

const MENU_INCLUDE = {
  taxRate: { select: { name: true, ratePercent: true } },
  variants: { where: ACTIVE, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  modifierGroups: {
    where: ACTIVE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { options: { where: ACTIVE, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  },
};

const num = (d) => (d === null || d === undefined ? null : Number(d));

// What a guest's phone is allowed to know about a product. `sku` and `status` are
// staff facts and are not here; cost and margin are not on the model at all.
const menuProduct = (p) => ({
  id: p.id,
  name: p.name,
  price: num(p.basePrice),
  // Shown so a guest can see what a price includes. The authoritative tax is
  // recomputed server-side on the order and is never taken from this.
  tax: p.taxRate ? { name: p.taxRate.name, percent: num(p.taxRate.ratePercent) } : null,
  variants: p.variants.map((v) => ({ id: v.id, name: v.name, price: num(v.price) })),
  modifierGroups: p.modifierGroups.map((g) => ({
    id: g.id,
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    options: g.options.map((m) => ({ id: m.id, name: m.name, price: num(m.price) })),
  })),
});

/**
 * The store's menu.
 *
 * Product is company-scoped in this schema — there is no per-branch catalog and
 * this lane does not invent one. So "availability" here means ACTIVE in the
 * tenant's menu, which is the same answer at every store of that tenant, and the
 * response says so in `availability` rather than implying a per-store stock
 * system that does not exist. The same limitation is documented on the phone
 * path (C-7); the honest report belongs in the payload, not in a comment only.
 */
const loadMenu = async (companyId) => {
  const [categories, products] = await Promise.all([
    prisma.category.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, sortOrder: true },
    }),
    prisma.product.findMany({
      where: { companyId, status: 'ACTIVE' },
      include: MENU_INCLUDE,
      orderBy: [{ name: 'asc' }],
    }),
  ]);

  const byCategory = new Map(categories.map((c) => [c.id, []]));
  for (const p of products) {
    const bucket = byCategory.get(p.categoryId);
    if (bucket) bucket.push(menuProduct(p));
  }
  return {
    availability: 'MENU_STATUS_ONLY',
    categories: categories
      .map((c) => ({ id: c.id, name: c.name, products: byCategory.get(c.id) ?? [] }))
      .filter((c) => c.products.length > 0),
  };
};

// --- scan -------------------------------------------------------------------

/**
 * Scanning. Anonymous, read-only, and it writes nothing — no visit, no guest, no
 * row of any kind. A passer-by reading the menu therefore leaves no trace and
 * does not make the table look occupied, which is the §6 requirement that a scan
 * must not imply an order.
 */
router.get(
  '/t/:token',
  asyncHandler(async (req, res) => {
    const qr = await resolveCard(req.params.token);
    const openVisit = await prisma.diningVisit.findFirst({
      where: { openTableId: qr.table.id, status: 'OPEN' },
      select: { id: true },
    });
    res.json({
      store: storeOf(qr),
      // That the table is occupied is visible to anyone standing next to it, so
      // saying so costs nothing and lets the phone ask for the join code up
      // front. What the party has ORDERED is not here, and neither is the code.
      table: { occupied: Boolean(openVisit), joinRequired: Boolean(openVisit) },
      menu: await loadMenu(qr.branch.companyId),
    });
  }),
);

// --- session ----------------------------------------------------------------

const sessionSchema = z.object({
  joinCode: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'The code is four digits')
    .optional(),
});

/**
 * Start the table's order, or join the one already running.
 *
 * The returned token is the only time the plaintext exists outside the phone
 * that asked for it: the row stores a sha256 of it, exactly like a staff session,
 * so a database read can never yield a usable credential.
 */
router.post(
  '/t/:token/session',
  asyncHandler(async (req, res) => {
    const body = sessionSchema.parse(req.body ?? {});
    const qr = await resolveCard(req.params.token);

    const result = await prisma.$transaction(async (tx) =>
      openOrJoinVisit(tx, { qr, table: qr.table, joinCode: body.joinCode }),
    );

    res.status(result.joined ? 200 : 201).json({
      store: storeOf(qr),
      guestToken: result.token,
      visit: publicVisitFor(result.visit, result.guest),
    });
  }),
);

// --- the table's order ------------------------------------------------------

/**
 * What this guest may see of the table's order.
 *
 * The party shares one order by the approved policy, so the lines are the
 * table's and the total is the table's — that is what a shared basket means and
 * hiding it would make the bill unverifiable. What is NOT here is any fact about
 * another person: there are no names, no phone numbers and no per-guest
 * identities anywhere in the model to leak. `mine` is computed against this
 * guest's own id so the phone can mark its own lines without learning who added
 * the others beyond "Guest 3".
 */
const guestOrderView = (order, guest) => {
  if (!order) return null;
  return {
    id: order.id,
    status: order.status,
    // The same four names the till and the customer display use, read off the
    // same columns recomputeOrder wrote. A guest's phone showing a different
    // total from the printed bill would be the worst defect this lane could
    // ship, so there is no arithmetic here at all.
    subtotal: num(order.subtotal),
    discountAmount: num(order.discountAmount),
    taxAmount: num(order.taxAmount),
    total: num(order.total),
    lines: order.items
      .filter((i) => i.status === 'ACTIVE')
      .map((i) => ({
        id: i.id,
        name: i.name,
        qty: i.qty,
        unitPrice: num(i.unitPrice),
        lineTotal: num(i.lineTotal),
        modifiers: (i.modifiers ?? []).map((m) => m.name),
        by: i.addedByGuest ? `Guest ${i.addedByGuest.seq}` : 'Staff',
        mine: i.addedByGuestId === guest.id,
        // The one status a guest is entitled to: has the kitchen been told. It
        // is derived from the KOT actually existing, never from the submission
        // being sent — an unaccepted line reads false, which is the §6 promise
        // that scanning and sending are not the same as being cooked.
        sentToKitchen: Boolean(i.kotId),
      })),
  };
};

const GUEST_ORDER_INCLUDE = {
  items: {
    include: { modifiers: true, addedByGuest: { select: { id: true, seq: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
};

const loadVisitOrder = (visitId) =>
  prisma.order.findFirst({
    where: { visitId, status: { in: ['OPEN', 'BILLED'] } },
    include: GUEST_ORDER_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });

router.get(
  '/t/:token/order',
  asyncHandler(async (req, res) => {
    const qr = await resolveCard(req.params.token);
    const guest = await resolveGuest(req, qr);
    await prisma.diningVisitGuest.update({
      where: { id: guest.id },
      data: { lastSeenAt: new Date() },
    });
    const order = await loadVisitOrder(guest.visitId);
    const pending = await prisma.qrSubmission.count({
      where: { visitId: guest.visitId, status: 'SUBMITTED' },
    });
    res.json({
      store: storeOf(qr),
      visit: publicVisitFor(guest.visit, guest),
      order: guestOrderView(order, guest),
      // Honest about the gap between sending and being accepted. A phone that
      // showed "ordered" the moment it sent would be making the §6 promise the
      // system deliberately does not make.
      awaitingStaff: pending,
    });
  }),
);

// --- submit -----------------------------------------------------------------

const submitSchema = z.object({
  // Supplied by the phone so a retry on a flaky mobile connection is answered
  // with the first result instead of ordering twice.
  idempotencyKey: z.string().trim().min(8).max(120),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        qty: z.number().int().min(1).max(99),
        modifierOptionIds: z.array(z.string().min(1)).max(30).optional(),
      }),
    )
    .min(1)
    .max(40),
  note: z.string().trim().max(200).optional(),
});

const publicSubmissionFor = (submission, order, guest) => ({
  id: submission.id,
  status: submission.status,
  submittedAt: submission.createdAt,
  lineCount: submission.lineCount,
  order: guestOrderView(order, guest),
});

const idempotencyClash = (err) =>
  err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('idempotencyKey');

const replayed = () =>
  new AppError(
    409,
    'POS_QR_KEY_REUSED',
    'That request id was already used for a different order. Please start again.',
  );

/**
 * Send the basket to the till.
 *
 * Two facts are created here and they are not the same fact: the order rows
 * exist (so the table is honestly occupied and the POS has something to look
 * at), and the submission is SUBMITTED but undecided. No KOT is cut — the
 * kitchen has not been told and will not be until a member of staff accepts.
 *
 * Duplicate submissions cannot create duplicate orders or KOTs. The unique key
 * on (companyId, idempotencyKey) is the guarantee, not the pre-check: a
 * double-tap gets past any pre-check, Postgres holds the loser until the winner
 * commits, and a clash therefore proves the winner is readable now and is owed
 * the answer the pre-check would have given a moment later.
 */
router.post(
  '/t/:token/order',
  asyncHandler(async (req, res) => {
    const body = submitSchema.parse(req.body);
    const qr = await resolveCard(req.params.token);
    const guest = await resolveGuest(req, qr);
    const companyId = qr.companyId;
    const requestHash = hashSubmission(body.items);

    const answer = async (submission) => {
      if (submission.requestHash !== requestHash) throw replayed();
      const order = submission.orderId
        ? await prisma.order.findUnique({
            where: { id: submission.orderId },
            include: GUEST_ORDER_INCLUDE,
          })
        : null;
      return res.status(200).json({ submission: publicSubmissionFor(submission, order, guest) });
    };

    const prior = await prisma.qrSubmission.findFirst({
      where: { companyId, idempotencyKey: body.idempotencyKey },
    });
    if (prior) return answer(prior);

    // Priced by the till's own resolver, against the company the CARD belongs
    // to. The guest sent ids and quantities; every rupee here comes from the
    // catalog, and an archived or unknown id is refused with the same reason the
    // till would give.
    const lines = [];
    for (const item of mergeCatalogItems(body.items)) {
      lines.push(await resolveCatalogLine(companyId, item));
    }

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const fresh = await tx.diningVisit.findUnique({ where: { id: guest.visitId } });
        if (!fresh || fresh.status !== 'OPEN') throw guestSessionOver();

        const order = await orderForVisit(tx, { visit: fresh, qr });
        const submission = await tx.qrSubmission.create({
          data: {
            companyId,
            branchId: qr.branchId,
            tableId: qr.tableId,
            qrCodeId: qr.id,
            visitId: fresh.id,
            guestId: guest.id,
            status: 'SUBMITTED',
            idempotencyKey: body.idempotencyKey,
            requestHash,
            orderId: order.id,
            lineCount: lines.length,
            // What was ASKED for, verbatim and priced, kept beside what was
            // accepted. Staff reviewing a submission see the basket as sent even
            // if a line is later voided.
            payload: {
              note: body.note ?? null,
              lines: lines.map((l) => ({
                name: l.name,
                qty: l.qty,
                unitPrice: l.unitPrice,
                modifiers: l.modifiers.map((m) => m.name),
              })),
            },
          },
        });
        for (const l of lines) {
          await tx.orderItem.create({
            data: {
              ...createLineData(l, order.id),
              addedByGuestId: guest.id,
              qrSubmissionId: submission.id,
              ...(body.note ? { note: body.note } : {}),
            },
          });
        }
        await recomputeOrder(tx, order.id);
        return submission;
      });
    } catch (err) {
      if (!idempotencyClash(err)) throw err;
      const winner = await prisma.qrSubmission.findFirst({
        where: { companyId, idempotencyKey: body.idempotencyKey },
      });
      if (!winner) throw err;
      return answer(winner);
    }

    const order = await prisma.order.findUnique({
      where: { id: created.orderId },
      include: GUEST_ORDER_INCLUDE,
    });
    res.status(201).json({ submission: publicSubmissionFor(created, order, guest) });
  }),
);

export default router;
