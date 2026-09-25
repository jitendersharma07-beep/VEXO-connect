// Fire the scheduled reports that are due — the one command an owner runs, or
// wires to cron, because REPORTING_SCHEDULER is off in this deployment.
//
//   node scripts/reporting-schedule-tick.mjs                 # says what WOULD send
//   node scripts/reporting-schedule-tick.mjs --send           # sends it
//   node scripts/reporting-schedule-tick.mjs --company <id>   # one tenant only
//
// DRY RUN IS THE DEFAULT, and that is the guard. The work order is explicit that
// real customer schedules must not be activated automatically, so the mode that
// writes anything has to be asked for by name. A cron line without --send is a
// monitor; with it, a sender.
//
// It prints what each schedule is, what period is due, and who would be written
// to versus withheld — never a credential, and never the figures themselves. The
// figures are in the artifact, and an owner pasting this output into a chat should
// not be pasting their company's takings with it.
//
// Every run appends one line to the log, whether or not it sent. A sender with no
// record of the mornings it stayed silent cannot be told apart from one that was
// never run.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { prisma } from '../src/lib/prisma.js';
// From the router on purpose. `tick` takes `actionsFor` as an argument precisely so
// the map from a report to the permissions it needs has one definition; a copy in
// this script would be a second one, and the copy that drifts is always the one
// nobody reads.
import { actionsFor } from '../src/api/routes/reporting.js';
import { dueRun, tick } from '../src/lib/reporting/schedule.js';

const argv = process.argv.slice(2);
const SEND = argv.includes('--send');
const COMPANY = argv.includes('--company') ? argv[argv.indexOf('--company') + 1] : null;
const LOG = process.env.REPORTING_TICK_LOG ?? '/tmp/reporting-schedule-tick.log';

const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};

const logRun = (verdict, summary) => {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()}\t${SEND ? 'SEND' : 'DRY-RUN'}\t${verdict}\t${summary}\n`);
  } catch (err) {
    console.error(`could not append to ${LOG}: ${err.message}`);
  }
};

let verdict = 'FAIL';
let summary = 'did not complete';
try {
  const where = { state: 'ACTIVE', ...(COMPANY ? { companyId: COMPANY } : {}) };
  const active = await prisma.reportSchedule.findMany({
    where,
    include: {
      recipients: { select: { recipient: { select: { email: true, isTestAddress: true, revokedAt: true } } } },
    },
    orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
  });

  if (!active.length) {
    say(`No active schedule${COMPANY ? ' for that company' : ''}. Nothing is due and nothing was sent.`);
    verdict = 'PASS';
    summary = '0 active';
  } else {
    const now = new Date();
    const due = [];
    for (const s of active) {
      // dueRun computes the period and the run key without writing anything, which
      // is what makes the dry run a real preview rather than a guess: it is the same
      // call the sender makes, one step short of delivering.
      const d = await dueRun({ schedule: s, now });
      const live = s.recipients.map((r) => r.recipient).filter((r) => !r.revokedAt);
      const willWrite = live.filter((r) => r.isTestAddress).map((r) => r.email);
      const withheld = live.filter((r) => !r.isTestAddress).map((r) => r.email);
      const already = d
        ? await prisma.reportDelivery.findUnique({
          where: { scheduleId_runKey: { scheduleId: s.id, runKey: d.runKey } },
          select: { status: true, sentAt: true },
        })
        : null;
      due.push({ s, d, willWrite, withheld, already });
    }

    const toSend = due.filter((x) => x.d && x.already?.status !== 'SENT');
    say(`${active.length} active schedule(s); ${due.filter((x) => x.d).length} with a completed period; ${toSend.length} not yet delivered.`);
    say('');
    for (const x of due) {
      const head = `${x.s.name} — ${x.s.reportKey} ${x.s.cadence} ${x.s.format}`;
      if (!x.d) {
        say(`  waiting   ${head}`);
        say('              no completed period yet — nothing to send.');
        continue;
      }
      const state = x.already?.status === 'SENT' ? 'delivered' : SEND ? 'sending' : 'would send';
      say(`  ${state.padEnd(9)} ${head}`);
      say(`              period ${x.d.period.from} to ${x.d.period.to}  ·  run key ${x.d.runKey}`);
      // Both halves, every time. "Sent" beside a schedule that named four people
      // and wrote to one is the reading this line exists to prevent.
      say(`              writes to ${x.willWrite.join(', ') || 'nobody'}`);
      if (x.withheld.length) {
        say(`              withheld ${x.withheld.join(', ')} — not marked as a test address in a build with no mail transport`);
      }
      if (!x.willWrite.length && !x.withheld.length) {
        say('              no live recipient — it cannot have been activated with one, so an address was revoked since.');
      }
    }
    say('');

    if (!SEND) {
      say('Dry run. Nothing was written. Add --send to deliver the periods listed above.');
      verdict = 'PASS';
      summary = `${toSend.length} due, none sent (dry run)`;
    } else {
      const result = await tick({ now, actionsFor, companyId: COMPANY });
      const sent = result.results.filter((r) => r.status === 'SENT' && !r.deduplicated);
      const dupes = result.results.filter((r) => r.deduplicated);
      const failures = result.results.filter((r) => r.status === 'FAILED' || (r.skipped && r.reason));
      for (const r of result.results) {
        const tag = r.deduplicated ? 'already' : (r.status ?? 'skipped');
        say(`  ${String(tag).padEnd(9)} ${r.name ?? r.scheduleId}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      say('');
      say(`${result.considered} considered, ${sent.length} sent, ${dupes.length} already delivered, ${failures.length} failed.`);
      verdict = failures.length ? 'FAIL' : 'PASS';
      summary = `${sent.length} sent, ${dupes.length} deduplicated, ${failures.length} failed`;
    }
  }
} catch (err) {
  say(`ERROR ${err.message}`);
  summary = err.message.slice(0, 200);
} finally {
  logRun(verdict, summary);
  await prisma.$disconnect();
}

say('');
say(`${verdict}  ${summary}  ·  logged to ${LOG}`);
process.exit(verdict === 'PASS' ? 0 : 1);
