// Heartbeat watchdog monitor.
//
// Phase 1.5 lift from `apps/web/src/lib/websocket/heartbeat/heartbeat-monitor.ts`.
//
// Differences from the source (de-app-ification):
//   1. No module-level singleton — class export. The composition root
//      (Phase 1.7 `createOrpcWsClient`) instantiates it; tests construct
//      their own. (CLAUDE.md "No god files" / "Dependency inversion".)
//   2. `Date.now()` and `setInterval` → injected `Clock`. The watchdog's
//      deadline arithmetic and its polling cadence both go through the
//      seam — that's the whole point of the Clock interface
//      (CLAUDE.md "Zero Date.now()" + "Zero setTimeout outside the seam").
//   3. `console.log` paths → injected `Logger`. The source logged both at
//      start and on timeout fire; both routes here are debug-level.
//   4. The source's `start(config)` method took its tunables every time
//      and stopped any existing monitor as a side effect. The new shape
//      splits config from start to keep them independent:
//        - `configure(intervalMs, timeoutMs)`: set deadline window. Called
//          by the subscriber when the `config` event lands.
//        - `start()`: begin polling. Idempotent (re-calling restarts the
//          poll without dropping the deadline).
//        - `stop()`: stop polling. Idempotent. Also conforms to the
//          `{ stop(): void }` shape `ReconnectManager` expects from a
//          heartbeat collaborator (Phase 1.3 cross-phase note).
//      Splitting lets the subscriber call `configure(...)` once on the
//      initial `config` event, then `start()` separately — and lets a
//      caller restart polling without re-supplying config.
//
// Why poll instead of arming a `setTimeout(deadline - now)` directly?
// The source app's choice was a periodic poll: every 5s, check elapsed.
// This is preserved verbatim because (a) it's simpler, (b) it tolerates
// clock jumps cleanly (a single armed timer drifting past the deadline
// would mask a real timeout), and (c) the 5s cadence is well below any
// realistic deadline (server-default heartbeat interval is ~25s; 5s
// poll keeps detection latency low without busy-looping).
//
// The poll interval is exposed as a constructor option for tests, but
// the default matches source.

import {
  type Clock,
  type Logger,
  type TimerHandle,
  noopLogger,
  systemClock,
} from "@repo/orpc-ws-shared";

/**
 * Source-default poll cadence. Re-checked on every interval tick; the
 * watchdog fires when `clock.now() - lastPing > intervalMs + timeoutMs`.
 * The choice predates this project (see source `heartbeat-monitor.ts:21`);
 * preserved verbatim so observed timing is identical post-lift.
 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Dependencies for HeartbeatMonitor. Clock + Logger have noop / system
 * defaults; the composition root wires real impls. `pollIntervalMs` is
 * a test seam — production callers always want the default.
 */
export interface HeartbeatMonitorDeps {
  clock?: Clock;
  logger?: Logger;
  /**
   * Override the 5s default poll cadence. Tests use a smaller value so
   * deadline arithmetic stays readable; production never sets this.
   */
  pollIntervalMs?: number;
}

/**
 * Watchdog for the heartbeat stream.
 *
 * Lifecycle (driven by HeartbeatSubscriber):
 *   1. `configure(intervalMs, timeoutMs)` — set the deadline window. Called
 *      when the subscriber sees the initial `config` event.
 *   2. `start()` — begin polling. Idempotent; re-calling stops the prior
 *      poll and starts fresh against the SAME deadline (so re-arming
 *      after a reconnect is one call, not two).
 *   3. `recordPing()` — bump the last-ping timestamp. Called on every
 *      `ping` event.
 *   4. `onTimeout(cb)` — register the watchdog callback. Composition
 *      root wires this to `ReconnectManager.reconnect()`.
 *   5. `stop()` — stop polling. Idempotent. Also the `{ stop(): void }`
 *      surface that `ReconnectManager`'s heartbeat collaborator hook
 *      expects (Phase 1.3 cross-phase note).
 *
 * Timeout firing semantics:
 *   - The callback fires AT MOST ONCE per timeout event in this design;
 *     after it fires the watchdog keeps polling but won't re-fire until
 *     a `recordPing()` resets the window. This matches the source
 *     (which would log + call the callback on every poll past the
 *     deadline) only via the composition root's wiring: the timeout
 *     callback calls `reconnect()`, which tears down the WS, which
 *     tears down the heartbeat subscription, which calls `stop()`. So
 *     in practice the source NEVER fired twice either; we just make
 *     that invariant explicit here so tests can pin it.
 */
export class HeartbeatMonitor {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;

  private intervalMs: number | null = null;
  private timeoutMs: number | null = null;
  private lastPingAt: number;
  private pollTimer: TimerHandle | null = null;
  private timeoutCallback: (() => void) | null = null;
  /**
   * Latch so a timeout fires only once per deadline window. Reset on
   * `recordPing()`. Without this, a poll that sees the deadline missed
   * would fire on every subsequent 5s tick until the watchdog is stopped
   * — see the docblock above for why "at most once per event" is the
   * intended contract.
   */
  private timeoutFired = false;

  constructor(deps: HeartbeatMonitorDeps = {}) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // Initialize to "now" so a monitor that has just been configured but
    // not yet seen a ping won't immediately trip its deadline. Source did
    // the same in the constructor (`lastHeartbeatTime = Date.now()`).
    this.lastPingAt = this.clock.now();
  }

  /**
   * Set the deadline window. Called by HeartbeatSubscriber when the
   * `config` event lands; safe to call again on a re-subscribe.
   *
   * Resets `lastPingAt` so a long gap before the first post-config
   * `ping` doesn't trip the watchdog on the next poll. Source did this
   * implicitly via `start()` resetting the timestamp; we surface it
   * explicitly because we split configure from start.
   */
  configure(intervalMs: number, timeoutMs: number): void {
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.lastPingAt = this.clock.now();
    this.timeoutFired = false;
    this.logger.debug("heartbeat-monitor: configured", {
      intervalMs,
      timeoutMs,
      deadlineMs: intervalMs + timeoutMs,
    });
  }

  /**
   * Begin polling. Idempotent — a second `start()` cancels the previous
   * poll and starts a fresh one, but does NOT touch `lastPingAt` (use
   * `configure()` for that). This split mirrors the source's behavior
   * after a reconnect: the subscriber re-arms the watchdog without
   * resetting the recorded-ping baseline.
   */
  start(): void {
    if (this.pollTimer) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.intervalMs == null || this.timeoutMs == null) {
      // Tolerate start-without-configure by warning + no-op; the
      // subscriber should always configure first, so this is a wiring
      // bug worth surfacing.
      this.logger.warn(
        "heartbeat-monitor: start() called before configure(); no-op",
      );
      return;
    }
    this.pollTimer = this.clock.setInterval(() => this.poll(), this.pollIntervalMs);
    this.logger.debug("heartbeat-monitor: started", {
      pollIntervalMs: this.pollIntervalMs,
    });
  }

  /**
   * Stop polling. Idempotent. Also serves as the `{ stop(): void }`
   * surface that ReconnectManager's heartbeat collaborator hook expects
   * (Phase 1.3 cross-phase note) — ReconnectManager calls this to tear
   * down the watchdog when a reconnect kicks in.
   *
   * Does NOT clear `intervalMs` / `timeoutMs`: a subsequent `start()`
   * resumes against the same deadline. The subscriber re-`configure(...)`s
   * on a fresh `config` event from a new subscription anyway, so the
   * cached values are harmless either way.
   */
  stop(): void {
    if (this.pollTimer) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.logger.debug("heartbeat-monitor: stopped");
    }
  }

  /**
   * Record a heartbeat ping. Called on every `ping` event the subscriber
   * relays. Resets the timeout latch so a subsequent missed window can
   * fire the callback again.
   */
  recordPing(): void {
    this.lastPingAt = this.clock.now();
    this.timeoutFired = false;
  }

  /**
   * Register the timeout callback. The composition root wires this to
   * `ReconnectManager.reconnect()`. Only the most recent registration is
   * retained (source semantics).
   */
  onTimeout(callback: () => void): void {
    this.timeoutCallback = callback;
  }

  /**
   * Single poll tick. Public ONLY for tests that prefer to drive the
   * poll manually instead of stepping a fake clock through every 5s
   * boundary; production callers never invoke this directly.
   */
  private poll(): void {
    if (this.intervalMs == null || this.timeoutMs == null) return;
    if (this.timeoutFired) return;

    const elapsed = this.clock.now() - this.lastPingAt;
    const deadlineMs = this.intervalMs + this.timeoutMs;

    if (elapsed > deadlineMs) {
      this.timeoutFired = true;
      this.logger.warn("heartbeat-monitor: timeout", {
        elapsedMs: elapsed,
        deadlineMs,
      });
      if (this.timeoutCallback) {
        try {
          this.timeoutCallback();
        } catch (err) {
          // Don't let a consumer's reconnect handler crash the poll
          // loop. Log and continue — the latch is already set, so we
          // won't re-fire until `recordPing()` resets it.
          this.logger.error("heartbeat-monitor: timeout callback threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
