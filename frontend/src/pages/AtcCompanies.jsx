import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import {
  PageHeader,
  StatusBadge,
  DemoBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

function CompanyForm({ onDone }) {
  const [form, setForm] = useState({
    name: '',
    slug: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    city: '',
    state: '',
    isDemo: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = { isDemo: form.isDemo };
      for (const [k, v] of Object.entries(form)) {
        if (k !== 'isDemo' && String(v).trim() !== '') payload[k] = v;
      }
      await api.post('/atc/companies', payload);
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
        <label className="label" htmlFor="c-name">Company name</label>
        <input id="c-name" className="input" value={form.name} onChange={set('name')} required minLength={2} />
      </div>
      <div>
        <label className="label" htmlFor="c-slug">Slug (lowercase, unique)</label>
        <input
          id="c-slug"
          className="input"
          value={form.slug}
          onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
          required
          pattern="[a-z0-9-]{2,40}"
          placeholder="acme-restaurants"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="c-contact">Contact name</label>
          <input id="c-contact" className="input" value={form.contactName} onChange={set('contactName')} />
        </div>
        <div>
          <label className="label" htmlFor="c-phone">Contact phone</label>
          <input id="c-phone" className="input" value={form.contactPhone} onChange={set('contactPhone')} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="c-email">Contact email</label>
        <input id="c-email" type="email" className="input" value={form.contactEmail} onChange={set('contactEmail')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="c-city">City</label>
          <input id="c-city" className="input" value={form.city} onChange={set('city')} />
        </div>
        <div>
          <label className="label" htmlFor="c-state">State</label>
          <input id="c-state" className="input" value={form.state} onChange={set('state')} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={form.isDemo}
          onChange={(e) => setForm((f) => ({ ...f, isDemo: e.target.checked }))}
          className="h-4 w-4 rounded border-slate-300 text-pos-royal focus:ring-pos-royal"
        />
        Mark as demo company (sample data only)
      </label>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create company'}
      </button>
    </form>
  );
}

export default function AtcCompanies() {
  const [companies, setCompanies] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/atc/companies');
      setCompanies(data.companies);
    } catch (err) {
      setError(apiError(err, 'Could not load companies'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error && companies === null) return <ErrorNote message={error} />;
  if (companies === null) return <FullScreenSpinner />;

  return (
    <div>
      <PageHeader
        title="Customer companies"
        subtitle="Every POS tenant, its licence state and size — onboarding and licensing happen here."
        actions={
          <button type="button" className="btn-orange" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New company
          </button>
        }
      />

      <ErrorNote message={error} />

      {companies.length === 0 ? (
        <EmptyState icon={Building2} title="No customer companies yet" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Company</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Licence</th>
                <th className="px-4 py-3 font-semibold">Branches</th>
                <th className="px-4 py-3 font-semibold">Users</th>
                <th className="px-4 py-3 font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {companies.map((c) => (
                <tr key={c.id} className="hover:bg-pos-surface/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-pos-ink">{c.name}</span>
                      {c.isDemo ? <DemoBadge /> : null}
                    </div>
                    <div className="text-xs text-slate-400">/{c.slug}{c.city ? ` · ${c.city}` : ''}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-3">
                    {c.license ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-600">{c.license.plan.replace('_', ' ')}</span>
                        <StatusBadge status={c.license.status} />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">none</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{c.branches}</td>
                  <td className="px-4 py-3 text-slate-600">{c.users}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/atc/companies/${c.id}`} className="text-xs font-semibold text-pos-royal hover:underline">
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} title="New customer company" onClose={() => setOpen(false)}>
        <CompanyForm
          onDone={() => {
            setOpen(false);
            load();
          }}
        />
      </Modal>
    </div>
  );
}
