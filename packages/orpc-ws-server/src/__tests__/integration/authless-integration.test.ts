// AUTHLESS integration: boots, RPC round-trips, heartbeat keeps working,
// and NO token is ever sent on the wire.
//
// Complements authless-context.test.ts (which pins the empty context).
// Here we pin the end-to-end happy path:
//   - `createAuthlessOrpcWsServer({ router })` boots + attaches.
//   - A real RPC procedure round-trips over the WS RPCLink.
//   - The heartbeat stealth procedure is unaffected: the server's
//     ping/pong watchdog runs and the connection stays open across
//     several intervals with no app traffic (heartbeat is pre-auth, so
//     authless must not disturb it).
//   - The client connects with NO `?token=` query.

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os, type RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import WebSocketClient from "ws";

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
  echo: os.handler(async ({ input }) => input as string),
};

// Minimal WS subset RPCLink consumes — `ws` satisfies it at runtime.
type WsLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

describe("AUTHLESS — end-to-end", () => {
  it("boots, RPC round-trips, heartbeat keeps the connection alive, no token sent", async () => {
    const { http, port, close } = await startHttpServer();
    // Fast heartbeat cadence so the test exercises a few intervals quickly.
    const server = createAuthlessOrpcWsServer({
      router,
      heartbeat: { intervalMs: 150, timeoutMs: 80, pingPong: true },
    });
    server.attach(http);

    // No `?token=` — the connect URL carries no credentials at all.
    const url = `ws://127.0.0.1:${port}/ws`;
    expect(url).not.toContain("token");
    const ws = new WebSocketClient(url);

    const closes: number[] = [];
    ws.on("close", (code) => closes.push(code));

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    try {
      const link = new RPCLink({
        websocket: ws as unknown as WsLike,
      });
      const client = createORPCClient<RouterClient<typeof router>>(link);

      // RPC round-trips.
      expect(await client.echo("hello")).toBe("hello");

      // Idle across ~4 heartbeat intervals — the connection must stay open
      // (heartbeat ping/pong keeps it alive; authless didn't break it).
      await new Promise((r) => setTimeout(r, 700));
      expect(closes).toHaveLength(0);
      expect(ws.readyState).toBe(WebSocketClient.OPEN);

      // RPC still works after the idle window.
      expect(await client.echo("again")).toBe("again");
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
      await server.dispose();
      await close();
    }
  });

  // Behavior change: authless DEFAULTS to a single global connection — a new
  // connection kicks the previous with 4005 (single-GUI remote-control model).
  // Models the authenticated kick test in ../integration/hooks.test.ts.
  it("DEFAULT single-connection: a second connection kicks the first with 4005 and fires onKicked", async () => {
    const onKicked = vi.fn();
    const { http, port, close } = await startHttpServer();
    // No allowConcurrentConnections → the single-global-connection default.
    const server = createAuthlessOrpcWsServer({
      router,
      hooks: { onKicked },
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      const c1 = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        c1.on("open", () => resolve());
        c1.on("error", (err) => reject(err));
      });

      const c1ClosePromise = new Promise<{ code: number }>((resolve) => {
        c1.on("close", (code) => resolve({ code }));
      });

      const c2 = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        c2.on("open", () => resolve());
        c2.on("error", (err) => reject(err));
      });

      // c1 is kicked with the session-replaced code (4005).
      const c1Close = await c1ClosePromise;
      expect(c1Close.code).toBe(4005);

      // onKicked fired exactly once; the authless hook receives only the
      // replacing WS (no user param).
      expect(onKicked).toHaveBeenCalledTimes(1);
      expect(onKicked.mock.calls[0]).toHaveLength(1);
      expect(onKicked.mock.calls[0]?.[0]).toBeDefined();

      // c2 is still the live connection.
      expect(c2.readyState).toBe(WebSocketClient.OPEN);

      c2.close();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      await server.dispose();
      await close();
    }
  });

  // The highest-value coverage gap: after a kick, the REPLACING connection must
  // be a fully-functional RPC endpoint — not merely "the old one got 4005".
  // Open A, open B (kicks A with 4005), then round-trip a real RPC over B.
  it("DEFAULT single-connection: the connection that kicks is fully functional (RPC round-trips over it)", async () => {
    const { http, port, close } = await startHttpServer();
    const server = createAuthlessOrpcWsServer({
      router,
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    let c1: WebSocketClient | undefined;
    let c2: WebSocketClient | undefined;
    try {
      c1 = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        c1?.on("open", () => resolve());
        c1?.on("error", (err) => reject(err));
      });

      // Await c1's kick BEFORE touching c2 — this makes the test deterministic
      // (the registry has definitely swapped to c2 by the time 4005 lands) and
      // pins the precondition: the new connection is exercised POST-kick.
      const c1ClosePromise = new Promise<{ code: number }>((resolve) => {
        c1?.on("close", (code) => resolve({ code }));
      });

      c2 = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        c2?.on("open", () => resolve());
        c2?.on("error", (err) => reject(err));
      });

      expect((await c1ClosePromise).code).toBe(4005);

      // The replacing connection (c2) must serve RPC normally.
      const link = new RPCLink({ websocket: c2 as unknown as WsLike });
      const client = createORPCClient<RouterClient<typeof router>>(link);
      expect(await client.echo("post-kick")).toBe("post-kick");
      // Works twice — proves the socket is a live, reusable RPC endpoint, not a
      // one-shot fluke that happened to survive the kick.
      expect(await client.echo("still-alive")).toBe("still-alive");
    } finally {
      c1?.close();
      c2?.close();
      await new Promise((r) => setTimeout(r, 30));
      await server.dispose();
      await close();
    }
  });

  // The opt-out restores the pre-flip behavior: connections coexist.
  it("allowConcurrentConnections: two connections coexist — no kick, no onKicked", async () => {
    const onKicked = vi.fn();
    const { http, port, close } = await startHttpServer();
    const server = createAuthlessOrpcWsServer({
      router,
      allowConcurrentConnections: true,
      hooks: { onKicked },
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      const c1 = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      const c1Closes: number[] = [];
      c1.on("close", (code) => c1Closes.push(code));
      await new Promise<void>((resolve, reject) => {
        c1.on("open", () => resolve());
        c1.on("error", (err) => reject(err));
      });

      const c2 = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        c2.on("open", () => resolve());
        c2.on("error", (err) => reject(err));
      });

      // Give any (erroneous) kick a moment to land.
      await new Promise((r) => setTimeout(r, 50));

      // Neither connection was kicked; both stay open.
      expect(c1Closes).toHaveLength(0);
      expect(onKicked).not.toHaveBeenCalled();
      expect(c1.readyState).toBe(WebSocketClient.OPEN);
      expect(c2.readyState).toBe(WebSocketClient.OPEN);

      c1.close();
      c2.close();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      await server.dispose();
      await close();
    }
  });
});
