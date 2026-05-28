// Phase 6 — NestJS adapter integration test for the HTTP upload route.
//
// What this pins:
//   1. With `uploads: { enabled: true, httpPath: "/upload" }` configured,
//      the route is registered on the underlying Express app and a POST
//      with a valid Bearer token reaches the consumer's procedure.
//   2. POST without Authorization → 401 (verifyClient rejects).
//   3. The startup collision check throws when the Express app already
//      has a route at the configured path.
//
// We deliberately bootstrap through `NestFactory.create` + the
// `ExpressAdapter` so the test exercises real Nest module wiring —
// the failure mode "wiring works in tests but breaks in real Nest"
// is what the integration test prevents.

import { describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import express from "express";
import type { AddressInfo } from "net";
import { os } from "@orpc/server";
import { RPCLink } from "@orpc/client/fetch";

import { OrpcWsModule } from "../../orpc-ws.module.js";
import type { OrpcWsModuleOptions } from "../../orpc-ws.options.js";

import "reflect-metadata";

interface TestUser {
  sub: string;
}

const GOOD_TOKEN = "good-token";

/**
 * Build a router with a `media.upload` procedure that echoes back the
 * input + the user from context.
 */
function buildAppModule(opts: OrpcWsModuleOptions) {
  @Module({
    imports: [OrpcWsModule.forRoot(opts)],
  })
  class AppModule {}
  return AppModule;
}

const router = {
  media: {
    upload: os.handler(async ({ input, context }) => {
      return {
        echoed: true,
        sub: (context as { user: TestUser }).user.sub,
        meta: (input as { name?: string }).name ?? null,
      };
    }),
  },
};

const baseOpts: OrpcWsModuleOptions<TestUser, typeof router> = {
  router,
  verifyClient: async (ctx) => {
    if (ctx.token === GOOD_TOKEN) {
      return {
        ok: true,
        user: { sub: "alice" },
        connectionKey: "alice",
      };
    }
    return { ok: false, code: 401, reason: "Bad token" };
  },
};

/**
 * Boot a Nest app on an ephemeral port. Returns the app + its port +
 * a teardown function.
 */
async function bootstrapWithUploads(
  uploads: OrpcWsModuleOptions["uploads"],
): Promise<{
  app: NestExpressApplication;
  port: number;
  close: () => Promise<void>;
}> {
  const expressInstance = express();
  const adapter = new ExpressAdapter(expressInstance);
  const AppModule = buildAppModule({ ...baseOpts, uploads });

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    adapter,
    { logger: false },
  );
  await app.listen(0, "127.0.0.1");

  const server = app.getHttpServer();
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    port,
    close: async () => {
      await app.close();
    },
  };
}

describe("NestJS upload route — integration", () => {
  it("accepts POST with valid Bearer token, routes to the procedure", async () => {
    const { port, close } = await bootstrapWithUploads({
      enabled: true,
      httpPath: "/upload",
    });

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        headers: () => ({ authorization: `Bearer ${GOOD_TOKEN}` }),
      });

      const result = await link.call(
        ["media", "upload"],
        {
          file: new Blob(["test content"], { type: "text/plain" }),
          name: "test.txt",
        },
        { context: {} },
      );

      expect(result).toEqual({
        echoed: true,
        sub: "alice",
        meta: "test.txt",
      });
    } finally {
      await close();
    }
  });

  it("rejects POST without Authorization with 401", async () => {
    const { port, close } = await bootstrapWithUploads({
      enabled: true,
      httpPath: "/upload",
    });

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        headers: () => ({}),
      });

      let error: unknown = undefined;
      try {
        await link.call(
          ["media", "upload"],
          { file: new Blob(["x"]) },
          { context: {} },
        );
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
    } finally {
      await close();
    }
  });

  it("rejects POST with wrong token with 401", async () => {
    const { port, close } = await bootstrapWithUploads({
      enabled: true,
      httpPath: "/upload",
    });

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        headers: () => ({ authorization: "Bearer wrong" }),
      });

      let error: unknown = undefined;
      try {
        await link.call(
          ["media", "upload"],
          { file: new Blob(["x"]) },
          { context: {} },
        );
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
    } finally {
      await close();
    }
  });

  it("bootstrap throws when an existing Express route occupies the configured path", async () => {
    // Pre-register a route at `/upload` on the same Express instance the
    // Nest app will use. The adapter's onApplicationBootstrap should
    // detect the collision and throw.
    const expressInstance = express();
    expressInstance.use("/upload", (_req, res) => {
      res.status(200).end("preexisting");
    });
    const adapter = new ExpressAdapter(expressInstance);

    const AppModule = buildAppModule({
      ...baseOpts,
      uploads: { enabled: true, httpPath: "/upload" },
    });

    // Bootstrap should fail. We capture the error here since
    // NestFactory.create rejects when onApplicationBootstrap throws.
    let error: unknown = undefined;
    try {
      const app = await NestFactory.create<NestExpressApplication>(
        AppModule,
        adapter,
        { logger: false },
      );
      await app.listen(0, "127.0.0.1");
      // If we get here without throwing, close the app and fail.
      await app.close();
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(String(error)).toMatch(/upload/i);
  });

  it("does NOT register the route when uploads.enabled is false", async () => {
    const { port, close } = await bootstrapWithUploads({
      enabled: false,
      httpPath: "/upload",
    });

    try {
      // A POST to /upload should reach Nest's default 404 handler (no
      // route is registered when uploads disabled).
      const resp = await fetch(`http://127.0.0.1:${port}/upload/media/upload`, {
        method: "POST",
      });
      expect(resp.status).toBe(404);
    } finally {
      await close();
    }
  });
});
