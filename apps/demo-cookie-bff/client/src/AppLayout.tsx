// Shared layout route for the authed area. Owns TWO responsibilities:
//
//   1. The /auth/me + connect guard — "ask the server who we are; if a session
//      exists, connect the WS" — so every child route inherits it without
//      repeating the effect.
//   2. The render gate — visitors with no server session see <SignIn />,
//      session-holders see the matched child.
//
// Unlike a browser-PKCE SPA, this app does NOT use any reactive auth-state
// hook or auth-guard component (it imports no auth-core package at all — that
// is the point of this demo). The "am I signed in?" answer comes from a one-shot
// `auth.me()` against the server session. The resolved identity is handed down
// to the child via the router's <Outlet /> context, so Home can render it
// WITHOUT a `getUser()` round-trip (cookie-bff already proved identity on the
// HTTP side).
//
// Why a layout route and not a wrapper component: react-router renders the
// matched child into <Outlet />, so this component mounts once and stays
// mounted across navigations between sibling authed pages. The connect guard
// therefore runs on first entry into the authed area and survives intra-area
// navigation — no connect churn per page.

import { useEffect, useState, type ReactElement } from "react";

import { Outlet } from "react-router";

import { me, type Identity } from "./lib/auth.js";
import { wsClient } from "./lib/ws-client.js";
import { SignIn } from "./pages/SignIn.js";

/** Context the layout hands to the matched child via <Outlet />. */
export interface HomeOutletContext {
  identity: Identity;
}

// Three-state machine for the /auth/me result: we must not render the gate
// until the async call settles, otherwise a session-holder would flash
// <SignIn /> on every reload.
type AuthGate =
  | { kind: "checking" }
  | { kind: "authed"; identity: Identity }
  | { kind: "anonymous" };

export function AppLayout(): ReactElement {
  const [gate, setGate] = useState<AuthGate>({ kind: "checking" });

  // Check the session once on mount via GET /auth/me. An identity → connect the
  // WS (the `sid` cookie rides the handshake automatically) and render the
  // child; null → render <SignIn />.
  //
  // NO WS cleanup on unmount, on purpose: the wsClient is a module-level
  // singleton that outlives this component. A cleanup calling dispose() would
  // tear down the shared connection on React StrictMode's dev double-mount,
  // leaving a disposed, terminal singleton that can never reconnect. Disposal
  // happens exactly once, explicitly, on sign-out (see Home.onSignOut).
  // connect() is idempotent, so a re-run of this effect is safe.
  useEffect(() => {
    let cancelled = false;
    void me().then((identity) => {
      if (cancelled) return;
      if (identity) {
        wsClient.connect();
        setGate({ kind: "authed", identity });
      } else {
        setGate({ kind: "anonymous" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hold rendering until /auth/me settles (avoids a <SignIn /> flash for
  // session-holders). A bare neutral line is enough for the demo.
  if (gate.kind === "checking") {
    return <p data-testid="auth-checking">Checking session...</p>;
  }

  // Render gate: anonymous → <SignIn />, else the matched child with the
  // identity in Outlet context.
  if (gate.kind === "anonymous") {
    return <SignIn />;
  }

  const context: HomeOutletContext = { identity: gate.identity };
  return <Outlet context={context} />;
}
