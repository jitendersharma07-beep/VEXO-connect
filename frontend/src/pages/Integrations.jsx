// LANE providers — the Integrations screen (task §6).
//
// Three rules this screen keeps, and they are the reason it looks the way it
// does rather than like a settings page:
//
//   * It ASSERTS NOTHING. Every status, timestamp and count here was written by
//     a real call — the server derives them from columns, and this file only
//     formats them. There is no optimistic "Connected" after a successful save,
//     because saving a key proves nothing about whether the key works.
//
//   * A SECRET NEVER COMES BACK. No credential field is ever pre-filled: the
//     API has no endpoint that returns one. What an operator sees is whether a
//     credential exists and when it last changed, and an empty box means
//     "replace it", not "it is blank".
//
//   * THE FORM IS GENERATED from the server's own field descriptors, not typed
//     out again here. A hand-written form drifts from the schema that validates
//     it, and the direction it drifts is that a required field stops being
//     offered — so saving fails, with a message about a box the operator was
//     never shown. tests/integrations.test.js asserts both directions of that.
//
// Every control is hidden unless the signed-in user holds the action behind it,
// and the server re-judges all eight regardless.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileUp,
  Info,
  KeyRound,
  ListChecks,
  Plug,
  RefreshCw,
  ScrollText,
  Store,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { usePermissions } from '../lib/permissions.jsx';
import {
  EmptyState,
  ErrorNote,
  FullScreenSpinner,
  PageHeader,
  StatCard,
} from '../components/ui.jsx';
import { fmtDateTime } from '../lib/pos.js';

// Not ui.jsx's StatusBadge. Its map has no ERROR and no CONNECTED, and an
// unrecognised status there falls back to grey — which would paint a broken
// integration the same colour as one nobody has set up yet.
const CONN_STYLES = {
  CONNECTED: 'bg-emerald-100 text-emerald-700',
  CONFIGURED: 'bg-amber-100 text-amber-700',
  DISABLED: 'bg-slate-200 text-slate-600',
  NOT_CONFIGURED: 'bg-slate-100 text-slate-500',
  ERROR: 'bg-red-100 text-red-700',
};

// What the status MEANS, in the words an operator would use. "CONFIGURED" on its
// own reads like success; it is not, and the difference is the whole point of
// the state.
const CONN_HINTS = {
  CONNECTED: 'A real call to the provider has succeeded.',
  CONFIGURED: 'Set up, but nothing has been shown to work yet. Press Test.',
  DISABLED: 'Set up and switched off. Nothing is being sent or received.',
  NOT_CONFIGURED: 'Not set up.',
  ERROR: 'The last attempt failed. The reason is below.',
};

function ConnBadge({ status }) {
  return (
    <span className={`badge ${CONN_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>
  );
}

const CONTRACT_STYLES = {
  SPECIFIED: 'text-emerald-700',
  PATH_ONLY: 'text-amber-700',
  UNSPECIFIED: 'text-slate-400',
  NOT_OFFERED: 'text-slate-400',
};

// Reads the provider registry's own vocabulary out loud. An operator deciding
// whether to switch something on is entitled to know that "we have the endpoint
// but not the body shape" is different from "this is documented".
const CONTRACT_HINTS = {
  SPECIFIED: 'Documented in full.',
  PATH_ONLY: 'Endpoint known, request shape not published — verify against your own account.',
  UNSPECIFIED: 'Not published.',
  NOT_OFFERED: 'The provider does not offer this.',
};

function Section({ icon: Icon, title, note, right, children }) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-pos-ink">
            {Icon ? <Icon className="h-4 w-4 text-pos-royal" /> : null}
            {title}
          </div>
          {note ? <div className="mt-1 max-w-2xl text-xs text-slate-500">{note}</div> : null}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

const Th = ({ children, right = false }) => (
  <th className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 ${right ? 'text-right' : 'text-left'}`}>
    {children}
  </th>
);
const Td = ({ children, right = false }) => (
  <td className={`px-3 py-2 text-sm text-slate-700 ${right ? 'text-right' : ''}`}>{children}</td>
);

// --- generated fields --------------------------------------------------------

// `secret` is a property of the VALUE, not of the field's type: Zomato's inbound
// header value is a text field that happens to be a shared secret, and it must
// never be rendered into a readable input or an autofill store.
function FieldInput({ field, value, onChange, disabled }) {
  const id = `f-${field.name}`;
  const common = { id, disabled, className: 'input' };
  return (
    <div>
      <label className="label" htmlFor={id}>
        {field.label}
        {field.required ? <span className="ml-1 text-red-600">*</span> : null}
      </label>
      {field.type === 'boolean' ? (
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-700">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {value === true ? 'On' : 'Off'}
        </label>
      ) : field.type === 'select' ? (
        <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">(default)</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          type={field.secret ? 'password' : field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          autoComplete={field.secret ? 'new-password' : 'off'}
          value={value ?? ''}
          placeholder={field.secret ? '••••••••' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help ? <div className="mt-1 text-xs text-slate-500">{field.help}</div> : null}
    </div>
  );
}

// '' from a cleared box is dropped rather than sent as an empty string: the
// schemas treat an absent optional field as "leave it alone" and an empty string
// as a value that fails validation.
const pruneBlank = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null));

function ConfigForm({ provider, connection, onSaved }) {
  const [form, setForm] = useState(() => ({ ...(connection?.config ?? {}) }));
  const [enabled, setEnabled] = useState(connection?.enabled ?? false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seeded when the server's copy changes (a save, or switching provider),
  // so the boxes show what is stored rather than what was typed last time.
  useEffect(() => {
    setForm({ ...(connection?.config ?? {}) });
    setEnabled(connection?.enabled ?? false);
  }, [connection?.id, connection?.updatedAt]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.put(`/integrations/${provider.key}`, {
        enabled,
        config: pruneBlank(form),
      });
      onSaved(data);
    } catch (err) {
      setError(apiError(err, 'Could not save these settings'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        <span className="text-sm font-semibold text-pos-ink">Enabled</span>
        <span className="text-xs text-slate-500">
          Off means nothing is sent or accepted, and queued work waits.
        </span>
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        {provider.configFields.map((f) => (
          <FieldInput
            key={f.name}
            field={f}
            value={form[f.name]}
            disabled={busy}
            onChange={(v) => setForm((s) => ({ ...s, [f.name]: v }))}
          />
        ))}
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}

function CredentialForm({ provider, connection, storageAvailable, onSaved }) {
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!storageAvailable) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Credential storage is not configured on this deployment, so provider keys cannot be stored.
        Set <code className="font-mono">POS_INTEGRATION_SECRET_KEY</code> and restart. Storing keys
        unencrypted is refused rather than done quietly.
      </div>
    );
  }
  if (!connection) {
    return (
      <div className="text-sm text-slate-500">
        Save the settings above first — a credential is stored against an existing connection.
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.put(`/integrations/${provider.key}/credential`, { credential: pruneBlank(form) });
      setForm({});
      onSaved();
    } catch (err) {
      setError(apiError(err, 'Could not store this credential'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-xs text-slate-500">
        {connection.hasCredential
          ? `A credential is stored (last changed ${fmtDateTime(connection.credentialUpdatedAt)}). These boxes are always empty — the API has no endpoint that returns a stored key. Filling them REPLACES it.`
          : 'No credential stored yet.'}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {provider.credentialFields.map((f) => (
          <FieldInput
            key={f.name}
            field={f}
            value={form[f.name]}
            disabled={busy}
            onChange={(v) => setForm((s) => ({ ...s, [f.name]: v }))}
          />
        ))}
      </div>
      <ErrorNote message={error} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Storing…' : connection.hasCredential ? 'Replace credential' : 'Store credential'}
        </button>
        {connection.hasCredential ? (
          <span className="text-xs text-slate-500">
            Replacing it clears the last successful sync — nothing has been proven with the new key yet.
          </span>
        ) : null}
      </div>
    </form>
  );
}

// --- outlet mapping ----------------------------------------------------------

function OutletMapping({ provider, outlets, branches, canMap, onSaved }) {
  const [rows, setRows] = useState(() =>
    outlets.map((o) => ({
      externalOutletId: o.externalOutletId,
      externalOutletName: o.externalOutletName ?? '',
      branchId: o.branchId,
      active: o.active,
    })),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRows(
      outlets.map((o) => ({
        externalOutletId: o.externalOutletId,
        externalOutletName: o.externalOutletName ?? '',
        branchId: o.branchId,
        active: o.active,
      })),
    );
  }, [outlets]);

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      await api.put(`/integrations/${provider.key}/outlets`, {
        outlets: rows.map((r) => ({
          externalOutletId: r.externalOutletId.trim(),
          externalOutletName: r.externalOutletName.trim() || null,
          branchId: r.branchId,
          active: r.active,
        })),
      });
      onSaved();
    } catch (err) {
      setError(apiError(err, 'Could not save the mapping'));
    } finally {
      setBusy(false);
    }
  };

  const setRow = (i, patch) => setRows((s) => s.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="text-sm text-slate-500">
          No outlets mapped. Until one is, this provider&apos;s orders have no store to go to and are
          held as discrepancies rather than guessed at.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Provider outlet ID</Th>
                <Th>Provider name</Th>
                <Th>Store</Th>
                <Th>Active</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={`${r.externalOutletId}-${i}`}>
                  <Td>
                    <input
                      className="input"
                      value={r.externalOutletId}
                      disabled={!canMap || busy}
                      onChange={(e) => setRow(i, { externalOutletId: e.target.value })}
                    />
                  </Td>
                  <Td>
                    <input
                      className="input"
                      value={r.externalOutletName}
                      disabled={!canMap || busy}
                      onChange={(e) => setRow(i, { externalOutletName: e.target.value })}
                    />
                  </Td>
                  <Td>
                    <select
                      className="input"
                      value={r.branchId}
                      disabled={!canMap || busy}
                      onChange={(e) => setRow(i, { branchId: e.target.value })}
                    >
                      <option value="">Choose a store…</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} {b.code ? `(${b.code})` : ''}
                        </option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300"
                      checked={r.active}
                      disabled={!canMap || busy}
                      onChange={(e) => setRow(i, { active: e.target.checked })}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNote message={error} />
      {canMap ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() =>
              setRows((s) => [...s, { externalOutletId: '', externalOutletName: '', branchId: '', active: true }])
            }
          >
            Add an outlet
          </button>
          <button type="button" className="btn-primary" disabled={busy || rows.length === 0} onClick={save}>
            {busy ? 'Saving…' : 'Save mapping'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// --- queue -------------------------------------------------------------------

const JOB_STYLES = {
  DEAD: 'bg-red-100 text-red-700',
  IN_FLIGHT: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-700',
  SUCCEEDED: 'bg-emerald-100 text-emerald-700',
};

function JobQueue({ provider, canRetry, onChanged }) {
  const [state, setState] = useState({ loading: true, jobs: [], summary: null, error: '' });
  const [retrying, setRetrying] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/integrations/${provider.key}/jobs`);
      setState({ loading: false, jobs: data.jobs, summary: data.summary, error: '' });
    } catch (err) {
      setState({ loading: false, jobs: [], summary: null, error: apiError(err, 'Could not read the queue') });
    }
  }, [provider.key]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = async (jobId) => {
    setRetrying(jobId);
    try {
      await api.post(`/integrations/${provider.key}/jobs/${jobId}/retry`);
      await load();
      onChanged();
    } catch (err) {
      setState((s) => ({ ...s, error: apiError(err, 'Could not retry that job') }));
    } finally {
      setRetrying('');
    }
  };

  if (state.loading) return <div className="text-sm text-slate-500">Reading the queue…</div>;

  return (
    <div className="space-y-3">
      <ErrorNote message={state.error} />
      {state.jobs.length === 0 ? (
        <div className="text-sm text-slate-500">Nothing queued.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Work</Th>
                <Th>Reference</Th>
                <Th>State</Th>
                <Th>Attempts</Th>
                <Th>Next attempt</Th>
                <Th>Last failure</Th>
                {canRetry ? <Th right>Retry</Th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.jobs.map((j) => (
                <tr key={j.id} className={j.status === 'DEAD' ? 'bg-red-50/50' : ''}>
                  <Td>{j.kind}</Td>
                  <Td>
                    <span className="font-mono text-xs">{j.externalRef || '—'}</span>
                  </Td>
                  <Td>
                    <span className={`badge ${JOB_STYLES[j.status] || 'bg-slate-100 text-slate-600'}`}>
                      {j.status}
                    </span>
                  </Td>
                  <Td>
                    {j.attempts} / {j.maxAttempts}
                  </Td>
                  <Td>{j.status === 'PENDING' ? fmtDateTime(j.nextAttemptAt) : '—'}</Td>
                  <Td>
                    {j.lastError ? (
                      <span className="text-xs text-red-700">
                        {j.lastError}
                        <span className="block text-slate-400">{fmtDateTime(j.lastErrorAt)}</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  {canRetry ? (
                    <Td right>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={retrying === j.id || j.status === 'SUCCEEDED'}
                        onClick={() => retry(j.id)}
                      >
                        {retrying === j.id ? 'Retrying…' : 'Retry now'}
                      </button>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* A DEAD job has exhausted its attempts and will never be tried again on
          its own. Saying so is the difference between a queue an operator works
          and a list they assume is draining. */}
      {state.summary?.dead ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.summary.dead} item{state.summary.dead === 1 ? '' : 's'} gave up after every retry and
          will not be attempted again without Retry now.
        </div>
      ) : null}
    </div>
  );
}

// --- historical loyalty import ----------------------------------------------

const CONFIRM_PHRASE = 'IMPORT CUSTOMERS';

// The one control on this screen that touches a hundred thousand real customer
// records. It previews by default, the real run needs the phrase typed, and a run
// that stopped part-way is RESUMED rather than started again — the server refuses
// to resume against a different file, which is why the same file has to be picked
// again here.
function LoyaltyImport() {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState(null);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const run = async ({ dryRun, resumeRunId }) => {
    setError('');
    setBusy(dryRun ? 'preview' : 'run');
    try {
      const { data } = await api.post('/integrations/REELO/import', {
        csv,
        dryRun,
        ...(dryRun ? {} : { confirm }),
        ...(resumeRunId ? { resumeRunId } : {}),
      });
      setReport(data);
    } catch (err) {
      setError(apiError(err, 'The import was refused'));
    } finally {
      setBusy('');
    }
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setReport(null);
    setError('');
    setCsv(await file.text());
  };

  const totals = report?.totals;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        This reads an export you download from your own Reelo account and records each customer&apos;s
        CURRENT balance against the POS customer. It does not enrol anyone with Reelo, does not send
        anyone a message, and does not recalculate or reset a single point — the numbers in the file
        are taken as the truth.
      </div>

      <div>
        <label className="label" htmlFor="import-file">
          Reelo customer export (CSV)
        </label>
        <input id="import-file" type="file" accept=".csv,text/csv" onChange={pick} className="input" />
        {fileName ? (
          <div className="mt-1 text-xs text-slate-500">
            {fileName} — {(csv.length / 1_048_576).toFixed(2)} MB, {Math.max(0, csv.split('\n').length - 1)} rows
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-ghost" disabled={!csv || busy} onClick={() => run({ dryRun: true })}>
          {busy === 'preview' ? 'Reading…' : 'Preview (changes nothing)'}
        </button>
      </div>

      {totals ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Rows read" value={totals.rowsRead} />
            <StatCard label="New customers" value={totals.customersCreated} accent="green" />
            <StatCard label="Matched existing" value={totals.matchedExistingCustomers} />
            <StatCard
              label="Points carried across"
              value={totals.balanceSumPoints}
              accent="orange"
              hint="Sum of the balances in the file"
            />
          </div>
          <div className="text-xs text-slate-500">
            {report.state} · {report.dryRun ? 'preview — nothing was written' : 'real import'} ·
            every row accounted for: {String(totals.reconciles)} ({totals.accountedFor} of {totals.rowsRead})
          </div>

          {totals.failed ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-sm font-semibold text-red-700">
                {totals.failed} row{totals.failed === 1 ? '' : 's'} could not be imported
              </div>
              <table className="mt-2 min-w-full">
                <thead>
                  <tr>
                    <Th>Row</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {(report.exceptions ?? []).map((x) => (
                    <tr key={x.rowNumber}>
                      <Td>{x.rowNumber}</Td>
                      <Td>{x.reason}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 text-xs text-red-700">
                Fix these rows in the file and import again. The rows that succeeded are not imported
                twice.
              </div>
            </div>
          ) : null}

          {report.canResume ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              This run stopped after row {report.resumeAfterRow}. Resuming continues from the next row
              with the SAME file — pick a different export and it will be refused rather than
              silently importing the wrong rows.
              <div className="mt-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!csv || busy}
                  onClick={() => run({ dryRun: report.dryRun, resumeRunId: report.id })}
                >
                  {busy ? 'Working…' : `Resume from row ${report.resumeAfterRow + 1}`}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <ErrorNote message={error} />

      {csv && report?.dryRun ? (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="label">Run it for real</div>
          <div className="mb-2 text-xs text-slate-500">
            Type <span className="font-mono font-semibold">{CONFIRM_PHRASE}</span> to confirm. Nothing
            below this line is reversible by pressing it again.
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="input max-w-xs"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={CONFIRM_PHRASE}
            />
            <button
              type="button"
              className="btn-orange"
              disabled={confirm !== CONFIRM_PHRASE || !!busy}
              onClick={() => run({ dryRun: false })}
            >
              {busy === 'run' ? 'Importing…' : 'Import for real'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- audit trail -------------------------------------------------------------

function AuditTrail({ providerKey }) {
  const [state, setState] = useState({ loading: true, entries: [], error: '', complete: true });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data } = await api.get('/integrations/audit/trail', { params: { provider: providerKey } });
        if (live) setState({ loading: false, entries: data.entries, error: '', complete: data.complete });
      } catch (err) {
        if (live) setState({ loading: false, entries: [], complete: true, error: apiError(err, 'Could not read the audit trail') });
      }
    })();
    return () => {
      live = false;
    };
  }, [providerKey]);

  if (state.loading) return <div className="text-sm text-slate-500">Reading the audit trail…</div>;
  if (state.error) return <ErrorNote message={state.error} />;
  if (state.entries.length === 0)
    return <div className="text-sm text-slate-500">Nothing has been changed on this integration yet.</div>;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {state.entries.map((e) => (
              <tr key={e.id}>
                <Td>{fmtDateTime(e.at)}</Td>
                <Td>
                  {e.actorEmail}
                  <span className="block text-xs text-slate-400">{e.actorRole}</span>
                </Td>
                <Td>
                  <span className="font-mono text-xs">{e.action.replace(/^INTEGRATION_/, '')}</span>
                </Td>
                <Td>
                  <span className="text-xs text-slate-500">
                    {Object.entries(e.meta)
                      .filter(([k]) => k !== 'provider')
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ') || '—'}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.complete ? null : (
        <div className="text-xs text-slate-500">Showing the most recent entries only.</div>
      )}
    </div>
  );
}

// --- the screen --------------------------------------------------------------

export default function Integrations() {
  const { can } = usePermissions();
  const [state, setState] = useState({ loading: true, providers: [], storage: false, error: '' });
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [branches, setBranches] = useState([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const loadList = useCallback(async () => {
    try {
      const { data } = await api.get('/integrations/providers');
      setState({
        loading: false,
        providers: data.providers,
        storage: data.credentialStorageAvailable,
        error: '',
      });
      return data.providers;
    } catch (err) {
      setState({ loading: false, providers: [], storage: false, error: apiError(err, 'Could not read integrations') });
      return [];
    }
  }, []);

  const loadDetail = useCallback(async (key) => {
    if (!key) return;
    setDetailError('');
    try {
      const { data } = await api.get(`/integrations/${key}`);
      setDetail(data);
    } catch (err) {
      setDetail(null);
      setDetailError(apiError(err, 'Could not read this integration'));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!can('org.store.read')) return;
    let live = true;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        if (live) setBranches(data.branches);
      } catch {
        // Not fatal: the mapping table falls back to "no stores to choose", which
        // is honest, and the rest of the screen still reads.
        if (live) setBranches([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [can]);

  useEffect(() => {
    setTestResult(null);
    loadDetail(selected);
  }, [selected, loadDetail]);

  const refresh = useCallback(async () => {
    await loadList();
    await loadDetail(selected);
  }, [loadList, loadDetail, selected]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post(`/integrations/${selected}/test`);
      setTestResult(data);
      await refresh();
    } catch (err) {
      setTestResult({ ok: false, detail: apiError(err, 'The test could not be run') });
    } finally {
      setTesting(false);
    }
  };

  const chosen = useMemo(
    () => state.providers.find((p) => p.key === selected) ?? null,
    [state.providers, selected],
  );

  if (state.loading) return <FullScreenSpinner />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        subtitle="Delivery aggregators, loyalty and accounting. Status here is what a real call last did — not what was typed in."
      />
      <ErrorNote message={state.error} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {state.providers.map((p) => {
          const conn = p.connection;
          const active = p.key === selected;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setSelected(active ? '' : p.key)}
              className={`card p-4 text-left transition-colors ${active ? 'ring-2 ring-pos-royal' : 'hover:bg-slate-50'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-bold text-pos-ink">{p.label}</div>
                  <div className="text-xs uppercase tracking-wide text-slate-400">{p.kind}</div>
                </div>
                <ConnBadge status={p.status} />
              </div>
              <div className="mt-3 text-xs text-slate-500">{CONN_HINTS[p.status]}</div>
              {conn?.lastSuccessfulSyncAt ? (
                <div className="mt-2 flex items-center gap-1 text-xs text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Last worked {fmtDateTime(conn.lastSuccessfulSyncAt)}
                </div>
              ) : null}
              {conn?.lastError ? (
                <div className="mt-2 flex items-start gap-1 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{conn.lastError}</span>
                </div>
              ) : null}
              {!p.operable ? (
                <div className="mt-2 flex items-start gap-1 text-xs text-slate-500">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>Cannot be switched on — see below.</span>
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {!chosen ? (
        <EmptyState
          icon={Plug}
          title="Choose an integration"
          note="Each one shows what its documentation actually supports, what is configured, what is queued and what failed."
        />
      ) : (
        <div className="space-y-5">
          <ErrorNote message={detailError} />

          <Section
            icon={Plug}
            title={`${chosen.label} — what is supported`}
            note={chosen.docs?.note}
            right={
              chosen.docs?.portal ? (
                <a
                  href={chosen.docs.portal}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs font-semibold text-pos-royal hover:underline"
                >
                  Provider documentation ↗
                </a>
              ) : null
            }
          >
            {/* Read from the provider registry, which is also what
                docs/INTEGRATION-VERIFICATION.md renders — one inventory, so the
                screen and the document cannot disagree. */}
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(chosen.capabilities).map(([cap, level]) => (
                <div key={cap} className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1">
                  <span className="text-sm text-slate-700">{cap}</span>
                  <span className={`text-xs font-semibold ${CONTRACT_STYLES[level] || 'text-slate-400'}`} title={CONTRACT_HINTS[level]}>
                    {level}
                  </span>
                </div>
              ))}
            </div>
            {chosen.blockedReason ? (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <div className="font-semibold">Not operable</div>
                {chosen.blockedReason}
                {chosen.alternatives?.length ? (
                  <ul className="mt-2 list-inside list-disc text-xs">
                    {chosen.alternatives.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {chosen.activation ? (
              <div className="mt-3 text-xs text-slate-500">
                <span className="font-semibold">To go live: </span>
                {Array.isArray(chosen.activation) ? chosen.activation.join(' · ') : String(chosen.activation)}
              </div>
            ) : null}
          </Section>

          {chosen.operable ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={Plug} label="Status" value={chosen.status} hint={CONN_HINTS[chosen.status]} accent={chosen.status === 'ERROR' ? 'red' : chosen.status === 'CONNECTED' ? 'green' : 'slate'} />
                <StatCard
                  icon={CheckCircle2}
                  label="Last successful sync"
                  value={detail?.connection?.lastSuccessfulSyncAt ? fmtDateTime(detail.connection.lastSuccessfulSyncAt) : 'Never'}
                  hint={detail?.connection?.lastCheckedAt ? `Last checked ${fmtDateTime(detail.connection.lastCheckedAt)}` : 'Not checked yet'}
                  accent={detail?.connection?.lastSuccessfulSyncAt ? 'green' : 'slate'}
                />
                <StatCard
                  icon={Clock}
                  label="Waiting to send"
                  value={detail?.queue?.pending ?? 0}
                  hint={detail?.queue?.due ? `${detail.queue.due} due now` : 'Nothing due'}
                  accent="orange"
                />
                <StatCard
                  icon={AlertTriangle}
                  label="Gave up"
                  value={detail?.queue?.dead ?? 0}
                  hint="Needs a person"
                  accent={detail?.queue?.dead ? 'red' : 'slate'}
                />
              </div>

              {detail?.connection?.lastError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <span className="font-semibold">Last failure </span>
                  {fmtDateTime(detail.connection.lastErrorAt)} — {detail.connection.lastError}
                </div>
              ) : null}

              {can('integration.test') ? (
                <Section
                  icon={RefreshCw}
                  title="Test the connection"
                  note="The only way this becomes CONNECTED. It calls the provider and records what happened, including a failure."
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" className="btn-primary" onClick={runTest} disabled={testing || !detail?.connection?.hasCredential}>
                      {testing ? 'Testing…' : 'Test now'}
                    </button>
                    {!detail?.connection?.hasCredential ? (
                      <span className="text-xs text-slate-500">Store a credential first.</span>
                    ) : null}
                    {testResult ? (
                      <span className={`text-sm font-semibold ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                        {testResult.ok ? 'The provider answered.' : `Failed: ${testResult.detail}`}
                      </span>
                    ) : null}
                  </div>
                </Section>
              ) : null}

              {can('integration.configure') ? (
                <Section icon={Plug} title="Settings" note="The non-secret half. Changing these does not touch the stored credential.">
                  <ConfigForm
                    provider={chosen}
                    connection={detail?.connection ?? null}
                    onSaved={refresh}
                  />
                </Section>
              ) : null}

              {can('integration.credential.write') ? (
                <Section icon={KeyRound} title="Credential" note="Goes in, never comes back out.">
                  <CredentialForm
                    provider={chosen}
                    connection={detail?.connection ?? null}
                    storageAvailable={state.storage}
                    onSaved={refresh}
                  />
                </Section>
              ) : null}

              {detail?.connection ? (
                <Section
                  icon={Store}
                  title="Outlet mapping"
                  note="One provider outlet to one store, explicitly. Nothing is inferred from names — a wrong guess sends another branch's orders to this kitchen."
                >
                  <OutletMapping
                    provider={chosen}
                    outlets={detail.outlets}
                    branches={branches}
                    canMap={can('integration.outlet.map')}
                    onSaved={refresh}
                  />
                </Section>
              ) : null}

              {detail?.connection ? (
                <Section
                  icon={ListChecks}
                  title="Queued work"
                  note="Outbound work waits here and retries on its own schedule. Errors shown are the provider's, sanitized."
                >
                  <JobQueue provider={chosen} canRetry={can('integration.job.retry')} onChanged={refresh} />
                </Section>
              ) : null}

              {chosen.key === 'REELO' && can('integration.import.run') && detail?.connection ? (
                <Section
                  icon={FileUp}
                  title="Bring existing loyalty customers across"
                  note="For a business already running Reelo. Preview first; the real run needs a typed confirmation."
                >
                  <LoyaltyImport />
                </Section>
              ) : null}

              <Section icon={ScrollText} title="Audit trail" note="Who changed what here.">
                <AuditTrail providerKey={chosen.key} />
              </Section>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
