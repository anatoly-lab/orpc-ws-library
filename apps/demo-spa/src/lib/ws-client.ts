// Singleton orpc-ws client. Created once at module load; React
// components share it via direct import. The `tokenProvider` is the
// one exposed by `@repo/oidc-pkce` — structurally compatible
// with `@repo/orpc-ws-client`'s seam (CLAUDE.md "Auth flow contract").

import type { AppContract } from "@demo/contract";
import { consoleLogger, createOrpcWsClient } from "@repo/orpc-ws-client";

import { authClient } from "./auth.js";
import { config } from "./config.js";

// Console bridge so the library's events are visible in devtools. In
// production an SPA would swap this for a real telemetry sink (Sentry,
// Datadog Browser, etc.); for the demo, raw console is enough.
export const wsClient = createOrpcWsClient<AppContract>({
  url: config.WS_URL,
  tokenProvider: authClient.tokenProvider,
  onTerminalAuthFailure: () => authClient.clearTokens(),
  onEvent: (e) => console.log("[orpc-ws event]", e),
  logger: consoleLogger("orpc-ws"),
});
