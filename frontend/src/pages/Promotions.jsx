// VC-102 promotions — the owner's campaign screen against Window 1's landed
// API. Rules are drafted here, published/paused/archived here; what they do
// to a bill is the server's business alone (lib/promotions.js + the order
// promotion routes). Money fields travel as integer paise; percent as a
// number. "Live now" is a client-side advisory recomputed in IST — the
// server re-decides eligibility on every application.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, PlusCircle, Pencil, Radio, Archive, Tag, PauseCircle } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { fmtINR } from '../lib/pos.js';
import { EmptyState, ErrorNote, Modal, PageHeader, StatCard } from '../components/ui.jsx';
import { useToast } from '../components/toast.jsx';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // Sunday = bit 0
const IST_OFFSET_MS = 330 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const minToHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hhmmToMin = (s) => {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
const paiseToRupeeStr = (p) => (p === null || p === undefined ? '' : String(p / 100));
const rupeesToPaise = (v) => (v === '' ? null : Math.round(Number(v) * 100));

const BLANK_FORM = {
  name: '',
  code: '',
  benefitType: 'PERCENT',
  percent: '',
  flatRupees: '',
  minSpendRupees: '',
  maxBenefitRupees: '',
  startsAt: '',
  endsAt: '',
  weekdayMask: 127,
  timeFrom: '',
  timeTo: '',
  channel: '',
  stackable: false,
  precedence: '100',
  totalLimit: '',
  perCustomerLimit: '',
  branchIds: [],
};

const benefitText = (p) =>
  p.benefitType === 'PERCENT' ? `${p.percent}% off` : `${fmtINR(p.flatPaise / 100)} off`;

// Advisory only — mirrors the server's isPromotionLive (IST semantics:
// weekdayMask Sunday=bit0, [startMinute, endMinute) exclusive end).
const liveNow = (p) => {
  if (p.status !== 'PUBLISHED') return false;
  const now = new Date();
  if (p.startsAt && now < new Date(p.startsAt)) return false;
  if (p.endsAt && now >= new Date(p.endsAt)) return false;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  if (p.weekdayMask !== null && !((p.weekdayMask >> ist.getUTCDay()) & 1)) return false;
  if (p.startMinute !== null && p.endMinute !== null) {
    const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (m < p.startMinute || m >= p.endMinute) return false;
  }
  return true;
};

const scheduleText = (p) => {
  const bits = [];
  if (p.startsAt || p.endsAt) {
    const d = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '…');
    bits.push(`${d(p.startsAt)} – ${d(p.endsAt)}`);
  }
  if (p.weekdayMask !== null && p.weekdayMask !== 127) {
    bits.push(WEEKDAYS.filter((_, i) => (p.weekdayMask >> i) & 1).join(' '));
  }
  if (p.startMinute !== null && p.endMinute !== null) {
    bits.push(`${minToHHMM(p.startMinute)}–${minToHHMM(p.endMinute)} IST`);
  }
  if (p.channel) bits.push(p.channel === 'DINE_IN' ? 'Dine-in only' : 'Takeaway only');
  return bits.length ? bits.join(' · ') : 'Always on';
};

const statusBadge = (p) => {
  if (p.status === 'ARCHIVED')
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">Archived</span>;
  if (p.status === 'DRAFT')
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Draft</span>;
  if (p.status === 'PAUSED')
    return <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">Paused</span>;
  return liveNow(p) ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Live now</span>
  ) : (
    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">Published</span>
  );
};

// datetime-local wants "YYYY-MM-DDTHH:MM" in local time; the API speaks ISO.
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const sortedIds = (ids) => [...ids].sort().join(',');

export default function Promotions() {
  const toast = useToast();
  const [promotions, setPromotions] = useState(null);
  const [branches, setBranches] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | promotion object
  const [form, setForm] = useState(BLANK_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [promoRes, branchRes] = await Promise.all([
        api.get('/promotions'),
        api.get('/branches'),
      ]);
      setPromotions(promoRes.data.promotions);
      setBranches(branchRes.data.branches);
      setLoadError('');
    } catch (err) {
      setLoadError(apiError(err, 'Could not load promotions'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const list = promotions ?? [];
    return {
      live: list.filter((p) => liveNow(p)).length,
      published: list.filter((p) => p.status === 'PUBLISHED').length,
      draft: list.filter((p) => p.status === 'DRAFT').length,
    };
  }, [promotions]);

  const openNew = () => {
    setForm(BLANK_FORM);
    setFormError('');
    setEditing('new');
  };

  const openEdit = (p) => {
    setForm({
      name: p.name,
      code: p.code ?? '',
      benefitType: p.benefitType,
      percent: p.percent === null ? '' : String(p.percent),
      flatRupees: paiseToRupeeStr(p.flatPaise),
      minSpendRupees: paiseToRupeeStr(p.minSpendPaise),
      maxBenefitRupees: paiseToRupeeStr(p.maxBenefitPaise),
      startsAt: toLocalInput(p.startsAt),
      endsAt: toLocalInput(p.endsAt),
      weekdayMask: p.weekdayMask ?? 127,
      timeFrom: p.startMinute === null ? '' : minToHHMM(p.startMinute),
      // endMinute may be 1440 (midnight, exclusive) which a time input cannot
      // hold; 23:59 is the closest editable value.
      timeTo: p.endMinute === null ? '' : minToHHMM(Math.min(p.endMinute, 1439)),
      channel: p.channel ?? '',
      stackable: p.stackable,
      precedence: String(p.precedence),
      totalLimit: p.totalLimit === null ? '' : String(p.totalLimit),
      perCustomerLimit: p.perCustomerLimit === null ? '' : String(p.perCustomerLimit),
      branchIds: (p.stores ?? []).map((s) => s.branchId),
    });
    setFormError('');
    setEditing(p);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleDay = (i) => setForm((f) => ({ ...f, weekdayMask: f.weekdayMask ^ (1 << i) }));
  const toggleBranch = (id) =>
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((b) => b !== id)
        : [...f.branchIds, id],
    }));

  const submit = async (e) => {
    e.preventDefault();
    if (form.weekdayMask === 0) {
      setFormError('Pick at least one day of the week');
      return;
    }
    setBusy(true);
    setFormError('');
    const intOr = (v) => (v === '' ? null : Number(v));
    const body = {
      name: form.name.trim(),
      code: form.code.trim() ? form.code.trim().toUpperCase() : null,
      benefitType: form.benefitType,
      percent: form.benefitType === 'PERCENT' ? Number(form.percent) : null,
      flatPaise: form.benefitType === 'FLAT' ? rupeesToPaise(form.flatRupees) : null,
      minSpendPaise: rupeesToPaise(form.minSpendRupees),
      maxBenefitPaise: rupeesToPaise(form.maxBenefitRupees),
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      // null = every day, per the schema; 127 would also mean that, but null
      // keeps "no day restriction" distinct in the data.
      weekdayMask: form.weekdayMask === 127 ? null : form.weekdayMask,
      startMinute: hhmmToMin(form.timeFrom),
      endMinute: hhmmToMin(form.timeTo),
      channel: form.channel || null,
      stackable: form.stackable,
      precedence: form.precedence === '' ? 100 : Number(form.precedence),
      totalLimit: intOr(form.totalLimit),
      perCustomerLimit: intOr(form.perCustomerLimit),
    };
    try {
      if (editing === 'new') {
        const { data } = await api.post('/promotions', body);
        if (form.branchIds.length) {
          await api.put(`/promotions/${data.promotion.id}/stores`, { branchIds: form.branchIds });
        }
        toast('Promotion created as a draft. Publish it to switch it on.', 'success');
      } else {
        await api.patch(`/promotions/${editing.id}`, body);
        // PUT /stores bumps the version of a published promotion even when
        // nothing changed, so only send it when the store set actually moved.
        const before = sortedIds((editing.stores ?? []).map((s) => s.branchId));
        if (before !== sortedIds(form.branchIds)) {
          await api.put(`/promotions/${editing.id}/stores`, { branchIds: form.branchIds });
        }
        toast('Promotion updated', 'success');
      }
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(apiError(err, 'Could not save the promotion'));
    } finally {
      setBusy(false);
    }
  };

  const lifecycle = async (p, action) => {
    try {
      await api.post(`/promotions/${p.id}/${action}`);
      toast(
        action === 'publish' ? `${p.name} is published` : action === 'pause' ? `${p.name} is paused` : `${p.name} is archived`,
        'success',
      );
      await load();
    } catch (err) {
      toast(apiError(err, `Could not ${action}`), 'error');
    }
  };

  const scopeText = (p) =>
    p.stores.length === 0 ? 'All stores' : p.stores.map((s) => s.branchName || 'Store').join(', ');

  return (
    <div>
      <PageHeader
        title="Promotions"
        subtitle="Scheduled offers applied at the till — automatically from the offers list, or by code. The server computes every benefit."
        actions={
          <button type="button" className="btn-primary flex items-center gap-2" onClick={openNew}>
            <PlusCircle className="h-4 w-4" /> New promotion
          </button>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard icon={Radio} label="Live now" value={stats.live} accent="green" />
        <StatCard icon={Megaphone} label="Published" value={stats.published} />
        <StatCard icon={Pencil} label="Drafts" value={stats.draft} accent="orange" />
      </div>
      <ErrorNote message={loadError} />

      {promotions === null ? null : promotions.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No promotions yet"
          note="Create an offer — a happy-hour percentage, a flat amount over a minimum spend, or a coded deal — and publish it when it should start applying."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Promotion</th>
                <th className="px-4 py-3">Benefit</th>
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Scope & limits</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {promotions.map((p) => (
                <tr key={p.id} className="border-b border-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-pos-ink">{p.name}</div>
                    {p.code ? (
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                        <Tag className="h-3 w-3" /> Code {p.code}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-xs text-slate-400">Automatic (picked at the till)</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div>{benefitText(p)}</div>
                    <div className="text-xs text-slate-400">
                      {p.minSpendPaise !== null ? `Over ${fmtINR(p.minSpendPaise / 100)}` : 'No minimum'}
                      {p.maxBenefitPaise !== null ? ` · Max ${fmtINR(p.maxBenefitPaise / 100)}` : ''}
                      {p.stackable ? ' · Stacks' : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{scheduleText(p)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {scopeText(p)}
                    {p.totalLimit !== null ? (
                      <div>
                        {p.redemptionCount} of {p.totalLimit} uses
                      </div>
                    ) : null}
                    {p.perCustomerLimit !== null ? <div>{p.perCustomerLimit} per customer</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    {statusBadge(p)}
                    {p.version > 1 ? <div className="mt-0.5 text-[10px] text-slate-400">v{p.version}</div> : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {p.status !== 'ARCHIVED' ? (
                        <button
                          type="button"
                          className="btn-ghost flex items-center gap-1 text-xs"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </button>
                      ) : null}
                      {p.status === 'DRAFT' || p.status === 'PAUSED' ? (
                        <button
                          type="button"
                          className="btn-primary flex items-center gap-1 px-3 py-1.5 text-xs"
                          onClick={() => lifecycle(p, 'publish')}
                        >
                          <Radio className="h-3.5 w-3.5" /> {p.status === 'PAUSED' ? 'Resume' : 'Publish'}
                        </button>
                      ) : null}
                      {p.status === 'PUBLISHED' ? (
                        <button
                          type="button"
                          className="btn-ghost flex items-center gap-1 text-xs text-orange-600"
                          onClick={() => lifecycle(p, 'pause')}
                        >
                          <PauseCircle className="h-3.5 w-3.5" /> Pause
                        </button>
                      ) : null}
                      {p.status !== 'ARCHIVED' ? (
                        <button
                          type="button"
                          className="btn-ghost flex items-center gap-1 text-xs text-slate-500"
                          onClick={() => lifecycle(p, 'archive')}
                        >
                          <Archive className="h-3.5 w-3.5" /> Archive
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'New promotion' : 'Edit promotion'}
        onClose={() => setEditing(null)}
        wide
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="promo-name">Name</label>
              <input id="promo-name" className="input" value={form.name} onChange={set('name')} required maxLength={120} />
            </div>
            <div>
              <label className="label" htmlFor="promo-code">Promo code (optional)</label>
              <input
                id="promo-code" className="input uppercase" value={form.code} onChange={set('code')}
                placeholder="Blank = automatic offer"
              />
            </div>
            <div>
              <label className="label" htmlFor="promo-type">Benefit</label>
              <select id="promo-type" className="input" value={form.benefitType} onChange={set('benefitType')}>
                <option value="PERCENT">Percent off</option>
                <option value="FLAT">Amount off (₹)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="promo-value">
                {form.benefitType === 'PERCENT' ? 'Percent' : 'Amount (₹)'}
              </label>
              {/* No client-side max — the server's validation is authoritative
                  and its refusal is surfaced below. */}
              {form.benefitType === 'PERCENT' ? (
                <input
                  id="promo-value" className="input" type="number" min="0.001" step="0.001"
                  value={form.percent} onChange={set('percent')} required
                />
              ) : (
                <input
                  id="promo-value" className="input" type="number" min="0.01" step="0.01"
                  value={form.flatRupees} onChange={set('flatRupees')} required
                />
              )}
            </div>
            <div>
              <label className="label" htmlFor="promo-min">Minimum spend (₹, optional)</label>
              <input id="promo-min" className="input" type="number" min="0.01" step="0.01" value={form.minSpendRupees} onChange={set('minSpendRupees')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-max">Max benefit (₹, optional)</label>
              <input id="promo-max" className="input" type="number" min="0.01" step="0.01" value={form.maxBenefitRupees} onChange={set('maxBenefitRupees')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-starts">Starts (optional)</label>
              <input id="promo-starts" className="input" type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-ends">Ends (optional)</label>
              <input id="promo-ends" className="input" type="datetime-local" value={form.endsAt} onChange={set('endsAt')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-from">Daily from (IST, optional)</label>
              <input id="promo-from" className="input" type="time" value={form.timeFrom} onChange={set('timeFrom')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-to">Daily until (IST, optional)</label>
              <input id="promo-to" className="input" type="time" value={form.timeTo} onChange={set('timeTo')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-channel">Channel</label>
              <select id="promo-channel" className="input" value={form.channel} onChange={set('channel')}>
                <option value="">Dine-in and takeaway</option>
                <option value="DINE_IN">Dine-in only</option>
                <option value="TAKEAWAY">Takeaway only</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="promo-precedence">Precedence (lower keeps money first)</label>
              <input id="promo-precedence" className="input" type="number" min="0" max="1000" step="1" value={form.precedence} onChange={set('precedence')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-limit">Total redemptions (optional)</label>
              <input id="promo-limit" className="input" type="number" min="1" step="1" value={form.totalLimit} onChange={set('totalLimit')} />
            </div>
            <div>
              <label className="label" htmlFor="promo-percustomer">Per-customer limit (optional)</label>
              <input id="promo-percustomer" className="input" type="number" min="1" step="1" value={form.perCustomerLimit} onChange={set('perCustomerLimit')} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={form.stackable}
              onChange={(e) => setForm((f) => ({ ...f, stackable: e.target.checked }))}
            />
            Can combine with other promotions on the same bill
          </label>
          <div>
            <div className="label">Days of the week (IST)</div>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                    (form.weekdayMask >> i) & 1
                      ? 'border-pos-royal bg-pos-royal/10 text-pos-royal'
                      : 'border-slate-200 text-slate-400'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label">Stores (none selected = every store)</div>
            <div className="flex flex-wrap gap-2">
              {branches.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => toggleBranch(b.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                    form.branchIds.includes(b.id)
                      ? 'border-pos-royal bg-pos-royal/10 text-pos-royal'
                      : 'border-slate-200 text-slate-400'
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
          <ErrorNote message={formError} />
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Saving…' : editing === 'new' ? 'Create draft' : 'Save changes'}
          </button>
        </form>
      </Modal>
    </div>
  );
}
