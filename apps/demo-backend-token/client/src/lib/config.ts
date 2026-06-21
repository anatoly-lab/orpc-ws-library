// Demo SPA build-time config.
//
// Vite inlines `import.meta.env.VITE_*` at build time — these become
// literal strings in the bundle. To re-target a different server origin
// or WS endpoint, change `.env` (or the build's env vars) and rebuild.
//
// This is the demo's stance, not the library's. A real consumer can
// still choose runtime config injection (server-rendered index.html
// template, /config.json fetched before bootstrap, etc.) — the
// library's WS client accepts the values as plain options and doesn't
// care where they come from. The demo picks the simpler per-process
// build because it pairs with a real `vite preview` process in the e2e
// harness.
//
// Backend-token mode: there is NO OIDC config in the browser. The IdP
// dance lives entirely on the server (which holds the refresh token);
// the SPA only needs to know where the WS lives and where the server's
// auth HTTP endpoints are.

export interface AppConfig {
  /** WebSocket endpoint URL for the ORPC client. */
  WS_URL: string;
  /**
   * Origin of the demo server's auth HTTP endpoints
   * (/auth/login, /auth/token, /auth/refresh, /auth/logout). The
   * httpOnly `sid` cookie set on /auth/callback authenticates the
   * token/refresh POSTs (sent with `credentials:"include"`).
   */
  SERVER_ORIGIN: string;
}

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    // Fail loudly at module load — a build with missing env produces a
    // bundle that throws before any UI renders. Far better than a
    // silent fallback that mis-targets the wrong server / endpoint.
    throw new Error(
      `${name} is required (set it in apps/demo-backend-token/.env or the build environment). See .env.example.`,
    );
  }
  return value;
}

export const config: AppConfig = {
  WS_URL: requireEnv("VITE_WS_URL", import.meta.env.VITE_WS_URL),
  SERVER_ORIGIN: requireEnv(
    "VITE_SERVER_ORIGIN",
    import.meta.env.VITE_SERVER_ORIGIN,
  ),
};
