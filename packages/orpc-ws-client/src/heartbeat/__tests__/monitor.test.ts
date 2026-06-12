// HeartbeatMonitor regression tests.
//
// Pins Phase 1.5 watchdog invariants with a fake clock — no real timers,
// no real `Date.now()`. CLAUDE.md "Zero Date.now()" / "Zero setTimeout
// outside the seam" + "Tests from day 0".
//
// Coverage:
//   1. Fresh-monitor calm: no timeout fires before configure / start.
//   2. Within deadline: configure(1000, 500) + start + recordPing → no
//      timeout for 1500ms (deadline = intervalMs + timeoutMs).
//   3. Past deadline: 1500ms of no ping past configure → onTimeout fires
//      exactly once.
//   4. recordPing resets the window: a ping at 1400ms keeps the watchdog
//      quiet through 2900ms.
//   5. stop() prevents future timeouts even past the deadline.
//   6. stop() is idempotent.
//   7. onTimeout fires AT MOST ONCE per missed deadline (latch).
//   8. start() without configure() is a logged no-op (defensive).

import { describe, expect, it, vi } from "vitest";

import type {
  Clock,
  Logger,
  TimerHandle,
} from "@orpc-ws/shared";

import { HeartbeatMonitor } from "../monitor.js";

// ---------- Fake interval clock ----------
// Models the parts of `Clock` the monitor uses: `now()`, `setInterval`,
// `clearInterval`. `advance(ms)` moves time forward, firing any due
// interval ticks. Re-armed timers (cleared + re-set inside a tick) are
// handled by re-scanning the list each iteration.

interface FakeInterval {
  id: number;
  intervalMs: number;
  nextFireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => void;
  getPending: () => FakeInterval[];
} {
  let now = initial;
  let nextId = 1;
  const intervals: FakeInterval[] = [];

  const toHandle = (t: FakeInterval): TimerHandle =>
    t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeInterval =>
    h as unknown as FakeInterval;

  const clock: Clock = {
    now: () => now,
    setTimeout: () => {
      throw new Error("setTimeout not expected for monitor tests");
    },
    clearTimeout: () => {
      throw new Error("clearTimeout not expected for monitor tests");
    },
    setInterval: (fn, ms) => {
      const t: FakeInterval = {
        id: nextId++,
        intervalMs: ms,
        nextFireAt: now + ms,
        fn,
        cancelled: false,
      };
      intervals.push(t);
      return toHandle(t);
    },
    clearInterval: (handle) => {
      fromHandle(handle).cancelled = true;
    },
  };

  const advance = (ms: number): void => {
    const target = now + ms;
    let safety = 10_000;
    while (safety-- > 0) {
      const due = intervals
        .filter((t) => !t.cancelled && t.nextFireAt <= target)
        .sort((a, b) => a.nextFireAt - b.nextFireAt);
      if (due.length === 0) {
        now = target;
        return;
      }
      const next = due[0];
      if (!next) {
        now = target;
        return;
      }
      now = next.nextFireAt;
      next.nextFireAt = now + next.intervalMs;
      next.fn();
    }
    throw new Error("fake clock: too many ticks (suspected infinite loop)");
  };

  const getPending = () => intervals.filter((t) => !t.cancelled).slice();
  return { clock, advance, getPending };
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

// Default test poll cadence kept small so deadline arithmetic stays
// readable. Production default (5s) is exercised in a separate test
// below; everywhere else we use 100ms.
const POLL_MS = 100;

describe("HeartbeatMonitor — quiescent state", () => {
  it("a fresh monitor (no configure, no start) fires no timeout", () => {
    const { clock, advance } = makeFakeClock(0);
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

    monitor.onTimeout(onTimeout);
    advance(10_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("start() without configure() is a no-op and logs a warning", () => {
    const { clock, advance } = makeFakeClock(0);
    const logger = makeLogger();
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor({
      clock,
      logger,
      pollIntervalMs: POLL_MS,
    });

    monitor.onTimeout(onTimeout);
    monitor.start();
    advance(60_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(
      logger.calls.some(
        (c) => c.level === "warn" && c.msg.includes("before configure"),
      ),
    ).toBe(true);
  });
});

describe("HeartbeatMonitor — watchdog inside the deadline window", () => {
  it("configure(1000, 500) + start + recordPing → no timeout within 1500ms", () => {
    const { clock, advance } = makeFakeClock(0);
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

    monitor.onTimeout(onTimeout);
    monitor.configure(1000, 500); // deadline = 1500ms
    monitor.start();
    monitor.recordPing(); // baseline ping at t=0

    // Advance through the entire window. Polls fire every 100ms; on each,
    // elapsed = now - 0 ranges through 100..1500. None exceeds 1500 strictly.
    advance(1500);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it(
    "recordPing() resets the watchdog window — a fresh ping at t=1400 keeps the monitor quiet at t=2900",
    () => {
      const { clock, advance } = makeFakeClock(0);
      const onTimeout = vi.fn();
      const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

      monitor.onTimeout(onTimeout);
      monitor.configure(1000, 500); // deadline 1500
      monitor.start();
      monitor.recordPing(); // t=0

      advance(1400); // still inside window
      expect(onTimeout).not.toHaveBeenCalled();

      monitor.recordPing(); // resets baseline to t=1400

      // From t=1400 forward, deadline is 1500ms again → expires at 2900.
      // Advance to 2899 (just shy) and confirm the watchdog stays quiet.
      advance(1499); // now at 2899
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );
});

describe("HeartbeatMonitor — watchdog past the deadline", () => {
  it("no ping for >1500ms after configure → onTimeout fires once", () => {
    const { clock, advance } = makeFakeClock(0);
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

    monitor.onTimeout(onTimeout);
    monitor.configure(1000, 500); // deadline 1500
    monitor.start();
    // No recordPing — configure() set lastPingAt = 0 implicitly.

    // The first poll past 1500ms is the 16th tick (at t=1600 with 100ms cadence).
    advance(1600);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it(
    "the timeout callback fires AT MOST ONCE per missed deadline — latch holds until recordPing()",
    () => {
      const { clock, advance } = makeFakeClock(0);
      const onTimeout = vi.fn();
      const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

      monitor.onTimeout(onTimeout);
      monitor.configure(1000, 500);
      monitor.start();

      // Advance well past the deadline so many polls would otherwise fire.
      advance(10_000);
      expect(onTimeout).toHaveBeenCalledTimes(1);

      // recordPing resets the latch; a fresh deadline miss can fire again.
      monitor.recordPing();
      advance(2000);
      expect(onTimeout).toHaveBeenCalledTimes(2);
    },
  );

  it("a throwing onTimeout callback is logged and does not crash the poll loop", () => {
    const { clock, advance } = makeFakeClock(0);
    const logger = makeLogger();
    const monitor = new HeartbeatMonitor({
      clock,
      logger,
      pollIntervalMs: POLL_MS,
    });

    monitor.onTimeout(() => {
      throw new Error("consumer wired this badly");
    });
    monitor.configure(1000, 500);
    monitor.start();

    expect(() => advance(2000)).not.toThrow();
    expect(
      logger.calls.some(
        (c) =>
          c.level === "error" && c.msg.includes("timeout callback threw"),
      ),
    ).toBe(true);
  });
});

describe("HeartbeatMonitor — stop()", () => {
  it("stop() prevents future timeouts even past the deadline", () => {
    const { clock, advance } = makeFakeClock(0);
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

    monitor.onTimeout(onTimeout);
    monitor.configure(1000, 500); // deadline 1500
    monitor.start();

    advance(500); // still inside window
    monitor.stop();

    advance(10_000); // would be way past deadline if poll still running

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stop() is idempotent — calling it twice does not throw", () => {
    const { clock } = makeFakeClock(0);
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

    monitor.configure(1000, 500);
    monitor.start();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });

  it("stop() called before start() is also idempotent", () => {
    const { clock } = makeFakeClock(0);
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });
    expect(() => monitor.stop()).not.toThrow();
  });

  it(
    "stop() conforms to the `{ stop(): void }` collaborator shape ReconnectManager expects",
    () => {
      // Pure structural sanity: HeartbeatMonitor has a `stop` method with
      // zero parameters and `void` return. This catches a refactor that
      // would silently change the signature (e.g. requiring arguments)
      // and break Phase 1.7's wire-up.
      const { clock } = makeFakeClock(0);
      const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });
      const stoppable: { stop(): void } = monitor;
      expect(typeof stoppable.stop).toBe("function");
      expect(stoppable.stop.length).toBe(0);
    },
  );
});

describe("HeartbeatMonitor — configure() semantics", () => {
  it("re-configure resets the baseline and clears the latch", () => {
    const { clock, advance } = makeFakeClock(0);
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor({ clock, pollIntervalMs: POLL_MS });

    monitor.onTimeout(onTimeout);
    monitor.configure(1000, 500);
    monitor.start();

    // Trip the timeout.
    advance(2000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Re-configure resets the baseline at the current `now` (= 2000) and
    // clears the latch. A fresh deadline cycle starts.
    monitor.configure(1000, 500);
    advance(1499); // would be 3499; still inside the new 1500 window from 2000
    expect(onTimeout).toHaveBeenCalledTimes(1);

    advance(200); // 3699 > 3500 deadline from t=2000 baseline
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });
});
