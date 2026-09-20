import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BadgePlus, UserPlus, PackagePlus } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import {
  PageHeader,
  StatusBadge,
  DemoBadge,
  RoleBadge,
  ErrorNote,
  Modal,
  FullScreenSpinner,
  TempPasswordReveal,
} from '../components/ui.jsx';

function IssueLicenseForm({ companyId, onDone }) {
  const [form, setForm] = useState({ plan: 'FREE_TRIAL', expiresAt: '', baseBranchLimit: 1, notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/atc/companies/${companyId}/licenses`, {
        plan: form.plan,
        expiresAt: new Date(form.expiresAt).toISOString(),
        baseBranchLimit: Number(form.baseBranchLimit) || 1,
        ...(form.notes.trim() ? { notes: form.notes } : {}),
      });
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
        <label className="label" htmlFor="l-plan">Plan</label>
        <select id="l-plan" className="input" value={form.plan} onChange={(e) => setForm((f) => ({ ...f, plan: e.target.value }))}>
          <option value="FREE_TRIAL">Free demo / trial</option>
          <option value="SINGLE_STORE">Single store</option>
          <option value="MULTI_STORE">Multi store</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="l-expiry">Expires on</label>
          <input id="l-expiry" type="date" className="input" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} required />
        </div>
        <div>
          <label className="label" htmlFor="l-limit">Base branch limit</label>
          <input
            id="l-limit"
            type="number"
            min="1"
            max="500"
            className="input"
            value={form.plan === 'SINGLE_STORE' ? 1 : form.baseBranchLimit}
            disabled={form.plan === 'SINGLE_STORE'}
            onChange={(e) => setForm((f) => ({ ...f, baseBranchLimit: e.target.value }))}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="l-notes">Notes</label>
        <input id="l-notes" className="input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Internal note (optional)" />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Issuing…' : 'Issue licence'}
      </button>
    </form>
  );
}

function AddonForm({ licenseId, onDone }) {
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/atc/licenses/${licenseId}/addons`, { quantity: Number(quantity) });
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
        <label className="label" htmlFor="a-qty">Additional branches</label>
        <input id="a-qty" type="number" min="1" max="100" className="input" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Adding…' : 'Add branch licences'}
      </button>
    </form>
  );
}

function OwnerForm({ companyId, onCreated }) {
  const [form, setForm] = useState({ fullName: '', email: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post(`/atc/companies/${companyId}/owner`, form);
      onCreated({ email: data.user.email, tempPassword: data.tempPassword });
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="o-name">Full name</label>
        <input id="o-name" className="input" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} required minLength={2} />
      </div>
      <div>
        <label className="label" htmlFor="o-email">Email</label>
        <input id="o-email" type="email" className="input" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create owner account'}
      </button>
    </form>
  );
}

export default function AtcCompanyDetail() {
  const { companyId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'license' | 'addon' | 'owner'
  const [credential, setCredential] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/atc/companies/${companyId}`);
      setData(data);
    } catch (err) {
      setError(apiError(err, 'Could not load the company'));
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <FullScreenSpinner />;

  const { company, branches, users, licenses } = data;
  const currentLicense = licenses[0] ?? null;

  const setCompanyStatus = async (status) => {
    try {
      await api.patch(`/atc/companies/${company.id}/status`, { status });
      await load();
    } catch (err) {
      setError(apiError(err));
    }
  };

  const closeModal = () => {
    setModal(null);
    setCredential(null);
    load();
  };

  return (
    <div>
      <Link to="/atc/companies" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-pos-royal hover:underline">
        <ArrowLeft className="h-4 w-4" /> All companies
      </Link>

      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {company.name} {company.isDemo ? <DemoBadge /> : null} <StatusBadge status={company.status} />
          </span>
        }
        subtitle={`/${company.slug}${company.contactEmail ? ` · ${company.contactEmail}` : ''}`}
        actions={
          <>
            {company.status === 'SUSPENDED' ? (
              <button type="button" className="btn-primary" onClick={() => setCompanyStatus('ACTIVE')}>Restore access</button>
            ) : (
              <button
                type="button"
                className="btn-ghost text-red-600"
                onClick={() => {
                  if (window.confirm(`Suspend ${company.name}? All of its POS sessions end immediately.`)) {
                    setCompanyStatus('SUSPENDED');
                  }
                }}
              >
                Suspend access
              </button>
            )}
          </>
        }
      />

      <ErrorNote message={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Licences</h2>
            <div className="flex gap-2">
              {currentLicense?.plan === 'MULTI_STORE' ? (
                <button type="button" className="btn-ghost" onClick={() => setModal('addon')}>
                  <PackagePlus className="h-4 w-4" /> Add-on
                </button>
              ) : null}
              <button type="button" className="btn-primary" onClick={() => setModal('license')}>
                <BadgePlus className="h-4 w-4" /> Issue licence
              </button>
            </div>
          </div>
          {licenses.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No licence yet — the customer cannot create branches until one is issued.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {licenses.map((l, i) => (
                <li key={l.id} className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-pos-ink">{l.plan.replace('_', ' ')}</span>
                      <StatusBadge status={l.status} />
                      {i === 0 ? <span className="badge bg-pos-royal/10 text-pos-royal">current</span> : null}
                    </div>
                    <span className="text-xs text-slate-500">
                      limit {l.branchLimit} · until {new Date(l.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                  {l.addons.length > 0 ? (
                    <div className="mt-1 text-xs text-slate-500">
                      add-ons: {l.addons.map((a) => `+${a.quantity}`).join(', ')} branches
                    </div>
                  ) : null}
                  {l.notes ? <div className="mt-1 text-xs text-slate-400">{l.notes}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Users ({users.length})</h2>
            <button type="button" className="btn-primary" onClick={() => setModal('owner')}>
              <UserPlus className="h-4 w-4" /> Create owner
            </button>
          </div>
          {users.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No POS accounts yet — create the first owner.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-pos-ink">{u.fullName}</div>
                    <div className="truncate text-xs text-slate-500">{u.email}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RoleBadge role={u.role} />
                    <StatusBadge status={u.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Branches ({branches.length})</h2>
          {branches.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No branches yet.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {branches.map((b) => (
                <div key={b.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-pos-ink">{b.name}</span>
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {b.code}
                    {b.city ? ` · ${b.city}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={modal === 'license'} title="Issue licence" onClose={closeModal}>
        <IssueLicenseForm companyId={company.id} onDone={closeModal} />
      </Modal>
      <Modal open={modal === 'addon'} title="Additional branch licences" onClose={closeModal}>
        {currentLicense ? <AddonForm licenseId={currentLicense.id} onDone={closeModal} /> : null}
      </Modal>
      <Modal open={modal === 'owner'} title={credential ? 'Owner created' : 'Create owner account'} onClose={closeModal}>
        {credential ? (
          <div className="space-y-4">
            <TempPasswordReveal credential={credential} />
            <button type="button" className="btn-primary w-full" onClick={closeModal}>Done</button>
          </div>
        ) : (
          <OwnerForm companyId={company.id} onCreated={setCredential} />
        )}
      </Modal>
    </div>
  );
}
