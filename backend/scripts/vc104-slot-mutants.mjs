// Negative controls for the VC-104 slot-anchor capacity rule.
//
//   node scripts/vc104-slot-mutants.mjs      (run from backend/, or anywhere —
//                                             paths resolve from this file)
//
// Green on the first run is a claim, not evidence. Each mutant breaks the
// IMPLEMENTATION — never an assertion — and the run must go RED on the named
// test. A mutant that stays green means the test beside it is decoration.
//
// Aimed at the UNION-of-three-arms form of countBookedInSlot. The single
// COALESCE was replaced because it could not be indexed; that rewrite triples
// the number of places the half-open rule is written (one `< $4` per arm) and
// introduces a double-count that a scalar anchor made impossible. So the
// battery carries a boundary mutant PER ARM, and a disjointness mutant.
//
// Two mutants are declared `escapes: true` in advance, with the reason.
// Predicting them is the point: an undetected mutation you already knew about
// is a documented limit, one you find later is a surprise.
//
// Restores every file from the exact bytes read at startup, in a finally, so an
// interrupted run cannot leave the tree mutated.
//
// Needs the same env as the suite (DATABASE_URL pointing at a scratch DB).
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = join(BACKEND, 'src/api/routes/phoneOrders.js');
const LIB = join(BACKEND, 'src/lib/phoneOrders.js');
const SUITE = 'tests/phoneOrders.test.js';
const REPORT = join(BACKEND, 'node_modules/.cache/vc104-mutant-report.json');
// The installed binary, not `npx vitest`. npx consults a shared npm cache under
// ~/.npm/_npx, and on a box running several worktrees at once that cache is
// contended — it has failed here with ENOTEMPTY mid-run. A control that can die
// for a reason unrelated to the mutation is a bad control.
const VITEST = join(BACKEND, 'node_modules/.bin/vitest');

const original = new Map([
  [ROUTE, readFileSync(ROUTE, 'utf8')],
  [LIB, readFileSync(LIB, 'utf8')],
]);

const MUTANTS = [
  {
    id: 'M1',
    what: 'no advisory lock: check and reserve stop being atomic',
    expect: 'serializes two genuinely overlapping reservations for the last place',
    file: LIB,
    from: `export const lockSlot = async (tx, { companyId, branchId, start }) => {
  await tx.$executeRawUnsafe(`,
    to: `export const lockSlot = async (tx, { companyId, branchId, start }) => {
  if (start) return;
  await tx.$executeRawUnsafe(`,
  },
  {
    id: 'M2',
    what: 'arm B deleted: a moved order no longer counts at its arrival slot',
    expect: 'counts a back-dated transfer against the slot it ARRIVES in, and refuses past the cap',
    file: LIB,
    from: `  UNION
    SELECT po.id
      FROM "PhoneOrderEvent" e
      JOIN "PhoneOrder" po ON po.id = e."phoneOrderId"`,
    to: `  UNION
    SELECT po.id
      FROM "PhoneOrderEvent" e
      JOIN "PhoneOrder" po ON po.id = e."phoneOrderId" AND false`,
  },
  {
    id: 'M2b',
    what: 'arms B and C stop being disjoint: a moved order counts in TWO slots',
    expect: 'occupies only the slot it arrived in, not also the slot it was called in',
    file: LIB,
    // The guard body is shared with arm B now, so it cannot be decorrelated for
    // arm C alone. Neutralise the guard by precedence instead: AND binds tighter
    // than OR, so `... AND P AND true OR false AND NOT EXISTS(...)` parses as
    // `(... AND P AND true) OR (false AND ...)`, which is just `... AND P`.
    // Every other arm-C predicate survives; only the NOT EXISTS stops applying.
    from: `       AND NOT EXISTS (SELECT 1`,
    to: `       AND true OR false AND NOT EXISTS (SELECT 1`,
  },
  {
    id: 'M3',
    what: 'no binding re-check inside the reassign transaction',
    // This first named the HTTP-level race test and was WRONG. That test fires two
    // reassigns with Promise.all, and the measurement recorded above reserveSlot in
    // the route says they enter it 28 ms apart — they never overlap, so deleting the
    // lock-and-check changes nothing they can see. It "caught" M3 on three earlier
    // runs by luck of ordering. The detector below forces the overlap with a held
    // advisory lock instead of hoping for one.
    expect: 're-checks capacity inside the transaction, after the advisory read said yes',
    file: ROUTE,
    from: `      await reserveSlot(tx, { companyId, branchId: body.branchId, when });

      await tx.order.update(`,
    to: `      await tx.order.update(`,
  },
  {
    id: 'M4',
    what: 'a scheduled transfer is judged against the moment it moves, not its due slot',
    expect: 'judges a scheduled transfer against its due slot, not the moment it moves',
    file: ROUTE,
    from: `    const when = po.scheduledFor ?? movedAt;`,
    to: `    const when = movedAt;`,
  },
  {
    id: 'M5',
    what: 'the latest reassign into the CURRENT branch no longer wins (A->B->A)',
    expect: 're-anchors to the latest move when an order returns to a store it left',
    file: LIB,
    // Single source of truth now, so this one edit hits the readable anchor and
    // both arms at once — which is the point of having factored it.
    from: `        AND ${'${e}'}."toBranchId" = po."routedBranchId"\`;`,
    to: `        AND ${'${e}'}."toBranchId" <> po."routedBranchId"\`;`,
  },
  {
    id: 'M6a',
    what: 'arm A (scheduled) treats the slot end as inclusive',
    expect: 'anchors a scheduled order inclusively at slot start and exclusively at slot end',
    file: LIB,
    from: `       AND po."scheduledFor" < $4`,
    to: `       AND po."scheduledFor" <= $4`,
  },
  {
    id: 'M6b',
    what: 'arm B (moved here) treats the slot end as inclusive',
    expect: 'anchors a transfer inclusively at slot start and exclusively at slot end',
    file: LIB,
    from: `       AND e."at" < $4`,
    to: `       AND e."at" <= $4`,
  },
  {
    id: 'M6c',
    what: 'arm C (never moved) treats the slot end as inclusive',
    expect: 'anchors a native ASAP order inclusively at slot start and exclusively at slot end',
    file: LIB,
    from: `       AND po."createdAt" < $4`,
    to: `       AND po."createdAt" <= $4`,
  },
  {
    id: 'M7',
    what: 'rejected orders keep occupying the kitchen',
    expect: 'returns the place to the slot when the destination rejects the order',
    file: LIB,
    // First aimed at arm C's copy of the status list and it ESCAPED: the
    // rejected order in that test was reassigned in, so it lives in arm B. The
    // list is written once now, so one edit covers every arm.
    from: `       AND po.status IN ('SUBMITTED','ACCEPTED')\`;`,
    to: `       AND po.status IN ('SUBMITTED','ACCEPTED','REJECTED')\`;`,
  },
  {
    id: 'M10',
    what: 'the capacity check moves OUTSIDE the transaction: a refused transfer still commits',
    // This first named the source-preservation test and was WRONG for a structural
    // reason worth keeping: that test fills the destination BEFORE the request, so
    // loadBranchDecision's advisory read refuses it at phoneOrders.js:986, before the
    // transaction opens. The mutated lines are never executed. Every capacity test in
    // the file had the same shape, which is why M10 escaped with the suite red in five
    // places and the one test named as its control still green.
    expect: 're-checks capacity inside the transaction, after the advisory read said yes',
    file: ROUTE,
    // Two point edits, which is why `edits` exists. The refusal survives — the
    // caller still gets 409 AT_CAPACITY — so every test that only checks the
    // status code stays green. What breaks is the rollback: the move has already
    // committed by the time the check throws, so the order is refused AND moved.
    // That is what separates M10 from M3: M3 loses the refusal, M10 keeps it and
    // loses only the rollback, so a test that asserts nothing past the 409 cannot
    // tell them apart.
    edits: [
      {
        from: `      await reserveSlot(tx, { companyId, branchId: body.branchId, when });

      await tx.order.update(`,
        to: `      await tx.order.update(`,
      },
      {
        from: `    const after = await orderOf(po.orderId);`,
        to: `    await reserveSlot(prisma, { companyId, branchId: body.branchId, when });
    const after = await orderOf(po.orderId);`,
      },
    ],
  },
  {
    id: 'M8',
    escapes: true,
    why: 'the window is milliseconds wide and only opens on a slot boundary, so no\n'
      + '      deterministic test can see it. Argued in code, not asserted.',
    what: 'reassign lets the event timestamp default instead of pinning movedAt',
    expect: '(none expected)',
    file: ROUTE,
    from: `          at: movedAt,
          action: 'REASSIGNED',`,
    to: `          action: 'REASSIGNED',`,
  },
  {
    id: 'M9',
    escapes: true,
    why: 'same millisecond window on the submit side: createdAt would default to\n'
      + '      now() a few ms after the instant reserveSlot checked.',
    what: 'submit lets createdAt default instead of pinning takenAt',
    expect: '(none expected)',
    file: ROUTE,
    from: `            createdAt: takenAt,`,
    to: '',
  },
];

// A run returns {failed, total}. The report file is DELETED first and its
// absence afterwards is a hard error — otherwise a vitest that dies before
// writing leaves the previous mutant's report on disk, and this script reads it
// and reports a confident CAUGHT/ESCAPED about a run that never happened. That
// is the difference between a control and a decoration.
const run = () => {
  rmSync(REPORT, { force: true });
  try {
    execFileSync(
      VITEST,
      ['run', SUITE, '--reporter=json', `--outputFile=${REPORT}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env, cwd: BACKEND },
    );
  } catch {
    /* a red run is the expected outcome here */
  }
  if (!existsSync(REPORT)) throw new Error('vitest wrote no report — the run did not happen');
  const report = JSON.parse(readFileSync(REPORT, 'utf8'));
  const all = report.testResults.flatMap((f) => f.assertionResults ?? []);
  return {
    failed: all.filter((a) => a.status === 'failed').map((a) => a.title),
    total: all.length,
  };
};

let bad = 0;
const escaped = [];
try {
  // Mutating a suite that is already red produces meaningless results: every
  // mutant looks caught. So establish the baseline first, and take its test
  // count as the number every mutated run must also collect — a mutant that
  // silently drops tests is not evidence either.
  const base = run();
  if (base.failed.length) {
    console.log(`BASELINE RED (${base.failed.length}): ${base.failed.join(' | ')}`);
    console.log('refusing to mutate a failing suite — nothing below would mean anything');
    process.exit(1);
  }
  console.log(`baseline: ${base.total} tests, all green\n`);

  for (const m of MUTANTS) {
    const src = original.get(m.file);
    // A mutant is a list of point edits applied in order. Most are one edit;
    // some properties cannot be broken with a single substitution — moving a
    // guard out of a transaction takes two, one to remove and one to re-add
    // elsewhere — and a battery that cannot express those silently has no
    // control for them.
    const edits = Array.isArray(m.edits) ? m.edits : [{ from: m.from, to: m.to }];
    let mutated = src;
    let applied = true;
    for (const e of edits) {
      if (!mutated.includes(e.from)) {
        applied = false;
        break;
      }
      mutated = mutated.replace(e.from, e.to);
    }
    if (!applied || mutated === src) {
      console.log(`${m.id} VOID — anchor text not found, the mutant did not apply`);
      bad += 1;
      continue;
    }
    writeFileSync(m.file, mutated);
    let failed;
    let total;
    try {
      ({ failed, total } = run());
    } finally {
      writeFileSync(m.file, src);
    }

    if (total !== base.total) {
      console.log(`${m.id} VOID — collected ${total} tests, baseline was ${base.total}`);
      bad += 1;
      continue;
    }

    if (m.escapes) {
      const ok = failed.length === 0;
      console.log(
        `${m.id} ${ok ? 'ESCAPED as predicted' : 'CAUGHT (better than predicted)'}  ${m.what}\n` +
          `      why: ${m.why}` +
          (ok ? '' : `\n      red: ${failed.join(' | ')}`),
      );
      if (ok) escaped.push(m);
      continue;
    }

    const caught = failed.includes(m.expect);
    console.log(
      `${m.id.padEnd(3)} ${caught ? 'CAUGHT  ' : 'ESCAPED '} ${m.what}\n` +
        `      by: ${m.expect}` +
        (caught && failed.length > 1 ? `\n      also red: ${failed.filter((f) => f !== m.expect).join(' | ')}` : '') +
        (caught ? '' : `\n      red this run (${failed.length}): ${failed.length ? failed.join(' | ') : 'none — the suite stayed GREEN'}`),
    );
    if (!caught) bad += 1;
  }
} finally {
  for (const [file, src] of original) writeFileSync(file, src);
  console.log('\nrestored both files from the bytes read at startup');
}

const enforced = MUTANTS.filter((m) => !m.escapes).length;
console.log(
  bad === 0
    ? `\nPASS: ${enforced}/${enforced} enforced mutants detected; ${escaped.length} predicted escape(s), listed above`
    : `\nFAIL: ${bad} enforced mutant(s) escaped or voided`,
);
process.exit(bad === 0 ? 0 : 1);
