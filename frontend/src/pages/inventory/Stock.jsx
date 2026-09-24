// What is where, in the six states §4 insists are kept apart.
//
// A single "quantity" column is what this screen exists to refuse. Physical is
// the shelf; blocked is the part of the shelf nobody may touch; usable is the
// difference; reserved is usable stock already promised; available is what a
// new request can actually draw on. A screen that collapses those into one
// number is a screen that lets somebody promise expired stock.

import { useMemo, useState } from 'react';
import { Boxes, IndianRupee, Search, TriangleAlert } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner } from '../../components/ui.jsx';
import {
  Callout,
  ErrorNote,
  Field,
  LocationSelect,
  RefreshButton,
  STOCK_STATE_HEAD,
  StockStateCells,
  Table,
  Td,
  Toolbar,
  useInventory,
  useLocations,
} from '../../components/inventory.jsx';
import { fmtDateTime } from '../../lib/pos.js';
import { COST_UNKNOWN, fmtCost, fmtPaise, fmtQty, ITEM_KIND_LABEL, unitLabel } from '../../lib/inventory.js';

export default function InventoryStock() {
  const { locations, error: locError } = useLocations();
  const [locationId, setLocationId] = useState('');
  const [q, setQ] = useState('');
  const [belowMin, setBelowMin] = useState(false);

  const params = useMemo(
    () => ({
      ...(locationId ? { locationId } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(belowMin ? { belowMin: 'true' } : {}),
    }),
    [locationId, q, belowMin],
  );
  const { data, error, loading, reload } = useInventory('/inventory/stock', { params });

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || locError || 'Could not load stock'} />;

  const rows = data.rows ?? [];
  const short = rows.filter((r) => r.belowMin);
  // Counted, not summed: the value total is the server's, because §3 of the
  // shared contract says the client never computes money and a valuation is
  // the most tempting place to break that.
  const unvalued = rows.filter((r) => r.unitCostPaise === null && r.physical !== '0.000');

  return (
    <div>
      <PageHeader
        title="Stock on hand"
        subtitle={`As at ${fmtDateTime(data.asOf)} · ${rows.length} position${rows.length === 1 ? '' : 's'}`}
        actions={<RefreshButton loading={loading} onClick={reload} />}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard icon={IndianRupee} label="Value shown" value={fmtPaise(data.totalValuePaise)} hint="Of the rows below" accent="royal" />
        <StatCard
          icon={TriangleAlert}
          label="Below minimum"
          value={short.length}
          hint="Against an active plan minimum"
          accent={short.length ? 'orange' : 'slate'}
        />
        <StatCard
          icon={Boxes}
          label="Not valued"
          value={unvalued.length}
          hint={unvalued.length ? 'Shown as cost not known, never as zero' : 'Every position with stock has a cost'}
          accent={unvalued.length ? 'orange' : 'slate'}
        />
      </div>

      {unvalued.length ? (
        <Callout tone="amber" title="Some stock has no cost the ledger can stand behind">
          {unvalued.length} position{unvalued.length === 1 ? '' : 's'} below read "{COST_UNKNOWN}". That is
          deliberate: a position that has never taken a valued receipt has no average cost, and printing
          ₹0.00 there would turn unknown cost into free stock and inflate every profit figure built on it.
        </Callout>
      ) : null}

      <Toolbar>
        <Field label="Location" htmlFor="stock-loc">
          <LocationSelect id="stock-loc" value={locationId} onChange={setLocationId} locations={locations} />
        </Field>
        <Field label="Item" htmlFor="stock-q">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="stock-q"
              className="input pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name"
            />
          </div>
        </Field>
        <Field label="Filter" htmlFor="stock-below">
          <label className="flex h-[42px] items-center gap-2 text-sm text-slate-600">
            <input
              id="stock-below"
              type="checkbox"
              className="h-4 w-4"
              checked={belowMin}
              onChange={(e) => setBelowMin(e.target.checked)}
            />
            Below the plan minimum only
          </label>
        </Field>
        <div className="grow" />
      </Toolbar>

      <ErrorNote message={error} />

      <Table
        head={[
          'Item',
          'Location',
          ...STOCK_STATE_HEAD,
          { key: 'min', label: 'Min / target', right: true, help: 'From the active replenishment plan for this location.' },
          { key: 'cost', label: 'Unit cost', right: true, help: 'Perpetual weighted average at this location.' },
          { key: 'value', label: 'Value', right: true },
        ]}
        empty="No stock in scope"
        emptyNote="Either nothing has been received yet, or no location you can reach holds this item."
      >
        {rows.map((r) => (
          <tr key={`${r.location.id}:${r.item.id}`} className={r.belowMin ? 'bg-amber-50/50' : ''}>
            <Td>
              <div className="font-semibold text-pos-ink">{r.item.name}</div>
              <div className="text-xs text-slate-400">
                {ITEM_KIND_LABEL[r.item.kind] || r.item.kind}
                {r.item.sku ? ` · ${r.item.sku}` : ''} · stocked in {unitLabel(r.item.baseUnit)}
              </div>
            </Td>
            <Td>
              <div className="text-slate-700">{r.location.name}</div>
              <div className="text-xs text-slate-400">{r.location.code}</div>
            </Td>
            <StockStateCells row={r} baseUnit={r.item.baseUnit} />
            <Td right className="text-xs text-slate-500">
              {r.minQty ? (
                <>
                  {fmtQty(r.minQty)} / {fmtQty(r.targetQty)}
                  {r.belowMin ? <div className="font-semibold text-amber-700">below minimum</div> : null}
                </>
              ) : (
                <span className="text-slate-300">no plan</span>
              )}
            </Td>
            <Td right className={r.unitCostPaise === null ? 'text-xs font-semibold text-amber-700' : 'text-slate-600'}>
              {fmtCost(r.unitCostPaise)}
            </Td>
            <Td right className="font-semibold text-pos-ink">{fmtPaise(r.valuePaise)}</Td>
          </tr>
        ))}
      </Table>

      <p className="mt-3 text-xs text-slate-400">
        Unit cost is a perpetual weighted average held per location per item, and it is separate from the
        order stock physically leaves in. Which batch goes out is decided by earliest expiry first; what it
        costs is decided by this average. The two answer different questions and are never merged.
      </p>
    </div>
  );
}
