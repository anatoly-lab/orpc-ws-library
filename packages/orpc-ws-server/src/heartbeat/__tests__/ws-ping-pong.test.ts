// Phase 3.2 — ws-ping-pong watchdog unit tests.
//
// Three behaviors pinned:
//   1. Alive marked on pong → next tick sends ping → if no pong, NEXT
//      tick terminates.
//   2. onZombieTerminated fires after terminate.
//   3. unregister removes the entry so it stops being ticked.

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";

import {
  type Clock,
  type TimerHandle,
} from "@repo/orpc-ws-shared";

import { WsPingPong } from "../ws-ping-pong.js";
import { DEFAULT_HEARTBEAT_CONFIG } from "../../config/heartbeat-config.js";

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  interval: number | null;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
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
        interval: null,
        cancelled: false,
      };
      timers.push(t);
      return toHandle(t);
    },
    clearTimeout: (h) => {
      fromHandle(h).cancelled = true;
    },
    setInterval: (fn, ms) => {
      const t: FakeTimer = {
        id: nextId++,
        fireAt: now + ms,
        fn,
        interval: ms,
        cancelled: false,
      };
      timers.push(t);
      return toHandle(t);
    },
    clearInterval: (h) => {
      fromHandle(h).cancelled = true;
    },
  };

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    let safety = 1000;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      if (!next) break;
      now = next.fireAt;
      if (next.interval !== null) {
        next.fireAt = now + next.interval;
      } else {
        const idx = timers.indexOf(next);
        if (idx >= 0) timers.splice(idx, 1);
      }
      try {
        next.fn();
      } catch {
        // tests check effects
      }
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  return { clock, advance };
}

/**
 * Minimal WebSocket stub — EventEmitter for `pong` + spy methods for
 * `ping`, `terminate`, `close`.
 */
function fakeWs(): {
  ws: WebSocket;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emitPong: () => void;
} {
  const emitter = new EventEmitter();
  const ping = vi.fn();
  const terminate = vi.fn();
  const ws = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    ping,
    terminate,
    close: vi.fn(),
  } as unknown as WebSocket;
  return { ws, ping, terminate, emitPong: () => emitter.emit("pong") };
}

describe("WsPingPong", () => {
  it("marks alive on pong, then ping → no pong → terminate on the second tick", async () => {
    const { clock, advance } = makeFakeClock();
    const pingPong = new WsPingPong({
      config: { ...DEFAULT_HEARTBEAT_CONFIG, intervalMs: 100 },
      clock,
    });
    pingPong.start();

    const { ws, ping, terminate } = fakeWs();
    pingPong.register(ws, { id: 1 });

    // Tick 1: initial alive is true → mark dead → ping.
    await advance(100);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();

    // No pong fires. Tick 2: alive === false → terminate.
    await advance(100);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(pingPong.trackedCount()).toBe(0);

    pingPong.stop();
  });

  it("pong response prevents the next-tick terminate", async () => {
    const { clock, advance } = makeFakeClock();
    const pingPong = new WsPingPong({
      config: { ...DEFAULT_HEARTBEAT_CONFIG, intervalMs: 100 },
      clock,
    });
    pingPong.start();

    const { ws, ping, terminate, emitPong } = fakeWs();
    pingPong.register(ws, { id: 1 });

    await advance(100); // ping
    emitPong(); // alive again
    await advance(100); // ping (NOT terminate)

    expect(ping).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();

    pingPong.stop();
  });

  it("onZombieTerminated fires on terminate, with the registered user", async () => {
    const { clock, advance } = makeFakeClock();
    const onZombieTerminated = vi.fn();
    const pingPong = new WsPingPong({
      config: { ...DEFAULT_HEARTBEAT_CONFIG, intervalMs: 50 },
      clock,
      onZombieTerminated,
    });
    pingPong.start();

    const user = { sub: "user-abc" };
    const { ws } = fakeWs();
    pingPong.register(ws, user);

    await advance(50); // ping
    await advance(50); // terminate

    expect(onZombieTerminated).toHaveBeenCalledTimes(1);
    expect(onZombieTerminated).toHaveBeenCalledWith(user);

    pingPong.stop();
  });

  it("unregister removes the entry from the tick rotation", async () => {
    const { clock, advance } = makeFakeClock();
    const pingPong = new WsPingPong({
      config: { ...DEFAULT_HEARTBEAT_CONFIG, intervalMs: 50 },
      clock,
    });
    pingPong.start();

    const { ws, ping } = fakeWs();
    pingPong.register(ws, { id: 1 });
    expect(pingPong.trackedCount()).toBe(1);

    pingPong.unregister(ws);
    expect(pingPong.trackedCount()).toBe(0);

    await advance(50);
    expect(ping).not.toHaveBeenCalled();

    pingPong.stop();
  });

  it("pingPong=false disables the watchdog entirely", async () => {
    const { clock, advance } = makeFakeClock();
    const pingPong = new WsPingPong({
      config: { ...DEFAULT_HEARTBEAT_CONFIG, pingPong: false, intervalMs: 50 },
      clock,
    });
    pingPong.start();

    const { ws, ping, terminate } = fakeWs();
    pingPong.register(ws, { id: 1 });

    // Advance many intervals — neither ping nor terminate fires.
    await advance(500);
    expect(ping).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();

    pingPong.stop();
  });
});
