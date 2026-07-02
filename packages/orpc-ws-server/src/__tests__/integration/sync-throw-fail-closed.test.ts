// Regression — sync throws in the upgrade/connection pipeline must fail
// closed, never crash the process or corrupt the handshake.
//
// `ws` v8 (traced in 8.21.0 dist) does not wrap its verifyClient call
// site or the 'connection' emit; before the fix a sync throw escaped
// with a different failure mode per site/mode:
//
//   - verifyClient throwing synchronously (plain-JS non-async verify +
//     a garbage `?token=` — attacker-triggerable): escaped the HTTP
//     server's 'upgrade' emit as an uncaughtException → process crash.
//   - connection handler throwing, AUTHLESS mode: with no verifyClient,
//     `completeUpgrade` — and the 'connection' emit — runs synchronously
//     inside the 'upgrade' emit → same uncaughtException/process crash.
//   - connection handler throwing, AUTHED mode: the 'connection' emit
//     runs from our verify callback inside the orchestrator's `.then`,
//     so the throw was swallowed by its `.catch` (misleading "consumer
//     verify threw" log) and fired the ws callback a SECOND time →
//     `abortHandshake` wrote a raw HTTP/1.1 500 onto the already-
//     upgraded (101) socket — protocol garbage at the client, though
//     not a crash.
//
// Real server + real client on loopback (same harness as
// connection-flow.test.ts) because the failure lives in the seam BETWEEN
// ws and our guards — a unit test can't observe the emit path. The
// registry-leak half of the connection-handler bug is pinned at the unit
// level in lifecycle/__tests__/connection-handler-sync-throw.test.ts.

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os } from "@orpc/server";
import WebSocketClient from "ws";

import type { Logger } from "@orpc-ws/shared";

import {
  createAuthlessOrpcWsServer,
  OrpcWsServer,
  SINGLE_AUTHLESS_KEY,
  type VerifyClient,
} from "../../index.js";

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

/** Await a client's terminal outcome: opened (then closed) or rejected pre-101. */
function outcome(
  client: WebSocketClient,
): Promise<{ opened: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    let opened = false;
    client.on("open", () => {
      opened = true;
    });
    client.on("close", (code) => resolve({ opened, closeCode: code }));
    // Pre-101 rejects surface as an 'error' (ws's abortHandshake); a
    // 'close' follows, but resolving on either keeps the test from
    // hanging if that ordering ever changes (mirrors
    // connection-flow.test.ts's whichever-lands-first pattern).
    client.on("error", () => {
      if (!opened) resolve({ opened: false });
    });
  });
}

describe("OrpcWsServer — sync throws fail closed (integration)", () => {
  it("sync-throwing verifyClient: upgrade rejected, process alive, next good connection succeeds", async () => {
    // Plain-JS-style verify: non-async, throws synchronously on a
    // malformed token instead of returning the discriminated union.
    const verify: VerifyClient<TestUser> = (ctx) => {
      if (ctx.token !== "good") {
        throw new Error("jwt.decode blew up on a garbage token");
      }
      return Promise.resolve({ ok: true, user: { sub: "u1" }, connectionKey: "u1" });
    };

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
    });
    server.attach(http);

    // Without the fix the throw escapes the 'upgrade' emit as an
    // uncaughtException. The listener both proves it doesn't happen and
    // keeps the runner alive if it regresses.
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);

    try {
      const bad = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=%7Bgarbage`);
      const badOutcome = await outcome(bad);
      expect(badOutcome.opened).toBe(false);

      // The server survived and still serves legitimate clients.
      const good = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=good`);
      await new Promise<void>((resolve, reject) => {
        good.on("open", () => resolve());
        good.on("error", (err) => reject(err));
      });
      good.close();
      await new Promise((r) => setTimeout(r, 50));

      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
      await server.dispose();
      await close();
    }
  });

  it("connection-handler sync throw (circular TUser): socket closed 1011, process alive, next connection succeeds", async () => {
    // verify accepts BOTH clients; the first gets a circular user with
    // NO connectionKey, so `deriveConnectionKey`'s JSON.stringify throws
    // inside the 'connection' handler — AFTER the 101.
    const circular: Record<string, unknown> = { sub: "boom" };
    circular.self = circular;
    let first = true;
    const verify: VerifyClient<Record<string, unknown>> = () => {
      if (first) {
        first = false;
        return Promise.resolve({ ok: true, user: circular });
      }
      return Promise.resolve({
        ok: true,
        user: { sub: "u2" },
        connectionKey: "u2",
      });
    };
    const onConnected = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<Record<string, unknown>, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onConnected },
    });
    server.attach(http);

    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);

    try {
      // 101 completes (verify said ok), then the composition-root guard
      // catches the handler throw and fails closed with 1011.
      const doomed = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      const doomedOutcome = await outcome(doomed);
      expect(doomedOutcome.opened).toBe(true);
      expect(doomedOutcome.closeCode).toBe(1011);
      // The handler never got as far as the onConnected hook.
      expect(onConnected).not.toHaveBeenCalled();

      // Server object still functional: the next connection wires fully.
      const good = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      await new Promise<void>((resolve, reject) => {
        good.on("open", () => resolve());
        good.on("error", (err) => reject(err));
      });
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(server.getConnection("u2")).toBeDefined();

      good.close();
      await new Promise((r) => setTimeout(r, 50));

      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
      await server.dispose();
      await close();
    }
  });

  it("authless (default single-connection mode): handler sync throw → 1011, process alive, same constant key reusable", async () => {
    // THE authless throw site, traced through `handleAuthless`: the only
    // consumer-reachable sync throw inside the registered-but-unwired
    // window is the injected Logger — specifically the unguarded
    // "client connected" info log in `wireLifecycle`. Everything else in
    // that window is library-owned and can't realistically throw: the
    // authless key seams are deterministic constants,
    // `setupConnectionTransport` is a no-op without bidi, the registry's
    // kick-close is internally try/catch'd, the lifecycle hooks are
    // wrapped, and `rpcHandler.upgrade` is the library's own ORPC
    // handler. So the throw is driven through the Logger seam — the
    // exact path the rollback docstring's "throwing consumer logger"
    // wrinkle describes.
    let threwOnce = false;
    const logger: Logger = {
      debug: () => {},
      // Throws EXACTLY once, on the first connection's connect log.
      // Later info calls (disconnect log, the retry's connect log) must
      // succeed so the retry can wire fully.
      info: (msg) => {
        if (!threwOnce && msg.includes("client connected")) {
          threwOnce = true;
          throw new Error("consumer logger blew up on the connect log");
        }
      },
      warn: () => {},
      // The composition-root guard reports the failure through `error`;
      // it must not throw here or the guard itself would blow up the
      // (synchronous, authless) 'connection' emit.
      error: () => {},
    };

    const { http, port, close } = await startHttpServer();
    // DEFAULT authless sub-mode: no `allowConcurrentConnections`, so
    // every socket shares the ONE constant registry key and a new
    // connection kicks the previous (4005).
    const server = createAuthlessOrpcWsServer({ router, logger });
    server.attach(http);

    // Pre-fix, authless was the genuine process-crash mode: with no
    // verifyClient, ws emits 'connection' synchronously inside the HTTP
    // 'upgrade' emit, so the throw escaped as an uncaughtException.
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);

    try {
      const doomed = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      const doomedOutcome = await outcome(doomed);
      expect(doomedOutcome.opened).toBe(true);
      expect(doomedOutcome.closeCode).toBe(1011);

      // Rollback freed the ONE constant key: the next connection
      // registers under it cleanly instead of colliding with a leaked
      // dead entry (which would 4005-kick a socket that's already gone).
      const good = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        good.on("open", () => resolve());
        good.on("error", (err) => reject(err));
      });
      expect(server.getConnection(SINGLE_AUTHLESS_KEY)).toBeDefined();

      // Default single-connection semantics survived the failure: a
      // newer connection still kicks the current one with 4005 under
      // the same constant key.
      const goodClosed = new Promise<number>((resolve) => {
        good.on("close", (code) => resolve(code));
      });
      const taker = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        taker.on("open", () => resolve());
        taker.on("error", (err) => reject(err));
      });
      expect(await goodClosed).toBe(4005);

      taker.close();
      await new Promise((r) => setTimeout(r, 50));

      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
      await server.dispose();
      await close();
    }
  });
});
