// WebSocket instance holder.
//
// Phase 1.1 lift from `apps/web/src/lib/websocket/state/websocket-holder.ts`.
// Difference from the source: no module-level singleton export — the
// composition root (Phase 1.7) instantiates this; tests construct their own.
// See CLAUDE.md "No god files" / "Dependency inversion" and
// implementation-plan.md §"Phase 1 — Discipline".
//
// Method-name change: the source's `markOpened()` is `markCurrentAttemptOpened()`
// here to match the field name; behavior is identical.

import type ReconnectingWebSocket from "partysocket/ws";

/**
 * Holds the live `ReconnectingWebSocket` plus the token and per-attempt
 * lifecycle flags associated with it. Single responsibility: state storage.
 * No I/O, no event wiring — those live in `lifecycle/` (Phase 1.2).
 */
export class WebSocketHolder {
  private websocket: ReconnectingWebSocket | null = null;
  private currentToken: string | null = null;
  // Per-attempt flag: true iff the CURRENT handshake attempt reached 'open'.
  // partysocket internally recreates the native WebSocket on each reconnect
  // WITHOUT calling holder.set(), so resetting only in set()/clear() would
  // leave this true across internal reconnects — a later handshake failure
  // (code 1000 synthesized by partysocket) would no longer match the
  // pre-open branch in event-handlers, causing a silent infinite reconnect
  // loop. event-handlers.onClose resets this at the top of every close so
  // each attempt is evaluated independently. Refresh-storm protection is
  // handled by a module-level timestamp in event-handlers.ts, not per-WS,
  // so that partysocket's per-reconnect WS recreation can't bypass the
  // rate-limit.
  private currentAttemptOpened = false;

  get(): ReconnectingWebSocket | null {
    return this.websocket;
  }

  set(ws: ReconnectingWebSocket): void {
    this.websocket = ws;
    // Fresh instance: reset lifecycle flags
    this.currentAttemptOpened = false;
  }

  clear(): void {
    this.websocket = null;
    this.currentToken = null;
    this.currentAttemptOpened = false;
  }

  getCurrentToken(): string | null {
    return this.currentToken;
  }

  setCurrentToken(token: string | null): void {
    this.currentToken = token;
  }

  markCurrentAttemptOpened(): void {
    this.currentAttemptOpened = true;
  }

  resetCurrentAttempt(): void {
    this.currentAttemptOpened = false;
  }

  getCurrentAttemptOpened(): boolean {
    return this.currentAttemptOpened;
  }
}
