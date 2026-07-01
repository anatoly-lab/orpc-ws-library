// `ConfigurableModuleBuilder` factory for the `OrpcWsModule`.
//
// Nest 10/11 idiomatic pattern: declare module-options shape, let the
// builder generate `forRoot` / `forRootAsync` (sync + async DI overloads,
// useFactory / useClass / useExisting) and the `MODULE_OPTIONS_TOKEN`
// for injection. We rename the export of the options token to
// `ORPC_WS_OPTIONS` for an ergonomic, library-namespaced public name —
// consumers see `ORPC_WS_OPTIONS` everywhere, not Nest's generic
// `MODULE_OPTIONS_TOKEN`.
//
// `setClassMethodName("forRoot")` flips the builder defaults from
// `register` / `registerAsync` to `forRoot` / `forRootAsync`. Matches
// the convention used by `@nestjs/config`, `@nestjs/typeorm`, etc.
//
// `OPTIONS_TYPE` / `ASYNC_OPTIONS_TYPE` are the builder's compile-time-only
// type carriers (runtime `undefined`; used only via `typeof`). `OrpcWsModule`
// re-declares generic `forRoot` / `forRootAsync` overrides that delegate to
// the builder's generated methods and cast back to these — the canonical Nest
// pattern for adding generics on top of a `ConfigurableModuleBuilder` (the
// generated signatures are fixed to the erased `OrpcWsModuleOptions`, so a
// generic `TClientContract`/`TUser` can only be surfaced via an override).
//
// See: https://docs.nestjs.com/fundamentals/dynamic-modules#configurable-module-builder

import { ConfigurableModuleBuilder } from "@nestjs/common";

import type { OrpcWsModuleOptions } from "./orpc-ws.options.js";

export const {
  ConfigurableModuleClass: OrpcWsConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: ORPC_WS_OPTIONS,
  OPTIONS_TYPE: ORPC_WS_OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE: ORPC_WS_ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<OrpcWsModuleOptions>()
  .setClassMethodName("forRoot")
  .build();
