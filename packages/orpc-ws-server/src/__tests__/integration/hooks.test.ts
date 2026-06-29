// Phase 4 — lifecycle hooks coverage.
//
// The composition root threads four hooks into the relevant collaborators:
//   - onConnected      → ConnectionHandler (post-upgrade)
//   - onDisconnected   → ConnectionHandler (ws.on('close'))
//   - onKicked         → ConnectionRegistry (singleConnectionPerUser switch)
//   - onZombieTerminated → WsPingPong (watchdog terminate path)
//
// Individual unit tests already cover the inside of each collaborator.
// This file pins the END-TO-END wiring: a real WS round trip exercises
// each hook with the right typed `TUser` payload AND the right adjacent
// argument (close code / replacing WS).

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

describe("OrpcWsServer — lifecycle hooks", () => {
  it("onConnected fires once per successful connection with the typed user", async () => {
    const user: TestUser = { sub: "u1" };
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user,
      connectionKey: user.sub,
    });
    const onConnected = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onConnected },
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      expect(onConnected).toHaveBeenCalledTimes(1);
      // The hook now receives a single `conn` handle: { key, user, ws }.
      const [conn] = onConnected.mock.calls[0]!;
      expect(conn.user).toEqual(user);
      expect(conn.key).toBe(user.sub);
      // The live `ws.WebSocket` instance on the server side — we don't poke
      // at its identity, but it must be defined.
      expect(conn.ws).toBeDefined();

      client.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("onDisconnected fires once on close with the right close code", async () => {
    const user: TestUser = { sub: "u1" };
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user,
      connectionKey: user.sub,
    });
    const onDisconnected = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onDisconnected },
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      // Client-initiated close with a specific application code.
      const SPECIFIC_CODE = 4123;
      client.close(SPECIFIC_CODE, "client-driven");

      // Wait for the server's 'close' handler to flush.
      await new Promise((r) => setTimeout(r, 80));

      expect(onDisconnected).toHaveBeenCalledTimes(1);
      // The hook now receives (conn, code).
      const [conn, code] = onDisconnected.mock.calls[0]!;
      expect(conn.user).toEqual(user);
      expect(code).toBe(SPECIFIC_CODE);
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("onKicked fires when a second connection with the same key arrives", async () => {
    const verify: VerifyClient<TestUser> = async () => ({
      ok: true,
      user: { sub: "shared-key" },
      // Same key for both clients → registry triggers the kick.
      connectionKey: "shared-key",
    });
    const onKicked = vi.fn();

    const { http, port, close } = await startHttpServer();
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: verify,
      hooks: { onKicked },
      // singleConnectionPerUser is true by default — confirm via config
      // overlay omitted means default.
      heartbeat: { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false },
    });
    server.attach(http);

    try {
      const c1 = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=a`);
      await new Promise<void>((resolve, reject) => {
        c1.on("open", () => resolve());
        c1.on("error", (err) => reject(err));
      });

      const c1ClosePromise = new Promise<{ code: number }>((resolve) => {
        c1.on("close", (code) => resolve({ code }));
      });

      const c2 = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=b`);
      await new Promise<void>((resolve, reject) => {
        c2.on("open", () => resolve());
        c2.on("error", (err) => reject(err));
      });

      // c1 should receive close code 4005 (session replaced).
      const c1Close = await c1ClosePromise;
      expect(c1Close.code).toBe(4005);

      expect(onKicked).toHaveBeenCalledTimes(1);
      const [kickedUser, replacedBy] = onKicked.mock.calls[0]!;
      expect(kickedUser).toEqual({ sub: "shared-key" });
      // replacedBy is the live ws of the SECOND connection (server side).
      expect(replacedBy).toBeDefined();

      c2.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("onZombieTerminated fires when the watchdog terminates a non-ponging client", async () => {
    const user: TestUser = { sub: "zombie" };
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
      hooks: { onZombieTerminated },
      heartbeat: { intervalMs: 100, timeoutMs: 50, pingPong: true },
    });
    server.attach(http);

    try {
      // autoPong: false simulates a hung / dead client at the wire level.
      const client = new WebSocketClient(
        `ws://127.0.0.1:${port}/ws?token=ok`,
        { autoPong: false },
      );
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
      });

      // 2 ticks: tick 1 ping (no reply), tick 2 terminate.
      await new Promise((r) => setTimeout(r, 600));

      expect(onZombieTerminated).toHaveBeenCalledTimes(1);
      expect(onZombieTerminated).toHaveBeenCalledWith(user);
    } finally {
      await server.dispose();
      await close();
    }
  });
});
