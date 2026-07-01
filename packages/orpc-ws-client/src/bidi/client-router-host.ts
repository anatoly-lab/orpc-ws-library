// Client-side host for server→client RPC (the `s2c` channel).
//
// Phase 4 of server→client bidirectional RPC. On the `s2c` channel the roles
// invert relative to ordinary ORPC-over-WS: the SERVER is the RPC *caller*
// (Phase 3's `createServerClientLink` in `@orpc-ws/server`) and the CLIENT —
// here — is the CALLEE. This module hosts an ORPC `RPCHandler` over the `s2c`
// `ChanneledSocket`, so a procedure the server invokes actually EXECUTES in the
// browser and its result/throw travels back over the same channel.
//
// It is the mirror image of Phase 3's `server-client-link.ts`: where that file
// builds the server's caller (`RPCLink` + typed proxy), this builds the
// client's answering handler. It DELIBERATELY mirrors the server core's c2s
// handler construction (`packages/orpc-ws-server/src/index.ts` →
// `new RPCHandler(router)` and `lifecycle/connection-handler.ts` →
// `rpcHandler.upgrade(ws, { context })`), but pointed at one channel of the
// shared socket instead of a whole `ws` connection.
//
// MIDDLEWARE ISOLATION (structural, no machinery): this is a SEPARATE
// `RPCHandler` instance from the consumer's c2s handler (the server-side one).
// The two share no router and no middleware chain, so server→client procedures
// never inherit the client→server root middleware and vice-versa. Isolation is
// a property of using two handlers — there is nothing to configure here.
//
// LIFECYCLE OWNERSHIP: this is a PURE factory. It does NOT create or dispose the
// `SocketMultiplexer` — the caller (Phase 5's connection integration) owns the
// mux and tears it down (`mux.dispose()`) on connection close. It returns
// nothing disposable, because the host owns no handle it could dispose:
// `@orpc/server/ws`'s `WsHandler.upgrade` registers a `'message'` and a
// `'close'` listener on the `s2c` `ChanneledSocket` and constructs an internal
// `ServerPeer`, but ORPC exposes NO handle to either the peer or those
// listeners (and we don't hold the listener references), so there is nothing
// for a `dispose()` to act on. Teardown is the mux owner's job — see the
// contract below.
//
// HOW IN-FLIGHT `s2c` EXECUTIONS ABORT — and the teardown CONTRACT for Phase 5.
// Abort is EVENT-DRIVEN, not dispose-driven. ORPC's internal `ServerPeer`
// aborts in-flight hosted handler executions ONLY when a real `'close'` EVENT
// reaches the channel: `@orpc/server/ws` registers
// `addEventListener('close', () => peer.close())`, and `peer.close({ abort:
// true })` aborts every pending server controller (the `signal` passed into
// each running handler fires) and closes its response/event-iterator queues.
//
// `SocketMultiplexer.dispose()` does NOT call `peer.close()`. It REMOVES the
// real `'close'` listener FIRST, then clears the channel registries (see
// `@orpc-ws/shared/socket-multiplexer.ts`). Consequences, symmetric to Phase 3:
//   - a bare `mux.dispose()` with no preceding close event leaves every
//     in-flight hosted execution UN-aborted (it runs to completion, then tries
//     to reply on a channel whose facade is now inert — the reply is dropped),
//     and
//   - a socket `'close'` arriving AFTER `dispose()` is swallowed (the listener
//     is already gone), so it cannot abort those executions either.
// CONTRACT (Phase 5 teardown): a real `'close'` event MUST reach the `s2c`
// channel BEFORE calling `mux.dispose()` — either close the underlying socket
// and let the event propagate, or dispatch a synthetic `'close'` to the channel
// — otherwise in-flight server→client executions are never aborted. This is the
// SAME close-before-dispose contract the Phase 3 caller side relies on, so a
// single correct teardown sequence settles both channels.

import { RPCHandler } from "@orpc/server/ws";
import type { AnyRouter, InferRouterInitialContext } from "@orpc/server";

import type { ChanneledSocket } from "@orpc-ws/shared";

/** Construction options for {@link createClientRouterHost}. */
export interface ClientRouterHostOptions<TRouter extends AnyRouter> {
  /**
   * The ORPC context handed to every server-invoked procedure. Inferred from
   * the router's initial context, so it is fully typed against `clientRouter`.
   * Optional: a router built off a bare `os` (no initial context) needs none —
   * it defaults to an empty context. A router whose procedures DO require an
   * initial context must supply one — and the factory's conditional rest-tuple
   * signature ENFORCES that in the types (see {@link createClientRouterHost}):
   * its non-empty-context arm intersects this options type with a REQUIRED
   * `context` field, so for a context-requiring router both omitting the options
   * arg AND passing an empty `{}` are compile errors. This field therefore stays
   * `?`-optional here while the requirement lives, ORPC-style, in the tuple.
   */
  readonly context?: InferRouterInitialContext<TRouter>;
}

/**
 * Host the client's answering handler for server→client RPC over one `s2c`
 * channel.
 *
 * @typeParam TRouter  The CLIENT's OWN router type — the procedures the client
 *   answers when the server calls them. The consumer builds it off a bare `os`
 *   (its own, separate from any c2s server router); the context generic is
 *   inferred from it so {@link ClientRouterHostOptions.context} is typed.
 *
 * @param s2cSocket  The `s2c` `ChanneledSocket` from the connection's
 *   `SocketMultiplexer` (`mux.channel(BIDI_S2C_CHANNEL)`). The factory does not
 *   create or own it; the caller (Phase 5) wires and disposes the mux.
 * @param clientRouter  The consumer's router answering server→client calls.
 * @param rest  A conditional rest-tuple holding the optional
 *   {@link ClientRouterHostOptions}. Mirroring ORPC's own `WsHandler.upgrade`
 *   (`MaybeOptionalOptions`), the options arg — and the `context` FIELD within
 *   it — is REQUIRED when the router's initial context is non-empty and OPTIONAL
 *   when it is empty. The non-empty arm intersects
 *   {@link ClientRouterHostOptions} with `{ context: InferRouterInitialContext<
 *   TRouter> }`, making `context` mandatory ONLY on that arm (a blanket
 *   `Required<…>` would wrongly force any future optional field too). The
 *   condition is resolved at the concrete call site against
 *   `InferRouterInitialContext<TRouter>` (NOT over the still-generic context at
 *   the internal `.upgrade`, which is what forced the loose internal wiring
 *   below). So for a context-requiring router BOTH omitting the options arg AND
 *   passing an empty `{}` are COMPILE errors — not a `{}`-at-runtime foot-gun.
 *
 * @returns `void`. The host owns nothing disposable — see the LIFECYCLE
 *   OWNERSHIP header for who tears down and the close-before-dispose contract.
 */
export function createClientRouterHost<TRouter extends AnyRouter>(
  s2cSocket: ChanneledSocket,
  clientRouter: TRouter,
  ...rest: Record<never, never> extends InferRouterInitialContext<TRouter>
    ? [options?: ClientRouterHostOptions<TRouter>]
    : [
        options: ClientRouterHostOptions<TRouter> & {
          readonly context: InferRouterInitialContext<TRouter>;
        },
      ]
): void {
  const options = rest[0];

  // Let `RPCHandler` infer its context from the router rather than pinning it
  // to `InferRouterInitialContext<TRouter>`. ORPC's `.upgrade` options use a
  // distributive conditional (`Record<never, never> extends T ? …`) that TS
  // cannot resolve over the still-generic `T` at this call site — pinning it
  // makes the `{ context }` argument unassignable. The PUBLIC option type below
  // stays precisely typed (`ClientRouterHostOptions<TRouter>`), so consumer DX
  // is unaffected; only this internal wiring widens.
  const handler = new RPCHandler(clientRouter);

  // THE single documented boundary cast for this wiring site (see @orpc-ws/shared
  // `socket.ts` / `channeled-socket.ts` headers). `ChanneledSocket` implements
  // `UnderlyingSocket`, which structurally covers the `addEventListener` + `send`
  // that `@orpc/server/ws`'s `WsHandler.upgrade` actually uses at runtime — a
  // NARROWER `Pick` than the c2s link needs (the handler never reads
  // `readyState` nor calls `removeEventListener`). It is NOT structurally a
  // `Pick<WebSocket, …>` because our `SocketEvent` / `addEventListener` are
  // deliberately narrower than the DOM types (no DOM-lib coupling). The cast is
  // sound because ORPC only READS `event.data` off a `'message'` event, which
  // the multiplexer provides on every dispatched frame.
  //
  // `upgrade` returns a `Promise<void>` that settles once it has registered its
  // listeners; there is nothing to await, so we `void` it (mirrors the server
  // core's `void this.rpcHandler.upgrade(...)`).
  void handler.upgrade(
    s2cSocket as unknown as Pick<WebSocket, "addEventListener" | "send">,
    { context: options?.context ?? {} },
  );
}
