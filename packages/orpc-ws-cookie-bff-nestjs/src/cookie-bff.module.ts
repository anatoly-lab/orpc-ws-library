// `CookieBffModule` — the single module a cookie-BFF consumer installs.
//
// THE LOAD-BEARING INVARIANT (Decision #23 — verifier→WS bridge is the
// ADAPTER's job): `forRootAsync(opts)` internally configures `OrpcWsModule`
// and hands it the cookie `VerifyClient`. The consumer wires ONE module and
// NEVER touches the WS verifier wiring. If the adapter merely exported the
// verifier, the consumer would re-create a `websocket/verify-client.ts` and
// re-import `OrpcWsModule` by hand — exactly the scattering #23 forbids.
//
// COMPOSITION SHAPE (why hand-written, not ConfigurableModuleBuilder):
// the builder's generated `forRootAsync` doesn't compose cleanly with an
// internal `imports: [OrpcWsModule.forRootAsync(...)]` whose own factory must
// read THIS module's resolved options. So we hand-roll a `DynamicModule`:
//
//   1. An inner `optionsModule` provides + exports `COOKIE_BFF_OPTIONS`
//      (the literal value for `forRoot`, or the async factory for
//      `forRootAsync`). It is the SINGLE source of the resolved options.
//   2. `COOKIE_BFF_CORE` is a factory provider over `COOKIE_BFF_OPTIONS`
//      (`createCookieBffCore(options)`) — the `/auth/*` handlers.
//   3. `OrpcWsModule.forRootAsync({ imports: [optionsModule], inject:
//      [COOKIE_BFF_OPTIONS], useFactory })` builds the WS server options from
//      the SAME options: it constructs the cookie verifier via
//      `createCookieVerifyClient(store, …)` and forwards `router` + the WS
//      passthroughs. THIS is the bridge.
//   4. The `/auth/*` controller + `CookieBffService` are registered/exported.
//
// Because `optionsModule` exports the options token AND the inner
// `OrpcWsModule.forRootAsync` imports it, the inner factory can inject the
// resolved options — the standard Nest pattern for sharing a provider into a
// dynamically-imported module's factory.
//
// INSTALL EXACTLY ONCE (app root). `CookieBffModule` owns the single
// `@Global` WS transport via its internal `OrpcWsModule`. Importing it twice
// — or importing `OrpcWsModule` separately ALONGSIDE it — would attach two WS
// servers to the same path: a last-wins / double-listen footgun. This is the
// same implicit single-install constraint `OrpcWsModule` already carries. We
// deliberately DON'T add a static-flag runtime guard: it would false-positive
// across tests (and any legitimate teardown/re-create) that build the module
// more than once in a single process.

import { type DynamicModule, Module } from "@nestjs/common";

import {
  createCookieBffCore,
  createCookieVerifyClient,
  type SessionStore,
} from "@orpc-ws/cookie-bff";
import { OrpcWsModule, type OrpcWsModuleOptions } from "@orpc-ws/server-nestjs";

import { CookieBffAuthController } from "./auth.controller.js";
import { CookieBffService } from "./cookie-bff.service.js";
import { COOKIE_BFF_CORE, COOKIE_BFF_OPTIONS } from "./cookie-bff.tokens.js";
import type { CookieBffModuleOptions } from "./cookie-bff.options.js";

/** `forRootAsync` arg — mirrors Nest's async-options convention. */
export interface CookieBffModuleAsyncOptions<TUser = unknown> {
  imports?: DynamicModule["imports"];
  inject?: ReadonlyArray<unknown>;
  useFactory: (
    ...args: never[]
  ) => CookieBffModuleOptions<TUser> | Promise<CookieBffModuleOptions<TUser>>;
}

@Module({})
export class CookieBffModule {
  /** Synchronous config — a literal options object (rare; async is primary). */
  static forRoot<TUser = unknown>(
    options: CookieBffModuleOptions<TUser>,
  ): DynamicModule {
    const optionsModule = makeOptionsModule({
      providers: [{ provide: COOKIE_BFF_OPTIONS, useValue: options }],
    });
    return buildModule(optionsModule);
  }

  /**
   * Async config (PRIMARY) — every real consumer needs DI for the session
   * store / config. The factory's resolved options drive BOTH the `/auth/*`
   * core AND the internal `OrpcWsModule` verifier bridge.
   */
  static forRootAsync<TUser = unknown>(
    async: CookieBffModuleAsyncOptions<TUser>,
  ): DynamicModule {
    const optionsModule = makeOptionsModule({
      imports: async.imports ?? [],
      providers: [
        {
          provide: COOKIE_BFF_OPTIONS,
          useFactory: async.useFactory,
          inject: (async.inject ?? []) as never[],
        },
      ],
    });
    return buildModule(optionsModule);
  }
}

/**
 * A tiny module that provides + exports `COOKIE_BFF_OPTIONS`. Exporting it is
 * what lets the inner `OrpcWsModule.forRootAsync` factory inject the resolved
 * options (and the `CookieBffModule`'s own core/service providers too).
 */
function makeOptionsModule(extra: {
  imports?: DynamicModule["imports"];
  providers: DynamicModule["providers"];
}): DynamicModule {
  return {
    module: CookieBffOptionsModule,
    imports: extra.imports ?? [],
    providers: extra.providers,
    exports: [COOKIE_BFF_OPTIONS],
  };
}

@Module({})
class CookieBffOptionsModule {}

/**
 * Assemble the `CookieBffModule` DynamicModule from a resolved options module.
 * Shared by `forRoot` (value) and `forRootAsync` (factory) so the wiring lives
 * in ONE place — the only difference is how `COOKIE_BFF_OPTIONS` is produced.
 */
function buildModule(optionsModule: DynamicModule): DynamicModule {
  // The CORE provider — the /auth/* handlers, built from the resolved options.
  const coreProvider = {
    provide: COOKIE_BFF_CORE,
    useFactory: (opts: CookieBffModuleOptions) => createCookieBffCore(opts),
    inject: [COOKIE_BFF_OPTIONS],
  };

  return {
    module: CookieBffModule,
    imports: [
      optionsModule,
      // ── THE BRIDGE (Decision #23) ──
      // Configure OrpcWsModule from the SAME resolved options, building the
      // cookie verifier internally. The consumer never wires this.
      OrpcWsModule.forRootAsync({
        imports: [optionsModule],
        inject: [COOKIE_BFF_OPTIONS],
        useFactory: (opts: CookieBffModuleOptions): OrpcWsModuleOptions =>
          toOrpcWsOptions(opts),
      }),
    ],
    providers: [coreProvider, CookieBffService],
    controllers: [CookieBffAuthController],
    // Export the service (consumer calls revokeUser/closeUser) + the core
    // (advanced consumers inject it). `COOKIE_BFF_OPTIONS` is owned by
    // `optionsModule`, so we re-export THAT module (not the token directly —
    // Nest forbids exporting a provider this module doesn't itself declare) to
    // make the options token reachable to downstream consumers.
    exports: [CookieBffService, COOKIE_BFF_CORE, optionsModule],
  };
}

/**
 * Map `CookieBffModuleOptions` → `OrpcWsModuleOptions`: forward the router +
 * WS passthroughs, and build the cookie `verifyClient` from the same cookie/
 * origin/session config the core uses (so the verifier and `/auth/*` agree on
 * cookie name, slide policy, etc.).
 */
function toOrpcWsOptions(opts: CookieBffModuleOptions): OrpcWsModuleOptions {
  const cookieName = opts.cookies?.sessionCookieName ?? "__Host-sid";
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? 60 * 60 * 24 * 30;

  const verifyClient = createCookieVerifyClient(
    opts.sessionStore as SessionStore<unknown>,
    {
      cookieName,
      originAllowlist: opts.originAllowlist,
      slideSessionOnActivity: opts.slideSessionOnActivity ?? true,
      sessionTtlSeconds,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    },
  );

  return {
    router: opts.router,
    verifyClient,
    // enforceTokenExpiry stays OFF (the WS pipe follows the SESSION window,
    // not the access token — §F.1). We never set it here.
    ...(opts.connection ? { connection: opts.connection } : {}),
    ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}),
    ...(opts.interceptors ? { interceptors: opts.interceptors } : {}),
    ...(opts.rootInterceptors ? { rootInterceptors: opts.rootInterceptors } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
}
