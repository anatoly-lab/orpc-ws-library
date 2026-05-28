// Reconnect manager.
//
// Phase 1.3 lift from `apps/web/src/lib/websocket/reconnect/reconnect-manager.ts`
// AND `apps/web/src/lib/websocket/lifecycle/event-handlers.ts:25` (the
// `lastWsAuthRefreshAttemptedAt` module-level storm-guard timestamp).
//
// MAJOR differences from the source:
//   1. The 30s storm-guard window — previously the module-level
//      `lastWsAuthRefreshAttemptedAt` in `event-handlers.ts` — lives here,
//      as an instance field. CLAUDE.md "Storm guard state moves from
//      module-level (...) into a ReconnectManager instance field" and
//      design-doc §"Library owns the 30s storm guard internally — single
//      window across all triggers". The drift between the source's
//      proactive-refresh guard and reactive-refresh guard is fixed by
//      having ONE owner of the timestamp.
//   2. `Math.random()` → injected `Rng.next()` (CLAUDE.md "Zero
//      `Math.random()` calls outside an injected RNG seam"). Jitter is
//      now deterministic under test.
//   3. `setTimeout` / `Date.now` → injected `Clock`. Same rationale as RNG.
//   4. `console.log` / `console.error` → injected `Logger`.
//   5. The source had ONE method (`reconnect`) that callers always wanted.
//      We split into:
//        - `reconnect()`: debounce + jitter + mutex, exactly as before.
//        - `tryAuthRecovery(closeCode)`: wraps `refreshAndReconnect` with
//          the storm-guard gate, fires `onTerminalAuthFailure` on storm
//          OR on `refresh()` returning null. This is what
//          `EventHandlers.onAuthRecoveryNeeded` calls into.
//
// The mutex (`reconnectInProgress`) and debounce timer are preserved
// verbatim — those exist for documented race-condition reasons (see source
// comment block around `reconnect()`).

import {
  type Clock,
  type Logger,
  type Rng,
  noopLogger,
  systemClock,
  defaultRng,
} from "@repo/orpc-ws-shared";
import type { TimerHandle } from "@repo/orpc-ws-shared";

import type { OnTerminalAuthFailure } from "../auth/types.js";

import type { TokenRefreshHandler } from "./token-refresh-handler.js";

/**
 * Subset of the unified `ReconnectConfig` (Phase 1.7) that the manager
 * actually reads. Declared as a structural pick so callers can pass the
 * full `ReconnectConfig` from `config/reconnect-config.ts` without
 * adaptation, while tests can hand in just these three fields without
 * also constructing the partysocket-facing knobs.
 *
 * Field semantics are unchanged from the Phase 1.3 placeholder:
 *   - `debounceMs`           — debounce window for `reconnect()` calls.
 *   - `jitterMs`             — max random jitter before reconnect kicks off.
 *   - `minRefreshIntervalMs` — storm-guard window (the source's
 *     `MIN_REFRESH_INTERVAL_MS` constant from `auth-failure.ts`).
 */
export interface ReconnectManagerConfig {
  debounceMs: number;
  jitterMs: number;
  minRefreshIntervalMs: number;
}

/**
 * Dependencies for ReconnectManager. Clock / Rng / Logger have noop defaults;
 * the composition root wires real impls.
 */
export interface ReconnectManagerDeps {
  tokenRefreshHandler: TokenRefreshHandler;
  reconnectConfig: ReconnectManagerConfig;
  /**
   * Fired when the library has given up on auth recovery PERMANENTLY for
   * this client instance (refresh returned null OR storm guard tripped).
   * See `auth/types.ts` for the full contract.
   */
  onTerminalAuthFailure: OnTerminalAuthFailure;
  clock?: Clock;
  rng?: Rng;
  logger?: Logger;
}

/**
 * Owns reconnect timing for one client instance.
 *
 * Two entry points:
 *   - `reconnect()`: explicit "please try to reconnect" call. Debounce +
 *     jitter + mutex. Used by sleep detector, heartbeat-timeout watchdog,
 *     and any consumer-facing manual reconnect signal.
 *   - `tryAuthRecovery(closeCode)`: routed from EventHandlers'
 *     `onAuthRecoveryNeeded` callback. Storm-guard-gated; on miss, fires
 *     `onTerminalAuthFailure`. Otherwise hands off to TokenRefreshHandler.
 *
 * All timing state lives on the instance — there is no module-level state.
 * One instance per client; dispose by simply dropping the reference (the
 * composition root owns the lifecycle).
 */
export class ReconnectManager {
  private readonly tokenRefreshHandler: TokenRefreshHandler;
  private readonly config: ReconnectManagerConfig;
  private readonly onTerminalAuthFailure: OnTerminalAuthFailure;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly logger: Logger;

  /** Mutex for `reconnect()`. Concurrent callers serialize on this flag. */
  private reconnectInProgress = false;
  /** Debounce-timer handle so a second `reconnect()` call can reset it. */
  private reconnectDebounceTimer: TimerHandle | null = null;
  /**
   * Pending resolvers for any `reconnect()` calls that are currently sitting
   * inside the debounce window. When the debounce fires (or when the call
   * short-circuits via the mutex), every accumulated resolver is invoked —
   * coalesced reconnects can't leave callers hanging on a promise that was
   * silently superseded.
   */
  private pendingReconnectResolvers: Array<() => void> = [];
  /**
   * Storm-guard timestamp. Was `lastWsAuthRefreshAttemptedAt` at module
   * scope in `lifecycle/event-handlers.ts` (source line 25). Now an
   * instance field — one window per client instance. CLAUDE.md "Storm
   * guard state moves from module-level into a ReconnectManager instance
   * field". Updated by `tryAuthRecovery` immediately before calling
   * `refreshAndReconnect`, so a follow-up call within
   * `minRefreshIntervalMs` will short-circuit.
   *
   * Initialized to `-Infinity` so the FIRST call always passes the guard
   * (since `now - (-Infinity)` is `Infinity`, never less than the window).
   * A naive `= 0` initialization would trip the guard on the first call
   * unless the clock had already advanced past the window — that's a
   * bug-shaped default we deliberately avoid.
   */
  private lastRefreshAttemptedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: ReconnectManagerDeps) {
    this.tokenRefreshHandler = deps.tokenRefreshHandler;
    this.config = deps.reconnectConfig;
    this.onTerminalAuthFailure = deps.onTerminalAuthFailure;
    this.clock = deps.clock ?? systemClock;
    this.rng = deps.rng ?? defaultRng;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Storm-guarded auth-recovery entry point. Called by EventHandlers'
   * `onAuthRecoveryNeeded` when the close-decision tree decides this close
   * is auth-related (1008 / 4001 / pre-open 1000).
   *
   * Behavior:
   *   - If now - lastRefreshAttemptedAt < minRefreshIntervalMs:
   *     storm guard trips. We treat this as a terminal auth failure
   *     because something is forcing us to refresh in a hot loop (almost
   *     always a bad refresh token or a server policy 1008-ing every
   *     reconnect). Firing `onTerminalAuthFailure` lets the consumer
   *     redirect to /login instead of burning Keycloak quota.
   *   - Otherwise: stamp the timestamp BEFORE calling refresh (so a
   *     concurrent close races into the storm-guard branch correctly),
   *     then hand off to TokenRefreshHandler. On `false` return (refresh
   *     itself failed), fire `onTerminalAuthFailure`.
   *
   * The `closeCode` argument is currently only used for logging (matches
   * the source — close codes are differentiated for diagnostics, but the
   * refresh path is uniform).
   */
  async tryAuthRecovery(closeCode: number): Promise<void> {
    const now = this.clock.now();
    const elapsed = now - this.lastRefreshAttemptedAt;

    if (elapsed < this.config.minRefreshIntervalMs) {
      this.logger.warn(
        "reconnect-manager: auth-recovery storm guard tripped, treating as terminal auth failure",
        {
          closeCode,
          elapsedMs: elapsed,
          minRefreshIntervalMs: this.config.minRefreshIntervalMs,
        },
      );
      this.fireTerminalAuthFailure();
      return;
    }

    // Stamp BEFORE the await. Two concurrent close events arriving inside
    // the same tick must NOT both pass the storm guard — the first writes
    // the timestamp synchronously, the second reads it and short-circuits.
    this.lastRefreshAttemptedAt = now;
    this.logger.info("reconnect-manager: starting auth-recovery refresh", {
      closeCode,
    });

    let ok = false;
    try {
      ok = await this.tokenRefreshHandler.refreshAndReconnect();
    } catch (err) {
      this.logger.error("reconnect-manager: refreshAndReconnect threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!ok) {
      this.logger.warn(
        "reconnect-manager: refresh returned null, firing onTerminalAuthFailure",
      );
      this.fireTerminalAuthFailure();
    }
  }

  /**
   * Safe reconnect with debounce, jitter, and mutex. Verbatim source
   * semantics except for the injected Clock / Rng:
   *   - Clears any pending debounce timer; the latest call wins.
   *   - After `debounceMs`, takes the mutex. Concurrent in-flight reconnects
   *     short-circuit (the in-flight one wins).
   *   - Adds `rng.next() * jitterMs` jitter to spread thundering-herd load.
   *   - Hands off to TokenRefreshHandler.refreshAndReconnect.
   *
   * Resolves when the post-debounce path completes (or short-circuits via
   * the mutex). Never rejects — errors are logged.
   */
  async reconnect(): Promise<void> {
    if (this.reconnectDebounceTimer) {
      // Earlier debounced reconnect superseded by this call. We clear the
      // pending timer but keep the accumulated resolvers — they're all
      // waiting for "some" reconnect to complete and don't care which
      // exact debounce window won.
      this.clock.clearTimeout(this.reconnectDebounceTimer);
      this.reconnectDebounceTimer = null;
    }

    return new Promise<void>((resolve) => {
      this.pendingReconnectResolvers.push(resolve);
      this.reconnectDebounceTimer = this.clock.setTimeout(() => {
        this.reconnectDebounceTimer = null;
        // Snapshot + clear under the same synchronous boundary so a
        // re-entrant `reconnect()` triggered from inside `runReconnect`
        // doesn't end up draining its own resolver here.
        const resolvers = this.pendingReconnectResolvers;
        this.pendingReconnectResolvers = [];
        void this.runReconnect(resolvers);
      }, this.config.debounceMs);
    });
  }

  isReconnecting(): boolean {
    return this.reconnectInProgress;
  }

  /**
   * Post-debounce reconnect body. Resolves EVERY accumulated waiter when
   * the work is done (or when the mutex short-circuits) — coalesced calls
   * to `reconnect()` share one outcome but each promise still settles.
   */
  private async runReconnect(resolvers: Array<() => void>): Promise<void> {
    const settleAll = () => {
      for (const r of resolvers) r();
    };

    if (this.reconnectInProgress) {
      this.logger.debug(
        "reconnect-manager: reconnect already in progress, skipping",
      );
      settleAll();
      return;
    }

    this.reconnectInProgress = true;
    try {
      // Jitter via the injected RNG so tests can pin exact delays. The
      // Math.random() in the source is the only thing that made jitter
      // tests flaky; the seam fixes that.
      const jitter = this.rng.next() * this.config.jitterMs;
      this.logger.info("reconnect-manager: starting safe reconnect", {
        jitterMs: Math.round(jitter),
      });
      await this.delay(jitter);

      await this.tokenRefreshHandler.refreshAndReconnect();
      this.logger.info("reconnect-manager: safe reconnect completed");
    } catch (err) {
      this.logger.error("reconnect-manager: safe reconnect failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.reconnectInProgress = false;
      settleAll();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.clock.setTimeout(() => resolve(), ms);
    });
  }

  private fireTerminalAuthFailure(): void {
    try {
      this.onTerminalAuthFailure();
    } catch (err) {
      // The consumer's terminal-failure callback must not crash the
      // reconnect path. Log and continue — the library has already moved
      // state to disconnected by the time this fires.
      this.logger.error(
        "reconnect-manager: onTerminalAuthFailure callback threw",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}
