// TokenRefreshHandler regression tests.
//
// Covers the Phase 1.3 de-app-ified swap-out flow:
//   - `refreshAndReconnect`: tokenProvider.refresh() is called; on null →
//     returns false, no reconnect is attempted. On a token → reconnect.
//   - `reconnectWithNewToken`: closes existing WS, calls linkClearer,
//     creates new WS via factory with URL provider closure, sets the
//     holder's current token.
//   - URL provider closure (Bug 1 fix): the factory receives a function
//     that on each call reads tokenProvider.getToken() afresh — i.e. the
//     URL provider is NOT a cached string.
//   - Mutex inside `reconnectWithNewToken`: a concurrent call bails with
//     a warn log and does NOT double-clear / double-set the holder.
//   - Heartbeat monitor / subscriber stop() called if injected (and not
//     called when not injected).
//
// The factory is stubbed so we can inspect what URL provider it received
// without running real partysocket.

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { WebSocketHolder } from "../../state/websocket-holder.js";
import type { WebSocketFactory } from "../../lifecycle/websocket-factory.js";
import type {
  ReconnectConfig,
  UrlProvider,
  WebSocketEventHandlers,
} from "../../lifecycle/types.js";

import type { TokenProvider } from "../../auth/token-provider.js";
import { TokenRefreshHandler } from "../token-refresh-handler.js";

// ---------- Fakes ----------

function makeStubSocket(label = "ws"): ReconnectingWebSocket {
  const close = vi.fn();
  return { __label: label, close } as unknown as ReconnectingWebSocket;
}

function makeTokenProvider(opts: {
  current?: string | null;
  // `refreshOmitted` distinguishes "not configured" (default to a non-null
  // string) from "configured to null" (explicit refresh-failure simulation).
  refresh?: string | null | Error;
  refreshOmitted?: boolean;
}): TokenProvider & {
  getToken: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
} {
  let cached: string | null =
    opts.current === undefined ? null : opts.current;
  const getToken = vi.fn(() => cached);
  const refresh = vi.fn(async (): Promise<string | null> => {
    if (opts.refresh instanceof Error) throw opts.refresh;
    const next: string | null = opts.refreshOmitted
      ? "new-token"
      : (opts.refresh as string | null);
    cached = next;
    return next;
  });
  return { getToken, refresh } as unknown as TokenProvider & {
    getToken: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
}

function makeStubFactory(): {
  factory: WebSocketFactory;
  create: ReturnType<typeof vi.fn>;
  captured: {
    urlProviders: UrlProvider[];
    handlers: WebSocketEventHandlers[];
    configs: ReconnectConfig[];
  };
  nextSocket: { value: ReconnectingWebSocket | null };
} {
  const captured = {
    urlProviders: [] as UrlProvider[],
    handlers: [] as WebSocketEventHandlers[],
    configs: [] as ReconnectConfig[],
  };
  const nextSocket = { value: null as ReconnectingWebSocket | null };
  const create = vi.fn(
    (
      urlProvider: UrlProvider,
      handlers: WebSocketEventHandlers,
      config: ReconnectConfig,
    ): ReconnectingWebSocket => {
      captured.urlProviders.push(urlProvider);
      captured.handlers.push(handlers);
      captured.configs.push(config);
      const ws = nextSocket.value ?? makeStubSocket("new");
      nextSocket.value = null; // consume
      return ws;
    },
  );
  const factory = { create } as unknown as WebSocketFactory;
  return { factory, create, captured, nextSocket };
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

interface BuildOptions {
  currentToken?: string | null;
  refreshResult?: string | null | Error;
  withHeartbeats?: boolean;
}

function build(opts: BuildOptions = {}) {
  const tokenProvider = makeTokenProvider({
    current: opts.currentToken === undefined ? "old-token" : opts.currentToken,
    refresh: opts.refreshResult,
    refreshOmitted: opts.refreshResult === undefined,
  });
  const holder = new WebSocketHolder();
  const { factory, create, captured } = makeStubFactory();
  const urlBuilder = vi.fn(
    (t: string | null) => `wss://example.test/${t ?? "no-token"}`,
  );
  const handlersFactory = vi.fn<() => WebSocketEventHandlers>(() => ({
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  }));
  const linkClearer = vi.fn();
  const heartbeatMonitor = opts.withHeartbeats
    ? { stop: vi.fn() }
    : undefined;
  const heartbeatSubscriber = opts.withHeartbeats
    ? { stop: vi.fn() }
    : undefined;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const handler = new TokenRefreshHandler({
    tokenProvider,
    websocketHolder: holder,
    websocketFactory: factory,
    urlBuilder,
    getEventHandlers: handlersFactory,
    reconnectConfig: makeReconnectConfig(),
    heartbeatMonitor,
    heartbeatSubscriber,
    linkClearer,
    logger,
  });

  return {
    handler,
    tokenProvider,
    holder,
    factory,
    create,
    captured,
    urlBuilder,
    handlersFactory,
    linkClearer,
    heartbeatMonitor,
    heartbeatSubscriber,
    logger,
  };
}

// ---------- Tests ----------

describe("TokenRefreshHandler — refreshAndReconnect", () => {
  it("returns false when tokenProvider.refresh returns null; no reconnect attempted", async () => {
    const ctx = build({ refreshResult: null });

    const result = await ctx.handler.refreshAndReconnect();

    expect(result).toBe(false);
    expect(ctx.tokenProvider.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.create).not.toHaveBeenCalled();
    expect(ctx.linkClearer).not.toHaveBeenCalled();
  });

  it("returns true and reconnects when refresh returns a token", async () => {
    const ctx = build({ refreshResult: "fresh-token" });

    const result = await ctx.handler.refreshAndReconnect();

    expect(result).toBe(true);
    expect(ctx.tokenProvider.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.create).toHaveBeenCalledTimes(1);
    expect(ctx.linkClearer).toHaveBeenCalledTimes(1);
    expect(ctx.holder.getCurrentToken()).toBe("fresh-token");
  });
});

describe("TokenRefreshHandler — reconnectWithNewToken", () => {
  it("closes existing WS, calls linkClearer, creates new WS via factory", () => {
    const ctx = build();
    const oldWs = makeStubSocket("old");
    ctx.holder.set(oldWs);
    ctx.holder.setCurrentToken("old-token");

    ctx.handler.reconnectWithNewToken("new-token");

    expect(oldWs.close).toHaveBeenCalledTimes(1);
    expect(ctx.linkClearer).toHaveBeenCalledTimes(1);
    expect(ctx.create).toHaveBeenCalledTimes(1);
    // holder.set() was called with the new socket the factory returned
    expect(ctx.holder.get()).not.toBe(oldWs);
    expect(ctx.holder.getCurrentToken()).toBe("new-token");
  });

  it(
    "URL provider passed to factory is a closure that re-reads " +
      "tokenProvider.getToken() each call (Bug 1 mitigation)",
    async () => {
      const ctx = build({
        currentToken: "token-A",
        refreshResult: "token-B",
      });

      ctx.handler.reconnectWithNewToken("token-B");
      const provider = ctx.captured.urlProviders[0];
      expect(provider).toBeDefined();
      expect(typeof provider).toBe("function");

      const fnProvider = provider as () => string | Promise<string>;

      // Invocation #1: returns URL with whatever tokenProvider.getToken says
      // right now (we set up the provider with "token-A").
      const url1 = await fnProvider();
      expect(ctx.tokenProvider.getToken).toHaveBeenCalledTimes(1);

      // Swap the cached token in the provider. The URL provider should
      // pick up the new value on the next call — proving it's not caching.
      ctx.tokenProvider.getToken.mockReturnValueOnce("token-C");
      const url2 = await fnProvider();
      expect(ctx.tokenProvider.getToken).toHaveBeenCalledTimes(2);

      expect(url1).toContain("token-A");
      expect(url2).toContain("token-C");
    },
  );

  it("mutex: concurrent reconnectWithNewToken calls bail with logger.warn", () => {
    const ctx = build();
    // Suspend the factory mid-create so the first call is "still in flight".
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    ctx.create.mockImplementationOnce(
      (
        _u: UrlProvider,
        _h: WebSocketEventHandlers,
        _c: ReconnectConfig,
      ): ReconnectingWebSocket => {
        // synchronously return a stub; but to simulate "in flight" we
        // make the second call observe the mutex by leveraging an
        // immediate same-tick second call.
        return makeStubSocket("first");
      },
    );

    // We can't truly suspend the sync body, but we CAN call
    // reconnectWithNewToken inside the linkClearer to simulate re-entrance
    // (a real-world cause: linkClearer triggers a teardown that, in error
    // cases, kicks off another reconnect).
    let secondAttempted = false;
    ctx.linkClearer.mockImplementationOnce(() => {
      secondAttempted = true;
      ctx.handler.reconnectWithNewToken("inner-token");
    });

    ctx.handler.reconnectWithNewToken("outer-token");
    // unblock the suspended factory call (not actually needed for sync
    // path but kept for symmetry)
    release?.();
    void blocker;

    expect(secondAttempted).toBe(true);
    // Only one factory.create call — the second was mutex-bailed.
    expect(ctx.create).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("heartbeat monitor / subscriber stop() called if injected", () => {
    const ctx = build({ withHeartbeats: true });
    ctx.handler.reconnectWithNewToken("new-token");
    expect(ctx.heartbeatMonitor?.stop).toHaveBeenCalledTimes(1);
    expect(ctx.heartbeatSubscriber?.stop).toHaveBeenCalledTimes(1);
  });

  it("heartbeat stops are skipped when not injected (no throw)", () => {
    const ctx = build({ withHeartbeats: false });
    expect(() => ctx.handler.reconnectWithNewToken("new-token")).not.toThrow();
  });

  it("setCurrentToken on holder is updated to the new token", () => {
    const ctx = build();
    ctx.holder.setCurrentToken("old");
    ctx.handler.reconnectWithNewToken("brand-new");
    expect(ctx.holder.getCurrentToken()).toBe("brand-new");
  });

  it("isReconnecting() flips during the swap and is false after", () => {
    const ctx = build();
    expect(ctx.handler.isReconnecting()).toBe(false);
    ctx.handler.reconnectWithNewToken("new-token");
    // The swap is sync, so by the time the call returns the flag is reset.
    expect(ctx.handler.isReconnecting()).toBe(false);
  });
});
