// Token-provider seam.
//
// Phase 1.3 NEW file. This is the consumer-facing auth seam — everything the
// library needs from the consumer's auth subsystem fits behind this two-method
// interface. CLAUDE.md "Auth flow contract":
//   - `refresh()` MUST be pure. No side effects beyond the refresh fetch.
//     Returns the fresh token, or null if refresh failed. The library closes
//     the WS and emits `onTerminalAuthFailure` itself; the provider never
//     touches WS state.
//   - The library owns the 30s storm guard internally — the provider sees AT
//     MOST one `refresh()` call per 30s window (see ReconnectManager
//     `tryAuthRecovery`). The provider need NOT debounce its own callers.
//   - `getToken()` is the synchronous read of the currently-cached token,
//     used by the URL provider closure on each partysocket reconnect (Bug 1
//     mitigation — fresh token on every retry).
//
// The source app's `authStorage.getValidAccessToken()` returned cached-if-
// fresh-else-refreshed; that conflation goes away here. `getToken()` is
// always synchronous and never refreshes; `refresh()` is always asynchronous
// and always actually refreshes when called. The library's storm guard
// decides whether to call refresh at all.

/**
 * Consumer-supplied token source.
 *
 * Optional at the type level on `createOrpcWsClient` — omitting it means
 * "no token; browser handles auth via cookies if any" (CLAUDE.md cookie-auth
 * support). When present, both methods must be implemented; the library
 * never partially uses the seam.
 */
export interface TokenProvider {
  /**
   * Synchronous read of the current cached token, or null if no token is
   * available. Called by the URL provider closure on every partysocket
   * reconnect attempt — MUST be cheap and non-blocking.
   */
  getToken(): string | null;

  /**
   * Asynchronously refresh the access token. The library calls this on
   * auth-failure close codes (1008 / 4001 / pre-open 1000) and on heartbeat
   * timeout, gated by the library-owned 30s storm guard (the provider sees
   * AT MOST one call per 30s window).
   *
   * Returns the fresh token on success, or null if refresh failed. On null,
   * the library emits `onTerminalAuthFailure` and stops retrying.
   *
   * MUST be pure: no side effects beyond the refresh fetch itself. Do NOT
   * close the WebSocket, clear auth state, or redirect from here — use the
   * `onTerminalAuthFailure` callback for cleanup so the library can stay in
   * control of teardown order.
   */
  refresh(): Promise<string | null>;
}
