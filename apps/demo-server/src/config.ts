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
      clientId: env.OIDC_CLIENT_ID ?? "orpc-ws-demo-spa",
    },
  };
}
