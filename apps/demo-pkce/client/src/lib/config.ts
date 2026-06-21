// Demo SPA build-time config.
//
// Vite inlines `import.meta.env.VITE_*` at build time — these become
// literal strings in the bundle. To re-target a different IdP or WS
// endpoint, change `.env` (or the build's env vars) and rebuild.
//
// This is the demo's stance, not the library's. A real consumer can
// still choose runtime config injection (server-rendered index.html
// template, /config.json fetched before bootstrap, etc.) — the
// library's auth + WS clients accept the values as plain options and
// don't care where they come from. The demo picks the simpler
// per-process build because it pairs with a real `vite preview`
// process in the e2e harness.
//
// The names here describe the protocol contract the SPA consumes (OIDC
// issuer URL, OIDC client ID) — NOT IdP-shaped names, because the SPA's
// `@orpc-ws/oidc-pkce` library is provider-agnostic.

export interface AppConfig {
  /** OIDC issuer URL — passed verbatim to `@orpc-ws/oidc-pkce`'s `createOidcAuth`. */
  OIDC_ISSUER_URL: string;
  /** OIDC client ID (the public SPA client registered with the IdP). */
  OIDC_CLIENT_ID: string;
  /** WebSocket endpoint URL for the ORPC client. */
  WS_URL: string;
  /** HTTP upload endpoint URL for the ORPC client's opt-in uploads transport. */
  UPLOAD_URL: string;
}

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    // Fail loudly at module load — a build with missing env produces a
    // bundle that throws before any UI renders. Far better than a
    // silent fallback that mis-targets the wrong IdP / endpoint.
    throw new Error(
      `${name} is required (set it in apps/demo-pkce/.env or the build environment). See .env.example.`,
    );
  }
  return value;
}

export const config: AppConfig = {
  OIDC_ISSUER_URL: requireEnv(
    "VITE_OIDC_ISSUER_URL",
    import.meta.env.VITE_OIDC_ISSUER_URL,
  ),
  OIDC_CLIENT_ID: requireEnv(
    "VITE_OIDC_CLIENT_ID",
    import.meta.env.VITE_OIDC_CLIENT_ID,
  ),
  WS_URL: requireEnv("VITE_WS_URL", import.meta.env.VITE_WS_URL),
  UPLOAD_URL: requireEnv("VITE_UPLOAD_URL", import.meta.env.VITE_UPLOAD_URL),
};
