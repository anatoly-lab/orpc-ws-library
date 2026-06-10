// Bug 14 regression — "terminal auth failure" must actually be terminal.
//
// docs/fable/bugs-review.md BUG-3: the public contract
// (`OrpcWsClientOptions.onTerminalAuthFailure`) says "the client is
// terminal after this fires". The implementation never made that true:
//
//   - the partysocket wrapper kept auto-retrying with the stale token,
//   - every rejected retry re-entered auth recovery and re-fired
//     `onTerminalAuthFailure` (storm guard → terminal #2, #3, …),
//   - past the 30s window the library performed ANOTHER network refresh
//     — a connection storm against both the WS endpoint and the IdP,
//   - state stayed `disconnected({willRetry: true})` forever — the UI
//     was told the library was still retrying after it had given up.
//
// Fix under test (composition level, real stub server speaking raw WS):
//   1. `onTerminalAuthFailure` fires AT MOST ONCE per client.
//   2. The wrapper is closed — partysocket's internal retry loop stops
//      (no further upgrade attempts land on the server).
//   3. State transitions to `disconnected({willRetry: false})`.
//   4. `connect()` after terminal is a no-op (one-way door; the consumer
//      creates a new client post-re-auth).
//   5. The no-tokenProvider branch routes through the same single-fire
//      path.
//
// The stub server rejects every connection by closing with 1008 right
// after the handshake — the wire shape of "server-side auth policy says
// no" that drives the client's auth-recovery path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import {
  createOrpcWsClient,
  type ClientEvent,
  type OrpcWsClient,
} from "../index.js";
import type { TokenProvider } from "../auth/token-provider.js";

type StubContract = Record<string, never>;

interface RejectingServerHandle {
  url: string;
  /** Count of upgrade attempts that reached the server. */
  upgradeCount: () => number;
  close: () => Promise<void>;
}

/**
 * HTTP + WS server that accepts the handshake then immediately closes
 * with 1008 ("Policy Violation" — the standard auth-reject code the
 * client's close-decision tree routes to auth-recovery).
 */
async function spinUpRejectingServer(): Promise<RejectingServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let upgrades = 0;

  wss.on("connection", (ws: WsWebSocket) => {
    upgrades += 1;
    ws.close(1008, "Auth rejected");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}`,
    upgradeCount: () => upgrades,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tight partysocket retry knobs so that, ABSENT the fix, the wrapper
 * would visibly retry several times within the post-terminal grace
 * window below — making the "retries stopped" assertion meaningful in
 * test-scale time.
 */
const FAST_RETRY = {
  minReconnectionDelay: 20,
  maxReconnectionDelay: 40,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 500,
};

describe("Bug 14 — terminal auth failure is terminal (composition root)", () => {
  let server: RejectingServerHandle;
  let client: OrpcWsClient<StubContract> | null = null;

  beforeEach(async () => {
    server = await spinUpRejectingServer();
  });

  afterEach(async () => {
    if (client) {
      try {
        client.dispose();
      } catch {
        // tolerated
      }
      client = null;
    }
    await server.close();
  });

  it(
    "refresh-returns-null: fires once, stops retries, sets terminal state, blocks connect()",
    async () => {
      const refresh = vi.fn(async () => null);
      const tokenProvider: TokenProvider = {
        getToken: () => "tok-stale",
        refresh,
      };
      const onTerminalAuthFailure = vi.fn();
      const events: ClientEvent[] = [];

      client = createOrpcWsClient<StubContract>({
        url: server.url,
        tokenProvider,
        onTerminalAuthFailure,
        onEvent: (evt) => events.push(evt),
        reconnect: FAST_RETRY,
        sleepDetection: false,
      });

      client.connect();

      // 1008 close → auth recovery → refresh() → null → terminal.
      await waitUntil(() => onTerminalAuthFailure.mock.calls.length >= 1);

      // (3) Terminal state: willRetry MUST be false — the library gave up.
      expect(client.state.getState()).toEqual({
        status: "disconnected",
        willRetry: false,
      });

      // (2) The wrapper's retry loop is dead: across several would-be
      // retry intervals (20–40ms each), the server sees no new upgrades
      // and the IdP (refresh) is not hit again.
      const upgradesAtTerminal = server.upgradeCount();
      await sleep(300);
      expect(server.upgradeCount()).toBe(upgradesAtTerminal);
      expect(refresh).toHaveBeenCalledTimes(1);

      // (1) Single fire — pre-fix this kept climbing with every retry.
      expect(onTerminalAuthFailure).toHaveBeenCalledTimes(1);
      const terminalEvents = events.filter(
        (e) => e.type === "auth_failure" && !e.refreshable,
      );
      expect(terminalEvents.length).toBe(1);

      // (4) connect() after terminal is a no-op — no new socket.
      client.connect();
      await sleep(100);
      expect(server.upgradeCount()).toBe(upgradesAtTerminal);
      expect(client.state.getState()).toEqual({
        status: "disconnected",
        willRetry: false,
      });
    },
  );

  it(
    "no-tokenProvider branch routes through the same single-fire terminal path",
    async () => {
      const onTerminalAuthFailure = vi.fn();
      const events: ClientEvent[] = [];

      client = createOrpcWsClient<StubContract>({
        url: server.url,
        // tokenProvider intentionally omitted — cookie-auth path. Auth
        // recovery is impossible; the library must go terminal ONCE.
        onTerminalAuthFailure,
        onEvent: (evt) => events.push(evt),
        reconnect: FAST_RETRY,
        sleepDetection: false,
      });

      client.connect();

      await waitUntil(() => onTerminalAuthFailure.mock.calls.length >= 1);

      const upgradesAtTerminal = server.upgradeCount();
      await sleep(300);

      // Pre-fix: this branch fired terminal on EVERY close-triggered
      // recovery while partysocket retried forever.
      expect(onTerminalAuthFailure).toHaveBeenCalledTimes(1);
      expect(server.upgradeCount()).toBe(upgradesAtTerminal);
      expect(client.state.getState()).toEqual({
        status: "disconnected",
        willRetry: false,
      });
      expect(
        events.filter((e) => e.type === "auth_failure" && !e.refreshable)
          .length,
      ).toBe(1);
    },
  );

  it("a throwing consumer onTerminalAuthFailure does not break the teardown", async () => {
    const onTerminalAuthFailure = vi.fn(() => {
      throw new Error("consumer redirect blew up");
    });

    client = createOrpcWsClient<StubContract>({
      url: server.url,
      tokenProvider: { getToken: () => "tok", refresh: async () => null },
      onTerminalAuthFailure,
      reconnect: FAST_RETRY,
      sleepDetection: false,
    });

    client.connect();
    await waitUntil(() => onTerminalAuthFailure.mock.calls.length >= 1);

    // Teardown ran BEFORE the consumer callback — state is terminal and
    // the retry loop is dead despite the throw.
    expect(client.state.getState()).toEqual({
      status: "disconnected",
      willRetry: false,
    });
    const upgrades = server.upgradeCount();
    await sleep(200);
    expect(server.upgradeCount()).toBe(upgrades);
  });
});
