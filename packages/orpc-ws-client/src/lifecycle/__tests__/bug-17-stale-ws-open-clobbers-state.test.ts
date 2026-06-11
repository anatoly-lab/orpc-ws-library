// Bug 17 (review BUG-6) — stale-WS open clobbers state.
//
// Bug 9's stale-WS guard existed only for CLOSE events. During a
// token-refresh swap (`TokenRefreshHandler.swapSocket`), the old wrapper is
// close()'d and replaced in the holder — but if its handshake completed just
// before the swap, its `open` event is already queued and still delivered.
// Without a guard, `handleOpen` then runs against the NEW holder state:
//   - markCurrentAttemptOpened() flags the NEW wrapper's attempt as opened
//     before it ever opened, so a later pre-open close-1000 on the new
//     wrapper misroutes to normal-disconnect instead of auth-recovery —
//     Bug 4's masked-handshake-failure silent loop, resurrected in a race;
//   - setState(connected()) fires while the new WS may still be CONNECTING;
//   - the onOpen hook (heartbeat subscribe) runs against a non-OPEN link.
//
// The fix mirrors the Bug-9 close guard exactly: the factory closure-binds
// the wrapper into onOpen, and handleOpen drops the event on the floor when
// the wrapper is no longer the holder's current one.

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { ConnectionStateManager } from "../../state/connection-state.js";
import {
  connecting,
  disconnected,
  type ConnectionState,
} from "../../state/types.js";
import { WebSocketHolder } from "../../state/websocket-holder.js";

import { EventHandlers } from "../event-handlers.js";

// Stub ReconnectingWebSocket: only the methods the handler touches need
// to exist. We never instantiate a real one — would trigger networking.
function makeStubSocket(label = "ws"): ReconnectingWebSocket {
  const close = vi.fn();
  return { __label: label, close } as unknown as ReconnectingWebSocket;
}

function buildHandlers(
  overrides: {
    initialState?: ConnectionState;
  } = {},
) {
  const connectionState = new ConnectionStateManager(
    overrides.initialState ?? disconnected({ willRetry: false }),
  );
  const websocketHolder = new WebSocketHolder();
  const onAuthRecoveryNeeded = vi.fn<(code: number) => void>();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const onOpen = vi.fn();
  const handlers = new EventHandlers({
    connectionState,
    websocketHolder,
    onAuthRecoveryNeeded,
    logger,
    onOpen,
  });
  return {
    handlers,
    connectionState,
    websocketHolder,
    onAuthRecoveryNeeded,
    onOpen,
    logger,
  };
}

describe("EventHandlers — onOpen — Bug 17: stale-WS open clobbering", () => {
  it("an open from a wrapper that's no longer current is ignored", () => {
    const ctx = buildHandlers({ initialState: connecting() });
    const wsOld = makeStubSocket("old");
    const wsNew = makeStubSocket("new");

    // wsOld is the *original* wrapper this handler was bound to.
    const handlers = ctx.handlers.createHandlers(wsOld);
    // But a token-refresh swap already replaced it: wsNew is current and
    // still mid-handshake (its own open hasn't fired yet).
    ctx.websocketHolder.set(wsNew);

    // wsOld's queued open is delivered after the swap:
    handlers.onOpen(new Event("open"), wsOld);

    // (a) State must NOT transition to connected — wsNew is still CONNECTING.
    expect(ctx.connectionState.getState()).toEqual({ status: "connecting" });
    // (b) wsNew's per-attempt flag must stay false. If the stale open
    //     flipped it, wsNew's later pre-open close-1000 would misroute to
    //     normal-disconnect instead of auth-recovery (Bug 4 resurrected).
    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(false);
    // (c) The onOpen hook (heartbeat subscribe) must NOT run — the link it
    //     would subscribe against is not OPEN.
    expect(ctx.onOpen).not.toHaveBeenCalled();
  });

  it("a current-wrapper open still transitions to connected and runs the hook", () => {
    const ctx = buildHandlers({ initialState: connecting() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    const handlers = ctx.handlers.createHandlers(ws);

    handlers.onOpen(new Event("open"), ws);

    expect(ctx.connectionState.getState()).toEqual({ status: "connected" });
    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(true);
    expect(ctx.onOpen).toHaveBeenCalledTimes(1);
  });
});
