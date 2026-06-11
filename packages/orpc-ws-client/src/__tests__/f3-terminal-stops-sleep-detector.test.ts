// F3 regression — terminal teardown must stop the sleep detector (and a
// kick must do the same).
//
// docs review finding F3: the composition root's `fireTerminalAuthFailure`
// stopped the heartbeat but NOT the sleep detector, and the 4005
// `session-replaced` branch stopped neither. So after the library had
// given up (terminal auth failure) — or after the session was replaced
// (`kicked`) — a device sleep/wake still emitted `woke_from_sleep` to the
// consumer and ran the full reconnect machinery, only to be refused at
// the socket swap with a misleading "client disposed" log. On the
// cookie-auth direct-terminal path (no tokenProvider) the ReconnectManager
// wasn't even latched, so the whole debounce → jitter → swap pipeline ran
// on a dead client.
//
// Fix under test (composition level, real stub server speaking raw WS):
//   1. `fireTerminalAuthFailure` stops the sleep detector — a wake after
//      terminal emits nothing and dials nothing.
//   2. The `onKicked` teardown stops it too — same assertions after a
//      4005 kick.
//   3. Sanity case proving the harness can produce wakes at all (so the
//      negative assertions above aren't vacuous).
//
// Determinism: the Blob-URL worker is replaced (vi.mock of
// `worker-source.ts`) with a test-controlled fake that the test ticks by
// hand, and the injected `clock` is the system clock plus a test-owned
// offset — "the device slept" is `offset += 60s` followed by one tick.
// No real 5s worker cadence, no real sleep.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import { systemClock, type Clock } from "@repo/orpc-ws-shared";

import {
  createOrpcWsClient,
  type ClientEvent,
  type OrpcWsClient,
} from "../index.js";

// Test-controlled stand-in for the sleep-detection worker. Hoisted so the
// vi.mock factory below (which vitest lifts above the imports) can close
// over it without a TDZ trap.
const workerControl = vi.hoisted(() => {
  type MessageListener = (event: { data: unknown }) => void;

  class FakeSleepWorker {
    private readonly listeners = new Set<MessageListener>();
    private terminated = false;

    addEventListener(type: string, listener: unknown): void {
      if (type === "message") {
        this.listeners.add(listener as MessageListener);
      }
    }

    removeEventListener(type: string, listener: unknown): void {
      if (type === "message") {
        this.listeners.delete(listener as MessageListener);
      }
    }

    terminate(): void {
      this.terminated = true;
      this.listeners.clear();
    }

    isTerminated(): boolean {
      return this.terminated;
    }

    /** Deliver one worker tick, respecting terminate()/removeEventListener. */
    postTick(ts: number): void {
      if (this.terminated) return;
      for (const listener of [...this.listeners]) {
        listener({ data: { ts } });
      }
    }
  }

  const workers: InstanceType<typeof FakeSleepWorker>[] = [];
  return {
    workers,
    createWorker: (): InstanceType<typeof FakeSleepWorker> => {
      const worker = new FakeSleepWorker();
      workers.push(worker);
      return worker;
    },
  };
});

// Replace the Blob-URL worker factory with the fake above. The
// SleepDetector consumes it through the `SleepWorker` structural type, so
// the fake satisfies it without touching detector internals.
vi.mock("../sleep/worker-source.js", () => ({
  defaultWorkerFactory: workerControl.createWorker,
}));

type StubContract = Record<string, never>;

interface StubServerHandle {
  url: string;
  /** Count of upgrade attempts that reached the server. */
  upgradeCount: () => number;
  close: () => Promise<void>;
}

/**
 * HTTP + WS server whose per-connection behavior is supplied by the test:
 * hold open (sanity case), close 1008 (terminal case), or close 4005
 * (kicked case).
 */
async function spinUpServer(
  onConnection: (ws: WsWebSocket) => void,
): Promise<StubServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let upgrades = 0;

  wss.on("connection", (ws: WsWebSocket) => {
    upgrades += 1;
    onConnection(ws);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}`,
    upgradeCount: () => upgrades,
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
 * System clock + test-owned offset. Timers stay REAL (the composition's
 * partysocket/debounce timing runs against the wall clock); only `now()`
 * is shiftable, which is exactly what the sleep detector's drift
 * arithmetic reads.
 */
function makeOffsetClock(): {
  clock: Clock;
  advanceWallClock: (ms: number) => void;
} {
  let offset = 0;
  const clock: Clock = {
    now: () => systemClock.now() + offset,
    setTimeout: (fn, ms) => systemClock.setTimeout(fn, ms),
    clearTimeout: (handle) => systemClock.clearTimeout(handle),
    setInterval: (fn, ms) => systemClock.setInterval(fn, ms),
    clearInterval: (handle) => systemClock.clearInterval(handle),
  };
  return {
    clock,
    advanceWallClock: (ms) => {
      offset += ms;
    },
  };
}

/** Jump the wall clock past the wake threshold, then deliver one tick. */
function simulateWake(advanceWallClock: (ms: number) => void): void {
  const worker = workerControl.workers.at(-1);
  if (!worker) {
    throw new Error("simulateWake: no sleep-detector worker was created");
  }
  advanceWallClock(60_000); // ≫ pollInterval (5s) + tolerance (2s)
  worker.postTick(Date.now());
}

const FAST_RETRY = {
  minReconnectionDelay: 20,
  maxReconnectionDelay: 40,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 500,
};

describe("F3 — terminal/kicked teardown stops the sleep detector (composition root)", () => {
  let server: StubServerHandle | null = null;
  let client: OrpcWsClient<StubContract> | null = null;

  beforeEach(() => {
    workerControl.workers.length = 0;
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
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("sanity: on a live client, a simulated wake emits woke_from_sleep", async () => {
    // Accept and hold — healthy connection.
    server = await spinUpServer(() => {});
    const { clock, advanceWallClock } = makeOffsetClock();
    const events: ClientEvent[] = [];

    client = createOrpcWsClient<StubContract>({
      url: server.url,
      onEvent: (evt) => events.push(evt),
      reconnect: FAST_RETRY,
      clock,
    });

    client.connect();
    await waitUntil(() => client!.state.getState().status === "connected");
    expect(workerControl.workers.length).toBe(1);

    simulateWake(advanceWallClock);

    // The harness CAN produce wakes — the negative assertions in the
    // terminal/kicked cases below are therefore meaningful.
    await waitUntil(() =>
      events.some((e) => e.type === "woke_from_sleep"),
    );
  });

  it("after a terminal auth failure (cookie-auth direct path), a wake emits nothing and dials nothing", async () => {
    // 1008-reject every connection. No tokenProvider → the composition
    // root's onAuthRecoveryNeeded goes STRAIGHT to fireTerminalAuthFailure
    // — the F3 path that pre-fix neither stopped the detector nor latched
    // the ReconnectManager.
    server = await spinUpServer((ws) => ws.close(1008, "Auth rejected"));
    const { clock, advanceWallClock } = makeOffsetClock();
    const events: ClientEvent[] = [];
    const onTerminalAuthFailure = vi.fn();

    client = createOrpcWsClient<StubContract>({
      url: server.url,
      onTerminalAuthFailure,
      onEvent: (evt) => events.push(evt),
      reconnect: FAST_RETRY,
      clock,
    });

    client.connect();
    await waitUntil(() => onTerminalAuthFailure.mock.calls.length >= 1);

    // The teardown stopped the detector — the worker is terminated.
    expect(workerControl.workers.length).toBe(1);
    expect(workerControl.workers[0]!.isTerminated()).toBe(true);

    // A wake on the dead client: nothing happens. Pre-fix the still-live
    // worker tick emitted `woke_from_sleep` and ran the full reconnect
    // machinery (un-latched ReconnectManager → debounce → jitter → swap),
    // refused only at the swap with a misleading "client disposed" log.
    const upgradesAtTerminal = server.upgradeCount();
    simulateWake(advanceWallClock);
    await sleep(200);

    expect(events.filter((e) => e.type === "woke_from_sleep")).toEqual([]);
    expect(server.upgradeCount()).toBe(upgradesAtTerminal);
    expect(client.state.getState()).toEqual({
      status: "disconnected",
      willRetry: false,
    });
  });

  it("after a 4005 kick, a wake emits nothing and dials nothing", async () => {
    server = await spinUpServer((ws) => ws.close(4005, "Session replaced"));
    const { clock, advanceWallClock } = makeOffsetClock();
    const events: ClientEvent[] = [];

    client = createOrpcWsClient<StubContract>({
      url: server.url,
      onEvent: (evt) => events.push(evt),
      reconnect: FAST_RETRY,
      clock,
    });

    client.connect();
    await waitUntil(() => client!.state.getState().status === "kicked");

    // The onKicked teardown stopped the detector — kick is as terminal
    // as dispose().
    expect(workerControl.workers.length).toBe(1);
    expect(workerControl.workers[0]!.isTerminated()).toBe(true);

    const upgradesAtKick = server.upgradeCount();
    simulateWake(advanceWallClock);
    await sleep(200);

    // Pre-fix the detector kept ticking on the kicked client and emitted
    // `woke_from_sleep` (the onWake kicked-guard suppressed only the
    // reconnect, not the consumer-facing event).
    expect(events.filter((e) => e.type === "woke_from_sleep")).toEqual([]);
    expect(server.upgradeCount()).toBe(upgradesAtKick);
    expect(client.state.getState()).toEqual({
      status: "kicked",
      reason: "session_replaced",
    });
  });
});
