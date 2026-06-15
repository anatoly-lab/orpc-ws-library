// Demo server env-config shape. Single source of truth — every mode's
// app-module + main entry reads from `readEnvConfig()`.
//
// The demo monorepo hosts THREE auth-mode demos, each run as its OWN
// Nest process (the library's `OrpcWsModule` is single-instance per
// app), on its own port:
//   - PKCE          — the SPA does the OIDC dance; the access token
//                     rides `?token=` to the WS. (port 18081)
//   - backend-token — the SERVER does the OIDC code exchange (server-side
//                     PKCE, public client, no secret), stores the refresh
//                     token, and hands the SPA short-lived access tokens
//                     it forwards over `?token=`. (port 18082)
//   - cookie-bff    — full BFF: the server holds ALL tokens, the SPA only
//                     ever sees an httpOnly session cookie; the WS verify
//                     reads the cookie, no `?token=` at all. (port 18083)
//
// Defaults match the dev/Playwright Keycloak realm. Overriding the env
// vars below swaps in a different IdP / ports / origins without code
// changes.
//
// NOTE: this is APP code, not library code. The CLAUDE.md "Zero
// `process.env` reads inside library code" rule applies to the packages
// under `packages/`, not to the demo composition root.

/**
 * Nest DI token for the resolved `AppEnvConfig`. `AppEnvConfig` is an
 * interface (erased at runtime), so the cookie-bff / backend-token
 * controllers inject it with `@Inject(APP_ENV_CONFIG)` rather than by type.
 */
export const APP_ENV_CONFIG = "APP_ENV_CONFIG";

export interface OidcAuthConfig {
  /** OIDC issuer URL — the same one the SPA's `@orpc-ws/oidc-pkce` uses. */
  issuerUrl: string;
  /**
   * OPTIONAL internal base URL the SERVER fetches discovery + JWKS from,
   * for split-host deployments (containers): the browser + token `iss`
   * use the public `issuerUrl`, while this server reaches the IdP over
   * the docker network at e.g. `http://keycloak:8080/realms/<realm>`.
   * Undefined ⇒ verifier defaults to `issuerUrl` (local-dev unchanged).
   */
  discoveryUrl?: string;
  /**
   * Expected client-bound claim for the WS-token verify — the SPA's OIDC
   * client ID. PKCE + backend-token both validate the access token
   * against this (the token is minted for the SPA's public client).
   */
  clientId: string;
}

/**
 * Config for the modes where the SERVER performs the OIDC code exchange
 * (backend-token + cookie-bff). Both run the exchange as a PUBLIC PKCE
 * client (no client secret) — see `OIDC_BACKEND_CLIENT_SECRET` below.
 */
export interface BackendOidcConfig {
  /**
   * The OIDC client the SERVER exchanges codes against. Defaults to
   * `OidcAuthConfig.clientId` — Keycloak's `orpc-ws-demo-spa` public
   * client works for the server-side PKCE flow too. Split it out only
   * if you register a dedicated confidential/back-channel client.
   */
  clientId: string;
  /**
   * SLOT for a confidential-client secret. The demo's backend modes are
   * deliberately PUBLIC PKCE clients (no secret) — the code-exchange
   * sends `code_verifier`, not `client_secret`. If you register a
   * CONFIDENTIAL client and set this, `oidc-code-exchange.ts` has a
   * clearly-commented slot to forward it. Left `undefined` here so the
   * public-client path stays the default.
   */
  clientSecret?: string;
}

/**
 * Per-mode SPA origin policy. A backend mode's SPA runs on more than one
 * origin (Vite dev + `vite preview`), so CORS must allow the whole list,
 * while the post-`/auth/callback` 302 needs a single primary target.
 */
export interface SpaOriginConfig {
  /**
   * The single origin the server 302s back to after a successful
   * server-side login. The FIRST entry of the configured origin list.
   */
  redirectOrigin: string;
  /**
   * The full CORS allowlist (credentials mode) for this mode's SPA —
   * dev + preview origins. Never `*` (credentials forbids the wildcard).
   */
  corsOrigins: string[];
}

export interface AppEnvConfig {
  /** PKCE mode port (the original demo-server port). */
  port: number;
  /** Per-mode listen ports. */
  ports: {
    pkce: number;
    backendToken: number;
    cookieBff: number;
  };
  oidc: OidcAuthConfig;
  /** Server-side code-exchange client (backend-token + cookie-bff). */
  backendOidc: BackendOidcConfig;
  /**
   * Per-mode SPA origin policy. Each backend mode has its own SPA, which
   * runs on TWO origins: the Vite dev server AND the `vite preview` build.
   * Both must be CORS-allowed (credentials mode) so a preview build's
   * cookie/credentialed `/auth/*` fetches aren't blocked; the post-login
   * 302 targets a single primary origin.
   */
  spaOrigins: {
    backendToken: SpaOriginConfig;
    cookieBff: SpaOriginConfig;
  };
  /** PKCE-mode CORS origins (the upload preflight; comma-separated env). */
  corsOrigins: string[];
  /** Name of the httpOnly session cookie set by the backend modes. */
  sessionCookieName: string;
}

/**
 * Parse a comma-separated origin list into a trimmed, non-empty array.
 */
function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Build a per-mode `SpaOriginConfig` from a comma-separated origin env var.
 * The FIRST entry is the post-login redirect target; the WHOLE list is the
 * CORS allowlist (dev + preview origins).
 */
function parseSpaOriginConfig(raw: string): SpaOriginConfig {
  const corsOrigins = parseOrigins(raw);
  return { redirectOrigin: corsOrigins[0] ?? "", corsOrigins };
}

/**
 * Read `AppEnvConfig` from a process-env-shaped object. Defaults to
 * `process.env`; tests can pass a fixture object.
 */
export function readEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppEnvConfig {
  // Back-compat: the original PKCE demo read `PORT` (18081). Honor it as
  // the PKCE port default so existing `.env` files keep working, but
  // `PORT_PKCE` (if set) wins.
  const pkcePort = Number(env.PORT_PKCE ?? env.PORT ?? 18081);
  const clientId = env.OIDC_CLIENT_ID ?? "orpc-ws-demo-spa";

  return {
    port: pkcePort,
    ports: {
      pkce: pkcePort,
      backendToken: Number(env.PORT_BACKEND_TOKEN ?? 18082),
      cookieBff: Number(env.PORT_COOKIE_BFF ?? 18083),
    },
    oidc: {
      issuerUrl:
        env.OIDC_ISSUER_URL ?? "http://localhost:18080/realms/orpc-ws-demo",
      // Optional: only set when the env var is present, so an unset
      // value stays `undefined` and the verifier falls back to issuerUrl.
      ...(env.OIDC_DISCOVERY_URL
        ? { discoveryUrl: env.OIDC_DISCOVERY_URL }
        : {}),
      clientId,
    },
    backendOidc: {
      // Defaults to the SPA's public client — server-side PKCE works
      // against a public client without a secret.
      clientId: env.OIDC_BACKEND_CLIENT_ID ?? clientId,
      // Only present when the consumer opted into a confidential client.
      ...(env.OIDC_BACKEND_CLIENT_SECRET
        ? { clientSecret: env.OIDC_BACKEND_CLIENT_SECRET }
        : {}),
    },
    spaOrigins: {
      // Comma-separated dev,preview origins. First entry = redirect target;
      // whole list = CORS allowlist (credentials mode).
      backendToken: parseSpaOriginConfig(
        env.SPA_ORIGIN_BACKEND_TOKEN ??
          "http://localhost:5174,http://localhost:4174",
      ),
      cookieBff: parseSpaOriginConfig(
        env.SPA_ORIGIN_COOKIE_BFF ??
          "http://localhost:5175,http://localhost:4175",
      ),
    },
    corsOrigins: parseOrigins(
      env.DEMO_CORS_ORIGINS ?? "http://localhost:5173,http://localhost:4173",
    ),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "sid",
  };
}
