// Where the owner decides how much of a bill their staff may give away.
//
// The product ships no opinion about that number. This screen is the opinion,
// and it is the customer's to hold: a company default, a branch that is
// trusted with more (or less), and a named member of staff who is trusted
// differently again. Most specific wins, field by field.
//
// The column that matters is "May give" — what each person can actually do
// once the three levels are resolved. An owner should not have to work out
// inheritance in their head to answer "so what can Priya take off?".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgePercent, Building2, Pencil, ShieldCheck, Store, Trash2, Users } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { fmtINR } from '../lib/pos.js';
import { EmptyState, ErrorNote, Modal, PageHeader, RoleBadge, StatCard } from '../components/ui.jsx';
import { useToast } from '../components/toast.jsx';

// null means "inherit from the level above" everywhere in this file. It is a
// real value, distinct from 0 ("allowed nothing"), and the client always sends
// all seven fields so a cleared box is never mistaken for a forgotten one.
const BLANK = {
  allowLineDiscount: null,
  allowOrderDiscount: null,
  maxPercent: null,
  maxFlatPaise: null,
  canApprove: null,
  maxApprovalPercent: null,
  maxApprovalFlatPaise: null,
  note: null,
};

const pctText = (milli) => {
  if (milli === null || milli === undefined) return null;
  const n = milli / 1000;
  return `${Number.isInteger(n) ? n : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
};

const ceilingText = (e) => {
  if (!e) return '—';
  if (!e.allowLineDiscount && !e.allowOrderDiscount) return 'No discounts';
  return e.ceiling || '—';
};

const TriState = ({ id, label, value, onChange, hint }) => (
  <div>
    <label className="label" htmlFor={id}>
      {label}
    </label>
    <select
      id={id}
      className="input"
      value={value === null ? '' : value ? 'yes' : 'no'}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}
    >
      <option value="">Inherit</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
  </div>
);

const NumField = ({ id, label, value, onChange, step = '0.001', max, hint }) => (
  <div>
    <label className="label" htmlFor={id}>
      {label}
    </label>
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className="input tabular-nums"
      min="0"
      max={max}
      step={step}
      placeholder="Inherit"
      value={value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
    {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
  </div>
);

function PolicyModal({ target, onClose, onSaved }) {
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    const p = target.policy;
    setForm(
      p
        ? {
            allowLineDiscount: p.allowLineDiscount,
            allowOrderDiscount: p.allowOrderDiscount,
            maxPercent: p.maxPercent,
            // Stored in paise; typed in rupees.
            maxFlatPaise: p.maxFlatPaise === null ? null : p.maxFlatPaise / 100,
            canApprove: p.canApprove,
            maxApprovalPercent: p.maxApprovalPercent,
            maxApprovalFlatPaise: p.maxApprovalFlatPaise === null ? null : p.maxApprovalFlatPaise / 100,
            note: p.note,
          }
        : BLANK,
    );
    setError('');
    setBusy(false);
  }, [target]);

  if (!target) return null;

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const toPaise = (rupees) => (rupees === null ? null : Math.round(rupees * 100));

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.put('/discount-policies', {
        level: target.level,
        branchId: target.branchId ?? null,
        userId: target.userId ?? null,
        allowLineDiscount: form.allowLineDiscount,
        allowOrderDiscount: form.allowOrderDiscount,
        maxPercent: form.maxPercent,
        maxFlatPaise: toPaise(form.maxFlatPaise),
        canApprove: form.canApprove,
        maxApprovalPercent: form.maxApprovalPercent,
        maxApprovalFlatPaise: toPaise(form.maxApprovalFlatPaise),
        note: form.note === '' ? null : form.note,
      });
      onSaved();
    } catch (err) {
      setError(apiError(err));
      setBusy(false);
    }
  };

  const inheritHint =
    target.level === 'COMPANY'
      ? 'Nothing sits above the company, so a box left on Inherit here means "not allowed".'
      : 'Leave a box on Inherit to keep whatever the level above already says.';

  return (
    <Modal open wide title={target.title} onClose={onClose}>
      <form onSubmit={save} className="space-y-5">
        <p className="text-xs text-slate-500">{inheritHint}</p>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            What they may give
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TriState
              id="allow-line"
              label="Discount on a single item"
              value={form.allowLineDiscount}
              onChange={set('allowLineDiscount')}
            />
            <TriState
              id="allow-order"
              label="Discount on the whole order"
              value={form.allowOrderDiscount}
              onChange={set('allowOrderDiscount')}
            />
            <NumField
              id="max-pct"
              label="Maximum % of the bill"
              max={100}
              value={form.maxPercent}
              onChange={set('maxPercent')}
              hint="Counts item and order discounts together."
            />
            <NumField
              id="max-flat"
              label="Maximum amount (₹)"
              step="0.01"
              value={form.maxFlatPaise}
              onChange={set('maxFlatPaise')}
              hint="If both are set, the tighter one decides."
            />
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            What they may approve for someone else
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TriState
              id="can-approve"
              label="May approve above-limit discounts"
              value={form.canApprove}
              onChange={set('canApprove')}
              hint="They sign with their own password, every time."
            />
            <div />
            <NumField
              id="max-appr-pct"
              label="Maximum % they may approve"
              max={100}
              value={form.maxApprovalPercent}
              onChange={set('maxApprovalPercent')}
            />
            <NumField
              id="max-appr-flat"
              label="Maximum amount they may approve (₹)"
              step="0.01"
              value={form.maxApprovalFlatPaise}
              onChange={set('maxApprovalFlatPaise')}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="policy-note">
            Note (optional)
          </label>
          <input
            id="policy-note"
            type="text"
            maxLength={200}
            className="input"
            placeholder="Why this was set"
            value={form.note ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </div>

        <ErrorNote message={error} />

        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ScopeCard({ icon: Icon, title, subtitle, policy, effective, onEdit, onClear }) {
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="rounded-lg bg-pos-royal/10 p-2.5 text-pos-royal">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold text-pos-ink">{title}</div>
          <div className="truncate text-xs text-slate-500">
            {policy ? subtitle : 'Not set — inherits from the level above'}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {effective ? (
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-slate-400">May give</div>
            <div className="font-bold tabular-nums text-pos-ink">{ceilingText(effective)}</div>
          </div>
        ) : null}
        <button type="button" className="btn-ghost" onClick={onEdit} aria-label={`Edit ${title}`}>
          <Pencil className="h-4 w-4" />
        </button>
        {policy && onClear ? (
          <button
            type="button"
            className="btn-ghost text-red-600"
            onClick={onClear}
            aria-label={`Clear ${title}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

const summarise = (p) => {
  if (!p) return '';
  const bits = [];
  if (p.allowLineDiscount !== null) bits.push(`item discounts ${p.allowLineDiscount ? 'on' : 'off'}`);
  if (p.allowOrderDiscount !== null) bits.push(`order discounts ${p.allowOrderDiscount ? 'on' : 'off'}`);
  if (p.maxPercent !== null) bits.push(`up to ${pctText(p.maxPercent * 1000)}`);
  if (p.maxFlatPaise !== null) bits.push(`up to ${fmtINR(p.maxFlatPaise / 100)}`);
  if (p.canApprove !== null) bits.push(`approving ${p.canApprove ? 'on' : 'off'}`);
  if (p.maxApprovalPercent !== null) bits.push(`approves to ${pctText(p.maxApprovalPercent * 1000)}`);
  if (p.maxApprovalFlatPaise !== null) bits.push(`approves to ${fmtINR(p.maxApprovalFlatPaise / 100)}`);
  return bits.join(' · ') || 'Nothing set';
};

export default function Discounts() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [target, setTarget] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.get('/discount-policies');
      setData(res.data);
      setLoadError('');
    } catch (err) {
      setLoadError(apiError(err, 'Could not load discount settings'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byScope = useMemo(() => {
    const m = { company: null, branch: {}, user: {} };
    for (const p of data?.policies || []) {
      if (p.level === 'COMPANY') m.company = p;
      else if (p.level === 'BRANCH') m.branch[p.branchId] = p;
      else m.user[p.userId] = p;
    }
    return m;
  }, [data]);

  const effectiveBy = useMemo(() => {
    const m = {};
    for (const e of data?.effective || []) m[e.userId] = e;
    return m;
  }, [data]);

  const clear = async (policy, label) => {
    try {
      await api.delete(`/discount-policies/${policy.id}`);
      toast(`${label} cleared — it now inherits again`, 'success');
      await load();
    } catch (err) {
      toast(apiError(err, 'Could not clear that setting'), 'error');
    }
  };

  if (loadError) {
    return (
      <>
        <PageHeader title="Discount permissions" />
        <ErrorNote message={loadError} />
      </>
    );
  }
  if (!data) return null;

  const staff = data.staff || [];
  const mayDiscount = staff.filter((u) => {
    const e = effectiveBy[u.id];
    return e && (e.allowLineDiscount || e.allowOrderDiscount);
  }).length;
  const mayApprove = staff.filter((u) => effectiveBy[u.id]?.canApprove).length;

  return (
    <>
      <PageHeader
        title="Discount permissions"
        subtitle="Who may take money off a bill, and how much. Set here, enforced at every till."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={Users}
          label="Staff who may discount"
          value={`${mayDiscount} of ${staff.length}`}
          hint={mayDiscount === 0 ? 'Nobody below the owner can discount yet' : 'Resolved across all three levels'}
          accent={mayDiscount === 0 ? 'slate' : 'royal'}
        />
        <StatCard
          icon={ShieldCheck}
          label="Staff who may approve"
          value={`${mayApprove} of ${staff.length}`}
          hint="They sign with their own password each time"
          accent={mayApprove === 0 ? 'slate' : 'green'}
        />
        <StatCard
          icon={BadgePercent}
          label="Company default"
          value={byScope.company ? pctText((byScope.company.maxPercent ?? 0) * 1000) || '—' : 'Not set'}
          hint={byScope.company ? summarise(byScope.company) : 'Nothing is allowed until this is set'}
          accent={byScope.company ? 'orange' : 'slate'}
        />
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Company default</h2>
        <ScopeCard
          icon={Building2}
          title="Everyone, unless overridden below"
          subtitle={summarise(byScope.company)}
          policy={byScope.company}
          onEdit={() =>
            setTarget({
              level: 'COMPANY',
              title: 'Company default',
              policy: byScope.company,
            })
          }
          onClear={byScope.company ? () => clear(byScope.company, 'Company default') : null}
        />
        {!byScope.company ? (
          <p className="mt-2 text-xs text-slate-500">
            Until this is set, only the owner may discount anything. That is deliberate — the safe
            state is the one nobody has to remember to choose.
          </p>
        ) : null}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Branch overrides</h2>
        <div className="space-y-2">
          {(data.branches || []).map((b) => (
            <ScopeCard
              key={b.id}
              icon={Store}
              title={b.name}
              subtitle={summarise(byScope.branch[b.id])}
              policy={byScope.branch[b.id]}
              onEdit={() =>
                setTarget({
                  level: 'BRANCH',
                  branchId: b.id,
                  title: `${b.name} override`,
                  policy: byScope.branch[b.id],
                })
              }
              onClear={byScope.branch[b.id] ? () => clear(byScope.branch[b.id], `${b.name} override`) : null}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Staff</h2>
        {staff.length === 0 ? (
          <EmptyState icon={Users} title="No staff yet" note="Add people on the Team screen first." />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">May give</th>
                  <th className="px-4 py-3">May approve up to</th>
                  <th className="px-4 py-3 text-right">Override</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {staff.map((u) => {
                  const e = effectiveBy[u.id];
                  const own = byScope.user[u.id];
                  return (
                    <tr key={u.id} className={own ? 'bg-pos-royal/[0.03]' : ''}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-pos-ink">{u.fullName}</div>
                        <div className="text-xs text-slate-500">{u.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="px-4 py-3 font-semibold tabular-nums text-pos-ink">{ceilingText(e)}</td>
                      <td className="px-4 py-3 tabular-nums text-slate-600">
                        {e?.canApprove ? e.approvalCeiling : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {own ? <span className="badge bg-pos-royal/10 text-pos-royal">Own setting</span> : null}
                          <button
                            type="button"
                            className="btn-ghost"
                            aria-label={`Edit ${u.fullName}`}
                            onClick={() =>
                              setTarget({
                                level: 'USER',
                                userId: u.id,
                                title: `${u.fullName} — own setting`,
                                policy: own,
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          {own ? (
                            <button
                              type="button"
                              className="btn-ghost text-red-600"
                              aria-label={`Clear ${u.fullName}`}
                              onClick={() => clear(own, `${u.fullName}'s own setting`)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PolicyModal
        target={target}
        onClose={() => setTarget(null)}
        onSaved={async () => {
          setTarget(null);
          toast('Discount setting saved', 'success');
          await load();
        }}
      />
    </>
  );
}
