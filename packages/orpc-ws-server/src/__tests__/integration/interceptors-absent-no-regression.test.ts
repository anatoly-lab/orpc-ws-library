// No-regression guard: a server built with NO interceptors behaves exactly
// as before. Passing neither `interceptors` nor `rootInterceptors` forwards
// `undefined` to the RPCHandler — a documented no-op — so a healthy call
// succeeds and a failing call still rejects, with no interceptor in the path.

import { describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os, type RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import WebSocketClient from "ws";

import { createOrpcWsServer } from "../../index.js";

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
  boom: os.handler(async () => {
    throw new Error("boom");
  }),
};

type WsLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

describe("server with NO interceptors behaves identically", () => {
  it("healthy call resolves and failing call rejects, no interceptors set", async () => {
    const { http, port, close } = await startHttpServer();

    const server = createOrpcWsServer<{ id: string }, typeof router>({
      router,
      // verifyClient must return a Promise — the orchestrator `.then()`s it.
      verifyClient: async () => ({ ok: true, user: { id: "u1" } }),
      // Deliberately NO interceptors / rootInterceptors.
    });
    server.attach(http);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    try {
      const link = new RPCLink({ websocket: ws as unknown as WsLike });
      const client = createORPCClient<RouterClient<typeof router>>(link);

      await expect(client.ping()).resolves.toBe("pong");
      await expect(client.boom()).rejects.toThrow();
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
      await server.dispose();
      await close();
    }
  });
});
