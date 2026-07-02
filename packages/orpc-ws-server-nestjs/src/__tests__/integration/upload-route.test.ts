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

import { describe, expect, it, vi } from "vitest";
import {
  Controller,
  Get,
  Logger,
  Module,
  Post,
  type Type,
} from "@nestjs/common";
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
function buildAppModule(
  opts: OrpcWsModuleOptions,
  controllers: Type<unknown>[] = [],
) {
  @Module({
    imports: [OrpcWsModule.forRoot(opts)],
    controllers,
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

// ----- Controller-shadowing detection (warn-only) -----
//
// On Nest 11, `init()` runs registerRouter (controllers) BEFORE
// callInitHook (our onModuleInit `app.use`), so a consumer controller
// route nested under `uploads.httpPath` sits earlier in the Express
// stack and silently wins over the upload handler for that path+method.
// The adapter can't fix the ordering, so it WARNS at bootstrap; these
// tests pin the warning and its boundaries.

/** Shadows the RPC procedure at /upload/media/upload. */
@Controller("upload")
class ShadowingUploadController {
  @Post("media/upload")
  intercept(): { via: string } {
    return { via: "controller" };
  }
}

/** Control: a route OUTSIDE the upload prefix must not warn. */
@Controller()
class UnrelatedController {
  @Get("health")
  health(): { ok: boolean } {
    return { ok: true };
  }
}

/** Occupies /upload exactly — the pre-existing hard-fail case. */
@Controller("upload")
class ExactPathController {
  @Post()
  handle(): { via: string } {
    return { via: "controller" };
  }
}

describe("NestJS upload route — controller shadowing detection", () => {
  it("warns (not throws) when a controller route is nested under httpPath, naming the offending route", async () => {
    // The service logs through a `new Logger(...)` instance, so a
    // prototype spy sees the call regardless of the app's `logger`
    // option (which only silences the downstream logger service).
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    try {
      const expressInstance = express();
      const adapter = new ExpressAdapter(expressInstance);
      const AppModule = buildAppModule(
        { ...baseOpts, uploads: { enabled: true, httpPath: "/upload" } },
        [ShadowingUploadController, UnrelatedController],
      );

      // Bootstrap must SUCCEED — shadowing is warn-only (throwing here
      // would be a breaking change for already-running apps).
      const app = await NestFactory.create<NestExpressApplication>(
        AppModule,
        adapter,
        { logger: false },
      );
      await app.listen(0, "127.0.0.1");
      const port = (app.getHttpServer().address() as AddressInfo).port;

      try {
        const messages = warnSpy.mock.calls.map((call) => String(call[0]));
        const shadowWarnings = messages.filter((m) => m.includes("shadow"));
        // The offending nested route is named...
        expect(
          shadowWarnings.some((m) => m.includes('"/upload/media/upload"')),
        ).toBe(true);
        // ...and the out-of-prefix control route is NOT warned about.
        expect(shadowWarnings.some((m) => m.includes("/health"))).toBe(false);

        // Runtime pin of the mechanism the warning describes: the
        // controller (registered first) wins over the upload handler.
        const resp = await fetch(
          `http://127.0.0.1:${port}/upload/media/upload`,
          { method: "POST" },
        );
        expect(resp.status).toBe(201); // Nest @Post default, not ORPC.
        expect(await resp.json()).toEqual({ via: "controller" });
      } finally {
        await app.close();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still THROWS on an exact-path controller collision (warn path does not over-reach)", async () => {
    const expressInstance = express();
    const adapter = new ExpressAdapter(expressInstance);
    const AppModule = buildAppModule(
      { ...baseOpts, uploads: { enabled: true, httpPath: "/upload" } },
      [ExactPathController],
    );

    let error: unknown = undefined;
    try {
      const app = await NestFactory.create<NestExpressApplication>(
        AppModule,
        adapter,
        { logger: false },
      );
      // onModuleInit (where the collision check runs) fires during
      // init/listen, not during create — same shape as the app.use
      // collision test above.
      await app.listen(0, "127.0.0.1");
      // If we get here without throwing, close the app and fail below.
      await app.close();
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(String(error)).toMatch(/upload/i);
  });

  it("does not false-positive on pathless middleware (Express 5 matchers reject the path)", async () => {
    // Pathless `app.use(fn)` layers (body parsers, etc.) expose Express 5
    // matcher functions that return false for "/upload" — pinned here so
    // a future introspection change can't start warning/throwing on them.
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    try {
      const expressInstance = express();
      expressInstance.use((_req, _res, next) => next());
      const adapter = new ExpressAdapter(expressInstance);
      const AppModule = buildAppModule({
        ...baseOpts,
        uploads: { enabled: true, httpPath: "/upload" },
      });

      const app = await NestFactory.create<NestExpressApplication>(
        AppModule,
        adapter,
        { logger: false },
      );
      await app.listen(0, "127.0.0.1");
      const port = (app.getHttpServer().address() as AddressInfo).port;

      try {
        const messages = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(messages.some((m) => m.includes("shadow"))).toBe(false);

        // The upload handler still works through the pathless layer.
        const link = new RPCLink({
          url: `http://127.0.0.1:${port}/upload`,
          headers: () => ({ authorization: `Bearer ${GOOD_TOKEN}` }),
        });
        const result = await link.call(
          ["media", "upload"],
          { file: new Blob(["x"]), name: "ok.txt" },
          { context: {} },
        );
        expect(result).toEqual({ echoed: true, sub: "alice", meta: "ok.txt" });
      } finally {
        await app.close();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
