// PKCE demo-app server env-config. Single source of truth — the main entry +
// app-module read from `readEnvConfig()`.
//
// This is the PKCE auth-mode server: the SPA performs the OIDC/PKCE dance
// and forwards its access token via `?token=`; this server verifies it and
// hosts the ORPC-over-WS endpoint on `/ws` plus the opt-in `/upload` HTTP
// transport (port 18081).
//
// Defaults match the dev/Playwright Keycloak realm. Overriding the env
// vars below swaps in a different IdP / port / origins without code changes.
//
// NOTE: this is APP code, not library code. The CLAUDE.md "Zero
// `process.env` reads inside library code" rule applies to the packages
// under `packages/`, not to the demo composition root.

/**
 * Nest DI token for the resolved `AppEnvConfig`. Kept for parity with the
 * cookie-based modes' app-modules even though PKCE wires no config provider
 * today — leaving it in place makes a future `ConfigService` swap drop-in.
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
   * client ID. The token is minted for the SPA's public client and this
   * server validates it against this.
   */
  clientId: string;
}

export interface AppEnvConfig {
  /** Listen port for this server. */
  port: number;
  oidc: OidcAuthConfig;
  /** CORS origins (the upload preflight; comma-separated env). */
  corsOrigins: string[];
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
 * Read `AppEnvConfig` from a process-env-shaped object. Defaults to
 * `process.env`; tests can pass a fixture object.
 */
export function readEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppEnvConfig {
  const clientId = env.OIDC_CLIENT_ID ?? "orpc-ws-demo-spa";

  return {
    port: Number(env.PORT ?? 18081),
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
    corsOrigins: parseOrigins(
      env.DEMO_CORS_ORIGINS ?? "http://localhost:5173,http://localhost:4173",
    ),
  };
}
