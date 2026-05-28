// Bug 8 regression — heartbeat travels through ORPC framing, not raw WS.
//
// Pre-history of Bug 8 (from the source app's bug postmortems): an early
// implementation sent heartbeat pings via raw `ws.send(...)` frames,
// bypassing ORPC entirely. The result: half the time, the message was
// interleaved mid-RPC-call and corrupted the StandardRPCSerializer's
// framing buffer. Bug 8's fix was "always go through the link".
//
// The Phase 1.5 design takes that one step further with the stealth
// procedure pattern (CLAUDE.md "Heartbeat ownership — stealth procedure
// pattern"). Now heartbeat goes through the link AND on a library-owned
// path (`["__orpc_ws_lib__", "heartbeat"]`) — not the source app's old
// `["system", "heartbeat"]` which would have leaked into the consumer's
// typed contract.
//
// This file regresses BOTH:
//   1. heartbeat MUST go through `link.call(...)` (Bug 8 base regression);
//   2. the path MUST be the stealth-namespace tuple — NOT
//      `["system", "heartbeat"]` (the old typed-contract path the source
//      used pre-library), NOT raw `ws.send(...)`, NOT anything else.
//
// We test by stubbing `LinkFactory` so the underlying link records every
// `call()` invocation, plus we wire in a `ws` spy that fails the test if
// ANYTHING is sent through raw `send()` (to be precise: nothing in the
// subscriber's surface path should reach a raw WS send — the link is
// the only legitimate consumer of `ws.send()`, and we don't go through a
// real link here).

import { describe, expect, it, vi } from "vitest";

import type { LinkFactory } from "../../client/link-factory.js";
import type { HeartbeatMonitor } from "../monitor.js";

import { HeartbeatSubscriber } from "../subscriber.js";
import { HEARTBEAT_PATH } from "../types.js";

/**
 * Stub link that lets the test pin every `call()`. The AsyncIterable it
 * returns is a never-resolving promise so the consumer's `for await`
 * blocks until `unsubscribe()`; perfect for asserting the path WITHOUT
 * also driving events.
 */
function makeRecordingLinkFactory(): {
  factory: LinkFactory;
  recordedCalls: {
    path: readonly string[];
    input: unknown;
    options: { signal?: AbortSignal; context: Record<string, unknown> };
  }[];
  rawSend: ReturnType<typeof vi.fn>;
} {
  const recordedCalls: {
    path: readonly string[];
    input: unknown;
    options: { signal?: AbortSignal; context: Record<string, unknown> };
  }[] = [];
  const rawSend = vi.fn();

  const neverEndingStream: AsyncIterable<never> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<never>>(() => {
            // never resolves — the subscriber sits inside `for await`
            // until the controller aborts.
          }),
      };
    },
  };

  const link = {
    call: vi.fn(
      async (
        path: readonly string[],
        input: unknown,
        options: { signal?: AbortSignal; context: Record<string, unknown> },
      ) => {
        recordedCalls.push({ path, input, options });
        return neverEndingStream;
      },
    ),
    // If somebody calls raw send, we want to know. The real LinkFactory
    // would not expose a `send` method, but the legacy pre-Bug-8 code
    // bypassed the link entirely; this trap catches a regression that
    // would have done that.
    send: rawSend,
  };

  const factory = {
    getLink: () => link,
    clearLink: () => {},
    hasLink: () => true,
  } as unknown as LinkFactory;

  return { factory, recordedCalls, rawSend };
}

function makeNoopMonitor(): HeartbeatMonitor {
  return {
    configure: () => {},
    start: () => {},
    stop: () => {},
    recordPing: () => {},
    onTimeout: () => {},
  } as unknown as HeartbeatMonitor;
}

describe("Bug 8 regression — heartbeat over ORPC link (stealth path)", () => {
  it(
    "subscribe() reaches the heartbeat procedure via link.call (NOT raw ws.send)",
    async () => {
      const { factory, recordedCalls, rawSend } = makeRecordingLinkFactory();
      const subscriber = new HeartbeatSubscriber({
        linkFactory: factory,
        monitor: makeNoopMonitor(),
      });

      await subscriber.subscribe();
      // Microtask flush for the `await link.call(...)` to settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(recordedCalls).toHaveLength(1);
      // Raw frame send (the pre-Bug-8 approach) must NEVER tick.
      expect(rawSend).not.toHaveBeenCalled();

      subscriber.unsubscribe();
    },
  );

  it(
    "the heartbeat call uses the stealth namespace path " +
      "['__orpc_ws_lib__', 'heartbeat'] — NOT ['system', 'heartbeat']",
    async () => {
      const { factory, recordedCalls } = makeRecordingLinkFactory();
      const subscriber = new HeartbeatSubscriber({
        linkFactory: factory,
        monitor: makeNoopMonitor(),
      });

      await subscriber.subscribe();
      await Promise.resolve();
      await Promise.resolve();

      const path = recordedCalls[0]?.path;
      expect(path).toEqual(["__orpc_ws_lib__", "heartbeat"]);
      expect(path).toEqual(HEARTBEAT_PATH);

      // The pre-stealth path. If a future refactor regresses to this,
      // the consumer's typed contract would have to re-declare
      // `system.heartbeat` — the exact coupling the stealth pattern
      // exists to avoid.
      expect(path).not.toEqual(["system", "heartbeat"]);

      subscriber.unsubscribe();
    },
  );

  it(
    "the heartbeat call carries the controller's signal in options — proves the path is unambiguous",
    async () => {
      const { factory, recordedCalls } = makeRecordingLinkFactory();
      const subscriber = new HeartbeatSubscriber({
        linkFactory: factory,
        monitor: makeNoopMonitor(),
      });

      await subscriber.subscribe();
      await Promise.resolve();
      await Promise.resolve();

      expect(recordedCalls[0]?.options.signal).toBeInstanceOf(AbortSignal);

      subscriber.unsubscribe();
    },
  );
});
