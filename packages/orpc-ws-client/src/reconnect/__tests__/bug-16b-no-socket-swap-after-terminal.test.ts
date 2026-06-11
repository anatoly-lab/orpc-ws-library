// Bug 16b regression — no socket swap after the client goes TERMINAL.
//
// The race: terminal teardown lands while a refresh is still in flight —
// e.g. a heartbeat-timeout `reconnect()` awaits its refresh when a GENUINE
// storm trips `tryAuthRecovery` into terminal (a prior auth-recovery
// refresh completed, then auth failed again within the window — the F2
// join/provenance fix narrows but does not remove this path), or a 4005
// kick / no-tokenProvider terminal fires at composition level. The
// late-resolving refresh then reaches `swapSocket` — which, without the
// composition root's unified `isDead` predicate (disposed / terminal /
// kicked), would build a brand-new WebSocket after terminal and let
// `handleOpen` flip state back to `connected` (zombie-after-terminal).
//
// Tested at the TokenRefreshHandler level (same shape as bug-12's
// post-dispose refusal): a REAL handler, a refresh promise the test holds
// open, and the terminal flag flipped mid-flight — deterministic where the
// composition-level interleave (real server + heartbeat timing) is not.

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";
import type { Logger } from "@repo/orpc-ws-shared";

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

// Same harness shape as bug-16's buildHandler: the TEST controls when the
// refresh settles, plus a settable `terminal` flag standing in for the
// composition root's `terminalAuthFired` latch.
function buildHandler() {
  const pending: Array<(token: string | null) => void> = [];
  const refresh = vi.fn(
    (): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        pending.push(resolve);
      }),
  );
  const resolveRefresh = (token: string | null): void => {
    for (const r of pending.splice(0)) r(token);
  };
  const tokenProvider = {
    getToken: vi.fn((): string | null => "current-token"),
    refresh,
  } as TokenProvider;

  let terminal = false;
  const setTerminal = (): void => {
    terminal = true;
  };

  const holder = new WebSocketHolder();
  const create = vi.fn(
    (): ReconnectingWebSocket =>
      ({ close: vi.fn() }) as unknown as ReconnectingWebSocket,
  );
  const factory = { create } as unknown as WebSocketFactory;
  const linkClearer = vi.fn();

  const handler = new TokenRefreshHandler({
    tokenProvider,
    websocketHolder: holder,
    websocketFactory: factory,
    urlBuilder: (t: string | null) => `wss://example.test/${t ?? "no-token"}`,
    getEventHandlers: vi.fn<() => WebSocketEventHandlers>(() => ({
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })),
    reconnectConfig: makeReconnectConfig(),
    linkClearer,
    isDead: () => terminal,
    logger: makeLogger(),
  });

  return { handler, refresh, resolveRefresh, setTerminal, holder, create, linkClearer };
}

describe("Bug 16b — a refresh that resolves after terminal must not swap in a new socket", () => {
  it("terminal trips while refresh is in flight: websocketFactory.create is never called", async () => {
    const ctx = buildHandler();

    // Heartbeat-timeout path: reconnect() → refreshAndReconnect(), whose
    // tokenProvider.refresh() is now in flight (held by the test).
    const p = ctx.handler.refreshAndReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.create).not.toHaveBeenCalled();

    // TERMINAL teardown runs (composition root flips `terminalAuthFired`
    // — genuine storm, 4005 kick, or no-tokenProvider path; the handler
    // doesn't care which) — all BEFORE the in-flight refresh settles.
    ctx.setTerminal();

    // The IdP now answers with a perfectly good token — too late.
    ctx.resolveRefresh("fresh-token");
    // The refusal lives at the swap layer, not in the return value: the
    // refresh DID succeed, so refreshAndReconnect still reports true; the
    // manager's own terminal latch ignores it.
    expect(await p).toBe(true);

    // THE guard: no new WebSocket is built after terminal. Pre-fix
    // (isDisposed checked only `disposed`), create() ran here, the holder
    // got a live socket, and handleOpen flipped state back to `connected`.
    expect(ctx.create).not.toHaveBeenCalled();
    expect(ctx.holder.get()).toBeNull();
    // swapSocket bailed before touching the link cache or the holder's
    // current-token record — the dead client stays untouched.
    expect(ctx.linkClearer).not.toHaveBeenCalled();
    expect(ctx.holder.getCurrentToken()).toBeNull();
  });
});
