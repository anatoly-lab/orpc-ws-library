// Bug 25 — a server that is merely DOWN must not force a logout.
//
// User-approved behavior change (2026-07-02; "issue 1" of the parked design
// questions). Pre-fix, the storm guard's trip was unconditionally terminal
// whenever the window had auth provenance. In token mode, against a server
// that is down (connection refused / unreachable), that meant:
//
//   1. partysocket surfaces every pre-open failure as a synthetic
//      code-1000 close (the browser masks the real reason);
//   2. the close-decision tree routes 1000-before-open to auth-recovery
//      (Bug 4 branch) — it is only a *candidate* auth signal;
//   3. the first such close burned the storm window's refresh (refresh
//      SUCCEEDS — the IdP is fine, only the app server is down);
//   4. the second pre-open failure landed within the 30s window with
//      auth-recovery provenance → storm trip → `onTerminalAuthFailure`
//      → forced logout, within ~30s of the server going down.
//
// Post-fix, the storm-trip OUTCOME depends on the `AuthRecoveryTrigger`
// discriminant (Bug 24) now plumbed into `tryAuthRecovery`:
//   - `"auth-close"` (real 1008/4001, and the upload transport's 401):
//     terminal — UNCHANGED. Two explicit credential rejections within the
//     window despite a completed refresh are a genuine auth hot loop.
//   - `"pre-open-1000"`: reconnect-with-current-token semantics — the same
//     trip the routine `reconnect()` path has. Mechanism: a deliberate
//     NO-OP. The wrapper that emitted the close is still the current one
//     and partysocket is already auto-retrying it on its own exponential
//     backoff (`maxRetries` is force-clamped to Infinity, S1), with the
//     URL-provider closure re-reading the current token on every attempt
//     (Bug 1). Critically it is NOT a `reconnectWithCurrentToken()` swap:
//     a fresh partysocket's first attempt has delay 0, so swapping on
//     every storm trip would spin at connection-refused latency against a
//     down server — the tests below pin the no-swap mechanism to keep
//     that hot loop unrepresentable.
//
// Give-up stays auth-owned: a null/thrown refresh, or a real auth close,
// still goes terminal via the existing paths.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, Rng, TimerHandle } from "@orpc-ws/shared";

import { ReconnectManager } from "../reconnect-manager.js";
import type { TokenRefreshHandler } from "../token-refresh-handler.js";

// ---------- Minimal fakes (same shapes as reconnect-manager.test.ts) ----------

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  setNow: (ms: number) => void;
} {
  let now = initial;
  const timers: FakeTimer[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { fireAt: now + ms, fn, cancelled: false };
      timers.push(t);
      return t as unknown as TimerHandle;
    },
    clearTimeout: (handle) => {
      (handle as unknown as FakeTimer).cancelled = true;
    },
    setInterval: () => {
      throw new Error("setInterval not expected in these tests");
    },
    clearInterval: () => {
      throw new Error("clearInterval not expected in these tests");
    },
  };
  // These tests drive `tryAuthRecovery` directly (no debounce/jitter
  // timers involved), so time only needs to MOVE — timers never fire.
  const setNow = (ms: number) => {
    now = ms;
  };
  return { clock, setNow };
}

const noRng: Rng = { next: () => 0.5 };

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Fake TokenRefreshHandler whose `refreshAndReconnect` SUCCEEDS — the Bug-25
 * shape is "IdP up, app server down": every refresh mints a token fine, it's
 * the WS handshake that keeps failing pre-open.
 */
function makeSucceedingHandler() {
  let inFlight = 0;
  const refreshAndReconnect = vi.fn(() => {
    inFlight += 1;
    return Promise.resolve(true).finally(() => {
      inFlight -= 1;
    });
  });
  const reconnectWithCurrentToken = vi.fn();
  const stub = {
    refreshAndReconnect,
    reconnectWithNewToken: vi.fn(),
    reconnectWithCurrentToken,
    isReconnecting: vi.fn(() => false),
    isRefreshing: vi.fn(() => inFlight > 0),
  } as unknown as TokenRefreshHandler;
  return { handler: stub, refreshAndReconnect, reconnectWithCurrentToken };
}

const WINDOW_MS = 30_000;

function build() {
  const { clock, setNow } = makeFakeClock(0);
  const fakes = makeSucceedingHandler();
  const onTerminalAuthFailure = vi.fn();
  const manager = new ReconnectManager({
    tokenRefreshHandler: fakes.handler,
    reconnectConfig: {
      debounceMs: 100,
      jitterMs: 1000,
      minRefreshIntervalMs: WINDOW_MS,
    },
    onTerminalAuthFailure,
    // Token mode: the consumer supplied a real tokenProvider.
    canRefresh: true,
    clock,
    rng: noRng,
    logger: makeLogger(),
  });
  return { manager, ...fakes, onTerminalAuthFailure, setNow };
}

describe("Bug 25 — pre-open-1000 storm trip is not terminal (server down ≠ logout)", () => {
  it(
    "token mode, refresh succeeds: repeated pre-open-1000 failures within " +
      "the storm window do NOT fire onTerminalAuthFailure (pre-fix: terminal on the 2nd)",
    async () => {
      const ctx = build();

      // 1st pre-open failure (server just went down): outside any window →
      // auth-recovery refresh runs and succeeds, stamping auth provenance.
      await ctx.manager.tryAuthRecovery(1000, "pre-open-1000");
      expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();

      // 2nd and 3rd pre-open failures, well within the window — the exact
      // shape that used to go terminal. The new socket from the refresh
      // failed pre-open again (server still down), then its retry failed.
      ctx.setNow(1_000);
      await ctx.manager.tryAuthRecovery(1000, "pre-open-1000");
      ctx.setNow(5_000);
      await ctx.manager.tryAuthRecovery(1000, "pre-open-1000");

      // NOT terminal, and no second refresh burned inside the window.
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
      expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
      // The client is still live: entry points have not latched terminal.
      await expect(
        ctx.manager.tryAuthRecovery(1000, "pre-open-1000"),
      ).resolves.toBeUndefined();
      expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
    },
  );

  it(
    "no-swap mechanism: the pre-open-1000 storm trip does NOT call " +
      "reconnectWithCurrentToken (a swap's first attempt has zero delay — " +
      "hot loop against a down server); it rides the live wrapper's backoff",
    async () => {
      const ctx = build();

      await ctx.manager.tryAuthRecovery(1000, "pre-open-1000"); // refresh #1
      ctx.setNow(2_000);
      await ctx.manager.tryAuthRecovery(1000, "pre-open-1000"); // storm trip

      // No socket rebuild of ANY kind from the trip: partysocket's own
      // retry loop (URL provider re-reads the current token, Bug 1) is the
      // reconnect-with-current-token machinery here, and its backoff is
      // the pacing — no library-side throttle needed by construction.
      expect(ctx.reconnectWithCurrentToken).not.toHaveBeenCalled();
      expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it("after the window expires, the next pre-open-1000 refreshes again (recovery path preserved)", async () => {
    const ctx = build();

    await ctx.manager.tryAuthRecovery(1000, "pre-open-1000"); // refresh #1
    ctx.setNow(10_000);
    await ctx.manager.tryAuthRecovery(1000, "pre-open-1000"); // storm no-op

    // Server still down past the window: one refresh per window is the
    // designed cadence (storm window prevents refresh hammering).
    ctx.setNow(WINDOW_MS + 1);
    await ctx.manager.tryAuthRecovery(1000, "pre-open-1000");
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(2);
    expect(ctx.onTerminalAuthFailure).not.toHaveBeenCalled();
  });

  it("no over-reach: a real 1008 auth-close within the window still goes terminal", async () => {
    const ctx = build();

    // Auth-provenance stamp via a pre-open candidate whose refresh succeeded.
    await ctx.manager.tryAuthRecovery(1000, "pre-open-1000");
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);

    // Then the server EXPLICITLY rejects the (just-refreshed) credential
    // within the window: genuine auth hot loop — terminal, unchanged.
    ctx.setNow(3_000);
    await ctx.manager.tryAuthRecovery(1008, "auth-close");
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
    expect(ctx.refreshAndReconnect).toHaveBeenCalledTimes(1);
  });

  it("no over-reach: an upload 401 within the window keeps terminal trip semantics (explicit auth-close classification)", async () => {
    const ctx = build();

    await ctx.manager.tryAuthRecovery(1000, "pre-open-1000"); // refresh #1
    ctx.setNow(3_000);
    // A 401 from the upload endpoint is an explicit server-side rejection
    // of the shared Bearer credential — same weight as a WS 1008/4001,
    // none of pre-open-1000's ambiguity.
    await ctx.manager.notifyUploadAuthFailure();
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("default trigger is the strict arm: tryAuthRecovery without a trigger behaves as auth-close (terminal on storm)", async () => {
    const ctx = build();

    await ctx.manager.tryAuthRecovery(1008);
    ctx.setNow(3_000);
    await ctx.manager.tryAuthRecovery(1008);
    // Callers that don't declare provenance get the pre-change (safe,
    // terminal-capable) semantics — only the composition root's
    // close-event wiring opts into the lenient pre-open path.
    expect(ctx.onTerminalAuthFailure).toHaveBeenCalledTimes(1);
  });
});
