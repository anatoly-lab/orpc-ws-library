// Phase 4 — Bug 6 server-side: keepalive via WS ping/pong over multiple
// intervals.
//
// ── PHASE 7 RELABEL ──────────────────────────────────────────────────────
// This file is the **MITIGATION test**, not the real failure-mode E2E.
// It proves on loopback that:
//   - the server's ping/pong frames flow at the configured cadence, and
//   - the watchdog terminates a zombie that doesn't pong.
// These are the *mitigation behaviors* that should prevent a K8s / Traefik /
// nginx ingress from dropping an idle WS after 30-60s. The real failure
// mode — actual proxy idle drop with our keepalive defeating it — needs a
// docker-compose stack with a real proxy in front of the WS server and is
// documented as MANUAL in `tests-e2e/README.md` (deferred from v1).
// ─────────────────────────────────────────────────────────────────────────
//
// Bug 6 mitigation lives in `WsPingPong`: the watchdog sends a `ws.ping()`
// frame every `intervalMs`. On loopback (no proxy idle drop to simulate),
// what we CAN assert is the second half of the contract:
//
//   1. A real `ws` client auto-responds to ping with pong (the `ws`
//      library does this by default — verified inline). Connection stays
//      open across 5+ intervals with zero application traffic.
//
//   2. A client that refuses to pong is detected as a zombie after one
//      missed pong and `terminate()`d by the server.
//
// Real proxy-drop simulation is Phase 7 (E2E) — see
// implementation-plan.md §"Phase 7 — E2E". This file pins the
// ping/pong mechanic on loopback so a regression in the mitigation
// surfaces here, not in nightly E2E.

import { describe, expect, it, vi } from "vitest";
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

describe("OrpcWsServer — Bug 6 server side: WS ping/pong keepalive", () => {
  it("client receives pings and stays open across 5 intervals with zero app traffic", async () => {
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user: { sub: "u1" },
      connectionKey: "u1",
    });

    const { http, port, close } = await startHttpServer();
    // 200ms interval × 5 ≈ 1s of zero app traffic; timeoutMs = 100 means
    // the watchdog fires a tick that checks aliveness on every interval.
    // Real prod cadence is 25s — too slow for a fast test. The scaling
    // doesn't change the contract.
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      heartbeat: { intervalMs: 200, timeoutMs: 100, pingPong: true },
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=ok`,
      );

      // Confirm `ws` library's auto-pong behavior: the library
      // auto-responds to a server-initiated `ping` frame by default —
      // pin that by counting how many pings the client receives over the
      // window.
      let pingsReceived = 0;
      client.on("ping", () => {
        pingsReceived++;
      });

      const closes: { code: number; reason: string }[] = [];
      client.on("close", (code, reasonBuf) => {
        closes.push({ code, reason: reasonBuf.toString() });
      });

      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      // Idle for ~1s — that's 5 watchdog intervals at 200ms.
      await new Promise((r) => setTimeout(r, 1100));

      // Connection still open: no close fired.
      expect(closes).toHaveLength(0);
      expect(client.readyState).toBe(WebSocketClient.OPEN);

      // The server sent at least 3 pings in that window (5 intervals,
      // allow some scheduler slack).
      expect(pingsReceived).toBeGreaterThanOrEqual(3);

      client.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("silent client (no pong response) → server terminate() + onZombieTerminated fires", async () => {
    const user: TestUser = { sub: "zombie-user" };
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user,
      connectionKey: user.sub,
    });
    const onZombieTerminated = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      heartbeat: { intervalMs: 150, timeoutMs: 50, pingPong: true },
      hooks: { onZombieTerminated },
    });
    server.attach(http);

    try {
      // `autoPong: false` makes this client behave like a misbehaving /
      // dead client — it never responds to the server's `ws.ping()`
      // frames. The `ws` library default is `true` (auto-pong) which is
      // exactly the browser's behavior; flipping it off is the right
      // way to simulate a zombie at the wire level.
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=ok`,
        { autoPong: false },
      );

      const closed = new Promise<{ code: number }>((resolve, reject) => {
        client.on("close", (code) => resolve({ code }));
        client.on("error", (err) => reject(err));
      });

      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      // The watchdog needs at least two ticks: tick 1 sends `ping` (the
      // client doesn't pong), tick 2 sees `alive === false` and calls
      // `ws.terminate()`. Allow a generous window (5 intervals).
      const result = await Promise.race([
        closed,
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);

      expect(result).not.toBeNull();
      // ws.terminate() closes the socket without a clean close frame —
      // `ws` reports close code 1006 (abnormal closure) on the client.
      // We don't assert the code precisely; the load-bearing fact is
      // that the connection ended AND the hook fired with the right user.
      expect(onZombieTerminated).toHaveBeenCalledWith(user);
    } finally {
      await server.dispose();
      await close();
    }
  });
});
