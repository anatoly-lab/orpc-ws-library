// HeartbeatSubscriber regression tests.
//
// Pins Phase 1.5 stealth-path invariants. CLAUDE.md "Heartbeat ownership
// — stealth procedure pattern": the subscriber MUST reach the heartbeat
// procedure via the literal `HEARTBEAT_PATH` tuple, NOT through any
// typed-contract proxy. These tests don't go through ORPC at all — they
// use a fake `LinkFactory` whose `getLink()` returns a stub link that
// records every `call()`.
//
// Coverage:
//   1. `subscribe()` calls `link.call(HEARTBEAT_PATH, undefined, opts)`
//      — path pinned literally (Bug 8 regression at the path level).
//   2. The options carry the abort controller's signal — proves
//      `unsubscribe()` actually aborts the upstream stream.
//   3. `config` event → `monitor.configure(intervalMs, timeoutMs)` then
//      `monitor.start()`.
//   4. `ping` event → `monitor.recordPing()`.
//   5. `unsubscribe()` aborts the controller; after unsubscribe no
//      further `recordPing()` calls can land on the monitor.
//   6. `stop()` is observationally identical to `unsubscribe()`.
//   7. Stream error (not abort) is logged but does NOT auto-resubscribe
//      — composition root handles reconnect via `onTimeout` wiring.
//   8. Re-subscribe aborts the prior stream before starting a new one.

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@repo/orpc-ws-shared";

import type { LinkFactory } from "../../client/link-factory.js";
import type { HeartbeatMonitor } from "../monitor.js";

import { HeartbeatSubscriber } from "../subscriber.js";
import { HEARTBEAT_PATH, type HeartbeatEvent } from "../types.js";

// ---------- Helpers ----------

/**
 * A controllable async iterable. Tests `push(event)` to send a value to
 * the consumer; `close()` ends the stream cleanly; `error(e)` throws
 * from the next iteration. The iterable also respects an
 * AbortSignal that the consumer passes via the call options — `.abort()`
 * makes the next pump reject.
 */
function makeControllableStream(): {
  iterable: AsyncIterable<HeartbeatEvent>;
  push: (event: HeartbeatEvent) => void;
  close: () => void;
  error: (err: Error) => void;
  signal?: AbortSignal;
  bindSignal: (signal: AbortSignal) => void;
} {
  const queue: HeartbeatEvent[] = [];
  let pendingResolve: ((value: IteratorResult<HeartbeatEvent>) => void) | null =
    null;
  let pendingReject: ((err: unknown) => void) | null = null;
  let closed = false;
  let pendingError: Error | null = null;
  let signal: AbortSignal | undefined;

  const settle = (): void => {
    if (!pendingResolve && !pendingReject) return;
    if (signal?.aborted) {
      const r = pendingReject;
      pendingReject = null;
      pendingResolve = null;
      r?.(new DOMException("Aborted", "AbortError"));
      return;
    }
    if (pendingError) {
      const err = pendingError;
      pendingError = null;
      const r = pendingReject;
      pendingReject = null;
      pendingResolve = null;
      r?.(err);
      return;
    }
    if (queue.length > 0) {
      const evt = queue.shift()!;
      const r = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      r?.({ value: evt, done: false });
      return;
    }
    if (closed) {
      const r = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      r?.({ value: undefined as unknown as HeartbeatEvent, done: true });
    }
  };

  const iterable: AsyncIterable<HeartbeatEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<HeartbeatEvent> {
      return {
        next: (): Promise<IteratorResult<HeartbeatEvent>> => {
          return new Promise<IteratorResult<HeartbeatEvent>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
            settle();
          });
        },
      };
    },
  };

  const bindSignal = (s: AbortSignal): void => {
    signal = s;
    if (s.aborted) {
      settle();
    } else {
      s.addEventListener("abort", () => settle());
    }
  };

  return {
    iterable,
    push: (event) => {
      queue.push(event);
      settle();
    },
    close: () => {
      closed = true;
      settle();
    },
    error: (err) => {
      pendingError = err;
      settle();
    },
    get signal() {
      return signal;
    },
    bindSignal,
  };
}

/**
 * Stub LinkFactory whose link records every `call()` invocation and
 * returns a per-call AsyncIterable that the test drives.
 */
interface CallRecord {
  path: readonly string[];
  input: unknown;
  options: { signal?: AbortSignal; context: Record<string, unknown> };
  stream: ReturnType<typeof makeControllableStream>;
}

function makeFakeLinkFactory(): {
  factory: LinkFactory;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const link = {
    call: vi.fn(
      async (
        path: readonly string[],
        input: unknown,
        options: { signal?: AbortSignal; context: Record<string, unknown> },
      ) => {
        const stream = makeControllableStream();
        if (options.signal) {
          stream.bindSignal(options.signal);
        }
        calls.push({ path, input, options, stream });
        return stream.iterable;
      },
    ),
  };
  const factory = {
    getLink: () => link,
    clearLink: () => {},
    hasLink: () => true,
  } as unknown as LinkFactory;
  return { factory, calls };
}

function makeFakeMonitor(): HeartbeatMonitor & {
  configureCalls: { intervalMs: number; timeoutMs: number }[];
  recordPingCalls: number;
  startCalls: number;
  stopCalls: number;
} {
  const configureCalls: { intervalMs: number; timeoutMs: number }[] = [];
  let recordPingCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;
  const monitor = {
    configure: (intervalMs: number, timeoutMs: number) => {
      configureCalls.push({ intervalMs, timeoutMs });
    },
    start: () => {
      startCalls++;
    },
    stop: () => {
      stopCalls++;
    },
    recordPing: () => {
      recordPingCalls++;
    },
    onTimeout: () => {},
  } as unknown as HeartbeatMonitor;
  Object.defineProperty(monitor, "configureCalls", { get: () => configureCalls });
  Object.defineProperty(monitor, "recordPingCalls", { get: () => recordPingCalls });
  Object.defineProperty(monitor, "startCalls", { get: () => startCalls });
  Object.defineProperty(monitor, "stopCalls", { get: () => stopCalls });
  return monitor as HeartbeatMonitor & {
    configureCalls: { intervalMs: number; timeoutMs: number }[];
    recordPingCalls: number;
    startCalls: number;
    stopCalls: number;
  };
}

function makeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = [];
  return {
    debug: (msg) => calls.push({ level: "debug", msg }),
    info: (msg) => calls.push({ level: "info", msg }),
    warn: (msg) => calls.push({ level: "warn", msg }),
    error: (msg) => calls.push({ level: "error", msg }),
    calls,
  };
}

// Tiny helper: let the microtask queue drain so the consumption loop
// can pump the next event before we make assertions.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

// ---------- Tests ----------

describe("HeartbeatSubscriber — stealth path (HEARTBEAT_PATH)", () => {
  it("subscribe() calls link.call(HEARTBEAT_PATH, undefined, { signal, context })", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    await subscriber.subscribe();
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toEqual(HEARTBEAT_PATH);
    expect(calls[0]?.path).toEqual(["__orpc_ws_lib__", "heartbeat"]);
    expect(calls[0]?.input).toBeUndefined();
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    // ClientOptions requires `context`; LinkFactory's link is typed
    // `Record<string, never>`, so the only valid value is `{}`.
    expect(calls[0]?.options.context).toEqual({});

    subscriber.unsubscribe();
  });

  it("the signal passed to link.call is the controller's signal — unsubscribe() aborts it", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    await subscriber.subscribe();
    await flush();

    const signal = calls[0]?.options.signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    subscriber.unsubscribe();

    expect(signal?.aborted).toBe(true);
  });
});

describe("HeartbeatSubscriber — event handling", () => {
  it("on 'config' event: monitor.configure called with correct args, then monitor.start", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    await subscriber.subscribe();
    await flush();

    calls[0]?.stream.push({ type: "config", intervalMs: 30_000, timeoutMs: 5_000 });
    await flush();

    expect(monitor.configureCalls).toEqual([
      { intervalMs: 30_000, timeoutMs: 5_000 },
    ]);
    expect(monitor.startCalls).toBe(1);

    subscriber.unsubscribe();
  });

  it("on 'ping' event: monitor.recordPing called", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    await subscriber.subscribe();
    await flush();

    calls[0]?.stream.push({ type: "ping", ts: 1_000 });
    calls[0]?.stream.push({ type: "ping", ts: 2_000 });
    calls[0]?.stream.push({ type: "ping", ts: 3_000 });
    await flush();

    expect(monitor.recordPingCalls).toBe(3);
    // Crucially, ping events DO NOT touch the monitor's configure / start
    // (those are config-event responsibilities only).
    expect(monitor.configureCalls).toEqual([]);
    expect(monitor.startCalls).toBe(0);

    subscriber.unsubscribe();
  });

  it(
    "after unsubscribe() no further ping events land on the monitor",
    async () => {
      const { factory, calls } = makeFakeLinkFactory();
      const monitor = makeFakeMonitor();
      const subscriber = new HeartbeatSubscriber({
        linkFactory: factory,
        monitor,
      });

      await subscriber.subscribe();
      await flush();

      calls[0]?.stream.push({ type: "ping", ts: 1_000 });
      await flush();
      expect(monitor.recordPingCalls).toBe(1);

      subscriber.unsubscribe();
      await flush();

      // The stream is still "open" from the test's perspective, but the
      // abort should have broken the for-await loop. New pushes must
      // not result in monitor.recordPing being called.
      calls[0]?.stream.push({ type: "ping", ts: 2_000 });
      calls[0]?.stream.push({ type: "ping", ts: 3_000 });
      await flush();

      expect(monitor.recordPingCalls).toBe(1);
    },
  );
});

describe("HeartbeatSubscriber — stop() / unsubscribe() equivalence", () => {
  it("stop() aborts the controller (same effect as unsubscribe)", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    await subscriber.subscribe();
    await flush();

    const signal = calls[0]?.options.signal;
    subscriber.stop();
    expect(signal?.aborted).toBe(true);
  });

  it("subscriber conforms to the `{ stop(): void }` collaborator shape ReconnectManager expects", () => {
    const { factory } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });
    // Structural check. ReconnectManager only needs `stop(): void` so
    // this compile-time-shaped assignment is the contract.
    const stoppable: { stop(): void } = subscriber;
    expect(typeof stoppable.stop).toBe("function");
    expect(stoppable.stop.length).toBe(0);
  });

  it("stop() is idempotent", async () => {
    const { factory } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    await subscriber.subscribe();
    await flush();

    subscriber.stop();
    expect(() => subscriber.stop()).not.toThrow();
  });
});

describe("HeartbeatSubscriber — stream error / close behavior", () => {
  it("on POST-config stream error: logs error and does NOT auto-resubscribe (watchdog owns recovery)", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const logger = makeLogger();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
      logger,
    });

    await subscriber.subscribe();
    await flush();

    // Config first — the monitor is armed, so a later stream death is
    // the watchdog's job (`onTimeout`), NOT the subscriber's. The
    // PRE-config error shape retries instead — see the NFI-1 suite.
    calls[0]?.stream.push({ type: "config", intervalMs: 30_000, timeoutMs: 5_000 });
    await flush();

    calls[0]?.stream.error(new Error("upstream blew up"));
    await flush();

    // Exactly ONE call to link.call — no auto-resubscribe.
    expect(calls).toHaveLength(1);
    expect(
      logger.calls.some(
        (c) => c.level === "error" && c.msg.includes("stream error"),
      ),
    ).toBe(true);
  });

  it("on stream close (cleanly): logs and does NOT auto-resubscribe", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const logger = makeLogger();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
      logger,
    });

    await subscriber.subscribe();
    await flush();

    calls[0]?.stream.close();
    await flush();

    expect(calls).toHaveLength(1);
    expect(
      logger.calls.some((c) => c.msg.includes("stream ended cleanly")),
    ).toBe(true);
  });
});

describe("HeartbeatSubscriber — re-subscribe race", () => {
  it(
    "a re-subscribe aborts the prior stream and awaits its loop before starting fresh",
    async () => {
      const { factory, calls } = makeFakeLinkFactory();
      const monitor = makeFakeMonitor();
      const subscriber = new HeartbeatSubscriber({
        linkFactory: factory,
        monitor,
      });

      await subscriber.subscribe();
      await flush();
      const firstSignal = calls[0]?.options.signal;
      expect(firstSignal?.aborted).toBe(false);

      // Re-subscribe before any unsubscribe — the prior controller must
      // be aborted, the prior loop awaited, and a new link.call issued.
      await subscriber.subscribe();
      await flush();

      expect(firstSignal?.aborted).toBe(true);
      expect(calls).toHaveLength(2);
      // Second call must also pin the stealth path.
      expect(calls[1]?.path).toEqual(HEARTBEAT_PATH);
      // Distinct signal — the controller is fresh, not the prior one.
      expect(calls[1]?.options.signal).not.toBe(firstSignal);

      subscriber.unsubscribe();
    },
  );
});
