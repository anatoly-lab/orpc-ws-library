// Demo SPA build-time config.
//
// Vite inlines `import.meta.env.VITE_*` at build time — these become literal
// strings in the bundle. To re-target a different WS endpoint, change `.env`
// (or the build's env vars) and rebuild.
//
// AUTHLESS mode: the browser holds NO credential of any kind — no token, no
// cookie. So the SPA only needs to know where the WS lives. There is no OIDC
// config, no token config, and no server-origin config (there are no auth
// HTTP endpoints to call).

export interface AppConfig {
  /** WebSocket endpoint URL for the ORPC client. */
  WS_URL: string;
}

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    // Fail loudly at module load — a build with missing env produces a
    // bundle that throws before any UI renders. Far better than a silent
    // fallback that mis-targets the wrong server.
    throw new Error(
      `${name} is required (set it in apps/demo-authless/client/.env or the build environment). See .env.example.`,
    );
  }
  return value;
}

export const config: AppConfig = {
  WS_URL: requireEnv("VITE_WS_URL", import.meta.env.VITE_WS_URL),
};
