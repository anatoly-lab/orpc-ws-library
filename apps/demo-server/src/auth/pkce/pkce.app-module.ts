// PKCE-mode `AppModule`. The original single-mode demo, moved here verbatim
// (behavior is byte-for-byte equivalent — same verifier config, same
// `/ws` path, same `/upload` HTTP transport, same logger bridge).
//
// The SPA does the OIDC/PKCE dance and forwards its access token via
// `?token=`; this module's only job is to exercise
// `OrpcWsModule.forRootAsync` against a real OIDC IdP.
//
// `forRootAsync` is here even though no DI is wired today, because the
// Playwright test will likely want to swap config without restarting the
// process via a `ConfigService` — keeping `forRootAsync` makes that
// drop-in.

import { Logger, Module } from "@nestjs/common";
import { fromNestShape, OrpcWsModule } from "@orpc-ws/server-nestjs";

import { readEnvConfig } from "../../config.js";
import { HealthController } from "../../health.controller.js";
import { appRouter } from "../../router.js";
import { createPkceVerifyClient } from "./pkce.verify.js";

// Bridge the library's Logger seam to Nest's structured Logger so events
// show up alongside the rest of the app's logs. Nest's Logger.debug only
// renders when the process log level includes 'debug'.
const nestLogger = new Logger("OrpcWs");

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      useFactory: () => {
        const { oidc } = readEnvConfig();
        return {
          router: appRouter,
          verifyClient: createPkceVerifyClient(oidc),
          connection: { path: "/ws" },
          // Opt-in HTTP transport for the demo's image upload. The NestJS
          // adapter auto-mounts an ORPC `RPCHandler` at `httpPath` during
          // bootstrap; `uploadImage` becomes reachable at POST /upload/uploadImage.
          uploads: { enabled: true, httpPath: "/upload", bodyLimitBytes: 10 * 1024 * 1024 },
          logger: fromNestShape(nestLogger),
        };
      },
    }),
  ],
  controllers: [HealthController],
})
export class PkceAppModule {}
