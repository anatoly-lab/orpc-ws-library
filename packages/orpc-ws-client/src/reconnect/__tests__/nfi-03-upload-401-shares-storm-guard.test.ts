// NFI-3 regression — an HTTP-upload 401 routes into the SAME storm-guarded
// auth-recovery path as a WS auth-failure close, sharing the single 30s
// window.
//
// docs/fable/resolution-status.md NFI-3 + CLAUDE.md "Library owns the 30s
// storm guard internally. Single window across all triggers (heartbeat
// timeout, close-code 1008/4001, pre-open 1000, HTTP-upload 401)." The
// upload-401 trigger was wired last: the orpc-http strategy detects the raw
// 401 (see orpc-http-strategy.test.ts) and calls
// `ReconnectManager.notifyUploadAuthFailure()`, which delegates to
// `tryAuthRecovery(401)`. Routing through the EXISTING method — rather than
// a parallel one — is the whole point: an upload 401 inherits the shared
// window, the single-flight join, and terminal-on-genuine-loop for free,
// and can never drift from the WS auth-recovery policy.
//
// These tests pin the delegation contract at the manager seam (the strategy
// test pins the HTTP-status detection). Together they cover the full path:
//   raw 401 → onUpload401 → notifyUploadAuthFailure → tryAuthRecovery.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, Rng, TimerHandle } from "@orpc-ws/shared";

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

const fakeRng: Rng = { next: () => 0 };

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function buildManager() {
  const { clock } = makeFakeClock(0);
  const refreshAndReconnect = vi.fn(async () => true);
  const handler = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    reconnectWithCurrentToken: vi.fn(),
    isReconnecting: vi.fn(() => false),
    // Each call is awaited to completion before the next trigger, so the
    // F2 join branch stays out — the window/provenance logic is exercised.
    isRefreshing: vi.fn(() => false),
  } as unknown as TokenRefreshHandler;
  const onTerminalAuthFailure = vi.fn();
  const manager = new ReconnectManager({
    tokenRefreshHandler: handler,
    reconnectConfig: {
      debounceMs: 100,
      jitterMs: 0,
      minRefreshIntervalMs: 30_000,
    },
    onTerminalAuthFailure,
    clock,
    rng: fakeRng,
    logger: makeLogger(),
  });
  return { manager, refreshAndReconnect, onTerminalAuthFailure };
}

describe("NFI-3 — upload 401 shares the storm-guard window via tryAuthRecovery", () => {
  it("notifyUploadAuthFailure() drives one auth-recovery refresh, not terminal", async () => {
    const ctx = buildManager();

    await ctx.manager.notifyUploadAuthFailure();

    // Delegates to tryAuthRecovery → a single refresh-and-reconnect.
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    // A lone 401 is the FIRST auth failure, not a hot loop — never terminal.
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("an upload 401 stamps the SHARED window with auth provenance — a WS 1008 inside it is a genuine storm → terminal", async () => {
    const ctx = buildManager();

    // Upload 401 at t=0 stamps the single window with auth-recovery
    // provenance and refreshes once.
    await ctx.manager.notifyUploadAuthFailure();
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);

    // A WS 1008 close arriving inside the same window, after the upload's
    // auth-recovery refresh COMPLETED, is auth-failing-again — the genuine
    // hot loop the storm guard exists to break. Because both triggers read
    // the SAME `lastRefreshAttemptedAt`, this trips terminal without a
    // second refresh. (Proof the upload path is not a separate window.)
    await ctx.manager.tryAuthRecovery(1008);
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("an upload 401 whose refresh fails (null) goes terminal — same as a WS auth-failure close", async () => {
    const ctx = buildManager();
    ctx.refreshAndReconnect.mockResolvedValueOnce(false);

    await ctx.manager.notifyUploadAuthFailure();

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });
});
