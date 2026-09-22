import { useEffect, useState } from 'react';
import { BadgeCheck, PackagePlus } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import {
  PageHeader,
  StatusBadge,
  ErrorNote,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

const PLAN_NOTES = {
  FREE_TRIAL: 'Evaluation licence issued by VEXO with a fixed expiry.',
  SINGLE_STORE: 'One active branch. Upgrade to Multi-Store for more outlets.',
  MULTI_STORE: 'Multiple branches; extra branch licences can be added by VEXO.',
};

export default function Licensing() {
  const [license, setLicense] = useState(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/license');
        setLicense(data.license);
      } catch (err) {
        setError(apiError(err, 'Could not load licence details'));
      }
    })();
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (license === undefined) return <FullScreenSpinner />;

  return (
    <div>
      <PageHeader
        title="Licence"
        subtitle="Your VEXO Connect licence. Plans, expiry and branch limits are managed by VEXO."
      />

      {license === null ? (
        <EmptyState
          icon={BadgeCheck}
          title="No licence issued"
          note="Contact VEXO to activate a licence for this company."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-6">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current plan</div>
              <StatusBadge status={license.status} />
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight text-pos-ink">
              {license.plan.replace('_', ' ')}
            </div>
            <p className="mt-2 text-sm text-slate-500">{PLAN_NOTES[license.plan]}</p>
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Starts</dt>
                <dd className="mt-0.5 font-semibold text-pos-ink">{new Date(license.startsAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Expires</dt>
                <dd className="mt-0.5 font-semibold text-pos-ink">{new Date(license.expiresAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Base branch limit</dt>
                <dd className="mt-0.5 font-semibold text-pos-ink">{license.baseBranchLimit}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Effective branch limit</dt>
                <dd className="mt-0.5 font-semibold text-pos-ink">{license.branchLimit}</dd>
              </div>
            </dl>
          </div>

          <div className="card p-6">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <PackagePlus className="h-4 w-4" /> Additional branch licences
            </div>
            {license.addons.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">
                No add-ons on this licence. To open more branches than your base limit, ask VEXO to add
                branch licences under the same account.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100 text-sm">
                {license.addons.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-3">
                    <span className="font-semibold text-pos-ink">+{a.quantity} branch{a.quantity > 1 ? 'es' : ''}</span>
                    <span className="text-xs text-slate-500">
                      {a.expiresAt ? `until ${new Date(a.expiresAt).toLocaleDateString()}` : 'follows licence expiry'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-5 rounded-lg bg-pos-surface p-3 text-xs text-slate-500">
              Licence changes (renewals, upgrades, extra branches, suspension) are done by the VEXO
              team — reach your VEXO contact to make changes.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
