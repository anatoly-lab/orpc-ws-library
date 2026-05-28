// Sleep detector — main-thread drift-detection over a Web Worker tick.
//
// Phase 1.6 lift from `apps/web/src/lib/websocket/sleep/sleep-detector.ts`.
//
// Differences from the source (de-app-ification):
//   1. No module-level singleton — class export. The composition root
//      (Phase 1.7 `createOrpcWsClient`) instantiates it; tests construct
//      their own. (CLAUDE.md "No god files" / "Dependency inversion".)
//   2. Factory function `createSleepDetector(onWake)` → `class SleepDetector`.
//      Same lifecycle (start/stop) but `destroy()` collapses into `stop()`
//      because the Blob-URL worker is trivially recreated on each `start()`
//      now that there's no `{ type: "start" }` handshake to coordinate.
//   3. Drift arithmetic moves out of the worker and into this class. The
//      worker is now a dumb ticker that posts `{ ts: Date.now() }`; this
//      class compares the tick arrival against the injected `Clock`. See
//      the worker file's header for why this split is the cleaner seam.
//   4. `Date.now()` → injected `Clock`. CLAUDE.md "Zero Date.now() outside
//      the seam".
//   5. `console.error` on worker error → injected `Logger`. CLAUDE.md
//      "Zero console.log".
//   6. `workerFactory` is injectable. Production uses the Blob-URL
//      factory from `worker-source.ts`; tests inject a mock Worker.
//
// Drift-detection algorithm (preserved verbatim from source intent):
//   On every worker tick:
//     elapsed = clock.now() - lastTickAt
//     if elapsed > pollIntervalMs + driftToleranceMs:
//       onWake(elapsed)  // best-effort estimate of sleep duration
//     lastTickAt = clock.now()
//
//   Rationale for using clock.now() (not the worker's `ts`):
//   - The injected `Clock` is the testable seam. Using the worker's
//     `ts` would require fake-clock state inside the worker, which
//     defeats the seam split.
//   - In production, both clocks share the same OS time source; the
//     numbers agree to within a few ms.
//   - We do read `msg.ts` to verify the message shape (defensive), but
//     all arithmetic uses `clock.now()`.

import {
  type Clock,
  type Logger,
  noopLogger,
  systemClock,
} from "@repo/orpc-ws-shared";

import { defaultWorkerFactory } from "./worker-source.js";

/**
 * Source-default poll cadence (5s). Matches the worker's `INTERVAL_MS`
 * and the source app's `SLEEP_DETECTION.INTERVAL_MS`. The interval
 * MUST agree with the worker — if a constructor option overrides this,
 * the worker still ticks at 5s. Override is for tests only; production
 * never sets it.
 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Source-default drift tolerance (2s). Matches source's
 * `SLEEP_DETECTION.DRIFT_THRESHOLD_MS`. Anything past
 * `pollIntervalMs + driftToleranceMs` is treated as "device woke from
 * sleep". 2s is intentionally generous — page-visibility throttling
 * alone can delay timers by ~1s on backgrounded tabs, and we don't
 * want to false-positive on those.
 */
const DEFAULT_DRIFT_TOLERANCE_MS = 2_000;

/**
 * Subset of the `Worker` DOM type that `SleepDetector` actually uses.
 *
 * Pinned narrowly so tests can hand-roll a mock without implementing the
 * full DOM Worker surface (importData, onmessageerror, dispatchEvent…).
 * In production this is satisfied by a real `Worker`. The mock the tests
 * inject lives behind this same shape.
 */
export interface SleepWorker {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  terminate(): void;
}

/**
 * Dependencies for SleepDetector. Clock + Logger have noop / system
 * defaults; the composition root wires real impls. `workerFactory` is
 * a test seam — production callers always want the Blob-URL default.
 *
 * `pollIntervalMs` and `driftToleranceMs` mirror the source's
 * `SLEEP_DETECTION` config. Both are configurable here (per CLAUDE.md
 * "All numeric tunables… live in a config object with sensible
 * defaults") but consumers usually take the defaults.
 */
export interface SleepDetectorDeps {
  /**
   * Callback invoked when a sleep event is detected. The argument is
   * the elapsed wall-clock time between the prior tick and the wake
   * tick — a best-effort estimate of the sleep duration. Same contract
   * as the source's `onWake(sleepDuration)`.
   *
   * The library's composition root (Phase 1.7) wires this to the
   * connection-state check + reconnect path; see `public-api.ts`
   * lines 56-88 in the source app for the analogous wiring.
   */
  onWake: (sleepDurationMs: number) => void;

  /**
   * Override the 5s default tick cadence. Tests use a smaller value so
   * elapsed-time arithmetic stays readable; production never sets this.
   * NOTE: this only affects the main thread's drift threshold. The
   * default Blob-URL worker still ticks at its hard-coded 5s. If you
   * need a non-default cadence in production, ship a custom
   * `workerFactory` too.
   */
  pollIntervalMs?: number;

  /**
   * Override the 2s default drift tolerance. Tests use a smaller value
   * so the wake threshold is easy to cross; production never sets this.
   */
  driftToleranceMs?: number;

  clock?: Clock;
  logger?: Logger;

  /**
   * Factory for the underlying `Worker`. Production default builds a
   * `Worker` from a Blob URL (`worker-source.ts`). Tests inject a mock
   * worker — the typical shape is:
   *   { addEventListener, removeEventListener, terminate }
   * with the test calling the registered `message` listener directly
   * via `postMessage({ data: { ts: ... } })`.
   */
  workerFactory?: () => SleepWorker;
}

/**
 * Detects device sleep/wake by watching for drift between expected and
 * actual Web-Worker tick arrivals.
 *
 * Why a worker (not a main-thread timer):
 *   Browsers throttle `setInterval` in backgrounded tabs (down to 1Hz,
 *   or paused entirely on iOS). A timer on the main thread would miss
 *   the wake signal in exactly the case we care about — when the user
 *   has the tab open but the device went to sleep. Web Workers are
 *   throttled less aggressively (Chrome keeps them running; Firefox
 *   has some throttling but the drift pattern still shows). The source
 *   app's choice (verified by Phase 1.6 implementation plan, row
 *   "1.6 sleep/") is to ship the detector in a worker; we preserve
 *   that.
 *
 * Lifecycle:
 *   1. `start()` — create the worker via `workerFactory`, attach the
 *      message listener, prime `lastTickAt = clock.now()`. Idempotent.
 *   2. `stop()` — `terminate()` the worker, detach the listener. Idempotent.
 *   3. `isRunning()` — `true` between `start()` and `stop()`.
 */
export class SleepDetector {
  private readonly onWake: (sleepDurationMs: number) => void;
  private readonly pollIntervalMs: number;
  private readonly driftToleranceMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly workerFactory: () => SleepWorker;

  private worker: SleepWorker | null = null;
  private lastTickAt: number = 0;
  private messageListener:
    | ((event: MessageEvent<unknown>) => void)
    | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;

  constructor(deps: SleepDetectorDeps) {
    this.onWake = deps.onWake;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.driftToleranceMs =
      deps.driftToleranceMs ?? DEFAULT_DRIFT_TOLERANCE_MS;
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.workerFactory = deps.workerFactory ?? defaultWorkerFactory;
  }

  /**
   * Start sleep detection. Spins up the worker and starts listening
   * for ticks. Idempotent — a second `start()` is a no-op (it does
   * NOT recreate the worker; tests pinning that should call `stop()`
   * first).
   */
  start(): void {
    if (this.worker !== null) {
      return;
    }
    this.lastTickAt = this.clock.now();
    this.worker = this.workerFactory();
    this.messageListener = (event) => this.onTick(event);
    this.errorListener = (event) => {
      // ErrorEvent's `message` is a `string`; if a worker post throws,
      // we surface the message at warn level. Not fatal — the next
      // tick may still arrive.
      this.logger.warn("sleep-detector: worker error", {
        message: event.message,
      });
    };
    this.worker.addEventListener("message", this.messageListener);
    this.worker.addEventListener("error", this.errorListener);
    this.logger.debug("sleep-detector: started", {
      pollIntervalMs: this.pollIntervalMs,
      driftToleranceMs: this.driftToleranceMs,
    });
  }

  /**
   * Stop sleep detection. Terminates the worker and removes listeners.
   * Idempotent — calling it twice does not throw. After `stop()` the
   * detector can be restarted with `start()`, which creates a fresh
   * worker via `workerFactory`.
   */
  stop(): void {
    if (this.worker === null) {
      return;
    }
    if (this.messageListener) {
      this.worker.removeEventListener("message", this.messageListener);
    }
    if (this.errorListener) {
      this.worker.removeEventListener("error", this.errorListener);
    }
    this.worker.terminate();
    this.worker = null;
    this.messageListener = null;
    this.errorListener = null;
    this.logger.debug("sleep-detector: stopped");
  }

  /**
   * `true` between `start()` and `stop()`. Test-only convenience —
   * production code shouldn't branch on this.
   */
  isRunning(): boolean {
    return this.worker !== null;
  }

  /**
   * Handle one worker tick. Public ONLY for symmetry with the source
   * (which inlined this inside the addEventListener arrow). Tests
   * exercise this path by posting messages through the mock worker.
   */
  private onTick(event: MessageEvent<unknown>): void {
    // Defensive shape check — the worker is library-controlled, but a
    // mis-injected `workerFactory` could send anything.
    const data = event.data;
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { ts?: unknown }).ts !== "number"
    ) {
      this.logger.warn("sleep-detector: unexpected worker message shape", {
        data,
      });
      return;
    }

    const now = this.clock.now();
    const elapsed = now - this.lastTickAt;
    const threshold = this.pollIntervalMs + this.driftToleranceMs;

    if (elapsed > threshold) {
      this.logger.info("sleep-detector: wake detected", {
        elapsedMs: elapsed,
        thresholdMs: threshold,
      });
      try {
        this.onWake(elapsed);
      } catch (err) {
        // Don't let a consumer's wake handler crash the listener.
        // Log + continue; the next tick still updates `lastTickAt`.
        this.logger.error("sleep-detector: onWake callback threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.lastTickAt = now;
  }
}
