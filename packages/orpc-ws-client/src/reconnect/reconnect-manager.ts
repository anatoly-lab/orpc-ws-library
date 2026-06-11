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
   * Jitter-delay timer handle + resolver (F5). `runReconnect`'s
   * `delay(jitter)` used to schedule an anonymous timeout whose handle was
   * never stored, so `dispose()` could clear the debounce timer but NOT a
   * jitter delay already in flight — the orphaned timer outlived the
   * client (the post-jitter `isStopped()` re-check aborted the WORK, but
   * the clock entry still fired). At most one delay is in flight at a
   * time (the `reconnectInProgress` mutex serializes `runReconnect`), so
   * a single slot suffices. `dispose()` clears the timer AND resolves the
   * delay early, letting `runReconnect` fall through to its `isStopped()`
   * abort and settle its waiters — callers must never hang.
   */
  private jitterDelayTimer: TimerHandle | null = null;
  private jitterDelayResolve: (() => void) | null = null;
  /**
   * Pending resolvers for any `reconnect()` calls that are currently sitting
   * inside the debounce window. When the debounce fires (or when the call
   * short-circuits via the mutex), every accumulated resolver is invoked —
   * coalesced reconnects can't leave callers hanging on a promise that was
   * silently superseded.
   */
  private pendingReconnectResolvers: Array<() => void> = [];
  /**
   * Trailing-rerun latch (NFI-5). A `reconnect()` whose debounce fires
   * WHILE another reconnect is in flight used to short-circuit on the
   * mutex and resolve without ANY reconnect happening after it — if that
   * dropped call was the only signal for a NEW problem (e.g. a second
   * heartbeat timeout after the in-flight run had already passed its
   * refresh), the trigger was lost permanently. Now the mutex branch
   * requests exactly ONE trailing rerun; the in-flight run's `finally`
   * consumes the flag and runs `runReconnect` once more. Trigger-driven,
   * not a loop: each additional rerun requires a fresh `reconnect()`
   * landing during a flight. The rerun shares the storm window, so it
   * rebuilds the socket with the current token instead of re-hitting
   * the IdP (Bug 16 semantics preserved).
   */
  private trailingRerunRequested = false;
  /**
   * Resolvers for the `reconnect()` calls that requested the trailing
   * rerun. They settle when the rerun completes (or short-circuits on a
   * dead client), NOT when the unrelated in-flight run finishes —
   * "my reconnect resolved" must mean "a reconnect ran after my call".
   * `dispose()` settles them too: callers never hang.
   */
  private trailingRerunResolvers: Array<() => void> = [];
  /**
   * Storm-guard timestamp. Was `lastWsAuthRefreshAttemptedAt` at module
   * scope in `lifecycle/event-handlers.ts` (source line 25). Now an
   * instance field — one window per client instance. CLAUDE.md "Storm
   * guard state moves from module-level into a ReconnectManager instance
   * field". Updated by BOTH refresh-driving paths — `tryAuthRecovery` and
   * `runReconnect` — immediately before calling `refreshAndReconnect`
   * (Bug 16 / BUG-5: "single window across all triggers"). A follow-up
   * call within `minRefreshIntervalMs` short-circuits: terminal in
   * `tryAuthRecovery` — but only when the prior stamp was itself an
   * auth-recovery refresh, see `lastRefreshWasAuthRecovery` (F2) — and a
   * no-refresh socket rebuild in `runReconnect` (normal churn).
   *
   * Initialized to `-Infinity` so the FIRST call always passes the guard
   * (since `now - (-Infinity)` is `Infinity`, never less than the window).
   * A naive `= 0` initialization would trip the guard on the first call
   * unless the clock had already advanced past the window — that's a
   * bug-shaped default we deliberately avoid.
   */
  private lastRefreshAttemptedAt = Number.NEGATIVE_INFINITY;
  /**
   * Provenance of the most recent `lastRefreshAttemptedAt` stamp (F2):
   * `true` when it came from an AUTH-recovery refresh (`tryAuthRecovery`),
   * `false` when it came from a routine `runReconnect` refresh (heartbeat
   * timeout / sleep-wake). The storm guard's terminal trip requires
   * auth-recovery provenance: "refreshed because auth failed, and auth
   * failed AGAIN within the window" is a genuine hot loop, but "routinely
   * refreshed, then hit the FIRST auth failure" is not. Pre-F2, a
   * successful sleep-wake refresh that stamped the shared window followed
   * by the new socket's pre-open 1000 (routed to auth recovery) within
   * the window went straight to terminal — a spurious forced logout on
   * what was the very first auth signal.
   */
  private lastRefreshWasAuthRecovery = false;
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
   * Behavior (F2: terminal only on a GENUINE storm), in order:
   *   - If a refresh is already in flight (`isRefreshing()`): DEFER to it.
   *     partysocket double-fires `onclose` (one 1008 → two calls ~1ms
   *     apart), and the old wrapper can auto-retry a stale token while a
   *     slow refresh is pending — neither duplicate is new evidence of an
   *     auth hot loop. The primary caller that started the flight owns the
   *     refresh, the swap, and terminal-on-failure; the duplicate returns
   *     without re-driving the swap (no throwaway socket).
   *   - Else if now - lastRefreshAttemptedAt < minRefreshIntervalMs AND
   *     the prior stamp was an auth-recovery refresh: genuine storm — a
   *     prior auth-driven refresh COMPLETED and we are auth-failing again
   *     within the window. The refresh isn't helping (almost always a bad
   *     refresh token or a server policy 1008-ing every reconnect).
   *     Firing `onTerminalAuthFailure` lets the consumer redirect to
   *     /login instead of burning Keycloak quota.
   *   - Otherwise (outside the window, OR within it but the last stamp
   *     was a ROUTINE `runReconnect` refresh — the first real auth
   *     failure deserves a recovery attempt, not an instant logout):
   *     stamp the timestamp + provenance BEFORE calling refresh (so a
   *     concurrent close races into the join/storm branches correctly),
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

    if (this.tokenRefreshHandler.isRefreshing()) {
      // F2 join: a refresh is ALREADY in flight — this trigger is a
      // DUPLICATE of the one that started it (partysocket double-fires the
      // close event; or the old wrapper auto-retried with the stale token
      // while a slow refresh was still pending), NOT a second independent
      // auth failure. Pre-F2 this fell into the storm guard and went
      // terminal while the in-flight refresh was about to succeed.
      //
      // The PRIMARY caller (the one that started the flight) owns the whole
      // outcome — the single-flighted token refresh, the socket swap, AND
      // firing terminal on failure. So this duplicate must do NOTHING:
      // re-driving `refreshAndReconnect` here would make each joiner run its
      // OWN `reconnectWithNewToken`, standing up a throwaway socket that the
      // stale-WS guard immediately discards — a wasted handshake on every
      // double-fired recovery (the common case). Defer to the primary.
      this.logger.debug(
        "reconnect-manager: auth-recovery joined an in-flight refresh; deferring to the primary",
        { closeCode },
      );
      return;
    }

    const now = this.clock.now();
    const elapsed = now - this.lastRefreshAttemptedAt;

    if (
      elapsed < this.config.minRefreshIntervalMs &&
      this.lastRefreshWasAuthRecovery
    ) {
      // Genuine storm: the prior AUTH-recovery refresh COMPLETED (not in
      // flight — the join branch above owns that case) and auth failed
      // again within the window. A within-window stamp from a ROUTINE
      // refresh deliberately does NOT trip this (F2) — see
      // `lastRefreshWasAuthRecovery`.
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
    // the timestamp synchronously, the second reads it and short-circuits
    // (via the join branch while the refresh is in flight, via the storm
    // branch once it has completed). Provenance: this stamp is an
    // auth-recovery refresh, so a repeat within the window IS storm
    // evidence.
    this.lastRefreshAttemptedAt = now;
    this.lastRefreshWasAuthRecovery = true;
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
   * Safe reconnect with debounce, jitter, and mutex. Source semantics
   * except for the injected Clock / Rng and the NFI-5 trailing rerun:
   *   - Clears any pending debounce timer; the latest call wins.
   *   - After `debounceMs`, takes the mutex. A call whose debounce fires
   *     while another reconnect is in flight requests ONE trailing rerun
   *     (NFI-5) — the in-flight run executes it on completion, so a
   *     trigger that arrived mid-flight is served by a reconnect that
   *     STARTS after it (the source dropped it silently).
   *   - Adds `rng.next() * jitterMs` jitter to spread thundering-herd load.
   *   - Hands off to TokenRefreshHandler.refreshAndReconnect.
   *
   * Resolves when a reconnect that started at-or-after this call completes
   * (or short-circuits on a dead client). Never rejects — errors are logged.
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
   * root's `dispose()`. Clears the armed debounce timer AND any in-flight
   * jitter-delay timer (F5), resolves every pending `reconnect()` promise
   * (callers must not hang on a client that will never reconnect), and
   * latches `disposed` so any in-flight `refresh()` that resolves later
   * is discarded instead of standing up a zombie WebSocket.
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
    if (this.jitterDelayTimer) {
      // F5: the jitter-delay timer is armed by `runReconnect`, not by the
      // debounce path above — clearing only the debounce timer left this
      // one to outlive the client. No timer survives dispose().
      this.clock.clearTimeout(this.jitterDelayTimer);
      this.jitterDelayTimer = null;
    }
    if (this.jitterDelayResolve) {
      // Release the `runReconnect` awaiting the (now-cancelled) delay so
      // its post-jitter `isStopped()` re-check aborts the work and its
      // `finally` settles the coalesced waiters — callers must not hang.
      const release = this.jitterDelayResolve;
      this.jitterDelayResolve = null;
      release();
    }
    const resolvers = this.pendingReconnectResolvers;
    this.pendingReconnectResolvers = [];
    for (const r of resolvers) r();
    // NFI-5: callers parked behind a requested trailing rerun must not
    // hang either. Clear the request so the in-flight run's `finally`
    // doesn't schedule a rerun on a disposed client (its entry check
    // would refuse anyway — this just keeps the teardown total).
    this.trailingRerunRequested = false;
    const trailing = this.trailingRerunResolvers;
    this.trailingRerunResolvers = [];
    for (const r of trailing) r();
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
      // NFI-5: don't drop the trigger. The in-flight run may have already
      // passed the point where this call's underlying problem (a fresh
      // heartbeat timeout, another wake) would be addressed — request one
      // trailing rerun and hand it our resolvers; the in-flight run's
      // `finally` consumes the request. Multiple mid-flight triggers
      // coalesce into the same single rerun.
      this.logger.debug(
        "reconnect-manager: reconnect already in progress, queueing one trailing rerun",
      );
      this.trailingRerunRequested = true;
      this.trailingRerunResolvers.push(...resolvers);
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
      // second reads it and takes the no-refresh branch. Provenance (F2):
      // this is a ROUTINE refresh — it suppresses back-to-back refreshes
      // via the shared window, but it must NOT arm the storm guard's
      // terminal trip in `tryAuthRecovery` (a first auth failure right
      // after a successful sleep-wake refresh is not a hot loop).
      this.lastRefreshAttemptedAt = now;
      this.lastRefreshWasAuthRecovery = false;

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
      if (this.trailingRerunRequested) {
        // NFI-5: a reconnect() landed while we were in flight. Run
        // exactly one more pass for it. The mutex is free again, so the
        // rerun proceeds; its own entry checks (isStopped) and `finally`
        // settle the carried resolvers on every path. If yet another
        // reconnect() lands DURING the rerun, the flag is set afresh by
        // the mutex branch — trigger-driven, never a self-loop.
        this.trailingRerunRequested = false;
        const trailing = this.trailingRerunResolvers;
        this.trailingRerunResolvers = [];
        void this.runReconnect(trailing);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // Record handle + resolver so dispose() can cancel the pending
      // timer and release the awaiting `runReconnect` (F5) — see the
      // `jitterDelayTimer` field comment.
      this.jitterDelayResolve = resolve;
      this.jitterDelayTimer = this.clock.setTimeout(() => {
        this.jitterDelayTimer = null;
        this.jitterDelayResolve = null;
        resolve();
      }, ms);
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
