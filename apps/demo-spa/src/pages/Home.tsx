// Home page — the only screen with meaningful UI in the demo.
//
// Two modes:
//   - signed out: shows the "Sign in with Keycloak" button
//   - signed in:  shows decoded user info, connection state, ping/echo
//                 buttons, sign-out
//
// Every interactive element carries a `data-testid` for Playwright.
// Selectors are intentionally simple — no class chains, no nth-child.

import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { useConnectionState } from "@repo/orpc-ws-client/react";

import { authClient } from "../lib/auth.js";
import { wsClient } from "../lib/ws-client.js";

interface PingResult {
  pong: true;
  at: number;
}

interface EchoResult {
  echoed: string;
  user: string;
}

export function Home(): ReactElement {
  const loggedIn = authClient.hasToken();
  const connection = useConnectionState(wsClient);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [echoResult, setEchoResult] = useState<EchoResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-connect on mount when the user is already signed in.
  useEffect(() => {
    if (loggedIn) wsClient.connect();
    // No cleanup: the singleton survives across renders; dispose only
    // happens on explicit logout.
  }, [loggedIn]);

  if (!loggedIn) {
    return (
      <main style={containerStyle}>
        <h1>orpc-ws-library demo</h1>
        <p>You are not signed in.</p>
        <button
          data-testid="signin-button"
          onClick={() => {
            // redirectToLogin awaits OIDC discovery before navigating; we
            // discard the returned promise because the page navigates
            // before it settles in production.
            void authClient.redirectToLogin();
          }}
          style={buttonStyle}
        >
          Sign in with Keycloak
        </button>
      </main>
    );
  }

  // `getUser()` parses claims from the id_token (NOT the access token like the
  // old `decodeAccessTokenForDisplay`). With the `email` scope the id_token
  // includes the email claim; the sub/"?" fallbacks preserve the old
  // never-renders-empty guarantee for the user-email testid.
  const user = authClient.getUser();

  const onPing = async (): Promise<void> => {
    setActionError(null);
    try {
      const r = await wsClient.rpc.ping();
      setPingResult(r);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const onEcho = async (): Promise<void> => {
    setActionError(null);
    try {
      const r = await wsClient.rpc.echo({ message: "hello" });
      setEchoResult(r);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSignOut = (): void => {
    // Dispose the WS BEFORE the page navigates to Keycloak's end-session
    // endpoint — gets us a clean close frame instead of an abrupt teardown
    // when the page unloads. logout() is async (awaits discovery on first
    // call) but we don't need to wait: discovery is normally pre-warmed
    // by the connect flow, so the await resolves synchronously.
    wsClient.dispose();
    void authClient.logout();
  };

  return (
    <main style={containerStyle}>
      <h1>orpc-ws-library demo</h1>
      <section>
        <h2>Signed in</h2>
        <p data-testid="user-email">{user?.email ?? user?.sub ?? "?"}</p>
      </section>

      <section>
        <h2>Connection</h2>
        <p data-testid="connection-status">{connection.status}</p>
      </section>

      <section style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button data-testid="ping-button" onClick={() => void onPing()} style={buttonStyle}>
          Ping
        </button>
        <button data-testid="echo-button" onClick={() => void onEcho()} style={buttonStyle}>
          Echo &quot;hello&quot;
        </button>
        <button data-testid="signout-button" onClick={onSignOut} style={buttonStyle}>
          Sign out
        </button>
      </section>

      {pingResult && (
        <pre data-testid="ping-result">{JSON.stringify(pingResult, null, 2)}</pre>
      )}
      {echoResult && (
        <pre data-testid="echo-result">{JSON.stringify(echoResult, null, 2)}</pre>
      )}
      {actionError && (
        <pre data-testid="action-error" style={{ color: "red" }}>{actionError}</pre>
      )}
    </main>
  );
}

const containerStyle: CSSProperties = {
  maxWidth: 600,
  margin: "2rem auto",
  padding: "1rem",
  fontFamily: "system-ui, sans-serif",
};

const buttonStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  fontSize: "1rem",
  cursor: "pointer",
};
