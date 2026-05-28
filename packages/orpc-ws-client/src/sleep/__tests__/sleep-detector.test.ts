// SleepDetector regression tests.
//
// Pins Phase 1.6 drift-detection invariants with a fake clock + mock
// worker — no real timers, no real `Date.now()`, no real Worker. The
// fake worker is structurally compatible with `SleepWorker` and gives
// the test full control over WHEN ticks arrive (the worker's real
// `setInterval` is irrelevant for these tests; we synthesize the ticks).
//
// CLAUDE.md "Zero Date.now()" / "Zero setTimeout outside the seam" +
// "Tests from day 0".
//
// Coverage (≥5 required by Phase 1.6 spec):
//   1. Fresh detector: isRunning() === false; no worker created.
//   2. start() → isRunning() === true; worker created via factory.
//   3. stop() → isRunning() === false; worker.terminate called; listener
//      detached.
//   4. Normal ticks (elapsed ≈ poll interval) → no wake event.
//   5. One huge tick (elapsed >> pollInterval + driftTolerance) →
//      onWake called with elapsed.
//   6. Two huge ticks → onWake called twice (each tick is its own
//      potential sleep window).
//   7. stop() is idempotent.
//   8. start() is idempotent (does NOT recreate the worker mid-flight).
//   9. start() after stop() spins up a fresh worker.
//  10. Worker error message → logged at warn level; detector keeps running.
//  11. Malformed worker message → logged at warn level; lastTickAt not
//      bumped, so subsequent valid ticks still measure from the prior
//      good baseline.
//  12. Throwing onWake callback → logged; detector keeps running.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, TimerHandle } from "@repo/orpc-ws-shared";

import { SleepDetector, type SleepWorker } from "../sleep-detector.js";

// ---------- Fake monotonic clock ----------
// SleepDetector only uses `clock.now()`. The setTimeout/setInterval seams
// throw to catch any accidental drift back into raw timers.

function makeFakeClock(initial = 0): {
  clock: Clock;
  setNow: (t: number) => void;
  advance: (ms: number) => void;
} {
  let now = initial;
  const clock: Clock = {
    now: () => now,
    setTimeout: () => {
      throw new Error("setTimeout not expected in SleepDetector");
    },
    clearTimeout: () => {
      throw new Error("clearTimeout not expected in SleepDetector");
    },
    setInterval: () => {
      throw new Error("setInterval not expected in SleepDetector");
    },
    clearInterval: () => {
      throw new Error("clearInterval not expected in SleepDetector");
    },
  };
  // `TimerHandle` is referenced only by the seam types above; pin it so
  // the import isn't flagged as unused.
  const _t: TimerHandle | null = null;
  void _t;
  return {
    clock,
    setNow: (t) => {
      now = t;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

// ---------- Mock worker ----------
// Implements the narrow `SleepWorker` surface. Tests post messages
// directly via `tick(ts)`, which calls every registered `message`
// listener (in practice, the SleepDetector registers exactly one).
//
// `terminate` is a `vi.fn()` so tests can assert it was called; the
// listeners are tracked so we can verify `removeEventListener` was
// honored on stop().

interface MockWorker extends SleepWorker {
  readonly terminate: ReturnType<typeof vi.fn>;
  readonly messageListeners: Array<(event: MessageEvent<unknown>) => void>;
  readonly errorListeners: Array<(event: ErrorEvent) => void>;
  tick(ts: number): void;
  postMalformed(data: unknown): void;
  emitError(message: string): void;
}

function makeMockWorker(): MockWorker {
  const messageListeners: Array<(event: MessageEvent<unknown>) => void> = [];
  const errorListeners: Array<(event: ErrorEvent) => void> = [];
  const terminate = vi.fn();

  return {
    addEventListener: ((type, listener) => {
      if (type === "message") {
        messageListeners.push(
          listener as (event: MessageEvent<unknown>) => void,
        );
      } else if (type === "error") {
        errorListeners.push(listener as (event: ErrorEvent) => void);
      }
    }) as SleepWorker["addEventListener"],
    removeEventListener: ((type, listener) => {
      const list = type === "message" ? messageListeners : errorListeners;
      const idx = list.indexOf(listener as never);
      if (idx >= 0) list.splice(idx, 1);
    }) as SleepWorker["removeEventListener"],
    terminate,
    messageListeners,
    errorListeners,
    tick(ts: number) {
      const event = { data: { ts } } as MessageEvent<unknown>;
      messageListeners.forEach((l) => l(event));
    },
    postMalformed(data: unknown) {
      const event = { data } as MessageEvent<unknown>;
      messageListeners.forEach((l) => l(event));
    },
    emitError(message: string) {
      const event = { message } as ErrorEvent;
      errorListeners.forEach((l) => l(event));
    },
  };
}

function makeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = [];
  return {
    debug: (msg) => calls.push({ level: "debug", msg }),
    info: (msg) => calls.push({ level: "info", msg }),
    warn: (msg) => calls.push({ level: "warn", msg }),
    error: (msg) => calls.push({ level: "error", msg }),
    calls,
  };
}

// Defaults the tests use. Keeping them small (and unequal to the
// production defaults) makes wake-event math readable and ensures the
// fake clock — not the production constants — drives every assertion.
const POLL_MS = 1_000;
const DRIFT_MS = 500;
const THRESHOLD_MS = POLL_MS + DRIFT_MS; // 1500

describe("SleepDetector — lifecycle (start / stop / isRunning)", () => {
  it("a fresh detector is not running and has not created a worker", () => {
    const onWake = vi.fn();
    const workerFactory = vi.fn(() => makeMockWorker());
    const { clock } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory,
    });

    expect(detector.isRunning()).toBe(false);
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("start() creates the worker via factory and marks the detector running", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const workerFactory = vi.fn(() => worker);
    const { clock } = makeFakeClock(1_000);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory,
    });
    detector.start();

    expect(detector.isRunning()).toBe(true);
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(worker.messageListeners).toHaveLength(1);
    expect(worker.errorListeners).toHaveLength(1);
  });

  it("stop() terminates the worker, removes listeners, and clears running state", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const workerFactory = vi.fn(() => worker);
    const { clock } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory,
    });
    detector.start();
    detector.stop();

    expect(detector.isRunning()).toBe(false);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.messageListeners).toHaveLength(0);
    expect(worker.errorListeners).toHaveLength(0);
  });

  it("stop() is idempotent — calling it twice does not throw and does not double-terminate", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const workerFactory = vi.fn(() => worker);
    const { clock } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory,
    });
    detector.start();
    detector.stop();
    expect(() => detector.stop()).not.toThrow();
    // The terminate count stays at 1 — the second stop() short-circuits.
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("stop() before start() is also idempotent", () => {
    const onWake = vi.fn();
    const workerFactory = vi.fn(() => makeMockWorker());
    const { clock } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      clock,
      workerFactory,
    });

    expect(() => detector.stop()).not.toThrow();
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("start() is idempotent — a second call does not recreate the worker", () => {
    const onWake = vi.fn();
    const workerFactory = vi.fn(() => makeMockWorker());
    const { clock } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      clock,
      workerFactory,
    });
    detector.start();
    detector.start();

    expect(workerFactory).toHaveBeenCalledTimes(1);
  });

  it("start() after stop() spins up a fresh worker", () => {
    const onWake = vi.fn();
    const workers: MockWorker[] = [];
    const workerFactory = vi.fn(() => {
      const w = makeMockWorker();
      workers.push(w);
      return w;
    });
    const { clock } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      clock,
      workerFactory,
    });
    detector.start();
    detector.stop();
    detector.start();

    expect(workerFactory).toHaveBeenCalledTimes(2);
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(workers[1]?.terminate).not.toHaveBeenCalled();
  });
});

describe("SleepDetector — drift detection", () => {
  it("normal ticks (elapsed ≈ pollInterval) do NOT fire onWake", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const { clock, advance } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory: () => worker,
    });
    detector.start();
    // lastTickAt = 0 (clock.now() at start).

    // Three on-time ticks. Elapsed is POLL_MS each time, which is strictly
    // less than POLL_MS + DRIFT_MS = THRESHOLD_MS.
    advance(POLL_MS);
    worker.tick(clock.now());
    advance(POLL_MS);
    worker.tick(clock.now());
    advance(POLL_MS);
    worker.tick(clock.now());

    expect(onWake).not.toHaveBeenCalled();
  });

  it("on-time-with-jitter (elapsed = pollInterval + a fraction of drift tolerance) does NOT fire onWake", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const { clock, advance } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory: () => worker,
    });
    detector.start();

    // Elapsed = 1499ms = THRESHOLD_MS - 1; just under the wake bar.
    advance(THRESHOLD_MS - 1);
    worker.tick(clock.now());

    expect(onWake).not.toHaveBeenCalled();
  });

  it(
    "one huge tick (elapsed >> pollInterval + driftTolerance) fires onWake with the elapsed duration",
    () => {
      const onWake = vi.fn();
      const worker = makeMockWorker();
      const { clock, advance } = makeFakeClock(0);

      const detector = new SleepDetector({
        onWake,
        pollIntervalMs: POLL_MS,
        driftToleranceMs: DRIFT_MS,
        clock,
        workerFactory: () => worker,
      });
      detector.start();

      // Simulate 60s of OS sleep. clock.now() jumps to 60_000.
      advance(60_000);
      worker.tick(clock.now());

      expect(onWake).toHaveBeenCalledTimes(1);
      // The detector reports the elapsed wall-clock time as the estimate.
      expect(onWake).toHaveBeenCalledWith(60_000);
    },
  );

  it("two huge ticks in succession fire onWake twice (each is its own sleep window)", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const { clock, advance } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      workerFactory: () => worker,
    });
    detector.start();

    // First sleep: 30s.
    advance(30_000);
    worker.tick(clock.now());
    // Second sleep: 45s right after, without intervening normal ticks.
    advance(45_000);
    worker.tick(clock.now());

    expect(onWake).toHaveBeenCalledTimes(2);
    expect(onWake).toHaveBeenNthCalledWith(1, 30_000);
    expect(onWake).toHaveBeenNthCalledWith(2, 45_000);
  });

  it(
    "a normal tick AFTER a wake tick re-baselines lastTickAt — the next normal cadence does NOT re-fire",
    () => {
      const onWake = vi.fn();
      const worker = makeMockWorker();
      const { clock, advance } = makeFakeClock(0);

      const detector = new SleepDetector({
        onWake,
        pollIntervalMs: POLL_MS,
        driftToleranceMs: DRIFT_MS,
        clock,
        workerFactory: () => worker,
      });
      detector.start();

      // Sleep: 30s.
      advance(30_000);
      worker.tick(clock.now());
      expect(onWake).toHaveBeenCalledTimes(1);

      // Normal cadence resumes. lastTickAt was just bumped to 30_000.
      advance(POLL_MS); // now = 31_000
      worker.tick(clock.now());
      advance(POLL_MS); // now = 32_000
      worker.tick(clock.now());

      expect(onWake).toHaveBeenCalledTimes(1);
    },
  );
});

describe("SleepDetector — defensive behavior", () => {
  it("malformed worker messages are logged at warn level and do NOT bump lastTickAt", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const logger = makeLogger();
    const { clock, advance } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      logger,
      workerFactory: () => worker,
    });
    detector.start();
    // lastTickAt = 0.

    advance(500);
    worker.postMalformed("not an object");
    advance(500);
    worker.postMalformed({ noTs: true });
    advance(500);
    // We've now advanced to 1500 = THRESHOLD_MS; a clean tick here should
    // measure elapsed = 1500 vs lastTickAt = 0, which is NOT > THRESHOLD.
    // (Strict greater-than: 1500 > 1500 is false. No wake.)
    worker.tick(clock.now());
    expect(onWake).not.toHaveBeenCalled();

    // One more advance over the threshold → wake fires, confirming the
    // malformed messages did not silently bump lastTickAt to 500/1000.
    advance(THRESHOLD_MS + 1);
    worker.tick(clock.now());
    expect(onWake).toHaveBeenCalledTimes(1);

    // Both malformed messages logged a warning.
    const warnings = logger.calls.filter(
      (c) => c.level === "warn" && c.msg.includes("unexpected worker message"),
    );
    expect(warnings).toHaveLength(2);
  });

  it("worker error events are logged at warn level and the detector keeps running", () => {
    const onWake = vi.fn();
    const worker = makeMockWorker();
    const logger = makeLogger();
    const { clock, advance } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      logger,
      workerFactory: () => worker,
    });
    detector.start();

    worker.emitError("boom");

    // Detector still running; a subsequent wake-sized tick still fires.
    expect(detector.isRunning()).toBe(true);
    advance(60_000);
    worker.tick(clock.now());
    expect(onWake).toHaveBeenCalledTimes(1);

    const warnings = logger.calls.filter(
      (c) => c.level === "warn" && c.msg.includes("worker error"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("a throwing onWake callback is logged and does not crash the listener", () => {
    const onWake = vi.fn(() => {
      throw new Error("consumer wired this badly");
    });
    const worker = makeMockWorker();
    const logger = makeLogger();
    const { clock, advance } = makeFakeClock(0);

    const detector = new SleepDetector({
      onWake,
      pollIntervalMs: POLL_MS,
      driftToleranceMs: DRIFT_MS,
      clock,
      logger,
      workerFactory: () => worker,
    });
    detector.start();

    advance(60_000);
    expect(() => worker.tick(clock.now())).not.toThrow();

    expect(onWake).toHaveBeenCalledTimes(1);
    const errors = logger.calls.filter(
      (c) => c.level === "error" && c.msg.includes("onWake callback threw"),
    );
    expect(errors).toHaveLength(1);

    // Subsequent wake-sized ticks still fire (lastTickAt was bumped).
    advance(60_000);
    worker.tick(clock.now());
    expect(onWake).toHaveBeenCalledTimes(2);
  });
});
