// Connection-level tunables: path, close codes, and the one-per-user
// enforcement switch.
//
// Close codes lifted verbatim from the source app's `WS_CLOSE_CODES`
// (`@repo/shared-types`) to keep wire-compatible behavior on day one:
//   - 4001 — auth failed (no token / invalid token / expired)
//   - 4005 — session replaced (kicked because a newer connection arrived)
//   - 4009 — server shutdown (graceful goodbye on `dispose()`)
//
// CLAUDE.md "Configurable, not hardcoded" requires these be reified as
// config; the consumer can swap to a different code scheme without
// touching library internals.

export interface ConnectionConfig {
  /**
   * Whether to kick the previous WS for a user when a new authenticated
   * one arrives. Default `true` matches the source gateway — "one tab per
   * user" semantics, important because the source app's reactive state
   * assumes a single live link per user.
   *
   * Set to `false` to allow concurrent connections; in that case the
   * connection-registry effectively becomes a no-op replacement guard,
   * and the consumer's broadcast logic needs to deduplicate.
   */
  singleConnectionPerUser: boolean;
  /** Path the WebSocket server listens on. Default `/ws`. */
  path: string;
  /**
   * Close code sent when the server initiates `dispose()`. Default 4009
   * (a private-use range code from the source app's WS_CLOSE_CODES).
   * Clients use this as a signal to stop reconnecting immediately.
   */
  shutdownCloseCode: number;
  /**
   * Close code sent to the kicked WS when a newer connection takes over.
   * Default 4005. Clients treat this as a terminal "kicked" state — they
   * do NOT auto-reconnect.
   */
  sessionReplacedCloseCode: number;
  /**
   * Close code sent during `verifyClient` when auth fails. Default 4001.
   * The library callsite of verify rejects pre-101 with this code; clients
   * trigger their auth-recovery / refresh path.
   */
  authFailedCloseCode: number;
}

/**
 * Defaults match the source gateway. The path is the one place a consumer
 * commonly overrides; the close codes are stable across the app and the
 * library both sides recognize.
 */
export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  singleConnectionPerUser: true,
  path: "/ws",
  shutdownCloseCode: 4009,
  sessionReplacedCloseCode: 4005,
  authFailedCloseCode: 4001,
};
