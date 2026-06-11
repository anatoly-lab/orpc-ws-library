// Demo `AppModule`. The whole point of the demo is to exercise
// `OrpcWsModule.forRootAsync` against a real OIDC IdP — so the module
// is almost entirely the library import, parameterized with a
// `VerifyClient` built by `@repo/oidc-verifier-jose`.
//
// `forRootAsync` is here even though no DI is wired today, because the
// future Playwright test will likely want to swap config without
// restarting the process via a `ConfigService` — keeping `forRootAsync`
// makes that drop-in.

import { Logger, Module } from "@nestjs/common";
import { createOidcVerifyClient } from "@repo/oidc-verifier-jose";
import { fromNestShape, OrpcWsModule } from "@repo/orpc-ws-server-nestjs";

import { readEnvConfig } from "./config.js";
import { HealthController } from "./health.controller.js";
import { appRouter } from "./router.js";

// Bridge the library's Logger seam to Nest's structured Logger so events
// show up alongside the rest of the app's logs. Nest's Logger.debug only
// renders when the process log level includes 'debug' (set via
// `app.useLogger(['error','warn','log','debug'])` in main.ts or the
// LOG_LEVEL env var).
const nestLogger = new Logger("OrpcWs");

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      useFactory: () => {
        const { oidc } = readEnvConfig();
        return {
          router: appRouter,
          // `boundClaim: "azp"` is the Keycloak default — the demo runs
          // on Keycloak. Auth0 / Okta consumers would set `"aud"`.
          verifyClient: createOidcVerifyClient({
            issuerUrl: oidc.issuerUrl,
            // Split-host (container) deployments fetch discovery + JWKS
            // over the internal docker-network URL while validating the
            // token `iss` against the public `issuerUrl`. Omitted in
            // local dev ⇒ verifier defaults to issuerUrl.
            ...(oidc.discoveryUrl ? { discoveryUrl: oidc.discoveryUrl } : {}),
            boundClaim: "azp",
            expectedClientId: oidc.clientId,
          }),
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
export class AppModule {}
