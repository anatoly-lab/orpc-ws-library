// Singleton orpc-ws client for the cookie-BFF auth mode. Created once at module
// load; React components share it via direct import.
//
// LIBRARY IMPORT CONSTRAINT (the whole point of this demo): this file imports
// ONLY `@orpc-ws/client` — no auth-core coupling at all.
//
// NO `tokenProvider` ON PURPOSE — this is the cookie auth path. The browser
// holds no token; the httpOnly `sid` cookie set by the server's /auth/callback
// is sent AUTOMATICALLY by the browser on the WS handshake (same-site cookie on
// the `ws://` upgrade request), so the server authenticates the connection from
// the cookie alone. Omitting `tokenProvider` is exactly how the library
// supports cookie auth: with no provider, the WS URL carries no `?token=` and
// the library never tries to refresh (see CLAUDE.md "Token transport" +
// "Cookie-auth caveat"). There is therefore no `onTerminalAuthFailure` here
// either — without a `tokenProvider` there is no library-driven refresh/terminal
// path to hook; session loss is surfaced by the server closing the WS, and the
// app re-checks /auth/me on the next load.

import { consoleLogger, createOrpcWsClient } from "@orpc-ws/client";

import type { AppContract } from "@demo/cookie-bff-contract";
import { config } from "./config.js";

export const wsClient = createOrpcWsClient<AppContract>({
  url: config.WS_URL,
  // Console bridge so the library's events are visible in devtools. In
  // production an SPA would swap this for a real telemetry sink (Sentry,
  // Datadog Browser, etc.); for the demo, raw console is enough.
  onEvent: (e) => console.log("[orpc-ws event]", e),
  logger: consoleLogger("orpc-ws"),
  // No `uploads` config: the cookie-bff demo server has no upload route, so the
  // upload UI is omitted from Home too.
});
