import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  CalendarCheck,
  CreditCard,
  Lock,
  Wallet,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, PageHeader, StatCard } from '../components/ui.jsx';
import { useToast } from '../components/toast.jsx';
import { fmtDateTime, fmtINR, getAtcScope, isAtc, istDaysAgo, istToday } from '../lib/pos.js';

// /reports/day-close — the end-of-day cash count.
//
// Every other report on this site shows the POS its own reflection. This is
// the one screen where a person tells the POS something it did not already
// know, so it is the only screen that can disagree with it. The design
// follows from that:
//
//   * the expected figure is shown BEFORE the box to type the count into. A
//     count taken blind is a better audit but a worse day — the cashier
//     cannot recheck a drawer they have already handed over — and the honest
//     purpose here is finding a mistake tonight, not catching a thief;
//   * the opening float has its own box. Everybody counts the float along
//     with the takings, and silently treating that as a surplus would teach
//     staff that the variance figure is noise;
//   * a variance cannot be filed without a note. The server enforces it; this
//     form just says so early rather than letting someone press the button
//     and be refused;
//   * a day that already has a closing does not offer the button again. It
//     offers a CORRECTION, which is a different thing with a different
//     record, because a second closing filed by accident is indistinguishable
//     from one filed to bury the first.

const variancePhrase = (v) => {
  if (v === 0) return 'balances exactly';
  return v > 0 ? `${fmtINR(Math.abs(v))} MORE than expected` : `${fmtINR(Math.abs(v))} SHORT`;
};

export default function DayClose() {
  const { user } = useAuth();
  const toast = useToast();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const [date, setDate] = useState(istToday());
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState([]);
  const [preview, setPreview] = useState(null);
  const [existing, setExisting] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [countedCash, setCountedCash] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Owners and ATC pick a branch; a pinned manager has one and the server
  // ignores anything they send. Cash lives in a specific till.
  const needsBranch = owner || atc;

  useEffect(() => {
    if (!needsBranch) return;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        const active = (data.branches || []).filter((b) => b.status === 'ACTIVE');
        setBranches(active);
        if (active.length === 1) setBranchId(active[0].id);
      } catch {
        // The branch picker is a convenience; the server is the authority.
      }
    })();
  }, [needsBranch]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    if (needsBranch && !branchId) { setPreview(null); return; }
    setLoading(true);
    setError('');
    try {
      const params = { date };
      if (branchId) params.branchId = branchId;
      const { data } = await api.get('/reports/day-close/preview', { params });
      setPreview(data.preview);
      setExisting(data.existingClose);

      const hist = await api.get('/reports/day-close', {
        params: { from: istDaysAgo(29), to: istToday(), ...(branchId ? { branchId } : {}) },
      });
      setHistory(hist.data);
    } catch (err) {
      setError(apiError(err, 'Could not load the day’s figures'));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [atc, atcScope, date, branchId, needsBranch]);

  useEffect(() => { load(); }, [load]);

  // Live variance, computed the same way the server will: counted, less the
  // float, less what the system expected. Shown as the person types so the
  // number is never a surprise produced by pressing Save.
  const counted = Number(countedCash);
  const float = Number(openingFloat || 0);
  const typed = countedCash !== '' && Number.isFinite(counted) && Number.isFinite(float);
  const variance = typed && preview ? Math.round((counted - float - preview.expectedCash) * 100) / 100 : null;
  const needsNote = variance !== null && variance !== 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!preview || !typed) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/reports/day-close', {
        date: preview.businessDate,
        ...(branchId ? { branchId } : {}),
        countedCash: counted,
        openingFloat: float,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(existing ? { correctsId: existing.id } : {}),
      });
      toast.push(
        data.close.variance === 0
          ? `${preview.businessDate} closed — the drawer balances`
          : `${preview.businessDate} closed — ${variancePhrase(data.close.variance)}`,
        data.close.variance === 0 ? 'success' : 'info',
      );
      setCountedCash('');
      setOpeningFloat('');
      setNote('');
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not file the closing'));
    } finally {
      setSaving(false);
    }
  };

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Daily closing" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={CalendarCheck}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Daily closing"
        subtitle={atcScope ? `Company: ${atcScope.name || atcScope.id}` : 'Count the drawer and close the day'}
      />

      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="dc-date">Business day (IST)</label>
          <input
            id="dc-date"
            type="date"
            className="input"
            max={istToday()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {needsBranch ? (
          <div>
            <label className="label" htmlFor="dc-branch">Branch</label>
            <select id="dc-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Choose a branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDate(istToday())}>
          Today
        </button>
      </div>

      {error ? <ErrorNote message={error} /> : null}

      {needsBranch && !branchId ? (
        <EmptyState
          icon={Banknote}
          title="Choose a branch"
          note="A cash drawer belongs to one branch, so a closing is filed against one branch rather than the whole company."
        />
      ) : null}

      {preview ? (
        <div className={loading ? 'opacity-60' : ''}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={Wallet}
              label="Expected in drawer"
              value={fmtINR(preview.expectedCash)}
              hint="cash taken less cash refunded — excludes your opening float"
              accent="royal"
            />
            <StatCard
              icon={Banknote}
              label="Cash taken"
              value={fmtINR(preview.cashSales)}
              hint={`cash refunded ${fmtINR(preview.cashRefunds)}`}
              accent="green"
            />
            <StatCard
              icon={CreditCard}
              label="Card, UPI & online"
              value={fmtINR(preview.cardSales + preview.upiSales + preview.otherSales + preview.gatewaySales)}
              hint="settled by bank or provider — not counted in the drawer"
              accent="slate"
            />
            <StatCard
              icon={CalendarCheck}
              label="Bills issued"
              value={String(preview.ordersBilled)}
              hint={preview.openOrders ? `${preview.openOrders} order(s) still open` : 'nothing left open'}
              accent={preview.openOrders ? 'orange' : 'slate'}
            />
          </div>

          {preview.openOrders ? (
            <div className="card mt-4 flex items-start gap-3 border-l-4 border-pos-orange px-5 py-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-pos-ember" />
              <p className="text-sm text-slate-700">
                <strong>{preview.openOrders} order{preview.openOrders === 1 ? '' : 's'} still open.</strong>{' '}
                They have not been billed, so nothing from them is in the figures above. Closing now is fine —
                whatever they take will land on the day they are billed.
              </p>
            </div>
          ) : null}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {atc ? (
              // The server refuses ATC this POST, so the form is not shown
              // rather than shown and refused. ATC did not count this drawer
              // and a closing filed under an ATC name would misattribute who
              // is answerable for the cash.
              <div className="card p-5">
                <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">Count the drawer</h2>
                <p className="mb-4 text-xs text-slate-500">{preview.note}</p>
                {existing ? (
                  <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                    Closed by {existing.closedBy?.fullName || 'someone'} at {fmtDateTime(existing.closedAt)} —
                    counted {fmtINR(existing.countedCash)}, {variancePhrase(existing.variance)}.
                    {existing.note ? <> Note: “{existing.note}”</> : null}
                  </div>
                ) : (
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Not closed yet for this day.
                  </div>
                )}
                <p className="mt-4 flex items-start gap-2 text-xs text-slate-400">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  VEXO support can read closings but cannot file one. The count is the branch’s own record of
                  its cash, so it is filed by the manager or the owner.
                </p>
              </div>
            ) : (
            <form className="card p-5" onSubmit={submit}>
              <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">
                {existing ? 'File a correction' : 'Count the drawer'}
              </h2>
              <p className="mb-4 text-xs text-slate-500">{preview.note}</p>

              {existing ? (
                <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  This day was already closed by {existing.closedBy?.fullName || 'someone'} at{' '}
                  {fmtDateTime(existing.closedAt)} — counted {fmtINR(existing.countedCash)},{' '}
                  {variancePhrase(existing.variance)}. Filing again records a <strong>correction</strong>;
                  the original stays on the record.
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="dc-counted">Cash counted in drawer</label>
                  <input
                    id="dc-counted"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    className="input"
                    placeholder="0.00"
                    value={countedCash}
                    onChange={(e) => setCountedCash(e.target.value)}
                    required
                  />
                  <p className="mt-1 text-xs text-slate-400">Everything in the till, float included.</p>
                </div>
                <div>
                  <label className="label" htmlFor="dc-float">Opening float</label>
                  <input
                    id="dc-float"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    className="input"
                    placeholder="0.00"
                    value={openingFloat}
                    onChange={(e) => setOpeningFloat(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-slate-400">The change you started the day with.</p>
                </div>
              </div>

              {variance !== null ? (
                <div
                  className={`mt-4 rounded-lg px-4 py-3 ${
                    variance === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-bold">
                    {variance === 0 ? <BadgeCheck className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
                    The drawer {variancePhrase(variance)}
                  </div>
                  {variance !== 0 ? (
                    <p className="mt-1 text-xs">
                      Recount before filing. If the figure is right, say what happened — the note is stored with
                      the closing and is what the owner reads later.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-4">
                <label className="label" htmlFor="dc-note">
                  Note {needsNote ? <span className="text-red-600">(required — the count does not balance)</span> : '(optional)'}
                </label>
                <textarea
                  id="dc-note"
                  className="input min-h-[72px]"
                  placeholder={needsNote ? 'e.g. 100 left in the tip jar, counted again and confirmed' : 'Anything worth recording about today'}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required={needsNote}
                />
              </div>

              <button
                type="submit"
                className="btn-primary mt-4 w-full"
                disabled={saving || !typed || (needsNote && !note.trim())}
              >
                <Lock className="mr-2 h-4 w-4" />
                {saving ? 'Filing…' : existing ? 'File correction' : `Close ${preview.businessDate}`}
              </button>
              <p className="mt-2 text-center text-xs text-slate-400">
                A closing cannot be edited afterwards. A mistake is fixed with a correction, which keeps both.
              </p>
            </form>
            )}

            <div className="card p-5">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Last 30 days</h2>
              {!history || history.closes.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No days closed yet.</p>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
                    <span><strong>{history.totals.days}</strong> day(s) closed</span>
                    <span className="text-red-700"><strong>{history.totals.shortDays}</strong> short</span>
                    <span className="text-amber-700"><strong>{history.totals.overDays}</strong> over</span>
                    <span>net variance <strong>{fmtINR(history.totals.variance)}</strong></span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                        <th className="pb-2">Day</th>
                        <th className="pb-2 text-right">Expected</th>
                        <th className="pb-2 text-right">Counted</th>
                        <th className="pb-2 text-right">Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.closes.map((c) => (
                        <tr key={c.id} className="border-t border-slate-100 align-top">
                          <td className="py-2">
                            <span className="font-semibold text-pos-ink">{c.businessDate}</span>
                            {c.isCorrection ? (
                              <span className="badge ml-1.5 bg-amber-100 text-amber-800">corrected</span>
                            ) : null}
                            {c.note ? <p className="mt-0.5 text-xs text-slate-500">{c.note}</p> : null}
                            <p className="text-xs text-slate-400">
                              {c.closedBy?.fullName || '—'} · {fmtDateTime(c.closedAt)}
                            </p>
                          </td>
                          <td className="py-2 text-right text-slate-600">{fmtINR(c.expectedCash)}</td>
                          <td className="py-2 text-right text-slate-600">{fmtINR(c.countedCash)}</td>
                          <td
                            className={`py-2 text-right font-semibold ${
                              c.variance === 0
                                ? 'text-emerald-700'
                                : c.variance < 0
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }`}
                          >
                            {c.variance > 0 ? '+' : ''}{fmtINR(c.variance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
