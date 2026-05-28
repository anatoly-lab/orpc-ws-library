// Phase 3.3 — connection-flow integration tests.
//
// Real `ws` server on an ephemeral loopback port + a real `ws` client.
// Pin three observable invariants the unit tests can't capture together:
//
//   1. Failed verifyClient → client never sees `open`. The 101 was
//      withheld; the close arrives before the `open` event.
//   2. Successful verifyClient → 101 + connection-handler runs (the
//      onConnected hook fires).
//   3. Bug 5 server-side regression: client sends a raw frame
//      immediately after `open` → the server-side `'message'` handler
//      receives it. The pre-`upgrade()` sync path must NOT drop the
//      first message.
//
// We use a TINY consumer router (`{ping: handler}`) — full ORPC round
// trip would require contract scaffolding that doesn't pay back for
// the Bug 5 assertion (the raw `message` arrival is sufficient).

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os } from "@orpc/server";
import WebSocketClient, { type WebSocket as WSWebSocket } from "ws";

import {
  OrpcWsServer,
  type VerifyClient,
} from "../../index.js";

interface TestUser {
  sub: string;
}

/**
 * Start an HTTP server on an ephemeral port. Returns the server, port,
 * and a teardown function.
 */
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

/**
 * Bare-bones consumer router fragment. The integration tests don't need
 * a typed client — they pump raw WS frames.
 */
const router = {
  ping: os.handler(async () => "pong"),
};

describe("OrpcWsServer — integration", () => {
  it("failed verifyClient: client never opens, server reports the close code", async () => {
    const verify: VerifyClient<TestUser> = async () => ({
      ok: false,
      code: 4001,
      reason: "Bad token",
    });

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer({
      router,
      verifyClient: verify,
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=nope`,
      );
      const openSpy = vi.fn();
      client.on("open", openSpy);

      // unexpected-response is what `ws` fires when the server rejects
      // pre-101 (non-101 status). The close event also fires; we await
      // whichever lands first.
      const closed = await new Promise<{
        opened: boolean;
        code?: number;
      }>((resolve) => {
        client.on("error", () => resolve({ opened: false }));
        client.on("close", (code) => resolve({ opened: false, code }));
        client.on("unexpected-response", () =>
          resolve({ opened: false }),
        );
        client.on("open", () => resolve({ opened: true }));
      });

      expect(closed.opened).toBe(false);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("successful verifyClient: client opens, onConnected fires with the typed user", async () => {
    const user: TestUser = { sub: "user-1" };
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user,
      connectionKey: "user-1",
    });
    const onConnected = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onConnected },
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=ok`,
      );

      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      // onConnected runs synchronously inside the 'connection' handler;
      // by the time the client's `open` event has fired, it must have
      // been called.
      expect(onConnected).toHaveBeenCalledTimes(1);
      const callArgs = onConnected.mock.calls[0]!;
      expect(callArgs[0]).toEqual(user);

      client.close();
      // Allow the close handler to run.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("Bug 5: client sends a frame immediately after open → server receives it", async () => {
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user: { sub: "u1" },
      connectionKey: "u1",
    });

    const messageSpy = vi.fn();
    const onConnected = vi.fn((_user: TestUser, ws: unknown) => {
      // Attach our spy in the SAME tick the connection-handler attaches
      // its ORPC pump. If we miss the message, it's because the sync
      // contract was violated.
      //
      // NOTE: ORPC's WS adapter also attaches a 'message' listener that
      // decodes JSON; our raw text frame triggers a JSON parse rejection
      // there. We absorb that on the WS's 'error' event so it doesn't
      // become an unhandled rejection at the test runner level.
      (ws as WSWebSocket).on("message", (data) => {
        messageSpy(data.toString());
      });
      (ws as WSWebSocket).on("error", () => {
        // swallow — we only care that 'message' fired.
      });
    });

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onConnected },
    });
    server.attach(http);

    // ORPC's WS pump rejects the synthetic non-JSON frame; absorb the
    // unhandled rejection at the process level for the duration of this
    // test so the runner doesn't fail on it.
    const rejHandler = (): void => {
      // swallow ORPC's JSON parse rejection — out of scope for this test
    };
    process.on("unhandledRejection", rejHandler);

    try {
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=ok`,
      );

      await new Promise<void>((resolve, reject) => {
        client.on("open", () => {
          // Send immediately on open — no setTimeout. This is the race
          // window the source app's "sync 'connection' handler" fix
          // closes.
          client.send("first-frame-after-open");
          resolve();
        });
        client.on("error", (err) => reject(err));
      });

      // Wait for the server to process the frame.
      await new Promise((r) => setTimeout(r, 100));

      expect(messageSpy).toHaveBeenCalled();
      expect(messageSpy.mock.calls[0]?.[0]).toBe("first-frame-after-open");

      client.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", rejHandler);
      await server.dispose();
      await close();
    }
  });
});
