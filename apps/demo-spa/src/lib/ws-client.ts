// Singleton orpc-ws client. Created once at module load; React
// components share it via direct import. The `tokenProvider` is the
// one exposed by `@repo/oidc-pkce` — structurally compatible
// with `@repo/orpc-ws-client`'s seam (CLAUDE.md "Auth flow contract").

import type { AppContract } from "@demo/contract";
import { createOrpcWsClient } from "@repo/orpc-ws-client";

import { authClient } from "./auth.js";
import { config } from "./config.js";

export const wsClient = createOrpcWsClient<AppContract>({
  url: config.WS_URL,
  tokenProvider: authClient.tokenProvider,
  onTerminalAuthFailure: () => authClient.clearTokens(),
  onEvent: (e) => console.log("[orpc-ws event]", e),
});
