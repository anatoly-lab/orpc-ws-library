// Integration test: real NestJS bootstrap on an ephemeral port, real
// WebSocket client, real `dispose()` → 4009 close path.
//
// What this exercise covers — and the equivalent core-side test:
//   - `OnApplicationBootstrap` actually calls `server.attach()` against
//     the platform-express `httpAdapter.getHttpServer()`. Equivalent of
//     packages/orpc-ws-server's `connection-flow.test.ts` but routed
//     through Nest.
//   - `BeforeApplicationShutdown` actually calls `server.dispose()` —
//     and the dispose runs BEFORE Nest's HTTP server is torn down, so
//     clients observe a clean 4009 close. The core has its own
//     `dispose-ordering.test.ts`; this test confirms the Nest hook
//     ordering forwards the same property to consumers.
//   - `verifyClient` rejection results in no 101 upgrade — same
//     framework-free guarantee, validated through the Nest stack.
//
// We do NOT round-trip an actual ORPC call here. The core's
// `connection-flow.test.ts` already pins the ORPC path; this test's
// load-bearing job is Nest-side wiring (HttpAdapterHost → attach,
// BeforeApplicationShutdown → dispose).

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

// Reflect-metadata loaded before any DI runs.
import "reflect-metadata";

interface TestUser {
  sub: string;
}

// Minimal app router — a single `ping` handler. We only need it so
// router composition has something to merge with the library's stealth
// `__orpc_ws_lib__.heartbeat`.
const router = {
  ping: os.handler(async () => "pong"),
};

/**
 * Build the AppModule for a given verifyClient. Each test calls this
 * with its own verify behavior so the discriminated-union code paths
 * stay isolated.
 */
function buildAppModule(
  verifyClient: OrpcWsModuleOptions<TestUser>["verifyClient"],
): new (...args: unknown[]) => unknown {
  @Module({
    imports: [
      OrpcWsModule.forRootAsync({
        useFactory: (): OrpcWsModuleOptions<TestUser, typeof router> => ({
          router,
          verifyClient,
          // Silence ping/pong watchdog so the test window is bounded by
          // its own timers, not by heartbeat ticks.
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

/**
 * Bootstrap a Nest app on an ephemeral port. Caller resolves the port
 * once `app.listen(0)` returns.
 */
async function bootstrap(
  AppModule: new (...args: unknown[]) => unknown,
): Promise<{ app: NestExpressApplication; port: number }> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
    { logger: false }, // silence Nest's chatty default logger
  );
  // enableShutdownHooks() is what makes BeforeApplicationShutdown fire
  // on app.close() (or signal). Without this, our dispose hook never
  // runs and we'd get TCP RSTs instead of 4009 frames.
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer();
  const address = server.address() as AddressInfo;
  return { app, port: address.port };
}

describe("OrpcWsModule — NestJS integration", () => {
  it("attaches on bootstrap and accepts a WebSocket upgrade at /ws", async () => {
    const verifyClient: OrpcWsModuleOptions<TestUser>["verifyClient"] = async (
      ctx,
    ) => {
      // Accept any token; assigning per-token connectionKey so two
      // concurrent test clients don't kick each other.
      const key = ctx.token ?? "anon";
      return {
        ok: true,
        user: { sub: key },
        connectionKey: key,
      };
    };

    const { app, port } = await bootstrap(buildAppModule(verifyClient));

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t1`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
        // Hard ceiling for the test — without this a hung handshake
        // would block the suite.
        setTimeout(() => reject(new Error("open timed out")), 2_000);
      });

      // We only need to assert the WS reached the OPEN state. The core
      // server's connection-flow.test.ts pins the ORPC round-trip.
      expect(client.readyState).toBe(WebSocketClient.OPEN);

      client.close();
      // Drain the close so app.close() below doesn't race.
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocketClient.CLOSED) return resolve();
        client.once("close", () => resolve());
      });
    } finally {
      await app.close();
    }
  });

  it("dispose runs in BeforeApplicationShutdown — client sees 4009 close BEFORE TCP RST", async () => {
    const verifyClient: OrpcWsModuleOptions<TestUser>["verifyClient"] =
      async () => ({
        ok: true,
        user: { sub: "u1" },
        connectionKey: "u1",
      });

    const { app, port } = await bootstrap(buildAppModule(verifyClient));

    const closeEvents: { code: number; reason: string }[] = [];
    const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
    client.on("close", (code, reasonBuf) => {
      closeEvents.push({ code, reason: reasonBuf.toString() });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", (err) => reject(err));
        setTimeout(() => reject(new Error("open timed out")), 2_000);
      });

      // Trigger Nest's shutdown sequence. BeforeApplicationShutdown
      // runs BEFORE the HTTP server closes, so the WS dispose
      // (registry.closeAll(4009, ...)) reaches the client over the
      // still-open TCP connection. A 4009 with reason proves clean
      // close; a 1006 / abnormal closure would prove a RST.
      await app.close();

      // Drain the close event if it hasn't fired yet (close frame +
      // socket teardown can arrive a microtask later).
      if (client.readyState !== WebSocketClient.CLOSED) {
        await new Promise<void>((resolve) => {
          client.once("close", () => resolve());
        });
      }

      expect(closeEvents.length).toBe(1);
      expect(closeEvents[0]?.code).toBe(4009);
      expect(closeEvents[0]?.reason).toBe("Server shutdown");
    } finally {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
  });

  it("verifyClient rejection prevents the 101 upgrade", async () => {
    const verifyClient: OrpcWsModuleOptions<TestUser>["verifyClient"] =
      async () => ({
        ok: false,
        code: 4001,
        reason: "Bad token",
      });

    const { app, port } = await bootstrap(buildAppModule(verifyClient));

    try {
      const client = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=x`);

      // The ws client either errors (`'unexpected-response'`) or fires
      // `'close'` without ever opening. We assert: `'open'` does NOT
      // fire.
      const outcome = await new Promise<"open" | "rejected">((resolve) => {
        let settled = false;
        const settle = (v: "open" | "rejected"): void => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        client.on("open", () => settle("open"));
        client.on("error", () => settle("rejected"));
        client.on("close", () => settle("rejected"));
        client.on("unexpected-response", () => settle("rejected"));
        setTimeout(() => settle("rejected"), 1_000);
      });

      expect(outcome).toBe("rejected");

      try {
        client.terminate();
      } catch {
        // ignore
      }
    } finally {
      await app.close();
    }
  });
});
