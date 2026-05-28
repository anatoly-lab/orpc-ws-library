// Demo server entry. Same Node process serves:
//   - the built SPA on `/` (`spa-static.middleware`)
//   - the ORPC-over-WS endpoint on `/ws` (`OrpcWsModule`)
//
// Single-process layout is intentional — no CORS to configure, no
// second dev server to babysit, no port juggling for Playwright. The
// SPA's static bundle gets `window.__APP_CONFIG__` substituted in at
// request time so we can flip Keycloak URLs without rebuilding.

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AppModule } from "./app.module.js";
import { readEnvConfig } from "./config.js";
import {
  spaStaticMiddleware,
  type SpaRuntimeConfig,
} from "./spa-static.middleware.js";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Bootstrap");

  // Use an explicit Express instance so we can mount middleware
  // pre-Nest. Nest 11's default factory accepts a server arg.
  const server = express();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
  );

  // Critical: `enableShutdownHooks()` is what makes
  // `BeforeApplicationShutdown` fire — without this the OrpcWsService
  // never calls `dispose()` and clients see a TCP RST instead of a
  // clean 4009 close. (Documented gotcha in
  // packages/orpc-ws-server-nestjs/README.md "Common gotchas".)
  app.enableShutdownHooks();

  // Single source of truth for env reads. `app.module.ts` calls the
  // same helper inside its OIDC verify-client useFactory — both sides
  // see identical defaults.
  const { port, oidc, wsUrl } = readEnvConfig();

  const runtimeConfig: SpaRuntimeConfig = {
    OIDC_ISSUER_URL: oidc.issuerUrl,
    OIDC_CLIENT_ID: oidc.clientId,
    WS_URL: wsUrl,
  };

  // Resolve the SPA `dist/` relative to this compiled file. After
  // `tsc`, `main.js` lives at `apps/demo-server/dist/main.js`, so the
  // SPA dist is `../../demo-spa/dist`.
  const here = dirname(fileURLToPath(import.meta.url));
  const spaDist =
    process.env.SPA_DIST ?? join(here, "../../demo-spa/dist");

  app.use(
    spaStaticMiddleware({
      dir: spaDist,
      runtimeConfig,
    }),
  );

  await app.listen(port);
  logger.log(`demo-server listening on http://localhost:${port}`);
  logger.log(`SPA bundle: ${spaDist}`);
  logger.log(`OIDC: issuer=${oidc.issuerUrl}, client=${oidc.clientId}`);
}

void bootstrap();
