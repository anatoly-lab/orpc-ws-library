// NFI-4 — bounded terminate-fallback on shutdown.
//
// `dispose()` awaits `wss.close()`, whose callback fires only when every
// client has finished its WS close handshake. A dead / half-open client
// never finishes it, so before this fix shutdown hung until `ws`'s
// internal ~30 s timer terminated the socket. `closeWssWithGrace` bounds
// the wait: stragglers still in `wss.clients` after
// `connection.shutdownGraceMs` are force-`terminate()`d so the close
// callback fires and dispose resolves promptly.
//
// Behaviors pinned (fake clock + fake wss — the fake sockets' `close()`
// never emits 'close', which is exactly the dead-client shape):
//   1. A socket that never completes its close handshake is terminated
//      after the grace period and shutdown resolves.
//   2. Happy path untouched: clients that close cleanly inside the window
//      are never terminated, and the fallback timer is cleared (it does
//      not fire later).
//   3. Mixed: only the straggler is terminated; the cleanly-closed client
//      is left alone.

import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { Clock, TimerHandle } from "@orpc-ws/shared";

import { closeWssWithGrace, type ClosableWss } from "../wss-shutdown.js";

// ----- Fake clock (same pattern as ws-ping-pong.test.ts, timeouts only) -----

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => void;
} {
  let now = initial;
  const timers: FakeTimer[] = [];

  const toHandle = (t: FakeTimer): TimerHandle => t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeTimer => h as unknown as FakeTimer;

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { fireAt: now + ms, fn, cancelled: false };
      timers.push(t);
      return toHandle(t);
    },
    clearTimeout: (h) => {
      fromHandle(h).cancelled = true;
    },
    setInterval: () => {
      throw new Error("setInterval not used by closeWssWithGrace");
    },
    clearInterval: () => {
      throw new Error("clearInterval not used by closeWssWithGrace");
    },
  };

  const advance = (ms: number): void => {
    now += ms;
    // One-shot timers, fired in due order.
    const due = timers
      .filter((t) => !t.cancelled && t.fireAt <= now)
      .sort((a, b) => a.fireAt - b.fireAt);
    for (const t of due) {
      t.cancelled = true;
      t.fn();
    }
  };

  return { clock, advance };
}

// ----- Fake wss + sockets -----

interface FakeWs {
  ws: WebSocket;
  terminate: ReturnType<typeof vi.fn>;
  /** Simulate a CLEAN close handshake completing for this socket. */
  finishCloseHandshake: () => void;
}

/**
 * Emulates the two `ws.WebSocketServer` behaviors the helper leans on:
 *   - `clients` drains as sockets close (cleanly or via terminate), and
 *   - the `close(cb)` callback fires once close was requested AND the
 *     client set is empty.
 * The fake sockets' `close()` is a no-op by construction — a client whose
 * close handshake never completes — so only `terminate()` (or an explicit
 * `finishCloseHandshake()`) drains them.
 */
function makeFakeWss(): {
  wss: ClosableWss;
  addClient: () => FakeWs;
} {
  const clients = new Set<WebSocket>();
  let closeCb: (() => void) | null = null;

  const maybeFinish = (): void => {
    if (closeCb !== null && clients.size === 0) {
      const cb = closeCb;
      closeCb = null;
      cb();
    }
  };

  const wss: ClosableWss = {
    clients,
    close: (cb) => {
      closeCb = cb ?? null;
      maybeFinish();
    },
  };

  const addClient = (): FakeWs => {
    const remove = (): void => {
      clients.delete(ws);
      maybeFinish();
    };
    const terminate = vi.fn(remove);
    const ws = {
      // Dead client: graceful close() never produces a 'close' — the
      // socket stays in `clients` until terminated.
      close: vi.fn(),
      terminate,
    } as unknown as WebSocket;
    clients.add(ws);
    return { ws, terminate, finishCloseHandshake: remove };
  };

  return { wss, addClient };
}

/** True once `p` has settled — without awaiting it (poll between ticks). */
async function hasResolved(p: Promise<void>): Promise<boolean> {
  let resolved = false;
  void p.then(() => {
    resolved = true;
  });
  await new Promise((r) => setImmediate(r));
  return resolved;
}

describe("closeWssWithGrace (NFI-4)", () => {
  it("terminates a socket that never completes its close handshake after the grace period, and shutdown resolves", async () => {
    const { clock, advance } = makeFakeClock();
    const { wss, addClient } = makeFakeWss();
    const dead = addClient();

    const done = closeWssWithGrace({ wss, clock, graceMs: 5000 });

    // Inside the window: nothing terminated, shutdown still pending.
    advance(4999);
    expect(dead.terminate).not.toHaveBeenCalled();
    expect(await hasResolved(done)).toBe(false);

    // Grace elapses → straggler force-closed → wss.close callback fires.
    advance(1);
    expect(dead.terminate).toHaveBeenCalledOnce();
    await expect(done).resolves.toBeUndefined();
  });

  it("happy path: clients closing cleanly inside the window are never terminated and the fallback timer is cleared", async () => {
    const { clock, advance } = makeFakeClock();
    const { wss, addClient } = makeFakeWss();
    const polite = addClient();

    const done = closeWssWithGrace({ wss, clock, graceMs: 5000 });

    // The client finishes its close handshake well inside the window.
    polite.finishCloseHandshake();
    await expect(done).resolves.toBeUndefined();
    expect(polite.terminate).not.toHaveBeenCalled();

    // The fallback was cleared — advancing past the grace fires nothing.
    advance(10_000);
    expect(polite.terminate).not.toHaveBeenCalled();
  });

  it("mixed: only the straggler is terminated; the cleanly-closed client is untouched", async () => {
    const { clock, advance } = makeFakeClock();
    const { wss, addClient } = makeFakeWss();
    const polite = addClient();
    const dead = addClient();

    const done = closeWssWithGrace({ wss, clock, graceMs: 5000 });

    polite.finishCloseHandshake();
    expect(await hasResolved(done)).toBe(false); // dead one still holds it

    advance(5000);
    expect(dead.terminate).toHaveBeenCalledOnce();
    expect(polite.terminate).not.toHaveBeenCalled();
    await expect(done).resolves.toBeUndefined();
  });

  it("a terminate() that throws does not stop the remaining stragglers from being terminated", async () => {
    const { clock, advance } = makeFakeClock();
    const { wss, addClient } = makeFakeWss();
    const broken = addClient();
    const dead = addClient();
    // First straggler's socket is in a torn state — terminate throws and
    // (worst case) never drains it from the set.
    broken.terminate.mockImplementation(() => {
      throw new Error("socket torn");
    });

    closeWssWithGrace({ wss, clock, graceMs: 5000 });
    advance(5000);

    expect(broken.terminate).toHaveBeenCalledOnce();
    expect(dead.terminate).toHaveBeenCalledOnce();
  });
});
