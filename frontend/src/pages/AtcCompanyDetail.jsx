import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BadgePlus, ShoppingCart, UserPlus, PackagePlus } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { setAtcScope, fmtDate } from '../lib/pos.js';
import {
  PageHeader,
  StatusBadge,
  DemoBadge,
  RoleBadge,
  ErrorNote,
  Modal,
  FullScreenSpinner,
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

// Inviting the owner, not creating them. This form used to POST and get a
// temporary password back, which the screen then displayed — a live credential
// on a monitor that is routinely screen-shared during onboarding calls, and in
// any screenshot of it. There is nothing to display now: the link goes to the
// customer's mailbox and exists nowhere else.
function OwnerForm({ companyId, onSent }) {
  const [form, setForm] = useState({ fullName: '', email: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post(`/atc/companies/${companyId}/owner`, form);
      onSent(data.invitation);
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
        <p className="mt-1.5 text-xs text-slate-500">
          They will receive a sign-up link at this address and choose their own password. Nobody here ever sees it.
        </p>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Sending…' : 'Send owner invitation'}
      </button>
    </form>
  );
}

export default function AtcCompanyDetail() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'license' | 'addon' | 'owner'
  const [sentTo, setSentTo] = useState(null);
  const [invitations, setInvitations] = useState([]);

  const load = useCallback(async () => {
    try {
      const [detail, invites] = await Promise.all([
        api.get(`/atc/companies/${companyId}`),
        api.get(`/atc/companies/${companyId}/invitations`),
      ]);
      setData(detail.data);
      setInvitations(invites.data.invitations);
    } catch (err) {
      setError(apiError(err, 'Could not load the company'));
    }
  }, [companyId]);

  // An invitation is a live way into the customer's account until it is used or
  // withdrawn, so the two controls that end one sit next to it rather than
  // somewhere an operator has to go looking.
  const inviteAction = async (id, what) => {
    setError('');
    try {
      await api.post(`/atc/invitations/${id}/${what}`);
      await load();
    } catch (err) {
      setError(apiError(err));
    }
  };

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
    setSentTo(null);
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
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setAtcScope({ id: company.id, name: company.name });
                navigate('/orders');
              }}
            >
              <ShoppingCart className="h-4 w-4" /> Browse POS data
            </button>
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
                      {/* IST, like every other date in the product. This one is
                          read by ATC support while a customer is on the phone
                          asking when their licence runs out. */}
                      limit {l.branchLimit} · until {fmtDate(l.expiresAt)}
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
              <UserPlus className="h-4 w-4" /> Invite owner
            </button>
          </div>
          {users.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">
              No POS accounts yet — invite the first owner. The account appears here once they open the link and choose
              a password.
            </p>
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

        {invitations.length > 0 ? (
          <div className="card p-5 lg:col-span-2">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">
              Invitations ({invitations.length})
            </h2>
            <ul className="divide-y divide-slate-100 text-sm">
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-pos-ink">{i.fullName}</div>
                    <div className="truncate text-xs text-slate-500">
                      {i.email}
                      {i.status === 'PENDING' ? ` · expires ${fmtDate(i.expiresAt)}` : ''}
                      {i.sentCount > 1 ? ` · sent ${i.sentCount}×` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RoleBadge role={i.role} />
                    <StatusBadge status={i.status} />
                    {i.status === 'PENDING' ? (
                      <>
                        {/* Resending mints a NEW link and kills the old one, so
                            a message forwarded by mistake stops working. */}
                        <button type="button" className="btn-ghost text-xs" onClick={() => inviteAction(i.id, 'resend')}>
                          Resend
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs text-red-600"
                          onClick={() => {
                            if (window.confirm(`Withdraw the invitation to ${i.email}? The link stops working at once.`)) {
                              inviteAction(i.id, 'revoke');
                            }
                          }}
                        >
                          Revoke
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

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
      <Modal open={modal === 'owner'} title={sentTo ? 'Invitation sent' : 'Invite the owner'} onClose={closeModal}>
        {sentTo ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-semibold">A sign-up link is on its way to {sentTo.email}.</p>
              <p className="mt-1.5 text-emerald-800">
                It expires on {fmtDate(sentTo.expiresAt)} and can be used once. They choose their own password when they
                open it — there is no password for you to pass on, and nothing here to write down.
              </p>
            </div>
            <button type="button" className="btn-primary w-full" onClick={closeModal}>Done</button>
          </div>
        ) : (
          <OwnerForm companyId={company.id} onSent={setSentTo} />
        )}
      </Modal>
    </div>
  );
}
