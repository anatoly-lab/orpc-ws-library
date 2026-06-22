// authless demo-app server env-config. Single source of truth — the main
// entry and app-module read from `readEnvConfig()`.
//
// This is the AUTHLESS auth-mode server (port 18084): there is NO IdP, NO
// OIDC, NO session cookie, NO token. The only things configurable are the
// listen port and the SPA origin allowlist (so the upload-less HTTP side —
// just the /health endpoint — answers CORS preflights from the cross-origin
// SPA; the WS upgrade itself is not subject to CORS).
//
// NOTE: this is APP code, not library code. The CLAUDE.md "Zero
// `process.env` reads inside library code" rule applies to the packages
// under `packages/`, not to the demo composition root.

/**
 * SPA origin policy. The SPA runs on more than one origin (Vite dev +
 * `vite preview`), so CORS must allow the whole list. There is no
 * post-login redirect here (no auth), so — unlike the auth-mode demos —
 * we only need the allowlist, not a single redirect target.
 */
export interface AppEnvConfig {
  /** Listen port for this server. */
  port: number;
  /** CORS allowlist for this mode's SPA (dev + preview origins). */
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
  return {
    port: Number(env.PORT ?? 18084),
    corsOrigins: parseOrigins(
      env.SPA_ORIGIN_AUTHLESS ??
        "http://localhost:5176,http://localhost:4176",
    ),
  };
}
