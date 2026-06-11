// Demo server env-config shape. Single source of truth — both
// `main.ts` (bootstrap) and `app.module.ts` (the OIDC verifier
// factory) read from `readEnvConfig()`.
//
// Defaults match the dev/Playwright Keycloak realm under
// `tests-e2e/setup/keycloak/`. Overriding `OIDC_ISSUER_URL`,
// `OIDC_CLIENT_ID`, or `PORT` swaps in a different IdP / port without
// code changes.

export interface OidcAuthConfig {
  /** OIDC issuer URL — the same one the SPA's `@repo/oidc-pkce` uses. */
  issuerUrl: string;
  /**
   * OPTIONAL internal base URL the SERVER fetches discovery + JWKS from,
   * for split-host deployments (containers): the browser + token `iss`
   * use the public `issuerUrl`, while this server reaches the IdP over
   * the docker network at e.g. `http://keycloak:8080/realms/<realm>`.
   * Undefined ⇒ verifier defaults to `issuerUrl` (local-dev unchanged).
   */
  discoveryUrl?: string;
  /** Expected client-bound claim — the SPA's OIDC client ID. */
  clientId: string;
}

export interface AppEnvConfig {
  port: number;
  oidc: OidcAuthConfig;
}

/**
 * Read `AppEnvConfig` from a process-env-shaped object. Defaults to
 * `process.env`; tests can pass a fixture object.
 *
 * NOTE: this is APP code, not library code. The CLAUDE.md "Zero
 * `process.env` reads inside library code" rule applies to the packages
 * under `packages/`, not to the demo composition root.
 */
export function readEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppEnvConfig {
  const port = Number(env.PORT ?? 18081);
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
      clientId: env.OIDC_CLIENT_ID ?? "orpc-ws-demo-spa",
    },
  };
}
