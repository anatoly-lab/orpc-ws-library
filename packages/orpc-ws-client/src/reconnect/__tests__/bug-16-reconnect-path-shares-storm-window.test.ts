// Bug 16 regression — the `reconnect()` path must share the storm-guard
// window (and never double-refresh).
//
// docs/fable/bugs-review.md BUG-5: CLAUDE.md's locked decision says
// "Library owns the 30s storm guard internally. Single window across all
// triggers (heartbeat timeout, close-code 1008/4001, pre-open 1000,
// HTTP-upload 401)." The implementation guarded only `tryAuthRecovery`;
// `reconnect()` (heartbeat-timeout + sleep-wake) neither read nor stamped
// `lastRefreshAttemptedAt`. Consequences:
//   1. Flapping reconnects hammered the IdP with refreshes that the design
//      says must share the 30s window.
//   2. A half-open zombie's `reconnect()` refresh could run CONCURRENTLY
//      with a 1008-triggered `tryAuthRecovery` refresh — with IdP
//      refresh-token rotation (Keycloak reuse detection) that revokes the
//      whole session: a self-inflicted logout.
//
// Fix under test, two layers:
//   - ReconnectManager.runReconnect consults + stamps the SHARED
//     `lastRefreshAttemptedAt`. Inside the window it rebuilds the socket
//     with the CURRENT token (`reconnectWithCurrentToken`) instead of
//     refreshing — NOT terminal (unlike `tryAuthRecovery`'s trip): a
//     reconnect landing in the window is normal churn.
//   - TokenRefreshHandler single-flights `tokenProvider.refresh()` so any
//     two overlapping refresh-driving callers share ONE network call.
//     (Defense in depth — the shared window already prevents overlap
//     through the manager, since both paths stamp synchronously before
//     their await.)

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";
import type { Clock, Logger, Rng, TimerHandle } from "@repo/orpc-ws-shared";

import { WebSocketHolder } from "../../state/websocket-holder.js";
import type { WebSocketFactory } from "../../lifecycle/websocket-factory.js";
import type {
  ReconnectConfig,
  WebSocketEventHandlers,
} from "../../lifecycle/types.js";
import type { TokenProvider } from "../../auth/token-provider.js";

import { ReconnectManager } from "../reconnect-manager.js";
import { TokenRefreshHandler } from "../token-refresh-handler.js";

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

// ---------- Manager-level builder (fake TokenRefreshHandler) ----------

function buildManager() {
  const { clock, advance } = makeFakeClock(0);
  const refreshAndReconnect = vi.fn(async () => true);
  const reconnectWithCurrentToken = vi.fn();
  const handler = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    reconnectWithCurrentToken,
    isReconnecting: vi.fn(() => false),
    // Every refreshAndReconnect in this suite is awaited to completion
    // before the next trigger — never in flight, so the F2 join branch
    // stays out of the picture and the window/provenance logic is what's
    // exercised.
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
  return {
    manager,
    refreshAndReconnect,
    reconnectWithCurrentToken,
    onTerminalAuthFailure,
    advance,
  };
}

// ---------- Handler-level builder (REAL TokenRefreshHandler) ----------

function makeStubSocket(label = "ws"): ReconnectingWebSocket {
  const close = vi.fn();
  return { __label: label, close } as unknown as ReconnectingWebSocket;
}

function makeReconnectConfig(): ReconnectConfig {
  return {
    maxRetries: 5,
    maxReconnectionDelay: 10_000,
    minReconnectionDelay: 1_000,
    reconnectionDelayGrowFactor: 1.3,
    connectionTimeout: 5_000,
    maxEnqueuedMessages: 0,
  };
}

function buildHandler() {
  // A refresh whose settlement the TEST controls — both callers must be
  // mid-await before the single network call resolves.
  const pending: Array<(token: string | null) => void> = [];
  const refresh = vi.fn(
    (): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        pending.push(resolve);
      }),
  );
  const resolveRefresh = (token: string | null): void => {
    for (const r of pending.splice(0)) r(token);
  };
  const getToken = vi.fn((): string | null => "current-token");
  const tokenProvider = { getToken, refresh } as TokenProvider;

  const holder = new WebSocketHolder();
  const create = vi.fn((): ReconnectingWebSocket => makeStubSocket("new"));
  const factory = { create } as unknown as WebSocketFactory;
  const handlersFactory = vi.fn<() => WebSocketEventHandlers>(() => ({
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  }));
  const linkClearer = vi.fn();

  const handler = new TokenRefreshHandler({
    tokenProvider,
    websocketHolder: holder,
    websocketFactory: factory,
    urlBuilder: (t: string | null) => `wss://example.test/${t ?? "no-token"}`,
    getEventHandlers: handlersFactory,
    reconnectConfig: makeReconnectConfig(),
    linkClearer,
    logger: makeLogger(),
  });

  return { handler, refresh, getToken, resolveRefresh, holder, create };
}

// ---------- Tests: shared window in the manager ----------

describe("Bug 16 — reconnect() shares the storm-guard window with tryAuthRecovery", () => {
  it("reconnect() within the window of a tryAuthRecovery stamp reconnects with the current token, no refresh", async () => {
    const ctx = buildManager();

    // Auth recovery stamps the shared window at t=0.
    await ctx.manager.tryAuthRecovery(1008);
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);

    // Heartbeat-timeout / sleep-wake reconnect lands at t=100 — well
    // inside the 30s window. The just-refreshed token is still fresh:
    // rebuild the socket with it, do NOT hit the IdP again.
    const p = ctx.manager.reconnect();
    await ctx.advance(100); // debounce (zero jitter)
    await p;

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.reconnectWithCurrentToken).toHaveBeenCalledTimes(1);
    // Normal churn, not an auth-failure hot loop — never terminal.
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("reconnect() outside the window refreshes and stamps; a follow-up reconnect inside the window does not", async () => {
    const ctx = buildManager();

    // First reconnect: window is unstamped (-Infinity) — refresh runs.
    const p1 = ctx.manager.reconnect();
    await ctx.advance(100);
    await p1;
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.reconnectWithCurrentToken).not.toHaveBeenCalled();

    // Second reconnect 100ms later: inside the window the FIRST reconnect
    // stamped — proof that reconnect() writes the shared timestamp.
    const p2 = ctx.manager.reconnect();
    await ctx.advance(100);
    await p2;
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    expect(ctx.reconnectWithCurrentToken).toHaveBeenCalledTimes(1);

    // Third reconnect after the window elapses: refresh is allowed again.
    const p3 = ctx.manager.reconnect();
    await ctx.advance(30_000);
    await p3;
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(2);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("reconnect()'s stamp is visible to tryAuthRecovery, but with ROUTINE provenance — first auth failure refreshes, the next one is terminal (F2)", async () => {
    const ctx = buildManager();

    const p = ctx.manager.reconnect();
    await ctx.advance(100);
    await p;
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);

    // A 1008 close right after a ROUTINE refresh is the FIRST auth
    // failure, not a hot loop. The pre-F2 semantics ("any within-window
    // stamp trips terminal") force-logged-out a healthy session here —
    // interleaving B: sleep-wake refresh succeeds, the new socket's
    // pre-open close routes to auth recovery within the window. With
    // provenance, the guard sees the stamp came from runReconnect and
    // performs a real auth-recovery refresh instead.
    await ctx.manager.tryAuthRecovery(1008);

    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(2);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();

    // That auth-recovery refresh COMPLETED and re-stamped the SAME shared
    // window with auth provenance — so the NEXT failure inside it is a
    // genuine storm. The single-window contract still holds; only the
    // terminal trip became provenance-aware.
    await ctx.manager.tryAuthRecovery(1008);
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(2);
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });
});

// ---------- Tests: single-flight refresh in the handler ----------

describe("Bug 16 — TokenRefreshHandler single-flights tokenProvider.refresh()", () => {
  it("two overlapping refreshAndReconnect() calls issue exactly ONE network refresh", async () => {
    const ctx = buildHandler();

    // Both callers start before the refresh settles — the Keycloak
    // rotation-race shape (manager-level reconnect + auth recovery).
    const p1 = ctx.handler.refreshAndReconnect();
    const p2 = ctx.handler.refreshAndReconnect();

    // Let the memo's `.then(...)` microtask reach the provider.
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);

    ctx.resolveRefresh("fresh-token");
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);

    // Still one network call — the second caller shared the in-flight
    // promise instead of burning a (possibly rotated) refresh token.
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.holder.getCurrentToken()).toBe("fresh-token");
  });

  it("the in-flight memo clears after settlement — a later refresh makes a new call", async () => {
    const ctx = buildHandler();

    const p1 = ctx.handler.refreshAndReconnect();
    ctx.resolveRefresh("token-1");
    expect(await p1).toBe(true);

    // NOT coalesced with the first — that flight already settled; serving
    // it stale would hand out an expired token forever.
    const p2 = ctx.handler.refreshAndReconnect();
    ctx.resolveRefresh("token-2");
    expect(await p2).toBe(true);

    expect(ctx.refresh).toHaveBeenCalledTimes(2);
  });

  it("a failed (null) shared refresh yields false to BOTH callers and clears the memo", async () => {
    const ctx = buildHandler();

    const p1 = ctx.handler.refreshAndReconnect();
    const p2 = ctx.handler.refreshAndReconnect();
    ctx.resolveRefresh(null);

    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.create).not.toHaveBeenCalled();

    // Failure must not poison the memo: the next storm-guard-approved
    // attempt gets a real network call.
    const p3 = ctx.handler.refreshAndReconnect();
    ctx.resolveRefresh("recovered");
    expect(await p3).toBe(true);
    expect(ctx.refresh).toHaveBeenCalledTimes(2);
  });
});

// ---------- Tests: reconnectWithCurrentToken mechanics ----------

describe("Bug 16 — reconnectWithCurrentToken rebuilds the socket without refreshing", () => {
  it("swaps the socket using tokenProvider.getToken(); refresh() is never called", () => {
    const ctx = buildHandler();
    const oldWs = makeStubSocket("old");
    ctx.holder.set(oldWs);

    ctx.handler.reconnectWithCurrentToken();

    expect(ctx.refresh).not.toHaveBeenCalled();
    expect(ctx.getToken).toHaveBeenCalled();
    expect(oldWs.close).toHaveBeenCalledTimes(1);
    expect(ctx.create).toHaveBeenCalledTimes(1);
    expect(ctx.holder.get()).not.toBe(oldWs);
    expect(ctx.holder.getCurrentToken()).toBe("current-token");
  });

  it("handles a null current token (cookie auth) — swap proceeds, token recorded as null", () => {
    const ctx = buildHandler();
    ctx.getToken.mockReturnValue(null);
    ctx.holder.setCurrentToken("stale");

    ctx.handler.reconnectWithCurrentToken();

    expect(ctx.create).toHaveBeenCalledTimes(1);
    expect(ctx.holder.getCurrentToken()).toBeNull();
  });
});
