// Shared layout route for the signed-in area. Owns TWO responsibilities:
//
//   1. The /auth/me gate — "ask the server who we are" — so every child route
//      inherits the answer without repeating the effect.
//   2. The render gate — visitors with no server session see <SignIn />,
//      session-holders see the matched child wrapped in <OrpcWs>, which owns
//      the WS connection (connect on mount / dispose on unmount) for the
//      signed-in subtree. The WS therefore connects only once we're past the gate.
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
// mounted across navigations between sibling signed-in pages. The <OrpcWs>
// wrapper therefore mounts once on first entry into the signed-in area and
// survives intra-area navigation — one stable connection, no connect churn per page.

import { useEffect, useState, type ReactElement } from "react";

import { Outlet } from "react-router";

import { consoleLogger } from "@orpc-ws/client";
import { OrpcWs } from "@orpc-ws/react";

import { me, type Identity } from "./lib/auth.js";
import { config } from "./lib/config.js";
import { SignIn } from "./pages/SignIn.js";

/** Context the layout hands to the matched child via <Outlet />. */
export interface HomeOutletContext {
  identity: Identity;
}

// Three-state machine for the /auth/me result: we must not render the gate
// until the async call settles, otherwise a session-holder would flash
// <SignIn /> on every reload.
//   - checking : still waiting on /auth/me (we don't know yet)
//   - signedIn : a session exists (we have the identity) → render the app
//   - signedOut: no session (not logged in) → render <SignIn />
type AuthGate =
  | { kind: "checking" }
  | { kind: "signedIn"; identity: Identity }
  | { kind: "signedOut" };

export function AppLayout(): ReactElement {
  const [gate, setGate] = useState<AuthGate>({ kind: "checking" });

  // Check the session once on mount via GET /auth/me. An identity → render the
  // signed-in subtree (which owns the WS connection, see below); null → <SignIn />.
  //
  // This effect no longer touches the WS: the connection is owned by <OrpcWs>,
  // mounted only inside the `signedIn` branch, so it connects once we're past the
  // gate and disposes on unmount — StrictMode-safe (see <OrpcWs>'s own deferred
  // dispose). The `me()` call merely decides which branch to render.
  useEffect(() => {
    let cancelled = false;
    void me().then((identity) => {
      if (cancelled) return;
      if (identity) {
        setGate({ kind: "signedIn", identity });
      } else {
        setGate({ kind: "signedOut" });
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

  // Render gate: signed out → <SignIn />, else the matched child with the
  // identity in Outlet context.
  if (gate.kind === "signedOut") {
    return <SignIn />;
  }

  // Signed-in area. <OrpcWs> constructs the cookie-auth client from these props
  // (NO `tokenProvider` — the httpOnly `sid` cookie rides the WS handshake
  // automatically), connects on mount and disposes on unmount. Mounting it here,
  // BELOW the gate, ties the connection's lifetime to "signed in": it begins
  // only after /auth/me confirms a session. Children below it reach the client
  // via `useOrpcWs()` / `useConnectionState()`. No `fallback` — Home renders
  // immediately and shows the live `connection.status` as it reaches connected.
  const context: HomeOutletContext = { identity: gate.identity };
  return (
    <OrpcWs
      url={config.WS_URL}
      // Console bridge so the library's events are visible in devtools. In
      // production an SPA would swap this for a real telemetry sink (Sentry,
      // Datadog Browser, etc.); for the demo, raw console is enough.
      onEvent={(e) => console.log("[orpc-ws event]", e)}
      logger={consoleLogger("orpc-ws")}
    >
      <Outlet context={context} />
    </OrpcWs>
  );
}
