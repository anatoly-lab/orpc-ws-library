// Bug 18 regression — concurrent subscribe() must not leak an
// unabortable heartbeat loop.
//
// The bug (docs/fable/bugs-review.md §BUG-7): `subscribe()`'s re-entry
// barrier was not atomic across its `await`:
//
//   if (this.abortController || this.activeLoop) {
//     this.unsubscribe();
//     const prior = this.activeLoop;
//     this.activeLoop = null;        // <-- 2nd caller now sees a clean slate
//     if (prior) await prior;        // <-- suspension point
//   }
//   const controller = new AbortController();
//   this.abortController = controller;  // <-- 1st caller resumes, OVERWRITES
//
// Interleaving (fast open→close→open churn — the composition root calls
// `void heartbeatSubscriber.subscribe()` on every open):
//   open#1 → loop-1 live. close → unsubscribe(). open#2 → subscribe() A:
//   enters the barrier (activeLoop still set), nulls the fields, awaits
//   loop-1's drain. open#3 → subscribe() B: both fields are null, skips
//   the barrier, starts loop-B and installs controller-B. A resumes,
//   starts loop-A and OVERWRITES abortController/activeLoop → loop-B's
//   controller is unreachable. unsubscribe()/stop()/dispose() abort only
//   loop-A; loop-B keeps consuming the stream and calling
//   monitor.recordPing() forever — permanently feeding the watchdog from
//   a stale subscription and masking real heartbeat timeouts.
//
// The fix: a generation counter. Each subscribe() claims `++generation`
// before any await and bails after the barrier if a newer call claimed a
// higher generation. Net effect: after ANY interleaving of concurrent
// subscribe() calls, exactly ONE loop is live and it IS the one
// unsubscribe() aborts.
//
// Harness mirrors subscriber.test.ts: fake LinkFactory whose link records
// every call() and returns a per-call controllable AsyncIterable.

import { describe, expect, it, vi } from "vitest";

import type { LinkFactory } from "../../client/link-factory.js";
import type { HeartbeatMonitor } from "../monitor.js";

import { HeartbeatSubscriber } from "../subscriber.js";
import { HEARTBEAT_PATH, type HeartbeatEvent } from "../types.js";

// ---------- Helpers (mirrors subscriber.test.ts) ----------

function makeControllableStream(): {
  iterable: AsyncIterable<HeartbeatEvent>;
  push: (event: HeartbeatEvent) => void;
  bindSignal: (signal: AbortSignal) => void;
} {
  const queue: HeartbeatEvent[] = [];
  let pendingResolve: ((value: IteratorResult<HeartbeatEvent>) => void) | null =
    null;
  let pendingReject: ((err: unknown) => void) | null = null;
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
    if (queue.length > 0) {
      const evt = queue.shift()!;
      const r = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      r?.({ value: evt, done: false });
    }
  };

  const iterable: AsyncIterable<HeartbeatEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<HeartbeatEvent> {
      return {
        next: (): Promise<IteratorResult<HeartbeatEvent>> => {
          return new Promise<IteratorResult<HeartbeatEvent>>(
            (resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;
              settle();
            },
          );
        },
      };
    },
  };

  return {
    iterable,
    push: (event) => {
      queue.push(event);
      settle();
    },
    bindSignal: (s) => {
      signal = s;
      if (s.aborted) {
        settle();
      } else {
        s.addEventListener("abort", () => settle());
      }
    },
  };
}

interface CallRecord {
  path: readonly string[];
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
        _input: unknown,
        options: { signal?: AbortSignal; context: Record<string, unknown> },
      ) => {
        const stream = makeControllableStream();
        if (options.signal) {
          stream.bindSignal(options.signal);
        }
        calls.push({ path, options, stream });
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

function makeFakeMonitor(): HeartbeatMonitor & { recordPingCalls: number } {
  let recordPingCalls = 0;
  const monitor = {
    configure: () => {},
    start: () => {},
    stop: () => {},
    recordPing: () => {
      recordPingCalls++;
    },
    onTimeout: () => {},
  } as unknown as HeartbeatMonitor;
  Object.defineProperty(monitor, "recordPingCalls", {
    get: () => recordPingCalls,
  });
  return monitor as HeartbeatMonitor & { recordPingCalls: number };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

// ---------- Test ----------

describe("Bug 18 — concurrent subscribe() leaks an unabortable loop", () => {
  it(
    "after open#1 → unsubscribe → concurrent subscribe A + B, exactly one " +
      "loop is live and unsubscribe() actually stops it",
    async () => {
      const { factory, calls } = makeFakeLinkFactory();
      const monitor = makeFakeMonitor();
      const subscriber = new HeartbeatSubscriber({
        linkFactory: factory,
        monitor,
      });

      // open#1: loop-1 live and pinging.
      await subscriber.subscribe();
      await flush();
      expect(calls).toHaveLength(1);
      calls[0]!.stream.push({ type: "ping", ts: 1_000 });
      await flush();
      expect(monitor.recordPingCalls).toBe(1);

      // close: abort loop-1. Its drain (catch/finally) is still pending
      // on the microtask queue — that's the window the bug needs.
      subscriber.unsubscribe();

      // open#2 (caller A): enters the barrier (activeLoop still set),
      // nulls the fields, suspends awaiting loop-1's drain.
      const a = subscriber.subscribe();
      // open#3 (caller B): runs synchronously before A resumes — sees the
      // clean slate A left behind, skips the barrier, starts its loop.
      const b = subscriber.subscribe();

      await Promise.all([a, b]);
      await flush();

      // Exactly ONE new loop. Pre-fix, caller A resumed after B and
      // started a second one (calls.length === 3), overwriting B's
      // controller and orphaning B's loop.
      expect(calls).toHaveLength(2);
      expect(calls[1]!.path).toEqual(HEARTBEAT_PATH);
      expect(calls[1]!.options.signal?.aborted).toBe(false);

      // The live loop feeds the monitor...
      calls[1]!.stream.push({ type: "ping", ts: 2_000 });
      await flush();
      expect(monitor.recordPingCalls).toBe(2);

      // ...and unsubscribe() actually reaches it. Pre-fix, the held
      // controller belonged to A's loop, so B's orphaned loop survived
      // this call and kept feeding the watchdog.
      subscriber.unsubscribe();
      await flush();
      expect(calls[1]!.options.signal?.aborted).toBe(true);

      // No further pings land on the monitor from ANY stream.
      for (const call of calls) {
        call.stream.push({ type: "ping", ts: 3_000 });
      }
      await flush();
      expect(monitor.recordPingCalls).toBe(2);
    },
  );

  it("N overlapping subscribes settle to one live, abortable loop", async () => {
    const { factory, calls } = makeFakeLinkFactory();
    const monitor = makeFakeMonitor();
    const subscriber = new HeartbeatSubscriber({
      linkFactory: factory,
      monitor,
    });

    // Fire 4 subscribes with no awaits in between — every interleaving
    // of barrier-entry and clean-slate-skip is in play.
    const first = subscriber.subscribe();
    const rest = [
      subscriber.subscribe(),
      subscriber.subscribe(),
      subscriber.subscribe(),
    ];
    await Promise.all([first, ...rest]);
    await flush();

    // Whatever the interleaving, at most one signal is still live.
    const liveCalls = calls.filter((c) => c.options.signal?.aborted === false);
    expect(liveCalls).toHaveLength(1);

    // And unsubscribe() kills it — afterwards nothing reaches the monitor.
    subscriber.unsubscribe();
    await flush();
    expect(liveCalls[0]!.options.signal?.aborted).toBe(true);

    const pingsBefore = monitor.recordPingCalls;
    for (const call of calls) {
      call.stream.push({ type: "ping", ts: 9_000 });
    }
    await flush();
    expect(monitor.recordPingCalls).toBe(pingsBefore);
  });
});
