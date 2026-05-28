// Demo `AppModule`. The whole point of the demo is to exercise
// `OrpcWsModule.forRootAsync` against a real OIDC IdP — so the module
// is almost entirely the library import, parameterized with a
// `VerifyClient` built by `@repo/oidc-verifier-jose`.
//
// `forRootAsync` is here even though no DI is wired today, because the
// future Playwright test will likely want to swap config without
// restarting the process via a `ConfigService` — keeping `forRootAsync`
// makes that drop-in.

import { Module } from "@nestjs/common";
import { createOidcVerifyClient } from "@repo/oidc-verifier-jose";
import { OrpcWsModule } from "@repo/orpc-ws-server-nestjs";

import { readEnvConfig } from "./config.js";
import { appRouter } from "./router.js";

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
            boundClaim: "azp",
            expectedClientId: oidc.clientId,
          }),
          connection: { path: "/ws" },
        };
      },
    }),
  ],
})
export class AppModule {}
