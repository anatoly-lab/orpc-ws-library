// Event handlers — orchestration layer.
//
// Phase 1.2 lift from `apps/web/src/lib/websocket/lifecycle/event-handlers.ts`.
// MAJOR differences from the source — read these before changing anything:
//
//   1. The close-decision tree is OUT — it lives in `close-decision.ts` as
//      a pure function. This class only consumes the decision. Branches
//      that were inline if-chains (1008, 4001, 4005, pre-open 1000) are
//      now switch-cases over the discriminated union returned by decideClose.
//
//   2. The MODULE-LEVEL `lastWsAuthRefreshAttemptedAt` storm-guard timestamp
//      is GONE from this file. It belongs to `ReconnectManager` (Phase 1.3).
//      In Phase 1.2 we only emit "auth-recovery is needed" via the
//      `onAuthRecoveryNeeded(closeCode)` callback the composition root will
//      wire to the storm-guard-protected refresh path.
//
//   3. The source called `handleAuthFailure()` and `authStorage.refreshAccessToken()`
//      directly — both are consumer-app concerns. The library publishes the
//      `onAuthRecoveryNeeded` event and lets the composition root decide.
//
//   4. Heartbeat subscriber start/stop is NOT here. Phase 1.5's
//      HeartbeatMonitor is the right home; the optional `onClose` hook lets
//      the composition root run any teardown it wants.
//
//   5. `console.log/error` → injected `Logger` (CLAUDE.md "Zero `console.log`").
//
// Bug coverage in this file:
//   - Bug 9 (stale-WS close clobbering): the isStaleWs branch derived from
//     wrapper !== holder.get() drops the close on the floor without touching
//     state — proven by the test suite.
//   - Bug 10 (currentAttemptOpened lifecycle): we snapshot the flag BEFORE
//     resetting it, so the decision tree sees attempt-N's reality but the
//     holder is reset in time for attempt-(N+1)'s open/close pair. Verbatim
//     ordering from the source's comment block.
//   - Bug 4 (pre-open 1000 masked handshake failure): decideClose returns
//     `auth-recovery` for this shape; we forward to onAuthRecoveryNeeded.

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type ReconnectingWebSocket from "partysocket/ws";

import type { ConnectionStateManager } from "../state/connection-state.js";
import { connected, disconnected, kicked } from "../state/types.js";
import type { WebSocketHolder } from "../state/websocket-holder.js";

import { decideClose, type CloseDecision } from "./close-decision.js";
import {
  normalizeCloseEvent,
  normalizeErrorEvent,
  normalizeOpenEvent,
} from "./event-normalizer.js";
import type { WebSocketEventHandlers } from "./types.js";

/**
 * Collaborators injected into EventHandlers. All required except `logger`,
 * which defaults to noop, and the two optional hooks which the composition
 * root may wire in Phase 1.7.
 */
export interface EventHandlersDeps {
  connectionState: ConnectionStateManager;
  websocketHolder: WebSocketHolder;
  /**
   * Called when the decision is `auth-recovery`. The composition root wires
   * this to the storm-guard-protected refresh path owned by ReconnectManager
   * (Phase 1.3). The callback is FIRE-AND-FORGET from this class's
   * perspective; we hand off and continue (state still moves to disconnected).
   */
  onAuthRecoveryNeeded: (closeCode: number) => void;
  /** Logger. Default: noop. */
  logger?: Logger;
  /**
   * Optional setup hook fired AFTER the state transitions to `connected`
   * on a successful open. Phase 1.7 wires this to start the heartbeat
   * subscriber so it begins consuming the stealth procedure. Mirror of
   * `onClose` below — the source app called `heartbeatSubscriber.subscribe()`
   * inline in its open handler; we surface the seam here.
   */
  onOpen?: () => void;
  /**
   * Optional teardown hook fired AFTER state transitions on any close
   * outcome that isn't `ignore` (stale-WS). Phase 1.7 wires this to stop
   * the heartbeat monitor, etc.
   */
  onClose?: () => void;
}

/**
 * Orchestrates lifecycle events for a single client. Stateless across
 * connections — all per-WS state lives in WebSocketHolder. A single
 * instance can serve any number of wrappers via `createHandlers()`.
 */
export class EventHandlers {
  private readonly connectionState: ConnectionStateManager;
  private readonly websocketHolder: WebSocketHolder;
  private readonly onAuthRecoveryNeeded: (closeCode: number) => void;
  private readonly logger: Logger;
  private readonly onOpenHook: (() => void) | undefined;
  private readonly onCloseHook: (() => void) | undefined;

  constructor(deps: EventHandlersDeps) {
    this.connectionState = deps.connectionState;
    this.websocketHolder = deps.websocketHolder;
    this.onAuthRecoveryNeeded = deps.onAuthRecoveryNeeded;
    this.logger = deps.logger ?? noopLogger;
    this.onOpenHook = deps.onOpen;
    this.onCloseHook = deps.onClose;
  }

  /**
   * Build a WebSocketEventHandlers bound to a specific wrapper. The factory
   * closes over `wrapper` when attaching onclose, so the wrapper-equality
   * check (Bug 9) has the right reference.
   */
  createHandlers(_wrapper: ReconnectingWebSocket): WebSocketEventHandlers {
    // `_wrapper` is intentionally unused inside this method — the factory
    // closure-binds the wrapper when wiring `ws.onclose` (see
    // websocket-factory.ts), and passes it back as the second arg to
    // `onClose` below. We accept it here so callers can construct
    // handlers in a parallel position to the factory call site, and so
    // future hooks (e.g. per-wrapper logging) have a place to land.
    return {
      onOpen: (event) => this.handleOpen(event),
      onClose: (event, w) => this.handleClose(event, w),
      onError: (event) => this.handleError(event),
    };
  }

  // ---------- handlers ----------

  private handleOpen(event: unknown): void {
    // Normalize for consistency / future-proofing — open carries no payload.
    normalizeOpenEvent(event);
    this.logger.info("event-handlers: WebSocket open");
    this.websocketHolder.markCurrentAttemptOpened();
    this.connectionState.setState(connected());
    // Per-open setup hook. Phase 1.7 wires this to start the heartbeat
    // subscriber so it begins consuming the stealth `__orpc_ws_lib__.heartbeat`
    // procedure now that the link can be built against the open WS. Source
    // verbatim semantics — the original `event-handlers.ts` called
    // `subscriber.subscribe(client, monitor)` inline at this point.
    this.runOnOpenHook();
  }

  private handleClose(event: unknown, wrapper: ReconnectingWebSocket): void {
    const normalized = normalizeCloseEvent(event, { logger: this.logger });
    this.logger.info("event-handlers: WebSocket close", {
      code: normalized.code,
      reason: normalized.reason,
    });

    // Snapshot inputs for the pure decision function BEFORE mutating the
    // holder. Bug 10 ordering: attemptHadOpened reflects the CLOSING
    // attempt; the holder is reset immediately after so the NEXT attempt
    // starts with a clean flag (partysocket can fire another close on a
    // pre-open failure of the next attempt without ever calling holder.set,
    // so we must reset here rather than in the factory).
    const currentWs = this.websocketHolder.get();
    const isStaleWs = wrapper !== currentWs;
    const attemptHadOpened = this.websocketHolder.getCurrentAttemptOpened();

    // Reset BEFORE dispatching (but AFTER capture). The reset is a no-op for
    // the stale-WS branch — current state was already touched by whoever
    // replaced the wrapper — but it's harmless and keeps the contract:
    // "every close resets the flag for the next attempt of the current WS".
    if (!isStaleWs) {
      this.websocketHolder.resetCurrentAttempt();
    }

    const decision = decideClose({
      event: normalized,
      isStaleWs,
      attemptHadOpened,
    });

    this.dispatchCloseDecision(decision, wrapper);
  }

  private handleError(event: unknown): void {
    const normalized = normalizeErrorEvent(event);
    // Matches source verbatim: log and return. No state change — partysocket
    // will follow with the corresponding close (or with a reconnect attempt),
    // and that close is where state transitions live.
    this.logger.error("event-handlers: WebSocket error", {
      message: normalized.message,
    });
  }

  // ---------- decision dispatch ----------

  private dispatchCloseDecision(
    decision: CloseDecision,
    wrapper: ReconnectingWebSocket,
  ): void {
    switch (decision.kind) {
      case "ignore":
        this.logger.debug("event-handlers: ignoring stale-WS close");
        // No state change. No onClose hook — the wrapper that replaced this
        // one is responsible for its own teardown chain.
        return;

      case "session-replaced":
        // Tell partysocket to STOP reconnecting. Without an explicit close
        // call on the wrapper, partysocket will retry forever even though
        // the session is gone. 4005 is also the code we received, but
        // sending it back via `wrapper.close()` flips partysocket's
        // internal `_closeCalled` flag and disables auto-reconnect.
        try {
          wrapper.close(4005, "Session replaced");
        } catch (err) {
          this.logger.warn("event-handlers: wrapper.close(4005) threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.connectionState.setState(kicked("session_replaced"));
        this.runOnCloseHook();
        return;

      case "auth-recovery":
        // `willRetry: true` — the library is going to attempt an auth
        // recovery + reconnect via the orchestrator. Even if storm guard
        // eventually trips and we end up firing terminal-auth-failure,
        // at this transition point we ARE retrying.
        this.connectionState.setState(
          disconnected({ code: decision.closeCode, willRetry: true }),
        );
        // Hand off to the composition root's storm-guard-protected refresh.
        // Errors thrown by the consumer's wiring must not propagate up
        // into partysocket's reconnect loop.
        try {
          this.onAuthRecoveryNeeded(decision.closeCode);
        } catch (err) {
          this.logger.error(
            "event-handlers: onAuthRecoveryNeeded callback threw",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
        this.runOnCloseHook();
        return;

      case "normal-disconnect":
        // partysocket will auto-reconnect (unless maxRetries exhausted);
        // from the library's perspective at this transition, we ARE
        // retrying. `code` is included for UI surfaces that want to render
        // the cause (1006 network drop vs. 1000 normal etc.).
        this.connectionState.setState(
          disconnected({ code: decision.closeCode, willRetry: true }),
        );
        this.runOnCloseHook();
        return;

      default: {
        // Exhaustiveness guard. If a new CloseDecision variant is added
        // and not handled here, TypeScript will flag this assignment.
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  }

  private runOnOpenHook(): void {
    if (!this.onOpenHook) return;
    try {
      this.onOpenHook();
    } catch (err) {
      this.logger.error("event-handlers: onOpen hook threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private runOnCloseHook(): void {
    if (!this.onCloseHook) return;
    try {
      this.onCloseHook();
    } catch (err) {
      this.logger.error("event-handlers: onClose hook threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
