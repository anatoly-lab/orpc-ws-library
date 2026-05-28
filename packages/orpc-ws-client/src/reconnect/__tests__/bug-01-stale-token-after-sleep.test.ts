// Bug 1 regression — "stale token after sleep".
//
// Source-app scenario:
//   1. Client connects with `tok-old`.
//   2. The device sleeps. While asleep, the consumer's auth subsystem
//      refreshes the token in the background (or another tab does), and
//      cached storage now holds `tok-new`.
//   3. The device wakes. partysocket sees the dropped connection and
//      kicks off its internal reconnect loop.
//   4. WITHOUT the fix: the original WebSocket URL was a static string
//      built at connect time — it carries `tok-old`. partysocket reuses
//      the same URL for every retry, so the reconnect attempts use a
//      stale token, the server rejects them with 1008, and the storm
//      guard eventually fires `onTerminalAuthFailure` even though a fresh
//      token was sitting in storage all along.
//   5. WITH the fix (preserved in TokenRefreshHandler.createUrlProvider):
//      the URL is built via a CLOSURE that re-reads tokenProvider.getToken()
//      on each invocation. partysocket invokes that closure on every
//      reconnect — so the next retry picks up `tok-new` automatically.
//
// This file is an integration-flavored unit test: real ReconnectManager +
// real TokenRefreshHandler + real WebSocketHolder + fake factory. We do
// NOT spin up a real partysocket — we inspect the URL provider it was
// handed and call it ourselves, which is exactly what partysocket does
// internally on each reconnect attempt.

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { WebSocketHolder } from "../../state/websocket-holder.js";
import type { WebSocketFactory } from "../../lifecycle/websocket-factory.js";
import type {
  ReconnectConfig,
  UrlProvider,
  WebSocketEventHandlers,
} from "../../lifecycle/types.js";

import type {
  Clock,
  Logger,
  Rng,
  TimerHandle,
} from "@repo/orpc-ws-shared";

import type { TokenProvider } from "../../auth/token-provider.js";
import { TokenRefreshHandler } from "../token-refresh-handler.js";
import { ReconnectManager } from "../reconnect-manager.js";

// ---------- Helpers (small subset of reconnect-manager.test.ts fakes) ----------

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
} {
  let now = 0;
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
    clearTimeout: (h) => {
      fromHandle(h).cancelled = true;
    },
    setInterval: () => {
      throw new Error("unused");
    },
    clearInterval: () => {
      throw new Error("unused");
    },
  };
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

const fixedRng: Rng = { next: () => 0 };
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeStubSocket(label: string): ReconnectingWebSocket {
  const close = vi.fn();
  return { __label: label, close } as unknown as ReconnectingWebSocket;
}

function makeStubFactory(): {
  factory: WebSocketFactory;
  captured: { urlProviders: UrlProvider[] };
  create: ReturnType<typeof vi.fn>;
} {
  const captured = { urlProviders: [] as UrlProvider[] };
  const create = vi.fn(
    (
      urlProvider: UrlProvider,
      _handlers: WebSocketEventHandlers,
      _config: ReconnectConfig,
    ): ReconnectingWebSocket => {
      captured.urlProviders.push(urlProvider);
      return makeStubSocket("post-reconnect");
    },
  );
  const factory = { create } as unknown as WebSocketFactory;
  return { factory, captured, create };
}

const dummyReconnectConfig: ReconnectConfig = {
  maxRetries: 5,
  maxReconnectionDelay: 10_000,
  minReconnectionDelay: 1_000,
  reconnectionDelayGrowFactor: 1.3,
  connectionTimeout: 5_000,
  maxEnqueuedMessages: 0,
};

// ---------- The test ----------

describe("Bug 1 — stale-token-after-sleep", () => {
  it(
    "URL provider closure passed to the WS factory re-reads the token on " +
      "every invocation, so a post-sleep reconnect picks up the swapped token",
    async () => {
      // Step 1 — initial token in the consumer's auth store is `tok-old`.
      // We simulate the consumer's storage with a single mutable variable
      // captured by the TokenProvider closure.
      let storedToken: string | null = "tok-old";

      const tokenProvider: TokenProvider = {
        getToken: () => storedToken,
        // refresh() returns whatever's in storage. The library shouldn't
        // need to call it in this scenario — the token was already swapped
        // by some out-of-band path (proactive refresh on resume, say).
        refresh: vi.fn(async () => storedToken),
      };

      const holder = new WebSocketHolder();
      const { factory, captured } = makeStubFactory();
      const urlBuilder = (t: string | null): string =>
        `wss://ws.test/?token=${encodeURIComponent(t ?? "")}`;
      const linkClearer = vi.fn();
      const eventHandlers: WebSocketEventHandlers = {
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onError: vi.fn(),
      };

      const tokenRefreshHandler = new TokenRefreshHandler({
        tokenProvider,
        websocketHolder: holder,
        websocketFactory: factory,
        urlBuilder,
        getEventHandlers: () => eventHandlers,
        reconnectConfig: dummyReconnectConfig,
        linkClearer,
        logger: silentLogger,
      });

      const { clock, advance } = makeFakeClock();
      const onTerminalAuthFailure = vi.fn();
      const manager = new ReconnectManager({
        tokenRefreshHandler,
        reconnectConfig: {
          debounceMs: 100,
          jitterMs: 0,
          minRefreshIntervalMs: 30_000,
        },
        onTerminalAuthFailure,
        clock,
        rng: fixedRng,
        logger: silentLogger,
      });

      // Step 2 — simulate sleep: another tab / proactive refresher swaps the
      // stored token to "tok-new". The library has no idea this happened.
      storedToken = "tok-new";

      // Step 3 — wake-from-sleep triggers manager.reconnect(). The manager
      // debounces, then calls tokenRefreshHandler.refreshAndReconnect.
      // refresh() returns the SAME stored token ("tok-new"), so we hit the
      // reconnectWithNewToken path — and the URL provider it captures must
      // produce a URL with "tok-new", NOT "tok-old".
      const p = manager.reconnect();
      await advance(100); // debounce + 0 jitter

      await p;

      // Capture the URL provider the factory was handed.
      expect(captured.urlProviders.length).toBe(1);
      const provider = captured.urlProviders[0] as () => string | Promise<string>;
      const url = await provider();

      expect(url).toContain("tok-new");
      expect(url).not.toContain("tok-old");
      expect(onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "subsequent partysocket-internal reconnect attempts re-read the token: " +
      "if the consumer rotates again, the next retry picks up the latest",
    async () => {
      // This pins the SECOND half of Bug 1: not just "the post-refresh
      // reconnect uses the right token", but "every retry partysocket runs
      // ALSO uses the latest token". partysocket invokes the URL provider
      // on each internal retry; we simulate that by calling it ourselves
      // twice with a store mutation in between.
      let storedToken: string | null = "tok-1";

      const tokenProvider: TokenProvider = {
        getToken: () => storedToken,
        refresh: vi.fn(async () => storedToken),
      };

      const holder = new WebSocketHolder();
      const { factory, captured } = makeStubFactory();
      const handler = new TokenRefreshHandler({
        tokenProvider,
        websocketHolder: holder,
        websocketFactory: factory,
        urlBuilder: (t) =>
          `wss://ws.test/?token=${encodeURIComponent(t ?? "")}`,
        getEventHandlers: () =>
          ({
            onOpen: vi.fn(),
            onClose: vi.fn(),
            onError: vi.fn(),
          } as WebSocketEventHandlers),
        reconnectConfig: dummyReconnectConfig,
        linkClearer: vi.fn(),
        logger: silentLogger,
      });

      handler.reconnectWithNewToken("tok-1");

      const provider = captured.urlProviders[0] as () =>
        | string
        | Promise<string>;

      const url1 = await provider();
      expect(url1).toContain("tok-1");

      // Mid-reconnect-loop, the consumer's storage rotates again.
      storedToken = "tok-2";
      const url2 = await provider();
      expect(url2).toContain("tok-2");

      // Third call — same retry-after-retry behavior expected.
      storedToken = "tok-3";
      const url3 = await provider();
      expect(url3).toContain("tok-3");
    },
  );
});
