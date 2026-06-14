// partysocket 1.2.0 synchronous-close regression (SHOULD-FIX 1) at the
// ClientLifecycle level.
//
// partysocket 1.2.0 made `ReconnectingWebSocket.close()` flip
// `readyState`→CLOSED and dispatch `close` SYNCHRONOUSLY. So when
// `fireTerminalAuthFailure()` / `dispose()` call `ws.close()` on a LIVE
// wrapper, our own `onclose` (→ EventHandlers.handleClose) RE-ENTERS
// inline before the calling method returns.
//
// The bug: the old teardown closed the wrapper while the holder was still
// SET. The re-entrant close then ran the full close-decision tree:
//   - never-opened (Bug-4 1000 shape) → `auth-recovery` → emit
//     `auth_failure{refreshable:true}` + `disconnected{willRetry:true}`;
//   - opened, code 1000              → `normal-disconnect` → emit
//     `disconnected{willRetry:true}`.
// Either way a SPURIOUS non-terminal frame landed before the intended
// terminal emit.
//
// The fix (CLEAR-BEFORE-CLOSE): null the link + holder BEFORE `ws.close()`.
// The re-entrant handleClose then sees `wrapper !== holder.get()` (holder
// is null) → `decideClose` returns `ignore` (stale-ws, Bug 9 guard) → no
// transition, no hooks, no spurious emit.
//
// This test drives the REAL `EventHandlers` (so the re-entrant close routes
// through the genuine close-decision tree) with a fake wrapper whose
// `close()` dispatches `onclose` synchronously, and calls
// `fireTerminalAuthFailure()` / `dispose()` DIRECTLY while the wrapper is
// LIVE in the holder — the exact window the bug needs.

import { describe, expect, it } from "vitest";

import { ConnectionStateManager } from "../../state/connection-state.js";
import { WebSocketHolder } from "../../state/websocket-holder.js";
import { connecting, disconnected, type ConnectionState } from "../../state/types.js";
import type { ClientEvent } from "../../events.js";

import { EventHandlers } from "../event-handlers.js";
import { ClientLifecycle, type ClientLifecycleDeps } from "../client-lifecycle.js";

// ---- Fake partysocket wrapper: synchronous close (partysocket 1.2.0). ----

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeWrapper {
  readyState = CONNECTING;
  onclose: ((event: unknown) => void) | null = null;
  closeCalls = 0;

  // partysocket 1.2.0: close() flips readyState→CLOSED and dispatches
  // `close` SYNCHRONOUSLY. We mirror that exactly so onclose re-enters the
  // SUT inline.
  close(code = 1000): void {
    this.closeCalls += 1;
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code, reason: "", wasClean: true });
  }
}

// ---- Stub collaborators ----

interface Harness {
  lifecycle: ClientLifecycle;
  state: ConnectionStateManager;
  holder: WebSocketHolder;
  events: ClientEvent[];
  states: ConnectionState[];
  ws: FakeWrapper;
  dropCalls: number;
  abortCalls: number;
}

function makeHarness(opts: { opened: boolean }): Harness {
  const events: ClientEvent[] = [];
  const states: ConnectionState[] = [];
  let dropCalls = 0;
  let abortCalls = 0;

  const state = new ConnectionStateManager(disconnected({ willRetry: false }));
  const holder = new WebSocketHolder();

  const linkFactory = { clearLink: () => {} } as unknown as ClientLifecycleDeps["linkFactory"];
  const heartbeatMonitor = { stop: () => {} } as unknown as ClientLifecycleDeps["heartbeatMonitor"];
  const heartbeatSubscriber = {
    abort: () => {
      abortCalls += 1;
    },
    drop: () => {
      dropCalls += 1;
    },
    stop: () => {},
  } as unknown as ClientLifecycleDeps["heartbeatSubscriber"];

  const emit = (e: ClientEvent): void => {
    events.push(e);
  };

  // REAL EventHandlers so the re-entrant close routes through the genuine
  // close-decision tree. The no-tokenProvider terminal path is what we
  // exercise: onAuthRecoveryNeeded → fireTerminalAuthFailure directly.
  // `lifecycle` is built below as `const` and referenced here through a
  // deferred closure (same forward-ref shape the real composition root uses
  // for `reconnectManager` in index.ts), so no `let` is needed.
  const eventHandlers = new EventHandlers({
    connectionState: state,
    websocketHolder: holder,
    onAuthRecoveryNeeded: () => {
      // Mirror the composition root's no-tokenProvider branch: go straight
      // to terminal (no refreshable:true emit). If the re-entrant close is
      // NOT stale-dropped, this fires a SECOND time (single-fire latch
      // makes it a no-op, but the auth-recovery branch ALSO already set a
      // spurious disconnected{willRetry:true} before reaching here).
      lifecycle.fireTerminalAuthFailure();
    },
    emit,
  } as unknown as ConstructorParameters<typeof EventHandlers>[0]);

  const ws = new FakeWrapper();
  // Wire the wrapper's onclose exactly as the WebSocketFactory does:
  // closure-bind the wrapper and route into EventHandlers.handleClose.
  const handlers = eventHandlers.createHandlers(ws as never);
  ws.onclose = (event) => handlers.onClose(event, ws as never);

  const lifecycle = new ClientLifecycle({
    connectionState: state,
    websocketHolder: holder,
    linkFactory,
    heartbeatMonitor,
    heartbeatSubscriber,
    websocketFactory: {} as unknown as ClientLifecycleDeps["websocketFactory"],
    reconnectConfig: {} as unknown as ClientLifecycleDeps["reconnectConfig"],
    urlProvider: () => "ws://x",
    createHandlers: () => handlers,
    getSleepDetector: () => null,
    getReconnectManager: () =>
      ({ dispose: () => {} }) as unknown as ReturnType<
        ClientLifecycleDeps["getReconnectManager"]
      >,
    emit,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  // Bring the wrapper into the holder as the LIVE connection.
  state.setState(connecting());
  holder.set(ws as never);
  ws.readyState = opts.opened ? OPEN : CONNECTING;
  if (opts.opened) {
    holder.markCurrentAttemptOpened();
    state.setState({ status: "connected" });
  }

  // Start recording AFTER setup so we only capture teardown frames.
  states.length = 0;
  state.subscribe(() => states.push(state.getState()));

  return { lifecycle, state, holder, events, states, ws, get dropCalls() { return dropCalls; }, get abortCalls() { return abortCalls; } } as Harness;
}

describe("ClientLifecycle — partysocket 1.2.0 synchronous close, no spurious teardown emit", () => {
  it("fireTerminalAuthFailure on a NEVER-OPENED live wrapper: re-entrant synchronous close is stale-dropped — no auth_failure{refreshable:true}, no disconnected{willRetry:true}", () => {
    const h = makeHarness({ opened: false });

    h.lifecycle.fireTerminalAuthFailure();

    // The wrapper was actually closed (which re-entered handleClose).
    expect(h.ws.closeCalls).toBeGreaterThanOrEqual(1);

    // NO spurious auth_failure{refreshable:true}. Only the terminal
    // {refreshable:false}.
    expect(h.events).toEqual([{ type: "auth_failure", refreshable: false }]);

    // NO transient disconnected{willRetry:true}. Only the single terminal
    // disconnected{willRetry:false}.
    expect(
      h.states.filter(
        (s) => s.status === "disconnected" && s.willRetry === true,
      ),
    ).toEqual([]);
    expect(h.states.at(-1)).toMatchObject({
      status: "disconnected",
      willRetry: false,
    });

    // Close path used drop() (frameless), never abort().
    expect(h.dropCalls).toBe(1);
    expect(h.abortCalls).toBe(0);
  });

  it("fireTerminalAuthFailure on an OPENED live wrapper: re-entrant code-1000 close is stale-dropped — no disconnected{willRetry:true}", () => {
    const h = makeHarness({ opened: true });

    h.lifecycle.fireTerminalAuthFailure();

    expect(h.ws.closeCalls).toBeGreaterThanOrEqual(1);
    // On an opened wrapper the re-entrant code-1000 close would route to
    // normal-disconnect (disconnected{willRetry:true}) if not stale-dropped.
    expect(
      h.states.filter(
        (s) => s.status === "disconnected" && s.willRetry === true,
      ),
    ).toEqual([]);
    expect(h.states.at(-1)).toMatchObject({
      status: "disconnected",
      willRetry: false,
    });
    expect(h.events).toEqual([{ type: "auth_failure", refreshable: false }]);
  });

  it("dispose() on an OPENED live wrapper: re-entrant close is stale-dropped — exactly one terminal frame, no spurious willRetry:true, no events", () => {
    const h = makeHarness({ opened: true });

    h.lifecycle.dispose();

    expect(h.ws.closeCalls).toBeGreaterThanOrEqual(1);
    expect(
      h.states.filter(
        (s) => s.status === "disconnected" && s.willRetry === true,
      ),
    ).toEqual([]);
    expect(h.states.at(-1)).toMatchObject({
      status: "disconnected",
      willRetry: false,
    });
    // dispose() emits no notification events.
    expect(h.events).toEqual([]);
    expect(h.dropCalls).toBe(1);
    expect(h.abortCalls).toBe(0);
  });
});
