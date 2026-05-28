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
// See: https://docs.nestjs.com/fundamentals/dynamic-modules#configurable-module-builder

import { ConfigurableModuleBuilder } from "@nestjs/common";

import type { OrpcWsModuleOptions } from "./orpc-ws.options.js";

export const {
  ConfigurableModuleClass: OrpcWsConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: ORPC_WS_OPTIONS,
} = new ConfigurableModuleBuilder<OrpcWsModuleOptions>()
  .setClassMethodName("forRoot")
  .build();
