// Singleton orpc-ws client for the AUTHLESS demo. Created once at module
// load; React components share it via direct import.
//
// LIBRARY IMPORT CONSTRAINT (the whole point of this demo): this file imports
// ONLY `@orpc-ws/client` — no auth-core coupling at all.
//
// NO `tokenProvider` ON PURPOSE — this is the authless path. The client just
// connects to the WS URL with no `?token=`, no cookie, no Bearer header. The
// server runs in `mode: "authless"` and accepts every upgrade. Omitting
// `tokenProvider` is exactly how the library supports the no-auth case: with
// no provider, the WS URL carries no `?token=` and the library never tries to
// refresh (see CLAUDE.md "Token transport"). There is no `onTerminalAuthFailure`
// here either — without a `tokenProvider` there is no library-driven
// refresh/terminal path to hook.

import { consoleLogger, createOrpcWsClient } from "@orpc-ws/client";

import type { AppContract } from "@demo/authless-contract";
import { config } from "./config.js";

export const wsClient = createOrpcWsClient<AppContract>({
  url: config.WS_URL,
  // Console bridge so the library's events are visible in devtools. In
  // production an SPA would swap this for a real telemetry sink; for the demo,
  // raw console is enough.
  onEvent: (e) => console.log("[orpc-ws event]", e),
  logger: consoleLogger("orpc-ws"),
  // No `tokenProvider`, no `uploads` — authless carries no credential and the
  // server has no upload route.
});
