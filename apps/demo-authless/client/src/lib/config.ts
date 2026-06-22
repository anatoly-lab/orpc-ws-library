// Demo SPA build-time config.
//
// Vite inlines `import.meta.env.VITE_*` at build time — these become literal
// strings in the bundle. To re-target a different WS endpoint, change `.env`
// (or the build's env vars) and rebuild.
//
// AUTHLESS mode: the browser holds NO credential of any kind — no token, no
// cookie. So the SPA only needs to know where the WS lives, and even that is
// OPTIONAL — it defaults to the local authless server. Unlike the auth demos
// (which fail loud on missing OIDC/server-origin env to avoid mis-targeting a
// protected backend), authless has zero required config: that is the whole
// pitch ("the simplest demo to run"). There is no OIDC config, no token
// config, and no server-origin config (there are no auth HTTP endpoints).

export interface AppConfig {
  /** WebSocket endpoint URL for the ORPC client. */
  WS_URL: string;
}

// Matches the @demo/authless-server default port (18084) and `/ws` path.
const DEFAULT_WS_URL = "ws://localhost:18084/ws";

export const config: AppConfig = {
  WS_URL: import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL,
};
