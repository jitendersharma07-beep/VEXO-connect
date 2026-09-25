// Stock between two places, and the arithmetic that proves it all arrived.
//
// Dispatched, accepted, damaged and short are four separately stored numbers.
// A settled transfer has dispatched = accepted + damaged + short, and the
// "unaccounted" column is what is left when it does not. That column exists to
// be zero; when it is not, the difference is shown rather than rounded away,
// because a transfer that quietly loses 200 g is how a shrinkage problem
// becomes invisible.

import { useMemo, useState } from 'react';
import { ArrowRight, ScaleIcon, Truck } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner } from '../../components/ui.jsx';
import {
  Badge,
  Callout,
  ErrorNote,
  Field,
  RefreshButton,
  Table,
  Td,
  Toolbar,
  useInventory,
} from '../../components/inventory.jsx';
import { fmtDateTime } from '../../lib/pos.js';
import { fmtPaise, fmtQty, TRANSFER_STATUS_STYLES } from '../../lib/inventory.js';

export default function InventoryTransfers() {
  const [status, setStatus] = useState('');
  const params = useMemo(() => (status ? { status } : {}), [status]);
  const { data, error, loading, reload } = useInventory('/inventory/transfers', { params });
  const recon = useInventory('/inventory/reports/transfer-reconciliation');

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || 'Could not load transfers'} />;

  const transfers = data.transfers ?? [];
  const inTransit = transfers.filter((t) => t.status === 'DISPATCHED');
  const reconRows = recon.data?.transfers ?? [];
  const unbalanced = reconRows.filter((t) => !t.balanced);

  return (
    <div>
      <PageHeader
        title="Transfers"
        subtitle="What has left, what has arrived, and what is still between the two"
        actions={
          <RefreshButton
            loading={loading}
            onClick={() => {
              reload();
              recon.reload();
            }}
          />
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={Truck}
          label="In transit"
          value={inTransit.length}
          hint="Dispatched, not yet accepted anywhere"
          accent={inTransit.length ? 'royal' : 'slate'}
        />
        <StatCard
          icon={ScaleIcon}
          label="Do not reconcile"
          value={unbalanced.length}
          hint="Dispatched does not equal accepted + damaged + short"
          accent={unbalanced.length ? 'red' : 'green'}
        />
        <StatCard icon={ArrowRight} label="Transfers shown" value={transfers.length} hint="Either end in your scope" accent="slate" />
      </div>

      {inTransit.length ? (
        <Callout tone="sky" icon={Truck} title={`${inTransit.length} transfer${inTransit.length === 1 ? '' : 's'} in transit`}>
          This stock has already left the source and has not yet increased anywhere. It is counted as
          in-transit and is deliberately in neither location's usable stock — the receiving store cannot
          promise it, and the sending warehouse has already given it up.
        </Callout>
      ) : null}

      {unbalanced.length ? (
        <Callout tone="red" title={`${unbalanced.length} transfer${unbalanced.length === 1 ? '' : 's'} do not add up`}>
          On these, what was dispatched is not equal to what was accepted plus what was recorded as
          damaged plus what was recorded as short. The difference is shown in the reconciliation table
          below rather than being absorbed into a total.
        </Callout>
      ) : null}

      <Toolbar>
        <Field label="Status" htmlFor="t-status">
          <select id="t-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="REQUESTED">Requested</option>
            <option value="DISPATCHED">In transit</option>
            <option value="RECEIVED">Received</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </Field>
      </Toolbar>

      <ErrorNote message={error} />

      <Table
        head={['Transfer', 'Route', 'Status', 'Dispatched', 'Received', { key: 'l', label: 'Lines', right: true }]}
        empty="No transfers"
        emptyNote="A transfer is created when an approved request is dispatched."
      >
        {transfers.map((t) => (
          <tr key={t.id}>
            <Td>
              <div className="font-semibold text-pos-ink">{t.number}</div>
              {t.note ? <div className="max-w-[14rem] text-xs text-slate-400">{t.note}</div> : null}
            </Td>
            <Td className="text-xs text-slate-600">
              {t.fromLocation?.name}
              <ArrowRight className="mx-1 inline h-3 w-3 text-slate-300" />
              {t.toLocation?.name}
            </Td>
            <Td>
              <Badge map={TRANSFER_STATUS_STYLES} value={t.status} />
            </Td>
            <Td className="text-xs text-slate-600">{fmtDateTime(t.dispatchedAt)}</Td>
            <Td className="text-xs text-slate-600">{fmtDateTime(t.receivedAt)}</Td>
            <Td right>{t.lines.length}</Td>
          </tr>
        ))}
      </Table>

      <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">
        Reconciliation — both sides of every transfer
      </h2>
      <ErrorNote message={recon.error} />
      <Table
        head={[
          'Transfer',
          'Item',
          { key: 'd', label: 'Dispatched', right: true },
          { key: 'a', label: 'Accepted', right: true },
          { key: 'dm', label: 'Damaged', right: true },
          { key: 's', label: 'Short', right: true },
          { key: 'u', label: 'Unaccounted', right: true, help: 'Dispatched minus accepted, damaged and short. Should be zero.' },
          { key: 'v', label: 'Value out', right: true },
        ]}
        empty="Nothing to reconcile yet"
      >
        {reconRows.flatMap((t) =>
          t.lines.map((l, idx) => (
            <tr key={`${t.id}:${l.item?.id ?? idx}`} className={t.balanced ? '' : 'bg-red-50/40'}>
              <Td>
                {idx === 0 ? (
                  <>
                    <div className="font-semibold text-pos-ink">{t.number}</div>
                    <div className="text-xs text-slate-400">
                      {t.from?.name} to {t.to?.name}
                    </div>
                  </>
                ) : null}
              </Td>
              <Td className="text-slate-700">{l.item?.name}</Td>
              <Td right className="text-slate-500">{fmtQty(l.dispatched, l.item?.baseUnit)}</Td>
              <Td right className="font-semibold text-emerald-700">{fmtQty(l.accepted, l.item?.baseUnit)}</Td>
              <Td right className="text-red-600">{fmtQty(l.damaged, l.item?.baseUnit)}</Td>
              <Td right className="text-amber-700">{fmtQty(l.shortage, l.item?.baseUnit)}</Td>
              <Td right className={l.unaccounted === '0.000' ? 'text-slate-300' : 'font-bold text-red-600'}>
                {fmtQty(l.unaccounted, l.item?.baseUnit)}
              </Td>
              <Td right className="text-slate-600">
                {idx === 0 ? fmtPaise(t.valueDispatchedPaise) : null}
              </Td>
            </tr>
          )),
        )}
      </Table>
    </div>
  );
}
