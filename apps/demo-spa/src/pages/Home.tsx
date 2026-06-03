// Home page — the only screen with meaningful UI in the demo.
//
// Authed-only: this page mounts solely when a token is present, because the
// signed-out gate now lives upstream in AppLayout's <RequireAuth> (which shows
// <SignIn /> to anonymous visitors). Home therefore renders just the signed-in
// view: decoded user info, connection state, ping/echo/getUser buttons, live
// tick display, sign-out.
//
// Every interactive element carries a `data-testid` for Playwright.
// Selectors are intentionally simple — no class chains, no nth-child.

import { useState, type ReactElement } from "react";

import { useConnectionState, useWsSubscription } from "@repo/orpc-ws-oidc-react";

import { authClient, wsClient } from "../lib/ws-client.js";
import styles from "./styles.module.css";

interface PingResult {
  pong: true;
  at: number;
}

interface EchoResult {
  echoed: string;
  user: string;
}

interface GetUserResult {
  sub: string;
  email?: string;
  name?: string;
}

export function Home(): ReactElement {
  const connection = useConnectionState(wsClient);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [echoResult, setEchoResult] = useState<EchoResult | null>(null);
  const [getUserResult, setGetUserResult] = useState<GetUserResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // NOTE: the "if logged in, connect the WS" guard lives in AppLayout now
  // (the shared layout route), so it is not repeated here. Home only consumes
  // the connection — it never initiates it.

  // Auto-subscribe to the server-pushed `tick` stream. The hook owns all the
  // plumbing the page used to hand-roll: connected-gating, AbortController
  // teardown, abort suppression, re-subscribe on reconnect, and error
  // surfacing. `data` is the latest `TickEvent` (or null before the first).
  const { data: lastTick } = useWsSubscription(wsClient, (rpc, signal) =>
    rpc.tick(undefined, { signal }),
  );

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

  const onGetUser = async (): Promise<void> => {
    setActionError(null);
    try {
      const r = await wsClient.rpc.getUser();
      setGetUserResult(r);
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
    <main className={styles.container}>
      <h1>orpc-ws-library demo</h1>
      <section>
        <h2>Signed in</h2>
        <p data-testid="user-email">{user?.email ?? user?.sub ?? "?"}</p>
      </section>

      <section>
        <h2>Connection</h2>
        <p data-testid="connection-status">{connection.status}</p>
      </section>

      <section className={styles.buttonRow}>
        <button data-testid="ping-button" onClick={() => void onPing()} className={styles.button}>
          Ping
        </button>
        <button data-testid="echo-button" onClick={() => void onEcho()} className={styles.button}>
          Echo &quot;hello&quot;
        </button>
        <button data-testid="get-user-button" onClick={() => void onGetUser()} className={styles.button}>
          Get user
        </button>
        <button data-testid="signout-button" onClick={onSignOut} className={styles.button}>
          Sign out
        </button>
      </section>

      <section>
        <h2>Live tick</h2>
        <p data-testid="last-tick">
          {lastTick
            ? `tick #${lastTick.tick} at ${new Date(lastTick.at).toISOString()}`
            : "waiting..."}
        </p>
      </section>

      {pingResult && (
        <pre data-testid="ping-result">{JSON.stringify(pingResult, null, 2)}</pre>
      )}
      {echoResult && (
        <pre data-testid="echo-result">{JSON.stringify(echoResult, null, 2)}</pre>
      )}
      {getUserResult && (
        <pre data-testid="get-user-result">{JSON.stringify(getUserResult, null, 2)}</pre>
      )}
      {actionError && (
        <pre data-testid="action-error" className={styles.error}>{actionError}</pre>
      )}
    </main>
  );
}
