// authless `AppModule`. The entire point of this demo: register the
// library's WS module in AUTHLESS mode.
//
// `mode: "authless"` selects the discriminated-union arm that has NO
// `verifyClient`, NO `uploads`, NO `enforceTokenExpiry`. Every WS upgrade is
// accepted; the consumer's procedures run with an empty ORPC context. The
// adapter's `OrpcWsService` reads `mode` and dispatches to the core's
// `createAuthlessOrpcWsServer` (see the adapter's `orpc-ws.options.ts` /
// `orpc-ws.service.ts`).
//
// There is no auth controller, no session store, no OIDC code-exchange —
// authless is strictly simpler than every other demo. The only controller is
// the trivial /health liveness endpoint.

import { Logger, Module } from "@nestjs/common";
import { fromNestShape, OrpcWsModule } from "@orpc-ws/server-nestjs";

import { appRouter } from "./router.js";
import { HealthController } from "./health.controller.js";

const nestLogger = new Logger("OrpcWs");

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      useFactory: () => ({
        // The AUTHLESS arm: no verifyClient, no uploads, no token.
        mode: "authless",
        router: appRouter,
        connection: { path: "/ws" },
        logger: fromNestShape(nestLogger),
      }),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
