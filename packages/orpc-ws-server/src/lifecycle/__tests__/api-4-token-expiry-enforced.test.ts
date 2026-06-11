// API-4 regression — opt-in token-expiry enforcement on live connections.
//
// docs/fable/security-review.md API-4: auth runs once, pre-101, and the
// token's `exp` was never read again — a 15-minute token yielded an
// effectively unbounded session because the heartbeat kept the socket
// alive indefinitely.
//
// Fix under test:
//   - `VerifyClientResult` success variant carries optional `expiresAt`
//     (epoch MILLISECONDS — the `Clock.now()` unit; JWT `exp` seconds are
//     converted by the verifier).
//   - `ConnectionConfig.enforceTokenExpiry` (default `false`): when on
//     AND the verify result carries `expiresAt`, the ConnectionHandler
//     schedules — via the injected Clock — a close with
//     `authFailedCloseCode` (4001, "Token expired") at that instant.
//   - The timer is cleared on connection close (no leak).
//   - Default-off: NOTHING is scheduled — zero behavior change for
//     existing consumers.
//
// ConnectionHandler unit tests with a fake clock + fake ws — fully
// deterministic, no real sockets.

import { describe, expect, it, vi } from "vitest";

import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";

import type { Clock, TimerHandle } from "@repo/orpc-ws-shared";

import { ConnectionHandler } from "../connection-handler.js";
import {
  VerifyClientOrchestrator,
  type VerifyClientResult,
} from "../verify-client-orchestrator.js";
import { ConnectionRegistry } from "../../state/connection-registry.js";
import { DEFAULT_CONNECTION_CONFIG } from "../../config/connection-config.js";
import type { WsPingPong } from "../../heartbeat/ws-ping-pong.js";

interface TestUser {
  sub: string;
}

// ---------- Fake clock ----------

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => void;
  getPending: () => FakeTimer[];
} {
  let now = initial;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const toHandle = (t: FakeTimer): TimerHandle => t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeTimer => h as unknown as FakeTimer;

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { id: nextId++, fireAt: now + ms, fn, cancelled: false };
      timers.push(t);
      return toHandle(t);
    },
    clearTimeout: (handle) => {
      fromHandle(handle).cancelled = true;
    },
    setInterval: () => {
      throw new Error("setInterval not expected in these tests");
    },
    clearInterval: () => {
      throw new Error("clearInterval not expected in these tests");
    },
  };

  // Synchronous advance — the expiry watchdog body is sync (ws.close).
  const advance = (ms: number): void => {
    now += ms;
    let safety = 1000;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      const next = due[0];
      if (!next) break;
      const idx = timers.indexOf(next);
      if (idx >= 0) timers.splice(idx, 1);
      next.fn();
    }
  };

  const getPending = () => timers.filter((t) => !t.cancelled).slice();

  return { clock, advance, getPending };
}

// ---------- Fake ws ----------

interface FakeWs {
  close: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (...args: never[]) => void) => void;
  /** Test helper — fire the registered 'close' listener like `ws` would. */
  emitClose: (code: number) => void;
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  return {
    close: vi.fn(),
    on: (event, cb) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    emitClose: (code: number) => {
      for (const cb of listeners.get("close") ?? []) {
        (cb as (code: number, reason: Buffer) => void)(code, Buffer.alloc(0));
      }
    },
  };
}

// ---------- Harness ----------

/**
 * Build a ConnectionHandler wired with real registry + real verify
 * orchestrator (primed through its actual `verifyClient` path, so the
 * WeakMap bridge is exercised honestly) and run `handle()` on a fake ws.
 */
async function runConnection(opts: {
  enforceTokenExpiry?: boolean;
  expiresAt?: number;
  clockNow?: number;
}): Promise<{
  ws: FakeWs;
  advance: (ms: number) => void;
  getPending: () => FakeTimer[];
}> {
  const { clock, advance, getPending } = makeFakeClock(opts.clockNow ?? 0);

  const result: VerifyClientResult<TestUser> = {
    ok: true,
    user: { sub: "user-1" },
    connectionKey: "user-1",
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
  const orchestrator = new VerifyClientOrchestrator<TestUser>(
    async () => result,
  );
  const req = { headers: {}, url: "/ws", socket: {} } as IncomingMessage;
  // Prime the WeakMap the same way `ws` does in production: through the
  // upgrade-time verifyClient callback.
  await new Promise<void>((resolve) => {
    orchestrator.buildWsVerifyClient()(
      { origin: "", secure: false, req },
      () => resolve(),
    );
  });

  const config = {
    ...DEFAULT_CONNECTION_CONFIG,
    ...(opts.enforceTokenExpiry !== undefined
      ? { enforceTokenExpiry: opts.enforceTokenExpiry }
      : {}),
  };

  const handler = new ConnectionHandler<TestUser>({
    verifyOrchestrator: orchestrator,
    registry: new ConnectionRegistry({ config }),
    pingPong: {
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as WsPingPong,
    rpcHandler: { upgrade: vi.fn() },
    config,
    clock,
  });

  const ws = makeFakeWs();
  handler.handle(ws as unknown as WebSocket, req);

  return { ws, advance, getPending };
}

// ---------- Tests ----------

describe("API-4 — token-expiry enforcement (enforceTokenExpiry: true)", () => {
  it("closes the connection with 4001 'Token expired' once the clock passes expiresAt", async () => {
    const { ws, advance } = await runConnection({
      enforceTokenExpiry: true,
      clockNow: 1_000,
      expiresAt: 6_000, // 5s of token life left
    });

    advance(4_999);
    expect(ws.close).not.toHaveBeenCalled();

    advance(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4001, "Token expired");
  });

  it("an already-expired expiresAt closes immediately (0ms timer, no negative delay)", async () => {
    const { ws, advance } = await runConnection({
      enforceTokenExpiry: true,
      clockNow: 10_000,
      expiresAt: 5_000, // in the past — verifyClient accepted it anyway
    });

    advance(0);
    expect(ws.close).toHaveBeenCalledWith(4001, "Token expired");
  });

  it("clears the expiry timer when the connection closes first (no leak, no late close)", async () => {
    const { ws, advance, getPending } = await runConnection({
      enforceTokenExpiry: true,
      clockNow: 0,
      expiresAt: 60_000,
    });
    expect(getPending().length).toBe(1);

    // Client disconnects normally well before expiry.
    ws.emitClose(1000);
    expect(getPending().length).toBe(0);

    // Long past the would-be expiry: no zombie close fires.
    advance(120_000);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("schedules nothing when the verify result carries no expiresAt", async () => {
    const { ws, advance, getPending } = await runConnection({
      enforceTokenExpiry: true,
      // expiresAt omitted — verifier doesn't know the expiry
    });

    expect(getPending().length).toBe(0);
    advance(86_400_000);
    expect(ws.close).not.toHaveBeenCalled();
  });
});

describe("API-4 / F4 — expiry beyond Node's 32-bit timer ceiling (~24.8 days)", () => {
  // Node clamps setTimeout delays above 2^31-1 ms to 1ms — a single
  // timer armed for a 30-day token would fire immediately, close 4001,
  // and push the client into a refresh→reconnect→close loop that ends in
  // terminal logout. The watchdog must instead sleep in <=MAX_DELAY
  // segments and re-arm until the real expiry instant.
  const MAX_DELAY = 2_147_483_647;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000; // 2_592_000_000 > MAX_DELAY

  it("does not close at the clamp boundary — re-arms — and closes 4001 only at the real expiry", async () => {
    const { ws, advance, getPending } = await runConnection({
      enforceTokenExpiry: true,
      clockNow: 0,
      expiresAt: THIRTY_DAYS,
    });

    // First segment is clamped to the 32-bit ceiling, never beyond.
    expect(getPending().length).toBe(1);
    expect(getPending()[0]?.fireAt).toBe(MAX_DELAY);

    // Cross the clamp boundary: the segment fires, sees the token is NOT
    // yet expired, and re-arms for the remainder — no close.
    advance(MAX_DELAY + 1);
    expect(ws.close).not.toHaveBeenCalled();
    expect(getPending().length).toBe(1);
    expect(getPending()[0]?.fireAt).toBe(THIRTY_DAYS);

    // One ms short of the real expiry: still open.
    advance(THIRTY_DAYS - (MAX_DELAY + 1) - 1);
    expect(ws.close).not.toHaveBeenCalled();

    // At the real expiry: closed exactly once, 4001.
    advance(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4001, "Token expired");
  });

  it("clears the re-armed segment on early close — no late close after the connection ended", async () => {
    const { ws, advance, getPending } = await runConnection({
      enforceTokenExpiry: true,
      clockNow: 0,
      expiresAt: THIRTY_DAYS,
    });

    // Get past the first segment so the timer in flight is a RE-ARMED
    // one (the leak candidate F4 calls out), not the original.
    advance(MAX_DELAY + 1);
    expect(getPending().length).toBe(1);

    // Connection closes normally before expiry → same teardown path
    // clears the re-armed segment too.
    ws.emitClose(1000);
    expect(getPending().length).toBe(0);

    // Long past the would-be expiry: no zombie close fires.
    advance(THIRTY_DAYS * 2);
    expect(ws.close).not.toHaveBeenCalled();
  });
});

describe("API-4 — default off: zero behavior change", () => {
  it("DEFAULT_CONNECTION_CONFIG ships enforceTokenExpiry: false", () => {
    expect(DEFAULT_CONNECTION_CONFIG.enforceTokenExpiry).toBe(false);
  });

  it("with the flag off (default), expiresAt is ignored — nothing scheduled, no close", async () => {
    const { ws, advance, getPending } = await runConnection({
      // enforceTokenExpiry not set → default false
      clockNow: 0,
      expiresAt: 5_000,
    });

    expect(getPending().length).toBe(0);
    advance(3_600_000);
    expect(ws.close).not.toHaveBeenCalled();
  });
});
