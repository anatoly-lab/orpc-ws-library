// Per-client browser-side bidi wiring (Phase 5b integration).
//
// The CLIENT mirror of the server's `bidi/connection-bidi.ts` (Phase 5a). Given
// the partysocket `ReconnectingWebSocket` wrapper of the CURRENT connection it
// builds the client's half of the two logical RPC channels over ONE real socket:
//   - c2s ("client→server"): the consumer's typed RPC still rides here. The c2s
//     `ChanneledSocket` facade is handed to the c2s `RPCLink` (via the
//     composition root's `LinkFactory`) instead of the raw wrapper, so outbound
//     client RPC — AND the stealth heartbeat — is demultiplexed onto the shared
//     wire. (`c2sLinkSocket()` is what the `LinkFactory.getWebSocket` thunk
//     resolves when bidi is on.)
//   - s2c ("server→client"): the consumer's `clientRouter` is HOSTED here (Phase
//     4's `createClientRouterHost`), so a procedure the server invokes actually
//     executes in the browser and its result/throw travels back over the wire.
//
// This module is ONLY constructed when the consumer opted into bidi (passed a
// `clientRouter`). A non-bidi client never builds it — the composition root
// points the `LinkFactory` at the RAW wrapper, so the non-bidi path is
// byte-identical to the pre-bidi client (no mux, no facade, no host, heartbeat
// untouched).
//
// ── WRAPPER LIFECYCLE (why this is a re-attachable coordinator, not a one-shot)
// The partysocket wrapper is NOT stable for the life of the client. partysocket
// reconnects its INNER native socket transparently under the SAME wrapper
// (handshake hiccup / idle drop) — those need no rebuild; the mux survives, its
// listeners stay valid, and the inner drop's `'close'` fans out to both channels
// (aborting in-flight s2c executions / rejecting pending c2s calls) before the
// inner socket reopens. But a LIBRARY-DRIVEN reconnect (token refresh, sleep-wake,
// heartbeat-timeout — see `reconnect/token-refresh-handler.ts` `swapSocket`, and
// the first `lifecycle/client-lifecycle.ts` `connect`) creates a BRAND-NEW wrapper
// and `holder.set`s it. The mux is bound to a wrapper, so each new wrapper needs a
// FRESH mux + host, and the previous one must be torn down. The composition root
// drives that by calling `attach(ws)` at the single chokepoint every new wrapper
// is born from (`WebSocketFactory.create`), and `dispose()` on `client.dispose()`.
//
// ── TEARDOWN ORDERING (load-bearing — see `client-router-host.ts` header) ──
// In-flight hosted s2c executions abort (and pending c2s calls reject) ONLY when a
// real `'close'` EVENT reaches the channels: ORPC's ws adapters listen for
// `'close'` and call `peer.close()`. `SocketMultiplexer.dispose()` does the
// OPPOSITE — it REMOVES the real `'close'` listener FIRST. So a bare
// `mux.dispose()` with no preceding close leaves hosted executions un-aborted and
// pending calls hung.
//
// Both teardown triggers close the wrapper (`ws.close()`) BEFORE the bidi handle
// is disposed: the swap closes the OLD wrapper before `WebSocketFactory.create`
// builds the new one (→ `attach` → `disposeCurrent`); `client.dispose()` closes
// the wrapper inside `ClientLifecycle.dispose()` before the composition root calls
// `bidi.dispose()`. partysocket 1.3.0 dispatches `'close'` SYNCHRONOUSLY from
// `close()` to BOTH property handlers and `addEventListener` listeners (the mux
// uses the latter), so the close fan-out runs in that synchronous task. We still
// defer `mux.dispose()` to a `queueMicrotask` (symmetric to the server's
// `connection-bidi.ts`): microtasks drain only AFTER the current synchronous task,
// so the channels' peers have already settled every pending call by the time the
// mux removes its real listeners — making the ordering explicit and robust
// regardless of when the close fan-out ran relative to the dispose trigger.

import type ReconnectingWebSocket from "partysocket/ws";
import type { AnyRouter } from "@orpc/server";
import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type ChanneledSocket,
  type Logger,
  noopLogger,
  SocketMultiplexer,
  type UnderlyingSocket,
} from "@orpc-ws/shared";

import {
  createClientRouterHost,
  type ClientRouterHostOptions,
} from "./client-router-host.js";

/**
 * The per-wrapper bidi handle. One exists per live partysocket wrapper; a new
 * one is built on every wrapper swap and the previous disposed.
 */
interface ClientBidiHandle {
  /**
   * The c2s `ChanneledSocket` facade the c2s `RPCLink` binds to, typed as the
   * `ReconnectingWebSocket` the `LinkFactory`'s thunk yields (the documented
   * bidi boundary cast — see `attach`). The `LinkFactory`'s own
   * `as unknown as WebSocket` is the ORPC-adapter cast for the `RPCLink`.
   */
  readonly c2sSocket: ReconnectingWebSocket;
  /**
   * Tear down this wrapper's multiplexer. Honors the close-before-dispose
   * contract (deferred `mux.dispose()` — see file header). Idempotent.
   */
  dispose(): void;
}

/**
 * The per-client bidi coordinator the composition root drives. Owns at most one
 * live {@link ClientBidiHandle} at a time; `attach` rolls it over on each
 * wrapper swap, `dispose` retires it on client teardown.
 */
export interface ClientBidi {
  /**
   * Build a fresh mux + s2c host over `ws`, disposing any previous handle
   * (close-before-dispose). Called from the `WebSocketFactory.create` chokepoint
   * — the one place every new wrapper (first connect AND every swap) is born.
   */
  attach(ws: ReconnectingWebSocket): void;
  /**
   * The current c2s facade for the c2s `RPCLink`, or `null` before the first
   * `attach`. Wired as the `LinkFactory`'s `getWebSocket` thunk when bidi is on,
   * so a rebuilt mux is picked up on the next (post-swap) link rebuild.
   */
  c2sLinkSocket(): ReconnectingWebSocket | null;
  /**
   * Dispose the current handle (close-before-dispose). Called from the wrapped
   * `client.dispose()`. Idempotent.
   */
  dispose(): void;
}

/**
 * Build the per-client bidi coordinator.
 *
 * @typeParam TRouter  The CLIENT's OWN router type — the procedures the client
 *   answers when the server calls them (built off a bare `os`, separate from any
 *   c2s server router). The context generic is inferred from it.
 *
 * @param clientRouter  The consumer's router answering server→client calls.
 * @param logger  Client logger; wired as the mux's `onError` sink (NOT the
 *   rethrow default — a throwing inbound dispatch must not crash the page).
 * @param options  The Phase-4 host options (`{ context }`). The
 *   conditional-rest CONTRACT (context REQUIRED iff the router needs one) is
 *   enforced upstream at the `createOrpcWsClient` call site against the concrete
 *   `TRouter`; here `TRouter` is generic, so — like the Phase-4 host's own
 *   internal `.upgrade` widening — we forward a plain optional options arg and
 *   the host defaults a missing context to `{}`.
 */
export function createClientBidi<TRouter extends AnyRouter>(
  clientRouter: TRouter,
  logger: Logger = noopLogger,
  options?: ClientRouterHostOptions<TRouter>,
): ClientBidi {
  let current: ClientBidiHandle | null = null;

  const disposeCurrent = (): void => {
    if (current) {
      current.dispose();
      current = null;
    }
  };

  const attach = (ws: ReconnectingWebSocket): void => {
    // Roll over: the previous wrapper was already closed by the caller (the swap
    // closes the OLD wrapper before this `create`; first connect has no
    // previous), so its close fan-out has run — dispose retires the spent mux.
    disposeCurrent();

    // Real-socket → mux seam cast. partysocket's `ReconnectingWebSocket` exposes
    // everything the mux uses (addEventListener / removeEventListener / send /
    // readyState / binaryType), but its types don't formally implement our
    // deliberately-narrow `UnderlyingSocket`, so the assignment needs a cast.
    // This is the real-socket boundary, distinct from the ORPC-adapter cast
    // below (mirrors the server's `connection-bidi.ts`).
    const mux = new SocketMultiplexer(ws as unknown as UnderlyingSocket, {
      onError: (error) =>
        logger.error("orpc-ws-client: bidi multiplexer dispatch error", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });

    // c2s boundary cast: the c2s `ChanneledSocket` facade, typed as the
    // `ReconnectingWebSocket` the `LinkFactory`'s `getWebSocket` thunk yields.
    // The facade implements `UnderlyingSocket` (every member the c2s `RPCLink`
    // reads at runtime) but is not structurally a `ReconnectingWebSocket`; the
    // `LinkFactory` then applies its own (pre-existing, path-shared)
    // `as unknown as WebSocket` at the actual `RPCLink` adapter site. Symmetric
    // to the server's `c2sSocket = mux.channel(C2S) as unknown as WebSocket`.
    const c2sSocket = mux.channel(
      BIDI_C2S_CHANNEL,
    ) as unknown as ReconnectingWebSocket;

    // Host the consumer's router on the s2c channel (Phase 4). Over the generic
    // `TRouter` the host's conditional-rest signature cannot be resolved (it is
    // resolved only at a concrete call site), so we forward through a plain
    // `(socket, router, options?)` view of it — the host widens a missing context
    // to `{}` internally anyway, exactly as its own `.upgrade` call does. This is
    // the single documented internal type-bridge; the context CONTRACT (required
    // iff the router needs one) is enforced upstream at the concrete
    // `createOrpcWsClient` call site, not here.
    const hostRouter = createClientRouterHost as (
      s2cSocket: ChanneledSocket,
      router: TRouter,
      options?: ClientRouterHostOptions<TRouter>,
    ) => void;
    hostRouter(mux.channel(BIDI_S2C_CHANNEL), clientRouter, options);

    current = { c2sSocket, dispose: makeBidiDispose(mux) };
  };

  return {
    attach,
    c2sLinkSocket: () => current?.c2sSocket ?? null,
    dispose: disposeCurrent,
  };
}

/**
 * Build the deferred-dispose closure for a wrapper's mux. See the file header's
 * TEARDOWN ORDERING note for WHY `mux.dispose()` is deferred to a microtask
 * rather than called synchronously. Symmetric to the server's
 * `connection-bidi.ts` `makeBidiDispose`.
 */
function makeBidiDispose(mux: SocketMultiplexer): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Defer past the synchronous `'close'` fan-out so the channels' peers settle
    // every pending call BEFORE the mux removes its real close listener.
    queueMicrotask(() => mux.dispose());
  };
}
