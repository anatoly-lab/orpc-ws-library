// Per-connection identity stamp on the ORPC context.
//
// The stealth heartbeat procedure (`__orpc_ws_lib__.heartbeat`) needs to
// know WHICH connection is subscribing so it can bound live subscriptions
// to one per connection (last-wins — see `heartbeat/publisher.ts`). The
// only per-connection data a procedure handler receives is its ORPC
// context, so the connection handler stamps the connection's raw `ws`
// onto the context it hands to `rpcHandler.upgrade()` — under a
// library-reserved SYMBOL key, for three load-bearing reasons:
//
//   1. INVISIBLE to consumers. Symbol keys don't appear in
//      `Object.keys()`, `JSON.stringify()`, or the consumer's typed
//      context (their `TContract` context types are string-keyed), so
//      the authless "empty `{}` context" contract and the authed
//      `{ user, token }` contract are both preserved as observed by
//      consumer procedures.
//   2. SURVIVES ORPC's context plumbing. With no middleware the handler
//      receives the upgrade context by reference; with middleware ORPC
//      merges via object spread (`mergeCurrentContext` in
//      @orpc/server), and spread copies own enumerable symbol-keyed
//      properties — so the stamp arrives either way.
//   3. COLLISION-FREE. A symbol can't clash with any consumer context
//      key, unlike a stringly `__orpc_ws_lib__` property.
//
// The HTTP upload transport builds its own context (`upload/http-handler`)
// and does NOT stamp it — `getConnectionWs` returns `undefined` there and
// the heartbeat publisher simply skips per-connection tracking (each HTTP
// request is its own short-lived exchange; there is no WS connection to
// key on).

import type { WebSocket } from "ws";

/**
 * The library-reserved context key carrying the connection's raw `ws`.
 * `unique symbol` so it can appear in exported type literals
 * (`AuthedContext` / `AuthlessContext` in `lifecycle/connection-handler.ts`).
 */
export const CONNECTION_WS: unique symbol = Symbol("orpc-ws:connection-ws");

/**
 * Structural view of a context that MAY carry the identity stamp. Both
 * connection-handler context shapes extend this; the heartbeat side reads
 * through {@link getConnectionWs} instead of touching the symbol directly.
 */
export interface ConnectionIdentityContext {
  [CONNECTION_WS]?: WebSocket;
}

/**
 * Read the identity stamp off an arbitrary context value. `undefined`
 * when the context was built by a transport that doesn't stamp (the HTTP
 * upload handler) or isn't an object at all — callers treat that as
 * "no per-connection tracking".
 */
export function getConnectionWs(context: unknown): WebSocket | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  return (context as ConnectionIdentityContext)[CONNECTION_WS];
}
