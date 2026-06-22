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

import { describe, expect, it } from "vitest";
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
});
