import { useCallback, useEffect, useState } from 'react';
import { Archive, Package, Pencil, Percent, Plus, Search, Tags } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader, StatusBadge } from '../components/ui.jsx';
import { fmtINR, getAtcScope, isAtc } from '../lib/pos.js';

// /catalog — owner/ATC catalog admin (contract §5.1). Archive flows only; the
// single hard delete in the UI is an empty category (server 409s otherwise).

const TABS = [
  { id: 'products', label: 'Products', icon: Package },
  { id: 'categories', label: 'Categories', icon: Tags },
  { id: 'taxes', label: 'Tax rates', icon: Percent },
];

function ConfirmModal({ open, title, body, confirmLabel, danger = false, onConfirm, onClose }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setError('');
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const go = async () => {
    setError('');
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={title} onClose={onClose}>
      <p className="mb-4 text-sm text-slate-600">{body}</p>
      <ErrorNote message={error} />
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn flex-1 text-white ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-pos-royal hover:bg-pos-deep'}`}
          onClick={go}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- categories ----------------
function CategoryForm({ initial, onDone }) {
  const [name, setName] = useState(initial?.name || '');
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = { name: name.trim(), ...(sortOrder !== '' ? { sortOrder: Number(sortOrder) } : {}) };
      if (initial) await api.patch(`/catalog/categories/${initial.id}`, payload);
      else await api.post('/catalog/categories', payload);
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="cat-name">Name</label>
        <input id="cat-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="cat-sort">Sort order (lower shows first)</label>
        <input id="cat-sort" type="number" className="input" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} min="0" />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : initial ? 'Save changes' : 'Create category'}
      </button>
    </form>
  );
}

function CategoriesTab({ categories, reload }) {
  const [modal, setModal] = useState(null); // 'new' | category
  const [toDelete, setToDelete] = useState(null);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button type="button" className="btn-orange" onClick={() => setModal('new')}>
          <Plus className="h-4 w-4" /> Add category
        </button>
      </div>
      {categories.length === 0 ? (
        <EmptyState icon={Tags} title="No categories yet" note="Products need a category — create one first." />
      ) : (
        <div className="card divide-y divide-slate-100">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <span className="text-sm font-semibold text-pos-ink">{c.name}</span>
                <span className="ml-2 text-xs text-slate-400">order {c.sortOrder}</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setModal(c)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs text-red-600"
                  onClick={() => setToDelete(c)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={Boolean(modal)} title={modal === 'new' ? 'Add category' : 'Edit category'} onClose={() => setModal(null)}>
        <CategoryForm
          initial={modal === 'new' ? null : modal}
          onDone={() => {
            setModal(null);
            reload();
          }}
        />
      </Modal>
      <ConfirmModal
        open={Boolean(toDelete)}
        title="Delete category"
        body={`Delete “${toDelete?.name}”? This is permanent and only possible while no products use it — otherwise the server refuses.`}
        confirmLabel="Delete"
        danger
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await api.delete(`/catalog/categories/${toDelete.id}`);
          reload();
        }}
      />
    </div>
  );
}

// ---------------- tax rates ----------------
function TaxRateForm({ initial, onDone }) {
  const [name, setName] = useState(initial?.name || '');
  const [ratePercent, setRatePercent] = useState(initial?.ratePercent ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = { name: name.trim(), ratePercent: Number(ratePercent) };
      if (initial) await api.patch(`/catalog/tax-rates/${initial.id}`, payload);
      else await api.post('/catalog/tax-rates', payload);
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="tax-name">Name (e.g. GST 5%)</label>
        <input id="tax-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="tax-rate">Rate percent (0–100, up to 3 decimals)</label>
        <input
          id="tax-rate"
          type="number"
          className="input"
          value={ratePercent}
          onChange={(e) => setRatePercent(e.target.value)}
          min="0"
          max="100"
          step="0.001"
          required
        />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy || name.trim() === '' || ratePercent === ''}>
        {busy ? 'Saving…' : initial ? 'Save changes' : 'Create tax rate'}
      </button>
    </form>
  );
}

function TaxesTab({ taxRates, reload }) {
  const [modal, setModal] = useState(null);
  const [toArchive, setToArchive] = useState(null);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button type="button" className="btn-orange" onClick={() => setModal('new')}>
          <Plus className="h-4 w-4" /> Add tax rate
        </button>
      </div>
      {taxRates.length === 0 ? (
        <EmptyState icon={Percent} title="No tax rates yet" note="Create GST rates here, then attach them to products." />
      ) : (
        <div className="card divide-y divide-slate-100">
          {taxRates.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-pos-ink">{t.name}</span>
                <span className="text-xs text-slate-500">{t.ratePercent}%</span>
                <StatusBadge status={t.status} />
              </div>
              {t.status === 'ACTIVE' ? (
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setModal(t)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button type="button" className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => setToArchive(t)}>
                    <Archive className="h-3.5 w-3.5" /> Archive
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Modal open={Boolean(modal)} title={modal === 'new' ? 'Add tax rate' : 'Edit tax rate'} onClose={() => setModal(null)}>
        <TaxRateForm
          initial={modal === 'new' ? null : modal}
          onDone={() => {
            setModal(null);
            reload();
          }}
        />
      </Modal>
      <ConfirmModal
        open={Boolean(toArchive)}
        title="Archive tax rate"
        body={`Archive “${toArchive?.name}”? Existing orders keep their snapshotted tax; products referencing it should be re-assigned.`}
        confirmLabel="Archive"
        danger
        onClose={() => setToArchive(null)}
        onConfirm={async () => {
          await api.delete(`/catalog/tax-rates/${toArchive.id}`);
          reload();
        }}
      />
    </div>
  );
}

// ---------------- products ----------------
function ProductForm({ initial, categories, taxRates, onSaved }) {
  const [form, setForm] = useState({
    categoryId: initial?.categoryId || categories[0]?.id || '',
    name: initial?.name || '',
    sku: initial?.sku || '',
    basePrice: initial?.basePrice ?? '',
    taxRateId: initial?.taxRate?.id || '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // PATCH accepts null to CLEAR sku/taxRateId (server `.nullish()`); the
      // create schema is `.optional()` only, so empty fields are omitted there.
      const payload = {
        categoryId: form.categoryId,
        name: form.name.trim(),
        basePrice: Number(form.basePrice),
        ...(initial
          ? { sku: form.sku.trim() || null, taxRateId: form.taxRateId || null }
          : {
              ...(form.sku.trim() ? { sku: form.sku.trim() } : {}),
              ...(form.taxRateId ? { taxRateId: form.taxRateId } : {}),
            }),
      };
      const res = initial
        ? await api.patch(`/catalog/products/${initial.id}`, payload)
        : await api.post('/catalog/products', payload);
      onSaved(res.data.product);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="p-name">Name</label>
        <input id="p-name" className="input" value={form.name} onChange={set('name')} required autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="p-cat">Category</label>
          <select id="p-cat" className="input" value={form.categoryId} onChange={set('categoryId')} required>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="p-sku">SKU (optional)</label>
          <input id="p-sku" className="input" value={form.sku} onChange={set('sku')} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="p-price">Base price (₹)</label>
          <input id="p-price" type="number" className="input" min="0" step="0.01" value={form.basePrice} onChange={set('basePrice')} required />
        </div>
        <div>
          <label className="label" htmlFor="p-tax">Tax rate</label>
          <select id="p-tax" className="input" value={form.taxRateId} onChange={set('taxRateId')}>
            <option value="">No tax</option>
            {taxRates
              .filter((t) => t.status === 'ACTIVE' || t.id === form.taxRateId)
              .map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
          </select>
        </div>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy || !form.name.trim() || form.basePrice === '' || !form.categoryId}>
        {busy ? 'Saving…' : initial ? 'Save changes' : 'Create product'}
      </button>
    </form>
  );
}

// Variants use the ABSOLUTE unit price, not a delta (contract §5.1).
function VariantsEditor({ product, onProduct }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // variant id
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');

  const refresh = async () => {
    const { data } = await api.get(`/catalog/products/${product.id}`);
    onProduct(data.product);
  };

  const addVariant = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/catalog/products/${product.id}/variants`, { name: name.trim(), price: Number(price) });
      setName('');
      setPrice('');
      setAdding(false);
      await refresh();
    } catch (err) {
      toast(apiError(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveVariant = async (v) => {
    setBusy(true);
    try {
      await api.patch(`/catalog/products/${product.id}/variants/${v.id}`, {
        name: editName.trim(),
        price: Number(editPrice),
      });
      setEditing(null);
      await refresh();
    } catch (err) {
      toast(apiError(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const archiveVariant = async (v) => {
    setBusy(true);
    try {
      await api.delete(`/catalog/products/${product.id}/variants/${v.id}`);
      await refresh();
    } catch (err) {
      toast(apiError(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const variants = product.variants || [];

  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="label mb-0">Variants (absolute unit price)</h3>
        {!adding ? (
          <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={() => setAdding(true)}>
            + Add variant
          </button>
        ) : null}
      </div>
      {variants.length === 0 && !adding ? (
        <p className="text-xs text-slate-400">No variants — the product sells at its base price.</p>
      ) : null}
      <ul className="space-y-1.5">
        {variants.map((v) => (
          <li key={v.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-1.5 text-sm">
            {editing === v.id ? (
              <span className="flex flex-1 items-center gap-2">
                <input className="input flex-1 px-2 py-1 text-xs" value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Variant name" />
                <input
                  type="number"
                  className="input w-24 px-2 py-1 text-xs"
                  min="0"
                  step="0.01"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  aria-label="Variant price"
                />
                <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={busy || !editName.trim() || editPrice === ''} onClick={() => saveVariant(v)}>
                  Save
                </button>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <span className="flex items-center gap-2">
                  <span className={v.status === 'ARCHIVED' ? 'text-slate-400 line-through' : 'font-semibold text-pos-ink'}>
                    {v.name}
                  </span>
                  <span className="text-slate-500">{fmtINR(v.price)}</span>
                  {v.status === 'ARCHIVED' ? <StatusBadge status="ARCHIVED" /> : null}
                </span>
                {v.status === 'ACTIVE' ? (
                  <span className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      className="font-semibold text-pos-royal hover:underline"
                      onClick={() => {
                        setEditing(v.id);
                        setEditName(v.name);
                        setEditPrice(String(v.price));
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className="font-semibold text-red-600 hover:underline" disabled={busy} onClick={() => archiveVariant(v)}>
                      Archive
                    </button>
                  </span>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={addVariant} className="mt-2 flex items-center gap-2">
          <input className="input flex-1 px-2 py-1.5 text-sm" placeholder="Name (e.g. Large)" value={name} onChange={(e) => setName(e.target.value)} required aria-label="New variant name" />
          <input
            type="number"
            className="input w-28 px-2 py-1.5 text-sm"
            placeholder="Price ₹"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            aria-label="New variant price"
          />
          <button type="submit" className="btn-primary px-3 py-1.5 text-sm" disabled={busy || !name.trim() || price === ''}>
            Add
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : null}
    </div>
  );
}

function ProductsTab({ categories, taxRates }) {
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [products, setProducts] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'new' | product object
  const [toArchive, setToArchive] = useState(null);

  const load = useCallback(async () => {
    setError('');
    setProducts(null);
    try {
      const params = {};
      if (q.trim()) params.q = q.trim();
      if (categoryId) params.categoryId = categoryId;
      if (status) params.status = status;
      const { data } = await api.get('/catalog/products', { params });
      setProducts(data.products || []);
    } catch (err) {
      setError(apiError(err, 'Could not load products'));
    }
  }, [q, categoryId, status]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const catName = (id) => categories.find((c) => c.id === id)?.name || '—';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
        </div>
        <select className="input w-auto" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <button type="button" className="btn-orange" onClick={() => setModal('new')} disabled={categories.length === 0}>
          <Plus className="h-4 w-4" /> Add product
        </button>
      </div>
      {categories.length === 0 ? (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Create a category first — every product needs one.
        </div>
      ) : null}

      {error ? <ErrorNote message={error} /> : null}
      {products === null && !error ? (
        <div className="card flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}
      {products && products.length === 0 ? (
        <EmptyState icon={Package} title="No products here" note="Try other filters, or add your first product." />
      ) : null}

      {products && products.length > 0 ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Base price</th>
                <th className="px-4 py-3">Tax</th>
                <th className="px-4 py-3">Variants</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-slate-50">
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-pos-ink">{p.name}</div>
                    {p.sku ? <div className="text-xs text-slate-400">{p.sku}</div> : null}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{catName(p.categoryId)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-pos-ink">{fmtINR(p.basePrice)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{p.taxRate ? p.taxRate.name : '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {(p.variants || []).filter((v) => v.status === 'ACTIVE').length || '—'}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setModal(p)}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      {p.status === 'ACTIVE' ? (
                        <button type="button" className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => setToArchive(p)}>
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
      ) : null}

      <Modal open={Boolean(modal)} title={modal === 'new' ? 'Add product' : `Edit — ${modal?.name || ''}`} onClose={() => setModal(null)} wide>
        {modal ? (
          <>
            <ProductForm
              initial={modal === 'new' ? null : modal}
              categories={categories}
              taxRates={taxRates}
              onSaved={(p) => {
                if (modal === 'new') setModal(p); // keep open so variants can be added
                else setModal(p);
                load();
              }}
            />
            {modal !== 'new' ? (
              <VariantsEditor
                product={modal}
                onProduct={(p) => {
                  setModal(p);
                  load();
                }}
              />
            ) : null}
          </>
        ) : null}
      </Modal>
      <ConfirmModal
        open={Boolean(toArchive)}
        title="Archive product"
        body={`Archive “${toArchive?.name}”? It disappears from the sell screen; past orders keep their snapshotted lines.`}
        confirmLabel="Archive"
        danger
        onClose={() => setToArchive(null)}
        onConfirm={async () => {
          await api.delete(`/catalog/products/${toArchive.id}`);
          load();
        }}
      />
    </div>
  );
}

export default function CatalogAdmin() {
  const { user } = useAuth();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;
  const [tab, setTab] = useState('products');
  const [categories, setCategories] = useState(null);
  const [taxRates, setTaxRates] = useState(null);
  const [error, setError] = useState('');

  const loadShared = useCallback(async () => {
    if (atc && !atcScope) return;
    setError('');
    try {
      const [c, t] = await Promise.all([api.get('/catalog/categories'), api.get('/catalog/tax-rates')]);
      setCategories(c.data.categories || []);
      setTaxRates(t.data.taxRates || []);
    } catch (err) {
      setError(apiError(err, 'Could not load the catalog'));
    }
  }, [atc, atcScope]);

  useEffect(() => {
    loadShared();
  }, [loadShared]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Catalog" subtitle="ATC operators browse per company." />
        <EmptyState
          icon={Package}
          title="No company selected"
          note="Open a company from the ATC console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Catalog"
        subtitle={
          atcScope
            ? `Company: ${atcScope.name || atcScope.id}`
            : 'Categories, products, variants and tax rates for your company'
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {(categories === null || taxRates === null) && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}
      {categories !== null && taxRates !== null ? (
        <>
          <div className="mb-4 flex gap-2 border-b border-slate-200">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold ${
                  tab === id ? 'border-pos-royal text-pos-royal' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
          {tab === 'products' ? <ProductsTab categories={categories} taxRates={taxRates} /> : null}
          {tab === 'categories' ? <CategoriesTab categories={categories} reload={loadShared} /> : null}
          {tab === 'taxes' ? <TaxesTab taxRates={taxRates} reload={loadShared} /> : null}
        </>
      ) : null}
    </div>
  );
}
