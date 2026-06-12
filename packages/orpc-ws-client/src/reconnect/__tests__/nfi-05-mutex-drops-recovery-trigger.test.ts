// NFI-5 regression: the reconnect() mutex used to DROP a trigger that
// arrived while another reconnect was in flight.
//
// docs/fable/bugs-review.md §"Needs further investigation" item 5:
// `runReconnect`'s mutex branch resolved the late caller immediately
// WITHOUT any reconnect happening after it. If that dropped call was the
// only signal for a NEW problem (e.g. a second heartbeat timeout firing
// after the in-flight run had already passed its refresh-and-swap), the
// recovery trigger was lost permanently — no retry, no error, a zombie.
//
// Fix: the mutex branch requests exactly ONE trailing rerun and parks its
// resolvers; the in-flight run's `finally` consumes the request and runs
// `runReconnect` once more. Properties pinned here:
//   1. The trigger is served: a reconnect STARTS after the mid-flight
//      call (lands in the shared storm window → current-token rebuild,
//      no second IdP hit — Bug 16 semantics preserved).
//   2. N mid-flight triggers coalesce into ONE trailing rerun.
//   3. The rerun is trigger-driven, not a loop: with no further calls,
//      exactly one rerun happens.
//   4. dispose() mid-flight settles parked callers and suppresses the
//      rerun — no work on a dead client, no hanging promises.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, Rng, TimerHandle } from "@orpc-ws/shared";

import { ReconnectManager } from "../reconnect-manager.js";
import type { TokenRefreshHandler } from "../token-refresh-handler.js";

// ---------- Fakes (same shapes as reconnect-manager.test.ts) ----------

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
} {
  let now = 0;
  const timers: FakeTimer[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { fireAt: now + ms, fn, cancelled: false };
      timers.push(t);
      return t as unknown as TimerHandle;
    },
    clearTimeout: (handle) => {
      (handle as unknown as FakeTimer).cancelled = true;
    },
    setInterval: () => {
      throw new Error("setInterval not expected");
    },
    clearInterval: () => {
      throw new Error("clearInterval not expected");
    },
  };
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    let safety = 100;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { clock, advance };
}

const fixedRng: Rng = { next: () => 0 };

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function build(opts: { isDead?: () => boolean } = {}) {
  const { clock, advance } = makeFakeClock();
  // refreshAndReconnect is held by the test; reconnectWithCurrentToken is
  // synchronous (the real handler's is too).
  const refreshResolvers: Array<(v: boolean) => void> = [];
  const refreshAndReconnect = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        refreshResolvers.push(resolve);
      }),
  );
  const reconnectWithCurrentToken = vi.fn();
  const handler = {
    refreshAndReconnect,
    reconnectWithCurrentToken,
    reconnectWithNewToken: vi.fn(),
    isReconnecting: vi.fn(() => false),
    isRefreshing: vi.fn(() => refreshResolvers.length > 0),
  } as unknown as TokenRefreshHandler & {
    refreshAndReconnect: ReturnType<typeof vi.fn>;
    reconnectWithCurrentToken: ReturnType<typeof vi.fn>;
  };
  const onTerminalAuthFailure = vi.fn();
  const manager = new ReconnectManager({
    tokenRefreshHandler: handler,
    reconnectConfig: {
      debounceMs: 100,
      jitterMs: 0,
      minRefreshIntervalMs: 30_000,
    },
    onTerminalAuthFailure,
    isDead: opts.isDead,
    clock,
    rng: fixedRng,
    logger: makeLogger(),
  });
  const settleRefresh = (v: boolean) => {
    for (const r of refreshResolvers.splice(0)) r(v);
  };
  return { manager, handler, onTerminalAuthFailure, advance, settleRefresh };
}

// Observable settlement helper — `await` would hang the test on a bug,
// so assertions about "not yet settled" use a flag instead.
function track<T>(p: Promise<T>): { settled: () => boolean; p: Promise<T> } {
  let settled = false;
  const wrapped = p.then((v) => {
    settled = true;
    return v;
  });
  return { settled: () => settled, p: wrapped };
}

// ---------- Tests ----------

describe("NFI-5 — reconnect() arriving mid-flight must not be dropped", () => {
  it(
    "nfi-05: a reconnect() whose debounce fires during an in-flight run " +
      "triggers exactly one trailing rerun after the run completes",
    async () => {
      const ctx = build();

      // First trigger: debounce + 0 jitter → refresh in flight, mutex held.
      const first = ctx.manager.reconnect();
      await ctx.advance(100);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);

      // Second trigger lands mid-flight (e.g. a fresh heartbeat timeout
      // on the JUST-swAPPED socket). Pre-fix the mutex branch resolved it
      // with no reconnect ever happening for it.
      const second = track(ctx.manager.reconnect());
      await ctx.advance(100); // its debounce fires into the mutex
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      // Parked, not lied to: the promise settles when ITS reconnect ran.
      expect(second.settled()).toBe(false);

      // In-flight run completes → trailing rerun starts; it lands inside
      // the shared storm window, so it rebuilds with the current token
      // (no second refresh — Bug 16 semantics).
      ctx.settleRefresh(true);
      await first;
      await ctx.advance(0); // the rerun's 0ms jitter timer

      await second.p;
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.handler.reconnectWithCurrentToken).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "nfi-05: N mid-flight triggers coalesce into ONE trailing rerun, and " +
      "with no further triggers no extra rerun follows (not a loop)",
    async () => {
      const ctx = build();

      const first = ctx.manager.reconnect();
      await ctx.advance(100);

      const second = track(ctx.manager.reconnect());
      await ctx.advance(100);
      const third = track(ctx.manager.reconnect());
      await ctx.advance(100);

      ctx.settleRefresh(true);
      await first;
      await ctx.advance(0);

      await second.p;
      await third.p;
      // One refresh (the original flight) + ONE current-token rebuild for
      // the whole mid-flight batch.
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.handler.reconnectWithCurrentToken).toHaveBeenCalledTimes(1);

      // Nothing else is pending — time marching on runs no more work.
      await ctx.advance(60_000);
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.handler.reconnectWithCurrentToken).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "nfi-05: dispose() mid-flight settles parked callers and suppresses " +
      "the trailing rerun — no work on a dead client",
    async () => {
      const ctx = build();

      const first = ctx.manager.reconnect();
      await ctx.advance(100);

      const second = track(ctx.manager.reconnect());
      await ctx.advance(100);
      expect(second.settled()).toBe(false);

      ctx.manager.dispose();
      // dispose settles the parked trailing resolvers immediately.
      await second.p;

      // The in-flight refresh resolving afterwards must not run the rerun.
      ctx.settleRefresh(true);
      await first;
      await ctx.advance(60_000);
      expect(ctx.handler.reconnectWithCurrentToken).not.toHaveBeenCalled();
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "nfi-05: a kick (isDead) landing mid-flight short-circuits the trailing " +
      "rerun at its entry check — parked callers still settle",
    async () => {
      let dead = false;
      const ctx = build({ isDead: () => dead });

      const first = ctx.manager.reconnect();
      await ctx.advance(100);

      const second = track(ctx.manager.reconnect());
      await ctx.advance(100);

      // 4005 kick lands while the refresh is still pending.
      dead = true;
      ctx.settleRefresh(true);
      await first;
      // The rerun is invoked by the finally but refuses to run (isStopped)
      // and settles the carried resolvers.
      await second.p;

      await ctx.advance(60_000);
      expect(ctx.handler.reconnectWithCurrentToken).not.toHaveBeenCalled();
      expect(ctx.handler.refreshAndReconnect).toHaveBeenCalledTimes(1);
    },
  );
});
