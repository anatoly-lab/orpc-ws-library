// Home page — the only screen in the AUTHLESS demo.
//
// Shows the three library capabilities with zero auth:
//   - connection state via `useConnectionState`,
//   - an `echo` request/response RPC behind a button,
//   - an `increment` RPC that mutates shared server state,
//   - the live `ticks()` AsyncIterable subscription via `useWsSubscription`.
//
// There is NO sign-in, NO user identity, NO upload — authless carries no
// credential and the server has no upload route.
//
// Every interactive element carries a `data-testid` for potential e2e use.
// Selectors are intentionally simple — no class chains, no nth-child.

import { useState, type ReactElement } from "react";

import {
  useConnectionState,
  useOrpcWs,
  useWsSubscription,
} from "@orpc-ws/react";

import type { AppContract } from "@demo/authless-contract";
import styles from "./styles.module.css";

interface EchoResult {
  message: string;
  at: number;
}

export function Home(): ReactElement {
  // The client is provided by the `<OrpcWs>` ancestor in App.tsx (no more
  // module-singleton import). `useOrpcWs<AppContract>()` re-asserts the
  // CLIENT→SERVER contract at this read site so `wsClient.rpc` stays typed.
  const wsClient = useOrpcWs<AppContract>();
  const connection = useConnectionState(wsClient);
  const [echoResult, setEchoResult] = useState<EchoResult | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-subscribe to the server-pushed `ticks` stream. The hook owns all the
  // plumbing: connected-gating, AbortController teardown, abort suppression,
  // re-subscribe on reconnect, and error surfacing. `data` is the latest
  // `TickEvent` (or null before the first).
  const { data: lastTick } = useWsSubscription(wsClient, (rpc, signal) =>
    rpc.ticks(undefined, { signal }),
  );

  const onEcho = async (): Promise<void> => {
    setActionError(null);
    try {
      const r = await wsClient.rpc.echo({ message: "hello" });
      setEchoResult(r);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const onIncrement = async (): Promise<void> => {
    setActionError(null);
    try {
      const r = await wsClient.rpc.increment();
      setCount(r.count);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className={styles.container}>
      <h1>orpc-ws-library demo (authless)</h1>
      <p>No sign-in — this server accepts every connection.</p>

      <section>
        <h2>Connection</h2>
        <p data-testid="connection-status">{connection.status}</p>
      </section>

      <section className={styles.buttonRow}>
        <button data-testid="echo-button" onClick={() => void onEcho()} className={styles.button}>
          Echo &quot;hello&quot;
        </button>
        <button data-testid="increment-button" onClick={() => void onIncrement()} className={styles.button}>
          Increment
        </button>
      </section>

      <section>
        <h2>Counter</h2>
        <p data-testid="counter-value">{count ?? "—"}</p>
      </section>

      <section>
        <h2>Live ticks</h2>
        <p data-testid="last-tick">
          {lastTick
            ? `tick #${lastTick.tick} at ${new Date(lastTick.at).toISOString()}`
            : "waiting..."}
        </p>
      </section>

      {echoResult && (
        <pre data-testid="echo-result">{JSON.stringify(echoResult, null, 2)}</pre>
      )}
      {actionError && (
        <pre data-testid="action-error" className={styles.error}>{actionError}</pre>
      )}
    </main>
  );
}
