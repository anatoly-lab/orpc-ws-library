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

import { Global, Module } from "@nestjs/common";

import { OrpcWsConfigurableModuleClass } from "./orpc-ws.module-builder.js";
import { OrpcWsService } from "./orpc-ws.service.js";

@Global()
@Module({
  providers: [OrpcWsService],
  exports: [OrpcWsService],
})
export class OrpcWsModule extends OrpcWsConfigurableModuleClass {}
