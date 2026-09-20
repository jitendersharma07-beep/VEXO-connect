import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Armchair,
  Ban,
  IndianRupee,
  Minus,
  Package,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Send,
  ShoppingBag,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { ErrorNote, Modal, ReasonModal } from '../components/ui.jsx';
import { KotListModal, KotModal, ReceiptModal } from '../components/Receipt.jsx';
import {
  MANUAL_PAYMENT_LABEL,
  ORDER_STATUS_STYLES,
  fmtINR,
  fmtTime,
  isLicenseError,
  isManagerUp,
  licenseUsable,
} from '../lib/pos.js';

// /sell — cashier screen (contract §11): catalog grid + server-driven cart.
// The order object is ALWAYS the server's latest response; no rupee amount on
// this screen is computed client-side.

function OrderStatusBadge({ status }) {
  return <span className={`badge ${ORDER_STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

function DiscountModal({ open, order, onClose, onOrder }) {
  const [type, setType] = useState('FLAT');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setType(order?.discount?.type || 'FLAT');
      setValue(order?.discount ? String(order.discount.value) : '');
      setError('');
      setBusy(false);
    }
  }, [open, order?.id]);

  if (!open || !order) return null;

  const apply = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/discount`, { type, value: Number(value) });
      onOrder(data.order);
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setError('');
    setBusy(true);
    try {
      const { data } = await api.delete(`/orders/${order.id}/discount`);
      onOrder(data.order);
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="Order discount" onClose={onClose}>
      <form onSubmit={apply} className="space-y-4">
        <div className="flex gap-2">
          {['FLAT', 'PERCENT'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`btn flex-1 ${type === t ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
            >
              {t === 'FLAT' ? '₹ Flat' : '% Percent'}
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="disc-value">
            {type === 'FLAT' ? `Amount in ₹ (up to subtotal ${fmtINR(order.subtotal)})` : 'Percent (0–100)'}
          </label>
          <input
            id="disc-value"
            type="number"
            className="input"
            min="0"
            max={type === 'PERCENT' ? 100 : undefined}
            step={type === 'FLAT' ? '0.01' : '0.001'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            autoFocus
          />
        </div>
        <ErrorNote message={error} />
        <div className="flex gap-2">
          {order.discount ? (
            <button type="button" className="btn-ghost flex-1" onClick={clear} disabled={busy}>
              Remove discount
            </button>
          ) : null}
          <button type="submit" className="btn-primary flex-1" disabled={busy || value === ''}>
            {busy ? 'Applying…' : 'Apply discount'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function VariantModal({ product, onPick, onClose }) {
  if (!product) return null;
  const variants = (product.variants || []).filter((v) => v.status === 'ACTIVE');
  return (
    <Modal open title={product.name} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-500">Choose a size / variant.</p>
      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold hover:border-pos-royal hover:bg-pos-royal/5"
          onClick={() => onPick(product, null)}
        >
          <span>Regular</span>
          <span>{fmtINR(product.basePrice)}</span>
        </button>
        {variants.map((v) => (
          <button
            key={v.id}
            type="button"
            className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold hover:border-pos-royal hover:bg-pos-royal/5"
            onClick={() => onPick(product, v)}
          >
            <span>{v.name}</span>
            <span>{fmtINR(v.price)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// Records a MANUAL payment (contract §5.3). Change due comes from the server
// response — never computed here.
function PaymentModal({ open, order, onClose, onOrder, onPaid }) {
  const [method, setMethod] = useState('CASH');
  const [tendered, setTendered] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { payment, changeDue, orderStatus }

  useEffect(() => {
    if (open && order) {
      setMethod('CASH');
      setTendered('');
      setAmount(String(order.amountDue ?? ''));
      setNote('');
      setError('');
      setBusy(false);
      setResult(null);
    }
  }, [open, order?.id]);

  if (!open || !order) return null;

  const due = order.amountDue;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload =
        method === 'CASH'
          ? { method, tendered: Number(tendered) }
          : { method, amount: Number(amount), ...(note.trim() ? { note: note.trim() } : {}) };
      const { data } = await api.post(`/orders/${order.id}/payments`, payload);
      onOrder(data.order);
      setResult({ payment: data.payment, changeDue: data.changeDue, orderStatus: data.order.status });
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const startAnother = () => {
    setMethod('CASH');
    setTendered('');
    setAmount(String(order.amountDue ?? ''));
    setNote('');
    setError('');
    setResult(null);
  };

  return (
    <Modal open title="Record payment" onClose={onClose}>
      {/* §5.3: manual records are labelled exactly like this — no gateway wording. */}
      <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-amber-800">
        {MANUAL_PAYMENT_LABEL}
      </div>
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="text-sm font-bold text-emerald-800">Payment recorded.</div>
            <div className="mt-1 text-sm text-emerald-800">
              {result.payment?.method} · {fmtINR(result.payment?.amount)}
              {result.payment?.tendered !== null && result.payment?.tendered !== undefined
                ? ` (tendered ${fmtINR(result.payment.tendered)})`
                : ''}
            </div>
          </div>
          {result.changeDue !== null && result.changeDue !== undefined && Number(result.changeDue) > 0 ? (
            <div className="rounded-lg bg-pos-royal/5 px-4 py-3 text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Change due</div>
              <div className="text-3xl font-extrabold text-pos-ink">{fmtINR(result.changeDue)}</div>
            </div>
          ) : null}
          {result.orderStatus === 'PAID' ? (
            <button type="button" className="btn-primary w-full" onClick={() => onPaid()}>
              Order paid in full — view receipt
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-center text-sm text-slate-600">
                Amount still due: <span className="font-bold">{fmtINR(order.amountDue)}</span>
              </div>
              <button type="button" className="btn-primary w-full" onClick={startAnother}>
                Record another payment
              </button>
              <button type="button" className="btn-ghost w-full" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-lg bg-slate-50 px-4 py-2 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Amount due</div>
            <div className="text-2xl font-extrabold text-pos-ink">{fmtINR(due)}</div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {['CASH', 'CARD', 'UPI', 'OTHER'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`btn px-2 ${method === m ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
              >
                {m}
              </button>
            ))}
          </div>
          {method === 'CASH' ? (
            <div>
              <label className="label" htmlFor="pay-tendered">Cash tendered (₹)</label>
              <div className="flex gap-2">
                <input
                  id="pay-tendered"
                  type="number"
                  className="input"
                  min="0"
                  step="0.01"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  required
                  autoFocus
                />
                <button type="button" className="btn-ghost shrink-0" onClick={() => setTendered(String(due))}>
                  Exact
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">Change due is calculated by the server.</p>
            </div>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="pay-amount">Amount received (₹)</label>
                <input
                  id="pay-amount"
                  type="number"
                  className="input"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="label" htmlFor="pay-note">Note (optional, e.g. "GPay, manual entry")</label>
                <input
                  id="pay-note"
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                />
              </div>
            </>
          )}
          <ErrorNote message={error} />
          <button
            type="submit"
            className="btn-orange w-full"
            disabled={busy || (method === 'CASH' ? tendered === '' || Number(tendered) <= 0 : amount === '' || Number(amount) <= 0)}
          >
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </form>
      )}
    </Modal>
  );
}

export default function Sell() {
  const { user, license } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const owner = user.role === 'CUSTOMER_OWNER';
  const managerUp = isManagerUp(user);
  const licenseBlocked = !licenseUsable(license, user);
  const [licMsg, setLicMsg] = useState('');

  // catalog
  const [cats, setCats] = useState(null);
  const [catError, setCatError] = useState('');
  const [activeCat, setActiveCat] = useState('ALL');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [products, setProducts] = useState(null);
  const [prodError, setProdError] = useState('');

  // order context
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // TAKEAWAY | DINE_IN (pre-order)
  const [tableId, setTableId] = useState(null);
  const [tables, setTables] = useState(null);
  const [tablesError, setTablesError] = useState('');
  const [branches, setBranches] = useState(null); // owner only
  const [branchId, setBranchId] = useState('');
  const [openOrders, setOpenOrders] = useState([]);

  // modals
  const [variantFor, setVariantFor] = useState(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [kot, setKot] = useState(null);
  const [kotListFor, setKotListFor] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [voidItemTarget, setVoidItemTarget] = useState(null);
  const [voidOrderOpen, setVoidOrderOpen] = useState(false);
  const [editLineId, setEditLineId] = useState(null);
  const [editLineValue, setEditLineValue] = useState('');

  const surfaceError = useCallback(
    (err, fallback) => {
      const msg = apiError(err, fallback);
      if (isLicenseError(err)) setLicMsg(msg);
      toast(msg, 'error');
    },
    [toast],
  );

  // --- catalog ---------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/catalog/categories');
        if (alive) setCats(data.categories || []);
      } catch (err) {
        if (alive) setCatError(apiError(err, 'Could not load categories'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(qLive.trim()), 300);
    return () => clearTimeout(t);
  }, [qLive]);

  const loadProducts = useCallback(async () => {
    setProdError('');
    setProducts(null);
    try {
      const query = {};
      if (activeCat !== 'ALL') query.categoryId = activeCat;
      if (q) query.q = q;
      const { data } = await api.get('/catalog/products', { params: query });
      setProducts(data.products || []);
    } catch (err) {
      setProdError(apiError(err, 'Could not load products'));
    }
  }, [activeCat, q]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // --- board (tables + open orders) ------------------------------------------
  const loadTables = useCallback(async () => {
    setTablesError('');
    try {
      const query = owner && branchId ? { branchId } : {};
      const { data } = await api.get('/tables', { params: query });
      setTables((data.tables || []).filter((t) => t.status === 'ACTIVE'));
    } catch (err) {
      setTablesError(apiError(err, 'Could not load tables'));
    }
  }, [owner, branchId]);

  const loadOpenOrders = useCallback(async () => {
    try {
      const query = { status: 'OPEN,BILLED', pageSize: 20 };
      if (owner && branchId) query.branchId = branchId;
      const { data } = await api.get('/orders', { params: query });
      setOpenOrders(data.orders || []);
    } catch {
      // strip is a convenience — never block the screen on it
      setOpenOrders([]);
    }
  }, [owner, branchId]);

  useEffect(() => {
    loadTables();
    loadOpenOrders();
  }, [loadTables, loadOpenOrders]);

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        if (!alive) return;
        const active = (data.branches || []).filter((b) => b.status === 'ACTIVE');
        setBranches(active);
        if (active.length && !branchId) setBranchId(active[0].id);
      } catch (err) {
        if (alive) toast(apiError(err, 'Could not load branches'), 'error');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  // --- resume (?order=…) -----------------------------------------------------
  useEffect(() => {
    const id = params.get('order');
    if (!id) return;
    (async () => {
      try {
        const { data } = await api.get(`/orders/${id}`);
        setOrder(data.order);
        setMode(data.order.type);
      } catch (err) {
        surfaceError(err, 'Could not load the order');
      } finally {
        params.delete('order');
        setParams(params, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resumeOrder = async (id) => {
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${id}`);
      setOrder(data.order);
      setMode(data.order.type);
    } catch (err) {
      surfaceError(err, 'Could not load the order');
    } finally {
      setBusy(false);
    }
  };

  // --- order mutations -------------------------------------------------------
  const addItem = async (product, variant) => {
    if (licenseBlocked) return;
    if (!order) {
      if (!mode) {
        toast('Choose Takeaway or pick a table first.', 'info');
        return;
      }
      if (mode === 'DINE_IN' && !tableId) {
        toast('Pick a free table for this dine-in order.', 'info');
        return;
      }
      if (owner && !branchId) {
        toast('Choose a branch first.', 'info');
        return;
      }
      setBusy(true);
      try {
        const payload = {
          type: mode,
          ...(mode === 'DINE_IN' ? { tableId } : {}),
          ...(owner ? { branchId } : {}),
          items: [{ productId: product.id, ...(variant ? { variantId: variant.id } : {}), qty: 1 }],
        };
        const { data } = await api.post('/orders', payload);
        setOrder(data.order);
        loadTables();
        loadOpenOrders();
      } catch (err) {
        surfaceError(err, 'Could not start the order');
        if (err?.response?.status === 409) {
          setTableId(null);
          loadTables();
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/items`, {
        productId: product.id,
        ...(variant ? { variantId: variant.id } : {}),
        qty: 1,
      });
      setOrder(data.order);
    } catch (err) {
      surfaceError(err, 'Could not add the item');
    } finally {
      setBusy(false);
    }
  };

  const patchItem = async (item, body, fallback) => {
    setBusy(true);
    try {
      const { data } = await api.patch(`/orders/${order.id}/items/${item.id}`, body);
      setOrder(data.order);
    } catch (err) {
      surfaceError(err, fallback);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (item) => {
    setBusy(true);
    try {
      const { data } = await api.delete(`/orders/${order.id}/items/${item.id}`);
      setOrder(data.order);
    } catch (err) {
      surfaceError(err, 'Could not remove the line');
    } finally {
      setBusy(false);
    }
  };

  const sendKot = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/kot`, {});
      setOrder(data.order);
      setKot(data.kot);
      toast(`KOT #${data.kot.seq} sent to kitchen.`, 'success');
    } catch (err) {
      surfaceError(err, 'Could not send the KOT');
    } finally {
      setBusy(false);
    }
  };

  const billOrder = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/bill`, {});
      setOrder(data.order);
      toast(`Billed — invoice ${data.order.invoiceNumber}`, 'success');
      setPayOpen(true);
      loadOpenOrders();
    } catch (err) {
      surfaceError(err, 'Could not bill the order');
    } finally {
      setBusy(false);
    }
  };

  const showReceipt = async (orderId) => {
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${orderId}/receipt`);
      setReceipt(data.receipt);
    } catch (err) {
      surfaceError(err, 'Could not load the receipt');
    } finally {
      setBusy(false);
    }
  };

  const newSale = () => {
    if (order && (order.status === 'OPEN' || order.status === 'BILLED')) {
      toast(`Order stays ${order.status} — resume it from the table board or Orders.`, 'info');
    }
    setOrder(null);
    setMode(null);
    setTableId(null);
    setReceipt(null);
    loadTables();
    loadOpenOrders();
  };

  const lineEditorSave = async (item) => {
    const v = editLineValue === '' ? 0 : Number(editLineValue);
    await patchItem(item, { lineDiscount: v }, 'Could not set the line discount');
    setEditLineId(null);
  };

  // --- derived hints (non-authoritative, per §3) -----------------------------
  const activeLines = order ? order.items.filter((i) => i.status === 'ACTIVE') : [];
  const hasUnsentKotLines = activeLines.some((i) => i.kotSeq === null || i.kotSeq === undefined);
  const canBill = activeLines.length > 0;
  const orderOpen = order?.status === 'OPEN';
  const netCollected =
    order && Number(order.amountPaid ?? 0) - Number(order.amountRefunded ?? 0) === 0;
  const anyKot = order ? order.items.some((i) => i.kotSeq !== null && i.kotSeq !== undefined) : false;

  const freeTables = (tables || []).filter((t) => !t.currentOrder);

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      {/* ---------------- left: catalog ---------------- */}
      <div className="min-w-0 flex-1">
        {licenseBlocked || licMsg ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {licMsg ||
              'Your licence does not allow POS actions right now. Viewing stays available; new orders and payments are disabled. Contact ATC to restore the licence.'}
          </div>
        ) : null}

        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Search products…"
              value={qLive}
              onChange={(e) => setQLive(e.target.value)}
              aria-label="Search products"
            />
          </div>
          <button type="button" className="btn-ghost" onClick={loadProducts} title="Reload products">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {catError ? (
          <ErrorNote message={catError} />
        ) : (
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setActiveCat('ALL')}
              className={`btn shrink-0 ${activeCat === 'ALL' ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
            >
              All
            </button>
            {(cats || []).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveCat(c.id)}
                className={`btn shrink-0 ${activeCat === c.id ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {prodError ? (
          <div className="space-y-2">
            <ErrorNote message={prodError} />
            <button type="button" className="btn-ghost" onClick={loadProducts}>
              Try again
            </button>
          </div>
        ) : products === null ? (
          <div className="card flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
          </div>
        ) : products.length === 0 ? (
          <div className="card flex flex-col items-center px-6 py-12 text-center">
            <Package className="mb-3 h-10 w-10 text-slate-300" />
            <div className="text-sm font-semibold text-slate-600">No products found</div>
            <div className="mt-1 text-xs text-slate-400">
              {q ? 'Try a different search.' : 'The catalog for this company is empty.'}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {products.map((p) => {
              const hasVariants = (p.variants || []).some((v) => v.status === 'ACTIVE');
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy || licenseBlocked}
                  onClick={() => (hasVariants ? setVariantFor(p) : addItem(p, null))}
                  className="card flex min-h-[92px] flex-col items-start justify-between p-3 text-left transition-colors hover:border-pos-royal hover:bg-pos-royal/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="text-sm font-bold leading-tight text-pos-ink">{p.name}</div>
                  <div className="mt-2 flex w-full items-center justify-between">
                    <span className="text-sm font-semibold text-pos-royal">{fmtINR(p.basePrice)}</span>
                    {hasVariants ? (
                      <span className="badge bg-pos-orange/10 text-pos-ember">variants</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------------- right: order panel ---------------- */}
      <div className="w-full shrink-0 xl:w-[400px]">
        <div className="card flex min-h-[420px] flex-col">
          {!order ? (
            <div className="flex flex-1 flex-col p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">New order</h2>

              {owner ? (
                <div className="mt-3">
                  <label className="label" htmlFor="sell-branch">Branch</label>
                  <select
                    id="sell-branch"
                    className="input"
                    value={branchId}
                    onChange={(e) => {
                      setBranchId(e.target.value);
                      setTableId(null);
                    }}
                  >
                    {(branches || []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode('TAKEAWAY');
                    setTableId(null);
                  }}
                  className={`btn ${mode === 'TAKEAWAY' ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
                >
                  <ShoppingBag className="h-4 w-4" /> Takeaway
                </button>
                <button
                  type="button"
                  onClick={() => setMode('DINE_IN')}
                  className={`btn ${mode === 'DINE_IN' ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
                >
                  <Armchair className="h-4 w-4" /> Dine-in
                </button>
              </div>

              {mode === 'DINE_IN' ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="label mb-0">Tables (occupied ones resume their order)</span>
                    <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={loadTables}>
                      Refresh
                    </button>
                  </div>
                  {tablesError ? <ErrorNote message={tablesError} /> : null}
                  {tables === null && !tablesError ? (
                    <div className="py-6 text-center text-sm text-slate-400">Loading tables…</div>
                  ) : null}
                  {tables && tables.length === 0 ? (
                    <div className="py-4 text-center text-sm text-slate-400">
                      No active tables in this branch. Ask a manager to add tables.
                    </div>
                  ) : null}
                  <div className="grid grid-cols-3 gap-2">
                    {(tables || []).map((t) =>
                      t.currentOrder ? (
                        <button
                          key={t.id}
                          type="button"
                          disabled={busy}
                          onClick={() => resumeOrder(t.currentOrder.id)}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-center hover:bg-amber-100"
                          title={`Occupied — resume order (${t.currentOrder.status})`}
                        >
                          <div className="text-sm font-bold text-amber-800">{t.name}</div>
                          <div className="text-[10px] font-semibold text-amber-700">
                            {t.currentOrder.status} · {fmtINR(t.currentOrder.total)}
                          </div>
                        </button>
                      ) : (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTableId(t.id)}
                          className={`rounded-lg border px-2 py-2 text-center ${
                            tableId === t.id
                              ? 'border-pos-royal bg-pos-royal text-white'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          }`}
                        >
                          <div className="text-sm font-bold">{t.name}</div>
                          <div className="text-[10px] font-semibold opacity-80">
                            {t.capacity ? `${t.capacity} seats` : 'free'}
                          </div>
                        </button>
                      ),
                    )}
                  </div>
                </div>
              ) : null}

              {mode ? (
                <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  {mode === 'TAKEAWAY'
                    ? 'Takeaway — tap a product to start the order.'
                    : tableId
                      ? `Table ${freeTables.find((t) => t.id === tableId)?.name || ''} selected — tap a product to start the order.`
                      : 'Pick a free (green) table, then tap a product.'}
                </div>
              ) : (
                <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                  Choose Takeaway or Dine-in to begin.
                </div>
              )}

              {openOrders.length > 0 ? (
                <div className="mt-5">
                  <div className="label">Open orders</div>
                  <div className="flex flex-wrap gap-2">
                    {openOrders.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        disabled={busy}
                        onClick={() => resumeOrder(o.id)}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left text-xs hover:border-pos-royal"
                      >
                        <span className="font-bold text-pos-ink">{o.tableName || 'Takeaway'}</span>{' '}
                        <span className="text-slate-500">{fmtINR(o.total)}</span>{' '}
                        <OrderStatusBadge status={o.status} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-pos-ink">
                      {order.type === 'DINE_IN' ? `Dine-in · ${order.table?.name || ''}` : 'Takeaway'}
                    </span>
                    <OrderStatusBadge status={order.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {order.invoiceNumber ? (
                      <span className="font-semibold">{order.invoiceNumber}</span>
                    ) : (
                      <span>Opened {fmtTime(order.createdAt)} by {order.openedBy?.fullName}</span>
                    )}
                  </div>
                </div>
                <button type="button" className="btn-ghost" onClick={newSale}>
                  New sale
                </button>
              </div>

              <div className="max-h-[46vh] flex-1 overflow-y-auto px-4 py-2">
                {order.items.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">No items on this order.</div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {order.items.map((it) => (
                      <li key={it.id} className={`py-2 ${it.status === 'VOIDED' ? 'opacity-60' : ''}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className={`text-sm font-semibold text-pos-ink ${it.status === 'VOIDED' ? 'line-through' : ''}`}>
                              {it.name}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                              <span>{fmtINR(it.unitPrice)} × {it.qty}</span>
                              {it.kotSeq !== null && it.kotSeq !== undefined ? (
                                <span className="badge bg-sky-100 text-sky-700">KOT #{it.kotSeq}</span>
                              ) : null}
                              {Number(it.lineDiscount) > 0 ? (
                                <span className="badge bg-pos-orange/10 text-pos-ember">disc {fmtINR(it.lineDiscount)}</span>
                              ) : null}
                            </div>
                            {it.status === 'VOIDED' ? (
                              <div className="mt-0.5 text-xs font-semibold text-red-600">
                                VOIDED{it.voidReason ? ` — ${it.voidReason}` : ''}
                              </div>
                            ) : null}
                          </div>
                          <div className="shrink-0 text-right text-sm font-bold text-pos-ink">
                            {it.status === 'VOIDED' ? '—' : fmtINR(it.lineTotal)}
                          </div>
                        </div>

                        {orderOpen && it.status === 'ACTIVE' ? (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            {it.kotSeq === null || it.kotSeq === undefined ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                  disabled={busy || it.qty <= 1}
                                  onClick={() => patchItem(it, { qty: it.qty - 1 }, 'Could not change quantity')}
                                  aria-label="Decrease quantity"
                                >
                                  <Minus className="h-3.5 w-3.5" />
                                </button>
                                <span className="w-6 text-center text-sm font-bold">{it.qty}</span>
                                <button
                                  type="button"
                                  className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                  disabled={busy}
                                  onClick={() => patchItem(it, { qty: it.qty + 1 }, 'Could not change quantity')}
                                  aria-label="Increase quantity"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  className="ml-1 rounded-md border border-slate-200 p-1 text-red-500 hover:bg-red-50 disabled:opacity-40"
                                  disabled={busy}
                                  onClick={() => deleteItem(it)}
                                  aria-label="Remove line"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <span className="text-[11px] text-slate-400">Sent to kitchen — qty locked</span>
                            )}
                            {editLineId === it.id ? (
                              <span className="ml-auto flex items-center gap-1">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  className="input w-24 px-2 py-1 text-xs"
                                  value={editLineValue}
                                  onChange={(e) => setEditLineValue(e.target.value)}
                                  aria-label="Line discount in rupees"
                                  autoFocus
                                />
                                <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={busy} onClick={() => lineEditorSave(it)}>
                                  Set
                                </button>
                                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditLineId(null)}>
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-pos-royal hover:underline"
                                onClick={() => {
                                  setEditLineId(it.id);
                                  setEditLineValue(Number(it.lineDiscount) > 0 ? String(it.lineDiscount) : '');
                                }}
                              >
                                <Pencil className="h-3 w-3" /> line disc
                              </button>
                            )}
                            {managerUp && (it.kotSeq !== null && it.kotSeq !== undefined) ? (
                              <button
                                type="button"
                                className="flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:underline"
                                onClick={() => setVoidItemTarget(it)}
                              >
                                <Ban className="h-3 w-3" /> void
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* totals — server values only */}
              <div className="border-t border-slate-100 px-4 py-3 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span>{fmtINR(order.subtotal)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-slate-600">
                  <span className="flex items-center gap-1.5">
                    Discount
                    {order.discount ? (
                      <span className="badge bg-pos-orange/10 text-pos-ember">
                        {order.discount.type === 'PERCENT' ? `${order.discount.value}%` : fmtINR(order.discount.value)}
                      </span>
                    ) : null}
                    {orderOpen ? (
                      <button
                        type="button"
                        className="text-pos-royal hover:underline"
                        onClick={() => setDiscountOpen(true)}
                        aria-label="Edit order discount"
                      >
                        <Tags className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </span>
                  <span>{Number(order.discountAmount) > 0 ? `-${fmtINR(order.discountAmount)}` : fmtINR(0)}</span>
                </div>
                <div className="mt-1 flex justify-between text-slate-600">
                  <span>Tax</span>
                  <span>{fmtINR(order.taxAmount)}</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between border-t border-slate-200 pt-2">
                  <span className="text-base font-bold text-pos-ink">Total</span>
                  <span className="text-2xl font-extrabold text-pos-ink">{fmtINR(order.total)}</span>
                </div>
                {order.payments.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                    {order.payments.map((p) => (
                      <div key={p.id}>
                        <div className="flex justify-between text-xs text-slate-600">
                          <span>
                            {p.method}
                            {p.tendered !== null && p.tendered !== undefined ? ` (tendered ${fmtINR(p.tendered)})` : ''}
                          </span>
                          <span>{fmtINR(p.amount)}</span>
                        </div>
                        <div className="text-[9px] font-bold uppercase tracking-wide text-amber-700">{MANUAL_PAYMENT_LABEL}</div>
                      </div>
                    ))}
                    <div className="flex justify-between text-xs font-semibold text-slate-700">
                      <span>Paid</span>
                      <span>{fmtINR(order.amountPaid)}</span>
                    </div>
                    {Number(order.amountDue) > 0 ? (
                      <div className="flex justify-between text-xs font-bold text-pos-ember">
                        <span>Balance due</span>
                        <span>{fmtINR(order.amountDue)}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* actions */}
              <div className="space-y-2 border-t border-slate-100 px-4 py-3">
                {orderOpen ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" className="btn-ghost" disabled={busy || !hasUnsentKotLines || licenseBlocked} onClick={sendKot}>
                        <Send className="h-4 w-4" /> Send KOT
                      </button>
                      <button type="button" className="btn-primary" disabled={busy || !canBill || licenseBlocked} onClick={billOrder}>
                        <IndianRupee className="h-4 w-4" /> Bill
                      </button>
                    </div>
                  </>
                ) : null}
                {order.status === 'BILLED' ? (
                  <button type="button" className="btn-orange w-full" disabled={busy || licenseBlocked} onClick={() => setPayOpen(true)}>
                    <IndianRupee className="h-4 w-4" /> Record payment · {fmtINR(order.amountDue)} due
                  </button>
                ) : null}
                {order.status === 'PAID' ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-sm font-bold text-emerald-800">
                    Payment recorded — order PAID
                  </div>
                ) : null}
                {['BILLED', 'PAID', 'REFUNDED'].includes(order.status) ? (
                  <button type="button" className="btn-ghost w-full" disabled={busy} onClick={() => showReceipt(order.id)}>
                    <Printer className="h-4 w-4" /> Receipt
                  </button>
                ) : null}
                <div className="flex items-center justify-between text-xs">
                  {anyKot ? (
                    <button type="button" className="font-semibold text-pos-royal hover:underline" onClick={() => setKotListFor(order.id)}>
                      Reprint KOTs
                    </button>
                  ) : (
                    <span />
                  )}
                  {managerUp && ['OPEN', 'BILLED'].includes(order.status) ? (
                    <button
                      type="button"
                      className="font-semibold text-red-600 hover:underline disabled:opacity-40"
                      disabled={!netCollected}
                      title={netCollected ? 'Void this order' : 'Refund collected payments before voiding'}
                      onClick={() => setVoidOrderOpen(true)}
                    >
                      Void order
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------------- modals ---------------- */}
      <VariantModal
        product={variantFor}
        onClose={() => setVariantFor(null)}
        onPick={(p, v) => {
          setVariantFor(null);
          addItem(p, v);
        }}
      />
      <DiscountModal open={discountOpen} order={order} onClose={() => setDiscountOpen(false)} onOrder={setOrder} />
      <PaymentModal
        open={payOpen}
        order={order}
        onClose={() => setPayOpen(false)}
        onOrder={(o) => {
          setOrder(o);
          loadOpenOrders();
          loadTables();
        }}
        onPaid={() => {
          setPayOpen(false);
          showReceipt(order.id);
        }}
      />
      <KotModal kot={kot} onClose={() => setKot(null)} />
      {kotListFor ? <KotListModal orderId={kotListFor} onClose={() => setKotListFor(null)} /> : null}
      {receipt ? <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      <ReasonModal
        open={Boolean(voidItemTarget)}
        title={`Void line — ${voidItemTarget?.name || ''}`}
        hint="The line stays visible as VOIDED and leaves all totals. Manager action — it is audited."
        busyLabel="Void line"
        onClose={() => setVoidItemTarget(null)}
        onSubmit={async (reason) => {
          const { data } = await api.post(`/orders/${order.id}/items/${voidItemTarget.id}/void`, { reason });
          setOrder(data.order);
        }}
      />
      <ReasonModal
        open={voidOrderOpen}
        title="Void order"
        hint="Allowed only while nothing is collected (net of refunds). The invoice number, if assigned, is kept as an audited gap."
        busyLabel="Void order"
        onClose={() => setVoidOrderOpen(false)}
        onSubmit={async (reason) => {
          const { data } = await api.post(`/orders/${order.id}/void`, { reason });
          setOrder(data.order);
          loadTables();
          loadOpenOrders();
        }}
      />
    </div>
  );
}
