import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  MapPin,
  Minus,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  ShoppingBasket,
  Store,
  Trash2,
  UserPlus,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useToast } from '../components/toast.jsx';
import { fmtINR, fmtDateTime } from '../lib/pos.js';
import { ErrorNote } from '../components/ui.jsx';
import {
  FULFILMENT_LABELS,
  conflictCustomerIdOf,
  errCode,
  newIdempotencyKey,
  reasonLabel,
  unavailableReasonsOf,
} from '../lib/vc104.js';

// VC-104 §5.7 — one idempotency key per FORM, minted when the form opens and
// reused across every retry and double-click of that submission. A new key is
// minted only by "Take another order", never by a click.

const pad = (n) => String(n).padStart(2, '0');
const localMinForSchedule = () => {
  const d = new Date(Date.now() + 5 * 60000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function SectionCard({ icon: Icon, step, title, hint, children }) {
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-pos-royal/10 text-xs font-bold text-pos-royal">
          {step}
        </div>
        {Icon ? <Icon className="h-4 w-4 text-slate-400" /> : null}
        <h2 className="text-sm font-bold text-pos-ink">{title}</h2>
        {hint ? <span className="text-xs text-slate-400">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ReasonPills({ reasons }) {
  if (!reasons?.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {reasons.map((r) => (
        <li key={`${r.code}-${r.message}`} className="flex items-start gap-2 text-xs">
          <span className="badge shrink-0 bg-amber-100 text-amber-700">{reasonLabel(r.code)}</span>
          <span className="text-slate-600">{r.message}</span>
        </li>
      ))}
    </ul>
  );
}

const addressLine = (a) =>
  [a.line1, a.line2, a.landmark, `${a.city} ${a.pincode}`].filter(Boolean).join(', ');

const EMPTY_ADDRESS_FORM = { label: '', line1: '', line2: '', landmark: '', city: '', pincode: '', isDefault: false };
const EMPTY_CUSTOMER_FORM = { name: '', phone: '', email: '', note: '' };

export default function PhoneOrderNew() {
  const toast = useToast();

  // Minted once per form open (§5.7). useState initialiser, so re-renders and
  // retries reuse the same key; only fullReset() mints a new one.
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey());

  // -- caller ----------------------------------------------------------------
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [results, setResults] = useState(null); // null = not searched yet
  const [customer, setCustomer] = useState(null); // detail incl. addresses + history
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [customerForm, setCustomerForm] = useState(EMPTY_CUSTOMER_FORM);
  const [customerFormError, setCustomerFormError] = useState('');
  const [duplicateId, setDuplicateId] = useState(null);
  const [customerBusy, setCustomerBusy] = useState(false);

  // -- fulfilment / address ----------------------------------------------------
  const [fulfilment, setFulfilment] = useState('DELIVERY');
  const [addressId, setAddressId] = useState(null);
  const [showNewAddress, setShowNewAddress] = useState(false);
  const [addressForm, setAddressForm] = useState(EMPTY_ADDRESS_FORM);
  const [addressFormError, setAddressFormError] = useState('');
  const [addressBusy, setAddressBusy] = useState(false);

  // -- schedule ---------------------------------------------------------------
  const [when, setWhen] = useState('ASAP'); // 'ASAP' | 'LATER'
  const [scheduledLocal, setScheduledLocal] = useState('');

  // -- items ------------------------------------------------------------------
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [itemFilter, setItemFilter] = useState('');
  const [variantPick, setVariantPick] = useState({}); // productId -> variantId
  const [basket, setBasket] = useState([]); // {productId, variantId, qty, name, variantName, price}

  // -- store options ----------------------------------------------------------
  const [options, setOptions] = useState(null);
  const [optionsAt, setOptionsAt] = useState(null);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const [branchId, setBranchId] = useState(null);

  // -- submit -----------------------------------------------------------------
  const [note, setNote] = useState('');
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [keyBurnt, setKeyBurnt] = useState(false); // POS_IDEMPOTENCY_KEY_REUSED
  const [submitted, setSubmitted] = useState(null); // server's phoneOrder

  const scheduledISO = when === 'LATER' && scheduledLocal ? new Date(scheduledLocal).toISOString() : null;

  // The options list is a point-in-time answer. Any input that fed it changes
  // → it is stale and the choice made on it is withdrawn (§5.6/§5.7: a stale
  // screen is re-judged by the server, but the screen should not present a
  // stale verdict as current either).
  const invalidateOptions = () => {
    setOptions(null);
    setOptionsAt(null);
    setBranchId(null);
    setOptionsError('');
  };

  // -- caller search -----------------------------------------------------------
  const searchSeq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setResults(null);
      setSearching(false);
      setSearchError('');
      return undefined;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/phone-orders/customers', { params: { q: term } });
        if (searchSeq.current !== seq) return;
        setResults(data.customers ?? []);
        setSearchError('');
      } catch (err) {
        if (searchSeq.current !== seq) return;
        setSearchError(apiError(err, 'Search failed'));
      } finally {
        if (searchSeq.current === seq) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const openCustomer = async (id) => {
    try {
      const { data } = await api.get(`/phone-orders/customers/${id}`);
      setCustomer(data.customer);
      setDuplicateId(null);
      setShowNewCustomer(false);
      setAddressId(data.customer.addresses.find((a) => a.isDefault && !a.archivedAt)?.id ?? null);
      invalidateOptions();
    } catch (err) {
      toast(apiError(err, 'Could not open that caller'), 'error');
    }
  };

  const createCustomer = async (e) => {
    e.preventDefault();
    setCustomerFormError('');
    setDuplicateId(null);
    setCustomerBusy(true);
    try {
      const { data } = await api.post('/phone-orders/customers', {
        name: customerForm.name.trim(),
        phone: customerForm.phone.trim(),
        email: customerForm.email.trim() || null,
        note: customerForm.note.trim() || null,
      });
      await openCustomer(data.customer.id);
      setCustomerForm(EMPTY_CUSTOMER_FORM);
    } catch (err) {
      // §5.2 — a duplicate phone number is a repeat caller, not a dead end: the
      // 409 carries the existing customer's id so the screen can offer to open
      // them instead.
      const dupId = errCode(err) === 'POS_CONFLICT' ? conflictCustomerIdOf(err) : null;
      if (dupId) setDuplicateId(dupId);
      setCustomerFormError(apiError(err, 'Could not save the caller'));
    } finally {
      setCustomerBusy(false);
    }
  };

  // -- addresses ---------------------------------------------------------------
  const refreshCustomer = async () => {
    if (!customer) return;
    const { data } = await api.get(`/phone-orders/customers/${customer.id}`);
    setCustomer(data.customer);
  };

  const createAddress = async (e) => {
    e.preventDefault();
    setAddressFormError('');
    setAddressBusy(true);
    try {
      const { data } = await api.post(`/phone-orders/customers/${customer.id}/addresses`, {
        label: addressForm.label.trim(),
        line1: addressForm.line1.trim(),
        line2: addressForm.line2.trim() || null,
        landmark: addressForm.landmark.trim() || null,
        city: addressForm.city.trim(),
        pincode: addressForm.pincode.trim(),
        isDefault: addressForm.isDefault,
      });
      await refreshCustomer();
      setAddressId(data.address.id);
      setShowNewAddress(false);
      setAddressForm(EMPTY_ADDRESS_FORM);
      invalidateOptions();
    } catch (err) {
      setAddressFormError(apiError(err, 'Could not save the address'));
    } finally {
      setAddressBusy(false);
    }
  };

  const patchAddress = async (id, patch, failMsg) => {
    try {
      await api.patch(`/phone-orders/customers/${customer.id}/addresses/${id}`, patch);
      await refreshCustomer();
      if (patch.archived && addressId === id) {
        setAddressId(null);
        invalidateOptions();
      }
    } catch (err) {
      toast(apiError(err, failMsg), 'error');
    }
  };

  // -- catalog -----------------------------------------------------------------
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data } = await api.get('/catalog/products');
        if (live) setCatalog(data.products ?? []);
      } catch (err) {
        if (live) setCatalogError(apiError(err, 'Could not load the menu'));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const visibleProducts = useMemo(() => {
    if (!catalog) return [];
    const term = itemFilter.trim().toLowerCase();
    const list = term ? catalog.filter((p) => p.name.toLowerCase().includes(term)) : catalog;
    return list.slice(0, 30);
  }, [catalog, itemFilter]);

  const addToBasket = (product) => {
    const activeVariants = (product.variants ?? []).filter((v) => v.status === 'ACTIVE');
    const variantId = activeVariants.length ? variantPick[product.id] || activeVariants[0].id : null;
    const variant = activeVariants.find((v) => v.id === variantId) ?? null;
    setBasket((b) => {
      const key = (l) => `${l.productId}|${l.variantId ?? ''}`;
      const lineKey = `${product.id}|${variantId ?? ''}`;
      const existing = b.find((l) => key(l) === lineKey);
      if (existing) return b.map((l) => (key(l) === lineKey ? { ...l, qty: Math.min(l.qty + 1, 999) } : l));
      return [
        ...b,
        {
          productId: product.id,
          variantId,
          qty: 1,
          name: product.name,
          variantName: variant?.name ?? null,
          // Menu price as sent by the server — shown per unit only. Line and
          // basket totals are never computed here; the payable amount is the
          // server's quote after submission (§3/§8).
          price: variant?.price ?? product.basePrice,
        },
      ];
    });
    invalidateOptions();
  };

  const bumpQty = (line, delta) => {
    setBasket((b) =>
      b
        .map((l) =>
          l.productId === line.productId && l.variantId === line.variantId
            ? { ...l, qty: Math.max(0, Math.min(l.qty + delta, 999)) }
            : l,
        )
        .filter((l) => l.qty > 0),
    );
    invalidateOptions();
  };

  const removeLine = (line) => {
    setBasket((b) => b.filter((l) => !(l.productId === line.productId && l.variantId === line.variantId)));
    invalidateOptions();
  };

  const itemsPayload = () =>
    basket.map((l) => ({ productId: l.productId, ...(l.variantId ? { variantId: l.variantId } : {}), qty: l.qty }));

  // -- store options -----------------------------------------------------------
  const readyForOptions =
    Boolean(customer) &&
    basket.length > 0 &&
    (fulfilment === 'PICKUP' || Boolean(addressId)) &&
    (when === 'ASAP' || Boolean(scheduledLocal));

  const checkStores = async () => {
    setOptionsBusy(true);
    setOptionsError('');
    try {
      const { data } = await api.post('/phone-orders/branch-options', {
        fulfilment,
        ...(fulfilment === 'DELIVERY' ? { addressId } : {}),
        ...(scheduledISO ? { scheduledFor: scheduledISO } : {}),
        items: itemsPayload(),
      });
      setOptions(data.options ?? []);
      setOptionsAt(new Date());
      setBranchId((prev) => {
        const still = (data.options ?? []).find((o) => o.branchId === prev);
        return still?.available ? prev : null;
      });
    } catch (err) {
      setOptionsError(apiError(err, 'Could not check the stores'));
    } finally {
      setOptionsBusy(false);
    }
  };

  // -- submit ------------------------------------------------------------------
  const canSubmit = readyForOptions && Boolean(branchId) && !submitBusy && !keyBurnt;

  const submit = async () => {
    setSubmitBusy(true);
    setSubmitError('');
    try {
      const res = await api.post('/phone-orders', {
        idempotencyKey: idemKey,
        customerId: customer.id,
        ...(fulfilment === 'DELIVERY' ? { addressId } : {}),
        fulfilment,
        branchId,
        ...(scheduledISO ? { scheduledFor: scheduledISO } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        items: itemsPayload(),
      });
      setSubmitted(res.data.phoneOrder);
      if (res.status === 200) {
        // §5.7 replay — this key already created the order; the server returned
        // the SAME order rather than a second one.
        toast('This submission had already gone through — showing the existing order.', 'info');
      } else {
        toast(`Phone order ${res.data.phoneOrder.reference} submitted.`, 'success');
      }
    } catch (err) {
      const code = errCode(err);
      if (code === 'POS_BRANCH_UNAVAILABLE') {
        // The screen was stale: the server re-judged the store and refused with
        // the same reason codes the selector uses. Surface them on the option.
        const reasons = unavailableReasonsOf(err);
        setOptions((opts) =>
          (opts ?? []).map((o) =>
            o.branchId === branchId ? { ...o, available: false, unavailableReasons: reasons } : o,
          ),
        );
        setBranchId(null);
        setSubmitError('That store can no longer take this order — its reasons are shown above. Pick another store or re-check.');
      } else if (code === 'POS_IDEMPOTENCY_KEY_REUSED') {
        setKeyBurnt(true);
        setSubmitError('This form’s submission key was already used for a different order. Start a fresh order below.');
      } else {
        setSubmitError(apiError(err, 'Could not submit the order'));
      }
    } finally {
      setSubmitBusy(false);
    }
  };

  const fullReset = () => {
    setIdemKey(newIdempotencyKey());
    setQ('');
    setResults(null);
    setCustomer(null);
    setShowNewCustomer(false);
    setCustomerForm(EMPTY_CUSTOMER_FORM);
    setCustomerFormError('');
    setDuplicateId(null);
    setFulfilment('DELIVERY');
    setAddressId(null);
    setShowNewAddress(false);
    setAddressForm(EMPTY_ADDRESS_FORM);
    setWhen('ASAP');
    setScheduledLocal('');
    setItemFilter('');
    setBasket([]);
    setNote('');
    setSubmitError('');
    setKeyBurnt(false);
    setSubmitted(null);
    invalidateOptions();
  };

  // -- success panel -----------------------------------------------------------
  if (submitted) {
    const storeName =
      options?.find((o) => o.branchId === submitted.routedBranchId)?.branchName ?? 'the routed store';
    return (
      <div className="mx-auto max-w-2xl">
        <div className="card p-6" data-testid="po-success">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-6 w-6" />
            <h1 className="text-xl font-bold text-pos-ink">
              {submitted.reference} — sent to {storeName}
            </h1>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {FULFILMENT_LABELS[submitted.fulfilment] ?? submitted.fulfilment}
            {' · '}
            {submitted.scheduledFor ? `scheduled for ${fmtDateTime(submitted.scheduledFor)}` : 'as soon as possible'}
            {' · '}taken by {submitted.operatorName}
          </p>

          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Read to the caller
            </div>
            <div className="mt-1 text-3xl font-extrabold tracking-tight text-pos-ink" data-testid="po-payable">
              {fmtINR(submitted.payableQuote)}
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Food &amp; tax (order total)</dt>
                <dd className="font-semibold text-pos-ink" data-testid="po-total">{fmtINR(submitted.order?.total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Delivery charge — quoted</dt>
                <dd className="font-semibold text-pos-ink" data-testid="po-delivery">{fmtINR(submitted.deliveryCharge)}</dd>
              </div>
            </dl>
            {submitted.deliveryChargeBillable === false ? (
              <p className="mt-3 text-xs leading-relaxed text-slate-500">
                The delivery charge is a quote collected with the bill. It is not on the tax
                invoice — its GST treatment is an open decision (contract C-6), so the invoice
                total will read {fmtINR(submitted.order?.total)}.
              </p>
            ) : null}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Link to="/phone-orders" className="btn-primary">Open phone orders</Link>
            <button type="button" className="btn-ghost" onClick={fullReset}>
              Take another order
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -- form --------------------------------------------------------------------
  const usableAddresses = customer?.addresses?.filter((a) => !a.archivedAt) ?? [];
  const archivedAddresses = customer?.addresses?.filter((a) => a.archivedAt) ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PhoneCall className="h-5 w-5 text-pos-royal" />
            <h1 className="text-2xl font-bold tracking-tight text-pos-ink">New phone order</h1>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Take the caller through: who, where, when, what — then pick the store and read back the quote.
          </p>
        </div>
        <Link to="/phone-orders" className="btn-ghost whitespace-nowrap">
          <ArrowLeft className="h-4 w-4" /> All phone orders
        </Link>
      </div>

      <div className="space-y-4">
        {/* 1 — caller */}
        <SectionCard icon={PhoneCall} step={1} title="Caller">
          {customer ? (
            <div>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-base font-bold text-pos-ink">{customer.name}</div>
                  <div className="text-sm text-slate-500">{customer.phone}{customer.email ? ` · ${customer.email}` : ''}</div>
                  {customer.note ? <div className="mt-1 text-xs text-amber-700">Note: {customer.note}</div> : null}
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setCustomer(null);
                    setAddressId(null);
                    invalidateOptions();
                  }}
                >
                  Change caller
                </button>
              </div>
              {customer.history?.length ? (
                <div className="mt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Recent phone orders
                  </div>
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                    <table className="w-full text-left text-xs">
                      <tbody>
                        {customer.history.map((h) => (
                          <tr key={h.phoneOrderId} className="border-b border-slate-100 last:border-0">
                            <td className="px-2 py-1.5 font-mono">{h.reference}</td>
                            <td className="px-2 py-1.5">{h.branchName ?? '—'}</td>
                            <td className="px-2 py-1.5">{FULFILMENT_LABELS[h.fulfilment] ?? h.fulfilment}</td>
                            <td className="px-2 py-1.5 text-right font-semibold">{fmtINR(h.total)}</td>
                            <td className="px-2 py-1.5">{h.status ?? '—'}</td>
                            <td className="px-2 py-1.5 font-mono text-slate-500">{h.invoiceNumber ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="input pl-9"
                  placeholder="Search by name or phone (at least 3 characters)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  autoFocus
                />
              </div>
              {q.trim().length > 0 && q.trim().length < 3 ? (
                <p className="mt-1 text-xs text-slate-400">Type at least 3 characters to search.</p>
              ) : null}
              <ErrorNote message={searchError} />
              {searching ? <p className="mt-2 text-xs text-slate-400">Searching…</p> : null}
              {results !== null && !searching ? (
                results.length ? (
                  <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {results.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50"
                          onClick={() => openCustomer(c.id)}
                        >
                          <span>
                            <span className="text-sm font-semibold text-pos-ink">{c.name}</span>
                            <span className="ml-2 text-xs text-slate-500">{c.phone}</span>
                          </span>
                          <span className="text-xs text-slate-400">
                            {c.addressCount} address{c.addressCount === 1 ? '' : 'es'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No caller matches that.</p>
                )
              ) : null}
              <div className="mt-3">
                {showNewCustomer ? (
                  <form onSubmit={createCustomer} className="space-y-3 rounded-lg border border-slate-200 p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="label" htmlFor="nc-name">Name</label>
                        <input id="nc-name" className="input" required maxLength={120} value={customerForm.name}
                          onChange={(e) => setCustomerForm((f) => ({ ...f, name: e.target.value }))} />
                      </div>
                      <div>
                        <label className="label" htmlFor="nc-phone">Phone</label>
                        <input id="nc-phone" className="input" required minLength={6} maxLength={20} value={customerForm.phone}
                          onChange={(e) => setCustomerForm((f) => ({ ...f, phone: e.target.value }))} />
                      </div>
                      <div>
                        <label className="label" htmlFor="nc-email">Email (optional)</label>
                        <input id="nc-email" className="input" type="email" maxLength={160} value={customerForm.email}
                          onChange={(e) => setCustomerForm((f) => ({ ...f, email: e.target.value }))} />
                      </div>
                      <div>
                        <label className="label" htmlFor="nc-note">Note (optional)</label>
                        <input id="nc-note" className="input" maxLength={500} value={customerForm.note}
                          onChange={(e) => setCustomerForm((f) => ({ ...f, note: e.target.value }))} />
                      </div>
                    </div>
                    <ErrorNote message={customerFormError} />
                    {duplicateId ? (
                      <button type="button" className="btn-ghost w-full justify-center" data-testid="po-open-duplicate" onClick={() => openCustomer(duplicateId)}>
                        Open the existing caller with this number
                      </button>
                    ) : null}
                    <div className="flex gap-2">
                      <button type="submit" className="btn-primary" disabled={customerBusy}>
                        {customerBusy ? 'Saving…' : 'Save caller'}
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setShowNewCustomer(false)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => setShowNewCustomer(true)}>
                    <UserPlus className="h-4 w-4" /> New caller
                  </button>
                )}
              </div>
            </div>
          )}
        </SectionCard>

        {/* 2 — fulfilment & address */}
        <SectionCard icon={MapPin} step={2} title="Pickup or delivery">
          <div className="flex gap-2">
            {['DELIVERY', 'PICKUP'].map((f) => (
              <button
                key={f}
                type="button"
                className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
                  fulfilment === f
                    ? 'border-pos-royal bg-pos-royal/10 text-pos-royal'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
                onClick={() => {
                  setFulfilment(f);
                  invalidateOptions();
                }}
              >
                {FULFILMENT_LABELS[f]}
              </button>
            ))}
          </div>
          {fulfilment === 'DELIVERY' ? (
            customer ? (
              <div className="mt-3">
                {usableAddresses.length ? (
                  <div className="space-y-2">
                    {usableAddresses.map((a) => (
                      <label
                        key={a.id}
                        className={`flex cursor-pointer items-start justify-between gap-3 rounded-lg border p-3 ${
                          addressId === a.id ? 'border-pos-royal bg-pos-royal/5' : 'border-slate-200'
                        }`}
                      >
                        <span className="flex items-start gap-2">
                          <input
                            type="radio"
                            name="address"
                            className="mt-1"
                            checked={addressId === a.id}
                            onChange={() => {
                              setAddressId(a.id);
                              invalidateOptions();
                            }}
                          />
                          <span>
                            <span className="text-sm font-semibold text-pos-ink">
                              {a.label}
                              {a.isDefault ? <span className="badge ml-2 bg-pos-royal/10 text-pos-royal">Default</span> : null}
                            </span>
                            <span className="block text-xs text-slate-500">{addressLine(a)}</span>
                          </span>
                        </span>
                        <span className="flex shrink-0 gap-1">
                          {!a.isDefault ? (
                            <button
                              type="button"
                              className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                              onClick={(e) => {
                                e.preventDefault();
                                patchAddress(a.id, { isDefault: true }, 'Could not set the default');
                              }}
                            >
                              Make default
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-red-50 hover:text-red-600"
                            onClick={(e) => {
                              e.preventDefault();
                              patchAddress(a.id, { archived: true }, 'Could not archive the address');
                            }}
                          >
                            Archive
                          </button>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-slate-500">No usable address on file for this caller.</p>
                )}
                {archivedAddresses.length ? (
                  <p className="mt-2 text-xs text-slate-400">
                    {archivedAddresses.length} archived address{archivedAddresses.length === 1 ? '' : 'es'} not shown —
                    archived addresses cannot take a delivery.
                  </p>
                ) : null}
                <div className="mt-3">
                  {showNewAddress ? (
                    <form onSubmit={createAddress} className="space-y-3 rounded-lg border border-slate-200 p-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="label" htmlFor="na-label">Label</label>
                          <input id="na-label" className="input" required maxLength={40} placeholder="Home / Office"
                            value={addressForm.label}
                            onChange={(e) => setAddressForm((f) => ({ ...f, label: e.target.value }))} />
                        </div>
                        <div>
                          <label className="label" htmlFor="na-line1">Address line 1</label>
                          <input id="na-line1" className="input" required maxLength={160} value={addressForm.line1}
                            onChange={(e) => setAddressForm((f) => ({ ...f, line1: e.target.value }))} />
                        </div>
                        <div>
                          <label className="label" htmlFor="na-line2">Line 2 (optional)</label>
                          <input id="na-line2" className="input" maxLength={160} value={addressForm.line2}
                            onChange={(e) => setAddressForm((f) => ({ ...f, line2: e.target.value }))} />
                        </div>
                        <div>
                          <label className="label" htmlFor="na-landmark">Landmark (optional)</label>
                          <input id="na-landmark" className="input" maxLength={120} value={addressForm.landmark}
                            onChange={(e) => setAddressForm((f) => ({ ...f, landmark: e.target.value }))} />
                        </div>
                        <div>
                          <label className="label" htmlFor="na-city">City</label>
                          <input id="na-city" className="input" required maxLength={80} value={addressForm.city}
                            onChange={(e) => setAddressForm((f) => ({ ...f, city: e.target.value }))} />
                        </div>
                        <div>
                          <label className="label" htmlFor="na-pincode">Pincode</label>
                          <input id="na-pincode" className="input" required pattern="\d{6}" maxLength={6}
                            title="6 digits" value={addressForm.pincode}
                            onChange={(e) => setAddressForm((f) => ({ ...f, pincode: e.target.value.replace(/\D/g, '') }))} />
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input type="checkbox" checked={addressForm.isDefault}
                          onChange={(e) => setAddressForm((f) => ({ ...f, isDefault: e.target.checked }))} />
                        Make this the default address
                      </label>
                      <ErrorNote message={addressFormError} />
                      <div className="flex gap-2">
                        <button type="submit" className="btn-primary" disabled={addressBusy}>
                          {addressBusy ? 'Saving…' : 'Save address'}
                        </button>
                        <button type="button" className="btn-ghost" onClick={() => setShowNewAddress(false)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <button type="button" className="btn-ghost" onClick={() => setShowNewAddress(true)}>
                      <Plus className="h-4 w-4" /> Add address
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-400">Pick the caller first — delivery needs one of their addresses.</p>
            )
          ) : (
            <p className="mt-3 text-xs text-slate-500">The caller collects from the store; no address is needed.</p>
          )}
        </SectionCard>

        {/* 3 — when */}
        <SectionCard icon={Clock} step={3} title="When">
          <div className="flex flex-wrap items-center gap-2">
            {[
              ['ASAP', 'As soon as possible'],
              ['LATER', 'Schedule for later'],
            ].map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
                  when === v
                    ? 'border-pos-royal bg-pos-royal/10 text-pos-royal'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
                onClick={() => {
                  setWhen(v);
                  invalidateOptions();
                }}
              >
                {label}
              </button>
            ))}
            {when === 'LATER' ? (
              <input
                type="datetime-local"
                className="input w-auto"
                min={localMinForSchedule()}
                value={scheduledLocal}
                onChange={(e) => {
                  setScheduledLocal(e.target.value);
                  invalidateOptions();
                }}
              />
            ) : null}
          </div>
          {when === 'LATER' ? (
            <p className="mt-2 text-xs text-slate-500">The time must be in the future; the stores are judged for that moment.</p>
          ) : null}
        </SectionCard>

        {/* 4 — items */}
        <SectionCard icon={ShoppingBasket} step={4} title="Items" hint="menu prices shown per unit — the payable amount is quoted by the server after submission">
          <ErrorNote message={catalogError} />
          {catalog === null && !catalogError ? <p className="text-xs text-slate-400">Loading the menu…</p> : null}
          {catalog !== null ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <input
                  className="input"
                  placeholder="Filter the menu…"
                  value={itemFilter}
                  onChange={(e) => setItemFilter(e.target.value)}
                />
                <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
                  {visibleProducts.map((p) => {
                    const activeVariants = (p.variants ?? []).filter((v) => v.status === 'ACTIVE');
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-pos-ink">{p.name}</div>
                          <div className="text-xs text-slate-500">
                            {activeVariants.length ? (
                              <select
                                className="mt-0.5 rounded border border-slate-200 px-1 py-0.5 text-xs"
                                value={variantPick[p.id] || activeVariants[0].id}
                                onChange={(e) => setVariantPick((m) => ({ ...m, [p.id]: e.target.value }))}
                              >
                                {activeVariants.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.name} · {fmtINR(v.price)}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              fmtINR(p.basePrice)
                            )}
                          </div>
                        </div>
                        <button type="button" className="btn-ghost shrink-0" onClick={() => addToBasket(p)} aria-label={`Add ${p.name}`}>
                          <Plus className="h-4 w-4" />
                        </button>
                      </li>
                    );
                  })}
                  {visibleProducts.length === 0 ? (
                    <li className="px-3 py-6 text-center text-sm text-slate-400">Nothing on the menu matches.</li>
                  ) : null}
                </ul>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">This order</div>
                {basket.length ? (
                  <ul className="mt-2 space-y-1">
                    {basket.map((l) => (
                      <li key={`${l.productId}|${l.variantId ?? ''}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-pos-ink">
                            {l.name}
                            {l.variantName ? <span className="text-slate-500"> · {l.variantName}</span> : null}
                          </div>
                          <div className="text-xs text-slate-500">{fmtINR(l.price)} each</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button type="button" className="rounded p-1 hover:bg-slate-200" onClick={() => bumpQty(l, -1)} aria-label="Less">
                            <Minus className="h-4 w-4" />
                          </button>
                          <span className="w-7 text-center text-sm font-bold">{l.qty}</span>
                          <button type="button" className="rounded p-1 hover:bg-slate-200" onClick={() => bumpQty(l, +1)} aria-label="More">
                            <Plus className="h-4 w-4" />
                          </button>
                          <button type="button" className="ml-1 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => removeLine(l)} aria-label="Remove">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-slate-400">Nothing yet — add items from the menu.</p>
                )}
              </div>
            </div>
          ) : null}
        </SectionCard>

        {/* 5 — store */}
        <SectionCard icon={Store} step={5} title="Store" hint={optionsAt ? `checked at ${optionsAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : undefined}>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary" data-testid="po-check-stores" disabled={!readyForOptions || optionsBusy} onClick={checkStores}>
              <RefreshCw className={`h-4 w-4 ${optionsBusy ? 'animate-spin' : ''}`} />
              {options ? 'Re-check stores' : 'Check stores'}
            </button>
            {!readyForOptions ? (
              <span className="text-xs text-slate-400">Needs a caller, items{fulfilment === 'DELIVERY' ? ', an address' : ''}{when === 'LATER' ? ' and a time' : ''}.</span>
            ) : null}
          </div>
          <ErrorNote message={optionsError} />
          {options ? (
            <div className="mt-3 space-y-2" data-testid="po-options">
              {options.map((o) => (
                <label
                  key={o.branchId}
                  data-testid={`po-option-${o.branchCode}`}
                  className={`block rounded-lg border p-3 ${
                    o.available
                      ? branchId === o.branchId
                        ? 'cursor-pointer border-pos-royal bg-pos-royal/5'
                        : 'cursor-pointer border-slate-200 hover:bg-slate-50'
                      : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="branch"
                        className="mt-1"
                        disabled={!o.available}
                        checked={branchId === o.branchId}
                        onChange={() => setBranchId(o.branchId)}
                      />
                      <span>
                        <span className="text-sm font-bold text-pos-ink">
                          {o.branchName} <span className="font-mono text-xs text-slate-400">{o.branchCode}</span>
                        </span>
                        <span className="block text-xs text-slate-500">
                          {o.hours ? `${o.hours.opensAt}–${o.hours.closesAt}` : 'hours not stated'}
                          {o.capacity ? ` · ${o.capacity.booked}/${o.capacity.maxOrdersPerSlot} booked this ${o.capacity.slotMinutes}-min slot` : ''}
                        </span>
                        {fulfilment === 'DELIVERY' ? (
                          <span className="block text-xs text-slate-500">
                            Delivery {fmtINR(o.deliveryCharge)}
                            {o.minOrder !== null && o.minOrder !== undefined ? ` · min order ${fmtINR(o.minOrder)}` : ''}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className={`badge shrink-0 ${o.available ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                      {o.available ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                  <ReasonPills reasons={o.unavailableReasons} />
                </label>
              ))}
            </div>
          ) : null}
        </SectionCard>

        {/* 6 — note + submit */}
        <SectionCard icon={CheckCircle2} step={6} title="Submit">
          <div>
            <label className="label" htmlFor="order-note">Note for the store (optional)</label>
            <input
              id="order-note"
              className="input"
              maxLength={500}
              placeholder="e.g. ring the bell twice"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <ErrorNote message={submitError} />
          {keyBurnt ? (
            <button type="button" className="mt-3 btn-ghost w-full justify-center" onClick={fullReset}>
              Start a fresh order
            </button>
          ) : (
            <button type="button" className="btn-primary mt-3 w-full" data-testid="po-submit" disabled={!canSubmit} onClick={submit}>
              {submitBusy ? 'Submitting…' : 'Submit phone order'}
            </button>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-slate-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            The store is checked again at submission — if it has closed or filled up since the list
            above was drawn, the order is refused with the reason, never silently taken.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
