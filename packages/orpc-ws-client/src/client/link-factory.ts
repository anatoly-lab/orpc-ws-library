// LinkFactory.
//
// Phase 1.4 lift from `apps/web/src/lib/websocket/client/link-factory.ts`.
//
// Differences from the source (de-app-ification):
//   1. No module-level singleton — class export. The composition root
//      (Phase 1.7 `createOrpcWsClient`) instantiates it; tests construct
//      their own. (See CLAUDE.md "No god files" / "Dependency inversion".)
//   2. `console.log` paths are gone; the class accepts an optional `Logger`
//      seam (CLAUDE.md "Zero console.log"). All log lines are debug-level —
//      the link factory is a hot path and never warns/errors on its own.
//   3. `RPCLink<Record<string, never>>` is preserved verbatim from the
//      source. The library doesn't currently surface ORPC client-context
//      typing; if/when the composition root grows a context generic, it
//      can be added here without breaking callers.
//
// IMPORTANT — partysocket wrapper indirection (preserved verbatim from the
// source comment block and CLAUDE.md design §2.1):
//
// We pass the partysocket wrapper directly to `RPCLink`, NOT the underlying
// native `WebSocket`. This is critical because:
//   1. partysocket's `send()` routes to its current internal `_ws`.
//   2. When partysocket reconnects internally (handshake hiccup, idle drop,
//      etc.) it constructs a NEW native `_ws` without notifying the holder.
//   3. If we extracted `_ws` directly, `RPCLink` would hold a stale
//      reference after every internal reconnect, and the next `link.call`
//      would write into a closed socket (silent message loss).
//   4. By handing partysocket itself to `RPCLink`, the wrapper transparently
//      routes through whatever `_ws` it currently owns — no observation
//      needed on our end.
//
// The link is invalidated explicitly via `clearLink()` when the WHOLE
// wrapper is being replaced (token refresh creates a brand-new
// `ReconnectingWebSocket`), but NOT on partysocket-internal reconnects.
// That's the whole point of the wrapper indirection.

import type { RPCLink } from "@orpc/client/websocket";
import { RPCLink as RPCLinkCtor } from "@orpc/client/websocket";
import type ReconnectingWebSocket from "partysocket/ws";
import { type Logger, noopLogger } from "@orpc-ws/shared";

/**
 * Manages lazy initialization of `RPCLink` with the current WebSocket
 * instance. Single responsibility: own the cache lifecycle (create-on-demand,
 * reuse, explicit invalidation).
 *
 * The link is package-internal — `OrpcWsClient` (Phase 1.7) exposes ONLY
 * the typed proxy returned by `createOrpcClientProxy`. The factory itself
 * is held by composition-root internals (heartbeat-subscriber needs
 * `link.call(["__orpc_ws_lib__","heartbeat"], …)` directly per Phase 1.5,
 * and TokenRefreshHandler's `linkClearer` callback wires to
 * `factory.clearLink()`).
 */
export class LinkFactory {
  private linkInstance: RPCLink<Record<string, never>> | null = null;
  private readonly getWebSocket: () => ReconnectingWebSocket | null;
  private readonly logger: Logger;

  /**
   * @param getWebSocket  Resolves the CURRENT partysocket wrapper from the
   *                       holder. Called lazily on the first `getLink()` —
   *                       NOT at construction — so the factory can be built
   *                       before any WS exists.
   * @param logger         Optional structured logger; defaults to noop.
   */
  constructor(
    getWebSocket: () => ReconnectingWebSocket | null,
    logger?: Logger,
  ) {
    this.getWebSocket = getWebSocket;
    this.logger = logger ?? noopLogger;
  }

  /**
   * Return the cached `RPCLink`, or build one against the current
   * WebSocket if none is cached.
   *
   * Throws if:
   *   - no WebSocket has been set on the holder (composition wiring error);
   *   - the WebSocket is not in `OPEN` state (caller attempted an RPC
   *     before the open handshake — typically a race in consumer code).
   *
   * The error messages are verbatim from the source so app-level callers
   * grepping logs see the same strings after the lift.
   */
  getLink(): RPCLink<Record<string, never>> {
    if (this.linkInstance) {
      return this.linkInstance;
    }

    const ws = this.getWebSocket();
    if (!ws) {
      throw new Error(
        "[LinkFactory] Cannot create link: WebSocket not initialized",
      );
    }
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("[LinkFactory] WebSocket not ready");
    }

    // Pass the partysocket wrapper, NOT ws._ws (the native socket).
    // See file-header note for the full rationale; this is the load-bearing
    // line for partysocket-internal-reconnect transparency.
    //
    // The `RPCLink` constructor types `websocket` as the structural subset
    // `Pick<WebSocket, "addEventListener" | "send" | "readyState">`, and the
    // partysocket wrapper fulfills that surface. We cast through `unknown`
    // because partysocket's published types don't formally implement the
    // browser `WebSocket` interface even though they expose the same shape.
    this.linkInstance = new RPCLinkCtor({
      websocket: ws as unknown as WebSocket,
    });
    this.logger.debug("link-factory: RPCLink created");
    return this.linkInstance;
  }

  /**
   * Invalidate the cached link. Called by TokenRefreshHandler (via the
   * `linkClearer` callback wired in Phase 1.7) right before it swaps in a
   * new `ReconnectingWebSocket`, so the next `getLink()` builds a fresh
   * link against the new wrapper.
   *
   * Does NOT close the old link — the wrapper it pointed at is being
   * closed by the swap flow itself.
   */
  clearLink(): void {
    if (this.linkInstance) {
      this.logger.debug("link-factory: link cleared");
    }
    this.linkInstance = null;
  }

  /**
   * For tests: whether a link is currently cached. Not part of the public
   * `OrpcWsClient` surface — kept here for the regression suite (lazy
   * creation + clearLink invalidation tests).
   */
  hasLink(): boolean {
    return this.linkInstance !== null;
  }
}
