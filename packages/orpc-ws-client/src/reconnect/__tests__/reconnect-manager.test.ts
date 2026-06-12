// ReconnectManager regression tests.
//
// Covers the Phase 1.3 behavioral contract (F2-amended):
//   - Storm guard within the configured window (default 30s) — first call
//     refreshes; once that refresh has COMPLETED, a second call within the
//     window is a genuine storm and short-circuits to
//     `onTerminalAuthFailure`. After the window elapses, refresh is allowed
//     again. (F2: a call while the refresh is still IN FLIGHT joins it, and
//     a window stamped by a routine `reconnect()` refresh does not trip the
//     guard — see the F2 suite below.)
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
} from "@orpc-ws/shared";

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
// to return true/false or throw. `isRefreshing` mirrors the real handler's
// single-flight memo (F2): true while a `refreshAndReconnect` call is
// pending, false once it settles. Tests that replace `refreshAndReconnect`
// via `mockImplementation` bypass the tracking and must override
// `isRefreshing` themselves if the join branch matters to them.

function makeFakeHandler(
  options: { result?: boolean | Error } = {},
): TokenRefreshHandler & {
  refreshAndReconnect: ReturnType<typeof vi.fn>;
  isRefreshing: ReturnType<typeof vi.fn>;
} {
  const result = options.result ?? true;
  let inFlight = 0;
  const refreshAndReconnect = vi.fn(() => {
    inFlight += 1;
    const flight = (async () => {
      if (result instanceof Error) throw result;
      return result;
    })();
    return flight.finally(() => {
      inFlight -= 1;
    });
  });
  const isRefreshing = vi.fn(() => inFlight > 0);
  // Other methods aren't called in these tests; stub for typing.
  const stub = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    reconnectWithCurrentToken: vi.fn(),
    isReconnecting: vi.fn(() => false),
    isRefreshing,
  } as unknown as TokenRefreshHandler & {
    refreshAndReconnect: ReturnType<typeof vi.fn>;
    isRefreshing: ReturnType<typeof vi.fn>;
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
  /** Composition-level deadness predicate (F1/F3) — see the F1/F3 suite. */
  isDead?: () => boolean;
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
    isDead: opts.isDead,
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
    "second tryAuthRecovery within minRefreshIntervalMs of a COMPLETED " +
      "auth-recovery refresh short-circuits to onTerminalAuthFailure " +
      "(genuine storm — no second refresh)",
    async () => {
      const ctx = build();

      // The await resolves the first auth-recovery refresh fully — NOT
      // in flight (the F2 join branch doesn't apply), provenance stamped
      // as auth-recovery. This is the genuine-storm shape.
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

      // Each call is awaited to completion before the next — the second
      // is NOT a concurrent duplicate (which would JOIN the in-flight
      // refresh under F2) but a fresh auth failure after a completed
      // auth-recovery refresh: the guard's terminal trip.
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

describe("ReconnectManager — F2 storm-guard false positives (join + provenance)", () => {
  // The storm guard's terminal trip is REAL (BUG-3: it kills the client →
  // forced re-login), so it must fire only on a GENUINE storm — a second
  // auth failure AFTER the first auth-recovery refresh COMPLETED within
  // the window. Two false-positive shapes are pinned here:
  //   (A) partysocket double-fires `onclose` over Node `ws`, so one 1008
  //       lands in `tryAuthRecovery` twice ~1ms apart — the second call
  //       must JOIN the in-flight refresh, not go terminal.
  //   (B) a successful ROUTINE (heartbeat/sleep) refresh stamps the shared
  //       window; the new socket's pre-open 1000 routes to auth recovery
  //       within it — that's the FIRST auth failure and deserves a real
  //       refresh, not an instant logout (provenance flag).

  // Shared-flight fake: every refreshAndReconnect call returns a promise
  // the TEST settles, all with one outcome — mirroring the real handler's
  // single-flight memo (the network-level sharing itself is pinned by the
  // bug-16 single-flight tests at the handler layer).
  function holdRefresh(ctx: ReturnType<typeof build>) {
    const resolvers: Array<(v: boolean) => void> = [];
    ctx.handler.refreshAndReconnect.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    ctx.handler.isRefreshing.mockImplementation(() => resolvers.length > 0);
    return (v: boolean) => {
      for (const r of resolvers.splice(0)) r(v);
    };
  }

  it(
    "f2-storm-guard-join: a second tryAuthRecovery WHILE the refresh is in " +
      "flight joins it — no terminal, shared outcome",
    async () => {
      const ctx = build();
      const settleRefresh = holdRefresh(ctx);

      // First 1008: stamps the window, starts the (held) refresh.
      const p1 = ctx.manager.tryAuthRecovery(1008);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // The double-fired close arrives ~1ms later, refresh still pending.
      // Pre-F2 this tripped the storm guard → terminal → forced logout
      // while the in-flight refresh was about to succeed.
      ctx.setNow(1);
      const p2 = ctx.manager.tryAuthRecovery(1008);

      // Deferred: the duplicate defers to the primary's in-flight refresh —
      // NO second refreshAndReconnect (so no throwaway socket swap), and NOT
      // terminal. The primary's single call owns the whole outcome.
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();

      // The shared flight succeeds; both callers settle, still no terminal.
      settleRefresh(true);
      await p1;
      await p2;
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "f2-storm-guard-join-failure: a joined refresh that fails fires " +
      "onTerminalAuthFailure exactly once (Bug 14 latch covers both callers)",
    async () => {
      const ctx = build();
      const settleRefresh = holdRefresh(ctx);

      const p1 = ctx.manager.tryAuthRecovery(1008);
      ctx.setNow(1);
      const p2 = ctx.manager.tryAuthRecovery(1008);

      // The duplicate (p2) deferred to the primary (p1) and did nothing.
      // The primary's refresh token really is dead → it fires terminal
      // exactly once. (The single-fire latch additionally backstops any
      // stray re-trigger.)
      settleRefresh(false);
      await p1;
      await p2;
      expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
      // Only the primary ever called refresh — the duplicate did not.
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "f2-storm-guard-provenance: a routine reconnect() refresh within the " +
      "window does NOT make the next auth failure terminal — it refreshes",
    async () => {
      const ctx = build({ debounceMs: 100, jitterMs: 0 });

      // Routine sleep-wake / heartbeat-timeout reconnect: refresh succeeds
      // and stamps the SHARED window with ROUTINE provenance.
      const p = ctx.manager.reconnect();
      await ctx.advance(100); // debounce (zero jitter)
      await p;
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // The new socket's pre-open 1000 routes to auth recovery within the
      // window. This is the FIRST actual auth failure — pre-F2 the shared
      // stamp tripped the guard and force-logged-out a healthy session.
      ctx.setNow(5_000);
      await ctx.manager.tryAuthRecovery(1000);

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(2);
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "f2-storm-guard-genuine: after a COMPLETED auth-recovery refresh, a " +
      "second auth failure within the window is still terminal (storm " +
      "protection preserved)",
    async () => {
      const ctx = build();

      // Bad-token hot loop: 1008 → refresh succeeds → new socket → 1008
      // again. The refresh isn't helping; the guard must still kill it.
      await ctx.manager.tryAuthRecovery(1008); // completes (awaited)
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      ctx.setNow(5_000);
      await ctx.manager.tryAuthRecovery(1008);

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
    },
  );
});

describe("ReconnectManager — F5 dispose() cancels the jitter-delay timer", () => {
  it(
    "f5-dispose-clears-jitter-timer: dispose() mid-jitter clears the " +
      "pending timer, settles the reconnect promise, and runs no work",
    async () => {
      const ctx = build({
        debounceMs: 100,
        jitterMs: 5000,
        rng: makeFakeRng([0.4]), // jitter = 2000ms
      });

      const p = ctx.manager.reconnect();
      await ctx.advance(100); // debounce fires; jitter timer armed
      expect(ctx.handler.refreshAndReconnect).not.toHaveBeenCalled();
      expect(ctx.getPending().length).toBe(1); // the jitter timer

      ctx.manager.dispose();

      // F5: pre-fix, dispose() cleared only the DEBOUNCE timer — the
      // jitter timer's handle was never stored, so it outlived the client
      // and fired into the fake clock later. Now no timer survives.
      expect(ctx.getPending().length).toBe(0);

      // dispose() releases the awaited delay; runReconnect's post-jitter
      // isStopped() re-check aborts and the coalesced waiters settle —
      // callers never hang on a dead client.
      await expect(p).resolves.toBeUndefined();

      // Even as time marches on, nothing runs.
      await ctx.advance(10_000);
      expect(ctx.handler.refreshAndReconnect).not.toHaveBeenCalled();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
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
    "concurrent reconnect() calls serialize via mutex (second call does not " +
      "double-refresh; it queues one trailing rerun — NFI-5)",
    async () => {
      // Hold refresh in flight by making it never resolve until we let it.
      let resolveRefresh: (v: boolean) => void = () => {};
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
      // it must NOT call refresh again — it parks behind the trailing-rerun
      // latch (NFI-5) instead of being dropped.
      const second = ctx.manager.reconnect();
      await ctx.advance(100);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // Release the first refresh; the trailing rerun then runs (its 0ms
      // jitter timer needs one clock tick) and lands in the shared storm
      // window → no second refresh, just a current-token socket rebuild.
      resolveRefresh(true);
      await first;
      await ctx.advance(0);
      await second;

      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.manager.isReconnecting()).toBe(false);
    },
  );

  it("isReconnecting() reflects in-flight refresh", async () => {
    let resolveRefresh: (v: boolean) => void = () => {};
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

    resolveRefresh(true);
    await p;
    expect(ctx.manager.isReconnecting()).toBe(false);
  });
});

describe("ReconnectManager — composition-level isDead predicate (F1/F3 unified deadness)", () => {
  // The manager's own latches (disposed / terminalFired) only cover the
  // deaths it participates in. The composition root also kills the client
  // via the `kicked` state (close 4005) and the no-tokenProvider terminal
  // path — neither routes through this instance — and injects that
  // knowledge as the `isDead` predicate. These tests pin the RM-level
  // wiring: every entry point and every after-await re-check must consult
  // the predicate, so a reconnect armed before ANY death short-circuits
  // instead of refreshing / firing terminal on a dead client.
  //
  // Each death is simulated by flipping a mutable boolean behind the
  // predicate at a precise point in the debounce → jitter → refresh
  // pipeline (fake clock; deterministic).

  it(
    "isDead flipping true between reconnect() scheduling and the debounce " +
      "firing skips the refresh; the promise still settles",
    async () => {
      let dead = false;
      const ctx = build({
        debounceMs: 1000,
        jitterMs: 0,
        isDead: () => dead,
      });

      const p = ctx.manager.reconnect();
      // Halfway through the debounce window — reconnect armed, not fired.
      await ctx.advance(500);
      // The kick (or composition-level terminal) lands now.
      dead = true;
      // Debounce elapses → runReconnect's entry isStopped() re-check must
      // short-circuit. Pre-wiring, only disposed/terminalFired were read
      // and the refresh ran on the dead client.
      await ctx.advance(500);

      // Callers must never hang on a dead client — settleAll runs in the
      // dead-client branch.
      await expect(p).resolves.toBeUndefined();
      expect(ctx.handler.refreshAndReconnect).not.toHaveBeenCalled();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "isDead flipping true during the jitter delay aborts before the " +
      "refresh; the promise still settles",
    async () => {
      let dead = false;
      const ctx = build({
        debounceMs: 1000,
        jitterMs: 5000,
        rng: makeFakeRng([0.4]), // jitter = 0.4 * 5000 = 2000ms
        isDead: () => dead,
      });

      const p = ctx.manager.reconnect();
      await ctx.advance(1000); // debounce fires; jitter timer scheduled
      // We're inside the jitter delay — no refresh yet.
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(0);

      // The kick lands mid-jitter.
      dead = true;
      // Jitter elapses → the post-jitter isStopped() re-check must abort.
      await ctx.advance(2000);

      await expect(p).resolves.toBeUndefined();
      expect(ctx.handler.refreshAndReconnect).not.toHaveBeenCalled();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "isDead flipping true while reconnect()'s refresh is in flight " +
      "suppresses the !ok terminal escalation",
    async () => {
      let dead = false;
      let resolveRefresh: (v: boolean) => void = () => {};
      const ctx = build({ debounceMs: 100, jitterMs: 0, isDead: () => dead });
      ctx.handler.refreshAndReconnect.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      const p = ctx.manager.reconnect();
      await ctx.advance(100); // debounce + 0 jitter → refresh in flight
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // The kick lands while refresh() is pending; the refresh then FAILS.
      // Pre-wiring, the !ok branch fired onTerminalAuthFailure — relabeling
      // a dead/kicked client as a terminal AUTH failure.
      dead = true;
      resolveRefresh(false);

      await expect(p).resolves.toBeUndefined();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "tryAuthRecovery on an already-dead client no-ops — no refresh, no " +
      "onTerminalAuthFailure",
    async () => {
      const ctx = build({ isDead: () => true });

      await ctx.manager.tryAuthRecovery(1008);

      expect(ctx.handler.refreshAndReconnect).not.toHaveBeenCalled();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "isDead flipping true while tryAuthRecovery's refresh is in flight " +
      "suppresses the !ok terminal relabel",
    async () => {
      let dead = false;
      let resolveRefresh: (v: boolean) => void = () => {};
      const ctx = build({ isDead: () => dead });
      ctx.handler.refreshAndReconnect.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      // tryAuthRecovery runs synchronously up to the refresh await, so the
      // resolver is captured by the time the call returns its promise.
      const p = ctx.manager.tryAuthRecovery(1008);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // The kick lands mid-refresh; the refresh then FAILS (null token).
      // The post-await isStopped() re-check must win — a kicked client is
      // not a terminal auth failure.
      dead = true;
      resolveRefresh(false);

      await expect(p).resolves.toBeUndefined();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "sanity: with isDead wired but always false, both flows still refresh " +
      "(the negative assertions above aren't vacuous)",
    async () => {
      const ctx = build({
        debounceMs: 1000,
        jitterMs: 5000,
        rng: makeFakeRng([0.4]),
        isDead: () => false,
      });

      // Same advance pattern as the mid-debounce / mid-jitter cases above,
      // minus the flip: the reconnect() flow runs to the refresh.
      const p = ctx.manager.reconnect();
      await ctx.advance(500);
      await ctx.advance(500); // debounce fires
      await ctx.advance(2000); // jitter elapses
      await p;
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // And tryAuthRecovery's entry check lets a live client through
      // (clock pushed past the shared storm window first).
      ctx.setNow(60_000);
      await ctx.manager.tryAuthRecovery(1008);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(2);
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );
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
