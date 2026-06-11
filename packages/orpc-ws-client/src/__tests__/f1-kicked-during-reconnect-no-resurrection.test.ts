// F1 regression — a reconnect armed BEFORE a 4005 kick must not complete
// AFTER it and resurrect the session.
//
// docs review finding F1: the client has THREE terminal states —
// `disposed`, terminal auth failure, and `kicked` (session replaced,
// close 4005). The one-way-door guards (Bug 12 / Bug 14 / Bug 16b)
// covered only the first two: the ReconnectManager's entry/after-await
// checks and the TokenRefreshHandler's swap predicate read
// `disposed || terminalAuthFired`, never `kicked`. So an auth-recovery
// refresh that was in flight when a 4005 landed would resolve, reach
// `swapSocket`, build a brand-new WebSocket on a kicked client, and
// `handleOpen` flipped `kicked` back to `connected` — this tab stole the
// session back from the tab that legitimately replaced it, and the two
// tabs then 4005-kick each other forever.
//
// Fix under test (composition level, real stub server speaking raw WS):
// the unified `isDead` predicate (disposed/terminal/KICKED) is wired into
// both the ReconnectManager and the TokenRefreshHandler, and the 4005
// branch's `onKicked` teardown clears the link/holder. After the kick:
//   1. The late-resolving refresh creates NO new socket (no upgrade
//      reaches the server).
//   2. State STAYS `kicked` — no `connected` (or any other) frame after
//      the kick.
//
// DETERMINISM — why this harness is shaped the way it is:
//   * The server HOLDS connection #1 open and only closes it with 1008 on
//     the test's command (`rejectFirstWith1008`), AFTER the client is
//     observed `connected`. That removes the open-vs-close race: the
//     attempt has provably opened, so the 1008 routes to auth-recovery
//     (not a pre-open/normal-disconnect decision) every time.
//   * `minRefreshIntervalMs: 0` neutralises the storm guard. This is
//     deliberate isolation: partysocket@1.1.19 (over Node `ws`) delivers
//     each `close` event TWICE (verified: one server close → two
//     `onclose` callbacks), so a single 1008 produces two auth-recovery
//     entries ~1ms apart. With the default 30s window the SECOND entry
//     trips the storm guard → terminal, pre-empting the `kicked` we are
//     here to exercise. Zeroing the window lets both entries coalesce on
//     the single-flighted, test-held refresh so the client stays alive
//     until the 4005 kick arrives. (That double-fire-trips-storm-guard
//     interaction is its own finding — F2 — tracked separately; it is NOT
//     what this test is about.)
//   * The refresh promise is held open by the TEST and resolved only
//     after `kicked` is observed — the exact "armed before, completes
//     after" interleaving, without racing real heartbeat timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import {
  createOrpcWsClient,
  type ConnectionState,
  type OrpcWsClient,
} from "../index.js";
import type { TokenProvider } from "../auth/token-provider.js";

type StubContract = Record<string, never>;

interface KickingServerHandle {
  url: string;
  /** Count of upgrade attempts that reached the server. */
  upgradeCount: () => number;
  /** Close the held-open first connection with 1008 (auth reject). */
  rejectFirstWith1008: () => void;
  close: () => Promise<void>;
}

/**
 * HTTP + WS server that arms the race deterministically: connection #1 is
 * HELD OPEN (so the client reaches `connected`) until the test calls
 * `rejectFirstWith1008()`, which closes it 1008 → the client starts auth
 * recovery (whose refresh the test holds open). Every SUBSEQUENT
 * connection — partysocket's retry after that 1008 — is closed with 4005
 * (session replaced → the client goes `kicked` while the refresh is still
 * in flight).
 */
async function spinUpKickingServer(): Promise<KickingServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let upgrades = 0;
  let firstConn: WsWebSocket | null = null;

  wss.on("connection", (ws: WsWebSocket) => {
    upgrades += 1;
    if (upgrades === 1) {
      // Hold open — closed on the test's command so the 1008 lands on a
      // provably-opened attempt (deterministic auth-recovery routing).
      firstConn = ws;
    } else {
      // The retry that follows the 1008 — kick it.
      ws.close(4005, "Session replaced");
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}`,
    upgradeCount: () => upgrades,
    rejectFirstWith1008: () => {
      firstConn?.close(1008, "Auth rejected");
    },
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tight partysocket retry knobs: after the 1008, the wrapper redials
 * within tens of ms — landing on the server's 4005 branch while the
 * test-held refresh is still pending. `minRefreshIntervalMs: 0` disables
 * the storm guard (see the file header for why).
 */
const FAST_RETRY = {
  minReconnectionDelay: 20,
  maxReconnectionDelay: 40,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 500,
  minRefreshIntervalMs: 0,
};

describe("F1 — kicked during an in-flight reconnect: no resurrection (composition root)", () => {
  let server: KickingServerHandle;
  let client: OrpcWsClient<StubContract> | null = null;

  beforeEach(async () => {
    server = await spinUpKickingServer();
  });

  afterEach(async () => {
    if (client) {
      try {
        client.dispose();
      } catch {
        // tolerated
      }
      client = null;
    }
    await server.close();
  });

  /**
   * Drives the shared "armed reconnect, then kicked, refresh still in
   * flight" interleaving and returns the observation points. The caller
   * resolves the held refresh (good token or null) and asserts.
   */
  async function driveToKickedWithRefreshInFlight(opts: {
    onTerminalAuthFailure: () => void;
  }): Promise<{
    resolveRefresh: (token: string | null) => void;
    refresh: ReturnType<typeof vi.fn>;
    frames: ConnectionState[];
    upgradesAtKick: number;
    framesAtKick: number;
  }> {
    let resolveRefresh: (token: string | null) => void = () => {};
    const refresh = vi.fn(
      (): Promise<string | null> =>
        new Promise<string | null>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const tokenProvider: TokenProvider = {
      getToken: () => "tok-current",
      refresh,
    };

    client = createOrpcWsClient<StubContract>({
      url: server.url,
      tokenProvider,
      onTerminalAuthFailure: opts.onTerminalAuthFailure,
      reconnect: FAST_RETRY,
      sleepDetection: false,
    });

    // Record every state frame so we can prove nothing follows `kicked`.
    const frames: ConnectionState[] = [];
    client.state.subscribe(() => {
      frames.push(client!.state.getState());
    });

    client.connect();

    // Connection #1 is held open → the client reaches `connected`. This is
    // the determinism anchor: the next close lands on an opened attempt.
    await waitUntil(() => client!.state.getState().status === "connected");

    // Reject connection #1 → auth recovery → tryAuthRecovery → refresh()
    // in flight (held by the test).
    server.rejectFirstWith1008();
    await waitUntil(() => refresh.mock.calls.length >= 1);

    // partysocket's retry redials with the stale token; the server 4005s
    // it → state `kicked`, wrapper closed, onKicked teardown clears the
    // link/holder — all while the refresh is still pending.
    await waitUntil(() => client!.state.getState().status === "kicked");

    return {
      resolveRefresh,
      refresh,
      frames,
      upgradesAtKick: server.upgradeCount(),
      framesAtKick: frames.length,
    };
  }

  it("a refresh resolving after the 4005 kick creates no socket and state stays kicked", async () => {
    const onTerminalAuthFailure = vi.fn();
    const { resolveRefresh, refresh, frames, upgradesAtKick, framesAtKick } =
      await driveToKickedWithRefreshInFlight({ onTerminalAuthFailure });

    // The IdP now answers the held refresh with a perfectly good token —
    // too late. Pre-fix this reached `swapSocket` (the guard checked only
    // disposed/terminal), dialed a new upgrade, and `handleOpen` flipped
    // `kicked` → `connected`.
    resolveRefresh("tok-fresh");

    // Grace window covering several would-be retry/connect intervals.
    await sleep(300);

    // (1) No resurrection: no new socket reached the server.
    expect(server.upgradeCount()).toBe(upgradesAtKick);
    // (2) `kicked` is a one-way door: no state frame of ANY kind after it.
    expect(client!.state.getState()).toEqual({
      status: "kicked",
      reason: "session_replaced",
    });
    expect(frames.slice(framesAtKick)).toEqual([]);
    // A kicked client must not be re-labeled as a terminal AUTH failure
    // either — the refresh succeeded; the session was simply replaced.
    expect(onTerminalAuthFailure).not.toHaveBeenCalled();
    // The refresh ran exactly once (single-flighted across the duplicate
    // close-event deliveries) — the kick must not trigger further IdP
    // traffic.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refresh resolving NULL after the 4005 kick does not relabel kicked as a terminal auth failure", async () => {
    // Same armed race, but the IdP answer is a FAILED refresh (null). The
    // good-token case never reaches the `!ok` branch of `tryAuthRecovery`
    // — this case does, and pre-fix that branch fired
    // `fireTerminalAuthFailure` on the kicked client: state was overwritten
    // `kicked` → `disconnected({willRetry: false})` and the consumer was
    // told "terminal auth failure" for a session that was simply replaced
    // from another tab. Post-fix the after-await `isStopped()` re-check in
    // `tryAuthRecovery` AND the `isStopped()` guard inside
    // `fireTerminalAuthFailure` both refuse: kicked is the final word.
    const onTerminalAuthFailure = vi.fn();
    const { resolveRefresh, refresh, frames, upgradesAtKick, framesAtKick } =
      await driveToKickedWithRefreshInFlight({ onTerminalAuthFailure });

    // The IdP reports the refresh FAILED. On a live client this is the
    // terminal-auth-failure trigger; on a kicked one it must be discarded.
    resolveRefresh(null);

    // Grace window covering several would-be retry/connect intervals.
    await sleep(300);

    // No socket was dialed off the failed refresh.
    expect(server.upgradeCount()).toBe(upgradesAtKick);
    // `kicked` was NOT overwritten with `disconnected({willRetry: false})`
    // — no state frame of ANY kind after the kick.
    expect(client!.state.getState()).toEqual({
      status: "kicked",
      reason: "session_replaced",
    });
    expect(frames.slice(framesAtKick)).toEqual([]);
    // And the consumer was never told "terminal auth failure" — a replaced
    // session is not an auth problem.
    expect(onTerminalAuthFailure).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
