// Bug 23 regression — a pre-open connection TIMEOUT is not an auth signal.
//
// partysocket synthesizes code 1000 for EVERY pre-open failure, so the
// Bug-4 branch (`code === 1000 && !attemptHadOpened` → auth-recovery)
// swept partysocket's own connectionTimeout in with the genuine
// masked-handshake-failure shape. A timeout is a network condition
// (slow/blackholed path), never an auth signal: routing it to
// auth-recovery burned a storm-guard-gated token refresh on every slow
// network, and two timeouts inside the 30s window tripped a spurious
// terminal logout.
//
// The timeout IS distinguishable: partysocket 1.3.0's timeout path —
// `_handleTimeout()` → `ErrorEvent(Error("TIMEOUT"))` → `_handleError` →
// `_disconnect(void 0, "timeout")` — puts the literal reason "timeout" on
// the synthetic CloseEvent(1000), while every other pre-open failure
// reaches `_disconnect` with `reason: void 0` (→ `""`). The
// event-normalizer preserves `reason` verbatim on the numeric-code happy
// path, so the decision tree can see it.
//
// Fix under test: `decideClose` classifies 1000+pre-open+reason:"timeout"
// as `normal-disconnect` (ride partysocket's backoff), while the plain
// 1000+pre-open shape still routes to auth-recovery (Bug 4 unchanged).
// Also pinned at the EventHandlers level: the timeout close never reaches
// `onAuthRecoveryNeeded` (no refresh is attempted).

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { ConnectionStateManager } from "../../state/connection-state.js";
import { connecting } from "../../state/types.js";
import { WebSocketHolder } from "../../state/websocket-holder.js";

import { decideClose } from "../close-decision.js";
import { EventHandlers } from "../event-handlers.js";

describe("Bug 23 — decideClose: pre-open 1000 + reason 'timeout' → normal-disconnect", () => {
  it("connection-timeout shape rides partysocket's backoff, not auth-recovery", () => {
    expect(
      decideClose({
        event: { type: "close", code: 1000, reason: "timeout", wasClean: true },
        isStaleWs: false,
        attemptHadOpened: false,
      }),
    ).toEqual({ kind: "normal-disconnect", closeCode: 1000 });
  });

  it("plain pre-open 1000 (empty reason) still routes to auth-recovery (Bug 4 intact)", () => {
    // Guard against over-fixing: the genuine masked-handshake-failure shape
    // (partysocket passes `reason: void 0` → "") must keep its Bug-4 route.
    expect(
      decideClose({
        event: { type: "close", code: 1000, reason: "", wasClean: true },
        isStaleWs: false,
        attemptHadOpened: false,
      }),
    ).toEqual({
      kind: "auth-recovery",
      closeCode: 1000,
      trigger: "pre-open-1000",
    });
  });

  it("the exemption is scoped to the exact partysocket reason string", () => {
    // Any other reason text on a pre-open 1000 is NOT the timeout shape.
    expect(
      decideClose({
        event: {
          type: "close",
          code: 1000,
          reason: "Timed Out",
          wasClean: true,
        },
        isStaleWs: false,
        attemptHadOpened: false,
      }).kind,
    ).toBe("auth-recovery");
  });
});

describe("Bug 23 — EventHandlers: timeout close attempts no refresh", () => {
  it("pre-open 1000/'timeout' → disconnected(willRetry:true), onAuthRecoveryNeeded NOT called", async () => {
    const connectionState = new ConnectionStateManager(connecting());
    const websocketHolder = new WebSocketHolder();
    const onAuthRecoveryNeeded = vi.fn();
    const eventHandlers = new EventHandlers({
      connectionState,
      websocketHolder,
      onAuthRecoveryNeeded,
    });

    const ws = { close: vi.fn() } as unknown as ReconnectingWebSocket;
    websocketHolder.set(ws);
    // NOTE: markCurrentAttemptOpened() is NEVER called — pre-open close.
    const handlers = eventHandlers.createHandlers(ws);

    // The exact event partysocket's connectionTimeout path delivers.
    await handlers.onClose(
      { code: 1000, reason: "timeout", wasClean: true },
      ws,
    );

    // Normal retryable disconnect — partysocket owns the backoff.
    expect(connectionState.getState()).toEqual({
      status: "disconnected",
      code: 1000,
      willRetry: true,
    });
    // Pre-fix: this fired (1000, "pre-open-1000") and the manager burned a
    // storm-guard-gated refresh on a network timeout.
    expect(onAuthRecoveryNeeded).not.toHaveBeenCalled();
  });
});
