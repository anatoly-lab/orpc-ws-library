// Runtime config the SPA reads from `window.__APP_CONFIG__`.
//
// The demo server injects this at index.html serve time. We do NOT use
// Vite env vars (`import.meta.env`) because that bakes config into the
// bundle — the whole point of the runtime-config seam is "build once,
// deploy to many IdPs / endpoints".
//
// The names here describe the *protocol contract* the SPA consumes
// (OIDC issuer URL, OIDC client ID), NOT the deployment specifics. The
// server's env vars can keep their IdP-shaped names (`KEYCLOAK_URL`,
// `KEYCLOAK_REALM`, etc.) — the server derives the SPA's `OIDC_*`
// shape from them. That boundary lets the SPA stay generic-OIDC while
// the deployment surface stays human-friendly for operators.

export interface AppConfig {
  /** OIDC issuer URL — passed verbatim to `@repo/oidc-pkce`'s `createOidcAuth`. */
  OIDC_ISSUER_URL: string;
  /** OIDC client ID (the public SPA client registered with the IdP). */
  OIDC_CLIENT_ID: string;
  /** WebSocket endpoint URL for the ORPC client. */
  WS_URL: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

function readConfig(): AppConfig {
  const cfg = window.__APP_CONFIG__;
  if (!cfg) {
    // Fallback for `vite dev` standalone (no server-side substitution).
    // The placeholder in index.html stays as a literal `{{...}}` and
    // never gets parsed; without a fallback the app would crash on import.
    return {
      OIDC_ISSUER_URL: "http://localhost:18080/realms/orpc-ws-demo",
      OIDC_CLIENT_ID: "orpc-ws-demo-spa",
      WS_URL: `ws://${window.location.host}/ws`,
    };
  }
  return cfg;
}

export const config: AppConfig = readConfig();
