// LANE foundation — what the signed-in person may do, as the SERVER sees it.
//
// Presentation only. Every action named here is enforced again on the request
// that uses it (backend middleware/permissions.js `requireAction`), so this
// exists for one reason: not to offer a control that will come back 403. It
// never authorises anything. A screen that cannot read this list hides its
// write controls rather than assuming yes — the opposite default would put a
// button in front of a cashier and let the server refuse it afterwards, which
// is how an operator learns to distrust the screen.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import api, { apiError } from './api.js';
import { useAuth } from './auth.jsx';
import { getAtcScope } from './pos.js';
import { EmptyState, FullScreenSpinner } from '../components/ui.jsx';

const PermissionContext = createContext(null);

const NONE = { loading: false, error: '', role: '', actions: [], scope: null };

export function PermissionProvider({ children }) {
  const { user } = useAuth();
  // Subscribing to the router is deliberate. A VEXO operator's permissions are
  // the ones they hold INSIDE the company they are currently looking at; that
  // scope lives in sessionStorage, and sessionStorage cannot announce a change.
  // The ATC console writes the scope and then client-navigates, so the
  // navigation is the only signal there is — this re-reads on every render the
  // router hands us, and the fetch below is keyed on the value rather than the
  // path, so ordinary page changes cost no request.
  useLocation();
  const scopeId = user?.role === 'POS_SUPER_ADMIN' ? getAtcScope()?.id ?? null : null;

  const [state, setState] = useState({ ...NONE, loading: true });

  const userId = user?.id ?? '';
  const role = user?.role ?? '';
  // A platform operator who has not picked a company has no tenant permissions
  // to fetch — the endpoint would answer 400, once per page view — so the
  // request is not made and the screens say "choose a company" instead.
  const unscopedPlatform = role === 'POS_SUPER_ADMIN' && !scopeId;

  useEffect(() => {
    if (!userId || unscopedPlatform) {
      setState({ ...NONE, role });
      return undefined;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      try {
        const { data } = await api.get('/permissions/me');
        if (!live) return;
        setState({
          loading: false,
          error: '',
          role: data.role ?? role,
          actions: data.actions ?? [],
          scope: data.scope ?? null,
        });
      } catch (err) {
        if (!live) return;
        // Empty actions, not the role's baseline: a list we could not read is
        // not a list we may assume.
        setState({
          ...NONE,
          role,
          error: apiError(err, 'Could not load your permissions'),
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [userId, role, scopeId, unscopedPlatform]);

  const value = useMemo(() => {
    const held = new Set(state.actions);
    return {
      ...state,
      unscopedPlatform,
      can: (action) => held.has(action),
      // "Any of these" — for a screen that is worth opening if the person can
      // do one of several things on it.
      canAny: (...actions) => actions.flat().some((a) => held.has(a)),
    };
  }, [state, unscopedPlatform]);

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export const usePermissions = () => useContext(PermissionContext);

// Shown INSTEAD of a screen the person may not open. Not a redirect: they typed
// or bookmarked this URL, and being bounced to the dashboard with no message
// reads as a broken link rather than as an answer.
export function PermissionDenied({ what = 'this screen' }) {
  const { unscopedPlatform, error } = usePermissions();
  if (unscopedPlatform) {
    return (
      <EmptyState
        icon={ShieldOff}
        title="Choose a company first"
        note="VEXO operator accounts act inside one customer account at a time. Open a company from the VEXO console, then come back."
      />
    );
  }
  return (
    <EmptyState
      icon={ShieldOff}
      title={`You do not have permission to open ${what}`}
      note={
        error ||
        'Your role does not include this. The account owner can change it from Users & Access.'
      }
    />
  );
}

// Route-level gate. The server refuses the underlying calls regardless; this
// keeps the person off a screen that would be nothing but refusals. `action`
// may be one name or a list — a list admits anyone holding ANY of them, for a
// screen whose sections already hide themselves one by one.
export function RequireAction({ action, what, children }) {
  const { loading, can, canAny } = usePermissions();
  if (loading) return <FullScreenSpinner />;
  const ok = Array.isArray(action) ? canAny(...action) : can(action);
  if (!ok) return <PermissionDenied what={what} />;
  return children;
}
