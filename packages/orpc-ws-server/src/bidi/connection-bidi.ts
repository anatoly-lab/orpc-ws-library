// Per-connection server-side bidi wiring (Phase 5a integration).
//
// Given the live `ws` socket of ONE accepted connection, this builds the
// server's half of the two logical RPC channels:
//   - c2s ("client→server"): the consumer's router runs here. ORPC's
//     `RPCHandler.upgrade(...)` is pointed at the `c2sSocket` facade instead of
//     the raw `ws`, so inbound client RPC is demultiplexed off the shared wire.
//   - s2c ("server→client"): the typed server→client caller proxy (`client`),
//     built by `createServerClientLink` over the other channel.
//
// It is the SINGLE place the per-connection `SocketMultiplexer` is created AND
// disposed. The connection-handler stays thin: it calls this once, hands
// `c2sSocket` to `upgrade()`, stashes `client` on the registry entry, and calls
// `dispose()` from the socket's `'close'` handler.
//
// This module is ONLY constructed when a server opted into bidi (the
// composition root supplies a `clientContract`). A non-bidi server never calls
// it — the connection-handler upgrades the RAW `ws` directly, so the non-bidi
// path is byte-identical to the pre-bidi server (no mux, no facade, no client).
//
// ── TEARDOWN ORDERING (load-bearing — see `server-client-link.ts` header) ──
// In-flight `conn.client.x()` calls reject ONLY when a real `'close'` EVENT
// reaches the s2c channel: ORPC's websocket adapter listens for `'close'` and
// calls `peer.close()`, which rejects every pending request. `mux.dispose()`
// does the OPPOSITE — it REMOVES the real `'close'` listener FIRST. So if we
// disposed the mux before the close fan-out ran, the s2c peer would never see
// the close and every pending call would HANG FOREVER.
//
// `dispose()` is only ever invoked from the connection's `ws` `'close'` handler.
// The mux registered its OWN `'close'` listener on that SAME `ws` at
// construction, so the mux's close fan-out (→ s2c peer.close → reject) is
// dispatched in the SAME synchronous emit as the handler's close callback —
// but their relative order is the unspecified ws-listener registration order,
// which we must NOT rely on. We therefore defer `mux.dispose()` to a
// `queueMicrotask`: microtasks drain only AFTER the current synchronous task
// (the entire `'close'` emit) completes, so by the time `mux.dispose()` runs
// the s2c peer has already rejected every pending call — regardless of listener
// registration order. This makes the ordering explicit and provably correct.

import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";
import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type Logger,
  noopLogger,
  SocketMultiplexer,
  type UnderlyingSocket,
} from "@orpc-ws/shared";
import type { WebSocket } from "ws";

import { createServerClientLink } from "./server-client-link.js";

/**
 * The per-connection bidi handle the connection-handler consumes.
 *
 * @typeParam TClient  The typed server→client caller proxy
 *   (`ContractRouterClient<TClientContract>`).
 */
export interface ConnectionBidi<TClient> {
  /**
   * The socket the c2s ORPC handler upgrades over. Typed `WebSocket` so the
   * connection-handler hands it straight to `upgrade()` with no further cast;
   * it is actually the c2s `ChanneledSocket` facade (the boundary cast lives
   * here — see below).
   */
  readonly c2sSocket: WebSocket;
  /** The typed server→client caller for this connection. */
  readonly client: TClient;
  /**
   * Tear down the per-connection multiplexer. MUST be called from the
   * connection's `ws` `'close'` handler — see the TEARDOWN ORDERING note in the
   * file header. Idempotent.
   */
  dispose(): void;
}

export interface ConnectionBidiDeps {
  /** Sink for multiplexer dispatch errors (bad inbound frame / throwing listener). */
  logger?: Logger;
}

/**
 * Build the server-side bidi wiring for one connection.
 *
 * @typeParam TClientContract  The client's contract router type — drives the
 *   typing of the returned `client` proxy.
 */
export function createConnectionBidi<TClientContract extends AnyContractRouter>(
  ws: WebSocket,
  deps: ConnectionBidiDeps = {},
): ConnectionBidi<ContractRouterClient<TClientContract>> {
  const logger = deps.logger ?? noopLogger;

  // Real-socket → mux seam cast. A node `ws.WebSocket` exposes everything the
  // mux uses (addEventListener / removeEventListener / send / readyState /
  // binaryType), but its DOM-event typings are wider than @orpc-ws/shared's
  // deliberately-narrow `UnderlyingSocket`, so the assignment needs a cast. This
  // is the real-socket boundary, distinct from the ORPC-adapter casts below.
  const mux = new SocketMultiplexer(ws as unknown as UnderlyingSocket, {
    onError: (error) =>
      logger.error("orpc-ws-server: bidi multiplexer dispatch error", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });

  // c2s ORPC-adapter boundary cast: the consumer's router handler upgrades over
  // this `ChanneledSocket` facade. It implements `UnderlyingSocket` (every
  // member ORPC reads at runtime) but is not structurally a `Pick<WebSocket,…>`
  // — `as unknown as WebSocket` names the seam, symmetric to the s2c cast inside
  // `createServerClientLink`. ORPC only ever READS `event.data` off a
  // `'message'` event, which the mux supplies.
  const c2sSocket = mux.channel(BIDI_C2S_CHANNEL) as unknown as WebSocket;

  const client = createServerClientLink<TClientContract>(
    mux.channel(BIDI_S2C_CHANNEL),
  );

  return { c2sSocket, client, dispose: makeBidiDispose(mux) };
}

/**
 * Build the deferred-dispose closure for a connection's mux. See the file
 * header's TEARDOWN ORDERING note for WHY `mux.dispose()` is deferred to a
 * microtask rather than called synchronously.
 */
function makeBidiDispose(mux: SocketMultiplexer): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Defer past the synchronous `'close'` fan-out so the s2c peer rejects every
    // in-flight call BEFORE the mux removes its real close listener.
    queueMicrotask(() => mux.dispose());
  };
}
