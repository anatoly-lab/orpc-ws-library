// Shared layout route for the authed area. Owns TWO responsibilities:
//
//   1. The bootstrap + connect guard — "pull the first access token from the
//      server session; if one exists, connect the WS" — so every child route
//      inherits it without repeating the effect.
//   2. The render gate — visitors with no server session see <SignIn />,
//      session-holders see the matched child.
//
// Unlike a browser-PKCE SPA, this app does NOT use any reactive auth-state
// hook or auth-guard component (it imports no auth-core package at all — that
// is the point of this demo). The "am I signed in?" answer comes from a one-shot
// `auth.bootstrap()` against the server session, held in local component state.
//
// Why a layout route and not a wrapper component: react-router renders the
// matched child into <Outlet />, so this component mounts once and stays
// mounted across navigations between sibling authed pages. The connect guard
// therefore runs on first entry into the authed area and survives intra-area
// navigation — no connect churn per page.

import { useEffect, useState, type ReactElement } from "react";

import { Outlet } from "react-router";

import { bootstrap } from "./lib/auth.js";
import { wsClient } from "./lib/ws-client.js";
import { SignIn } from "./pages/SignIn.js";

// Three-state machine for the bootstrap result: we must not render the gate
// until the async `/auth/token` pull settles, otherwise a session-holder would
// flash <SignIn /> on every reload.
type AuthGate = "checking" | "authed" | "anonymous";

export function AppLayout(): ReactElement {
  const [gate, setGate] = useState<AuthGate>("checking");

  // Bootstrap once on mount: pull the first token from the server session.
  // `true` → connect the WS and render the child; `false` → render <SignIn />.
  //
  // NO WS cleanup on unmount, on purpose: the wsClient is a module-level
  // singleton that outlives this component. A cleanup calling dispose() would
  // tear down the shared connection on React StrictMode's dev double-mount,
  // leaving a disposed, terminal singleton that can never reconnect. Disposal
  // happens exactly once, explicitly, on sign-out (see Home.onSignOut).
  // connect() is idempotent, so a re-run of this effect is safe.
  useEffect(() => {
    let cancelled = false;
    void bootstrap().then((hasSession) => {
      if (cancelled) return;
      if (hasSession) {
        wsClient.connect();
        setGate("authed");
      } else {
        setGate("anonymous");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hold rendering until the bootstrap settles (avoids a <SignIn /> flash for
  // session-holders). A bare neutral line is enough for the demo.
  if (gate === "checking") {
    return <p data-testid="auth-checking">Checking session...</p>;
  }

  // Render gate: anonymous → <SignIn />, else the matched child route.
  return gate === "authed" ? <Outlet /> : <SignIn />;
}
