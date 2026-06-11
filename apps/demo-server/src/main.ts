// Demo server entry. This process owns ONE responsibility: host the
// ORPC-over-WS endpoint on `/ws`. The Vite SPA is a separate process
// (`apps/demo-spa`), reached on its own port — see the root README's
// "Demo" section.
//
// Why split: the previous single-process layout (server-side
// `index.html` template + express.static) entangled the server with
// SPA build artifacts and forced runtime-config injection per request.
// That gave us one fewer port to babysit in dev, but it (a) leaked
// build artifacts into the server's runtime, and (b) made the demo a
// poor reference for consumers who'll run their SPA on their own
// host/CDN. Two processes mirrors the real deployment shape.
//
// CORS is enabled for the upload HTTP transport. The WS `/ws` endpoint
// never needed it (WS upgrades aren't subject to CORS preflight), but the
// SPA (localhost:5173/4173) and this server (localhost:18081) are
// cross-origin, so the browser fires a CORS preflight `OPTIONS` before the
// upload `POST`. That preflight carries no `Authorization` header — without
// CORS short-circuiting it, the upload handler's `verifyClient` would 401
// the preflight and the real POST would never go out. `enableCors` (below)
// answers the preflight with a 204 before it reaches `verifyClient`.

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import express from "express";

import { AppModule } from "./app.module.js";
import { readEnvConfig } from "./config.js";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Bootstrap");

  // Use an explicit Express instance so we keep the option of mounting
  // future HTTP middleware (CORS, /healthz, uploads) without changing
  // Nest's factory call.
  const server = express();
  // Dev mode wants full visibility — including the library's
  // `debug`-level traces (e.g. `heartbeat-publisher: tick`) which Nest
  // silences by default. A production deployment of this same shape
  // would scope these down to `["error", "warn", "log"]`.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
    { logger: ["error", "warn", "log", "debug", "verbose"] },
  );

  // Critical: `enableShutdownHooks()` is what makes
  // `BeforeApplicationShutdown` fire — without this the OrpcWsService
  // never calls `dispose()` and clients see a TCP RST instead of a
  // clean 4009 close. (Documented gotcha in
  // packages/orpc-ws-server-nestjs/README.md "Common gotchas".)
  app.enableShutdownHooks();

  // Allow the cross-origin SPA to POST uploads (and its CORS preflight) to
  // this server. Must run before `app.listen(...)` so the cors middleware
  // is registered ahead of the adapter's upload route (mounted during
  // bootstrap) and short-circuits the `OPTIONS` preflight. See the header
  // comment for why this matters for auth.
  // Allowed origins are env-driven (`DEMO_CORS_ORIGINS`, comma-separated)
  // so a containerized SPA on a different origin can be added without a
  // code change. Defaults to the local-dev / e2e Vite ports.
  const corsOrigins = (process.env.DEMO_CORS_ORIGINS ??
    "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.enableCors({
    origin: corsOrigins,
    methods: ["POST", "OPTIONS"],
  });

  const { port, oidc } = readEnvConfig();

  // Bind host is env-driven: loopback by default (the demo is a
  // local-dev / CI fixture, not a network service — exposing `/ws` on
  // every interface serves no purpose), but containers set
  // `HOST=0.0.0.0` so the port is reachable from outside the container.
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen(port, host);
  logger.log(`demo-server bound on ${host}:${port}`);
  logger.log(`WS endpoint: ws://localhost:${port}/ws`);
  logger.log(`OIDC: issuer=${oidc.issuerUrl}, client=${oidc.clientId}`);
}

void bootstrap();
