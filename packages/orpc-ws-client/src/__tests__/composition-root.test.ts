// Composition-root smoke test.
//
// End-to-end-ish: the real `createOrpcWsClient` factory wired against a
// real `ws`-package WebSocketServer running on an ephemeral loopback port.
// The stub server speaks NO ORPC — it just accepts connections, records
// the upgrade URL, and lets the client connect / disconnect. That's
// enough to pin the public-surface contract at Phase 1.7:
//
//   - `createOrpcWsClient` returns an object with the right shape:
//     `{ rpc, state: { getState, subscribe }, connect, dispose }`.
//   - `state.getState()` returns a tagged-record `ConnectionState`.
//   - `connect()` initiates a real WebSocket handshake to the configured
//     URL — observable from the server side.
//   - The handshake URL carries `?token=` when a tokenProvider is configured
//     and NO `?token=` when one is not (cookie-auth path).
//   - `dispose()` closes the WebSocket and stops further activity.
//
// Full RPC round-trips are deliberately NOT exercised here — that needs
// the server library (Phase 3). Handshake-level assertions are the
// right granularity for Phase 1.7's "the composition root works" claim.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AddressInfo, createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import { createOrpcWsClient, type OrpcWsClient } from "../index.js";
import type { TokenProvider } from "../auth/token-provider.js";

// Minimal contract shape — we never actually call into it; the smoke test
// asserts on transport, not RPC. `unknown` would also work but a stub
// contract type keeps the public-surface generic instantiation honest.
type StubContract = Record<string, never>;

interface StubServerHandle {
  url: string;
  /** All upgrade-request URLs the server saw (in order of arrival). */
  upgradePaths: string[];
  /** Pending `ws` connections so we can close them on teardown. */
  closeAll: () => Promise<void>;
}

/**
 * Spin up a minimal HTTP + WebSocket server on a loopback ephemeral port.
 * The server accepts every connection and records the upgrade URL.
 */
async function spinUpStubServer(): Promise<StubServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const upgradePaths: string[] = [];
  const connections: WsWebSocket[] = [];

  wss.on("connection", (ws: WsWebSocket, req) => {
    if (req.url) upgradePaths.push(req.url);
    connections.push(ws);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  const closeAll = async () => {
    for (const ws of connections) {
      try {
        ws.close();
      } catch {
        // best-effort
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => httpServer.close(() => resolve()));
    });
  };

  return { url, upgradePaths, closeAll };
}

/**
 * Sleep until either the predicate is true or the timeout elapses. We use
 * this in place of arbitrary `setTimeout` waits — the test asserts on
 * what the server saw, and the wait is bounded.
 */
async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`);
}

describe("createOrpcWsClient composition root — public surface", () => {
  let server: StubServerHandle;
  let client: OrpcWsClient<StubContract> | null = null;

  beforeEach(async () => {
    server = await spinUpStubServer();
  });

  afterEach(async () => {
    if (client) {
      try {
        client.dispose();
      } catch {
        // tolerated — assertions in tests may have left it half-disposed
      }
      client = null;
    }
    await server.closeAll();
  });

  it("returns an object with the right shape", () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      // Disable the worker — the smoke test runs in happy-dom and we want
      // no background ticks confusing assertions.
      sleepDetection: false,
    });

    expect(client).toBeTypeOf("object");
    // NOTE: we deliberately do NOT `expect(client.rpc).toBeTypeOf("object")`.
    // `rpc` is a lazy Proxy — any property access (including the property
    // inspection chai does on assertion failure) tries to materialize the
    // RPCLink, which throws "WebSocket not initialized" pre-connect. We
    // check `rpc` was assigned via `Object.hasOwn` which is trap-safe.
    expect(Object.hasOwn(client, "rpc")).toBe(true);
    expect(typeof client.connect).toBe("function");
    expect(typeof client.dispose).toBe("function");
    expect(typeof client.state.getState).toBe("function");
    expect(typeof client.state.subscribe).toBe("function");
  });

  it("state.getState() returns a tagged-record ConnectionState", () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      sleepDetection: false,
    });

    const initial = client.state.getState();
    // Initial state — before connect — is `disconnected({ willRetry: false })`.
    expect(initial).toEqual({ status: "disconnected", willRetry: false });
  });

  it(
    "connect() triggers a real WebSocket handshake to the stub server",
    async () => {
      client = createOrpcWsClient<StubContract>({
        url: server.url,
        sleepDetection: false,
      });

      // Subscribe to state changes so we observe the move to `connected`.
      const transitions: ReturnType<typeof client.state.getState>[] = [];
      const unsubscribe = client.state.subscribe(() => {
        transitions.push(client!.state.getState());
      });

      client.connect();

      // Wait for the server to record at least one upgrade.
      await waitUntil(() => server.upgradePaths.length >= 1);

      // The server saw exactly one upgrade request, and the path is `/`
      // (no `?token=` since we didn't supply a tokenProvider).
      expect(server.upgradePaths.length).toBeGreaterThanOrEqual(1);
      const path = server.upgradePaths[0];
      expect(path).toBe("/");

      // The transitions saw connecting → connected (or at least connecting;
      // the server may not have completed the handshake by the time we
      // checked transition events, depending on happy-dom timing).
      const seenConnecting = transitions.some((s) => s.status === "connecting");
      expect(seenConnecting).toBe(true);

      // Wait for the state to be `connected` once the handshake completes.
      await waitUntil(() => client!.state.getState().status === "connected");
      expect(client.state.getState()).toEqual({ status: "connected" });

      unsubscribe();
    },
  );

  it(
    "tokenProvider — handshake URL carries ?token=<encoded>",
    async () => {
      const tokenProvider: TokenProvider = {
        getToken: () => "tok-abc",
        refresh: vi.fn(async () => "tok-abc"),
      };
      client = createOrpcWsClient<StubContract>({
        url: server.url,
        tokenProvider,
        sleepDetection: false,
      });

      client.connect();

      await waitUntil(() => server.upgradePaths.length >= 1);

      const path = server.upgradePaths[0];
      // URL builder encodes via `URLSearchParams.set`; raw value should
      // appear as `?token=tok-abc`.
      expect(path).toContain("token=tok-abc");
    },
  );

  it(
    "no tokenProvider — handshake URL carries NO ?token= param (cookie-auth path)",
    async () => {
      client = createOrpcWsClient<StubContract>({
        url: server.url,
        // tokenProvider intentionally omitted
        sleepDetection: false,
      });

      client.connect();

      await waitUntil(() => server.upgradePaths.length >= 1);

      const path = server.upgradePaths[0];
      expect(path).not.toContain("token=");
    },
  );

  it("connect() is idempotent — multiple calls produce ONE WebSocket", async () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      sleepDetection: false,
    });

    client.connect();
    client.connect();
    client.connect();

    await waitUntil(() => server.upgradePaths.length >= 1);
    // Even with the partysocket internal reconnect machinery, a sequence
    // of three synchronous connect()s from a `disconnected`/`connecting`
    // state must not open three separate sockets. We tolerate at most
    // one — anything more would be a regression in the idempotency guard.
    // Note: the server may show MORE upgrades over time as partysocket
    // retries on its own, but we check the count immediately after the
    // first upgrade — before partysocket has any reason to retry.
    expect(server.upgradePaths.length).toBe(1);
  });

  it("dispose() closes the WebSocket and stops further activity", async () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      sleepDetection: false,
    });

    client.connect();
    await waitUntil(() => server.upgradePaths.length >= 1);

    // Pre-dispose: we're connected (or close to it).
    // dispose() must result in a terminal `disconnected({willRetry:false})` state.
    client.dispose();

    // After dispose() the state is `disconnected` with willRetry: false.
    const s = client.state.getState();
    expect(s.status).toBe("disconnected");
    if (s.status === "disconnected") {
      expect(s.willRetry).toBe(false);
    }

    // A second connect() after dispose() must NOT open a new WebSocket.
    const upgradesBefore = server.upgradePaths.length;
    client.connect();
    // Brief wait to allow any rogue handshake to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.upgradePaths.length).toBe(upgradesBefore);
  });

  it("disposed client's state subscribe still works (terminal state observable)", () => {
    // Public-surface guarantee: even after dispose, `state` remains
    // queryable. Consumers may still want to read "are we disposed?"
    // without crashing.
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      sleepDetection: false,
    });
    client.dispose();

    expect(() => client!.state.getState()).not.toThrow();
    expect(() => client!.state.subscribe(() => {})()).not.toThrow();
  });

  it("dispose() is idempotent — second call is a no-op", () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      sleepDetection: false,
    });
    client.dispose();
    expect(() => client!.dispose()).not.toThrow();
  });
});
