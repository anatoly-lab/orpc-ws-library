// Bug 15 regression — failed heartbeat-timeout recovery must not strand
// the client.
//
// docs/fable/bugs-review.md BUG-4: `runReconnect` discarded the boolean
// from `refreshAndReconnect()`. On a half-open zombie socket (heartbeat
// timeout, no close event ever coming) with a refresh that returns null:
// no WS swap, no `onTerminalAuthFailure`, no event, no retry — and the
// monitor's `timeoutFired` latch could only be reset by a `recordPing()`
// that would never arrive. One failed recovery = permanent zombie with
// the UI stuck on `connected`.
//
// Fix under test (ReconnectManager half): `runReconnect` honors the
// refresh outcome — `false` (refresh returned null) routes to the SAME
// single-fire terminal path as `tryAuthRecovery` (Bug 14 latch), per the
// locked auth contract ("refresh returned null → terminal").
//
// The composition-root half (heartbeat watchdog transitions state to
// `disconnected({willRetry: true})` so the UI never shows `connected`
// over a dead link) lives in `index.ts`; driving the real watchdog needs
// a heartbeat-speaking ORPC server, which is e2e territory — the unit
// seam here pins the recovery-outcome routing that caused the stranding.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, Rng, TimerHandle } from "@repo/orpc-ws-shared";

import { ReconnectManager } from "../reconnect-manager.js";
import type { TokenRefreshHandler } from "../token-refresh-handler.js";

// ---------- Fake clock (same shape as reconnect-manager.test.ts) ----------

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

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
      const t: FakeTimer = { id: nextId++, fireAt: now + ms, fn, cancelled: false };
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

  const advance = async (ms: number): Promise<void> => {
    now += ms;
    let safety = 1000;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      const next = due[0];
      if (!next) break;
      const idx = timers.indexOf(next);
      if (idx >= 0) timers.splice(idx, 1);
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.resolve();
  };

  return { clock, advance };
}

const fakeRng: Rng = { next: () => 0 }; // zero jitter — debounce only

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// ---------- Builder ----------

function build(
  opts: { refreshResult?: boolean | Error; canRefresh?: boolean } = {},
) {
  const { clock, advance } = makeFakeClock(0);
  const result = opts.refreshResult ?? true;
  const refreshAndReconnect = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const handler = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    reconnectWithCurrentToken: vi.fn(),
    isReconnecting: vi.fn(() => false),
    // Refreshes in this suite are awaited to completion before the next
    // trigger — the F2 join branch never applies here.
    isRefreshing: vi.fn(() => false),
  } as unknown as TokenRefreshHandler;
  const reconnectWithCurrentToken = (
    handler as unknown as { reconnectWithCurrentToken: ReturnType<typeof vi.fn> }
  ).reconnectWithCurrentToken;
  const onTerminalAuthFailure = vi.fn();
  const manager = new ReconnectManager({
    tokenRefreshHandler: handler,
    reconnectConfig: {
      debounceMs: 100,
      jitterMs: 0,
      minRefreshIntervalMs: 30_000,
    },
    onTerminalAuthFailure,
    canRefresh: opts.canRefresh,
    clock,
    rng: fakeRng,
    logger: makeLogger(),
  });
  return {
    manager,
    refreshAndReconnect,
    reconnectWithCurrentToken,
    onTerminalAuthFailure,
    advance,
  };
}

// ---------- Tests ----------

describe("Bug 15 — runReconnect honors the refresh outcome", () => {
  it("reconnect() with refresh returning null fires onTerminalAuthFailure (was silently swallowed)", async () => {
    const ctx = build({ refreshResult: false });

    // The heartbeat-timeout / sleep-wake entry point.
    const p = ctx.manager.reconnect();
    await ctx.advance(100); // debounce (zero jitter)
    await p;

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("reconnect() with refresh throwing is treated as failed — fires terminal (parity with tryAuthRecovery)", async () => {
    const ctx = build({ refreshResult: new Error("provider blew up") });

    const p = ctx.manager.reconnect();
    await ctx.advance(100);
    await p;

    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("reconnect() with refresh succeeding does NOT fire terminal (no regression)", async () => {
    const ctx = build({ refreshResult: true });

    const p = ctx.manager.reconnect();
    await ctx.advance(100);
    await p;

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });
});

describe("Bug 15 — terminal latch is shared across both entry points (Bug 14 single-fire)", () => {
  it("terminal via reconnect(): subsequent reconnect() triggers no further refresh and no re-fire", async () => {
    const ctx = build({ refreshResult: false });

    const p1 = ctx.manager.reconnect();
    await ctx.advance(100);
    await p1;
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);

    // The watchdog latch never resets on a zombie, but even if a second
    // trigger arrives (sleep-wake tick, consumer retry), the manager is
    // terminal: no refresh storm, no duplicate consumer callback.
    const p2 = ctx.manager.reconnect();
    await ctx.advance(100);
    await p2;

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("terminal via reconnect(): tryAuthRecovery() afterwards no-ops too", async () => {
    const ctx = build({ refreshResult: false });

    const p = ctx.manager.reconnect();
    await ctx.advance(100);
    await p;
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);

    // A straggler 1008 close routing into auth recovery after terminal.
    await ctx.manager.tryAuthRecovery(1008);

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("terminal via tryAuthRecovery(): reconnect() afterwards no-ops (mirror direction)", async () => {
    const ctx = build({ refreshResult: false });

    await ctx.manager.tryAuthRecovery(1008);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);

    const p = ctx.manager.reconnect();
    await ctx.advance(100);
    await p;

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });
});

describe("Bug 15b regression — cookie auth (canRefresh: false) must not go terminal on reconnect()", () => {
  // The Bug 15 fix over-fired for cookie-auth consumers: with no
  // `tokenProvider`, the composition root substitutes a stub whose
  // `refresh()` always returns null, so EVERY sleep-wake / heartbeat-timeout
  // `reconnect()` resolved `false` and fired `onTerminalAuthFailure` —
  // redirecting a perfectly healthy client to /login because the laptop
  // slept. Since the Bug 16 / BUG-5 fix, cookie auth skips refresh
  // ENTIRELY: `runReconnect` rebuilds the socket via
  // `reconnectWithCurrentToken()` (the URL builder handles a null token)
  // and never consults the refresh outcome.
  it("reconnect() rebuilds the socket without a refresh and does NOT fire onTerminalAuthFailure", async () => {
    const ctx = build({ canRefresh: false });

    const p = ctx.manager.reconnect();
    await ctx.advance(100); // debounce (zero jitter)
    await p;

    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();
    expect(ctx.reconnectWithCurrentToken).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("manager is not latched terminal — a later reconnect() still runs", async () => {
    const ctx = build({ canRefresh: false });

    const p1 = ctx.manager.reconnect();
    await ctx.advance(100);
    await p1;

    // A second wake / heartbeat tick: the manager must still be live, not
    // silently terminal (the cookie-auth path leaves no one-way latch
    // behind), and still refresh-free.
    const p2 = ctx.manager.reconnect();
    await ctx.advance(100);
    await p2;

    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();
    expect(ctx.reconnectWithCurrentToken).toHaveBeenCalledTimes(2);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });
});
