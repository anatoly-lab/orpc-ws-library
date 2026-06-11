// NFI-1 regression: heartbeat stream failing BEFORE the `config` event
// left the connection permanently unmonitored.
//
// docs/fable/bugs-review.md §"Needs further investigation" item 1:
// if the heartbeat AsyncIterable errors before `config` (e.g. `link.call`
// rejects because the server has no stealth heartbeat router, or the
// server-side procedure errors while the WS stays open), the monitor is
// never `configure()`d, so `start()` no-ops and the watchdog never arms.
// `onTimeout` — the composition root's whole recovery path — can then
// NEVER fire: a later half-open zombie goes undetected, silently.
//
// Fix: the subscriber retries the subscription a bounded number of times
// (`preConfigMaxRetries`, `preConfigRetryDelayMs` deps; Clock-seamed) on a
// PRE-config failure only. POST-config failures keep the source contract:
// no resubscribe — the armed watchdog owns recovery. Any explicit
// `subscribe()` / `unsubscribe()` cancels a pending retry, so teardown
// paths (dispose / kick / terminal / per-close hook) can't race it.

import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger, TimerHandle } from "@repo/orpc-ws-shared";

import type { LinkFactory } from "../../client/link-factory.js";
import type { HeartbeatMonitor } from "../monitor.js";

import { HeartbeatSubscriber } from "../subscriber.js";
import { HEARTBEAT_PATH, type HeartbeatEvent } from "../types.js";

// ---------- Fake clock (setTimeout/clearTimeout only) ----------

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
  pendingCount: () => number;
} {
  let now = 0;
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

  const advance = async (ms: number): Promise<void> => {
    now += ms;
    let safety = 100;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      // Let the async subscribe machinery settle between fires.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  return {
    clock,
    advance,
    pendingCount: () => timers.filter((t) => !t.cancelled).length,
  };
}

// ---------- Controllable stream (subset of subscriber.test.ts helper) ----------

function makeControllableStream(): {
  iterable: AsyncIterable<HeartbeatEvent>;
  push: (event: HeartbeatEvent) => void;
  error: (err: Error) => void;
} {
  const queue: HeartbeatEvent[] = [];
  let pendingResolve: ((r: IteratorResult<HeartbeatEvent>) => void) | null =
    null;
  let pendingReject: ((err: unknown) => void) | null = null;
  let pendingError: Error | null = null;

  const settle = (): void => {
    if (!pendingResolve && !pendingReject) return;
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
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<HeartbeatEvent>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
            settle();
          }),
      }),
    },
    push: (event) => {
      queue.push(event);
      settle();
    },
    error: (err) => {
      pendingError = err;
      settle();
    },
  };
}

// ---------- Fake link factory with scriptable per-call outcomes ----------
// `script[i]` decides the i-th `link.call`: "reject" → the call itself
// rejects (the no-stealth-router shape); "stream" → returns a controllable
// stream the test drives. Calls beyond the script default to "stream".

function makeScriptableLinkFactory(script: Array<"reject" | "stream">): {
  factory: LinkFactory;
  calls: Array<{ stream: ReturnType<typeof makeControllableStream> | null }>;
} {
  const calls: Array<{
    stream: ReturnType<typeof makeControllableStream> | null;
  }> = [];
  const link = {
    call: vi.fn(async (path: readonly string[]) => {
      expect(path).toEqual(HEARTBEAT_PATH);
      const mode = script[calls.length] ?? "stream";
      if (mode === "reject") {
        calls.push({ stream: null });
        throw new Error("Procedure not found: __orpc_ws_lib__.heartbeat");
      }
      const stream = makeControllableStream();
      calls.push({ stream });
      return stream.iterable;
    }),
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
  startCalls: number;
} {
  const configureCalls: { intervalMs: number; timeoutMs: number }[] = [];
  let startCalls = 0;
  const monitor = {
    configure: (intervalMs: number, timeoutMs: number) => {
      configureCalls.push({ intervalMs, timeoutMs });
    },
    start: () => {
      startCalls++;
    },
    stop: () => {},
    recordPing: () => {},
    onTimeout: () => {},
  } as unknown as HeartbeatMonitor;
  Object.defineProperty(monitor, "configureCalls", {
    get: () => configureCalls,
  });
  Object.defineProperty(monitor, "startCalls", { get: () => startCalls });
  return monitor as HeartbeatMonitor & {
    configureCalls: { intervalMs: number; timeoutMs: number }[];
    startCalls: number;
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const RETRY_DELAY_MS = 1_000;

function build(script: Array<"reject" | "stream">, maxRetries = 3) {
  const { clock, advance, pendingCount } = makeFakeClock();
  const { factory, calls } = makeScriptableLinkFactory(script);
  const monitor = makeFakeMonitor();
  const logger = makeLogger();
  const subscriber = new HeartbeatSubscriber({
    linkFactory: factory,
    monitor,
    logger,
    clock,
    preConfigMaxRetries: maxRetries,
    preConfigRetryDelayMs: RETRY_DELAY_MS,
  });
  return { subscriber, calls, monitor, logger, advance, pendingCount };
}

// ---------- Tests ----------

describe("NFI-1 — pre-config stream failure leaves the connection unmonitored", () => {
  it(
    "nfi-01: link.call rejecting before config retries the subscription " +
      "and the monitor arms on the retry's config event",
    async () => {
      const ctx = build(["reject", "stream"]);

      await ctx.subscriber.subscribe();
      await flush();

      // First attempt failed before any config — pre-fix this was the
      // end of the story: no retry, monitor never configured, watchdog
      // never armed.
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.monitor.configureCalls).toEqual([]);

      // The bounded retry fires after the configured delay…
      await ctx.advance(RETRY_DELAY_MS);
      expect(ctx.calls).toHaveLength(2);

      // …and the fresh stream's config event arms the watchdog.
      ctx.calls[1]?.stream?.push({
        type: "config",
        intervalMs: 25_000,
        timeoutMs: 5_000,
      });
      await flush();

      expect(ctx.monitor.configureCalls).toEqual([
        { intervalMs: 25_000, timeoutMs: 5_000 },
      ]);
      expect(ctx.monitor.startCalls).toBe(1);

      ctx.subscriber.unsubscribe();
    },
  );

  it(
    "nfi-01: a stream erroring before its config event (server procedure " +
      "errored, WS healthy) also retries",
    async () => {
      const ctx = build(["stream", "stream"]);

      await ctx.subscriber.subscribe();
      await flush();
      expect(ctx.calls).toHaveLength(1);

      // The call succeeded but the stream dies before emitting config.
      ctx.calls[0]?.stream?.error(new Error("heartbeat procedure threw"));
      await flush();

      await ctx.advance(RETRY_DELAY_MS);
      expect(ctx.calls).toHaveLength(2);

      ctx.subscriber.unsubscribe();
    },
  );

  it(
    "nfi-01: the retry budget is bounded — after preConfigMaxRetries " +
      "failures it gives up loudly and stops calling",
    async () => {
      const ctx = build(["reject", "reject", "reject"], 2);

      await ctx.subscriber.subscribe();
      await flush();
      expect(ctx.calls).toHaveLength(1);

      await ctx.advance(RETRY_DELAY_MS); // retry 1
      expect(ctx.calls).toHaveLength(2);
      await ctx.advance(RETRY_DELAY_MS); // retry 2 — budget exhausted after
      expect(ctx.calls).toHaveLength(3);

      // No further timer is armed; time marching on changes nothing.
      expect(ctx.pendingCount()).toBe(0);
      await ctx.advance(10 * RETRY_DELAY_MS);
      expect(ctx.calls).toHaveLength(3);

      // The give-up is loud — the maintainer asked for "unmonitored" to
      // be observable, not silent.
      expect(
        ctx.logger.calls.some(
          (c) => c.level === "error" && c.msg.includes("UNMONITORED"),
        ),
      ).toBe(true);
    },
  );

  it("nfi-01: unsubscribe() cancels a pending pre-config retry", async () => {
    const ctx = build(["reject", "stream"]);

    await ctx.subscriber.subscribe();
    await flush();
    expect(ctx.pendingCount()).toBe(1); // retry armed

    // Teardown (per-close hook / dispose / kick / terminal all route
    // through unsubscribe) must cancel the retry — a dead client never
    // re-subscribes.
    ctx.subscriber.unsubscribe();
    expect(ctx.pendingCount()).toBe(0);

    await ctx.advance(10 * RETRY_DELAY_MS);
    expect(ctx.calls).toHaveLength(1);
  });

  it(
    "nfi-01: a fresh subscribe() cancels the pending retry — the new " +
      "subscription owns the (full) budget, no doubled loops",
    async () => {
      const ctx = build(["reject", "stream", "stream"]);

      await ctx.subscriber.subscribe();
      await flush();
      expect(ctx.pendingCount()).toBe(1); // retry armed

      // Reconnect happened: the per-open hook subscribes fresh.
      await ctx.subscriber.subscribe();
      await flush();
      expect(ctx.calls).toHaveLength(2);
      expect(ctx.pendingCount()).toBe(0); // stale retry cancelled

      // The old retry never fires a third call.
      await ctx.advance(10 * RETRY_DELAY_MS);
      expect(ctx.calls).toHaveLength(2);

      ctx.subscriber.unsubscribe();
    },
  );

  it(
    "nfi-01: POST-config stream errors do NOT arm a retry — the armed " +
      "watchdog owns recovery there (source contract preserved)",
    async () => {
      const ctx = build(["stream"]);

      await ctx.subscriber.subscribe();
      await flush();

      ctx.calls[0]?.stream?.push({
        type: "config",
        intervalMs: 25_000,
        timeoutMs: 5_000,
      });
      await flush();
      expect(ctx.monitor.startCalls).toBe(1);

      ctx.calls[0]?.stream?.error(new Error("died after config"));
      await flush();

      expect(ctx.pendingCount()).toBe(0);
      await ctx.advance(10 * RETRY_DELAY_MS);
      expect(ctx.calls).toHaveLength(1);
    },
  );
});
