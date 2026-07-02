// EventHandlers orchestration tests.
//
// Pins the side-effect behavior that wraps the pure close-decision tree:
//   - Bug 9 stale-WS guard: a close from a wrapper that's no longer the
//     holder's current wrapper does NOT touch state and does NOT trigger
//     onAuthRecoveryNeeded.
//   - Bug 10 currentAttemptOpened lifecycle: every close (other than the
//     stale-WS ignore branch) resets the flag so the NEXT attempt is
//     evaluated independently. We exercise this across decision kinds.
//   - Auth-recovery callback fires with the right close code for 1008,
//     4001, and pre-open 1000.
//   - Session-replaced calls wrapper.close(4005) AND sets terminal state
//     AND does NOT call onAuthRecoveryNeeded.
//   - Normal-disconnect transitions state to DISCONNECTED.
//   - onOpen marks the attempt opened and sets state to CONNECTED.
//   - onError logs but doesn't change state (matches source).

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { ConnectionStateManager } from "../../state/connection-state.js";
import {
  connected,
  connecting,
  disconnected,
  type ConnectionState,
} from "../../state/types.js";
import { WebSocketHolder } from "../../state/websocket-holder.js";

import { EventHandlers } from "../event-handlers.js";
import type { AuthRecoveryTrigger } from "../close-decision.js";

// Stub ReconnectingWebSocket: only the methods the handler touches need
// to exist. We never instantiate a real one — would trigger networking.
function makeStubSocket(label = "ws"): ReconnectingWebSocket {
  const close = vi.fn();
  return { __label: label, close } as unknown as ReconnectingWebSocket;
}

function buildHandlers(
  overrides: {
    initialState?: ConnectionState;
    onClose?: () => void;
  } = {},
) {
  const connectionState = new ConnectionStateManager(
    overrides.initialState ?? disconnected({ willRetry: false }),
  );
  const websocketHolder = new WebSocketHolder();
  const onAuthRecoveryNeeded =
    vi.fn<(code: number, trigger: AuthRecoveryTrigger) => void>();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const onClose = overrides.onClose ?? vi.fn();
  const handlers = new EventHandlers({
    connectionState,
    websocketHolder,
    onAuthRecoveryNeeded,
    logger,
    onClose,
  });
  return {
    handlers,
    connectionState,
    websocketHolder,
    onAuthRecoveryNeeded,
    onClose,
    logger,
  };
}

describe("EventHandlers — onOpen", () => {
  it("sets state to CONNECTED and marks the attempt opened", () => {
    const ctx = buildHandlers({ initialState: connecting() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    const handlers = ctx.handlers.createHandlers(ws);

    handlers.onOpen(new Event("open"), ws);

    expect(ctx.connectionState.getState()).toEqual({ status: "connected" });
    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(true);
  });
});

describe("EventHandlers — onError", () => {
  it("logs but does not change state (matches source behaviour)", () => {
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    const handlers = ctx.handlers.createHandlers(ws);

    handlers.onError({ message: "transport bad" });

    expect(ctx.connectionState.getState()).toEqual({ status: "connected" });
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("EventHandlers — onClose — Bug 9: stale-WS close clobbering", () => {
  it("a close from a wrapper that's no longer current is ignored", async () => {
    const ctx = buildHandlers({ initialState: connected() });
    const wsA = makeStubSocket("A");
    const wsB = makeStubSocket("B");

    // wsA is the *original* wrapper this handler was bound to.
    const handlers = ctx.handlers.createHandlers(wsA);
    // But the holder has already been replaced by wsB (reconnect happened).
    ctx.websocketHolder.set(wsB);
    ctx.websocketHolder.markCurrentAttemptOpened(); // wsB succeeded

    // A delayed close from wsA fires:
    await handlers.onClose(
      { code: 1008, reason: "policy", wasClean: true },
      wsA,
    );

    // State stays CONNECTED — wsB is still up.
    expect(ctx.connectionState.getState()).toEqual({ status: "connected" });
    // onAuthRecoveryNeeded must NOT have been called.
    expect(ctx.onAuthRecoveryNeeded).not.toHaveBeenCalled();
    // wsB's per-attempt flag must NOT have been clobbered. wsA's stale
    // close had no business resetting it. Without the stale-WS reset
    // guard in handleClose, this would now be false.
    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(true);
    // wsA itself must NOT have been wrapper.close()'d.
    expect((wsA.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("EventHandlers — onClose — auth-recovery routes", () => {
  it("code 1008 → onAuthRecoveryNeeded(1008), state → disconnected(code:1008, willRetry:true), onClose hook runs", async () => {
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    await handlers.onClose({ code: 1008, reason: "", wasClean: true }, ws);

    expect(ctx.onAuthRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(ctx.onAuthRecoveryNeeded).toHaveBeenCalledWith(1008, "auth-close");
    expect(ctx.connectionState.getState()).toEqual({
      status: "disconnected",
      code: 1008,
      willRetry: true,
    });
    expect(ctx.onClose).toHaveBeenCalledTimes(1);
  });

  it("code 4001 → onAuthRecoveryNeeded(4001)", async () => {
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    await handlers.onClose({ code: 4001, reason: "", wasClean: true }, ws);

    expect(ctx.onAuthRecoveryNeeded).toHaveBeenCalledWith(4001, "auth-close");
    expect(ctx.connectionState.getState()).toEqual({
      status: "disconnected",
      code: 4001,
      willRetry: true,
    });
  });

  it("Bug 4 pre-open 1000 (!attemptHadOpened) → onAuthRecoveryNeeded(1000)", async () => {
    // The handshake failed at the browser layer; partysocket synthesized
    // a code-1000 close before onopen ever fired. Without the Bug-4 fix
    // this would route to normal-disconnect and we'd loop silently.
    const ctx = buildHandlers({ initialState: connecting() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    // NOTE: markCurrentAttemptOpened() is NEVER called — pre-open close.
    const handlers = ctx.handlers.createHandlers(ws);

    await handlers.onClose({ code: 1000, reason: "", wasClean: true }, ws);

    expect(ctx.onAuthRecoveryNeeded).toHaveBeenCalledWith(
      1000,
      "pre-open-1000",
    );
    expect(ctx.connectionState.getState()).toEqual({
      status: "disconnected",
      code: 1000,
      willRetry: true,
    });
  });

  it("post-open 1000 (attemptHadOpened) → normal-disconnect, NOT auth-recovery", async () => {
    // Symmetric to the previous test: this proves we don't OVER-fire the
    // Bug-4 branch — a clean server-side close on an opened connection is
    // not an auth event.
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    await handlers.onClose({ code: 1000, reason: "", wasClean: true }, ws);

    expect(ctx.onAuthRecoveryNeeded).not.toHaveBeenCalled();
    expect(ctx.connectionState.getState()).toEqual({
      status: "disconnected",
      code: 1000,
      willRetry: true,
    });
  });
});

describe("EventHandlers — onClose — session-replaced (4005)", () => {
  it("calls wrapper.close(4005), sets kicked(session_replaced), NO auth-recovery", async () => {
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    await handlers.onClose(
      { code: 4005, reason: "Session replaced", wasClean: true },
      ws,
    );

    // partysocket auto-reconnect needs an explicit close() with the 4005
    // code to flip its `_closeCalled` flag and stop retrying.
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4005, "Session replaced");
    expect(ctx.connectionState.getState()).toEqual({
      status: "kicked",
      reason: "session_replaced",
    });
    expect(ctx.onAuthRecoveryNeeded).not.toHaveBeenCalled();
    expect(ctx.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EventHandlers — onClose — normal-disconnect branches", () => {
  it("code 1006 (network drop) → disconnected(code:1006, willRetry:true), no recovery", async () => {
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    await handlers.onClose(
      { code: 1006, reason: "", wasClean: false },
      ws,
    );

    expect(ctx.connectionState.getState()).toEqual({
      status: "disconnected",
      code: 1006,
      willRetry: true,
    });
    expect(ctx.onAuthRecoveryNeeded).not.toHaveBeenCalled();
    expect(ctx.onClose).toHaveBeenCalledTimes(1);
  });

  it("partysocket cloneEventBrowser bug shape is normalized then routed correctly", async () => {
    // End-to-end: feed the orchestrator the buggy clone shape (`code: "close"`
    // string, original event under `reason`). The normalizer recovers 1008
    // and we hit the auth-recovery branch.
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    const original = { code: 1008, reason: "policy", wasClean: true };
    const buggy = { code: "close", reason: original, wasClean: true };
    await handlers.onClose(buggy, ws);

    expect(ctx.onAuthRecoveryNeeded).toHaveBeenCalledWith(1008, "auth-close");
  });
});

describe("EventHandlers — Bug 10 cross-instance: currentAttemptOpened reset on every close", () => {
  it("after a close, the next attempt's onOpen/onClose pair starts with opened=false", async () => {
    // Walkthrough mirrors the WebSocketHolder Phase-1.1 test, but exercised
    // through the orchestrator: a close on the current wrapper must reset
    // the flag so a SUBSEQUENT pre-open close (partysocket's synthesized
    // 1000) is correctly classified as Bug 4, not as "normal post-open".
    const ctx = buildHandlers({ initialState: connecting() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    const handlers = ctx.handlers.createHandlers(ws);

    // Attempt #1: open succeeds, then disconnects cleanly post-open (1000).
    handlers.onOpen(new Event("open"), ws);
    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(true);
    await handlers.onClose({ code: 1000, reason: "", wasClean: true }, ws);

    // The flag must be reset by the orchestrator now — partysocket may
    // begin attempt #2 internally without ever calling holder.set().
    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(false);

    // Attempt #2: pre-open close synthesized as 1000. Bug 4 must fire.
    ctx.onAuthRecoveryNeeded.mockClear();
    await handlers.onClose({ code: 1000, reason: "", wasClean: true }, ws);
    expect(ctx.onAuthRecoveryNeeded).toHaveBeenCalledWith(
      1000,
      "pre-open-1000",
    );
  });

  it("stale-WS close does NOT reset the current attempt's opened flag", async () => {
    // Defensive: if a delayed close from a *previous* wrapper resets the
    // flag, the current wrapper's later post-open 1000 would misroute to
    // auth-recovery. Guard against that regression here.
    const ctx = buildHandlers({ initialState: connected() });
    const wsA = makeStubSocket("A");
    const wsB = makeStubSocket("B");
    const handlersA = ctx.handlers.createHandlers(wsA);

    ctx.websocketHolder.set(wsB);
    ctx.websocketHolder.markCurrentAttemptOpened();

    await handlersA.onClose(
      { code: 1000, reason: "", wasClean: true },
      wsA,
    );

    expect(ctx.websocketHolder.getCurrentAttemptOpened()).toBe(true);
  });
});

describe("EventHandlers — error containment", () => {
  it("a throwing onAuthRecoveryNeeded callback does not propagate", () => {
    const ctx = buildHandlers({ initialState: connected() });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    ctx.onAuthRecoveryNeeded.mockImplementation(() => {
      throw new Error("consumer wired this badly");
    });
    const handlers = ctx.handlers.createHandlers(ws);

    expect(() =>
      handlers.onClose({ code: 1008, reason: "", wasClean: true }, ws),
    ).not.toThrow();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("a throwing onClose hook does not propagate", () => {
    const onClose = vi.fn(() => {
      throw new Error("hook explosion");
    });
    const ctx = buildHandlers({
      initialState: connected(),
      onClose,
    });
    const ws = makeStubSocket();
    ctx.websocketHolder.set(ws);
    ctx.websocketHolder.markCurrentAttemptOpened();
    const handlers = ctx.handlers.createHandlers(ws);

    expect(() =>
      handlers.onClose({ code: 1006, reason: "", wasClean: false }, ws),
    ).not.toThrow();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
