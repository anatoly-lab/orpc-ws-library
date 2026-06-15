// cookie-bff `AppModule`. Full BFF: the server runs the OIDC flow, holds
// every token, and the browser only ever sees an httpOnly session cookie.
// The WS verify (`createCookieVerifyClient`) reads that cookie — there is
// no `?token=` and NO upload transport configured here.
//
// Shared-instance wiring: the controller (built by Nest DI) and the WS
// verify (built inside `forRootAsync`'s `useFactory`) MUST share ONE
// `SessionStore` — a session created on the /auth/callback request has to
// be visible to a WS upgrade moments later. We construct the store +
// code-exchange ONCE at module-eval time and provide both as DI values AND
// close over them in the verify factory, so there's a single instance.

import { Logger, Module } from "@nestjs/common";
import { fromNestShape, OrpcWsModule } from "@orpc-ws/server-nestjs";

import { APP_ENV_CONFIG, type AppEnvConfig, readEnvConfig } from "../../config.js";
import { HealthController } from "../../health.controller.js";
import { appRouter } from "../../router.js";
import { OidcCodeExchange } from "../../shared/oidc-code-exchange.js";
import { SessionStore } from "../../shared/session-store.js";
import { CookieBffController } from "./cookie-bff.controller.js";
import { createCookieVerifyClient } from "./cookie-bff.verify.js";

const nestLogger = new Logger("OrpcWs");

// Single shared instances. Module-eval-time construction is fine: a module
// is instantiated once per Nest app, and this process hosts exactly one
// mode.
const config: AppEnvConfig = readEnvConfig();
const sessionStore = new SessionStore();
const codeExchange = new OidcCodeExchange(config.oidc.issuerUrl, config.backendOidc);

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      useFactory: () => ({
        router: appRouter,
        // Verify reads the httpOnly cookie off the upgrade request; shares
        // the SAME store the controller writes sessions into.
        verifyClient: createCookieVerifyClient(
          sessionStore,
          config.sessionCookieName,
        ),
        connection: { path: "/ws" },
        // No uploads in cookie-bff — keep the mode minimal.
        logger: fromNestShape(nestLogger),
      }),
    }),
  ],
  controllers: [CookieBffController, HealthController],
  providers: [
    // Provide the shared instances by value so CookieBffController's
    // constructor params resolve to the SAME objects the verify closes over.
    { provide: APP_ENV_CONFIG, useValue: config },
    { provide: OidcCodeExchange, useValue: codeExchange },
    { provide: SessionStore, useValue: sessionStore },
  ],
})
export class CookieBffAppModule {}
