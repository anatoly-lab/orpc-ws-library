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
  /**
   * Opt-in token-expiry watchdog (API-4). When `true` AND the consumer's
   * `verifyClient` result carries `expiresAt` (epoch ms), the connection
   * handler schedules a close with `authFailedCloseCode` (default 4001,
   * "Token expired") at that instant — so a connection authenticated with
   * a 15-minute token cannot outlive the token. The library client treats
   * 4001 as auth-recovery: refresh the token, reconnect — the loop closes
   * with no client-side change.
   *
   * Default `false` for back-compat: a verify result without `expiresAt`
   * (every pre-existing consumer) sees zero behavior change either way.
   * Recommended `true` for new deployments using a verifier that
   * populates `expiresAt` (e.g. `@orpc-ws/oidc-verifier-jose`).
   */
  enforceTokenExpiry: boolean;
  /**
   * Grace window (ms) `dispose()` waits for clients to finish the WS
   * close handshake before force-`terminate()`ing the stragglers.
   * Default 5000.
   *
   * Why (NFI-4): `dispose()` sends a graceful `close()` to every client
   * and then awaits the `ws` server's close — which waits for each
   * client's close handshake to complete. A dead / half-open client
   * never completes it, and `ws`'s own internal fallback timer takes
   * ~30 s, so one zombie could hang server shutdown that long. Clients
   * that close cleanly inside the window are untouched (they still get
   * the clean `shutdownCloseCode` frame); only stragglers are
   * terminated, and only after the window elapses.
   */
  shutdownGraceMs: number;
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
  enforceTokenExpiry: false,
  shutdownGraceMs: 5000,
};
