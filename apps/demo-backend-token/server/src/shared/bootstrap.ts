// Nest bootstrap helper for this demo app's server process.
//
// Each auth-mode demo (PKCE, backend-token, cookie-bff) is now a
// self-contained app with its OWN server process — the library's
// `OrpcWsModule` is single-instance per app, so one mode = one server
// package = one `OrpcWsModule.forRootAsync` call in one process. This
// helper centralizes everything the entry shares regardless of mode —
// Express instance, log level, shutdown hooks, CORS, host/port binding —
// so `main.ts` stays a one-liner that names its module + port + CORS
// policy. (Copied verbatim into each app's server; intentional cross-app
// DRY violation — a single source within an app, no shared demo package.)
//
// CORS notes:
// - PKCE mode allows the SPA origins for the upload HTTP transport's CORS
//   preflight (the WS upgrade itself isn't subject to CORS). `credentials`
//   is false there — the upload carries a Bearer header, not a cookie.
// - cookie-bff + backend-token set `credentials: true` so the browser
//   sends/receives the httpOnly session cookie on the /auth/* fetches.
//   With credentials, the origin MUST be an explicit allowlist (never `*`).

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
  /**
   * Whether CORS allows credentials (cookies). True for the cookie-based
   * modes (cookie-bff, backend-token), false for PKCE (Bearer-only upload).
   */
  credentials: boolean;
  /**
   * HTTP methods allowed by CORS. Defaults to the cookie modes' needs
   * (GET/POST/OPTIONS); PKCE overrides to its original `POST, OPTIONS`.
   */
  methods?: string[];
  /** Human label for the boot log line (e.g. "pkce"). */
  modeLabel: string;
}

/**
 * Boot a Nest app for this app's auth mode. Centralizes what every
 * mode's `main.ts` shares — Express adapter, debug-level logging,
 * shutdown hooks, env-driven host, CORS — just parameterized by mode.
 */
export async function bootstrap(
  // The Nest root module class for this mode.
  appModule: Type<unknown>,
  opts: BootstrapOptions,
): Promise<void> {
  const logger = new Logger("Bootstrap");

  // Explicit Express instance so the cookie-based controllers can use
  // express `Request`/`Response` for cookie + redirect handling, and so we
  // keep the option of mounting future HTTP middleware without changing
  // Nest's factory call.
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
  // calls `dispose()` and clients see a TCP RST instead of a clean 4009
  // close. (Documented gotcha in
  // packages/orpc-ws-server-nestjs/README.md "Common gotchas".)
  app.enableShutdownHooks();

  // Allow the cross-origin SPA to reach this server. Must run before
  // `app.listen(...)` so the cors middleware is registered ahead of the
  // adapter's routes and short-circuits the `OPTIONS` preflight. For the
  // upload transport (PKCE), the preflight carries no `Authorization`
  // header — without CORS answering it, the upload handler's `verifyClient`
  // would 401 the preflight and the real POST would never go out.
  app.enableCors({
    origin: opts.corsOrigins,
    methods: opts.methods ?? ["GET", "POST", "OPTIONS"],
    credentials: opts.credentials,
  });

  // Bind host is env-driven: loopback by default (the demo is a local-dev /
  // CI fixture, not a network service), but containers set `HOST=0.0.0.0`
  // so the port is reachable from outside the container.
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen(opts.port, host);
  logger.log(`${opts.modeLabel} demo server bound on ${host}:${opts.port}`);
  logger.log(`WS endpoint: ws://localhost:${opts.port}/ws`);
}
