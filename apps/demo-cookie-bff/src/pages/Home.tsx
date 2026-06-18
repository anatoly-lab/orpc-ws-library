// Home page — the only screen with meaningful UI in the demo.
//
// Authed-only: this page mounts solely when a server session exists, because
// the signed-out gate lives upstream in AppLayout (which shows <SignIn /> when
// GET /auth/me finds no session). Home renders just the signed-in view:
// identity, connection state, ping/echo/getUser buttons, live tick, sign-out.
//
// DIFFERENCES from the PKCE demo:
//   - NO image upload section. The cookie-bff demo server has no upload route
//     configured, and the wsClient here has no `uploads` config, so `upload` is
//     not present. Omitting the section keeps the UI honest.
//   - Identity comes from the `/auth/me` HTTP call (cookie-authed), surfaced via
//     the layout's <Outlet /> context — not from a decoded token (the browser
//     holds none) and not from a `getUser()` round-trip on mount. The `getUser`
//     WS procedure is still wired to its button so the e2e suite can prove the
//     server propagates the cookie-derived principal into the handler.
//
// Every interactive element carries a `data-testid` for Playwright. Selectors
// are intentionally simple — no class chains, no nth-child.

import { useState, type ReactElement } from "react";

import { useOutletContext } from "react-router";

import { useConnectionState, useWsSubscription } from "@orpc-ws/react";

import type { HomeOutletContext } from "../AppLayout.js";
import { logout } from "../lib/auth.js";
import { wsClient } from "../lib/ws-client.js";
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
  // Identity resolved by the layout's /auth/me call (cookie-authed). Rendered
  // into the `user-email` testid — same shape as the PKCE demo, different
  // source (HTTP session instead of a decoded id_token).
  const { identity } = useOutletContext<HomeOutletContext>();

  const connection = useConnectionState(wsClient);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [echoResult, setEchoResult] = useState<EchoResult | null>(null);
  const [getUserResult, setGetUserResult] = useState<GetUserResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // NOTE: the connect guard lives in AppLayout. Home only consumes the
  // connection — it never initiates it.

  // Auto-subscribe to the server-pushed `tick` stream. The hook owns all the
  // plumbing the page used to hand-roll: connected-gating, AbortController
  // teardown, abort suppression, re-subscribe on reconnect, and error
  // surfacing. `data` is the latest `TickEvent` (or null before the first).
  const { data: lastTick } = useWsSubscription(wsClient, (rpc, signal) =>
    rpc.tick(undefined, { signal }),
  );

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
    // Dispose the WS BEFORE the page navigates to the server's logout endpoint
    // — gets us a clean close frame instead of an abrupt teardown when the page
    // unloads. logout() is async (it POSTs /auth/logout then redirects to the
    // IdP end-session URL) but we don't need to await it from here.
    wsClient.dispose();
    void logout();
  };

  return (
    <main className={styles.container}>
      <h1>orpc-ws-library demo (cookie-bff)</h1>
      <section>
        <h2>Signed in</h2>
        <p data-testid="user-email">
          {identity.email ?? identity.sub ?? "?"}
        </p>
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
