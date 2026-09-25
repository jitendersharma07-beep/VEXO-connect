// What a dish is made of, and what selling it actually took off the shelf.
//
// Two §7 rules are load-bearing here and are stated on the screen rather than
// only in the code:
//
//   - A recipe is VERSIONED. Selling a dish records which version was in force
//     at the time, so last month's cost is not rewritten by today's recipe
//     change. Editing a recipe therefore creates a new version; it never edits
//     the old one.
//   - A missing cost is shown as missing. An UNCOSTED consumption is a real
//     deduction from stock whose money value is not known, and it is counted
//     separately so it can never be read as a zero-cost, full-margin sale.

import { useMemo, useState } from 'react';
import { ChefHat, CircleAlert, Layers, Receipt } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner, Modal } from '../../components/ui.jsx';
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
import { COST_STATUS_STYLES, fmtPaise, fmtQty } from '../../lib/inventory.js';

const VERSION_STYLES = {
  DRAFT: 'bg-slate-200 text-slate-600',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  RETIRED: 'bg-slate-200 text-slate-500',
};

const CONSUMPTION_STYLES = {
  POSTED: 'bg-emerald-100 text-emerald-700',
  UNCOSTED: 'bg-amber-100 text-amber-700',
};

// Why a deduction could not be valued. The server names the reason instead of
// leaving a zero behind, and the screen repeats the name it was given rather
// than flattening every case to "unknown".
// These are the four values in UNCOSTED in backend/src/lib/inventory/
// consumption.js, and nothing else is ever written to the column.
const UNCOSTED_LABEL = {
  NO_STOCK_LOCATION: 'this store has no stock location its sales come out of',
  NO_RECIPE: 'no recipe is linked to what was sold',
  NO_ACTIVE_VERSION: 'the recipe has no version in force',
  EMPTY_RECIPE: 'the recipe in force lists no ingredients',
};

function RecipeDetail({ recipe, onClose }) {
  const { data, error, loading } = useInventory(`/inventory/recipes/${recipe.id}`, { skip: !recipe });
  const r = data?.recipe ?? recipe;
  const versions = [...(r.versions ?? [])].sort((a, b) => b.version - a.version);

  return (
    <Modal open title={r.name} onClose={onClose} wide>
      <div className="space-y-4">
        {loading && !data ? <div className="py-4 text-center text-sm text-slate-400">Loading…</div> : null}
        <ErrorNote message={error} />

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600">
            {r.outputItem ? `Makes ${r.outputItem.name}` : 'Sold straight from the till, not stocked as an item'}
          </span>
          <span className="text-slate-400">
            · {(r.links ?? []).length} product{(r.links ?? []).length === 1 ? '' : 's'} linked
          </span>
        </div>

        {(r.links ?? []).length ? (
          <div className="flex flex-wrap gap-1">
            {r.links.map((l) => (
              <span key={l.id} className="badge bg-slate-100 text-slate-600">
                {l.product?.name || l.productId}
                {l.variantId ? ' · one variant' : ''}
              </span>
            ))}
          </div>
        ) : (
          <Callout tone="amber" icon={CircleAlert} title="Nothing sells this recipe yet">
            Until a product is linked, selling that product deducts no stock and is recorded as uncosted.
            The sale is never silently ignored — it is recorded as a sale the system could not value.
          </Callout>
        )}

        {versions.map((v) => (
          <div key={v.id} className="rounded-lg border border-slate-200">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm">
              <span className="font-bold text-pos-ink">Version {v.version}</span>
              <Badge map={VERSION_STYLES} value={v.status} />
              <span className="text-xs text-slate-500">
                makes {fmtQty(v.outputQty, r.outputItem?.baseUnit)} at {v.yieldPercent}% yield
              </span>
              <span className="ml-auto text-xs text-slate-400">
                {v.status === 'ACTIVE' && v.activatedAt
                  ? `in force since ${fmtDateTime(v.activatedAt)}`
                  : v.retiredAt
                    ? `retired ${fmtDateTime(v.retiredAt)}`
                    : `drafted ${fmtDateTime(v.createdAt)}`}
              </span>
            </div>
            <table className="w-full text-xs">
              <thead className="text-left font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ingredient</th>
                  <th className="px-3 py-2">Written as</th>
                  <th className="px-3 py-2 text-right">Taken from stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {v.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-semibold text-pos-ink">{l.item?.name}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {fmtQty(l.qty)} {l.unit}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.qtyBase, l.item?.baseUnit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {v.note ? <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">{v.note}</p> : null}
          </div>
        ))}

        <p className="text-xs text-slate-400">
          A retired version is kept, not deleted. Every sale points at the version that was in force when
          it happened, which is the only way last quarter's food cost can still be recalculated after the
          recipe has changed twice.
        </p>
      </div>
    </Modal>
  );
}

function Consumptions() {
  const [status, setStatus] = useState('');
  const params = useMemo(() => (status ? { status } : {}), [status]);
  const { data, error, loading, reload } = useInventory('/inventory/sales/consumptions', { params });
  const rows = data?.consumptions ?? [];
  const summary = data?.summary;

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">What selling took off the shelf</h2>
        <RefreshButton loading={loading} onClick={reload} />
      </div>

      <p className="mb-3 text-xs text-slate-500">
        One row per sold line, and one deduction per sold line. A bill that is printed, paid and
        reprinted still deducts once, because the deduction is tied to the sold line itself and not to
        the printing, the payment or the kitchen ticket.
      </p>

      {summary ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <StatCard
            icon={Receipt}
            label="Cost of what was sold"
            value={fmtPaise(summary.costPaise)}
            hint={`${summary.lines} sold line${summary.lines === 1 ? '' : 's'}`}
            accent="royal"
          />
          <StatCard
            icon={CircleAlert}
            label="Sold but not valued"
            value={summary.uncostedLines}
            hint={summary.uncostedLines ? 'Real sales the system could not cost' : 'Every sale carries a cost'}
            accent={summary.uncostedLines ? 'orange' : 'slate'}
          />
          <StatCard
            icon={Layers}
            label="Costed from an old price"
            value={summary.linesWithEstimatedCost}
            hint="Marked ESTIMATED, not ACTUAL"
            accent={summary.linesWithEstimatedCost ? 'orange' : 'slate'}
          />
        </div>
      ) : null}

      {summary?.uncostedLines || summary?.linesWithUnknownCost ? (
        <Callout tone="amber" title="Some sales have no cost the system can stand behind">
          These lines sold real food. What they cost is not known, so they are counted here instead of
          being added into the figure above as zero. A profit report built on this data has to subtract
          them or say it did not — presenting them as free is the one thing it must not do.
        </Callout>
      ) : null}

      <Toolbar>
        <Field label="Show" htmlFor="con-status">
          <select id="con-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Every sold line</option>
            <option value="POSTED">Costed and deducted</option>
            <option value="UNCOSTED">Could not be costed</option>
          </select>
        </Field>
      </Toolbar>

      <ErrorNote message={error} />

      <Table
        head={[
          'When',
          'Status',
          { key: 'q', label: 'Sold', right: true },
          { key: 'r', label: 'Returned', right: true },
          { key: 'c', label: 'Cost', right: true },
          'Cost basis',
          'Why not costed',
        ]}
        empty="Nothing sold yet"
        emptyNote="A row appears here the moment a bill is raised against a recipe-linked product."
      >
        {rows.map((c) => (
          <tr key={c.id}>
            <Td className="text-xs text-slate-500">{fmtDateTime(c.occurredAt)}</Td>
            <Td>
              <Badge map={CONSUMPTION_STYLES} value={c.status} />
            </Td>
            <Td right className="tabular-nums">{c.qtySold}</Td>
            <Td right className={Number(c.returnedQty) ? 'font-semibold tabular-nums text-amber-700' : 'tabular-nums text-slate-300'}>
              {c.returnedQty}
            </Td>
            <Td right className="font-semibold tabular-nums">
              {c.costStatus === 'MISSING' ? <span className="text-amber-700">not known</span> : fmtPaise(c.costPaise)}
            </Td>
            <Td>
              <Badge map={COST_STATUS_STYLES} value={c.costStatus} />
            </Td>
            <Td className="text-xs text-slate-500">
              {c.uncostedReason ? UNCOSTED_LABEL[c.uncostedReason] || c.uncostedReason : '—'}
            </Td>
          </tr>
        ))}
      </Table>

      <p className="mt-3 text-xs text-slate-400">
        Returning money to a customer does not put food back on the shelf. A refund only restocks when
        somebody records that the goods actually came back, which is why the returned column here is
        separate from anything on the payment side.
      </p>
    </section>
  );
}

export default function InventoryRecipes() {
  const { data, error, loading, reload } = useInventory('/inventory/recipes');
  const [open, setOpen] = useState(null);

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || 'Could not load recipes'} />;

  const recipes = data.recipes ?? [];
  const unlinked = recipes.filter((r) => !(r.links ?? []).length);
  const noActive = recipes.filter((r) => !(r.versions ?? []).some((v) => v.status === 'ACTIVE'));

  return (
    <div>
      <PageHeader
        title="Recipes and food cost"
        subtitle="What a dish is made of, which version was in force, and what it actually cost"
        actions={<RefreshButton loading={loading} onClick={reload} />}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard icon={ChefHat} label="Recipes" value={recipes.length} hint="Across this company" accent="royal" />
        <StatCard
          icon={Layers}
          label="With no version in force"
          value={noActive.length}
          hint={noActive.length ? 'Selling these deducts nothing' : 'Every recipe has an active version'}
          accent={noActive.length ? 'orange' : 'slate'}
        />
        <StatCard
          icon={CircleAlert}
          label="Not linked to a product"
          value={unlinked.length}
          hint={unlinked.length ? 'Nothing on the menu triggers them' : 'Every recipe is reachable from a sale'}
          accent={unlinked.length ? 'orange' : 'slate'}
        />
      </div>

      {noActive.length ? (
        <Callout tone="amber" title={`${noActive.length} recipe${noActive.length === 1 ? ' has' : 's have'} no version in force`}>
          A recipe with only drafts describes nothing the system will act on. Selling the linked product
          still records the sale — it records it as uncosted, so the gap is visible rather than being a
          quietly perfect margin.
        </Callout>
      ) : null}

      <ErrorNote message={error} />

      <Table
        head={['Recipe', 'Makes', 'Version in force', { key: 'l', label: 'Ingredients', right: true }, 'Sold as', 'Status']}
        empty="No recipes"
        emptyNote="A recipe is what links a thing on the menu to the stock it consumes."
      >
        {recipes.map((r) => {
          const active = (r.versions ?? []).find((v) => v.status === 'ACTIVE');
          return (
            <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r)}>
              <Td className="font-semibold text-pos-royal">{r.name}</Td>
              <Td className="text-xs text-slate-600">
                {r.outputItem ? r.outputItem.name : <span className="text-slate-300">sold directly</span>}
              </Td>
              <Td>
                {active ? (
                  <span className="text-sm">
                    v{active.version}
                    <span className="ml-1 text-xs text-slate-400">{active.yieldPercent}% yield</span>
                  </span>
                ) : (
                  <span className="badge bg-amber-100 text-amber-700">none active</span>
                )}
              </Td>
              <Td right>{active ? active.lines.length : <span className="text-slate-300">—</span>}</Td>
              <Td className="text-xs text-slate-600">
                {(r.links ?? []).length ? (
                  r.links.map((l) => l.product?.name || l.productId).join(', ')
                ) : (
                  <span className="text-amber-700">not linked</span>
                )}
              </Td>
              <Td className="text-xs text-slate-600">{r.status}</Td>
            </tr>
          );
        })}
      </Table>

      {open ? <RecipeDetail recipe={open} onClose={() => setOpen(null)} /> : null}

      <Consumptions />
    </div>
  );
}
