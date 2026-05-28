// Unit-ish test for `OrpcWsModule.forRoot` / `forRootAsync` wiring.
//
// What we pin here:
//   - `forRoot(options)` produces a DynamicModule containing
//     `OrpcWsService` and binding the options token.
//   - `forRootAsync({ useFactory, inject })` runs the factory at
//     compile() time and the resolved options are reachable via
//     `ORPC_WS_OPTIONS`.
//   - `OrpcWsService` resolves through DI when both options + a stub
//     `HttpAdapterHost` are available.
//
// We do NOT bootstrap a real HTTP server here — that's the integration
// test's job (see ./integration/lifecycle.test.ts). `HttpAdapterHost` is
// overridden with a stub: `httpAdapter` is `null` until the app actually
// starts, and we never call `OnApplicationBootstrap`.

import { describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { Injectable, Module } from "@nestjs/common";

import { OrpcWsModule } from "../orpc-ws.module.js";
import { OrpcWsService } from "../orpc-ws.service.js";
import { ORPC_WS_OPTIONS } from "../orpc-ws.module-builder.js";
import type { OrpcWsModuleOptions } from "../orpc-ws.options.js";

// Reflect-metadata must be loaded before any DI container runs.
// `@nestjs/core` imports it transitively but we explicit-side-effect here
// so the order is unambiguous if a test runs this file in isolation.
import "reflect-metadata";

const trivialOptions = (): OrpcWsModuleOptions => ({
  router: {},
  verifyClient: async () => ({
    ok: true,
    user: { sub: "test-user" },
    connectionKey: "test-user",
  }),
});

// A stub HttpAdapterHost — the service constructor only needs the
// reference; OnApplicationBootstrap is not invoked in unit tests.
const stubHttpAdapterHost = {
  httpAdapter: null,
};

describe("OrpcWsModule.forRoot()", () => {
  it("returns a DynamicModule wiring OrpcWsService and the options token", async () => {
    const opts = trivialOptions();

    const moduleRef = await Test.createTestingModule({
      imports: [OrpcWsModule.forRoot(opts)],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    // Service resolves — the eager OrpcWsServer construction in its
    // constructor succeeded (router collision check etc.).
    const service = moduleRef.get(OrpcWsService);
    expect(service).toBeInstanceOf(OrpcWsService);

    // The options token is bound to the value we passed.
    const resolvedOptions = moduleRef.get<OrpcWsModuleOptions>(ORPC_WS_OPTIONS);
    expect(resolvedOptions).toBe(opts);
    expect(resolvedOptions.verifyClient).toBe(opts.verifyClient);

    await moduleRef.close();
  });

  it("eager router-collision check fires at module bootstrap (not on first connect)", async () => {
    // Heartbeat namespace collision in consumer's router — the core
    // throws synchronously in its constructor, which is called eagerly
    // by OrpcWsService's constructor. Nest's compile() surfaces this as
    // a thrown error during DI resolution.
    const collidingOptions: OrpcWsModuleOptions = {
      // The library's reserved namespace per CLAUDE.md "Heartbeat
      // ownership — stealth procedure pattern".
      router: { __orpc_ws_lib__: { heartbeat: "anything" } },
      verifyClient: async () => ({
        ok: true,
        user: {},
        connectionKey: "u",
      }),
    };

    await expect(
      Test.createTestingModule({
        imports: [OrpcWsModule.forRoot(collidingOptions)],
      })
        .overrideProvider(HttpAdapterHost)
        .useValue(stubHttpAdapterHost)
        .compile(),
    ).rejects.toThrow();
  });
});

// A DI consumer used by the async test below: factory dependency.
@Injectable()
class FakeAuthService {
  verify(): "ok" {
    return "ok";
  }
}

@Module({
  providers: [FakeAuthService],
  exports: [FakeAuthService],
})
class FakeAuthModule {}

describe("OrpcWsModule.forRootAsync()", () => {
  it("invokes useFactory during compile() with injected deps", async () => {
    const factory = vi.fn((auth: FakeAuthService): OrpcWsModuleOptions => {
      // Touch the injected dep so a wiring regression is observable.
      expect(auth.verify()).toBe("ok");
      return trivialOptions();
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeAuthModule,
        OrpcWsModule.forRootAsync({
          imports: [FakeAuthModule],
          inject: [FakeAuthService],
          useFactory: factory,
        }),
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.any(FakeAuthService));

    // Options token holds whatever the factory returned.
    const resolvedOptions = moduleRef.get<OrpcWsModuleOptions>(ORPC_WS_OPTIONS);
    expect(resolvedOptions).toBeDefined();
    expect(typeof resolvedOptions.verifyClient).toBe("function");

    // Service still resolves.
    const service = moduleRef.get(OrpcWsService);
    expect(service).toBeInstanceOf(OrpcWsService);

    await moduleRef.close();
  });
});
