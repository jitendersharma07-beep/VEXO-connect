// VC-102 promotions — the owner's campaign screen against Window 1's landed
// API. Rules are drafted here, published/paused/archived here; what they do
// to a bill is the server's business alone (lib/promotions.js + the order
// promotion routes). Money fields travel as integer paise; percent as a
// number. "Live now" is a client-side advisory recomputed in IST — the
// server re-decides eligibility on every application.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, Megaphone, PauseCircle, Pencil, PlusCircle, Radio, Tag, Trash2, Utensils,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { fmtINR, licenseUsable } from '../lib/pos.js';
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

// The four rule kinds the server accepts, in the order the form offers them,
// with the wording the server's own logic justifies (lib/promotions.js:52-71):
// ANY include rule narrows the promotion to matching lines; EXCLUDE_PRODUCT wins
// outright; a product rule outranks that product's category rule either way.
const RULE_KINDS = [
  { value: 'INCLUDE_CATEGORY', label: 'Only this category', target: 'category' },
  { value: 'EXCLUDE_CATEGORY', label: 'Never this category', target: 'category' },
  { value: 'INCLUDE_PRODUCT', label: 'Only this item', target: 'product' },
  { value: 'EXCLUDE_PRODUCT', label: 'Never this item', target: 'product' },
];
const RULE_LABEL = Object.fromEntries(RULE_KINDS.map((k) => [k.value, k.label]));

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
  // The endMinute the server last told us, kept beside the editable field. See
  // the note on submit(): endMinute may be 1440 and a time input cannot hold it.
  timeToRaw: null,
  channel: '',
  stackable: false,
  precedence: '100',
  totalLimit: '',
  perCustomerLimit: '',
  branchIds: [],
  rules: [],
};

const ruleText = (r, names) => {
  const target = r.categoryId ? names.categories.get(r.categoryId) : names.products.get(r.productId);
  return `${RULE_LABEL[r.kind]}: ${target ?? '(removed from the catalogue)'}`;
};

const sameRules = (a, b) => {
  const key = (r) => `${r.kind}|${r.categoryId ?? ''}|${r.productId ?? ''}`;
  if (a.length !== b.length) return false;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
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
  const { user, license } = useAuth();
  const { can } = usePermissions();
  const [promotions, setPromotions] = useState(null);
  const [branches, setBranches] = useState([]);
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | promotion object
  const [form, setForm] = useState(BLANK_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(null);
  const [lifecycleBusy, setLifecycleBusy] = useState('');
  // The rule picker's two fields: which kind, pointing at what. Reset whenever
  // the form opens, so a half-built rule never leaks into the next edit.
  const [ruleKind, setRuleKind] = useState('INCLUDE_CATEGORY');
  const [ruleTarget, setRuleTarget] = useState('');

  // The route is gated on promo.read, so reaching this page means the list is
  // readable. Writing is a separate action and publishing a third — a FINANCE or
  // REGIONAL_MANAGER user holds only promo.read and sees this screen read-only
  // rather than being offered buttons the server will refuse.
  const licenceOk = licenseUsable(license, user);
  const mayWrite = can('promo.write') && licenceOk;
  const mayPublish = can('promo.publish') && licenceOk;

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

  // The catalogue is needed to NAME an item rule — both in the editor and in the
  // list, where a rule with no name to show would read as a rule pointing at a
  // deleted product. Loaded once, on first need, rather than on every page view:
  // a company can have thousands of products and most promotions have no rules.
  const loadCatalogue = useCallback(async () => {
    if (categories.length || products.length) return;
    try {
      const [catRes, prodRes] = await Promise.all([
        api.get('/catalog/categories'),
        api.get('/catalog/products'),
      ]);
      setCategories(catRes.data.categories || []);
      setProducts(prodRes.data.products || []);
    } catch {
      // Not fatal: without the catalogue the rule editor says so and every other
      // field still saves.
    }
  }, [categories.length, products.length]);

  // Rules already in use need their names on the list, not just in the editor.
  useEffect(() => {
    if (promotions?.some((p) => (p.rules ?? []).length)) loadCatalogue();
  }, [promotions, loadCatalogue]);

  const names = useMemo(
    () => ({
      categories: new Map(categories.map((c) => [c.id, c.name])),
      products: new Map(products.map((p) => [p.id, p.name])),
    }),
    [categories, products],
  );

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
    loadCatalogue();
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
      // hold; 23:59 is the closest editable value, and timeToRaw remembers the
      // real one so that merely opening the form does not shorten the window.
      timeTo: p.endMinute === null ? '' : minToHHMM(Math.min(p.endMinute, 1439)),
      timeToRaw: p.endMinute,
      channel: p.channel ?? '',
      stackable: p.stackable,
      precedence: String(p.precedence),
      totalLimit: p.totalLimit === null ? '' : String(p.totalLimit),
      perCustomerLimit: p.perCustomerLimit === null ? '' : String(p.perCustomerLimit),
      branchIds: (p.stores ?? []).map((s) => s.branchId),
      rules: (p.rules ?? []).map((r) => ({
        kind: r.kind,
        categoryId: r.categoryId ?? null,
        productId: r.productId ?? null,
      })),
    });
    setFormError('');
    setEditing(p);
    loadCatalogue();
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  // Editing the field by hand is the one thing that may discard the remembered
  // 1440: from then on the field IS the value.
  const setTimeTo = (e) => setForm((f) => ({ ...f, timeTo: e.target.value, timeToRaw: null }));
  const setUntilMidnight = () => setForm((f) => ({ ...f, timeTo: '23:59', timeToRaw: 1440 }));
  const toggleDay = (i) => setForm((f) => ({ ...f, weekdayMask: f.weekdayMask ^ (1 << i) }));
  const toggleBranch = (id) =>
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((b) => b !== id)
        : [...f.branchIds, id],
    }));

  const addRule = (rule) =>
    setForm((f) =>
      f.rules.some((r) => r.kind === rule.kind && r.categoryId === rule.categoryId && r.productId === rule.productId)
        ? f
        : { ...f, rules: [...f.rules, rule] },
    );
  const removeRule = (i) => setForm((f) => ({ ...f, rules: f.rules.filter((_, n) => n !== i) }));

  const ruleTargetType = RULE_KINDS.find((k) => k.value === ruleKind).target;

  useEffect(() => {
    if (editing !== null) {
      setRuleKind('INCLUDE_CATEGORY');
      setRuleTarget('');
    }
  }, [editing]);

  const changeRuleKind = (e) => {
    const next = e.target.value;
    const nextTarget = RULE_KINDS.find((k) => k.value === next).target;
    setRuleKind(next);
    // A category id left sitting in what is now a product select would send the
    // server a rule pointing at nothing — 400 "One or more categories/products
    // do not exist" — so switching target types clears the selection.
    if (nextTarget !== ruleTargetType) setRuleTarget('');
  };

  const addPendingRule = () => {
    if (!ruleTarget) return;
    addRule({
      kind: ruleKind,
      categoryId: ruleTargetType === 'category' ? ruleTarget : null,
      productId: ruleTargetType === 'product' ? ruleTarget : null,
    });
    setRuleTarget('');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (form.weekdayMask === 0) {
      setFormError('Pick at least one day of the week');
      return;
    }
    // The server refuses one minute set without the other (promotions.js:111),
    // which as a form error is clearer said here than fetched.
    if (!form.timeFrom !== !form.timeTo) {
      setFormError('Set both daily times or neither');
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
      // endMinute is EXCLUSIVE and the schema allows 1440 — midnight at the end
      // of the day — which <input type="time"> tops out one minute short of. A
      // form that displayed 23:59 and then saved 23:59 would shorten a
      // to-midnight window by a minute every time anyone opened the record, so
      // the value the server gave us is re-sent unless the operator moved the
      // field themselves.
      endMinute: form.timeTo === '' ? null : (form.timeToRaw ?? hhmmToMin(form.timeTo)),
      channel: form.channel || null,
      stackable: form.stackable,
      precedence: form.precedence === '' ? 100 : Number(form.precedence),
      totalLimit: intOr(form.totalLimit),
      perCustomerLimit: intOr(form.perCustomerLimit),
    };
    try {
      if (editing === 'new') {
        const { data } = await api.post('/promotions', body);
        // Targeting is two more routes, and they need the id the create just
        // minted. A failure here leaves a DRAFT that exists but is not targeted
        // — which is why the message names that outcome instead of claiming
        // everything saved.
        if (form.branchIds.length) {
          await api.put(`/promotions/${data.promotion.id}/stores`, { branchIds: form.branchIds });
        }
        if (form.rules.length) {
          await api.put(`/promotions/${data.promotion.id}/rules`, { rules: form.rules });
        }
        toast('Promotion created as a draft. Publish it to switch it on.', 'success');
      } else {
        await api.patch(`/promotions/${editing.id}`, body);
        // PUT /stores and PUT /rules bump the version of a published promotion
        // even when nothing changed, and a version bump is what redemptions
        // snapshot — so only send them when the set actually moved.
        const before = sortedIds((editing.stores ?? []).map((s) => s.branchId));
        if (before !== sortedIds(form.branchIds)) {
          await api.put(`/promotions/${editing.id}/stores`, { branchIds: form.branchIds });
        }
        if (!sameRules(editing.rules ?? [], form.rules)) {
          await api.put(`/promotions/${editing.id}/rules`, { rules: form.rules });
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
    if (lifecycleBusy) return;
    setLifecycleBusy(`${p.id}:${action}`);
    try {
      await api.post(`/promotions/${p.id}/${action}`);
      toast(
        action === 'publish' ? `${p.name} is published` : action === 'pause' ? `${p.name} is paused` : `${p.name} is archived`,
        'success',
      );
      await load();
    } catch (err) {
      // The server refuses an illegal transition with a 409 naming the current
      // status, which is more useful than anything invented here. Reload either
      // way: a refusal usually means someone else already moved it.
      toast(apiError(err, `Could not ${action} this promotion`), 'error');
      await load();
    } finally {
      setLifecycleBusy('');
    }
  };

  const archive = async () => {
    const p = confirmArchive;
    setConfirmArchive(null);
    await lifecycle(p, 'archive');
  };

  const scopeText = (p) =>
    p.stores.length === 0 ? 'All stores' : p.stores.map((s) => s.branchName || 'Store').join(', ');

  // Stores that may be targeted: the active ones, plus any store this promotion
  // already targets even if it has since been deactivated. Filtering that one
  // out would drop it from the form's list and then delete the link on save,
  // silently un-targeting a store nobody asked to un-target.
  const targetableBranches = useMemo(() => {
    const linked = new Set(form.branchIds);
    return branches.filter((b) => b.status === 'ACTIVE' || linked.has(b.id));
  }, [branches, form.branchIds]);

  return (
    <div>
      <PageHeader
        title="Promotions"
        subtitle="Scheduled offers applied at the till — automatically from the offers list, or by code. The server computes every benefit."
        actions={
          mayWrite ? (
            <button type="button" className="btn-primary flex items-center gap-2" onClick={openNew}>
              <PlusCircle className="h-4 w-4" /> New promotion
            </button>
          ) : null
        }
      />
      {/* Said plainly rather than leaving an operator hunting for a button that
          is not there. Two separate reasons, so two separate sentences. */}
      {!mayWrite ? (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {licenceOk
            ? 'You can review campaigns here. Creating, editing and publishing them needs a promotions role.'
            : 'This company’s licence does not currently allow changes. Campaigns are shown read-only.'}
        </div>
      ) : null}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard icon={Radio} label="Live now" value={stats.live} accent="green" />
        <StatCard icon={Megaphone} label="Published" value={stats.published} />
        <StatCard icon={Pencil} label="Drafts" value={stats.draft} accent="orange" />
      </div>
      <ErrorNote message={loadError} />

      {promotions === null ? (
        <div className="card p-6 text-center text-sm text-slate-500">Loading campaigns…</div>
      ) : promotions.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No promotions yet"
          note={
            mayWrite
              ? 'Create an offer — a happy-hour percentage, a flat amount over a minimum spend, or a coded deal — and publish it when it should start applying.'
              : 'Nobody has set up a campaign for this company yet.'
          }
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
                    {(p.rules ?? []).length ? (
                      <div className="mt-1 flex items-start gap-1 text-slate-600">
                        <Utensils className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{p.rules.map((r) => ruleText(r, names)).join(' · ')}</span>
                      </div>
                    ) : null}
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
                  {/* Edit needs promo.write; publish, pause and archive need
                      promo.publish. Two different actions, so two different
                      gates — a role may hold one without the other, and the
                      server enforces exactly this split. */}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {mayWrite && p.status !== 'ARCHIVED' ? (
                        <button
                          type="button"
                          className="btn-ghost flex items-center gap-1 text-xs"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </button>
                      ) : null}
                      {mayPublish && (p.status === 'DRAFT' || p.status === 'PAUSED') ? (
                        <button
                          type="button"
                          className="btn-primary flex items-center gap-1 px-3 py-1.5 text-xs"
                          disabled={!!lifecycleBusy}
                          onClick={() => lifecycle(p, 'publish')}
                        >
                          <Radio className="h-3.5 w-3.5" /> {p.status === 'PAUSED' ? 'Resume' : 'Publish'}
                        </button>
                      ) : null}
                      {mayPublish && p.status === 'PUBLISHED' ? (
                        <button
                          type="button"
                          className="btn-ghost flex items-center gap-1 text-xs text-orange-600"
                          disabled={!!lifecycleBusy}
                          onClick={() => lifecycle(p, 'pause')}
                        >
                          <PauseCircle className="h-3.5 w-3.5" /> Pause
                        </button>
                      ) : null}
                      {mayPublish && p.status !== 'ARCHIVED' ? (
                        <button
                          type="button"
                          className="btn-ghost flex items-center gap-1 text-xs text-slate-500"
                          disabled={!!lifecycleBusy}
                          onClick={() => setConfirmArchive(p)}
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
              <input id="promo-to" className="input" type="time" value={form.timeTo} onChange={setTimeTo} />
              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                {form.timeToRaw === 1440 ? (
                  <span className="font-semibold text-pos-royal">Runs until midnight (24:00)</span>
                ) : (
                  <button type="button" className="underline" onClick={setUntilMidnight}>
                    Until midnight
                  </button>
                )}
                <span>· the end time is exclusive</span>
              </div>
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
              {targetableBranches.map((b) => (
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
                  {b.status !== 'ACTIVE' ? ' (inactive)' : ''}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label">Item rules (none = the whole bill)</div>
            {form.rules.length ? (
              <ul className="mb-2 space-y-1.5">
                {form.rules.map((r, i) => (
                  <li
                    key={`${r.kind}|${r.categoryId ?? ''}|${r.productId ?? ''}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate text-slate-600">{ruleText(r, names)}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      onClick={() => removeRule(i)}
                      aria-label={`Remove rule: ${ruleText(r, names)}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {/* Existing rules stay listed (and removable) even when the catalogue
                could not be read — only ADDING needs names to choose from. */}
            {categories.length || products.length ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="input w-auto"
                    value={ruleKind}
                    onChange={changeRuleKind}
                    aria-label="Rule kind"
                  >
                    {RULE_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>{k.label}</option>
                    ))}
                  </select>
                  <select
                    className="input min-w-0 flex-1"
                    value={ruleTarget}
                    onChange={(e) => setRuleTarget(e.target.value)}
                    aria-label={ruleTargetType === 'category' ? 'Category' : 'Item'}
                  >
                    <option value="">
                      {ruleTargetType === 'category' ? 'Choose a category…' : 'Choose an item…'}
                    </option>
                    {(ruleTargetType === 'category' ? categories : products).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={!ruleTarget}
                    onClick={addPendingRule}
                  >
                    Add rule
                  </button>
                </div>
                {/* Mirrors lib/promotions.js:52-71 — see RULE_KINDS above. */}
                <div className="mt-1 text-[11px] text-slate-500">
                  “Only” rules narrow the offer to matching lines · an item rule outranks its
                  category rule · “Never this item” always wins.
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
                No categories or items are available to build a rule against — the rest of the
                form still saves.
              </div>
            )}
          </div>
          <ErrorNote message={formError} />
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Saving…' : editing === 'new' ? 'Create draft' : 'Save changes'}
          </button>
        </form>
      </Modal>

      {/* Archive is the one transition with no way back (the server refuses
          every edit and every lifecycle call on an ARCHIVED promotion), so it
          is the one action that asks first. Clicking outside cancels. */}
      <Modal
        open={confirmArchive !== null}
        title="Archive this promotion?"
        onClose={() => setConfirmArchive(null)}
      >
        {confirmArchive ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-pos-ink">{confirmArchive.name}</span>
              {confirmArchive.status === 'PUBLISHED'
                ? ' is published — archiving switches it off at the till immediately.'
                : ` is ${confirmArchive.status === 'DRAFT' ? 'a draft' : 'paused'} and is not applying to bills now.`}
            </p>
            <p className="text-sm text-slate-600">
              Archiving is permanent: an archived promotion cannot be edited, published or
              brought back
              {confirmArchive.redemptionCount
                ? `. Its ${confirmArchive.redemptionCount} recorded redemption${
                    confirmArchive.redemptionCount === 1 ? ' stays' : 's stay'
                  } on the books.`
                : '.'}
              {confirmArchive.status === 'PUBLISHED'
                ? ' To take it off the till and bring it back later, use Pause instead.'
                : ''}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost flex-1"
                onClick={() => setConfirmArchive(null)}
              >
                Keep it
              </button>
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={!!lifecycleBusy}
                onClick={archive}
              >
                Archive permanently
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
