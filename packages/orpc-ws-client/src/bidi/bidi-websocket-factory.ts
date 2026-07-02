// `BidiWebSocketFactory` — the bidi-aware specialization of
// `WebSocketFactory` that (re)attaches the client's bidi coordinator to
// every brand-new wrapper. One concept: hooking `bidi.attach` into the
// single chokepoint where wrappers are born.

import type ReconnectingWebSocket from "partysocket/ws";
import type { Logger } from "@orpc-ws/shared";

import { WebSocketFactory } from "../lifecycle/websocket-factory.js";
import type {
  UrlProvider,
  WebSocketEventHandlers,
} from "../lifecycle/types.js";
import type { ReconnectConfig } from "../config/reconnect-config.js";
import type { ClientBidi } from "./client-bidi.js";

/**
 * Bidi-aware `WebSocketFactory`. Identical to the base factory except it
 * (re)builds the per-connection bidi mux + s2c host against each brand-new
 * wrapper it creates. `WebSocketFactory.create` is the SINGLE chokepoint every
 * new wrapper is born from (first connect + every reconnect swap), so hooking
 * `bidi.attach` here keeps ClientLifecycle / TokenRefreshHandler untouched and
 * the mux always tracking the live wrapper. Used only when bidi is on; a
 * subclass (not a plain wrapper object) because `WebSocketFactory` has private
 * fields and is therefore nominal — only a subclass is assignable to it.
 */
export class BidiWebSocketFactory extends WebSocketFactory {
  private readonly bidi: ClientBidi;

  constructor(options: { logger?: Logger }, bidi: ClientBidi) {
    super(options);
    this.bidi = bidi;
  }

  override create(
    urlProvider: UrlProvider,
    handlers: WebSocketEventHandlers,
    config: ReconnectConfig,
  ): ReconnectingWebSocket {
    const ws = super.create(urlProvider, handlers, config);
    // (Re)attach bidi to the new wrapper. See bidi/client-bidi.ts for the
    // dispose-previous (close-before-dispose) + rebuild semantics.
    this.bidi.attach(ws);
    return ws;
  }
}
