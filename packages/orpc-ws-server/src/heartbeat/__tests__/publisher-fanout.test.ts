// Phase 4 — heartbeat publisher fanout: single timer, N subscribers.
//
// Phase 3 left a cross-phase note: the publisher must register EXACTLY ONE
// `setInterval` regardless of how many AsyncIterable subscribers are
// attached. That's the load-bearing O(1) cost property. The existing
// publisher.test.ts "start() is idempotent" check approximated it by
// observing pings-per-interval, but did not directly assert the
// `setInterval` call count.
//
// This file pins it directly: we wrap the test clock with a `vi.fn()`
// spy on `setInterval` and assert the exact call count after `start()` +
// `subscribe()` × N.

import { describe, expect, it, vi } from "vitest";

import {
  type Clock,
  type HeartbeatEvent,
  type TimerHandle,
} from "@repo/orpc-ws-shared";

import { HeartbeatPublisher } from "../publisher.js";

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  interval: number | null;
  cancelled: boolean;
}

/**
 * Same fake clock as publisher.test.ts but wraps `setInterval` /
 * `clearInterval` in `vi.fn()` spies so tests can inspect call counts
 * directly. Sharing the clock would have required exposing internal
 * counters; per the Phase 4 brief, we either extend the Clock interface
 * with `getActiveTimerCount()` or use a vi.fn-backed seam. The vi.fn
 * route is local to this test and doesn't widen the public Clock surface.
 */
function makeSpyingFakeClock(initial = 0): {
  clock: Clock;
  setIntervalSpy: ReturnType<typeof vi.fn>;
  clearIntervalSpy: ReturnType<typeof vi.fn>;
  advance: (ms: number) => Promise<void>;
} {
  let now = initial;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const toHandle = (t: FakeTimer): TimerHandle => t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeTimer => h as unknown as FakeTimer;

  const setIntervalSpy = vi.fn((fn: () => void, ms: number): TimerHandle => {
    const t: FakeTimer = {
      id: nextId++,
      fireAt: now + ms,
      fn,
      interval: ms,
      cancelled: false,
    };
    timers.push(t);
    return toHandle(t);
  });

  const clearIntervalSpy = vi.fn((h: TimerHandle): void => {
    fromHandle(h).cancelled = true;
  });

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = {
        id: nextId++,
        fireAt: now + ms,
        fn,
        interval: null,
        cancelled: false,
      };
      timers.push(t);
      return toHandle(t);
    },
    clearTimeout: (h) => {
      fromHandle(h).cancelled = true;
    },
    setInterval: (fn, ms) => setIntervalSpy(fn, ms),
    clearInterval: (h) => clearIntervalSpy(h),
  };

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    let safety = 5000;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      if (!next) break;
      now = next.fireAt;
      if (next.interval !== null) {
        next.fireAt = now + next.interval;
      } else {
        const idx = timers.indexOf(next);
        if (idx >= 0) timers.splice(idx, 1);
      }
      try {
        next.fn();
      } catch {
        // tests assert on side effects
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  return { clock, setIntervalSpy, clearIntervalSpy, advance };
}

describe("HeartbeatPublisher — fanout: single timer, N subscribers", () => {
  it("registers exactly ONE setInterval regardless of subscriber count", async () => {
    const { clock, setIntervalSpy, advance } = makeSpyingFakeClock();
    const config = { intervalMs: 100, timeoutMs: 50, pingPong: false };
    const publisher = new HeartbeatPublisher({ config, clock });

    // No timer should be created at construction. start() owns the
    // setInterval call; subscribe() does NOT.
    expect(setIntervalSpy).toHaveBeenCalledTimes(0);

    publisher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    // The single interval is wired to the configured cadence.
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(100);

    // Attach 5 concurrent subscribers. None of them should add a timer.
    const N = 5;
    const controllers: AbortController[] = [];
    const received: HeartbeatEvent[][] = [];
    const drains: Promise<void>[] = [];

    for (let i = 0; i < N; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      received.push([]);
      const iter = publisher.subscribe(controller.signal);
      const idx = i;
      drains.push(
        (async () => {
          try {
            for await (const evt of iter) {
              received[idx]!.push(evt);
            }
          } catch {
            // abort surfaces here — silent
          }
        })(),
      );
    }

    // Let all subscribers settle into their inner publisher.subscribe()
    // listener registration.
    for (let k = 0; k < 10; k++) await Promise.resolve();

    // O(1) timer property: exactly ONE setInterval, no matter how many
    // subscribers attached.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // Each subscriber has its config event already.
    for (let i = 0; i < N; i++) {
      expect(received[i]?.length).toBeGreaterThanOrEqual(1);
      expect(received[i]?.[0]?.type).toBe("config");
    }

    // Advance one interval. Every subscriber should receive exactly one
    // ping event (5 subscribers × 1 tick × 1 fan-out = 5 pings total,
    // never 5²).
    await advance(100);
    for (let k = 0; k < 10; k++) await Promise.resolve();

    for (let i = 0; i < N; i++) {
      const pings = received[i]!.filter((e) => e.type === "ping");
      expect(pings.length).toBe(1);
    }

    // Still only one timer after the tick.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    controllers.forEach((c) => c.abort());
    publisher.stop();
    await Promise.all(drains);
  });

  it("stop() then start() reuses the publisher but does NOT leak the prior timer", async () => {
    const { clock, setIntervalSpy, clearIntervalSpy, advance } =
      makeSpyingFakeClock();
    const config = { intervalMs: 100, timeoutMs: 50, pingPong: false };
    const publisher = new HeartbeatPublisher({ config, clock });

    publisher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    publisher.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // A second start cycle creates exactly ONE more timer (cumulative 2).
    publisher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    // Cancellation count stays at 1 — the new timer is still live until
    // the next stop. (Sanity: clear was not double-called by mistake.)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // Quick smoke: a single subscriber still receives pings via the new
    // timer.
    const controller = new AbortController();
    const iter = publisher.subscribe(controller.signal);
    const events: HeartbeatEvent[] = [];
    const drain = (async () => {
      try {
        for await (const evt of iter) {
          events.push(evt);
          if (events.length >= 2) break;
        }
      } catch {
        // ignore
      }
    })();
    for (let k = 0; k < 5; k++) await Promise.resolve();
    await advance(100);
    for (let k = 0; k < 5; k++) await Promise.resolve();

    expect(events.find((e) => e.type === "ping")).toBeDefined();

    controller.abort();
    publisher.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    await drain;
  });
});
