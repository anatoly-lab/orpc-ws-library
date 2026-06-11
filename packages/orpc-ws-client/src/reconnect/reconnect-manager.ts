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
  /**
   * Whether `tokenRefreshHandler.refreshAndReconnect()` can actually mint
   * a new token — i.e. the consumer supplied a `tokenProvider`. Cookie-auth
   * clients (no `tokenProvider`) get the composition root's stub provider
   * whose `refresh()` always returns `null`; that `null` means "nothing to
   * refresh", NOT "auth is dead", so `runReconnect` skips the refresh
   * entirely and rebuilds the socket via `reconnectWithCurrentToken()` —
   * never escalating to `onTerminalAuthFailure` (regression on the Bug 15
   * fix: a healthy cookie-auth client would hit terminal just from a
   * sleep-wake or heartbeat-timeout `reconnect()`). Defaults to `true`
   * (token auth).
   */
  canRefresh?: boolean;
  /**
   * Composition-level "client is dead" predicate (F1/F3). The manager's
   * own `disposed` / `terminalFired` latches only cover the deaths it
   * participates in; the composition root also kills the client via the
   * `kicked` state (session replaced, close 4005) and via the
   * no-tokenProvider terminal path — neither routes through this
   * instance. When the predicate returns `true`, every entry point and
   * every after-await re-check refuses to run, so a reconnect armed
   * before the death cannot complete after it (the F1 kicked → connected
   * resurrection). Optional — defaults to "not dead"; the internal
   * latches remain the baseline guards.
   */
  isDead?: () => boolean;
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
 * One instance per client. The composition root MUST call `dispose()` on
 * client teardown — dropping the reference is NOT enough while a debounce
 * timer is armed or a refresh is in flight (Bug 12: a surviving timer
 * would resurrect a WebSocket after `client.dispose()`).
 *
 * Terminal semantics (Bug 14): `onTerminalAuthFailure` fires AT MOST ONCE
 * per instance. After it fires, every entry point (`reconnect()`,
 * `tryAuthRecovery()`) becomes a no-op — "the library has given up" is a
 * one-way door, matching the public contract ("the client is terminal
 * after this fires; create a new one post-re-auth").
 */
export class ReconnectManager {
  private readonly tokenRefreshHandler: TokenRefreshHandler;
  private readonly config: ReconnectManagerConfig;
  private readonly onTerminalAuthFailure: OnTerminalAuthFailure;
  private readonly canRefresh: boolean;
  private readonly isDead: (() => boolean) | undefined;
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
   * field". Updated by BOTH refresh-driving paths — `tryAuthRecovery` and
   * `runReconnect` — immediately before calling `refreshAndReconnect`
   * (Bug 16 / BUG-5: "single window across all triggers"). A follow-up
   * call within `minRefreshIntervalMs` short-circuits: terminal in
   * `tryAuthRecovery` (auth-failure hot loop), no-refresh socket rebuild
   * in `runReconnect` (normal churn).
   *
   * Initialized to `-Infinity` so the FIRST call always passes the guard
   * (since `now - (-Infinity)` is `Infinity`, never less than the window).
   * A naive `= 0` initialization would trip the guard on the first call
   * unless the clock had already advanced past the window — that's a
   * bug-shaped default we deliberately avoid.
   */
  private lastRefreshAttemptedAt = Number.NEGATIVE_INFINITY;
  /**
   * Single-fire latch for `onTerminalAuthFailure` (Bug 14). Once the
   * library has given up on auth recovery, repeat triggers (partysocket
   * retries being 1008-ed, follow-up heartbeat timeouts) must NOT re-fire
   * the consumer callback or attempt further refreshes — terminal means
   * terminal.
   */
  private terminalFired = false;
  /**
   * Set by `dispose()` (Bug 12). Checked at the top of every entry point
   * AND re-checked after every `await`, so an in-flight `refresh()` that
   * resolves post-dispose cannot proceed to swap the socket or fire
   * consumer callbacks.
   */
  private disposed = false;

  constructor(deps: ReconnectManagerDeps) {
    this.tokenRefreshHandler = deps.tokenRefreshHandler;
    this.config = deps.reconnectConfig;
    this.onTerminalAuthFailure = deps.onTerminalAuthFailure;
    this.canRefresh = deps.canRefresh ?? true;
    this.isDead = deps.isDead;
    this.clock = deps.clock ?? systemClock;
    this.rng = deps.rng ?? defaultRng;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Unified deadness check (F1/F3): the instance's own latches (Bug 12 /
   * Bug 14) OR the composition root's `isDead` predicate (disposed /
   * terminal / kicked). Every entry point and every after-await re-check
   * goes through here so all three terminal states behave identically —
   * a reconnect armed before ANY death short-circuits instead of running
   * to the swap and being refused there.
   */
  private isStopped(): boolean {
    return this.disposed || this.terminalFired || (this.isDead?.() ?? false);
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
    if (this.isStopped()) {
      // Dead client — disposed (Bug 12), terminal (Bug 14), or kicked /
      // composition-terminal (F1/F3): the library must not attempt
      // another refresh. Repeat triggers (e.g. a straggler close event)
      // no-op here.
      this.logger.debug(
        "reconnect-manager: tryAuthRecovery on a dead client (disposed/terminal/kicked); ignoring",
        { closeCode },
      );
      return;
    }
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

    // Re-check after the await (Bug 12 / F1): a dispose() — or a 4005
    // kick / composition-level terminal — that landed while refresh() was
    // in flight wins. No terminal callback post-teardown, and a kicked
    // client must not be re-labeled "terminal auth failure".
    if (this.isStopped()) return;

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
    if (this.isStopped()) {
      // Dead client — disposed (Bug 12), terminal (Bug 14), or kicked /
      // composition-terminal (F1/F3): no reconnect machinery may run.
      // Resolve immediately — callers must never hang.
      this.logger.debug(
        "reconnect-manager: reconnect() on a dead client (disposed/terminal/kicked); ignoring",
      );
      return;
    }
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
   * Cancel all reconnect machinery (Bug 12). Called by the composition
   * root's `dispose()`. Clears the armed debounce timer, resolves every
   * pending `reconnect()` promise (callers must not hang on a client
   * that will never reconnect), and latches `disposed` so any in-flight
   * `refresh()` that resolves later is discarded instead of standing up
   * a zombie WebSocket.
   *
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectDebounceTimer) {
      this.clock.clearTimeout(this.reconnectDebounceTimer);
      this.reconnectDebounceTimer = null;
    }
    const resolvers = this.pendingReconnectResolvers;
    this.pendingReconnectResolvers = [];
    for (const r of resolvers) r();
    this.logger.debug("reconnect-manager: disposed");
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

    if (this.isStopped()) {
      // Died (disposed/terminal/kicked) between scheduling and the
      // debounce firing.
      this.logger.debug(
        "reconnect-manager: runReconnect on a dead client; skipping",
      );
      settleAll();
      return;
    }

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

      // Re-check after the jitter delay (Bug 12 / F1): a dispose(), a
      // 4005 kick, or a composition-level terminal during the delay must
      // win — no refresh, no socket swap.
      if (this.isStopped()) {
        this.logger.debug(
          "reconnect-manager: client died during jitter delay; aborting reconnect",
        );
        return;
      }

      // Cookie auth (no tokenProvider): refresh is meaningless — the stub
      // provider's `refresh()` always returns null, which carries no auth
      // signal (Bug 15b). Rebuild the socket with the current (no-)token
      // instead; the URL builder already handles a null token. Never
      // terminal — a sleep-wake or heartbeat-timeout reconnect on a
      // cookie-auth client is routine churn, not a "redirect to /login".
      // (`tryAuthRecovery` never reaches this state — the composition root
      // already gates it on `hasTokenProvider` before routing close events
      // here.)
      if (!this.canRefresh) {
        this.tokenRefreshHandler.reconnectWithCurrentToken();
        this.logger.info(
          "reconnect-manager: safe reconnect completed (no tokenProvider, no refresh)",
        );
        return;
      }

      // Shared storm window (Bug 16 / BUG-5): heartbeat-timeout and
      // sleep-wake reconnects share the SAME `lastRefreshAttemptedAt`
      // window as `tryAuthRecovery` — CLAUDE.md "single window across all
      // triggers". If we refreshed within `minRefreshIntervalMs`, the
      // current token is still fresh: rebuild the socket with it instead
      // of hitting the IdP again. Unlike `tryAuthRecovery`'s trip, this is
      // NOT terminal — a reconnect landing inside the window is normal
      // churn, not an auth-failure hot loop.
      const now = this.clock.now();
      if (now - this.lastRefreshAttemptedAt < this.config.minRefreshIntervalMs) {
        this.logger.info(
          "reconnect-manager: within storm window, reconnecting with current token (no refresh)",
        );
        this.tokenRefreshHandler.reconnectWithCurrentToken();
        return;
      }

      // Stamp the SHARED window BEFORE the await (same rule as
      // `tryAuthRecovery`): two near-simultaneous triggers must not both
      // pass the window check — the first writes synchronously, the
      // second reads it and takes the no-refresh branch.
      this.lastRefreshAttemptedAt = now;

      // Honor the refresh outcome (Bug 15). The source dropped this
      // boolean, which left a heartbeat-timeout recovery whose refresh
      // returned null in limbo: no new socket, no terminal signal, no
      // retry — a permanent zombie. "Refresh returned null" maps to
      // terminal per the locked auth contract (CLAUDE.md §"Auth flow
      // contract"), exactly as in `tryAuthRecovery` above.
      let ok = false;
      try {
        ok = await this.tokenRefreshHandler.refreshAndReconnect();
      } catch (err) {
        this.logger.error("reconnect-manager: refreshAndReconnect threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Re-check after the refresh await (Bug 12 / F1): a death that
      // landed mid-refresh wins — no terminal callback, and a kicked
      // client must not be re-labeled "terminal auth failure".
      if (this.isStopped()) return;
      if (!ok) {
        this.logger.warn(
          "reconnect-manager: reconnect refresh returned null, firing onTerminalAuthFailure",
        );
        this.fireTerminalAuthFailure();
        return;
      }
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
    if (this.terminalFired) {
      // Bug 14: single fire per instance. Anything that re-triggers the
      // terminal path after the first fire (straggler close events,
      // late storm-guard trips) is logged and dropped.
      this.logger.debug(
        "reconnect-manager: terminal auth failure already fired; ignoring repeat",
      );
      return;
    }
    // Dead for another reason — disposed (Bug 12) or the composition
    // root's kicked/terminal latch (F1/F3): a dead client must not fire
    // the consumer's terminal callback on top of its own death.
    if (this.isStopped()) return;
    this.terminalFired = true;
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
