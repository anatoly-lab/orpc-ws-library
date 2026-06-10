// Bug 13 regression — `connect()` during the auto-retry window must NOT
// create a duplicate socket.
//
// docs/fable/bugs-review.md BUG-2: after any drop the state is
// `disconnected({willRetry: true})` while the EXISTING partysocket
// wrapper is still auto-retrying internally (default maxRetries:
// Infinity). The old idempotency guard only excluded `connecting` /
// `connected` / `kicked`, so a `connect()` call in that window — exactly
// the "idempotent, call it freely" usage the docs invite (a "retry now"
// button, a React effect re-run) — passed the guard, created a SECOND
// wrapper, and `websocketHolder.set(ws)` overwrote the reference. The
// orphaned wrapper was never closed and kept reconnecting forever: two
// live server connections, and with the server's default
// `singleConnectionPerUser` the two wrappers perpetually 4005-kick each
// other into a terminal `kicked` the user never caused.
//
// Fix under test (composition level, real stub server speaking raw WS):
// `connect()` no-ops when a wrapper already exists in the holder — the
// library owns reconnect, so the correct idempotent behavior is to leave
// the retrying wrapper alone.
//
// Determinism: partysocket's retry delay is pinned far beyond the test
// horizon, so the existing wrapper sits parked in its retry window. Any
// NEW upgrade reaching the server inside the grace window can only come
// from a second wrapper created by `connect()` — the pre-fix failure
// signature.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import { createOrpcWsClient, type OrpcWsClient } from "../index.js";

type StubContract = Record<string, never>;

interface DroppingServerHandle {
  url: string;
  /** Count of upgrade attempts that reached the server. */
  upgradeCount: () => number;
  /** Abruptly sever every live connection (client sees a 1006 close). */
  dropAll: () => void;
  close: () => Promise<void>;
}

/**
 * HTTP + WS server that accepts every handshake and holds the connection
 * open until the test calls `dropAll()` — `terminate()` severs the TCP
 * socket without a close frame, so the client observes code 1006, the
 * wire shape of "network drop" that routes to `normal-disconnect`
 * (state `disconnected({code: 1006, willRetry: true})`) and leaves the
 * partysocket wrapper auto-retrying.
 */
async function spinUpDroppingServer(): Promise<DroppingServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let upgrades = 0;
  const connections: WsWebSocket[] = [];

  wss.on("connection", (ws: WsWebSocket) => {
    upgrades += 1;
    connections.push(ws);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}`,
    upgradeCount: () => upgrades,
    dropAll: () => {
      for (const ws of connections) {
        try {
          ws.terminate();
        } catch {
          // best-effort
        }
      }
      connections.length = 0;
    },
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
 * Park partysocket's internal retry FAR beyond the test horizon: after
 * the drop, the existing wrapper sits in its retry window for ~5 minutes
 * without dialing out. Any upgrade the server sees inside the test's
 * grace window is therefore attributable ONLY to a duplicate wrapper —
 * the exact pre-fix bug.
 */
const PARKED_RETRY = {
  minReconnectionDelay: 300_000,
  maxReconnectionDelay: 300_000,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 500,
};

describe("Bug 13 — connect() during the auto-retry window (composition root)", () => {
  let server: DroppingServerHandle;
  let client: OrpcWsClient<StubContract> | null = null;

  beforeEach(async () => {
    server = await spinUpDroppingServer();
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

  it("connect() while disconnected({willRetry: true}) is a no-op — no second socket", async () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      reconnect: PARKED_RETRY,
      sleepDetection: false,
    });

    client.connect();
    await waitUntil(() => client!.state.getState().status === "connected");
    expect(server.upgradeCount()).toBe(1);

    // Sever the connection — the client lands in the retry window:
    // `disconnected({willRetry: true})` with the wrapper still in the
    // holder, parked on its (deliberately huge) reconnect delay.
    server.dropAll();
    await waitUntil(() => {
      const s = client!.state.getState();
      return s.status === "disconnected" && s.willRetry;
    });

    // The bug trigger: a "retry now" button / effect re-run calls
    // connect() inside the window. Pre-fix this passed the status guard
    // and dialed a SECOND wrapper immediately (upgradeCount → 2 within
    // milliseconds, since a fresh partysocket connects right away).
    client.connect();
    client.connect(); // twice — the guard must hold under repeated calls

    await sleep(300);
    expect(server.upgradeCount()).toBe(1);

    // The no-op must not touch state either: a `connecting` frame here
    // would be a lie (nothing new was dialed) and would clobber the
    // retry-window `disconnected` record the UI renders. (The exact close
    // code is environment-dependent — happy-dom vs. browser — so we pin
    // the tag and the retry flag, not the code.)
    const after = client.state.getState();
    expect(after.status).toBe("disconnected");
    if (after.status === "disconnected") {
      expect(after.willRetry).toBe(true);
    }
  });

  it("the retrying wrapper stays owned by the library — dispose() still kills it", async () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      reconnect: PARKED_RETRY,
      sleepDetection: false,
    });

    client.connect();
    await waitUntil(() => client!.state.getState().status === "connected");
    server.dropAll();
    await waitUntil(() => {
      const s = client!.state.getState();
      return s.status === "disconnected" && s.willRetry;
    });

    // connect() no-opped, so the holder still owns the ORIGINAL wrapper —
    // dispose() must find and close it (no orphan left retrying). Pre-fix,
    // holder.set() had replaced the reference and dispose() could only
    // close the duplicate, leaking the original for the page lifetime.
    client.connect();
    client.dispose();

    expect(client.state.getState()).toEqual({
      status: "disconnected",
      willRetry: false,
    });
    await sleep(200);
    expect(server.upgradeCount()).toBe(1);
  });
});
