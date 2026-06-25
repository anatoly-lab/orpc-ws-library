// cookie-bff demo-app server env-config. Single source of truth — `main.ts`
// and `auth/cookie-auth.module.ts` (the one `CookieBffModule.forRootAsync`
// config block) read from `readEnvConfig()`.
//
// This is the cookie-bff auth-mode server (port 18083): full BFF — the library
// (`@orpc-ws/cookie-bff-nestjs`) runs the OIDC flow, holds ALL tokens
// server-side (encrypted at rest), and the browser only ever sees an httpOnly
// session cookie. The library's cookie verifier reads that cookie on the WS
// upgrade — there is no `?token=` at all.
//
// Defaults match the dev/Playwright Keycloak realm. Overriding the env
// vars below swaps in a different IdP / port / origins without code changes.
//
// NOTE: this is APP code, not library code. The CLAUDE.md "Zero
// `process.env` reads inside library code" rule applies to the packages
// under `packages/`, not to the demo composition root.

/**
 * Nest DI token for the resolved `AppEnvConfig`. `AppEnvConfig` is an
 * interface (erased at runtime), so the controller injects it with
 * `@Inject(APP_ENV_CONFIG)` rather than by type.
 */
export const APP_ENV_CONFIG = "APP_ENV_CONFIG";

export interface OidcAuthConfig {
  /** OIDC issuer URL — the same one the IdP discovery is fetched from. */
  issuerUrl: string;
  /**
   * OPTIONAL internal base URL the SERVER fetches discovery + JWKS from,
   * for split-host deployments (containers): the browser-facing `iss`
   * uses the public `issuerUrl`, while this server reaches the IdP over
   * the docker network at e.g. `http://keycloak:8080/realms/<realm>`.
   * Undefined ⇒ verifier defaults to `issuerUrl` (local-dev unchanged).
   */
  discoveryUrl?: string;
  /**
   * The SPA's OIDC client ID. cookie-bff doesn't do a WS-token verify, but
   * the value is kept for parity / future use (e.g. an end-session hint).
   */
  clientId: string;
}

/**
 * Config for the SERVER-SIDE OIDC code exchange. The cookie-bff mode runs
 * the exchange as a PUBLIC PKCE client (no client secret).
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
   * SLOT for a confidential-client secret. This mode is deliberately a
   * PUBLIC PKCE client (no secret) — the library's server-side code-exchange
   * sends `code_verifier`, not `client_secret`. If you register a
   * CONFIDENTIAL client and set this, it's forwarded to the library via
   * `keycloak.clientSecret` (the library's code-exchange adds it to the token
   * request). Left `undefined` here so the public-client path stays the
   * default.
   */
  clientSecret?: string;
}

/**
 * SPA origin policy. The SPA runs on more than one origin (Vite dev +
 * `vite preview`), so CORS must allow the whole list, while the
 * post-`/auth/callback` 302 needs a single primary target.
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
  /** Listen port for this server. */
  port: number;
  oidc: OidcAuthConfig;
  /** Server-side code-exchange client. */
  backendOidc: BackendOidcConfig;
  /** SPA origin policy (dev + preview origins). */
  spaOrigins: SpaOriginConfig;
  /** Name of the httpOnly session cookie set by this server. */
  sessionCookieName: string;
  /**
   * The API's own callback URL the IdP redirects back to. MUST be registered
   * as a valid redirect URI in the realm. In cookie-BFF the callback is a
   * SERVER endpoint (not the SPA) — the auth code never touches JS.
   */
  callbackUrl: string;
  /**
   * 32-byte AES-256-GCM key (base64) for at-rest token encryption (§E.3).
   * The library encrypts the stored Keycloak tokens with this before they hit
   * the session store. Read from `SESSION_ENC_KEY`.
   */
  sessionEncKey: string;
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
 * Build a `SpaOriginConfig` from a comma-separated origin env var. The
 * FIRST entry is the post-login redirect target; the WHOLE list is the
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
  const clientId = env.OIDC_CLIENT_ID ?? "orpc-ws-demo-spa";
  const port = Number(env.PORT ?? 18083);

  return {
    port,
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
    // Comma-separated dev,preview origins. First entry = redirect target;
    // whole list = CORS allowlist (credentials mode).
    spaOrigins: parseSpaOriginConfig(
      env.SPA_ORIGIN_COOKIE_BFF ??
        "http://localhost:5175,http://localhost:4175",
    ),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "sid",
    // The API's own /auth/callback. Defaults to this server's loopback origin;
    // MUST match a redirect URI registered in the realm.
    callbackUrl:
      env.OIDC_REDIRECT_URI ?? `http://localhost:${port}/auth/callback`,
    // 32-byte base64 AES-256-GCM key. A FIXED dev default so the demo runs
    // out-of-the-box; a real deployment MUST set SESSION_ENC_KEY to a secret
    // (rotating it invalidates existing sessions — see the design doc §E.3).
    sessionEncKey:
      env.SESSION_ENC_KEY ??
      // 32 bytes of 0x2a, base64 — DEMO ONLY, do not use in production.
      "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
  };
}
