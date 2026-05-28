// Heartbeat wire types + library-reserved procedure path.
//
// Lives in @repo/orpc-ws-shared so the server core and the client core can
// import the same literal without taking a dependency on each other. CLAUDE.md
// "Heartbeat ownership — stealth procedure pattern" makes this one source of
// truth load-bearing: any drift between server-side router-composer and
// client-side subscriber breaks the stealth wire address silently.
//
// Originally lived in `packages/orpc-ws-client/src/heartbeat/types.ts`
// (Phase 1.5). Phase 3 moves it here so the server core (which can't depend
// on the client package) can read the same constants. The client re-exports
// them from `./heartbeat/types.ts` for backwards-compat with existing
// imports — see that file for the re-export note.

/**
 * Wire shape of `__orpc_ws_lib__.heartbeat` events.
 *
 * Two event types over the same AsyncIterable:
 *   - `config`: emitted ONCE per subscription, immediately after
 *     subscribe. Carries the deadline-window parameters the server is
 *     using; the monitor needs them to compute its watchdog deadline.
 *   - `ping`: emitted on the server's heartbeat interval. The monitor
 *     records the ping; missing one past `intervalMs + timeoutMs` fires
 *     the timeout callback.
 *
 * `ts` on `ping` is the server's `Date.now()` (or injected clock) at
 * emission. Currently unused on the client (the monitor uses its own
 * injected clock for deadline arithmetic to avoid clock-skew confusion),
 * but kept on the wire for diagnostics + future drift-detection use.
 */
export type HeartbeatEvent =
  | { type: "config"; intervalMs: number; timeoutMs: number }
  | { type: "ping"; ts: number };

/**
 * Library-reserved namespace under which the heartbeat procedure lives.
 *
 * Picked to minimize collision risk with consumer router keys (the leading
 * `__` and trailing `__` plus the `_lib_` middle make accidental
 * occurrence vanishingly unlikely in real contracts). The server's
 * `router-composer` runtime-asserts the namespace is absent in the
 * consumer's router before merging.
 */
export const HEARTBEAT_NAMESPACE = "__orpc_ws_lib__";

/**
 * Full procedure path for the heartbeat subscription.
 *
 * `as const` (readonly tuple) so it matches `link.call`'s
 * `path: readonly string[]` parameter type without a cast and so that
 * tests pinning the literal value (Bug 8 regression) get full
 * compile-time structural matching.
 */
export const HEARTBEAT_PATH = [HEARTBEAT_NAMESPACE, "heartbeat"] as const;
