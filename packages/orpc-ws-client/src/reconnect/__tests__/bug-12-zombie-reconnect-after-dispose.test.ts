// Bug 12 regression — zombie reconnect after `dispose()`.
//
// docs/fable/bugs-review.md BUG-1: `client.dispose()` never touched the
// ReconnectManager, so a `reconnect()` sitting in the debounce window, a
// `runReconnect` mid-jitter-delay, or a `tryAuthRecovery` awaiting
// `tokenProvider.refresh()` all survived teardown. When the timer fired /
// the refresh resolved, `refreshAndReconnect()` ran to completion and
// `TokenRefreshHandler.reconnectWithNewToken` installed a brand-new
// partysocket — violating the "after dispose() the client object is dead"
// contract and leaking the connection for the page lifetime.
//
// Fix under test:
//   - `ReconnectManager.dispose()`: clears the armed debounce timer,
//     resolves every pending `reconnect()` promise, and latches `disposed`
//     — checked at the top of every entry point AND re-checked after each
//     `await`.
//   - `TokenRefreshHandler` belt-and-braces: the injected `isDead`
//     predicate (composition-wired to disposed/terminal/kicked) makes
//     `reconnectWithNewToken` refuse to build/install a new WebSocket
//     post-teardown.
//
// All timing through the fake clock — deterministic, no real timers.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, Rng, TimerHandle } from "@orpc-ws/shared";

import { ReconnectManager } from "../reconnect-manager.js";
import { TokenRefreshHandler } from "../token-refresh-handler.js";
import type { WebSocketFactory } from "../../lifecycle/websocket-factory.js";
import { WebSocketHolder } from "../../state/websocket-holder.js";
import { DEFAULT_RECONNECT_CONFIG } from "../../config/reconnect-config.js";

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
  getPending: () => FakeTimer[];
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

  const getPending = () => timers.filter((t) => !t.cancelled).slice();

  return { clock, advance, getPending };
}

const fakeRng: Rng = { next: () => 0.5 };

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

// ---------- Builder ----------

function build(opts: { refreshResult?: boolean } = {}) {
  const { clock, advance, getPending } = makeFakeClock(0);
  const refreshAndReconnect = vi.fn(async () => opts.refreshResult ?? true);
  const handler = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    isReconnecting: vi.fn(() => false),
    // The only tryAuthRecovery call in this suite is post-dispose (dies at
    // the isStopped() gate), but the stub keeps the seam complete.
    isRefreshing: vi.fn(() => false),
  } as unknown as TokenRefreshHandler;
  const onTerminalAuthFailure = vi.fn();
  const logger = makeLogger();
  const manager = new ReconnectManager({
    tokenRefreshHandler: handler,
    reconnectConfig: {
      debounceMs: 100,
      jitterMs: 1000, // rng 0.5 → 500ms jitter
      minRefreshIntervalMs: 30_000,
    },
    onTerminalAuthFailure,
    clock,
    rng: fakeRng,
    logger,
  });
  return {
    manager,
    refreshAndReconnect,
    onTerminalAuthFailure,
    advance,
    getPending,
    logger,
  };
}

// ---------- Tests ----------

describe("Bug 12 — ReconnectManager.dispose() cancels the reconnect machinery", () => {
  it("dispose() during the debounce window: timer cleared, promise resolves, NO refresh", async () => {
    const ctx = build();

    const p = ctx.manager.reconnect(); // armed debounce timer
    expect(ctx.getPending().length).toBe(1);

    ctx.manager.dispose();

    // The pending reconnect promise must settle (callers can't hang on a
    // dead client) and the timer must be gone.
    await p;
    expect(ctx.getPending().length).toBe(0);

    // Even if time marches on, no refresh ever happens.
    await ctx.advance(10_000);
    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();
  });

  it("dispose() during the jitter delay: refresh never starts", async () => {
    const ctx = build();

    const p = ctx.manager.reconnect();
    await ctx.advance(100); // debounce fires; jitter timer (500ms) armed
    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();

    ctx.manager.dispose();

    // The jitter timer was scheduled pre-dispose via delay(); when it
    // fires, the post-await disposed check must abort before refresh.
    await ctx.advance(500);
    await p;
    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();
  });

  it("dispose() during an in-flight refresh: result discarded, no terminal callback", async () => {
    // Default no-op so TS keeps the callable type across the closure
    // reassignment below (the existing `| null` pattern trips narrowing).
    let resolveRefresh: (v: boolean) => void = () => {};
    const ctx = build();
    ctx.refreshAndReconnect.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const p = ctx.manager.reconnect();
    await ctx.advance(100); // debounce
    await ctx.advance(500); // jitter → refresh starts and is held
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);

    ctx.manager.dispose();

    // The held refresh resolves AFTER dispose — with `false` (the
    // terminal-shaped outcome). Post-dispose, the manager must neither
    // fire onTerminalAuthFailure nor do anything else.
    resolveRefresh(false);
    await p;
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("tryAuthRecovery() after dispose(): no refresh, no terminal", async () => {
    const ctx = build({ refreshResult: false });
    ctx.manager.dispose();

    await ctx.manager.tryAuthRecovery(1008);

    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("reconnect() after dispose(): resolves immediately without scheduling anything", async () => {
    const ctx = build();
    ctx.manager.dispose();

    await ctx.manager.reconnect();

    expect(ctx.getPending().length).toBe(0);
    expect(ctx.refreshAndReconnect).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent", () => {
    const ctx = build();
    ctx.manager.dispose();
    expect(() => ctx.manager.dispose()).not.toThrow();
  });
});

describe("Bug 12 — TokenRefreshHandler refuses the socket swap post-dispose", () => {
  it("reconnectWithNewToken() is a no-op when isDead() returns true", () => {
    let disposed = false;
    const holder = new WebSocketHolder();
    const create = vi.fn(() => {
      throw new Error("websocketFactory.create must not be called post-dispose");
    });
    const factory = { create } as unknown as WebSocketFactory;
    const linkClearer = vi.fn();

    const handler = new TokenRefreshHandler({
      tokenProvider: {
        getToken: () => "tok",
        refresh: async () => "tok-fresh",
      },
      websocketHolder: holder,
      websocketFactory: factory,
      urlBuilder: (token) => `ws://x/?token=${token ?? ""}`,
      getEventHandlers: () => ({
        onOpen: () => {},
        onClose: () => {},
        onError: () => {},
      }),
      reconnectConfig: DEFAULT_RECONNECT_CONFIG,
      linkClearer,
      isDead: () => disposed,
      logger: makeLogger(),
    });

    disposed = true;
    handler.reconnectWithNewToken("tok-fresh");

    // No new WS was built, the holder stays empty, the link cache was
    // never touched — the dead client stays dead.
    expect(create).not.toHaveBeenCalled();
    expect(holder.get()).toBeNull();
    expect(linkClearer).not.toHaveBeenCalled();
  });
});
