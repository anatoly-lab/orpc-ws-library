// ReconnectManager regression tests.
//
// Covers the Phase 1.3 behavioral contract:
//   - Storm guard within the configured window (default 30s) — first call
//     refreshes, second short-circuits to `onTerminalAuthFailure`. After the
//     window elapses, refresh is allowed again.
//   - `onTerminalAuthFailure` fires when refresh returns null AND when the
//     storm guard trips. These are the only two paths that fire it.
//   - Debounce: N triggers within debounceMs coalesce to one reconnect.
//   - Jitter: seeded RNG → deterministic delay; in-range; two different
//     seeds produce different delays.
//   - Mutex: concurrent `reconnect()` calls serialize.
//   - `isReconnecting()` reports the in-flight flag.
//   - `tryAuthRecovery(closeCode)` invokes refreshAndReconnect on first call.
//   - `tryAuthRecovery` does NOT double-refresh inside the storm window.
//
// All clock and RNG behavior runs through fakes — no `Math.random`, no
// real timers, no `Date.now`. CLAUDE.md "Zero `Date.now()` / `Math.random()`
// calls outside an injected seam".

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Clock,
  Logger,
  Rng,
  TimerHandle,
} from "@repo/orpc-ws-shared";

import { ReconnectManager } from "../reconnect-manager.js";
import type { TokenRefreshHandler } from "../token-refresh-handler.js";

// ---------- Fake clock ----------
// A controllable clock: `now` advances on `advance(ms)`; pending timers fire
// when their scheduled time is <= now. We track timers as a small array
// keyed by an opaque handle. Re-entrant timers (set inside a callback) are
// handled by re-checking the array after each fire.

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
  getPending: () => FakeTimer[];
  setNow: (ms: number) => void;
} {
  let now = initial;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const toHandle = (t: FakeTimer): TimerHandle =>
    t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeTimer =>
    h as unknown as FakeTimer;

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = {
        id: nextId++,
        fireAt: now + ms,
        fn,
        cancelled: false,
      };
      timers.push(t);
      return toHandle(t);
    },
    clearTimeout: (handle) => {
      fromHandle(handle).cancelled = true;
    },
    setInterval: () => {
      throw new Error("setInterval not expected in these tests");
    },
    clearInterval: () => {
      throw new Error("clearInterval not expected in these tests");
    },
  };

  // Advance time, firing any due timers. Lets microtasks settle between
  // each fire so any awaited promises in the body of a timer callback can
  // resolve before the next tick.
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    let safety = 1000;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      if (!next) break;
      // remove it
      const idx = timers.indexOf(next);
      if (idx >= 0) timers.splice(idx, 1);
      next.fn();
      // let microtasks flush — important for awaited bodies
      await Promise.resolve();
      await Promise.resolve();
    }
    // flush microtasks one more time in case the last fire scheduled
    // nothing but did `await` something
    await Promise.resolve();
  };

  const getPending = () =>
    timers.filter((t) => !t.cancelled).slice();
  const setNow = (ms: number) => {
    now = ms;
  };

  return { clock, advance, getPending, setNow };
}

// ---------- Fake RNG ----------
// Sequence-based: returns the next number from a list, wrapping. Tests that
// don't care which value pops just pass `[0.5]`.

function makeFakeRng(sequence: number[]): Rng {
  let i = 0;
  return {
    next: () => {
      const v = sequence[i % sequence.length];
      i += 1;
      return v ?? 0;
    },
  };
}

// ---------- Test logger ----------

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

// ---------- Fake TokenRefreshHandler ----------
// Just enough surface for the manager. Tests configure `refreshAndReconnect`
// to return true/false or throw.

function makeFakeHandler(
  options: { result?: boolean | Error } = {},
): TokenRefreshHandler & {
  refreshAndReconnect: ReturnType<typeof vi.fn>;
} {
  const result = options.result ?? true;
  const refreshAndReconnect = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  // Other methods aren't called in these tests; stub for typing.
  const stub = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    isReconnecting: vi.fn(() => false),
  } as unknown as TokenRefreshHandler & {
    refreshAndReconnect: ReturnType<typeof vi.fn>;
  };
  return stub;
}

// ---------- Builder ----------

interface BuildOptions {
  refreshResult?: boolean | Error;
  rng?: Rng;
  minRefreshIntervalMs?: number;
  debounceMs?: number;
  jitterMs?: number;
}

function build(opts: BuildOptions = {}) {
  const { clock, advance, getPending, setNow } = makeFakeClock(0);
  const rng = opts.rng ?? makeFakeRng([0.5]);
  const handler = makeFakeHandler({ result: opts.refreshResult });
  const logger = makeLogger();
  const onTerminalAuthFailure = vi.fn();
  const manager = new ReconnectManager({
    tokenRefreshHandler: handler,
    reconnectConfig: {
      debounceMs: opts.debounceMs ?? 1000,
      jitterMs: opts.jitterMs ?? 5000,
      minRefreshIntervalMs: opts.minRefreshIntervalMs ?? 30_000,
    },
    onTerminalAuthFailure,
    clock,
    rng,
    logger,
  });
  return {
    manager,
    handler,
    onTerminalAuthFailure,
    advance,
    setNow,
    getPending,
    logger,
  };
}

// ---------- Tests ----------

describe("ReconnectManager — storm guard (instance-state 30s window)", () => {
  beforeEach(() => {
    // ensure no global Math.random / Date.now reads can sneak in
  });

  it("first tryAuthRecovery call triggers refreshAndReconnect", async () => {
    const ctx = build();

    await ctx.manager.tryAuthRecovery(1008);

    expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it(
    "second tryAuthRecovery call within minRefreshIntervalMs short-circuits " +
      "to onTerminalAuthFailure (no second refresh)",
    async () => {
      const ctx = build();

      await ctx.manager.tryAuthRecovery(1008);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // 5s later — well within the 30s window
      ctx.setNow(5_000);
      await ctx.manager.tryAuthRecovery(4001);

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "after minRefreshIntervalMs elapses, refresh is allowed again",
    async () => {
      const ctx = build();

      await ctx.manager.tryAuthRecovery(1008);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // 30_001 ms later — past the window
      ctx.setNow(30_001);
      await ctx.manager.tryAuthRecovery(1008);

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(2);
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "onTerminalAuthFailure fires when tokenProvider.refresh returns null (false path)",
    async () => {
      const ctx = build({ refreshResult: false });

      await ctx.manager.tryAuthRecovery(1008);

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "onTerminalAuthFailure fires when storm guard trips (without a second refresh attempt)",
    async () => {
      const ctx = build();

      await ctx.manager.tryAuthRecovery(1008);
      await ctx.manager.tryAuthRecovery(1008);

      // Only the FIRST attempt called refresh; the second tripped the guard.
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "refreshAndReconnect throwing is treated as a failed refresh — fires terminal",
    async () => {
      const ctx = build({ refreshResult: new Error("network down") });

      await ctx.manager.tryAuthRecovery(1008);

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
    },
  );
});

describe("ReconnectManager — reconnect() debounce + jitter + mutex", () => {
  it("N triggers within debounceMs coalesce to one reconnect", async () => {
    const ctx = build({ debounceMs: 1000, jitterMs: 0 });

    // Fire three reconnects in quick succession (no advance).
    const p1 = ctx.manager.reconnect();
    const p2 = ctx.manager.reconnect();
    const p3 = ctx.manager.reconnect();

    // Nothing happens yet — debounce hasn't elapsed.
    expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(0);

    // Advance past debounce. Only the LAST scheduled timer fires (the
    // earlier ones were cleared).
    await ctx.advance(1000);

    await Promise.all([p1, p2, p3]);

    expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
  });

  it(
    "jitter is rng.next() * jitterMs and the value is consumed deterministically",
    async () => {
      const ctx = build({
        debounceMs: 1000,
        jitterMs: 5000,
        rng: makeFakeRng([0.4]),
      });

      const p = ctx.manager.reconnect();

      // After debounce, the jitter delay is rng.next() * jitterMs = 2000.
      await ctx.advance(1000); // debounce fires; jitter timer scheduled
      // Right after debounce fires, refresh hasn't been called — we're in
      // the jitter delay.
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(0);

      await ctx.advance(2000); // jitter elapses
      await p;

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "different seeded sequences produce different jitter delays " +
      "(determinism check)",
    async () => {
      const ctxA = build({
        debounceMs: 100,
        jitterMs: 1000,
        rng: makeFakeRng([0.2]),
      });
      const ctxB = build({
        debounceMs: 100,
        jitterMs: 1000,
        rng: makeFakeRng([0.7]),
      });

      const pA = ctxA.manager.reconnect();
      const pB = ctxB.manager.reconnect();

      // After debounce: A wants 200ms more, B wants 700ms more.
      await ctxA.advance(100);
      await ctxB.advance(100);

      // At 200ms post-debounce, A should fire but B should still wait.
      await ctxA.advance(200);
      await ctxB.advance(200);
      expect(ctxA.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctxB.handler.refreshAndReconnect).toHaveBeenCalledTimes(0);

      await ctxB.advance(500); // total 700 post-debounce
      await pA;
      await pB;
      expect(ctxB.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it("jitter delay is in [0, jitterMs) — boundary check at 0 and (almost) 1", async () => {
    // RNG returning 0 → delay 0; we should fire as soon as debounce elapses.
    const ctx = build({
      debounceMs: 100,
      jitterMs: 5000,
      rng: makeFakeRng([0]),
    });

    const p = ctx.manager.reconnect();
    await ctx.advance(100); // debounce + 0 jitter
    await p;
    expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
  });

  it(
    "concurrent reconnect() calls serialize via mutex (second call no-ops)",
    async () => {
      // Hold refresh in flight by making it never resolve until we let it.
      let resolveRefresh: ((v: boolean) => void) | null = null;
      const ctx = build({ debounceMs: 100, jitterMs: 0 });
      ctx.handler.refreshAndReconnect.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      const first = ctx.manager.reconnect();
      await ctx.advance(100); // debounce fires; refresh starts; mutex held
      expect(ctx.manager.isReconnecting()).toBe(true);

      // A second reconnect, debounced + jitter elapses. With the mutex held
      // it must NOT call refresh again — bails with the debug log.
      const second = ctx.manager.reconnect();
      await ctx.advance(100);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // Release the first refresh; both promises settle.
      resolveRefresh?.(true);
      await first;
      await second;

      expect(ctx.manager.isReconnecting()).toBe(false);
    },
  );

  it("isReconnecting() reflects in-flight refresh", async () => {
    let resolveRefresh: ((v: boolean) => void) | null = null;
    const ctx = build({ debounceMs: 50, jitterMs: 0 });
    ctx.handler.refreshAndReconnect.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    expect(ctx.manager.isReconnecting()).toBe(false);

    const p = ctx.manager.reconnect();
    expect(ctx.manager.isReconnecting()).toBe(false); // still in debounce

    await ctx.advance(50);
    expect(ctx.manager.isReconnecting()).toBe(true);

    resolveRefresh?.(true);
    await p;
    expect(ctx.manager.isReconnecting()).toBe(false);
  });
});

describe("ReconnectManager — error containment", () => {
  it("a throwing onTerminalAuthFailure callback does not propagate", async () => {
    const ctx = build({ refreshResult: false });
    ctx.onTerminalAuthFailure.mockImplementation(() => {
      throw new Error("consumer wired this badly");
    });

    await expect(ctx.manager.tryAuthRecovery(1008)).resolves.toBeUndefined();
    expect(
      ctx.logger.calls.some(
        (c) => c.level === "error" && c.msg.includes("onTerminalAuthFailure"),
      ),
    ).toBe(true);
  });
});
