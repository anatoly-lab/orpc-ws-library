// Reconnect configuration — unified across the library.
//
// Phase 1.7 lift from `apps/web/src/lib/websocket/config/reconnect-config.ts`,
// merged with the Phase 1.2 placeholder (`lifecycle/types.ts:ReconnectConfig`)
// and the Phase 1.3 placeholder (`reconnect/reconnect-manager.ts:
// ReconnectManagerConfig`). ONE shape for all reconnect knobs, one defaults
// table, one place to override.
//
// The split between "partysocket-facing" and "library-facing" fields is
// purely descriptive: partysocket's constructor reads the first group; the
// library's `ReconnectManager` reads the second. Both live on one object
// so the consumer never has to pass two configs that must be kept in sync.
//
// Source defaults are preserved verbatim except for one library-facing
// addition: `minRefreshIntervalMs`. The source's storm-guard window came
// from `auth-failure.MIN_REFRESH_INTERVAL_MS` (a separate module). We lift
// it INTO this config so the storm-guard tuning is overridable per-instance
// — CLAUDE.md "Configurable, not hardcoded".

/**
 * Tunables for the reconnect path. Single source of truth across:
 *   - `WebSocketFactory.create()` (partysocket-facing fields)
 *   - `ReconnectManager` constructor (library-facing fields)
 *   - `TokenRefreshHandler` (forwards the partysocket fields to the
 *     factory on every swap).
 *
 * Field groups:
 *   - **partysocket-facing**: forwarded as-is into the partysocket
 *     constructor. Names match partysocket's option names exactly.
 *   - **library-facing**: read by `ReconnectManager` for debounce, jitter,
 *     and storm-guard timing.
 */
export interface ReconnectConfig {
  // ----- partysocket-facing (used by WebSocketFactory) -----
  /** Maximum total retries. Source default: `Infinity`. */
  maxRetries: number;
  /** Minimum delay between reconnect attempts (ms). Source default: 1000. */
  minReconnectionDelay: number;
  /** Maximum delay between reconnect attempts (ms). Source default: 30_000. */
  maxReconnectionDelay: number;
  /**
   * Multiplicative factor for exponential backoff between attempts.
   * Source default: 2 (1s → 2s → 4s → 8s → 16s → 30s cap).
   */
  reconnectionDelayGrowFactor: number;
  /** Per-attempt connection-establishment timeout (ms). Source default: 5000. */
  connectionTimeout: number;
  /**
   * Max queued send()s while disconnected. Source default: 0 (drop on
   * disconnect — the library's RPC layer surfaces the error to the caller
   * directly rather than silently queueing).
   */
  maxEnqueuedMessages: number;

  // ----- library-facing (used by ReconnectManager) -----
  /**
   * Debounce window for `ReconnectManager.reconnect()` calls. Multiple
   * triggers within this window coalesce into one. Source default: 100ms.
   */
  debounceMs: number;
  /**
   * Maximum random jitter added before kicking off the reconnect (ms).
   * Actual delay is `rng.next() * jitterMs` (in [0, jitterMs)). Prevents
   * thundering-herd on simultaneous client wake-ups. Source default: 1000ms.
   */
  jitterMs: number;
  /**
   * Storm-guard window (ms). If `tryAuthRecovery` is called within this
   * many ms of a COMPLETED auth-recovery refresh, the call short-circuits
   * to `onTerminalAuthFailure` instead of refreshing again. (F2: a call
   * landing while a refresh is still in flight JOINS it, and a window
   * stamped by a routine `reconnect()` refresh does not trip the guard —
   * only auth-recovery-provenance stamps do.) Source default (from
   * `auth-failure.MIN_REFRESH_INTERVAL_MS`): 30_000ms.
   */
  minRefreshIntervalMs: number;
}

/**
 * Production defaults. Verbatim from the source app — the comments in the
 * original `config/reconnect-config.ts` plus the storm-guard default from
 * `auth-failure.ts`. Overridable per-instance via `OrpcWsClientOptions.reconnect`.
 */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  // partysocket-facing
  maxRetries: Number.POSITIVE_INFINITY,
  minReconnectionDelay: 1000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 2,
  connectionTimeout: 5000,
  maxEnqueuedMessages: 0,

  // library-facing
  debounceMs: 100,
  jitterMs: 1000,
  minRefreshIntervalMs: 30_000,
};
