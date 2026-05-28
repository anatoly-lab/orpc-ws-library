// Phase 4 — dispose() ordering: graceful close BEFORE TCP RST.
//
// The Nest adapter (Phase 5) wires `dispose()` to
// `BeforeApplicationShutdown` so it runs BEFORE the HTTP server stops
// accepting / serving. For consumers reading the contract from the core,
// the load-bearing property is:
//
//   On `server.dispose()`, every connected client receives a clean WS
//   close frame with the configured shutdownCloseCode (4009 by default)
//   BEFORE the underlying TCP socket is torn down.
//
// "Before the TCP RST" is observable: a clean close arrives as
// `'close'` with the explicit code 4009 + reason. A raw RST arrives as
// `'close'` with code 1006 (abnormal closure) and no reason. Asserting
// each client got the 4009 close pins the ordering.
//
// We also pin: `dispose()` is idempotent (second call is a no-op),
// and after dispose, `wss` is null on the server (no further upgrades
// accepted on that port).

import { describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os } from "@orpc/server";
import WebSocketClient from "ws";

import { OrpcWsServer, type VerifyClient } from "../../index.js";

interface TestUser {
  sub: string;
}

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

describe("OrpcWsServer — dispose() graceful close ordering", () => {
  it("all connected clients receive close code 4009 (shutdown) on dispose()", async () => {
    // Three different users so the registry doesn't kick anyone before
    // dispose runs (singleConnectionPerUser is on by default).
    let nextId = 0;
    const verify: VerifyClient<TestUser> = async () => {
      const id = `user-${++nextId}`;
      return { ok: true, user: { sub: id }, connectionKey: id };
    };

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      // Disable ping/pong so the watchdog can't race with dispose
      // teardown in the test window.
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    const closeEvents: { code: number; reason: string }[][] = [[], [], []];
    const clients: WebSocketClient[] = [];

    try {
      // Open 3 concurrent clients.
      for (let i = 0; i < 3; i++) {
        const idx = i;
        const c = new WebSocketClient(
          `ws://127.0.0.1:${port}/ws?token=ok-${i}`,
        );
        clients.push(c);
        c.on("close", (code, reasonBuf) => {
          closeEvents[idx]!.push({ code, reason: reasonBuf.toString() });
        });
        await new Promise<void>((resolve, reject) => {
          c.on("open", () => resolve());
          c.on("error", (err) => reject(err));
        });
      }

      // All three open — trigger the graceful shutdown.
      const disposePromise = server.dispose();

      // Wait for every client to have observed its close event.
      await Promise.all(
        clients.map(
          (c) =>
            new Promise<void>((resolve) => {
              if (c.readyState === WebSocketClient.CLOSED) return resolve();
              c.once("close", () => resolve());
            }),
        ),
      );

      await disposePromise;

      // Each client got exactly one close event with the configured
      // shutdown close code (4009) and the standard reason. 4009 is the
      // proof of "clean close BEFORE TCP RST": an RST would land as
      // 1006 (abnormal) with no reason payload.
      for (let i = 0; i < 3; i++) {
        const events = closeEvents[i]!;
        expect(events.length).toBe(1);
        expect(events[0]?.code).toBe(4009);
        expect(events[0]?.reason).toBe("Server shutdown");
      }
    } finally {
      // Clean up any sockets / handles still hanging.
      clients.forEach((c) => {
        try {
          c.terminate();
        } catch {
          // ignore
        }
      });
      await close();
    }
  });

  it("after dispose(), the WSS is detached — new connections cannot upgrade", async () => {
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user: { sub: "u1" },
      connectionKey: "u1",
    });

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      // Establish + dispose.
      const live = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=ok`);
      await new Promise<void>((resolve, reject) => {
        live.on("open", () => resolve());
        live.on("error", (err) => reject(err));
      });

      await server.dispose();

      // The HTTP server is still listening (the consumer / framework
      // owns its lifecycle); but the WSS has been closed. New upgrade
      // attempts on the same path return a non-101 response.
      //
      // We observe this as the client never firing `open`. (`ws`'s
      // WebSocketServer.close() removes the 'upgrade' listener it had
      // registered on the http server; the bare http server has no
      // upgrade handler, so the request goes nowhere.)
      const post = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=after-dispose`,
      );
      const opened = await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (v: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        post.on("open", () => settle(true));
        post.on("error", () => settle(false));
        post.on("close", () => settle(false));
        post.on("unexpected-response", () => settle(false));
        setTimeout(() => settle(false), 500);
      });

      expect(opened).toBe(false);

      try {
        post.terminate();
      } catch {
        // ignore
      }
    } finally {
      await close();
    }
  });

  it("dispose() is idempotent — second call is a no-op (does not throw)", async () => {
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user: { sub: "u1" },
      connectionKey: "u1",
    });

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      // Establish one client so dispose has something to close.
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=ok`,
      );
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      await server.dispose();
      // Second dispose returns immediately, no throw, no side effect.
      await expect(server.dispose()).resolves.toBeUndefined();

      try {
        client.terminate();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await close();
    }
  });
});

// Note: the URL in the assertions uses different `?token=` query values
// across clients but the same `verifyClient` returns a fresh user each
// time. The clients use distinct `connectionKey`s so they share the
// registry without kicking each other.
