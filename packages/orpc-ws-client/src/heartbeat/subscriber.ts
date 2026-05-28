// Heartbeat stream subscriber.
//
// Phase 1.5 lift from `apps/web/src/lib/websocket/heartbeat/heartbeat-subscriber.ts`.
//
// MAJOR difference from the source — the "stealth procedure" path:
//
//   source: `await orpcClient.system.heartbeat({ signal })`
//     →  required the consumer's `appContract` type to declare a
//        `system.heartbeat` AsyncIterable procedure. D1 from the design
//        doc — "your TContract must extend ours" coupling.
//
//   library: `await linkFactory.getLink().call(HEARTBEAT_PATH, undefined, opts)`
//     →  reaches the same wire address through the low-level link API,
//        bypassing the consumer's typed proxy. The consumer's `TContract`
//        is untouched.
//
// CLAUDE.md "Heartbeat ownership — stealth procedure pattern" pins the
// rationale: the server-side `router-composer` (Phase 3) spreads a
// library-owned sub-router under the reserved namespace and asserts
// non-collision; the client reaches that sub-router by literal path.
// Path lives in `types.ts` (HEARTBEAT_PATH) so server + client share
// one literal.
//
// Other diffs from source:
//   1. No module-level singleton — class export.
//   2. `console.log` / `console.error` → injected `Logger`. The
//      `Math.random() < 0.05` log-throttle on every ping is gone; debug
//      logs are emitted on every ping but at debug-level — the consumer's
//      logger can throttle if desired.
//   3. The collaborators (`linkFactory`, `monitor`) move from
//      method arguments to constructor injection. The source's
//      `subscribe(client, monitor)` shape was awkward — the subscriber
//      already had to own `abortController` state across calls, and the
//      composition root knew both collaborators at wire-up time. Lifting
//      them to construction lets `subscribe()` be argument-free, which
//      matches the lifecycle ("start consuming the stream the controller
//      knows how to make").
//   4. `stop()` aliases `unsubscribe()` so the subscriber conforms to
//      the `{ stop(): void }` shape `ReconnectManager` expects from a
//      heartbeat collaborator (Phase 1.3 cross-phase note).
//
// On reconnect:
//   The source's `subscribe()` did NOT auto-resubscribe on stream error
//   or close — that's the composition root's job (heartbeat-timeout →
//   ReconnectManager → fresh subscribe on next connect). We preserve
//   that contract verbatim: the consumption loop exits, we log, we
//   detach. The wiring at the composition root decides what happens
//   next.

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type { LinkFactory } from "../client/link-factory.js";

import { HEARTBEAT_PATH, type HeartbeatEvent } from "./types.js";
import type { HeartbeatMonitor } from "./monitor.js";

/**
 * Dependencies for HeartbeatSubscriber. `logger` defaults to noop; the
 * composition root wires the real one.
 */
export interface HeartbeatSubscriberDeps {
  linkFactory: LinkFactory;
  monitor: HeartbeatMonitor;
  logger?: Logger;
}

/**
 * Consumes the `__orpc_ws_lib__.heartbeat` AsyncIterable and drives the
 * monitor.
 *
 * Lifecycle:
 *   - `subscribe()` — kick off the consumption loop. Idempotent in the
 *     sense that calling it while a subscription is live first awaits
 *     the prior teardown, then re-starts. This matters during a
 *     reconnect race where the composition root may re-subscribe before
 *     the previous AsyncIterable has finished draining.
 *   - `unsubscribe()` — abort the controller. The AsyncIterable's `next()`
 *     throws on abort, breaking the `for await` loop. After unsubscribe,
 *     no further `monitor.recordPing()` or `monitor.configure()` calls
 *     can land (the loop is the only call site).
 *   - `stop()` — alias for `unsubscribe()`. Conforms to the
 *     `{ stop(): void }` shape ReconnectManager expects from a
 *     heartbeat collaborator (Phase 1.3 cross-phase note).
 */
export class HeartbeatSubscriber {
  private readonly linkFactory: LinkFactory;
  private readonly monitor: HeartbeatMonitor;
  private readonly logger: Logger;

  /**
   * AbortController for the current consumption loop. Replaced on every
   * `subscribe()` call so a stale controller from a previous (aborted)
   * subscription can't accidentally abort the next one.
   */
  private abortController: AbortController | null = null;
  /**
   * Promise of the current consumption-loop body. Tracked so
   * `subscribe()` can `await` it on a re-subscribe — otherwise two loops
   * could run concurrently and both call `monitor.recordPing()` on
   * conflicting timestamps.
   */
  private activeLoop: Promise<void> | null = null;

  constructor(deps: HeartbeatSubscriberDeps) {
    this.linkFactory = deps.linkFactory;
    this.monitor = deps.monitor;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Subscribe to the heartbeat stream and drive the monitor until the
   * stream ends or `unsubscribe()` is called.
   *
   * If a previous subscription is still draining, this method first
   * aborts it and awaits its loop body — guarantees a single live
   * consumption loop at any time.
   */
  async subscribe(): Promise<void> {
    // Tear down any prior subscription and wait for its loop to exit.
    // Without this await, a `subscribe()` called from inside the
    // composition root's reconnect path could start a second loop
    // alongside the first — both calling `monitor.recordPing()`, both
    // racing on `monitor.configure()`.
    if (this.abortController || this.activeLoop) {
      this.unsubscribe();
      const prior = this.activeLoop;
      this.activeLoop = null;
      if (prior) {
        // The prior loop catches its own errors (aborts surface as a
        // logged debug); awaiting it here is purely a sync barrier.
        await prior;
      }
    }

    const controller = new AbortController();
    this.abortController = controller;

    const loop = this.runLoop(controller);
    this.activeLoop = loop;
    // The PUBLIC `subscribe()` returns once we've kicked off the loop —
    // we do NOT await `loop` here. The loop runs for the lifetime of the
    // stream; the source had the same fire-and-await-elsewhere shape.
    // The caller (composition root) doesn't block on the stream's
    // lifetime, only on the initial handoff.
    //
    // We don't return a reference to `loop` because the only legitimate
    // way to interrupt it is `unsubscribe()`/`stop()`; callers don't
    // need the promise.
    void loop;
  }

  /**
   * Abort the current consumption loop. Idempotent. After this call,
   * the AsyncIterable's next `next()` rejects with an AbortError, the
   * loop exits, and no further events reach the monitor.
   *
   * Does NOT stop the monitor itself — the composition root is
   * responsible for that orchestration (`monitor.stop()` lives on the
   * same shutdown path).
   */
  unsubscribe(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Alias for `unsubscribe()`. Exists so the subscriber conforms to the
   * `{ stop(): void }` shape ReconnectManager expects from a heartbeat
   * collaborator (Phase 1.3 cross-phase note). The composition root
   * passes `this` to ReconnectManager via the same interface.
   */
  stop(): void {
    this.unsubscribe();
  }

  /**
   * The actual consumption loop. Separate from `subscribe()` so the
   * latter can `void` it cleanly (we don't want the public surface to
   * hand back a promise that resolves at stream end).
   *
   * Stealth path: `link.call(HEARTBEAT_PATH, undefined, opts)`. The
   * literal path comes from `types.ts` — server-side composer (Phase 3)
   * spreads its sub-router under the SAME tuple, so this is the
   * end-to-end ABI of the stealth heartbeat.
   *
   * `context: {}` is required by `ClientOptions<Record<string, never>>`;
   * LinkFactory currently fixes the link's client-context type to the
   * empty record, so this empty object is the only valid value. If the
   * library later surfaces context typing, both sides widen together.
   */
  private async runLoop(controller: AbortController): Promise<void> {
    const { signal } = controller;
    try {
      this.logger.debug("heartbeat-subscriber: subscribing", {
        path: HEARTBEAT_PATH,
      });

      const link = this.linkFactory.getLink();
      // The return type of `link.call` is `Promise<unknown>` — the
      // heartbeat procedure on the server-side router returns an
      // AsyncIterable, so we cast to the wire type defined in types.ts.
      // Any deviation in shape (e.g. server emits a non-event object)
      // would surface as a missing `type` discriminant at the consume
      // site below.
      const stream = (await link.call(HEARTBEAT_PATH, undefined, {
        signal,
        context: {},
      })) as AsyncIterable<HeartbeatEvent>;

      for await (const event of stream) {
        // Defensive double-check: between `for await` iterations a
        // dispose could have aborted the controller. The AsyncIterable
        // will surface the abort on its next pump, but spending CPU on
        // a stale event before that is wasteful.
        if (signal.aborted) break;

        if (event.type === "config") {
          this.logger.info("heartbeat-subscriber: config received", {
            intervalMs: event.intervalMs,
            timeoutMs: event.timeoutMs,
          });
          this.monitor.configure(event.intervalMs, event.timeoutMs);
          this.monitor.start();
        } else if (event.type === "ping") {
          this.monitor.recordPing();
          this.logger.debug("heartbeat-subscriber: ping", { ts: event.ts });
        }
      }
      this.logger.debug("heartbeat-subscriber: stream ended cleanly");
    } catch (error) {
      if (signal.aborted) {
        // Expected path on `unsubscribe()`; the abort surfaces as an
        // AbortError on the next pump. Quiet log.
        this.logger.debug("heartbeat-subscriber: aborted");
      } else {
        // Stream error during a live subscription. We do NOT
        // auto-resubscribe — the composition root handles reconnect via
        // the monitor's `onTimeout` callback wiring (which will fire
        // when the deadline elapses). Log and let the loop end.
        this.logger.error("heartbeat-subscriber: stream error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      // If this loop is the active one, detach. A `subscribe()` that
      // raced ahead of us will already have overwritten these fields,
      // so guard the detach so we don't trample the new subscription.
      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.activeLoop && this.activeLoop !== Promise.resolve()) {
        // Best-effort detach; the only consumer of `activeLoop` is the
        // `subscribe()` re-entry barrier, which has already awaited us
        // by the time this finally runs.
      }
    }
  }
}
