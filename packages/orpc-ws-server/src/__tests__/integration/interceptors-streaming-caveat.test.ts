// Pins the documented LIMITATION of `interceptors`: an AsyncIterable
// procedure that throws MID-STREAM (after the iterator has been returned)
// does NOT trigger the handler-level `interceptors` onError.
//
// Why: the interceptor wraps ORPC's `handle()`, which resolves once the
// procedure RETURNS its async iterator (subscription setup). Errors thrown
// from later `.next()` pulls happen after handle() has already resolved, so
// they ride the event stream to the client but never re-enter the
// interceptor. This is a real coverage edge — asserted here so it's an
// intentional, documented boundary rather than a silent regression.
//
// (Setup failures — a throw BEFORE the first yield, while the handler is
// still producing the iterator — ARE seen by the interceptor; that's the
// "subscription setup" half of the documented behavior. This test isolates
// the mid-stream half.)

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { onError, os, type RouterClient } from "@orpc/server";
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

// Yields one value successfully, THEN throws on the next pull — a genuine
// mid-stream failure (not a setup failure: the iterator is returned and the
// first `.next()` resolves before the throw).
const router = {
  ticks: os.handler(async function* (): AsyncGenerator<number> {
    yield 1;
    throw new Error("mid-stream boom");
  }),
};

type WsLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

describe("interceptors do NOT see a mid-stream AsyncIterable throw", () => {
  it("onError is NOT called when the error is thrown after the iterator is returned", async () => {
    const { http, port, close } = await startHttpServer();

    const onErrorSpy = vi.fn();

    const server = createOrpcWsServer<{ id: string }, typeof router>({
      router,
      // verifyClient must return a Promise — the orchestrator `.then()`s it.
      verifyClient: async () => ({ ok: true, user: { id: "u1" } }),
      interceptors: [onError((e) => onErrorSpy(e))],
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

      // Drive the stream: first value arrives, then the iteration throws.
      const iterator = await client.ticks();
      const drain = async () => {
        const seen: number[] = [];
        for await (const n of iterator as AsyncIterable<number>) {
          seen.push(n);
        }
        return seen;
      };

      await expect(drain()).rejects.toThrow();

      // The documented caveat: the handler-level interceptor never fired,
      // because the error surfaced AFTER handle() resolved the iterator.
      expect(onErrorSpy).not.toHaveBeenCalled();
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
      await server.dispose();
      await close();
    }
  });
});
