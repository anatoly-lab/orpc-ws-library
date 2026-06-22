// Unit tests for the extracted API-4 token-expiry watchdog.
//
// `armTokenExpiryWatchdog` is now independently testable — no
// ConnectionHandler / verify-orchestrator harness needed. We drive it with
// the same fake-clock + fake-ws seams the connection-handler tests use, so
// the behavior contract (close at expiry, re-arm across the 32-bit ceiling,
// cancel-on-close) is covered at the unit level.

import { describe, expect, it, vi } from "vitest";

import type { WebSocket } from "ws";

import { noopLogger } from "@orpc-ws/shared";
import type { Clock, TimerHandle } from "@orpc-ws/shared";

import { armTokenExpiryWatchdog } from "../token-expiry-watchdog.js";

// ---------- Fake clock (mirrors api-4 test conventions) ----------

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
      const t: FakeTimer = {
        id: nextId++,
        fireAt: now + ms,
        fn,
        cancelled: false,
      };
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

  // Synchronous advance — the watchdog body is sync (ws.close()).
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

function makeFakeWs(): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() };
}

// ---------- Harness ----------

function arm(opts: {
  clockNow?: number;
  expiresAt: number;
  authFailedCloseCode?: number;
}) {
  const { clock, advance, getPending } = makeFakeClock(opts.clockNow ?? 0);
  const ws = makeFakeWs();
  const cancel = armTokenExpiryWatchdog(
    {
      clock,
      authFailedCloseCode: opts.authFailedCloseCode ?? 4001,
      logger: noopLogger,
    },
    {
      ws: ws as unknown as WebSocket,
      expiresAt: opts.expiresAt,
      connectionKey: "conn-1",
    },
  );
  return { ws, advance, getPending, cancel };
}

// ---------- Tests ----------

describe("armTokenExpiryWatchdog", () => {
  it("arms a close at expiresAt — fires ws.close(code, 'Token expired') exactly when the clock passes it", () => {
    const { ws, advance } = arm({ clockNow: 1_000, expiresAt: 6_000 });

    advance(4_999);
    expect(ws.close).not.toHaveBeenCalled();

    advance(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4001, "Token expired");
  });

  it("honours a custom authFailedCloseCode", () => {
    const { ws, advance } = arm({
      expiresAt: 1_000,
      authFailedCloseCode: 4010,
    });

    advance(1_000);
    expect(ws.close).toHaveBeenCalledWith(4010, "Token expired");
  });

  it("an already-past expiresAt closes promptly (0ms timer, no negative delay)", () => {
    const { ws, advance } = arm({ clockNow: 10_000, expiresAt: 5_000 });

    advance(0);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4001, "Token expired");
  });

  describe("32-bit timer ceiling (~24.8 days)", () => {
    const MAX_DELAY = 2_147_483_647;
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000; // > MAX_DELAY

    it("clamps the first segment to the ceiling, re-arms, and closes only at the real expiry", () => {
      const { ws, advance, getPending } = arm({
        clockNow: 0,
        expiresAt: THIRTY_DAYS,
      });

      // First segment clamped to the 32-bit ceiling, never beyond.
      expect(getPending().length).toBe(1);
      expect(getPending()[0]?.fireAt).toBe(MAX_DELAY);

      // Cross the clamp boundary: segment fires, sees token NOT yet
      // expired, re-arms for the remainder — no early close.
      advance(MAX_DELAY + 1);
      expect(ws.close).not.toHaveBeenCalled();
      expect(getPending().length).toBe(1);
      expect(getPending()[0]?.fireAt).toBe(THIRTY_DAYS);

      // One ms short of the real expiry: still open.
      advance(THIRTY_DAYS - (MAX_DELAY + 1) - 1);
      expect(ws.close).not.toHaveBeenCalled();

      // At the real expiry: closed exactly once.
      advance(1);
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(ws.close).toHaveBeenCalledWith(4001, "Token expired");
    });
  });

  describe("canceller", () => {
    it("clears a pending timer — no close after cancel", () => {
      const { ws, advance, getPending, cancel } = arm({
        clockNow: 0,
        expiresAt: 60_000,
      });
      expect(getPending().length).toBe(1);

      cancel();
      expect(getPending().length).toBe(0);

      advance(120_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("clears a RE-ARMED segment — no late close after cancel past the ceiling", () => {
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const MAX_DELAY = 2_147_483_647;
      const { ws, advance, getPending, cancel } = arm({
        clockNow: 0,
        expiresAt: THIRTY_DAYS,
      });

      // Get past the first segment so the in-flight timer is a re-armed one.
      advance(MAX_DELAY + 1);
      expect(getPending().length).toBe(1);

      cancel();
      expect(getPending().length).toBe(0);

      advance(THIRTY_DAYS * 2);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("is idempotent — a second cancel after fire is a harmless no-op", () => {
      const { ws, advance, cancel } = arm({ clockNow: 0, expiresAt: 1_000 });

      advance(1_000);
      expect(ws.close).toHaveBeenCalledTimes(1);

      // Timer already fired (binding nulled); cancelling now must not throw.
      expect(() => cancel()).not.toThrow();
    });
  });
});
