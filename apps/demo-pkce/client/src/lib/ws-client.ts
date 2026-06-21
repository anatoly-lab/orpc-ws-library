// Singleton orpc-ws client. Created once at module load; React
// components share it via direct import. The `tokenProvider` is the
// one exposed by `@orpc-ws/oidc-pkce` — structurally compatible
// with `@orpc-ws/client`'s seam (CLAUDE.md "Auth flow contract").

import { consoleLogger, createOrpcWsClient } from "@orpc-ws/client";
import { createOidcAuth } from "@orpc-ws/oidc-pkce";

import type { AppContract } from "@demo/pkce-contract";
import { config } from "./config.js";

// Composition root for the demo SPA's OIDC auth.
//
// The entire PKCE / discovery / storage / refresh dance lives in
// `@orpc-ws/oidc-pkce`; this file is just the binding of runtime config
// to the library. Single module-level instance — every page imports
// the same `authClient`.
export const authClient = createOidcAuth({
  issuerUrl: config.OIDC_ISSUER_URL,
  clientId: config.OIDC_CLIENT_ID,
  redirectUri: `${window.location.origin}/auth/callback`,
  scopes: ["openid", "email", "profile"],
});

// Console bridge so the library's events are visible in devtools. In
// production an SPA would swap this for a real telemetry sink (Sentry,
// Datadog Browser, etc.); for the demo, raw console is enough.
export const wsClient = createOrpcWsClient<AppContract>({
  url: config.WS_URL,
  tokenProvider: authClient.tokenProvider,
  onTerminalAuthFailure: () => authClient.clearTokens(),
  onEvent: (e) => console.log("[orpc-ws event]", e),
  logger: consoleLogger("orpc-ws"),
  // Opt-in HTTP uploads transport. Configuring it makes `wsClient.upload`
  // present. The same `tokenProvider` above is reused for the Bearer header
  // automatically — no auth wiring needed here.
  uploads: { strategy: "orpc-http", httpUrl: config.UPLOAD_URL },
});
