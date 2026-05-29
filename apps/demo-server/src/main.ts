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
// No CORS middleware: the only HTTP surface is the `/ws` WebSocket
// upgrade endpoint, and WS upgrades are not subject to CORS (browsers
// gate them via `Origin` checks at the server's discretion, not via
// preflight). If/when this demo grows an `uploads:` config, CORS will
// need to be added then.

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

  const { port, oidc } = readEnvConfig();

  // Bind to loopback only. The demo is a local-dev / CI fixture, not
  // a network service — exposing `/ws` on every interface (LAN, VPN)
  // serves no purpose and broadens the trust surface.
  await app.listen(port, "127.0.0.1");
  logger.log(`demo-server listening on http://localhost:${port}`);
  logger.log(`WS endpoint: ws://localhost:${port}/ws`);
  logger.log(`OIDC: issuer=${oidc.issuerUrl}, client=${oidc.clientId}`);
}

void bootstrap();
