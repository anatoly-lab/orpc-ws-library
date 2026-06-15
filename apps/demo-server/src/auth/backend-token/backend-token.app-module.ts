// backend-token `AppModule`. The server runs the OIDC flow and holds the
// refresh + id tokens server-side, but the WS still authenticates via the
// access token over `?token=` (same as PKCE) — so the verify is the PKCE
// OIDC verifier and the upload transport is wired identically to PKCE.
//
// Like cookie-bff, the controller (Nest DI) and the verify (forRootAsync
// factory) share a single `SessionStore` + `OidcCodeExchange`, constructed
// once at module-eval time.

import { Logger, Module } from "@nestjs/common";
import { fromNestShape, OrpcWsModule } from "@orpc-ws/server-nestjs";

import { APP_ENV_CONFIG, type AppEnvConfig, readEnvConfig } from "../../config.js";
import { HealthController } from "../../health.controller.js";
import { appRouter } from "../../router.js";
import { OidcCodeExchange } from "../../shared/oidc-code-exchange.js";
import { SessionStore } from "../../shared/session-store.js";
import { BackendTokenController } from "./backend-token.controller.js";
import { createBackendTokenVerifyClient } from "./backend-token.verify.js";

const nestLogger = new Logger("OrpcWs");

const config: AppEnvConfig = readEnvConfig();
const sessionStore = new SessionStore();
const codeExchange = new OidcCodeExchange(config.oidc.issuerUrl, config.backendOidc);

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      useFactory: () => ({
        router: appRouter,
        // Same OIDC token verify as PKCE — the access token rides `?token=`.
        verifyClient: createBackendTokenVerifyClient(config.oidc),
        connection: { path: "/ws" },
        // Match PKCE's upload transport so the demo's image upload works
        // the same way across token-based modes.
        uploads: { enabled: true, httpPath: "/upload", bodyLimitBytes: 10 * 1024 * 1024 },
        logger: fromNestShape(nestLogger),
      }),
    }),
  ],
  controllers: [BackendTokenController, HealthController],
  providers: [
    { provide: APP_ENV_CONFIG, useValue: config },
    { provide: OidcCodeExchange, useValue: codeExchange },
    { provide: SessionStore, useValue: sessionStore },
  ],
})
export class BackendTokenAppModule {}
