// Minimal structural socket interface the bidi multiplexer wraps.
//
// Phase 2 of server→client bidirectional RPC. The multiplexer (see
// `socket-multiplexer.ts`) lays two logical RPC channels over ONE real
// WebSocket. It must NOT depend on the DOM `lib` `WebSocket` type or the
// node `ws` types — @orpc-ws/shared is dependency-free and framework-free,
// and the same multiplexer is consumed by both the browser client core
// (where the real socket is partysocket's `ReconnectingWebSocket`) and the
// node server core (where it is a `ws` socket). So we define our OWN
// structural interface: the smallest surface the multiplexer actually uses.
//
// WHY this exact shape — it covers what BOTH ORPC adapters actually touch:
//   - `@orpc/client/websocket` `LinkWebsocketClient` accepts
//     `Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'send'
//     | 'readyState'>` and reads `event.data` off a `'message'` event,
//     listens to `'message' | 'close' | 'open'`, and reads `readyState`.
//   - `@orpc/server/ws` `WsHandler.upgrade` accepts
//     `Pick<WebSocket, 'addEventListener' | 'send'>`, reads `event.data`,
//     and listens to `'message' | 'close'`.
// `UnderlyingSocket` covers every member/event those picks use (it also adds
// `'open' | 'error'` and an optional `binaryType` setter / `close`). Both
// adapters register listeners DOM-style (`addEventListener(type, fn)`), never
// node-style `.on(...)`, which is why this interface models only the DOM event
// API.
//
// NOT structurally assignable to `Pick<WebSocket, …>` — a single boundary cast
// is REQUIRED at each ORPC wiring site (later phases:
// `new LinkWebsocketClient({ websocket })`, `WsHandler.upgrade(ws)`), written
// `channeledSocket as unknown as Pick<WebSocket, …>`. Two deliberate narrowings
// make that cast necessary: `SocketEvent` does NOT model the full DOM/`ws`
// `Event` (no `bubbles` / `type` / `target` / `code` / `reason`), and
// `addEventListener` is narrowed to our four-event union. The cast is sound
// because @orpc-ws/shared is intentionally dependency-free (no DOM lib) and
// ORPC only ever READS `event.data` at runtime — which the multiplexer
// provides on every dispatched `'message'` event.

import type { WireFrame } from "./channel.js";

/**
 * The four socket event types the multiplexer cares about.
 *
 * `message` carries data (routed per-channel); `open` / `close` / `error`
 * are connection-lifecycle events (fanned out to BOTH channels). This is a
 * strict subset of the DOM `WebSocketEventMap` keys — the ones ORPC's
 * adapters and the cores actually observe.
 */
export type SocketEventType = "message" | "open" | "close" | "error";

/**
 * Minimal inbound-event shape. ORPC's adapters read ONLY `.data` off an
 * event, and only for `'message'`; lifecycle handlers read nothing. `data`
 * is therefore optional (absent/ignored for `open` / `close` / `error`).
 *
 * Modeled as a plain object (not the DOM `Event` / `MessageEvent`) so the
 * interface needs no DOM lib. A real `MessageEvent` is assignable to it
 * (`MessageEvent.data` widens to `unknown`), and the synthetic events the
 * multiplexer dispatches are `{ data }` literals.
 */
export interface SocketEvent {
  readonly data?: unknown;
}

/** A registered event listener. One signature for every event type. */
export type SocketListener = (event: SocketEvent) => void;

/**
 * The subset of `addEventListener`'s options the multiplexer honors.
 *
 * Only `once` is modeled because it is the only one ORPC uses: the client
 * adapter registers its `open` / `close` connection-wait listeners with
 * `{ once: true }` (see `LinkWebsocketClient`'s send path). `capture` /
 * `passive` / `signal` are meaningless for a non-DOM socket.
 */
export interface AddEventListenerOptions {
  readonly once?: boolean;
}

/**
 * The real socket the multiplexer wraps — the smallest surface it needs.
 *
 * A live browser `WebSocket`, partysocket `ReconnectingWebSocket`, or node
 * `ws` socket is each structurally assignable to this interface (they all
 * expose DOM-style `addEventListener` / `removeEventListener`, `send`,
 * `readyState`, and a `binaryType` setter). `ChanneledSocket` also
 * implements it, so the per-channel facade is itself a valid "socket".
 */
export interface UnderlyingSocket {
  /** Send one frame. The multiplexer only ever passes a {@link WireFrame}. */
  send(data: WireFrame): void;

  addEventListener(
    type: SocketEventType,
    listener: SocketListener,
    options?: AddEventListenerOptions,
  ): void;

  removeEventListener(type: SocketEventType, listener: SocketListener): void;

  /** `WebSocket.readyState` numeric constants (CONNECTING=0, OPEN=1, …). */
  readonly readyState: number;

  /**
   * Binary delivery mode. Optional: not every socket exposes it, and the
   * multiplexer only WRITES it (sets `'arraybuffer'` at construction to
   * force synchronous binary frames — see `normalize-inbound.ts`).
   */
  binaryType?: string;

  /**
   * Tear down the underlying transport. Optional because ORPC's client pick
   * never calls it; the multiplexer delegates a channel `close()` here.
   */
  close?(code?: number, reason?: string): void;
}
