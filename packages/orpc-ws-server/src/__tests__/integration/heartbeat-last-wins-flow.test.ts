// Heartbeat last-wins, end-to-end (decided 2026-07-02).
//
// The unit suite (`heartbeat/__tests__/heartbeat-last-wins.test.ts`) pins
// the publisher's bound in isolation. This file proves the full plumbing
// composes over a REAL connection: the connection handler stamps the raw
// `ws` identity onto the upgrade context (symbol-keyed — see
// `state/connection-identity.ts`), the stealth procedure reads it back,
// and the publisher enforces last-wins per connection:
//
//   1. The SAME connection calling `__orpc_ws_lib__.heartbeat` twice →
//      the first stream ends gracefully (clean completion at the client,
//      not an error); the second is live. (Would fail pre-fix: the first
//      stream never ended, so each extra call grew server memory until
//      disconnect.)
//   2. TWO different connections each keep their own live subscription —
//      the bound never crosses connections.
//
// Authless server (`allowConcurrentConnections: true` so test 2's two
// sockets coexist) — the heartbeat is pre-auth-state liveness, identical
// in both modes, and authless is exactly where the unbounded-subscription
// memory growth was unauthenticated. Real timers; the heartbeat interval
// is scaled down (50ms) like the other loopback integration suites.

import { describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os } from "@orpc/server";
import { RPCLink } from "@orpc/client/websocket";
import WebSocketClient from "ws";

import { HEARTBEAT_PATH, type HeartbeatEvent } from "@orpc-ws/shared";

import { createAuthlessOrpcWsServer } from "../../index.js";

async function startHttpServer(): Promise<{
  http: HttpServer;
  port: number;
  close: () => Promise<void>;
}> {
  const http = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    http,
    port,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

const router = {
  ping: os.handler(async () => "pong"),
};

// Minimal WS subset RPCLink consumes — `ws` satisfies it at runtime.
type WsLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

async function openWs(port: number): Promise<WebSocketClient> {
  const ws = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });
  return ws;
}

interface Drain {
  events: HeartbeatEvent[];
  /** How the stream exited: clean completion vs error. */
  done: Promise<"ended" | "errored">;
  controller: AbortController;
}

/**
 * Subscribe to the stealth heartbeat over the link exactly the way the
 * library's client core does (`link.call(HEARTBEAT_PATH, ...)`) and drain
 * it in the background.
 */
function startHeartbeatDrain(link: RPCLink<Record<never, never>>): Drain {
  const events: HeartbeatEvent[] = [];
  const controller = new AbortController();
  const done = (async (): Promise<"ended" | "errored"> => {
    try {
      const stream = (await link.call(HEARTBEAT_PATH, undefined, {
        signal: controller.signal,
        context: {},
      })) as AsyncIterable<HeartbeatEvent>;
      for await (const evt of stream) {
        events.push(evt);
      }
      return "ended";
    } catch {
      return "errored";
    }
  })();
  return { events, done, controller };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll until `cond()` or fail after `timeoutMs`. */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await sleep(10);
  }
}

describe("stealth heartbeat — last-wins per connection (end-to-end)", () => {
  it("a second subscription on the SAME connection ends the first stream gracefully; the second stays live", async () => {
    const { http, port, close } = await startHttpServer();
    const server = createAuthlessOrpcWsServer({
      router,
      heartbeat: { intervalMs: 50, timeoutMs: 25, pingPong: false },
    });
    server.attach(http);

    const ws = await openWs(port);
    try {
      const link = new RPCLink<Record<never, never>>({
        websocket: ws as unknown as WsLike,
      });

      // First subscription live: config + at least one ping over the wire.
      const first = startHeartbeatDrain(link);
      await waitFor(() => first.events.some((e) => e.type === "ping"));
      expect(first.events[0]?.type).toBe("config");

      // Same connection subscribes again → the FIRST stream completes
      // CLEANLY (the server generator returns; ORPC propagates the end of
      // stream — not an error). Pre-fix, `first.done` never settles: race
      // against a timeout so the failure is a clear assertion, not a hang.
      const second = startHeartbeatDrain(link);
      const firstOutcome = await Promise.race([
        first.done,
        sleep(2_000).then(() => "timeout" as const),
      ]);
      expect(firstOutcome).toBe("ended");

      // The second (surviving) subscription keeps receiving pings.
      await waitFor(() => second.events.some((e) => e.type === "ping"));
      const firstFrozen = first.events.length;
      const secondSoFar = second.events.length;
      await sleep(150);
      expect(first.events.length).toBe(firstFrozen);
      expect(second.events.length).toBeGreaterThan(secondSoFar);

      second.controller.abort();
      await second.done;
    } finally {
      ws.close();
      await sleep(30);
      await server.dispose();
      await close();
    }
  });

  it("two DIFFERENT connections each keep their own live subscription", async () => {
    const { http, port, close } = await startHttpServer();
    // Concurrent authless so the second socket doesn't 4005-kick the first
    // — this test is about heartbeat identity, not session replacement.
    const server = createAuthlessOrpcWsServer({
      router,
      allowConcurrentConnections: true,
      heartbeat: { intervalMs: 50, timeoutMs: 25, pingPong: false },
    });
    server.attach(http);

    const wsA = await openWs(port);
    const wsB = await openWs(port);
    try {
      const linkA = new RPCLink<Record<never, never>>({
        websocket: wsA as unknown as WsLike,
      });
      const linkB = new RPCLink<Record<never, never>>({
        websocket: wsB as unknown as WsLike,
      });

      const drainA = startHeartbeatDrain(linkA);
      const drainB = startHeartbeatDrain(linkB);

      // Both live simultaneously — B's subscription did NOT displace A's
      // (each connection has its own identity stamp).
      await waitFor(() => drainA.events.some((e) => e.type === "ping"));
      await waitFor(() => drainB.events.some((e) => e.type === "ping"));

      // And they STAY live together: both keep accumulating pings.
      const aSoFar = drainA.events.length;
      const bSoFar = drainB.events.length;
      await sleep(150);
      expect(drainA.events.length).toBeGreaterThan(aSoFar);
      expect(drainB.events.length).toBeGreaterThan(bSoFar);

      drainA.controller.abort();
      drainB.controller.abort();
      await Promise.all([drainA.done, drainB.done]);
    } finally {
      wsA.close();
      wsB.close();
      await sleep(30);
      await server.dispose();
      await close();
    }
  });
});
