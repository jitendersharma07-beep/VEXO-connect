// The inventory front page: what needs attention, and what the stock is worth.
//
// Every figure is read from /inventory/dashboard, which counts from the ledger
// and the balance caches the ledger writes in the same transaction. Nothing on
// this page is computed in the browser, so the number here and the number on
// the stock screen cannot disagree.

import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  CalendarClock,
  ClipboardList,
  HelpCircle,
  IndianRupee,
  MapPin,
  Timer,
  TriangleAlert,
  Truck,
} from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner } from '../../components/ui.jsx';
import { Callout, ErrorNote, RefreshButton, Table, Td, useInventory } from '../../components/inventory.jsx';
import { fmtDateTime } from '../../lib/pos.js';
import { fmtPaise } from '../../lib/inventory.js';

// The scheduler's own health, shown next to the work it is supposed to be
// doing. §6 demands failed delivery be visible; a job that stopped ticking is
// the larger version of the same failure, and an empty reminder list looks
// identical whether the job is idle or dead.
function SchedulerHealth({ status }) {
  if (!status) return null;
  const jobs = status.jobs ?? [];
  const missing = status.missing ?? [];
  const failing = jobs.filter((j) => j.failing);

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Timer className="h-4 w-4 text-pos-royal" />
        <h2 className="text-sm font-bold text-pos-ink">Background scheduler</h2>
      </div>

      {/* The server sends the job NAMES that have no row yet, and the
          company-scoped one carries the company id. Named in plain words here
          rather than printed raw. */}
      {missing.length ? (
        <Callout tone="amber" title={missing.length > 1 ? 'The scheduler has never run' : 'One scheduler job has never run'}>
          {missing.some((n) => !n.includes(':')) ? 'The estate-wide pass' : 'The pass for this company'} has no
          record of ever having run. Plans will not raise their own orders and reminders will not be
          chased until it does. Ask your administrator whether the scheduler process is switched on.
        </Callout>
      ) : null}

      {failing.length ? (
        <Callout tone="red" title="The last pass did not finish cleanly">
          Orders raised by a plan may be late. The error is recorded against the job.
        </Callout>
      ) : null}

      <Table head={['Job', 'Last tick', 'Last clean finish', { key: 'r', label: 'Runs', right: true }, { key: 'f', label: 'Failures', right: true }]}>
        {jobs.map((j) => (
          <tr key={j.name}>
            <Td>
              <div className="font-semibold text-pos-ink">{j.scope === 'GLOBAL' ? 'Estate-wide pass' : 'Your company'}</div>
              {/* The global job's error names whichever tenant's plan broke, so
                  the server sends only whether it failed. Showing "failing" with
                  no text is the honest amount of detail to give here. */}
              {j.failing ? (
                <div className="mt-0.5 text-xs text-red-600">
                  {j.lastError || 'Failed — the detail belongs to another tenant and is not shown here.'}
                </div>
              ) : null}
            </Td>
            <Td className="text-slate-600">{fmtDateTime(j.lastTickAt)}</Td>
            <Td className="text-slate-600">{fmtDateTime(j.lastOkAt)}</Td>
            <Td right>{j.runCount}</Td>
            <Td right className={j.failCount ? 'font-semibold text-red-600' : ''}>{j.failCount}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export default function InventoryOverview() {
  const dash = useInventory('/inventory/dashboard');
  const sched = useInventory('/inventory/scheduler');

  if (!dash.data && dash.loading) return <FullScreenSpinner />;
  if (!dash.data) return <ErrorNote message={dash.error || 'Could not load the inventory overview'} />;

  const d = dash.data;
  const attention =
    d.batchesExpired + d.requestsAwaitingApproval + d.unresolvedIssues + d.remindersOverdue;

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle={`${d.locations} location${d.locations === 1 ? '' : 's'} you can see · as at ${fmtDateTime(d.asOf)}`}
        actions={
          <RefreshButton
            loading={dash.loading || sched.loading}
            onClick={() => {
              dash.reload();
              sched.reload();
            }}
          />
        }
      />

      <ErrorNote message={dash.error} />

      {d.batchesExpired > 0 ? (
        <Callout tone="red" icon={TriangleAlert} title={`${d.batchesExpired} expired batch${d.batchesExpired === 1 ? '' : 'es'} still hold stock`}>
          Expired stock is already excluded from usable and available quantities — it cannot be
          dispatched or sold. It is still physically somewhere, and until it is written off it keeps
          showing in physical stock. <Link className="underline" to="/inventory/batches">Deal with it on the batch screen.</Link>
        </Callout>
      ) : null}

      {d.positionsWithUnknownCost > 0 ? (
        <Callout tone="amber" icon={HelpCircle} title={`${d.positionsWithUnknownCost} position${d.positionsWithUnknownCost === 1 ? '' : 's'} with no known cost`}>
          These are shown as "cost not known" everywhere, never as zero. They are excluded from the
          valuation total rather than being counted as free stock, so the valuation below is a
          valuation of what could be valued.
        </Callout>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={IndianRupee}
          label="Stock value"
          value={fmtPaise(d.totalValuePaise)}
          hint={
            d.positionsWithUnknownCost
              ? `${d.positions} positions · ${d.positionsWithUnknownCost} not valued`
              : `${d.positions} positions, all valued`
          }
          accent="royal"
        />
        <StatCard
          icon={ClipboardList}
          label="Needs a decision"
          value={d.requestsAwaitingApproval}
          hint={`${d.openRequests} request${d.openRequests === 1 ? '' : 's'} open in total`}
          accent={d.requestsAwaitingApproval ? 'orange' : 'slate'}
        />
        <StatCard
          icon={Truck}
          label="In transit"
          value={d.transfersInTransit}
          hint="Dispatched, not yet accepted anywhere"
          accent={d.transfersInTransit ? 'royal' : 'slate'}
        />
        <StatCard
          icon={AlertTriangle}
          label="Overdue reminders"
          value={d.remindersOverdue}
          hint={d.unresolvedIssues ? `${d.unresolvedIssues} unsettled shortage/damage` : 'No unsettled shortages'}
          accent={d.remindersOverdue ? 'red' : 'slate'}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={CalendarClock}
          label="Expiring in 7 days"
          value={d.batchesExpiringIn7Days}
          hint="Still usable — use these first"
          accent={d.batchesExpiringIn7Days ? 'orange' : 'slate'}
        />
        <StatCard
          icon={TriangleAlert}
          label="Already expired"
          value={d.batchesExpired}
          hint="Blocked from issue and sale"
          accent={d.batchesExpired ? 'red' : 'slate'}
        />
        <StatCard icon={Boxes} label="Stock positions" value={d.positions} hint="Item at a location" accent="slate" />
        <StatCard icon={MapPin} label="Locations in scope" value={d.locations} hint="What your role reaches" accent="slate" />
      </div>

      {attention === 0 ? (
        <div className="mt-4">
          <Callout tone="sky" icon={null} title="Nothing is waiting on anybody">
            No expired stock, no request awaiting a decision, no unsettled shortage and no overdue
            reminder in the locations you can see.
          </Callout>
        </div>
      ) : null}

      <div className="mt-6">
        <SchedulerHealth status={sched.data} />
        <ErrorNote message={sched.error} />
      </div>
    </div>
  );
}
