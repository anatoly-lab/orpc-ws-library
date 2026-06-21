// backend-token-mode entry. The server runs the OIDC flow + holds refresh
// tokens; the SPA gets short-lived access tokens it forwards over `?token=`.
//
// CORS: credentials:true (the SPA's /auth/* fetches send the httpOnly
// session cookie), origins allowed = this mode's SPA dev + preview origins
// (`SPA_ORIGIN_BACKEND_TOKEN`, comma-separated).

import { BackendTokenAppModule } from "./auth/backend-token.app-module.js";
import { readEnvConfig } from "./config.js";
import { bootstrap } from "./shared/bootstrap.js";

const { port, spaOrigins } = readEnvConfig();

void bootstrap(BackendTokenAppModule, {
  port,
  corsOrigins: spaOrigins.corsOrigins,
  credentials: true,
  modeLabel: "backend-token",
});
