import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BadgeCheck, CheckCircle2, HelpCircle, ListChecks, RotateCcw, Timer } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, PageHeader, StatCard } from '../components/ui.jsx';
import { fmtDateTime, fmtINR, getAtcScope, isAtc, istDaysAgo, istToday } from '../lib/pos.js';

// /reports/reconciliation — gateway reconciliation (contract §13). Puts "what
// we asked the provider for" beside "what actually arrived" and lists every
// row that does not line up. Every figure, reason and note on this page is a
// server value rendered verbatim: the client computes nothing about money and
// invents no zeros the server did not send.

function Section({ title, tone = 'slate', children }) {
  const border = tone === 'red' ? 'border-red-200' : tone === 'amber' ? 'border-amber-200' : 'border-slate-100';
  return (
    <div className={`card mt-4 border ${border} p-5`}>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </div>
  );
}

function Th({ children, right = false }) {
  return <th className={`pb-2 ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Td({ children, right = false, bold = false }) {
  return (
    <td className={`py-2 ${right ? 'text-right' : ''} ${bold ? 'font-semibold text-pos-ink' : 'text-slate-600'}`}>
      {children}
    </td>
  );
}

export default function GatewayReconciliation() {
  const { user } = useAuth();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const [from, setFrom] = useState(istDaysAgo(6));
  const [to, setTo] = useState(istToday());
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!owner) return;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        setBranches((data.branches || []).filter((b) => b.status === 'ACTIVE'));
      } catch {
        // branch filter optional
      }
    })();
  }, [owner]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (owner && branchId) params.branchId = branchId;
      const { data } = await api.get('/reports/gateway-reconciliation', { params });
      setReport(data.report);
    } catch (err) {
      setError(apiError(err, 'Could not load the reconciliation report'));
    } finally {
      setLoading(false);
    }
  }, [atc, atcScope, from, to, owner, branchId]);

  useEffect(() => {
    load();
  }, [load]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Gateway reconciliation" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={ListChecks}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  const ex = report?.exceptions;
  const sum = report?.summary;

  // With no provider configured AND no gateway rows in range, every figure on
  // this page would be a zero measuring something that does not exist — and a
  // grid of zeros beside a green "nothing to chase" tick reads as "the gateway
  // is reconciled", which is a different claim from "there is no gateway".
  // Same reasoning the server already applies to signatureFailures, which it
  // sends as null rather than 0 because unknowable is not none.
  //
  // Deliberately not keyed on `configured` alone: a deployment that switches a
  // provider off still owes the customer every refund raised while it was on,
  // so any history in range keeps the full report on screen.
  const nothingToReconcile =
    report &&
    !report.gateway.configured &&
    sum.settledIntents === 0 &&
    sum.openIntents === 0 &&
    sum.exceptions === 0;

  return (
    <div>
      <PageHeader
        title="Gateway reconciliation"
        subtitle={
          atcScope
            ? `Company: ${atcScope.name || atcScope.id}`
            : owner
              ? 'All branches, or filter to one'
              : 'Your branch'
        }
      />

      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="rec-from">From (IST)</label>
          <input id="rec-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="rec-to">To (IST)</label>
          <input id="rec-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {owner ? (
          <div>
            <label className="label" htmlFor="rec-branch">Branch</label>
            <select id="rec-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setFrom(istToday()); setTo(istToday()); }}>
            Today
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setFrom(istDaysAgo(6)); setTo(istToday()); }}>
            Last 7 days
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setFrom(istDaysAgo(29)); setTo(istToday()); }}>
            Last 30 days
          </button>
        </div>
      </div>

      {error ? <ErrorNote message={error} /> : null}
      {!report && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {report ? (
        <div className={loading ? 'opacity-60' : ''}>
          {!report.gateway.configured ? (
            <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              No payment provider is configured on this deployment, so every payment is a manual
              record.{' '}
              {nothingToReconcile
                ? 'Nothing in this range went through a gateway, so there is nothing to reconcile.'
                : 'The rows below are gateway history from when a provider was configured. Switching one off does not settle what it still owes.'}
            </div>
          ) : (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              Provider: <span className="font-bold">{report.gateway.provider}</span> — figures below
              cover provider-side attempts and signature-verified deliveries in this range.
            </div>
          )}

          {nothingToReconcile ? (
            <EmptyState
              icon={ListChecks}
              title="Nothing to reconcile"
              note="This report fills in once a provider is live and takes its first payment. Until then there are no intents, deliveries or gateway refunds to count, and showing zeros would suggest a gateway had been checked and found clean."
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  icon={BadgeCheck}
                  label="Settled intents"
                  value={sum.settledIntents}
                  hint="provider confirmed these by webhook"
                  accent="green"
                />
                <StatCard
                  icon={Timer}
                  label="Open intents"
                  value={sum.openIntents}
                  hint="asked for, not yet answered"
                  accent={sum.openIntents > 0 ? 'orange' : 'slate'}
                />
                <StatCard
                  icon={AlertTriangle}
                  label="Exceptions"
                  value={sum.exceptions}
                  hint="rows a human should look at"
                  accent={sum.exceptions > 0 ? 'orange' : 'green'}
                />
                <StatCard
                  icon={RotateCcw}
                  label="Refunds awaiting provider"
                  value={sum.refundsAwaitingProvider}
                  hint={`rejected by provider: ${sum.refundsRejectedByProvider}`}
                  accent={sum.refundsAwaitingProvider > 0 ? 'orange' : 'slate'}
                />
                {/* Its own card, never folded into the one above: an unconfirmed
                    refund is the state that costs money if it is retried blind. */}
                <StatCard
                  icon={HelpCircle}
                  label="Refunds unconfirmed"
                  value={sum.refundsUnconfirmedByProvider}
                  hint="sent, no answer — reconcile, never re-refund"
                  accent={sum.refundsUnconfirmedByProvider > 0 ? 'red' : 'slate'}
                />
              </div>

              <div className="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
                <span className="font-semibold text-pos-ink">Signature failures:</span>
                {sum.signatureFailures === null ? (
                  <span className="text-slate-500">
                    — not attributable to one company; ask VEXO for the deployment-wide figure
                  </span>
                ) : (
                  <span className={sum.signatureFailures > 0 ? 'font-bold text-red-600' : 'text-slate-600'}>
                    {sum.signatureFailures}
                  </span>
                )}
                {ex.unprocessedEvents > 0 ? (
                  <span className="font-bold text-red-600">
                    {ex.unprocessedEvents} recorded event{ex.unprocessedEvents === 1 ? '' : 's'} never
                    applied — this should be impossible; contact VEXO
                  </span>
                ) : null}
              </div>

              {sum.exceptions === 0 ? (
                <div className="card mt-4 flex items-center gap-3 border border-emerald-200 bg-emerald-50/50 px-5 py-4 text-sm text-emerald-800">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  Nothing to chase in this range: every settled intent has its payment, no verified
                  delivery was refused, and no refund is waiting on the provider.
                </div>
              ) : null}
            </>
          )}

          {ex.openIntents.length > 0 ? (
            <Section title="Open intents — asked for, never answered" tone="amber">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Invoice</Th>
                    <Th>Order status</Th>
                    <Th>Intent status</Th>
                    <Th right>Amount</Th>
                    <Th right>Opened</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.openIntents.map((i) => (
                    <tr key={i.intentId} className="border-t border-slate-100">
                      <Td bold>{i.invoiceNumber || '—'}</Td>
                      <Td>{i.orderStatus}</Td>
                      <Td>{i.status}</Td>
                      <Td right bold>{fmtINR(i.amount)}</Td>
                      <Td right>{fmtDateTime(i.createdAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                The customer may have paid and the confirmation may not have arrived yet — these are
                the rows to chase with the provider before recording anything by hand.
              </p>
            </Section>
          ) : null}

          {ex.refundsAwaitingProvider.length > 0 ? (
            <Section title="Refunds awaiting the provider" tone="amber">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Invoice</Th>
                    <Th>Reason</Th>
                    <Th right>Amount</Th>
                    <Th right>Requested</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.refundsAwaitingProvider.map((r) => (
                    <tr key={r.refundId} className="border-t border-slate-100">
                      <Td bold>{r.invoiceNumber || '—'}</Td>
                      <Td>{r.reason}</Td>
                      <Td right bold>{fmtINR(r.amount)}</Td>
                      <Td right>{fmtDateTime(r.requestedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                The customer was promised this money and has not received it yet. Nothing here is
                shown as refunded anywhere in the POS until the provider confirms the payout.
              </p>
            </Section>
          ) : null}

          {ex.refundsUnconfirmedByProvider.length > 0 ? (
            <Section title="Refunds sent to the provider with no answer" tone="red">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Invoice</Th>
                    <Th>Reason</Th>
                    <Th>What happened</Th>
                    <Th right>Amount</Th>
                    <Th right>Requested</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.refundsUnconfirmedByProvider.map((r) => (
                    <tr key={r.refundId} className="border-t border-slate-100">
                      <Td bold>{r.invoiceNumber || '—'}</Td>
                      <Td>{r.reason}</Td>
                      <Td>{r.failureReason || '—'}</Td>
                      <Td right bold>{fmtINR(r.amount)}</Td>
                      <Td right>{fmtDateTime(r.requestedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                The provider never acknowledged these requests, so whether they are paying out is
                unknown. Reconcile each one from its order screen — that re-sends the SAME request
                under its original idempotency key. Raising a fresh refund here could pay the
                customer twice.
              </p>
            </Section>
          ) : null}

          {ex.refundsRejectedByProvider.length > 0 ? (
            <Section title="Refunds the provider refused" tone="red">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Invoice</Th>
                    <Th>Reason</Th>
                    <Th>Provider says</Th>
                    <Th right>Amount</Th>
                    <Th right>Requested</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.refundsRejectedByProvider.map((r) => (
                    <tr key={r.refundId} className="border-t border-slate-100">
                      <Td bold>{r.invoiceNumber || '—'}</Td>
                      <Td>{r.reason}</Td>
                      <Td>{r.failureReason || '—'}</Td>
                      <Td right bold>{fmtINR(r.amount)}</Td>
                      <Td right>{fmtDateTime(r.requestedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                The customer is still owed this money; somebody has to make it right by hand.
              </p>
            </Section>
          ) : null}

          {ex.verifiedButNotApplied.length > 0 ? (
            <Section title="Verified deliveries that changed nothing" tone="amber">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Event</Th>
                    <Th>Kind</Th>
                    <Th>Reason it was not applied</Th>
                    <Th right>Received</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.verifiedButNotApplied.map((e) => (
                    <tr key={e.eventId} className="border-t border-slate-100">
                      <Td bold>{e.eventId}</Td>
                      <Td>{e.kind}</Td>
                      <Td>{e.reason}</Td>
                      <Td right>{fmtDateTime(e.receivedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                Genuine, signature-verified deliveries the system deliberately refused to apply —
                each reason is stored, and a discrepancy a human must judge is not an error the
                provider can fix by retrying.
              </p>
            </Section>
          ) : null}

          {ex.settledWithoutPayment.length > 0 ? (
            <Section title="Settled intents with no payment row" tone="red">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Invoice</Th>
                    <Th>Intent</Th>
                    <Th right>Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.settledWithoutPayment.map((i) => (
                    <tr key={i.intentId} className="border-t border-slate-100">
                      <Td bold>{i.invoiceNumber || '—'}</Td>
                      <Td>{i.intentId}</Td>
                      <Td right bold>{fmtINR(i.amount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}

          {ex.gatewayPaymentsWithoutIntent.length > 0 ? (
            <Section title="Gateway payments with no intent behind them" tone="red">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Payment</Th>
                    <Th>Order</Th>
                    <Th right>Amount</Th>
                    <Th right>Recorded</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.gatewayPaymentsWithoutIntent.map((p) => (
                    <tr key={p.paymentId} className="border-t border-slate-100">
                      <Td bold>{p.paymentId}</Td>
                      <Td>{p.orderId}</Td>
                      <Td right bold>{fmtINR(p.amount)}</Td>
                      <Td right>{fmtDateTime(p.createdAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">This should be impossible — contact VEXO.</p>
            </Section>
          ) : null}

          {ex.amountMismatches.length > 0 ? (
            <Section title="Intent and payment disagree on the amount" tone="red">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <Th>Invoice</Th>
                    <Th right>Intent amount</Th>
                    <Th right>Paid amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {ex.amountMismatches.map((m) => (
                    <tr key={m.intentId} className="border-t border-slate-100">
                      <Td bold>{m.invoiceNumber || '—'}</Td>
                      <Td right>{fmtINR(m.intentAmount)}</Td>
                      <Td right bold>{fmtINR(m.paidAmount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}

          {/* §13: render the note verbatim — it explains signature failures,
              which only exist on a deployment that has a provider to fail. */}
          {nothingToReconcile ? null : (
            <p className="mt-4 text-xs leading-relaxed text-slate-500">{report.note}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
