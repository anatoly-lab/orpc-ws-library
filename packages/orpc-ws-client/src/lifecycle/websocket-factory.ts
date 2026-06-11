// WebSocket factory.
//
// Phase 1.2 lift from `apps/web/src/lib/websocket/lifecycle/websocket-factory.ts`.
// Differences from the source:
//   1. No module-level singleton. Class export; the composition root
//      (Phase 1.7) instantiates it; tests construct their own.
//      (CLAUDE.md "No god files" / implementation-plan.md §"Phase 1 — Discipline".)
//   2. `console.error` in the close-handler wrapper → injected `Logger`.
//      (CLAUDE.md "Zero `console.log`".)
//
// The non-obvious part — verbatim from source, do NOT optimize:
//   We assign handlers via PROPERTY (ws.onopen = ..., ws.onclose = ...)
//   not via addEventListener. partysocket@1.1.19's addEventListener path
//   runs cloneEventBrowser, which mangles CloseEvent into a shape with
//   `code: "close"` (string). The property path delivers the ORIGINAL
//   event with the real numeric code. See event-normalizer.ts for the
//   full bug explanation.
//
// For onclose specifically, we closure-bind the wrapper. With property
// handlers, `event.target` is the NATIVE WebSocket — NOT the partysocket
// wrapper — so it can't be used to detect a stale (previously-replaced)
// wrapper. The factory closes over `ws` and passes it explicitly as the
// second arg to the handler; the stale-WS guard (Bug 9) compares it to
// the holder's current wrapper.

import ReconnectingWebSocket from "partysocket/ws";

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type {
  ReconnectConfig,
  UrlProvider,
  WebSocketEventHandlers,
} from "./types.js";

interface WebSocketFactoryOptions {
  logger?: Logger;
}

/**
 * Creates configured `ReconnectingWebSocket` instances with event handlers
 * attached via property assignment (NOT addEventListener — see file header).
 *
 * Stateless: a single instance can produce any number of sockets. The
 * composition root holds one; tests can construct their own.
 */
export class WebSocketFactory {
  private readonly logger: Logger;

  constructor(options: WebSocketFactoryOptions = {}) {
    this.logger = options.logger ?? noopLogger;
  }

  create(
    urlProvider: UrlProvider,
    handlers: WebSocketEventHandlers,
    config: ReconnectConfig,
  ): ReconnectingWebSocket {
    const ws = new ReconnectingWebSocket(urlProvider, [], {
      maxRetries: config.maxRetries,
      maxReconnectionDelay: config.maxReconnectionDelay,
      minReconnectionDelay: config.minReconnectionDelay,
      reconnectionDelayGrowFactor: config.reconnectionDelayGrowFactor,
      connectionTimeout: config.connectionTimeout,
      maxEnqueuedMessages: config.maxEnqueuedMessages,
    });

    // === Property-assigned handlers (deliberate; see file header). ===
    //
    // ws.onopen / ws.onclose / ws.onerror receive the ORIGINAL events.
    // ws.addEventListener("close", ...) would receive a cloned event with
    // a mangled `code`. Do NOT swap these for addEventListener calls
    // without re-reading event-normalizer.ts and the source-app comment.
    ws.onopen = (event) => {
      // Closure-bind `ws` for the same reason as onclose below: the
      // stale-WS guard in onOpen (Bug 6/17) needs the partysocket wrapper
      // identity, and property-assigned handlers only expose the NATIVE
      // WebSocket on event.target.
      handlers.onOpen(event, ws);
    };
    ws.onclose = (event) => {
      // Closure-bind `ws` so the handler can identify which wrapper it
      // was attached to. The wrapper-equality check in onClose (Bug 9)
      // can't use event.target because property-assigned handlers see
      // the NATIVE WebSocket on event.target, not the partysocket wrapper.
      const result = handlers.onClose(event, ws);
      if (result instanceof Promise) {
        result.catch((err) => {
          // A throwing close-handler must not crash partysocket's
          // reconnect loop; surface to logger and continue.
          this.logger.error("websocket-factory: onClose handler threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };
    ws.onerror = (event) => {
      handlers.onError(event);
    };

    return ws;
  }
}
