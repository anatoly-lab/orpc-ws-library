// Bug 21 regression — swapSocket's own close must not re-enter the
// close-decision tree as a live event.
//
// partysocket 1.3.0 dispatches `close` SYNCHRONOUSLY from `close()`, and
// for a wrapper closed MID-HANDSHAKE (never opened) it synthesizes the
// pre-open code-1000 shape. `swapSocket` used to call `ws.close()` while
// the holder still pointed at the wrapper — under a comment falsely
// claiming the close fires async and gets stale-dropped. Because the
// wrapper was still current, the re-entrant close ran the FULL decision
// tree: 1000-before-open → `auth-recovery` (Bug 4 branch) →
// `tryAuthRecovery` → storm-guard trip (the refresh that caused this very
// swap had JUST stamped the window) → spurious `fireTerminalAuthFailure()`.
// Net effect: a SUCCESSFUL token refresh logged the user out; under cookie
// auth a routine sleep-wake reconnect became a force-logout.
//
// Fix under test (CLEAR-BEFORE-CLOSE in swapSocket, mirroring dispose() /
// fireTerminalAuthFailure() — see sync-close-no-spurious-emit.test.ts for
// those paths): the link + holder are cleared BEFORE the captured wrapper
// is closed, so the re-entrant close fails the wrapper-equality check
// (Bug 9 stale-WS guard) and is silently dropped. The swap then proceeds:
// new socket installed, opens, state → connected.
//
// This test drives the REAL EventHandlers (so the re-entrant close routes
// through the genuine close-decision tree) AND the REAL TokenRefreshHandler,
// with fake wrappers whose `close()` dispatches `onclose` synchronously —
// the same harness shape as sync-close-no-spurious-emit.test.ts.

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { ConnectionStateManager } from "../../state/connection-state.js";
import { WebSocketHolder } from "../../state/websocket-holder.js";
import {
  connected,
  connecting,
  disconnected,
  type ConnectionState,
} from "../../state/types.js";

import { EventHandlers } from "../../lifecycle/event-handlers.js";
import { ClientLifecycle } from "../../lifecycle/client-lifecycle.js";
import type { WebSocketFactory } from "../../lifecycle/websocket-factory.js";
import type {
  ReconnectConfig,
  WebSocketEventHandlers,
} from "../../lifecycle/types.js";
import type { TokenProvider } from "../../auth/token-provider.js";
import type { LinkFactory } from "../../client/link-factory.js";
import type { HeartbeatMonitor } from "../../heartbeat/monitor.js";
import type { HeartbeatSubscriber } from "../../heartbeat/subscriber.js";

import { TokenRefreshHandler } from "../token-refresh-handler.js";
import type { ReconnectManager } from "../reconnect-manager.js";

// ---- Fake partysocket wrapper: synchronous close (partysocket 1.3.0). ----

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeWrapper {
  readyState = CONNECTING;
  onclose: ((event: unknown) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  closeCalls = 0;

  // partysocket 1.3.0: `close()` on a mid-handshake wrapper flips
  // readyState→CLOSED and dispatches the SYNTHETIC pre-open close —
  // code 1000, empty reason — SYNCHRONOUSLY, re-entering our handleClose
  // inline before `close()` returns. Mirrored exactly: this is the window
  // the bug needs.
  close(code = 1000): void {
    this.closeCalls += 1;
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code, reason: "", wasClean: true });
  }
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeReconnectConfig(): ReconnectConfig {
  return {
    maxRetries: 5,
    maxReconnectionDelay: 10_000,
    minReconnectionDelay: 1_000,
    reconnectionDelayGrowFactor: 1.3,
    connectionTimeout: 5_000,
    maxEnqueuedMessages: 0,
    debounceMs: 100,
    jitterMs: 1_000,
    minRefreshIntervalMs: 30_000,
  };
}

describe("Bug 21 — swapSocket's synchronous re-entrant close is stale-dropped", () => {
  it(
    "refresh-success swap on a mid-handshake wrapper: no auth-recovery " +
      "trigger, no spurious disconnected frame; new socket opens → connected",
    async () => {
      const state = new ConnectionStateManager(connecting());
      const holder = new WebSocketHolder();
      const onAuthRecoveryNeeded = vi.fn();
      const logger = makeLogger();

      // REAL EventHandlers so the re-entrant close routes through the
      // genuine close-decision tree (the pre-fix failure path).
      const eventHandlers = new EventHandlers({
        connectionState: state,
        websocketHolder: holder,
        onAuthRecoveryNeeded,
        logger,
      });

      // Factory stub that wires each created wrapper exactly as the real
      // WebSocketFactory does: closure-bind the wrapper into the handler
      // triple it received.
      const created: FakeWrapper[] = [];
      const create = vi.fn(
        (
          _url: unknown,
          handlers: WebSocketEventHandlers,
          _config: ReconnectConfig,
        ): ReconnectingWebSocket => {
          const ws = new FakeWrapper();
          ws.onclose = (e) => handlers.onClose(e, ws as never);
          ws.onopen = (e) => handlers.onOpen(e, ws as never);
          created.push(ws);
          return ws as unknown as ReconnectingWebSocket;
        },
      );
      const factory = { create } as unknown as WebSocketFactory;

      const tokenProvider: TokenProvider = {
        getToken: vi.fn(() => "fresh-token"),
        refresh: vi.fn(async () => "fresh-token"),
      };

      const handler = new TokenRefreshHandler({
        tokenProvider,
        websocketHolder: holder,
        websocketFactory: factory,
        urlBuilder: (t) => `wss://example.test/?token=${t ?? ""}`,
        getEventHandlers: () =>
          eventHandlers.createHandlers({} as unknown as ReconnectingWebSocket),
        reconnectConfig: makeReconnectConfig(),
        linkClearer: vi.fn(),
        logger,
      });

      // The OLD wrapper is LIVE in the holder and still MID-HANDSHAKE
      // (never opened) — e.g. a sleep-wake reconnect fired while partysocket
      // was still retrying with the stale token. This is exactly the shape
      // whose close() synthesizes the pre-open 1000.
      const oldWs = new FakeWrapper();
      const oldHandlers = eventHandlers.createHandlers(
        oldWs as unknown as ReconnectingWebSocket,
      );
      oldWs.onclose = (e) => oldHandlers.onClose(e, oldWs as never);
      holder.set(oldWs as unknown as ReconnectingWebSocket);

      const frames: ConnectionState[] = [];
      state.subscribe(() => frames.push(state.getState()));

      // Successful refresh → swapSocket → oldWs.close() → SYNC re-entrant
      // pre-open-1000 close.
      await expect(handler.refreshAndReconnect()).resolves.toBe(true);

      // The old wrapper WAS closed (which re-entered handleClose inline)…
      expect(oldWs.closeCalls).toBeGreaterThanOrEqual(1);
      // …but the re-entrant close was stale-dropped: no auth-recovery
      // trigger (pre-fix this fired with (1000, "pre-open-1000") and the
      // storm guard escalated it to terminal), no disconnected frame.
      expect(onAuthRecoveryNeeded).not.toHaveBeenCalled();
      expect(frames.filter((f) => f.status === "disconnected")).toEqual([]);

      // The swap completed: a new socket was built and installed.
      expect(create).toHaveBeenCalledTimes(1);
      const newWs = created[0]!;
      expect(holder.get()).toBe(newWs as unknown as ReconnectingWebSocket);

      // The new socket's handshake completes → connected. The client rode
      // through the refresh seamlessly instead of logging out.
      newWs.onopen?.({});
      expect(state.getState()).toEqual({ status: "connected" });
    },
  );

  // Follow-up hazard the CLEAR-BEFORE-CLOSE fix re-opens: between
  // `holder.clear()` and `holder.set(newWs)` the holder is null, so the
  // Bug-13 guard in `ClientLifecycle.connect()` ("a wrapper in the holder
  // means the library already owns reconnect") PASSES for a consumer
  // calling `client.connect()` from inside the synchronous close fan-out
  // (orpc/bidi abort listeners run consumer code inline; dispose()/terminal
  // have latches blocking connect(), a plain swap has none). Pre-fix the
  // swap then RESUMED and created a SECOND socket, orphaning the
  // re-entrant one — never closed, retrying forever; under the server's
  // singleConnectionPerUser the two 4005-kick each other in a loop.
  //
  // Fix under test: after the close (and the Bug-22 deadness re-check),
  // swapSocket re-checks the holder — if a re-entrant connect() already
  // stood up a socket, the swap bails instead of duplicating. The
  // re-entrant socket carries the FRESH token: the swap stamps
  // `holder.setCurrentToken(token)` BEFORE the close, and connect()'s
  // urlProvider reads `tokenProvider.getToken()` (in sync with the refresh
  // result per the TokenProvider contract, Bug 1).
  it(
    "consumer calls connect() synchronously from the close fan-out: exactly " +
      "ONE socket (the re-entrant one, on the fresh token) exists after the swap",
    async () => {
      // Realistic shape: a 1008 close already moved state to
      // disconnected({willRetry:true}) and kicked off the auth recovery
      // whose successful refresh drives this swap — so connect()'s status
      // guard does not filter the re-entrant call.
      const state = new ConnectionStateManager(
        disconnected({ code: 1008, willRetry: true }),
      );
      const holder = new WebSocketHolder();
      const onAuthRecoveryNeeded = vi.fn();
      const logger = makeLogger();

      const eventHandlers = new EventHandlers({
        connectionState: state,
        websocketHolder: holder,
        onAuthRecoveryNeeded,
        logger,
      });

      const created: FakeWrapper[] = [];
      const create = vi.fn(
        (
          _url: unknown,
          handlers: WebSocketEventHandlers,
          _config: ReconnectConfig,
        ): ReconnectingWebSocket => {
          const ws = new FakeWrapper();
          ws.onclose = (e) => handlers.onClose(e, ws as never);
          ws.onopen = (e) => handlers.onOpen(e, ws as never);
          created.push(ws);
          return ws as unknown as ReconnectingWebSocket;
        },
      );
      const factory = { create } as unknown as WebSocketFactory;

      const tokenProvider: TokenProvider = {
        getToken: vi.fn(() => "fresh-token"),
        refresh: vi.fn(async () => "fresh-token"),
      };

      // REAL ClientLifecycle so the re-entrant connect() runs the genuine
      // Bug-13 guard (the guard that passes mid-swap is the hazard).
      // Collaborators connect() doesn't touch are minimal stubs.
      const lifecycle = new ClientLifecycle({
        connectionState: state,
        websocketHolder: holder,
        linkFactory: { clearLink: vi.fn() } as unknown as LinkFactory,
        heartbeatMonitor: { stop: vi.fn() } as unknown as HeartbeatMonitor,
        heartbeatSubscriber: {
          drop: vi.fn(),
        } as unknown as HeartbeatSubscriber,
        websocketFactory: factory,
        reconnectConfig: makeReconnectConfig(),
        urlProvider: () => {
          const t = tokenProvider.getToken();
          holder.setCurrentToken(t);
          return `wss://example.test/?token=${t ?? ""}`;
        },
        createHandlers: () =>
          eventHandlers.createHandlers({} as unknown as ReconnectingWebSocket),
        getSleepDetector: () => null,
        getReconnectManager: () =>
          ({ dispose: vi.fn() }) as unknown as ReconnectManager,
        emit: vi.fn(),
        logger,
      });

      const handler = new TokenRefreshHandler({
        tokenProvider,
        websocketHolder: holder,
        websocketFactory: factory,
        urlBuilder: (t) => `wss://example.test/?token=${t ?? ""}`,
        getEventHandlers: () =>
          eventHandlers.createHandlers({} as unknown as ReconnectingWebSocket),
        reconnectConfig: makeReconnectConfig(),
        linkClearer: vi.fn(),
        connectionState: state,
        isDead: lifecycle.isDead,
        logger,
      });

      // Old wrapper: live in the holder, mid-handshake. Its close fan-out
      // runs the library handler (stale-dropped) and then a CONSUMER
      // listener that re-enters connect() — the inline-listener shape the
      // synchronous close makes reachable.
      const oldWs = new FakeWrapper();
      const oldHandlers = eventHandlers.createHandlers(
        oldWs as unknown as ReconnectingWebSocket,
      );
      let tokenDuringFanOut: string | null | undefined;
      oldWs.onclose = (e) => {
        oldHandlers.onClose(e, oldWs as never);
        tokenDuringFanOut = holder.getCurrentToken();
        lifecycle.connect();
      };
      holder.set(oldWs as unknown as ReconnectingWebSocket);

      await expect(handler.refreshAndReconnect()).resolves.toBe(true);

      // The fan-out saw the FRESH token (stamped before the close), so the
      // re-entrant connect() was built against it — not a null/stale one.
      expect(tokenDuringFanOut).toBe("fresh-token");
      // Exactly ONE socket was created — the re-entrant connect()'s. The
      // swap detected the occupied holder and did NOT create a duplicate
      // (pre-fix: create() ran twice, the first socket was orphaned and the
      // pair 4005-kicked each other under singleConnectionPerUser).
      expect(create).toHaveBeenCalledTimes(1);
      const reentrantWs = created[0]!;
      expect(holder.get()).toBe(reentrantWs as unknown as ReconnectingWebSocket);

      // The surviving socket opens → connected. One live connection, fresh
      // token, no self-kick setup.
      reentrantWs.onopen?.({});
      expect(state.getState()).toEqual({ status: "connected" });
    },
  );

  // State-truthfulness companion (Bug 15 parity): the CLEAR-BEFORE-CLOSE
  // fix stale-drops the old wrapper's own close, so a swap tearing down an
  // OPENED wrapper (sleep-wake reconnect / upload-401 recovery arrive with
  // state `connected`) would emit NO disconnected frame at all —
  // `client.state` would claim `connected` over a dead link until the NEW
  // socket opened (indefinitely, if the server were down). swapSocket now
  // sets `disconnected({willRetry: true})` itself, guarded on `connected`.
  it(
    "swap on an OPENED wrapper emits a truthful disconnected frame at swap " +
      "start — state never claims connected over a dead link",
    () => {
      const state = new ConnectionStateManager(connected());
      const holder = new WebSocketHolder();
      const onAuthRecoveryNeeded = vi.fn();
      const logger = makeLogger();

      const eventHandlers = new EventHandlers({
        connectionState: state,
        websocketHolder: holder,
        onAuthRecoveryNeeded,
        logger,
      });

      const created: FakeWrapper[] = [];
      let stateAtCreate: ConnectionState | null = null;
      const create = vi.fn(
        (
          _url: unknown,
          handlers: WebSocketEventHandlers,
          _config: ReconnectConfig,
        ): ReconnectingWebSocket => {
          // Capture what the consumer observes at the moment the new socket
          // is stood up — the disconnected frame must land BEFORE this.
          stateAtCreate = state.getState();
          const ws = new FakeWrapper();
          ws.onclose = (e) => handlers.onClose(e, ws as never);
          ws.onopen = (e) => handlers.onOpen(e, ws as never);
          created.push(ws);
          return ws as unknown as ReconnectingWebSocket;
        },
      );
      const factory = { create } as unknown as WebSocketFactory;

      const handler = new TokenRefreshHandler({
        tokenProvider: {
          getToken: vi.fn(() => "current-token"),
          refresh: vi.fn(async () => "current-token"),
        },
        websocketHolder: holder,
        websocketFactory: factory,
        urlBuilder: (t) => `wss://example.test/?token=${t ?? ""}`,
        getEventHandlers: () =>
          eventHandlers.createHandlers({} as unknown as ReconnectingWebSocket),
        reconnectConfig: makeReconnectConfig(),
        linkClearer: vi.fn(),
        connectionState: state,
        logger,
      });

      // Old wrapper: OPENED and live — the sleep-wake shape (state is
      // `connected`, no close event has fired).
      const oldWs = new FakeWrapper();
      oldWs.readyState = OPEN;
      const oldHandlers = eventHandlers.createHandlers(
        oldWs as unknown as ReconnectingWebSocket,
      );
      oldWs.onclose = (e) => oldHandlers.onClose(e, oldWs as never);
      holder.set(oldWs as unknown as ReconnectingWebSocket);
      holder.markCurrentAttemptOpened();

      const frames: ConnectionState[] = [];
      state.subscribe(() => frames.push(state.getState()));

      // Sleep-wake reconnect within the storm window: rebuild on the
      // current token, no refresh.
      handler.reconnectWithCurrentToken();

      // The truthful frame landed at swap start, BEFORE the new socket
      // existed — and the old wrapper's own close stayed stale-dropped
      // (no auth-recovery trigger, the Bug-21 fix intact).
      expect(frames[0]).toEqual({ status: "disconnected", willRetry: true });
      expect(stateAtCreate).toEqual({
        status: "disconnected",
        willRetry: true,
      });
      expect(onAuthRecoveryNeeded).not.toHaveBeenCalled();
      expect(oldWs.closeCalls).toBeGreaterThanOrEqual(1);

      // The new socket opens → connected. Full truthful sequence:
      // connected → disconnected(willRetry) → connected.
      expect(create).toHaveBeenCalledTimes(1);
      created[0]!.onopen?.({});
      expect(state.getState()).toEqual({ status: "connected" });
    },
  );
});
