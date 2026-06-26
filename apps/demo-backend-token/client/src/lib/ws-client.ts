// Singleton orpc-ws client for the backend-token auth mode. Created once at
// module load; React components share it via direct import.
//
// LIBRARY IMPORT CONSTRAINT (the whole point of this demo): this file imports
// ONLY `@orpc-ws/client` — no auth-core coupling at all. The `tokenProvider`
// is the app's own custom implementation (`createBackendTokenProvider`),
// proving a consumer can plug any token source into the library's seam without
// pulling in any auth package.

import { consoleLogger, createOrpcWsClient } from "@orpc-ws/client";

import type { AppContract } from "@demo/backend-token-contract";
import { config } from "./config.js";
import { createBackendTokenProvider } from "./backend-token-provider.js";

// Module-level singletons. `tokenProvider` is exported so `auth.ts` can call
// its app-only `bootstrap()` and so the library can pull tokens via the seam.
export const tokenProvider = createBackendTokenProvider(config.SERVER_ORIGIN);

export const wsClient = createOrpcWsClient<AppContract>({
  url: config.WS_URL,
  tokenProvider,
  // Terminal auth failure: the library has given up (refresh returned null, or
  // the storm guard tripped). It has ALREADY closed the WS and gone terminal
  // before this fires — our job is only app-level cleanup. There is no local
  // token store to clear (the provider's in-memory token dies with the page),
  // so we just bounce the user back through the server's login flow. NOTE this
  // is the library's teardown hook, NOT something the pure `refresh()` does.
  onTerminalAuthFailure: () => {
    window.location.href = `${config.SERVER_ORIGIN}/auth/login`;
  },
  // Console bridge so the library's events are visible in devtools. In
  // production an SPA would swap this for a real telemetry sink (Sentry,
  // Datadog Browser, etc.); for the demo, raw console is enough.
  onEvent: (e) => console.log("[orpc-ws event]", e),
  logger: consoleLogger("orpc-ws"),
  // Opt-in HTTP uploads transport. The backend-token server enables /upload, so
  // this demo includes an image-upload UI. The same `tokenProvider` above is
  // reused for the Bearer header automatically — no extra auth wiring here.
  uploads: { strategy: "orpc-http", httpUrl: `${config.SERVER_ORIGIN}/upload` },
});
