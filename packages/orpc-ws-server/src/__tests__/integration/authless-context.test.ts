// AUTHLESS integration: a procedure runs with the EMPTY context `{}`.
//
// Pins the core authless contract: `createAuthlessOrpcWsServer` accepts
// every upgrade (no verifyClient) and hands the consumer's procedures an
// empty ORPC context — NO `user`, NO `token` keys. A real `ws` client +
// the ORPC WS RPCLink drive an actual round-trip so the context the
// procedure observes is the real one, not a fake.

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

// The procedure echoes back the keys of its ORPC context, so the test can
// assert "context has no user/token" against the wire result.
const router = {
  contextKeys: os.handler(async ({ context }) =>
    Object.keys(context as Record<string, unknown>).sort(),
  ),
};

// Minimal WS subset RPCLink consumes — `ws` satisfies it at runtime.
type WsLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

describe("AUTHLESS — procedure runs with empty context", () => {
  it("context handed to ORPC is {} (no user, no token)", async () => {
    const { http, port, close } = await startHttpServer();
    const server = createAuthlessOrpcWsServer({ router });
    server.attach(http);

    // No `?token=` — authless never reads or requires one.
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    try {
      const link = new RPCLink({
        // `ws` implements the DOM-ish subset RPCLink needs.
        websocket: ws as unknown as WsLike,
      });
      const client = createORPCClient<RouterClient<typeof router>>(link);

      const keys = await client.contextKeys();
      expect(keys).toEqual([]);
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
      await server.dispose();
      await close();
    }
  });
});
