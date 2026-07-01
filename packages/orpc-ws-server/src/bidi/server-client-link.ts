// Server-side caller for server→client RPC (the `s2c` channel).
//
// Phase 3 of server→client bidirectional RPC. On the `s2c` channel the roles
// invert relative to ordinary ORPC-over-WS: the SERVER is the RPC *caller* and
// the CLIENT (Phase 4) hosts the answering handler. This module builds the
// server's caller side — an ORPC `RPCLink` over one channel of the shared
// socket, wrapped in the typed `ContractRouterClient` proxy — and nothing more.
//
// It DELIBERATELY mirrors the client core's c2s wiring
// (`packages/orpc-ws-client/src/client/link-factory.ts` +
// `orpc-client.ts`), but in the opposite direction and generic over the client
// contract:
//   - LinkFactory builds `new RPCLink({ websocket })` against the real socket;
//     here the "socket" is a per-channel `ChanneledSocket` facade.
//   - createOrpcClientProxy wraps the link in
//     `createORPCClient<ContractRouterClient<TContract>>(...)`; we do the same.
//
// Differences from the client core (by design for this phase):
//   1. NO lazy-link Proxy. The client core defers link construction until the
//      WS handshake completes (the client object is handed to React contexts
//      before the socket is open). Here the factory is called by Phase 5's
//      connection integration, which already holds a live, multiplexed socket —
//      so there is nothing to defer, and a direct `RPCLink` is simpler/clearer.
//   2. NO partysocket-wrapper indirection. That note in LinkFactory exists
//      because partysocket swaps its inner native socket on internal reconnect;
//      a `ChanneledSocket` is a stable view over one underlying socket and has
//      no such swap, so handing it straight to `RPCLink` is correct.
//
// LIFECYCLE OWNERSHIP: this is a PURE factory. It does NOT create or dispose the
// `SocketMultiplexer` — the caller (Phase 5's connection integration) owns the
// mux and tears it down (`mux.dispose()`) on connection close. The link holds no
// resources of its own beyond the channel listeners the `RPCLink` registered, so
// no separate disposer is returned.
//
// HOW IN-FLIGHT `s2c` CALLS REJECT — and the teardown CONTRACT for Phase 5.
// Rejection is EVENT-DRIVEN, not dispose-driven. ORPC's internal `ClientPeer`
// rejects pending s2c requests ONLY when a real `'close'` EVENT reaches the
// channel: the `@orpc/client/websocket` adapter registers
// `addEventListener('close', () => peer.close())`, and `peer.close()` closes the
// response queue (rejecting every awaiting pull with an `AbortError`). ORPC
// exposes NO handle to that peer, so this factory CANNOT self-reject — it can
// only let the close event propagate.
//
// `SocketMultiplexer.dispose()` does NOT call `peer.close()`. It REMOVES the real
// `'close'` listener FIRST, then clears the channel registries. Consequences:
//   - a bare `mux.dispose()` with no preceding close event leaves every in-flight
//     s2c request HUNG FOREVER (its response-queue pull never settles), and
//   - a socket `'close'` arriving AFTER `dispose()` is swallowed (the listener is
//     already gone), so it cannot rescue those hung requests either.
// CONTRACT (Phase 5 teardown): a real `'close'` event MUST reach the `s2c`
// channel BEFORE calling `mux.dispose()` — either close the underlying socket and
// let the event propagate, or dispatch a synthetic `'close'` to the channel —
// otherwise pending s2c calls hang. See the matching test.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";

import type { ChanneledSocket } from "@orpc-ws/shared";

/**
 * Build the typed server→client caller over one `s2c` channel.
 *
 * @typeParam TClientContract  The CLIENT's contract router type — the set of
 *   procedures the client (Phase 4) will answer. The returned proxy carries it
 *   end-to-end so `conn.client.someProc(input)` is fully typed against it.
 *
 * @param s2cSocket  The `s2c` `ChanneledSocket` from the connection's
 *   `SocketMultiplexer` (`mux.channel(BIDI_S2C_CHANNEL)`). The factory does
 *   not create or own it; the caller wires and disposes the mux.
 *
 * @returns A `ContractRouterClient<TClientContract>` — the typed proxy the
 *   server calls the client through.
 *
 * The link's context generic is `Record<string, never>` to mirror the client
 * core's LinkFactory; the library does not currently surface ORPC client-context
 * typing on either direction. If/when it does, both call sites widen together.
 */
export function createServerClientLink<
  TClientContract extends AnyContractRouter,
>(s2cSocket: ChanneledSocket): ContractRouterClient<TClientContract> {
  // THE single documented boundary cast for this wiring site (see
  // @orpc-ws/shared `socket.ts` header). `ChanneledSocket` implements
  // `UnderlyingSocket`, which covers every member ORPC's
  // `Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'send' |
  // 'readyState'>` actually uses at runtime, but it is NOT structurally a
  // `Pick<WebSocket, …>` — @orpc-ws/shared's `SocketEvent` / `addEventListener`
  // are deliberately narrower than the DOM types (no DOM lib dependency). The
  // cast is sound because ORPC only ever READS `event.data` off a `'message'`
  // event, which the multiplexer provides on every dispatched frame.
  const link = new RPCLink<Record<string, never>>({
    websocket: s2cSocket as unknown as Pick<
      WebSocket,
      "addEventListener" | "removeEventListener" | "send" | "readyState"
    >,
  });

  return createORPCClient<ContractRouterClient<TClientContract>>(link);
}
