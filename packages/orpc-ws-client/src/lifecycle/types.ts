// Lifecycle module shared types.
//
// Phase 1.2 lift from `apps/web/src/lib/websocket/types.ts`. We pull only the
// shapes the lifecycle module owns or directly consumes:
//   - UrlProvider:           used by the factory; the function form is
//                            re-invoked on each partysocket reconnect so the
//                            URL can carry a fresh token (Bug 1 mitigation).
//   - WebSocketEventHandlers: the contract between the factory and the
//                             EventHandlers orchestrator.
//
// Phase 1.7 unification: the Phase 1.2 placeholder `ReconnectConfig` is
// removed. The factory now consumes the UNIFIED `ReconnectConfig` from
// `config/reconnect-config.ts` — same shape as ReconnectManager reads;
// the factory simply only touches the partysocket-facing fields. One
// source of truth across the library.

import type ReconnectingWebSocket from "partysocket/ws";

export type { ReconnectConfig } from "../config/reconnect-config.js";

/**
 * URL provider for WebSocket connections.
 *
 * Static string for trivial cases; a function (sync or async) for the live
 * app, so each partysocket reconnect re-reads the current token from
 * storage. This is the seam Bug 1 (stale-token-after-sleep) is fixed at.
 */
export type UrlProvider =
  | string
  | (() => string)
  | (() => Promise<string>);

/**
 * WebSocket event handlers contract.
 *
 * `onClose` receives the wrapper it was attached to as a second argument.
 * Property-assigned `onclose` handlers see the NATIVE WebSocket on
 * `event.target`, not the partysocket wrapper, so we can't use event.target
 * to detect a stale (previously-replaced) wrapper. The factory closure-binds
 * the wrapper when attaching the handler so onClose can compare it to the
 * holder's current wrapper (Bug 9 stale-WS guard).
 *
 * Handlers receive `unknown` raw events; the event-normalizer (the D3
 * anti-corruption layer) is responsible for turning them into a stable
 * `NormalizedXxxEvent` shape before the orchestration logic runs. Typing the
 * raw events here would lie about what partysocket actually delivers (see
 * the `cloneEventBrowser` bug documented in `event-normalizer.ts`).
 */
export interface WebSocketEventHandlers {
  onOpen: (event: unknown) => void;
  onClose: (
    event: unknown,
    wrapper: ReconnectingWebSocket,
  ) => void | Promise<void>;
  onError: (event: unknown) => void;
}
