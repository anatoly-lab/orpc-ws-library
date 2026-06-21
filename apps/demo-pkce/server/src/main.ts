// PKCE-mode entry for this self-contained demo app's server. The SPA
// performs the OIDC/PKCE dance and forwards its access token via `?token=`;
// this server verifies it and hosts the ORPC-over-WS endpoint on `/ws` plus
// the opt-in `/upload` HTTP transport.
//
// CORS: PKCE allows the SPA upload preflight (Bearer-authed POST), so
// `credentials` is false and methods are limited to POST/OPTIONS — matching
// the original main.ts. Origins come from `DEMO_CORS_ORIGINS`.

import { PkceAppModule } from "./auth/pkce.app-module.js";
import { readEnvConfig } from "./config.js";
import { bootstrap } from "./shared/bootstrap.js";

const { port, corsOrigins } = readEnvConfig();

void bootstrap(PkceAppModule, {
  port,
  corsOrigins,
  credentials: false,
  // Preserve the original PKCE CORS surface (upload preflight only).
  methods: ["POST", "OPTIONS"],
  modeLabel: "pkce",
});
