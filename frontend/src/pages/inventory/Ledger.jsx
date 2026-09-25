// The ledger itself, and the proof that the fast numbers agree with it.
//
// §4 says every stock change is an attributable movement. This screen is where
// that claim is cashed: one row per movement, newest first, each naming what
// caused it and the position it left behind. StockBalance is a cache; the
// ledger is the record. "Check the two agree" is read-only and anyone with
// ledger sight may run it — rewriting the cache from the ledger is the owner's,
// because it is the one button on this screen that writes.

import { useMemo, useState } from 'react';
import { BookOpen, ScrollText, ShieldCheck, Wrench } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner } from '../../components/ui.jsx';
import {
  ActionButton,
  Actor,
  Badge,
  Callout,
  ErrorNote,
  Field,
  ItemSelect,
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
import { fmtDateTime } from '../../lib/pos.js';
import {
  COST_STATUS_STYLES,
  fmtCost,
  fmtPaise,
  fmtQty,
  isInventoryOwner,
  movementLabel,
  MOVEMENT_LABEL,
  qtyIsNegative,
} from '../../lib/inventory.js';

// What a movement points back at. The ledger stores sourceType/sourceId rather
// than a foreign key per cause, so this is the only place that turns the pair
// into words — and when it is a type nobody has taught it yet, it says so
// instead of inventing a sentence.
// These are the exact strings the routers write — grep sourceType across
// backend/src to confirm before adding one. A label invented for a source the
// server never emits is a row that will never render it.
const SOURCE_LABEL = {
  GRN: 'a delivery',
  PURCHASE_RETURN: 'a return to the supplier',
  TRANSFER: 'a transfer',
  STORE_REQUEST_LINE: 'a store request',
  STOCK_COUNT: 'a stock count',
  WASTAGE: 'a write-off',
  ORDER_ITEM: 'a sold item',
  SALE_RETURN: 'a returned sale',
};

// Postings the till and the scheduler make on their own. These legitimately
// have no signed-in person, so the row says the machine did it rather than
// leaving a blank that reads like a missing audit trail.
const AUTOMATIC_SOURCES = new Set(['ORDER_ITEM', 'SALE_RETURN']);

function MovementRow({ m }) {
  const negative = qtyIsNegative(m.qty);
  return (
    <tr className="align-top">
      <Td className="text-xs text-slate-500">
        <div>{fmtDateTime(m.occurredAt)}</div>
        <div className="text-slate-300">#{m.seq}</div>
      </Td>
      <Td>
        <div className="font-semibold text-pos-ink">{movementLabel(m.type)}</div>
        <div className="text-xs text-slate-400">
          {SOURCE_LABEL[m.sourceType] || m.sourceType || 'no source recorded'}
        </div>
      </Td>
      <Td className="text-xs">
        <Actor
          actor={m.createdBy}
          absent={AUTOMATIC_SOURCES.has(m.sourceType) ? 'posted automatically' : 'no person recorded'}
        />
        {/* The till, when there was one. Only a sale has one — a delivery, a
            count, a transfer and the scheduler are not rung up anywhere — so
            this line appears on the rows where it means something and is
            absent, rather than blank, on the rest. */}
        {m.terminal ? (
          <div className="text-slate-400">
            at {m.terminal.name} <span className="text-slate-300">({m.terminal.code})</span>
          </div>
        ) : null}
      </Td>
      <Td className="text-xs text-slate-600">{m.location?.name}</Td>
      <Td>
        <div className="text-sm text-slate-700">{m.item?.name}</div>
        {m.batch ? <div className="text-xs text-slate-400">batch {m.batch.batchCode}</div> : null}
      </Td>
      <Td right className={`font-bold tabular-nums ${negative ? 'text-red-600' : 'text-emerald-700'}`}>
        {fmtQty(m.qty, m.item?.baseUnit)}
      </Td>
      <Td right className="tabular-nums text-slate-600">
        {fmtPaise(m.valuePaise)}
      </Td>
      <Td right className="tabular-nums text-xs text-slate-500">
        {fmtCost(m.unitCostPaise)}
        {m.costStatus && m.costStatus !== 'ACTUAL' ? (
          <div className={`badge mt-1 ${COST_STATUS_STYLES[m.costStatus]}`}>{m.costStatus}</div>
        ) : null}
      </Td>
      <Td right className="tabular-nums text-xs text-slate-500">
        <div>{fmtQty(m.balanceQtyAfter, m.item?.baseUnit)}</div>
        <div className="text-slate-400">{fmtPaise(m.balanceValueAfter)}</div>
      </Td>
    </tr>
  );
}

// Cache against ledger. Green here is a measurement, not a reassurance: the
// number of positions actually compared is printed next to it, so "ok" on an
// empty company reads as "nothing was checked" rather than as "all correct".
function CacheCheck({ owner, onRebuilt }) {
  const verify = useInventory('/inventory/ledger/verify');
  const { byId } = useLocations();
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const rebuild = async () => {
    setError('');
    setResult(null);
    try {
      const { data } = await api.post('/inventory/ledger/rebuild', {});
      setResult(data);
      await verify.reload();
      await onRebuilt();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  const v = verify.data;
  const mismatches = v?.mismatches ?? [];

  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
            Do the running totals still match the ledger?
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Stock figures are served from a cache so a busy screen does not re-add years of movements.
            This compares that cache against the ledger itself. It only reads.
          </p>
        </div>
        <div className="flex gap-2">
          <RefreshButton loading={verify.loading} onClick={verify.reload} />
        </div>
      </div>

      <ErrorNote message={error || verify.error} />

      {v ? (
        v.ok ? (
          <Callout tone="slate" icon={ShieldCheck} title="The cache agrees with the ledger">
            {v.checked} position{v.checked === 1 ? '' : 's'} compared, none differing. If that count is
            zero, nothing has been stocked yet — it is not a clean bill of health for stock that does not
            exist.
          </Callout>
        ) : (
          <Callout tone="red" title={`${mismatches.length} position${mismatches.length === 1 ? '' : 's'} disagree`}>
            The cache and the ledger differ on these. The ledger is the record, so the fix is to rewrite
            the cache from it — never the other way round. Until that is done, the stock screen is
            showing the cached figure.
          </Callout>
        )
      ) : null}

      {mismatches.length ? (
        <div className="overflow-x-auto rounded-lg border border-red-100">
          <table className="w-full min-w-[30rem] text-xs">
            <thead className="bg-red-50 text-left font-semibold uppercase tracking-wide text-red-700">
              <tr>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Cache says</th>
                <th className="px-3 py-2 text-right">Ledger says</th>
                <th className="px-3 py-2 text-right">Cache value</th>
                <th className="px-3 py-2 text-right">Ledger value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-red-50">
              {mismatches.map((m) => (
                <tr key={`${m.locationId}:${m.itemId}`}>
                  <td className="px-3 py-2">{byId.get(m.locationId)?.name || m.locationId}</td>
                  <td className="px-3 py-2 text-slate-500">{m.itemId}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtQty(m.cache_qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtQty(m.ledger_qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPaise(m.cache_value)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPaise(m.ledger_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {result ? (
        <Callout
          tone={result.mismatchesAfter === 0 ? 'slate' : 'red'}
          icon={Wrench}
          title={
            result.mismatchesAfter === 0
              ? 'Rebuilt, and the two now agree'
              : `Rebuilt, but ${result.mismatchesAfter} position${result.mismatchesAfter === 1 ? '' : 's'} still differ`
          }
        >
          {result.mismatchesBefore} differed before, {result.mismatchesAfter} after. A difference that
          survives a rebuild is not a cache problem — it means the ledger itself disagrees with the
          cache for a reason the rebuild cannot invent away, and it needs looking at.
        </Callout>
      ) : null}

      {owner ? (
        <ActionButton
          className="btn-ghost mt-3"
          confirm="This rewrites the cached stock figures from the ledger. The ledger itself is not touched. Continue?"
          onClick={rebuild}
        >
          <Wrench className="h-4 w-4" /> Rewrite the cache from the ledger
        </ActionButton>
      ) : (
        <p className="mt-3 text-xs text-slate-400">
          Only the company owner can rewrite the cache. Checking it, which is what this panel does, needs
          no such permission — a read that tells you something is wrong should never be the restricted one.
        </p>
      )}
    </section>
  );
}

function Valuation() {
  const [asOf, setAsOf] = useState('');
  const [locationId, setLocationId] = useState('');
  const { locations } = useLocations();
  const params = useMemo(
    () => ({ ...(asOf ? { asOf: new Date(asOf).toISOString() } : {}), ...(locationId ? { locationId } : {}) }),
    [asOf, locationId],
  );
  const { data, error, loading, reload } = useInventory('/inventory/valuation', { params });
  const lines = data?.lines ?? [];

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">What the stock was worth</h2>
        <RefreshButton loading={loading} onClick={reload} />
      </div>

      <p className="mb-3 text-xs text-slate-500">
        This is replayed from the ledger rather than read from today's cache, which is why a valuation
        taken for last month can be taken again next year and give the same answer.
      </p>

      <Toolbar>
        <Field label="As at" htmlFor="val-asof">
          <input
            id="val-asof"
            type="datetime-local"
            className="input"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </Field>
        <Field label="Location" htmlFor="val-loc">
          <LocationSelect id="val-loc" value={locationId} onChange={setLocationId} locations={locations} />
        </Field>
      </Toolbar>

      <ErrorNote message={error} />

      {data ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          <StatCard
            icon={BookOpen}
            label="Stock value at that moment"
            value={fmtPaise(data.totalValuePaise)}
            hint={`${lines.length} position${lines.length === 1 ? '' : 's'} holding stock`}
            accent="royal"
          />
          <StatCard
            icon={ScrollText}
            label="Positions with no known cost"
            value={data.linesWithUnknownCost}
            hint={
              data.linesWithUnknownCost
                ? 'Counted separately, never folded into the total'
                : 'Every position carries a cost'
            }
            accent={data.linesWithUnknownCost ? 'orange' : 'slate'}
          />
        </div>
      ) : null}

      {data?.linesWithUnknownCost ? (
        <Callout tone="amber" title="This valuation is not complete, and says so">
          {data.linesWithUnknownCost} position{data.linesWithUnknownCost === 1 ? ' was' : 's were'} last
          touched by a movement with no cost behind it. Those quantities are real; their value is not
          known. The total above is the value of everything else, not a total that has quietly counted
          them as free.
        </Callout>
      ) : null}

      <Table
        head={[
          'Location',
          'Item',
          { key: 'q', label: 'Quantity', right: true },
          { key: 'v', label: 'Value', right: true },
          'Cost basis',
        ]}
        empty="Nothing held at that moment"
        emptyNote="Either no stock existed yet, or every position had been emptied by then."
      >
        {lines.map((l, i) => (
          <tr key={`${l.location?.id ?? i}:${l.item?.id ?? i}`}>
            <Td className="text-xs text-slate-600">{l.location?.name}</Td>
            <Td className="text-slate-700">{l.item?.name}</Td>
            <Td right className="tabular-nums">{fmtQty(l.qty, l.item?.baseUnit)}</Td>
            <Td right className="font-semibold tabular-nums">{fmtPaise(l.valuePaise)}</Td>
            <Td>
              <Badge map={COST_STATUS_STYLES} value={l.costStatus} />
            </Td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

export default function InventoryLedger() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const { locations } = useLocations();
  const items = useInventory('/inventory/items');

  const [locationId, setLocationId] = useState('');
  const [itemId, setItemId] = useState('');
  const [type, setType] = useState('');

  const params = useMemo(
    () => ({
      ...(locationId ? { locationId } : {}),
      ...(itemId ? { itemId } : {}),
      ...(type ? { type } : {}),
      limit: 100,
    }),
    [locationId, itemId, type],
  );
  const { data, error, loading, reload } = useInventory('/inventory/ledger', { params });

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || 'Could not load the ledger'} />;

  const movements = data.movements ?? [];

  return (
    <div>
      <PageHeader
        title="Stock ledger"
        subtitle="Every change to stock, what caused it, and what it left behind"
        actions={<RefreshButton loading={loading} onClick={reload} />}
      />

      <CacheCheck owner={owner} onRebuilt={reload} />

      <Toolbar>
        <Field label="Location" htmlFor="led-loc">
          <LocationSelect id="led-loc" value={locationId} onChange={setLocationId} locations={locations} />
        </Field>
        <Field label="Item" htmlFor="led-item">
          <ItemSelect id="led-item" value={itemId} onChange={setItemId} items={items.data?.items ?? []} />
        </Field>
        <Field label="Kind of movement" htmlFor="led-type">
          <select id="led-type" className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any kind</option>
            {Object.keys(MOVEMENT_LABEL).map((k) => (
              <option key={k} value={k}>
                {MOVEMENT_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
      </Toolbar>

      <ErrorNote message={error} />

      <Table
        head={[
          'When',
          'What happened',
          {
            key: 'who',
            label: 'Who',
            help: 'The signed-in person who posted it. Automatic postings name the process instead, so an unattended change is never shown as an anonymous one.',
          },
          'Where',
          'Item',
          { key: 'q', label: 'Change', right: true },
          { key: 'v', label: 'Value', right: true },
          { key: 'u', label: 'Unit cost', right: true },
          { key: 'b', label: 'Position after', right: true, help: 'The quantity and value this movement left behind at that location.' },
        ]}
        empty="No movements match"
        emptyNote="Stock only changes through a movement, so an empty ledger means nothing has moved."
      >
        {movements.map((m) => (
          <MovementRow key={m.id} m={m} />
        ))}
      </Table>

      {data.nextCursor ? (
        <p className="mt-3 text-xs text-slate-400">
          Showing the most recent {movements.length}. Narrow by location or item to reach older
          movements — the ledger is append-only and keeps everything.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-slate-400">
        Nothing here can be edited. A mistake is corrected by posting the opposite movement against it,
        so the original error and its correction are both permanently visible. That is the whole point of
        an append-only ledger: it is the difference between a figure that was fixed and a figure that was
        quietly changed.
      </p>

      <Valuation />
    </div>
  );
}
