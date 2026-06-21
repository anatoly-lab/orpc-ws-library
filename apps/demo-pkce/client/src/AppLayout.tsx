// Shared layout route for the authed area. Owns TWO responsibilities:
//
//   1. The connect guard — "if we hold a token, connect the WS" — so every
//      child route inherits it without repeating the effect. New authed pages
//      added under this route in App.tsx are guarded for free.
//   2. The render gate — anonymous visitors see <SignIn />, token-holders see
//      the matched child. This is delegated to the library's <RequireAuth>,
//      which lifts the old per-page `if (!loggedIn)` block out of Home.
//
// Division of responsibility: AppLayout reads `status` once to drive the
// connect effect; RequireAuth independently reads the same reactive auth
// source for the render gate. Both subscribe to the one cheap store — no
// double-implementation of the gate, just two readers of one truth.
//
// Why a layout route and not a wrapper component: react-router renders the
// matched child into <Outlet />, so this component mounts once and stays
// mounted across navigations between sibling authed pages. The connect guard
// therefore runs on first entry into the authed area and survives intra-area
// navigation — no connect churn per page.

import { useEffect, type ReactElement } from "react";

import { Outlet } from "react-router";

import { RequireAuth, useAuthState } from "@orpc-ws/oidc-react";

import { SignIn } from "./pages/SignIn.js";
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

  // Render gate lives in the library: anonymous → <SignIn />, else the child.
  // RequireAuth uses the same `status !== "anonymous"` predicate as the connect
  // guard above, so an expired session still renders the authed UI while the
  // WS recovers.
  return (
    <RequireAuth client={authClient} fallback={<SignIn />}>
      <Outlet />
    </RequireAuth>
  );
}
