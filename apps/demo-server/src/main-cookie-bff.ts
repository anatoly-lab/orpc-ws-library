// cookie-bff-mode entry. Full BFF: the server holds ALL tokens; the SPA
// only ever sees an httpOnly session cookie. The WS verify reads that
// cookie — no `?token=`.
//
// CORS: credentials:true (the cookie rides every /auth/* + WS request),
// origins allowed = this mode's SPA dev + preview origins
// (`SPA_ORIGIN_COOKIE_BFF`, comma-separated).

import { CookieBffAppModule } from "./auth/cookie-bff/cookie-bff.app-module.js";
import { readEnvConfig } from "./config.js";
import { bootstrap } from "./shared/bootstrap.js";

const { ports, spaOrigins } = readEnvConfig();

void bootstrap(CookieBffAppModule, {
  port: ports.cookieBff,
  corsOrigins: spaOrigins.cookieBff.corsOrigins,
  credentials: true,
  modeLabel: "cookie-bff",
});
