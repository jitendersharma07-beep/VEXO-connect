// The manager's signature, asked for at the moment it is needed.
//
// When the server refuses a discount as above the operator's limit it answers
// POS_DISCOUNT_NOT_PERMITTED, and that refusal is not a dead end — it is a
// "fetch someone who can sign for this". This module turns that answer into a
// prompt, and re-sends the SAME request with the approver's own credentials
// attached.
//
// It works as a response interceptor rather than as a wrapper around each
// call, for two reasons. The first is blast radius: six routes move a
// discount, including three that never mention one (adding a line, changing a
// quantity, removing a line — each of them changes the bill the discount is
// measured against). Wrapping them one by one means the day somebody adds a
// seventh, the till dead-ends at the counter. The second is that it keeps the
// Sell screen's code exactly as it was.
//
// Two rules this file exists to hold:
//
//   - The approver types their OWN email and password, here, now. There is no
//     manager mode, no token, no "approver PIN" left on a sticky note. The
//     server re-verifies the password on every single request.
//   - A refused approval NEVER re-prompts on its own. The prompt stays open
//     showing why it was refused, and waits for a human to press the button
//     again. An automatic retry loop against a password field is a password
//     guesser, and the server throttles it — the till should not be the thing
//     tripping that throttle.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import api, { apiError } from './api.js';
import { ErrorNote, Modal } from '../components/ui.jsx';

const DENIED = 'POS_DISCOUNT_NOT_PERMITTED';
const REFUSED = 'POS_DISCOUNT_APPROVAL_REFUSED';

// axios has already serialised the request body by the time a response
// interceptor sees it, so the retry has to put it back together.
const bodyOf = (config) => {
  const raw = config?.data;
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

function ApprovalPrompt({ prompt, onSubmit, onCancel }) {
  const [approverEmail, setApproverEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');

  // A fresh prompt starts empty. In particular the password is never carried
  // over from a previous approval, on this order or any other.
  useEffect(() => {
    if (prompt?.token) {
      setApproverEmail('');
      setPassword('');
      setReason('');
    }
  }, [prompt?.token]);

  if (!prompt) return null;

  const submit = (e) => {
    e.preventDefault();
    onSubmit({ approverEmail: approverEmail.trim(), password, reason: reason.trim() });
    // Cleared the instant it leaves this component. It lives in the request
    // and nowhere else.
    setPassword('');
  };

  const ready = approverEmail.trim() !== '' && password !== '' && reason.trim() !== '';

  return (
    <Modal open title="A manager needs to approve this" onClose={onCancel}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">{prompt.message}</div>
        </div>

        <p className="text-xs text-slate-500">
          The approver signs in here themselves. Do not enter someone else&rsquo;s password on their
          behalf — this is recorded against their name.
        </p>

        <div>
          <label className="label" htmlFor="approver-email">
            Approver&rsquo;s email
          </label>
          <input
            id="approver-email"
            type="email"
            autoComplete="off"
            className="input"
            value={approverEmail}
            onChange={(e) => setApproverEmail(e.target.value)}
            disabled={prompt.busy}
            required
            autoFocus
          />
        </div>
        <div>
          <label className="label" htmlFor="approver-password">
            Approver&rsquo;s password
          </label>
          <input
            id="approver-password"
            type="password"
            autoComplete="new-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={prompt.busy}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="approver-reason">
            Reason for the discount
          </label>
          <input
            id="approver-reason"
            type="text"
            maxLength={200}
            className="input"
            placeholder="Why is this being given?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={prompt.busy}
            required
          />
        </div>

        <ErrorNote message={prompt.error} />

        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onCancel} disabled={prompt.busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={prompt.busy || !ready}>
            {prompt.busy ? 'Checking…' : 'Approve'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ApprovalProvider({ children }) {
  const [prompt, setPrompt] = useState(null);
  const resolverRef = useRef(null);
  const tokenRef = useRef(0);

  // Resolves with the approver's credentials, or with null if the operator
  // backed out. One press of the button, one resolution.
  const ask = useCallback(
    (info) =>
      new Promise((resolve) => {
        tokenRef.current += 1;
        resolverRef.current = resolve;
        setPrompt({ ...info, token: tokenRef.current, busy: false });
      }),
    [],
  );

  const settle = useCallback((value) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    if (value) setPrompt((p) => (p ? { ...p, busy: true } : p));
    else setPrompt(null);
    resolve?.(value);
  }, []);

  const close = useCallback(() => {
    resolverRef.current = null;
    setPrompt(null);
  }, []);

  useEffect(() => {
    const id = api.interceptors.response.use(undefined, async (err) => {
      const data = err?.response?.data;
      if (err?.response?.status !== 403 || data?.error?.code !== DENIED) return Promise.reject(err);

      const config = err.config;
      // No config means nothing to re-send. The flag stops the retry itself
      // from opening a second prompt if it comes back denied for a different
      // reason — one refusal, one prompt.
      if (!config || config.__discountApproval) return Promise.reject(err);
      config.__discountApproval = true;

      const body = bodyOf(config);
      let error = '';

      // Loops only on a human pressing Approve again. Nothing in here retries
      // by itself.
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const approval = await ask({ message: data.error.message, details: data.error.details, error });
        if (!approval) {
          close();
          return Promise.reject(err);
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await api.request({ ...config, data: { ...body, approval } });
          close();
          return res;
        } catch (again) {
          if (again?.response?.data?.error?.code === REFUSED) {
            // Wrong password, wrong branch, over the approver's own ceiling,
            // or the throttle. Say so and wait to be asked again.
            error = apiError(again, 'Those approver credentials were not accepted.');
            continue;
          }
          close();
          return Promise.reject(again);
        }
      }
    });
    return () => api.interceptors.response.eject(id);
  }, [ask, close]);

  return (
    <>
      {children}
      <ApprovalPrompt prompt={prompt} onSubmit={settle} onCancel={() => settle(null)} />
    </>
  );
}
