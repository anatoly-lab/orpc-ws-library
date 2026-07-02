// `OrpcWsModule` — the NestJS dynamic module wrapping the framework-free
// `OrpcWsServer` core.
//
// Public surface: `forRoot(options)` and `forRootAsync({ useFactory,
// inject })` — both wired by `OrpcWsConfigurableModuleClass`.
// `forRootAsync` is the documented primary pattern: every real consumer
// needs DI for `verifyClient` (AuthService, ConfigService).
//
// `@Global()` — the WS server is a transport singleton. Once configured
// at the root, every feature module that needs `OrpcWsService` (e.g. to
// call `closeUser` from an admin controller) should get it without
// re-importing `OrpcWsModule`. The same convention applies to
// `@nestjs/config`, `@nestjs/typeorm`, etc. when their modules are
// considered global.
//
// Install EXACTLY once per Nest app. Registering `forRoot`/`forRootAsync`
// twice — or importing this module alongside one that configures it
// internally (e.g. `CookieBffModule`) — attaches two `WebSocketServer`s
// to the one HTTP server, and the FIRST WS connection crashes with ws's
// "server.handleUpgrade() was called more than once". Doc-only guard on
// purpose: a runtime static flag would false-positive across sequential
// Nest app instances in tests.

import {
  type ConfigurableModuleAsyncOptions,
  type DynamicModule,
  Global,
  Module,
} from "@nestjs/common";

import type { AnyContractRouter } from "@orpc-ws/server";

import {
  type ORPC_WS_ASYNC_OPTIONS_TYPE,
  type ORPC_WS_OPTIONS_TYPE,
  OrpcWsConfigurableModuleClass,
} from "./orpc-ws.module-builder.js";
import type { OrpcWsModuleOptions } from "./orpc-ws.options.js";
import { OrpcWsService } from "./orpc-ws.service.js";

@Global()
@Module({
  providers: [OrpcWsService],
  exports: [OrpcWsService],
})
export class OrpcWsModule extends OrpcWsConfigurableModuleClass {
  // The builder generates `forRoot` / `forRootAsync` typed against the ERASED
  // `OrpcWsModuleOptions` (where `TClientContract` is the `never` default), so
  // its generated signatures type `clientContract?: never` — un-passable. We
  // re-declare both as GENERIC static overrides that surface the third
  // (`TClientContract`) and first (`TUser`) generics, then delegate to the
  // builder's implementation via `super`, casting back to the builder's own
  // option-type carriers. This is the canonical Nest recipe (see the
  // `OPTIONS_TYPE` / `ASYNC_OPTIONS_TYPE` docs in @nestjs/common).
  //
  // Opt-in / byte-identical-when-off: with `TClientContract` left at its
  // `never` default the signatures collapse to exactly the prior ones, and the
  // runtime is untouched — `super.forRoot*` is the same generated method, the
  // options object is forwarded verbatim (the core reads `clientContract`
  // presence itself).
  //
  // BIDI INFERENCE CAVEAT (forRootAsync only). `forRoot` takes the options
  // literal directly, so `TClientContract` is inferred from the `clientContract`
  // VALUE you pass. `forRootAsync` takes a `useFactory` instead, and TS's
  // higher-order inference will NOT pull this third generic out of a BARE
  // (unannotated) factory return — `forRootAsync({ useFactory: () => ({ router,
  // clientContract, hooks }) })` infers `TClientContract = never`, so `conn.client`
  // silently loses its typing (collapses to absent). To make the bidi generic
  // flow, annotate the factory's RETURN type —
  // `useFactory: (): OrpcWsModuleOptions<TUser, TContract, MyClientContract> =>
  // ({ … })` — or pass the type args to `forRootAsync` explicitly. (Runtime is
  // unaffected either way; this is purely about preserving `.client` typing.)

  static override forRoot<
    TUser = unknown,
    TContract extends object = object,
    TClientContract extends AnyContractRouter = never,
  >(
    options: OrpcWsModuleOptions<TUser, TContract, TClientContract>,
  ): DynamicModule {
    return super.forRoot(options as typeof ORPC_WS_OPTIONS_TYPE);
  }

  static override forRootAsync<
    TUser = unknown,
    TContract extends object = object,
    TClientContract extends AnyContractRouter = never,
  >(
    options: ConfigurableModuleAsyncOptions<
      OrpcWsModuleOptions<TUser, TContract, TClientContract>
    >,
  ): DynamicModule {
    return super.forRootAsync(options as typeof ORPC_WS_ASYNC_OPTIONS_TYPE);
  }
}
