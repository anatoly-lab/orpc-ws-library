// Heartbeat publisher — single timer, N subscribers.
//
// Drives the ORPC `__orpc_ws_lib__.heartbeat` AsyncIterable. One ticker
// fans out to every subscriber via `@orpc/server`'s `EventPublisher`
// (formerly `@orpc/experimental-publisher/memory` in the source app —
// stable API, same shape, moved into core in 1.x).
//
// O(1) fan-out is load-bearing: the source gateway runs one
// `setInterval` regardless of connection count. If we put a per-
// connection timer here, a 10k-user cluster would have 10k timers — the
// publisher pattern preserves the constant cost.
//
// Subscription protocol — pinned for the wire contract:
//
//   1. FIRST event MUST be `{type:"config", intervalMs, timeoutMs}` so
//      the client's watchdog knows the deadline window.
//   2. Subsequent events MUST be `{type:"ping", ts}` at the configured
//      cadence. `ts` is the `clock.now()` at emission — client uses its
//      own injected clock for the actual deadline arithmetic (the wire
//      `ts` is diagnostics).
//   3. Abort signal terminates the iterable cleanly via the inner
//      `EventPublisher.subscribe({signal})`. No leaked listeners.
//   4. LAST-WINS per connection: a connection holds AT MOST ONE live
//      subscription — a new subscribe() carrying the same connection
//      identity gracefully ENDS the previous one. See `subscribe()`.

import { EventPublisher } from "@orpc/server";

import {
  type Clock,
  type Logger,
  type HeartbeatEvent,
  noopLogger,
  systemClock,
  type TimerHandle,
} from "@orpc-ws/shared";

import type { HeartbeatConfig } from "../config/heartbeat-config.js";

interface PingPayload {
  ts: number;
}

/**
 * EventPublisher's generic event map shape — keys are event names, values
 * are payload types. We only emit `ping`; the `config` event is
 * synthesized inline in `subscribe()` (it's per-subscription metadata,
 * not a fan-out event).
 */
type PublisherEvents = {
  ping: PingPayload;
};

export interface HeartbeatPublisherDeps {
  config: HeartbeatConfig;
  clock?: Clock;
  logger?: Logger;
}

/**
 * Owner of the fan-out timer + the per-subscription AsyncIterable.
 *
 * Lifecycle:
 *   - construct → start() → subscribe() (N times) → ... → stop() → dispose
 *   - subscribe() can be called before start() — the iterable will yield
 *     the config event immediately, then wait for the first publish.
 *   - stop() ends the timer but does NOT close existing iterables. They
 *     remain idle until their AbortSignal fires (typical: client closes
 *     the WS, ORPC aborts the AsyncIterable's `signal`).
 *
 * The deliberate split between `start()` (open the ticker) and the
 * construction of subscribers matches the composition root's wiring
 * order — the publisher is built before `OrpcWsServer.attach()`; the
 * ticker only meaningfully runs once at least one client subscribes.
 */
export class HeartbeatPublisher {
  private readonly config: HeartbeatConfig;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly publisher: EventPublisher<PublisherEvents>;
  private timer: TimerHandle | null = null;
  /**
   * The live subscription's kill switch, keyed by connection identity
   * (the connection's raw `ws` object — see `state/connection-identity.ts`).
   * Drives the last-wins bound: a new subscription for the same key aborts
   * the previous controller.
   *
   * WeakMap needs no disconnect cleanup: the key IS the `ws`, whose
   * lifetime is the connection's (registry / ping-pong / `wss.clients` all
   * drop it on 'close'), so entries vanish with the socket. A stale
   * controller left behind by a subscription that already ended naturally
   * is harmless — aborting an aborted controller is a no-op.
   */
  private readonly liveByConnection = new WeakMap<object, AbortController>();
  /**
   * Live fan-out subscriber count, maintained by each subscription's
   * generator around its attach/detach to the inner EventPublisher.
   * Needed because `EventPublisher.size` counts distinct EVENT NAMES with
   * listeners (its listeners map is keyed by event name), not listeners —
   * with only `ping` ever subscribed it reads 0 or 1 regardless of width.
   */
  private liveSubscriberCount = 0;

  constructor(deps: HeartbeatPublisherDeps) {
    this.config = deps.config;
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.publisher = new EventPublisher<PublisherEvents>();
  }

  /**
   * Returns the AsyncIterable served from the ORPC heartbeat procedure.
   *
   * The shape is:
   *   yield config event (always, immediately)
   *   for await ping of publisher.subscribe('ping', { signal })
   *     yield ping
   *
   * Caller (`buildSystemRouter`) returns this iterable directly from
   * the procedure handler. ORPC's WS adapter pipes each event to the
   * client.
   *
   * `connection` is the subscriber's per-connection identity (the raw
   * `ws` — see `state/connection-identity.ts`). When present, this
   * subscription REPLACES the connection's previous live one (last-wins,
   * see below). When absent (the HTTP upload transport, or a direct test
   * call), the subscription is untracked — pre-existing behavior.
   */
  subscribe(
    signal?: AbortSignal,
    connection?: object,
  ): AsyncIterableIterator<HeartbeatEvent> {
    const config = this.config;
    const publisher = this.publisher;
    // `gen` below is a standalone generator function (no `this`); bridge
    // the live-subscriber counter through arrow closures. Incremented at
    // fan-out attach, decremented exactly once at detach (the generator's
    // `finally` around the ping loop), so `subscriberCount()` reflects the
    // true fan-out width — see `liveSubscriberCount` for why
    // `EventPublisher.size` cannot.
    const onAttach = (): void => {
      this.liveSubscriberCount += 1;
    };
    const onDetach = (): void => {
      this.liveSubscriberCount -= 1;
    };

    // LAST-WINS per connection (decided 2026-07-02). Without a bound, one
    // WS connection could call the stealth heartbeat procedure unbounded
    // times, each call parking an EventPublisher subscriber + generator
    // that is only freed at disconnect — in authless mode that is
    // unauthenticated per-connection memory growth. Last-wins was chosen
    // over a numeric cap because it strictly bounds memory at 1 with zero
    // configuration, and the library's own client is single-subscription
    // by construction (it always aborts its previous subscription before
    // resubscribing) — so a legitimate client never observes the takeover.
    //
    // `internal` is this subscription's private kill switch: it aborts
    // when EITHER the transport-level `signal` fires (disconnect — the
    // pre-existing cleanup path, forwarded inside the generator) OR a
    // successor subscription on the same connection supersedes this one.
    // Registration happens HERE, synchronously, not in the (lazy)
    // generator body — so two back-to-back subscribes still last-wins
    // even if the first was never pumped.
    const internal = new AbortController();
    if (connection) {
      this.liveByConnection.get(connection)?.abort();
      this.liveByConnection.set(connection, internal);
    }

    // ORPC's wire serializer (`isAsyncIteratorObject` in
    // `@orpc/standard-server-peer`) checks for BOTH `Symbol.asyncIterator`
    // AND a `next()` method on the SAME object. An async generator function
    // satisfies both because its returned generator is its own iterator —
    // returning the generator directly (not an `AsyncIterable` wrapper that
    // exposes only `[Symbol.asyncIterator]`) is what makes ORPC frame the
    // response as an event stream instead of rejecting it as "stream is not
    // async iterable".
    async function* gen(): AsyncIterableIterator<HeartbeatEvent> {
      // Forward the transport abort into the private controller so ONE
      // signal (internal) governs the inner ping iterator regardless of
      // WHY the subscription ends (disconnect vs supersede). `once` plus
      // the `finally` removal keep the transport signal free of leaked
      // listeners however the generator exits.
      const forwardAbort = (): void => internal.abort();
      if (signal?.aborted) internal.abort();
      else signal?.addEventListener("abort", forwardAbort, { once: true });

      try {
        // Step 1: deliver the per-subscription config event. Client's
        // monitor uses these to compute its deadline window.
        yield {
          type: "config",
          intervalMs: config.intervalMs,
          timeoutMs: config.timeoutMs,
        } satisfies HeartbeatEvent;

        // Superseded (or disconnected) while parked at the config yield —
        // end without ever attaching to the fan-out.
        if (internal.signal.aborted) return;

        // Step 2: fan-out subscription via the publisher. The publisher's
        // own iterator honors the abort signal — when it fires (ORPC
        // aborted the iterable because the client closed the WS, or a
        // successor subscription superseded this one), `pingIter.next()`
        // throws and the for-await exits cleanly.
        const pingIter = publisher.subscribe("ping", {
          signal: internal.signal,
        });
        onAttach();
        try {
          for await (const ping of pingIter) {
            if (internal.signal.aborted) break;
            yield { type: "ping", ts: ping.ts } satisfies HeartbeatEvent;
          }
        } catch (err) {
          // EventPublisher surfaces aborts as throws; absorb when OUR
          // controller is the cause (disconnect or supersede) so the
          // iterable closes gracefully (`done`), not with an error —
          // a superseded consumer sees a clean end of stream.
          if (internal.signal.aborted) return;
          throw err;
        } finally {
          onDetach();
        }
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
      }
    }

    return gen();
  }

  /**
   * Start the fan-out ticker. Idempotent — calling twice is a no-op so
   * the composition root can call `start()` defensively without
   * tracking state.
   *
   * Once started, every `intervalMs` the publisher emits a `ping` event;
   * every subscriber's AsyncIterable receives it. The publisher's
   * internal queue handles slow consumers (configurable via
   * `EventPublisherOptions` — we use the default for now).
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setInterval(() => {
      const ts = this.clock.now();
      // Debug-only — gated by the consumer's logger level. Lets a future
      // deep-dive session confirm the ticker is alive and observe the
      // current fan-out width without enabling info-level chatter.
      this.logger.debug("heartbeat-publisher: tick", {
        subscriberCount: this.liveSubscriberCount,
      });
      try {
        this.publisher.publish("ping", { ts });
      } catch (err) {
        // Defensive: a subscriber's listener should not throw, but if
        // EventPublisher ever surfaces one, don't kill the timer.
        this.logger.error("heartbeat-publisher: publish threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.config.intervalMs);
    this.logger.info("heartbeat-publisher: started", {
      intervalMs: this.config.intervalMs,
    });
  }

  /**
   * Stop the fan-out ticker. Idempotent. Existing iterables remain idle
   * (no more pings); they only close when their `signal` fires.
   */
  stop(): void {
    if (this.timer === null) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
    this.logger.info("heartbeat-publisher: stopped");
  }

  /**
   * Test-only — the number of LIVE fan-out subscribers (attached ping
   * iterators). Counts subscribers, not event names — `EventPublisher.size`
   * would read 0/1 only (see `liveSubscriberCount`).
   */
  subscriberCount(): number {
    return this.liveSubscriberCount;
  }
}
