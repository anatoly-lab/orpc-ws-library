// authless-mode entry. No IdP, no token, no cookie — the library module is
// registered with `mode: "authless"` (see app-module.ts) and every WS
// upgrade is accepted.
//
// CORS: credentials:false (there is no cookie/Bearer to carry). The origins
// allowed = this mode's SPA dev + preview origins (`SPA_ORIGIN_AUTHLESS`,
// comma-separated).

import { AppModule } from "./app-module.js";
import { readEnvConfig } from "./config.js";
import { bootstrap } from "./shared/bootstrap.js";

const { port, corsOrigins } = readEnvConfig();

void bootstrap(AppModule, {
  port,
  corsOrigins,
  modeLabel: "authless",
});
