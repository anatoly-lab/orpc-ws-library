// Nest bootstrap helper for this demo app's server process.
//
// Each demo (PKCE, backend-token, cookie-bff, authless) is a self-contained
// app with its OWN server process — the library's `OrpcWsModule` is
// single-instance per app, so one mode = one server package = one
// `OrpcWsModule.forRootAsync` call in one process. This helper centralizes
// everything the entry shares regardless of mode — Express instance, log
// level, shutdown hooks, CORS, host/port binding — so `main.ts` stays a
// one-liner. (Copied into each app's server; intentional cross-app DRY
// violation — a single source within an app, no shared demo package.)
//
// AUTHLESS notes: there is no token, no cookie, and no upload transport, so
// CORS is `credentials: false` and exists only so the cross-origin SPA's
// (currently just /health) HTTP preflights succeed. The WS upgrade itself is
// not subject to CORS.

import "reflect-metadata";
import { Logger, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import express from "express";

export interface BootstrapOptions {
  /** Listen port for this mode. */
  port: number;
  /** Allowed CORS origins (the SPA(s) this mode serves). */
  corsOrigins: string[];
  /** Human label for the boot log line (e.g. "authless"). */
  modeLabel: string;
}

/**
 * Boot a Nest app for this app. Centralizes what every demo's `main.ts`
 * shares — Express adapter, debug-level logging, shutdown hooks, env-driven
 * host, CORS.
 */
export async function bootstrap(
  // The Nest root module class.
  appModule: Type<unknown>,
  opts: BootstrapOptions,
): Promise<void> {
  const logger = new Logger("Bootstrap");

  // Explicit Express instance so we keep the option of mounting future HTTP
  // middleware without changing Nest's factory call.
  const server = express();
  // Dev mode wants full visibility — including the library's `debug`-level
  // traces which Nest silences by default. A production deployment would
  // scope these down to `["error", "warn", "log"]`.
  const app = await NestFactory.create<NestExpressApplication>(
    appModule,
    new ExpressAdapter(server),
    { logger: ["error", "warn", "log", "debug", "verbose"] },
  );

  // Critical: `enableShutdownHooks()` is what makes
  // `BeforeApplicationShutdown` fire — without this the OrpcWsService never
  // calls `dispose()` and clients see a TCP RST instead of a clean close.
  // (Documented gotcha in
  // packages/orpc-ws-server-nestjs/README.md "Common gotchas".)
  app.enableShutdownHooks();

  // Allow the cross-origin SPA to reach this server's HTTP endpoints. No
  // credentials — authless carries no cookie and no Bearer header.
  app.enableCors({
    origin: opts.corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  });

  // Bind host is env-driven: loopback by default (the demo is a local-dev
  // fixture, not a network service), but containers set `HOST=0.0.0.0` so
  // the port is reachable from outside the container.
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen(opts.port, host);
  logger.log(`${opts.modeLabel} demo server bound on ${host}:${opts.port}`);
  logger.log(`WS endpoint: ws://localhost:${opts.port}/ws`);
}
