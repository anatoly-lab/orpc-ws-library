// Shared layout route for authenticated pages.
//
// Owns the single "if we hold a token, connect the WS" guard so every child
// route inherits it without repeating the effect. New authed pages added under
// this route in App.tsx are guarded for free — that is the whole point of
// lifting the guard out of the individual pages.
//
// Why a layout route and not a wrapper component: react-router renders the
// matched child into <Outlet />, so this component mounts once and stays
// mounted across navigations between sibling authed pages. The connect guard
// therefore runs on first entry into the authed area and survives intra-area
// navigation — no connect churn per page.

import { useEffect, type ReactElement } from "react";

import { Outlet } from "react-router-dom";

import { useAuthState } from "@repo/orpc-ws-oidc-react";

import { authClient, wsClient } from "./lib/ws-client.js";

export function AppLayout(): ReactElement {
  // Reactive auth read (CLAUDE.md "State vs events"). Replaces the prior
  // one-shot `authClient.hasToken()`: the guard now re-evaluates on login,
  // logout, refresh, and cross-tab changes instead of only at page load.
  const { status } = useAuthState(authClient);

  // Gate on `status !== "anonymous"` (tokens present), NOT strictly
  // "authenticated". This mirrors the prior `hasToken()` semantics, which was
  // true whenever tokens existed — covering both "authenticated" and "expired".
  // An expired token must still trigger a connect attempt so the library's
  // reconnect+refresh dance can recover the session (send stale token, get
  // 1008, call refresh()). Gating on "authenticated" only would regress that
  // recovery path and break reconnection after a token lapses.
  const loggedIn = status !== "anonymous";

  // Connect when logged in. NO cleanup on purpose: the wsClient is a
  // module-level singleton that outlives this component. Returning a cleanup
  // that calls dispose() would tear down the shared connection on React
  // StrictMode's dev double-mount (and on any unmount), leaving a disposed,
  // terminal singleton that can never reconnect. Disposal happens exactly once,
  // explicitly, on logout (see Home.onSignOut). connect() is idempotent, so
  // re-running this effect is safe.
  useEffect(() => {
    if (loggedIn) wsClient.connect();
  }, [loggedIn]);

  return <Outlet />;
}
