// Batches, expiry, containment and traceability — §3 on one screen.
//
// The list is ordered earliest-expiry-first because that is the order stock is
// supposed to leave in, so the top of this table is what should be used next.
// Whether a batch is blocked is the server's answer, derived at read time by
// comparing expiry to today rather than read from a flag somebody has to set.
// That is what makes expired stock unavailable "even if the reminder scheduler
// is down": nothing has to have run for the comparison to be true.

import { useMemo, useState } from 'react';
import { Ban, PackageOpen, Search, ShieldCheck, Undo2 } from 'lucide-react';
import { PageHeader, FullScreenSpinner, Modal, ReasonModal } from '../../components/ui.jsx';
import {
  ActionButton,
  Badge,
  Callout,
  ErrorNote,
  Field,
  LocationSelect,
  RefreshButton,
  Table,
  Td,
  Toolbar,
  useInventory,
  useLocations,
} from '../../components/inventory.jsx';
import api, { apiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/pos.js';
import { BATCH_STATE_STYLES, blockLabel, fmtQty, isInventoryOwner, movementLabel, unitLabel } from '../../lib/inventory.js';

const daysUntil = (iso) => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.floor(ms / 86400000);
};

// The expiry column carries its own urgency. "12 Oct 2026" tells a person
// nothing they can act on; "in 3 days" does.
function ExpiryCell({ expiryDate, blockReason }) {
  if (!expiryDate) return <span className="text-xs text-slate-300">no expiry</span>;
  const d = daysUntil(expiryDate);
  const tone =
    blockReason === 'EXPIRED' ? 'text-red-600 font-semibold' : d <= 7 ? 'text-amber-700 font-semibold' : 'text-slate-600';
  return (
    <div>
      <div className={tone}>{fmtDate(expiryDate)}</div>
      <div className="text-xs text-slate-400">
        {d < 0 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago` : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}

// One batch, everywhere it has ever been. This is the answer to a recall
// notice, and it is read from the ledger rather than from a summary table, so
// it cannot be out of date with the stock it describes.
function TrailModal({ batchId, onClose }) {
  const { data, error, loading } = useInventory(`/inventory/batches/${batchId}/trail`, { skip: !batchId });
  return (
    <Modal open={Boolean(batchId)} title="Where this batch has been" onClose={onClose} wide>
      {loading && !data ? <div className="py-6 text-center text-sm text-slate-400">Loading…</div> : null}
      <ErrorNote message={error} />
      {data ? (
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="font-semibold text-pos-ink">
              {data.batch.batchCode} · {data.batch.item?.name}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {data.batch.supplier ? `From ${data.batch.supplier.name}. ` : ''}
              {data.batch.supplierBatchCode ? `Supplier code ${data.batch.supplierBatchCode}. ` : ''}
              Received {fmtDateTime(data.batch.receivedAt)}. Expires {fmtDate(data.batch.expiryDate)}.
            </div>
            {data.blockReason ? (
              <div className="mt-2 text-xs font-semibold text-red-600">
                Blocked: {blockLabel(data.blockReason)}
                {data.batch.stateReason ? ` — ${data.batch.stateReason}` : ''}
              </div>
            ) : null}
          </div>

          {data.openings?.length ? (
            <div>
              <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Containers opened</div>
              <ul className="space-y-1 text-xs text-slate-600">
                {data.openings.map((o) => (
                  <li key={o.id}>
                    {fmtQty(o.qty)} opened at {o.location?.name} on {fmtDateTime(o.openedAt)} — use by{' '}
                    <span className="font-semibold">{fmtDateTime(o.useByAt)}</span>
                    {o.closedAt ? ` (closed ${fmtDateTime(o.closedAt)})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">
              Every movement, oldest first
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-100">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {data.movements.map((m) => (
                    <tr key={m.id}>
                      <td className="px-3 py-2 text-slate-400">#{m.seq}</td>
                      <td className="px-3 py-2 font-semibold text-pos-ink">{movementLabel(m.type)}</td>
                      <td className="px-3 py-2 text-slate-600">{m.location?.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(m.qty)}</td>
                      <td className="px-3 py-2 text-slate-400">{fmtDateTime(m.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// Trace by the code printed on the carton, which is what a recall notice
// quotes — not by an internal id nobody in a kitchen has ever seen.
function TraceByCode() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const search = async () => {
    setError('');
    setResult(null);
    try {
      const { data } = await api.get('/inventory/reports/traceability', { params: { batchCode: code.trim() } });
      setResult(data);
    } catch (err) {
      setError(apiError(err, 'Could not trace that code'));
    }
  };
  return (
    <div className="card mb-5 p-4">
      <div className="mb-2 text-sm font-bold text-pos-ink">Trace a batch code</div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow">
          <label className="label" htmlFor="trace-code">Code on the carton, or the supplier's own code</label>
          <input id="trace-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="B7K2QX" />
        </div>
        <ActionButton className="btn-primary" onClick={search} disabled={code.trim().length < 2}>
          <Search className="h-4 w-4" /> Trace
        </ActionButton>
      </div>
      <ErrorNote message={error} />
      {result ? (
        <div className="mt-3 space-y-2 text-sm">
          {result.traces.map((t) => (
            <div key={t.batch.id} className="rounded-lg bg-slate-50 p-3">
              <div className="font-semibold text-pos-ink">
                {t.batch.batchCode} · {t.batch.item?.name}
                {t.batch.blockReason ? <span className="ml-2 text-xs text-red-600">{blockLabel(t.batch.blockReason)}</span> : null}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                Touched {t.touchedLocations.length} location{t.touchedLocations.length === 1 ? '' : 's'}:{' '}
                {t.touchedLocations.map((l) => l.name).join(', ') || 'none'} · {t.movements.length} movements
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function InventoryBatches() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const { locations } = useLocations();
  const [locationId, setLocationId] = useState('');
  const [expiring, setExpiring] = useState('');
  const [state, setState] = useState('');
  const [trailFor, setTrailFor] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);
  const [actionError, setActionError] = useState('');

  const params = useMemo(
    () => ({
      ...(locationId ? { locationId } : {}),
      ...(expiring ? { expiringInDays: expiring } : {}),
      ...(state ? { state } : {}),
    }),
    [locationId, expiring, state],
  );
  const { data, error, loading, reload } = useInventory('/inventory/batches', { params });

  const act = async (batchId, verb, reason) => {
    setActionError('');
    try {
      await api.post(`/inventory/batches/${batchId}/${verb}`, { reason });
      await reload();
    } catch (err) {
      setActionError(apiError(err));
      throw err;
    }
  };

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || 'Could not load batches'} />;

  const batches = data.batches ?? [];
  const blocked = batches.filter((b) => b.blockReason);

  return (
    <div>
      <PageHeader
        title="Batches and expiry"
        subtitle="Earliest expiry first — the order stock is meant to leave in"
        actions={<RefreshButton loading={loading} onClick={reload} />}
      />

      {blocked.length ? (
        <Callout tone="red" title={`${blocked.length} batch${blocked.length === 1 ? '' : 'es'} cannot be issued`}>
          Expired, recalled or quarantined stock is excluded from usable and available quantities at
          every location it sits in. It is blocked by the ledger itself, not by a reminder, so it stays
          blocked whether or not the background job is running.
        </Callout>
      ) : null}

      <TraceByCode />

      <Toolbar>
        <Field label="Location" htmlFor="b-loc">
          <LocationSelect id="b-loc" value={locationId} onChange={setLocationId} locations={locations} />
        </Field>
        <Field label="Expiring within" htmlFor="b-exp">
          <select id="b-exp" className="input" value={expiring} onChange={(e) => setExpiring(e.target.value)}>
            <option value="">Any expiry</option>
            <option value="3">3 days</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="0">Already expired</option>
          </select>
        </Field>
        <Field label="State" htmlFor="b-state">
          <select id="b-state" className="input" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            <option value="AVAILABLE">Available</option>
            <option value="QUARANTINED">Quarantined</option>
            <option value="RECALLED">Recalled</option>
          </select>
        </Field>
      </Toolbar>

      <ErrorNote message={actionError || error} />

      <Table
        head={[
          'Batch',
          'Item',
          'Expiry',
          'State',
          'Where it is',
          { key: 'act', label: '', right: true },
        ]}
        empty="No batches hold stock in scope"
        emptyNote="Batches with nothing left in them are not listed; use the trace box above to look one up by code."
      >
        {batches.map((b) => (
          <tr key={b.id} className={b.blockReason ? 'bg-red-50/40' : ''}>
            <Td>
              <button
                type="button"
                className="font-semibold text-pos-royal hover:underline"
                onClick={() => setTrailFor(b.id)}
              >
                {b.batchCode}
              </button>
              {b.supplierBatchCode ? (
                <div className="text-xs text-slate-400">supplier: {b.supplierBatchCode}</div>
              ) : null}
            </Td>
            <Td>
              <div className="text-slate-700">{b.item?.name}</div>
              <div className="text-xs text-slate-400">received {fmtDate(b.receivedAt)}</div>
            </Td>
            <Td>
              <ExpiryCell expiryDate={b.expiryDate} blockReason={b.blockReason} />
            </Td>
            <Td>
              <Badge map={BATCH_STATE_STYLES} value={b.state} />
              {b.blockReason ? (
                <div className="mt-1 text-xs font-semibold text-red-600">{blockLabel(b.blockReason)} — cannot be issued</div>
              ) : null}
              {b.stateReason ? <div className="mt-0.5 max-w-[16rem] text-xs text-slate-500">{b.stateReason}</div> : null}
            </Td>
            <Td>
              <div className="space-y-0.5 text-xs">
                {b.positions.map((p) => (
                  <div key={p.location.id}>
                    <span className="text-slate-500">{p.location.name}</span>{' '}
                    <span className="font-semibold tabular-nums text-pos-ink">
                      {fmtQty(p.qty, b.item?.baseUnit)}
                    </span>
                  </div>
                ))}
              </div>
            </Td>
            <Td right>
              <div className="flex justify-end gap-2">
                {b.state === 'AVAILABLE' ? (
                  <>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setReasonFor({ batch: b, verb: 'quarantine' })}
                      title="Stop this batch leaving the building"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" /> Quarantine
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs text-red-600"
                      onClick={() => setReasonFor({ batch: b, verb: 'recall' })}
                    >
                      <Ban className="h-3.5 w-3.5" /> Recall
                    </button>
                  </>
                ) : owner ? (
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => setReasonFor({ batch: b, verb: 'release' })}
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Release
                  </button>
                ) : (
                  // A manager stops a bad crate; only the owner decides it was
                  // fine after all. Saying so beats an absent button.
                  <span className="text-xs text-slate-400">owner releases</span>
                )}
              </div>
            </Td>
          </tr>
        ))}
      </Table>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-400">
        <PackageOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Opening a container starts a second, shorter clock on the part that was opened. Both the batch
        expiry and the opened-container use-by are shown on the trail, and the earlier of the two is the
        one that governs.
      </p>

      <TrailModal batchId={trailFor} onClose={() => setTrailFor(null)} />

      <ReasonModal
        open={Boolean(reasonFor)}
        title={
          reasonFor?.verb === 'quarantine'
            ? `Quarantine ${reasonFor?.batch?.batchCode}`
            : reasonFor?.verb === 'recall'
              ? `Recall ${reasonFor?.batch?.batchCode}`
              : `Release ${reasonFor?.batch?.batchCode}`
        }
        hint={
          reasonFor?.verb === 'release'
            ? 'Releasing puts this batch back into usable stock everywhere it sits. The reason is recorded against the batch.'
            : 'This blocks the batch at every location immediately. Stock stays physically where it is and stops being usable or available.'
        }
        busyLabel={reasonFor?.verb === 'release' ? 'Release batch' : 'Block batch'}
        onSubmit={(reason) => act(reasonFor.batch.id, reasonFor.verb, reason)}
        onClose={() => setReasonFor(null)}
      />
    </div>
  );
}
