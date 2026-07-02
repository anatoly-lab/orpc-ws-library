// Bug 22 regression — a client that dies DURING swapSocket's close must not
// get a new socket.
//
// `swapSocket` checked `isDead?.()` only at ENTRY. But partysocket 1.3.0
// dispatches `close` synchronously from `close()`, and the close fan-out
// runs arbitrary listeners on the wrapper (our handlers, bidi/orpc wiring,
// consumer callbacks) — any of which can dispose the client or drive it
// terminal/kicked while `close()` is still on the stack. Pre-fix the swap
// then RESUMED: it built a brand-new socket, installed it in the holder,
// and `handleOpen` flipped state back to `connected` AFTER the consumer
// was told the client is dead (zombie-after-terminal — the same failure
// class as Bug 16b, but through the synchronous-close window the entry
// check cannot see).
//
// Fix under test: swapSocket RE-CHECKS `isDead?.()` after the `close()`
// call and bails before `websocketFactory.create(...)`. This is
// deliberately independent of the Bug-21 CLEAR-BEFORE-CLOSE fix (which
// stale-drops OUR OWN re-entrant close handler): defense in depth against
// every OTHER listener on the wrapper.
//
// Same harness shape as bug-16b (which pins the ENTRY check for deaths
// landing while the refresh is in flight): a real TokenRefreshHandler and
// a `dead` flag standing in for the composition root's unified isDead
// predicate — here flipped synchronously FROM the wrapper's close().

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";
import type { Logger } from "@orpc-ws/shared";

import { WebSocketHolder } from "../../state/websocket-holder.js";
import type { WebSocketFactory } from "../../lifecycle/websocket-factory.js";
import type {
  ReconnectConfig,
  WebSocketEventHandlers,
} from "../../lifecycle/types.js";
import type { TokenProvider } from "../../auth/token-provider.js";

import { TokenRefreshHandler } from "../token-refresh-handler.js";

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
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

describe("Bug 22 — client goes terminal during swapSocket's synchronous close", () => {
  it("close() fires terminal inline: no new WebSocket is created, holder stays empty", () => {
    let dead = false;

    const holder = new WebSocketHolder();
    const create = vi.fn(
      (): ReconnectingWebSocket =>
        ({ close: vi.fn() }) as unknown as ReconnectingWebSocket,
    );
    const factory = { create } as unknown as WebSocketFactory;

    const handler = new TokenRefreshHandler({
      tokenProvider: {
        getToken: vi.fn((): string | null => "current-token"),
        refresh: vi.fn(async (): Promise<string | null> => "fresh-token"),
      } as TokenProvider,
      websocketHolder: holder,
      websocketFactory: factory,
      urlBuilder: (t: string | null) => `wss://example.test/${t ?? "no-token"}`,
      getEventHandlers: vi.fn<() => WebSocketEventHandlers>(() => ({
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onError: vi.fn(),
      })),
      reconnectConfig: makeReconnectConfig(),
      linkClearer: vi.fn(),
      isDead: () => dead,
      logger: makeLogger(),
    });

    // The OLD wrapper's close() — dispatched SYNCHRONOUSLY by partysocket —
    // drives the client terminal while swapSocket's close() call is still
    // on the stack (stand-in for any close listener firing
    // fireTerminalAuthFailure / dispose / a 4005 kick).
    const oldWs = {
      close: vi.fn(() => {
        dead = true;
      }),
    } as unknown as ReconnectingWebSocket;
    holder.set(oldWs);

    // Entry check passes (`dead` is still false) — only the post-close
    // re-check can catch this death.
    handler.reconnectWithNewToken("fresh-token");

    // The old wrapper was closed…
    expect(oldWs.close).toHaveBeenCalledTimes(1);
    // …and THE guard: no new socket after death. Pre-fix create() ran here,
    // the holder got a live socket, and handleOpen flipped a client the
    // consumer had already been told was dead back to `connected`.
    expect(create).not.toHaveBeenCalled();
    expect(holder.get()).toBeNull();
    // The fresh token was stamped BEFORE the close (so the synchronous
    // fan-out saw it — Bug-21 follow-up), but the dead-bail re-clears it:
    // the dead client's cleared state stays cleared.
    expect(holder.getCurrentToken()).toBeNull();
  });
});
