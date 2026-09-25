// The central kitchen: what was made, out of what, and what it cost.
//
// A production run is the one place in this module where several positions
// collapse into one, so it is the one place a reader most needs to see the
// arithmetic rather than be told the answer. The detail below lists every
// input with the value it gave up and puts the output underneath as the sum
// those inputs add to — because the claim "a kitchen neither mints nor burns
// money" is only worth making if somebody can check it on screen.
//
// The second number this screen exists for is the yield variance. A run set up
// for 10 kg that produced 9.4 kg still ate 10 kg of ingredients; the 600 g is
// a real loss and it is shown as a loss, not absorbed into a lower input
// figure where nobody would ever find it.

import { useMemo, useState } from 'react';
import { ChefHat, CookingPot, Scale, TrendingDown } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner, Modal } from '../../components/ui.jsx';
import {
  ActionButton,
  Actor,
  ActorInline,
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
import { fmtDate, fmtDateTime } from '../../lib/pos.js';
import { COST_STATUS_STYLES, fmtCost, fmtPaise, fmtQty, qtyIsNegative, qtyIsZero } from '../../lib/inventory.js';

const COST_NOTE = {
  ACTUAL: 'every input had a known cost',
  ESTIMATED: 'at least one input was valued from its last known price',
  MISSING: 'at least one input had no cost basis at all',
};

function RunDetail({ runId, onClose }) {
  const { data, error, loading } = useInventory(`/inventory/production/${runId}`, { skip: !runId });
  const p = data?.production;

  const variance = p?.yieldVarianceQty;
  const short = variance ? Number(variance) < 0 : false;

  return (
    <Modal open={Boolean(runId)} title={p ? `Production run ${p.number}` : 'Production run'} onClose={onClose} wide>
      {loading && !data ? <div className="py-6 text-center text-sm text-slate-400">Loading…</div> : null}
      <ErrorNote message={error} />
      {p ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge map={COST_STATUS_STYLES} value={p.costStatus} />
            <span className="font-semibold text-pos-ink">{p.recipe?.name}</span>
            <span className="text-slate-400">version {p.recipe?.version}</span>
            <span className="text-slate-400">· at {p.location?.name}</span>
            <span className="text-slate-400">· {fmtDateTime(p.createdAt)}</span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full min-w-[30rem] text-xs">
              <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Went in</th>
                  <th className="px-3 py-2 text-right">Quantity</th>
                  <th className="px-3 py-2 text-right">Value given up</th>
                  <th className="px-3 py-2">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {p.inputs.map((i) => (
                  <tr key={i.item.id}>
                    <td className="px-3 py-2 font-semibold text-pos-ink">{i.item.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(i.qtyBase, i.item.baseUnit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-pos-royal">{fmtPaise(i.valuePaise)}</td>
                    <td className="px-3 py-2">
                      <Badge map={COST_STATUS_STYLES} value={i.costStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* The sum, written as a sum. The output row is the same number
                  as the total above it, which is the entire claim. */}
              <tfoot className="border-t-2 border-slate-200 bg-slate-50/60">
                <tr>
                  <td className="px-3 py-2 text-right font-semibold text-slate-500" colSpan={2}>
                    Inputs, in total
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-pos-royal">
                    {fmtPaise(p.inputValuePaise)}
                  </td>
                  <td />
                </tr>
                <tr>
                  <td className="px-3 py-2 font-bold text-pos-ink">
                    Came out: {p.outputItem?.name}
                    {p.batch?.batchCode ? (
                      <span className="ml-2 font-normal text-slate-400">batch {p.batch.batchCode}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums">
                    {fmtQty(p.outputQty, p.outputItem?.baseUnit)}
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-pos-ink">
                    {fmtPaise(p.inputValuePaise)}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500">
                    {fmtCost(p.outputUnitCostPaise)} per {p.outputItem?.baseUnit?.toLowerCase() ?? 'unit'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {p.plannedQty && variance && Number(variance) !== 0 ? (
            <Callout
              tone={short ? 'amber' : 'sky'}
              icon={TrendingDown}
              title={`Set up for ${fmtQty(p.plannedQty, p.outputItem?.baseUnit)}, ${
                short ? 'only got' : 'got'
              } ${fmtQty(p.outputQty, p.outputItem?.baseUnit)}`}
            >
              {short ? (
                <>
                  {fmtQty(variance.replace('-', ''), p.outputItem?.baseUnit)} never arrived. The ingredients
                  for the full {fmtQty(p.plannedQty, p.outputItem?.baseUnit)} still left the shelf, so the same{' '}
                  {fmtPaise(p.inputValuePaise)} is now carried by less product and every portion made from it
                  costs more. That is the loss, and it is meant to be visible.
                </>
              ) : (
                <>
                  The run produced more than it was set up for. The inputs charged are still the ones the run
                  was set up to use, so the extra output carries no extra cost — worth checking the recipe's
                  stated yield, which may now be pessimistic.
                </>
              )}
            </Callout>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
            <div>
              Recorded by <ActorInline actor={p.createdBy} />
            </div>
            <div>
              Recipe yield on paper: <span className="font-semibold text-pos-ink">{p.yieldPercent}%</span>
              {p.batch?.expiryDate ? <span className="ml-3">Use by {fmtDate(p.batch.expiryDate)}</span> : null}
            </div>
          </div>

          {p.note ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{p.note}</p> : null}

          <p className="text-xs text-slate-400">
            The output is booked in at exactly what the inputs were worth when they left — read back off the
            movements the run just posted, never recalculated from a price list. A production run moves value
            between positions; it does not create or destroy any, so the total on the shelf is the same before
            and after. Inputs are picked first-expiring-first, and are charged against the run that was{' '}
            <em>set up</em> rather than the quantity that actually appeared.
            {p.costStatus !== 'ACTUAL' ? ` This run is ${p.costStatus.toLowerCase()}: ${COST_NOTE[p.costStatus]}.` : ''}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

// Recording a run. Deliberately two quantity boxes: what the run was set up to
// make, and what came out of it. Collapsing them into one would be a smaller
// form that could not express the only interesting thing that happens in a
// kitchen.
function RecordRun({ locations, recipes, onDone }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    locationId: '',
    recipeVersionId: '',
    batchQty: '',
    outputQty: '',
    batchCode: '',
    expiryDate: '',
    note: '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Only recipes that name the item they make, and only their live version. A
  // menu recipe is consumed by selling it and the server refuses to produce
  // one, so offering it here would be offering a refusal.
  const makeable = useMemo(
    () =>
      recipes
        .filter((r) => r.outputItem && r.status === 'ACTIVE')
        .flatMap((r) =>
          r.versions
            .filter((v) => v.status === 'ACTIVE')
            .map((v) => ({ id: v.id, label: `${r.name} v${v.version} → ${r.outputItem.name}`, recipe: r, version: v })),
        ),
    [recipes],
  );
  const chosen = makeable.find((m) => m.id === form.recipeVersionId) ?? null;

  const submit = async () => {
    setError('');
    try {
      await api.post('/inventory/production', {
        locationId: form.locationId,
        recipeVersionId: form.recipeVersionId,
        batchQty: form.batchQty,
        ...(form.outputQty ? { outputQty: form.outputQty } : {}),
        ...(form.batchCode ? { batchCode: form.batchCode.trim() } : {}),
        ...(form.expiryDate ? { expiryDate: form.expiryDate } : {}),
        ...(form.note ? { note: form.note.trim() } : {}),
        idempotencyKey: `prd-ui-${form.recipeVersionId}-${Date.now()}`,
      });
      setOpen(false);
      setForm({ locationId: '', recipeVersionId: '', batchQty: '', outputQty: '', batchCode: '', expiryDate: '', note: '' });
      await onDone();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  const ready = form.locationId && form.recipeVersionId && form.batchQty;

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        <CookingPot className="h-4 w-4" /> Record a run
      </button>
      <Modal open={open} title="Record a production run" onClose={() => setOpen(false)} wide>
        <div className="space-y-4">
          <ErrorNote message={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kitchen" htmlFor="prd-loc" hint="Inputs leave here and the output arrives here.">
              <LocationSelect
                id="prd-loc"
                value={form.locationId}
                onChange={(v) => setForm((f) => ({ ...f, locationId: v }))}
                locations={locations}
                allLabel="Choose a location"
              />
            </Field>
            <Field label="Recipe" htmlFor="prd-rec" hint="Only live versions of recipes that name what they make.">
              <select id="prd-rec" className="input" value={form.recipeVersionId} onChange={set('recipeVersionId')}>
                <option value="">Choose a recipe</option>
                {makeable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Set up to make"
              htmlFor="prd-plan"
              hint={
                chosen
                  ? `In ${chosen.recipe.outputItem.baseUnit.toLowerCase()}. This is what the ingredients are charged against.`
                  : 'This is what the ingredients are charged against.'
              }
            >
              <input id="prd-plan" className="input" value={form.batchQty} onChange={set('batchQty')} placeholder="2000" />
            </Field>
            <Field label="Actually came out" htmlFor="prd-out" hint="Leave blank if the run went exactly to plan.">
              <input id="prd-out" className="input" value={form.outputQty} onChange={set('outputQty')} placeholder="same" />
            </Field>
            <Field label="Batch code" htmlFor="prd-batch" hint="Required if the output item is batch tracked.">
              <input id="prd-batch" className="input" value={form.batchCode} onChange={set('batchCode')} placeholder="PAN-2609" />
            </Field>
            <Field label="Use by" htmlFor="prd-exp" hint="The made batch gets its own date, not the milk's.">
              <input id="prd-exp" type="date" className="input" value={form.expiryDate} onChange={set('expiryDate')} />
            </Field>
          </div>
          <Field label="Note" htmlFor="prd-note">
            <input id="prd-note" className="input" value={form.note} onChange={set('note')} placeholder="Morning batch for both stores" />
          </Field>

          {chosen ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {chosen.recipe.name} v{chosen.version.version} lists its ingredients for{' '}
              {fmtQty(chosen.version.outputQty, chosen.recipe.outputItem.baseUnit)} at a stated yield of{' '}
              {chosen.version.yieldPercent}%. Whatever you set the run up for is scaled from that, and the
              inputs are divided by the yield because the trim comes out of the store too.
            </p>
          ) : null}

          <ActionButton className="btn-primary w-full" onClick={submit} disabled={!ready}>
            <CookingPot className="h-4 w-4" /> Post this run
          </ActionButton>
        </div>
      </Modal>
    </>
  );
}

export default function Production() {
  const { locations, loading: locLoading } = useLocations();
  const runs = useInventory('/inventory/production');
  const recipes = useInventory('/inventory/recipes');
  const [openRun, setOpenRun] = useState(null);

  const rows = runs.data?.production ?? [];
  const recipeList = recipes.data?.recipes ?? [];

  const valueMoved = rows.reduce((a, r) => a + BigInt(r.inputValuePaise ?? '0'), 0n);
  const makeable = recipeList.filter((r) => r.outputItem && r.versions?.some((v) => v.status === 'ACTIVE'));

  if (locLoading && !runs.data) return <FullScreenSpinner />;

  return (
    <div>
      <PageHeader
        title="Central kitchen"
        subtitle="What was made, out of what, and what it cost"
        actions={
          <Toolbar>
            <RefreshButton loading={runs.loading} onClick={runs.reload} />
            <RecordRun
              locations={locations}
              recipes={recipeList}
              onDone={async () => {
                await runs.reload();
              }}
            />
          </Toolbar>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          icon={CookingPot}
          label="Runs recorded"
          value={rows.length}
          hint="Most recent 200"
          accent={rows.length ? 'royal' : 'slate'}
        />
        <StatCard
          icon={Scale}
          label="Value moved through"
          value={fmtPaise(valueMoved)}
          hint="Taken off the ingredients and carried by what was made"
          accent={valueMoved > 0n ? 'royal' : 'slate'}
        />
        <StatCard
          icon={ChefHat}
          label="Recipes that can be made"
          value={makeable.length}
          hint="Live versions that name the item they produce"
          accent={makeable.length ? 'slate' : 'orange'}
        />
      </div>

      {!makeable.length ? (
        <Callout tone="sky" icon={ChefHat} title="Nothing is set up to be produced yet">
          A recipe can be made here only once it names the item it produces and has a live version. A recipe
          with no output item is a menu recipe — paneer is stocked, a latte is not — and it is consumed by
          selling it rather than by running a batch.
        </Callout>
      ) : null}

      <ErrorNote message={runs.error || recipes.error} />
      <Table
        head={[
          'Run',
          'Made',
          'At',
          { key: 'q', label: 'Came out', right: true },
          { key: 'y', label: 'vs plan', right: true },
          { key: 'v', label: 'Input value', right: true },
          'By',
          'When',
        ]}
        empty="No production runs recorded"
        emptyNote="A run takes ingredients off the shelf and puts what they became back on it, carrying their value across."
      >
        {rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenRun(r.id)}>
            <Td className="font-semibold text-pos-royal">{r.number}</Td>
            <Td className="text-slate-700">{r.outputItem?.name}</Td>
            <Td className="text-xs text-slate-600">{r.location?.name}</Td>
            <Td right>{fmtQty(r.outputQty, r.outputItem?.baseUnit)}</Td>
            {/* The shortfall on the list, not only inside the run. A loss a
                reader has to open every row to find is a loss most readers
                will not find. Runs recorded before the planned quantity was
                stored say nothing here rather than claiming they went to
                plan. */}
            <Td right className="text-xs">
              {r.yieldVarianceQty && !qtyIsZero(r.yieldVarianceQty) ? (
                <span className={qtyIsNegative(r.yieldVarianceQty) ? 'font-semibold text-pos-orange' : 'text-slate-500'}>
                  {qtyIsNegative(r.yieldVarianceQty) ? '' : '+'}
                  {fmtQty(r.yieldVarianceQty, r.outputItem?.baseUnit)}
                </span>
              ) : (
                <span className="text-slate-300">{r.yieldVarianceQty ? 'to plan' : '—'}</span>
              )}
            </Td>
            <Td right className="font-semibold">
              {fmtPaise(r.inputValuePaise)}
            </Td>
            <Td className="text-xs text-slate-600">
              <Actor actor={r.createdBy} />
            </Td>
            <Td className="text-xs text-slate-500">{fmtDateTime(r.createdAt)}</Td>
          </tr>
        ))}
      </Table>

      <p className="mt-3 text-xs text-slate-400">
        "Input value" is what the ingredients were worth when they left the shelf, and it is exactly what the
        finished item was booked in at. Open a run to see the inputs it was made from and the arithmetic that
        got there.
      </p>

      <RunDetail runId={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}
