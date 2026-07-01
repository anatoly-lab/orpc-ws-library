// Server→client bidi (`clientContract`) threading through the NestJS adapter.
//
// The core proves the bidi RUNTIME exhaustively (orpc-ws-server's
// integration/bidi-connection.test.ts). This file's load-bearing job is the
// ADAPTER seam: that a `clientContract` passed through `OrpcWsModule` reaches
// the matching core factory (createOrpcWsServer / createAuthlessOrpcWsServer)
// — observed end-to-end via (a) the `onConnected` hook conn carrying a typed
// `client`, and (b) `OrpcWsService.getConnection(key)?.client` exposing the
// same caller. Both the AUTHENTICATED and AUTHLESS arms are covered.
//
// We connect a PLAIN `ws` client (no answering ORPC peer), so we only assert
// the caller's PRESENCE (`typeof client.notify === "function"`) — never invoke
// it (an un-answered call would hang). Same restraint as the core test.

import { describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "net";
import WebSocketClient from "ws";
import { oc } from "@orpc/contract";
import { os } from "@orpc/server";

import { OrpcWsModule } from "../../orpc-ws.module.js";
import { OrpcWsService } from "../../orpc-ws.service.js";
import type { OrpcWsModuleOptions } from "../../orpc-ws.options.js";

import "reflect-metadata";

// A client contract VALUE — its presence flips bidi on and types `conn.client`.
const clientContract = { notify: oc };
type ClientContract = typeof clientContract;

const router = {
  ping: os.handler(async () => "pong"),
};

// Quiet the watchdog so the short test window is its own.
const quietHeartbeat = { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false };

// `onConnected` writes the conn's key here so the test can drive
// `service.getConnection(key)`; the authless key is an internal counter the
// test can't otherwise know.
interface Captured {
  key?: string;
  hookClientType?: string;
}

function buildAuthenticatedModule(captured: Captured) {
  @Module({
    imports: [
      OrpcWsModule.forRootAsync({
        useFactory: (): OrpcWsModuleOptions<
          { sub: string },
          typeof router,
          ClientContract
        > => ({
          router,
          verifyClient: async () => ({
            ok: true,
            user: { sub: "u1" },
            connectionKey: "u1",
          }),
          clientContract,
          heartbeat: quietHeartbeat,
          hooks: {
            onConnected: (conn) => {
              captured.key = conn.key;
              captured.hookClientType = typeof conn.client.notify;
            },
          },
        }),
      }),
    ],
  })
  class AppModule {}
  return AppModule;
}

function buildAuthlessModule(captured: Captured) {
  @Module({
    imports: [
      OrpcWsModule.forRootAsync({
        useFactory: (): OrpcWsModuleOptions<
          unknown,
          typeof router,
          ClientContract
        > => ({
          mode: "authless",
          router,
          clientContract,
          heartbeat: quietHeartbeat,
          hooks: {
            onConnected: (conn) => {
              captured.key = conn.key;
              captured.hookClientType = typeof conn.client.notify;
            },
          },
        }),
      }),
    ],
  })
  class AppModule {}
  return AppModule;
}

async function bootstrap(
  AppModule: new (...args: unknown[]) => unknown,
): Promise<{ app: NestExpressApplication; port: number }> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
    { logger: false },
  );
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, port: address.port };
}

async function openClient(url: string): Promise<WebSocketClient> {
  const client = new WebSocketClient(url);
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
    setTimeout(() => reject(new Error("open timed out")), 2_000);
  });
  return client;
}

describe("OrpcWsModule — server→client bidi threading", () => {
  it("AUTHENTICATED: clientContract reaches the factory; hook + getConnection expose a typed client", async () => {
    const captured: Captured = {};
    const { app, port } = await bootstrap(buildAuthenticatedModule(captured));

    try {
      const client = await openClient(`ws://127.0.0.1:${port}/ws?token=t`);
      // Give onConnected a beat to fire after the upgrade.
      await new Promise((r) => setTimeout(r, 50));

      // (a) The hook conn carried a typed `client` (bidi on through the module).
      expect(captured.key).toBe("u1");
      expect(captured.hookClientType).toBe("function");

      // (b) The service's out-of-band accessor exposes the same caller.
      const service = app.get(OrpcWsService);
      const conn = service.getConnection<ClientContract>("u1");
      expect(conn).toBeDefined();
      expect(typeof conn!.client.notify).toBe("function");

      client.close();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await app.close();
    }
  });

  it("AUTHLESS: clientContract reaches the authless factory; hook + getConnection expose a typed client", async () => {
    const captured: Captured = {};
    const { app, port } = await bootstrap(buildAuthlessModule(captured));

    try {
      // No `?token=` — authless accepts the upgrade.
      const client = await openClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise((r) => setTimeout(r, 50));

      expect(captured.key).toBeDefined();
      expect(captured.hookClientType).toBe("function");

      const service = app.get(OrpcWsService);
      const conn = service.getConnection<ClientContract>(captured.key!);
      expect(conn).toBeDefined();
      expect(typeof conn!.client.notify).toBe("function");

      client.close();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await app.close();
    }
  });
});
