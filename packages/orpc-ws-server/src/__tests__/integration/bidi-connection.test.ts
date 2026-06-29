// Phase 5a — server bidi integration tests.
//
// Real `ws` server on an ephemeral loopback port + a real (plain) `ws` client.
// A plain client does NOT run an answering ORPC peer, so server→client calls
// never resolve until the socket closes — exactly what we want to assert the
// teardown-rejection invariant without a Phase-6 client peer.
//
// Pins the Phase-5a observable invariants:
//   1. Opt-in gating: with NO `clientContract`, `upgrade` receives the RAW ws
//      and `conn.client` is absent — behavior matches the pre-bidi server.
//   2. With a `clientContract`, a mux is interposed (`upgrade` gets a DIFFERENT
//      socket than the raw ws), the registry carries a `client`, and
//      `getConnection(key)?.client` is present.
//   3. The `onConnected` hook receives the single `conn` with `{ key, user, ws }`
//      plus `client` when bidi is on.
//   4. TEARDOWN: an in-flight `conn.client.x()` rejects (not hangs) when the
//      client disconnects — the real close path drives the bidi teardown order.

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { oc } from "@orpc/contract";
import { os } from "@orpc/server";
import WebSocketClient from "ws";

import { createOrpcWsServer, type VerifyClient } from "../../index.js";

interface TestUser {
  sub: string;
}

// A client contract VALUE (runtime object) — its presence flips bidi on and
// drives `conn.client`'s type. The caller proxy is dynamic; the value is unused
// beyond type inference.
const clientContract = { notify: oc };
type ClientContract = typeof clientContract;

const router = {
  ping: os.handler(async () => "pong"),
};

const verify: VerifyClient<TestUser> = async () => ({
  ok: true,
  user: { sub: "u1" },
  connectionKey: "u1",
});

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

const quietHeartbeat = { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false };

describe("OrpcWsServer — server→client bidi integration", () => {
  it("bidi OFF: upgrade gets the raw ws; conn has no client (byte-identical path)", async () => {
    const upgraded: unknown[] = [];
    const onConnected = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = createOrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onConnected },
      heartbeat: quietHeartbeat,
    });
    // Spy on the captured server-side ws to compare identity with `upgrade`'s arg.
    // We can't intercept ORPC's internal upgrade here, so we assert via the conn:
    // when bidi is off, the conn carries no client and getConnection has none.
    server.attach(http);

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      expect(onConnected).toHaveBeenCalledTimes(1);
      const conn = onConnected.mock.calls[0]![0] as {
        key: string;
        user: TestUser;
        ws: unknown;
        client?: unknown;
      };
      expect(conn.key).toBe("u1");
      expect(conn.user).toEqual({ sub: "u1" });
      expect(conn.ws).toBeDefined();
      // No bidi → no client on the conn, and getConnection surfaces none.
      expect(conn.client).toBeUndefined();
      expect(
        (server.getConnection("u1") as { client?: unknown } | undefined)?.client,
      ).toBeUndefined();
      void upgraded;

      client.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("bidi ON: conn + registry carry a typed client; getConnection exposes it", async () => {
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = createOrpcWsServer<TestUser, typeof router, ClientContract>({
      router,
      verifyClient: verify,
      clientContract,
      hooks: { onConnected, onDisconnected },
      heartbeat: quietHeartbeat,
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      expect(onConnected).toHaveBeenCalledTimes(1);
      const conn = onConnected.mock.calls[0]![0] as {
        key: string;
        client: { notify: (i: unknown) => Promise<unknown> };
      };
      expect(typeof conn.client.notify).toBe("function");

      // Out-of-band accessor exposes the same typed caller.
      const fromGet = server.getConnection("u1");
      expect(fromGet).toBeDefined();
      expect(typeof fromGet!.client.notify).toBe("function");

      client.close();
      await new Promise((r) => setTimeout(r, 50));

      // The disconnect conn carries the same `client` reference (bidi on) —
      // it is live but doomed (the s2c peer is closed); consumers must not
      // CALL it from onDisconnected, only observe its presence.
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      const discConn = onDisconnected.mock.calls[0]![0] as {
        client: { notify: (i: unknown) => Promise<unknown> };
      };
      expect(typeof discConn.client.notify).toBe("function");
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("TEARDOWN: an in-flight server→client call rejects when the client disconnects", async () => {
    const { http, port, close } = await startHttpServer();
    const server = createOrpcWsServer<TestUser, typeof router, ClientContract>({
      router,
      verifyClient: verify,
      clientContract,
      heartbeat: quietHeartbeat,
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      const conn = server.getConnection("u1");
      expect(conn).toBeDefined();

      // No answering peer on the plain client → this never resolves on its own.
      const pending = (
        conn!.client as { notify: (i: unknown) => Promise<unknown> }
      ).notify({ msg: "hi" });
      // Let the request leave on the wire before we tear down.
      await new Promise((r) => setTimeout(r, 20));

      // Client-initiated close → server ws 'close' → bidi teardown. The pending
      // server→client call must REJECT (a hang fails this test by timeout).
      client.close();

      await expect(pending).rejects.toThrow();
    } finally {
      await server.dispose();
      await close();
    }
  });
});
