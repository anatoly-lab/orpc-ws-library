// Heartbeat last-wins subscription bound (decided 2026-07-02).
//
// One WS connection could previously call the stealth heartbeat procedure
// unbounded times; every call parked an EventPublisher subscriber +
// generator that was only freed at disconnect — unauthenticated
// per-connection memory growth in authless mode. The decided semantics:
// a NEW heartbeat subscription carrying the same connection identity
// gracefully ENDS the previous live one (last-wins), so per-connection
// memory is strictly bounded at 1. Five behaviors pinned:
//
//   1. Same connection subscribes twice → the FIRST stream ends
//      gracefully (clean `done`, no throw); the second stays live.
//      (Would fail pre-fix: the first kept streaming forever.)
//   2. The bound is strict: N subscribes on one connection leave exactly
//      ONE inner fan-out subscriber. (Would fail pre-fix: N.)
//   3. Two DIFFERENT connections each keep their own live subscription —
//      last-wins never crosses connections.
//   4. Disconnect cleanup is intact: after a supersede, aborting the
//      SURVIVOR's transport signal frees everything (fan-out width 0).
//   5. Identity-less subscriptions (the HTTP transport / direct calls)
//      stay untracked and coexist — pre-existing behavior.

import { describe, expect, it } from "vitest";

import {
  type Clock,
  type HeartbeatEvent,
  type TimerHandle,
} from "@orpc-ws/shared";

import { HeartbeatPublisher } from "../publisher.js";

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  interval: number | null;
  cancelled: boolean;
}

/**
 * Fake clock with manual `advance(ms)` — same helper shape as
 * `publisher.test.ts` (setInterval support needed; the publisher ticks).
 */
function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
} {
  let now = initial;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const toHandle = (t: FakeTimer): TimerHandle => t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeTimer => h as unknown as FakeTimer;

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
    setInterval: (fn, ms) => {
      const t: FakeTimer = {
        id: nextId++,
        fireAt: now + ms,
        fn,
        interval: ms,
        cancelled: false,
      };
      timers.push(t);
      return toHandle(t);
    },
    clearInterval: (h) => {
      fromHandle(h).cancelled = true;
    },
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
        // tests assert on side effects, not throws from the timer body
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  return { clock, advance };
}

/** Flush enough microtasks for generators to attach / settle. */
async function pump(): Promise<void> {
  for (let k = 0; k < 10; k++) await Promise.resolve();
}

interface Drain {
  events: HeartbeatEvent[];
  /** Resolves when the for-await exits — however it exits. */
  done: Promise<void>;
  state: { ended: boolean; threw: boolean };
}

/** Background-drain a subscription, recording events + how it exited. */
function drain(iter: AsyncIterableIterator<HeartbeatEvent>): Drain {
  const events: HeartbeatEvent[] = [];
  const state = { ended: false, threw: false };
  const done = (async () => {
    try {
      for await (const evt of iter) {
        events.push(evt);
      }
    } catch {
      state.threw = true;
    }
    state.ended = true;
  })();
  return { events, done, state };
}

const CONFIG = { intervalMs: 50, timeoutMs: 25, pingPong: false };

describe("HeartbeatPublisher — last-wins per connection", () => {
  it("a second subscription on the SAME connection gracefully ends the first; the second stays live", async () => {
    const { clock, advance } = makeFakeClock();
    const publisher = new HeartbeatPublisher({ config: CONFIG, clock });
    publisher.start();

    // Stand-in for the connection's ws object — the publisher only needs
    // a stable object identity (WeakMap key).
    const conn = {};

    const c1 = new AbortController();
    const d1 = drain(publisher.subscribe(c1.signal, conn));
    await pump();
    await advance(50);
    await pump();

    // First subscription is genuinely live: config + at least one ping.
    expect(d1.events[0]?.type).toBe("config");
    expect(d1.events.some((e) => e.type === "ping")).toBe(true);

    // Second subscription on the SAME connection → last-wins.
    const c2 = new AbortController();
    const d2 = drain(publisher.subscribe(c2.signal, conn));
    await pump();

    // The FIRST stream ended GRACEFULLY (clean done, no error) without
    // its own transport signal ever firing. Pre-fix this await hangs —
    // the first subscription kept streaming until disconnect.
    await d1.done;
    expect(d1.state.ended).toBe(true);
    expect(d1.state.threw).toBe(false);

    // First is frozen; second receives subsequent pings.
    const frozen = d1.events.length;
    await advance(100);
    await pump();
    expect(d1.events.length).toBe(frozen);
    expect(d2.events[0]?.type).toBe("config");
    expect(d2.events.filter((e) => e.type === "ping").length)
      .toBeGreaterThanOrEqual(1);

    c2.abort();
    await d2.done;
    publisher.stop();
  });

  it("bounds fan-out strictly at ONE inner subscriber per connection", async () => {
    const { clock, advance } = makeFakeClock();
    const publisher = new HeartbeatPublisher({ config: CONFIG, clock });
    publisher.start();

    const conn = {};
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const drains = controllers.map((c) =>
      drain(publisher.subscribe(c.signal, conn)),
    );
    await pump();
    await advance(50);
    await pump();

    // Three subscribes, ONE live fan-out subscriber (pre-fix: 3).
    expect(publisher.subscriberCount()).toBe(1);

    // Only the LAST drain is still receiving.
    expect(drains[0]!.state.ended).toBe(true);
    expect(drains[1]!.state.ended).toBe(true);
    expect(drains[2]!.state.ended).toBe(false);
    expect(drains[2]!.events.some((e) => e.type === "ping")).toBe(true);

    controllers[2]!.abort();
    await drains[2]!.done;
    publisher.stop();
  });

  it("two DIFFERENT connections each keep their own live subscription", async () => {
    const { clock, advance } = makeFakeClock();
    const publisher = new HeartbeatPublisher({ config: CONFIG, clock });
    publisher.start();

    const connA = {};
    const connB = {};
    const cA = new AbortController();
    const cB = new AbortController();
    const dA = drain(publisher.subscribe(cA.signal, connA));
    const dB = drain(publisher.subscribe(cB.signal, connB));
    await pump();
    await advance(50);
    await pump();

    // B's subscribe did NOT end A's — different identities never collide.
    expect(dA.state.ended).toBe(false);
    expect(dB.state.ended).toBe(false);
    expect(dA.events.some((e) => e.type === "ping")).toBe(true);
    expect(dB.events.some((e) => e.type === "ping")).toBe(true);
    expect(publisher.subscriberCount()).toBe(2);

    // A resubscribes: only A's previous stream ends; B is untouched.
    const cA2 = new AbortController();
    const dA2 = drain(publisher.subscribe(cA2.signal, connA));
    await pump();
    expect(dA.state.ended).toBe(true);
    expect(dB.state.ended).toBe(false);

    cA2.abort();
    cB.abort();
    await Promise.all([dA2.done, dB.done]);
    publisher.stop();
  });

  it("disconnect still frees everything after a supersede — fan-out width returns to 0", async () => {
    const { clock, advance } = makeFakeClock();
    const publisher = new HeartbeatPublisher({ config: CONFIG, clock });
    publisher.start();

    const conn = {};
    const c1 = new AbortController();
    const d1 = drain(publisher.subscribe(c1.signal, conn));
    await pump();
    const c2 = new AbortController();
    const d2 = drain(publisher.subscribe(c2.signal, conn));
    await pump();
    await advance(50);
    await pump();

    // Replaced one already freed; survivor live.
    await d1.done;
    expect(publisher.subscriberCount()).toBe(1);

    // Disconnect (ORPC aborts the transport signal) frees the survivor —
    // the pre-existing cleanup path is intact under the new wiring.
    c2.abort();
    await d2.done;
    await pump();
    expect(publisher.subscriberCount()).toBe(0);

    publisher.stop();
  });

  it("identity-less subscriptions (HTTP transport / direct calls) stay untracked and coexist", async () => {
    const { clock, advance } = makeFakeClock();
    const publisher = new HeartbeatPublisher({ config: CONFIG, clock });
    publisher.start();

    const c1 = new AbortController();
    const c2 = new AbortController();
    // No connection identity → no last-wins bookkeeping (back-compat).
    const d1 = drain(publisher.subscribe(c1.signal));
    const d2 = drain(publisher.subscribe(c2.signal));
    await pump();
    await advance(50);
    await pump();

    expect(d1.state.ended).toBe(false);
    expect(d2.state.ended).toBe(false);
    expect(d1.events.some((e) => e.type === "ping")).toBe(true);
    expect(d2.events.some((e) => e.type === "ping")).toBe(true);

    c1.abort();
    c2.abort();
    await Promise.all([d1.done, d2.done]);
    publisher.stop();
  });
});
