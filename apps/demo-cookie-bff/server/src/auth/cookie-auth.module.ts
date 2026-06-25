// The cookie-BFF AppModule — now ONE config block over the library
// (`@orpc-ws/cookie-bff-nestjs`) instead of the ~1000 hand-written lines this
// demo used to carry (its own controller, PKCE code-exchange, cookie helpers,
// oauth_state cookie, in-memory store, and a hand-bound WS verify-client).
//
// Decision #23 (the verifier→WS bridge is the ADAPTER's job): we import ONLY
// `CookieBffModule.forRootAsync` — it internally configures `OrpcWsModule` and
// hands it the cookie verifier. There is NO separate `OrpcWsModule` import and
// NO hand-written `verify-client.ts` anymore.
//
// The demo's footprint is exactly what the design doc §A.3 targets: a CONFIG
// BLOCK + a ~40-line `SessionStore` adapter (session-store.ts) + one
// revocation wire (dev-revoke.controller.ts → `CookieBffService.revokeUser`).

import { Logger, Module } from "@nestjs/common";
import { fromNestShape } from "@orpc-ws/server-nestjs";
import {
  CookieBffModule,
  type CookieBffModuleOptions,
} from "@orpc-ws/cookie-bff-nestjs";

import { APP_ENV_CONFIG, type AppEnvConfig, readEnvConfig } from "../config.js";
import { HealthController } from "../health.controller.js";
import { appRouter } from "../router.js";
import type { DemoUser } from "./demo-user.js";
import { DemoSessionStore } from "./session-store.js";
import { DevRevokeController } from "./dev-revoke.controller.js";

const nestLogger = new Logger("OrpcWs");

// Single shared instances. A module is instantiated once per Nest app and this
// process hosts exactly one mode, so module-eval construction is fine. The
// store is shared with the library's verifier + handlers via the options
// object (the adapter resolves the options factory exactly once).
const config: AppEnvConfig = readEnvConfig();
const sessionStore = new DemoSessionStore();

@Module({
  imports: [
    CookieBffModule.forRootAsync<DemoUser>({
      useFactory: (): CookieBffModuleOptions<DemoUser> => ({
        router: appRouter,
        keycloak: {
          issuerUrl: config.oidc.issuerUrl,
          ...(config.oidc.discoveryUrl
            ? { discoveryUrl: config.oidc.discoveryUrl }
            : {}),
          clientId: config.backendOidc.clientId,
          ...(config.backendOidc.clientSecret
            ? { clientSecret: config.backendOidc.clientSecret }
            : {}),
          // The API's OWN callback — cookie-BFF moves the OAuth callback to a
          // SERVER endpoint (the auth code never touches JS).
          redirectUri: config.callbackUrl,
          scope: "openid profile email",
          // Extra authorize params (F3) — `prompt=select_account` makes the
          // IdP show the account chooser. These can't clobber the PKCE/state/
          // redirect params (the library sets those after, and they win).
          authorizeParams: { prompt: "select_account" },
        },
        // WS Origin allowlist (Decision #10) — the SPA origins.
        originAllowlist: config.spaOrigins.corsOrigins,
        // At-rest token encryption key (§E.3).
        encryptionKey: config.sessionEncKey,
        // The ~40-line demo store adapter (in-memory + companion index).
        sessionStore,
        // Where /auth/callback 302s the browser after setting the cookie.
        spaRedirectUri: config.spaOrigins.redirectOrigin,
        // findOrCreateUser → ENRICHED user (Decision #22). The demo adds a
        // fixed `role` and reads `picture` off the RAW id_token claims (F2 —
        // the third `rawClaims` arg) to set an `avatar`; a real app looks up
        // its DB row here.
        resolveUser: async (claims, _tokens, rawClaims): Promise<DemoUser> => ({
          sub: claims.sub,
          ...(claims.email ? { email: claims.email } : {}),
          ...(claims.name
            ? { name: claims.name }
            : claims.preferredUsername
              ? { name: claims.preferredUsername }
              : {}),
          // Read an arbitrary claim from the raw payload (here standard
          // `picture`) — no library change needed for IdP-specific claims.
          ...(typeof rawClaims.picture === "string"
            ? { avatar: rawClaims.picture }
            : {}),
          role: "demo-user",
        }),
        // ── LOCALHOST cookie config ──
        // The library defaults are PROD-shaped (`__Host-` prefix, Secure,
        // SameSite=Strict). Over plain http://localhost a `__Host-`/Secure
        // cookie is dropped by the browser, so for the demo we relax them:
        // a plain `sid` name, no Secure, no host-prefix, SameSite=Lax.
        // PRODUCTION should OMIT this block and take the hardened defaults.
        cookies: {
          sessionCookieName: config.sessionCookieName, // "sid"
          secure: false,
          hostPrefix: false,
          sameSite: "lax",
        },
        // WS path + central logger, forwarded to OrpcWsModule.
        connection: { path: "/ws" },
        logger: fromNestShape(nestLogger),
      }),
    }),
  ],
  controllers: [HealthController, DevRevokeController],
  providers: [{ provide: APP_ENV_CONFIG, useValue: config }],
})
export class CookieBffAppModule {}
