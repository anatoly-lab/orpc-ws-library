// Home page — the only screen with meaningful UI in the demo.
//
// Authed-only: this page mounts solely when a server session exists, because
// the signed-out gate lives upstream in AppLayout (which shows <SignIn /> when
// the bootstrap finds no session). Home renders just the signed-in view:
// identity, connection state, ping/echo/getUser buttons, live tick, image
// upload, sign-out.
//
// Identity DIFFERENCE from the PKCE demo: there is no client-side token to
// decode here — the browser holds only an opaque access token. So the "who am
// I" line comes from the `getUser()` WS PROCEDURE (server round-trip) rather
// than from a library `authClient.getUser()` claim parse. It is fetched once on
// connect and rendered into the same `user-email` testid the PKCE demo uses.
//
// Every interactive element carries a `data-testid` for Playwright. Selectors
// are intentionally simple — no class chains, no nth-child.

import {
  useEffect,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";

import { useConnectionState, useWsSubscription } from "@orpc-ws/react";

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

// The typed `rpc.*` proxy returns typed values, but `wsClient.upload()`
// resolves to `{ ok: true; response: unknown }` — the procedure's output is
// not threaded through the upload seam. So we mirror the contract's
// `uploadImage` output here and cast `response` to it.
interface UploadResponse {
  ok: true;
  storedAs: string;
  size: number;
}

export function Home(): ReactElement {
  const connection = useConnectionState(wsClient);
  const [identity, setIdentity] = useState<GetUserResult | null>(null);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [echoResult, setEchoResult] = useState<EchoResult | null>(null);
  const [getUserResult, setGetUserResult] = useState<GetUserResult | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [uploading, setUploading] = useState(false);
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

  // Identity via the WS procedure (NOT a decoded token — the browser only holds
  // an opaque access token here). Fetched once the connection is up; re-fetched
  // if the connection drops and recovers. Failures are swallowed: the identity
  // line falls back to "?" rather than surfacing a transient error.
  useEffect(() => {
    if (connection.status !== "connected") return;
    let cancelled = false;
    void wsClient.rpc
      .getUser()
      .then((u) => {
        if (!cancelled) setIdentity(u);
      })
      .catch(() => {
        /* leave identity as-is; the "?" fallback covers the empty case */
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status]);

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

  // Upload over the library's HTTP transport (NOT the WS). `upload` is only
  // present when `uploads` was configured on the client — it is here (see
  // ws-client.ts), so the non-null assertion is safe. `procedure` is the
  // tuple path into the contract; `meta` carries the optional `name` field
  // alongside the file. The resolved `response` is `unknown` (see
  // UploadResponse) so we cast it before rendering.
  const onUpload = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again re-fires `onChange`.
    e.target.value = "";
    if (!file) return;
    setActionError(null);
    setUploadResult(null);
    setUploading(true);
    try {
      const res = await wsClient.upload!(file, {
        procedure: ["uploadImage"],
        meta: { name: file.name },
      });
      setUploadResult(res.response as UploadResponse);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
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
      <h1>orpc-ws-library demo (backend-token)</h1>
      <section>
        <h2>Signed in</h2>
        <p data-testid="user-email">
          {identity?.email ?? identity?.sub ?? "?"}
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

      <section>
        <h2>Image upload</h2>
        <input
          data-testid="upload-input"
          type="file"
          accept="image/*"
          disabled={uploading}
          onChange={(e) => void onUpload(e)}
        />
        {uploading && <p data-testid="upload-status">uploading...</p>}
        {uploadResult && (
          <p data-testid="upload-result">
            stored as {uploadResult.storedAs} ({uploadResult.size} bytes)
          </p>
        )}
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
