// AUTHLESS integration through the NestJS adapter.
//
// Pins that `OrpcWsModule.forRoot({ mode: "authless", router })` boots
// and attaches WITHOUT a verifyClient — every WS upgrade is accepted with
// no token. This is the Nest-side mirror of the core's
// authless-integration.test.ts; its load-bearing job is the adapter's
// mode dispatch (mode: "authless" → createAuthlessOrpcWsServer).

import { describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "net";
import WebSocketClient from "ws";
import { os } from "@orpc/server";

import { OrpcWsModule } from "../../orpc-ws.module.js";
import type { OrpcWsModuleOptions } from "../../orpc-ws.options.js";

import "reflect-metadata";

const router = {
  ping: os.handler(async () => "pong"),
};

function buildAuthlessAppModule(): new (...args: unknown[]) => unknown {
  @Module({
    imports: [
      OrpcWsModule.forRootAsync({
        useFactory: (): OrpcWsModuleOptions<unknown, typeof router> => ({
          mode: "authless",
          router,
          // Quiet the watchdog so the test window is its own.
          heartbeat: {
            intervalMs: 10_000,
            timeoutMs: 5_000,
            pingPong: false,
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

describe("OrpcWsModule — AUTHLESS mode", () => {
  it("forRootAsync({ mode: 'authless' }) boots + accepts an upgrade with no token", async () => {
    const { app, port } = await bootstrap(buildAuthlessAppModule());

    try {
      // No `?token=` — authless accepts the upgrade regardless.
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
        setTimeout(() => reject(new Error("open timed out")), 2_000);
      });

      expect(client.readyState).toBe(WebSocketClient.OPEN);

      client.close();
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocketClient.CLOSED) return resolve();
        client.once("close", () => resolve());
      });
    } finally {
      await app.close();
    }
  });
});
