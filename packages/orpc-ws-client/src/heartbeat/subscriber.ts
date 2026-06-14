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
//   4. `stop()` aliases `abort()` so the subscriber conforms to
//      the `{ stop(): void }` shape `ReconnectManager` expects from a
//      heartbeat collaborator (Phase 1.3 cross-phase note).
//
// On reconnect:
//   The source's `subscribe()` did NOT auto-resubscribe on stream error
//   or close — that's the composition root's job (heartbeat-timeout →
//   ReconnectManager → fresh subscribe on next connect). We preserve
//   that contract for POST-config failures: once the monitor is armed,
//   a dead stream stops producing pings and the watchdog's `onTimeout`
//   drives recovery. PRE-config failures are the one exception (NFI-1):
//   if the stream dies before the `config` event, the monitor was never
//   armed, `onTimeout` can never fire, and the connection is silently
//   unmonitored (e.g. the client points at a server without the stealth
//   heartbeat router, or the server-side procedure errors while the WS
//   stays open). For that case ONLY we retry the subscription a bounded
//   number of times — see `runLoop`'s catch path.

import {
  type Clock,
  type Logger,
  type TimerHandle,
  noopLogger,
  systemClock,
} from "@orpc-ws/shared";

import type { LinkFactory } from "../client/link-factory.js";

import { HEARTBEAT_PATH, type HeartbeatEvent } from "./types.js";
import type { HeartbeatMonitor } from "./monitor.js";

/**
 * Source defaults for the pre-config retry (NFI-1). Three retries, one
 * second apart, covers a transient server-side hiccup; a deterministic
 * failure (no stealth router on the server) exhausts the budget and is
 * surfaced as an error log. Overridable via deps for tests.
 */
const DEFAULT_PRE_CONFIG_MAX_RETRIES = 3;
const DEFAULT_PRE_CONFIG_RETRY_DELAY_MS = 1_000;

/**
 * Dependencies for HeartbeatSubscriber. `logger` defaults to noop; the
 * composition root wires the real one. `clock` defaults to the system
 * clock — only the pre-config retry timer goes through it.
 *
 * NOTE (Option B): the subscriber has ZERO knowledge of socket
 * `readyState`. The open/closed teardown decision lives in the lifecycle
 * orchestrator, which picks `abort()` vs `drop()` — see the two methods'
 * doc comments. There is deliberately no `isSocketOpen` predicate here.
 */
export interface HeartbeatSubscriberDeps {
  linkFactory: LinkFactory;
  monitor: HeartbeatMonitor;
  logger?: Logger;
  clock?: Clock;
  /**
   * How many times a subscription that failed BEFORE the `config` event
   * is retried (NFI-1). Post-config failures never retry — the armed
   * watchdog owns recovery there. Default: 3.
   */
  preConfigMaxRetries?: number;
  /** Delay between pre-config retries (ms). Default: 1000. */
  preConfigRetryDelayMs?: number;
}

/**
 * Consumes the `__orpc_ws_lib__.heartbeat` AsyncIterable and drives the
 * monitor.
 *
 * Lifecycle — TWO distinct ways to stop, chosen by the lifecycle
 * orchestrator based on socket state (Option B; the subscriber itself
 * never inspects `readyState`):
 *   - `subscribe()` — kick off the consumption loop. Idempotent in the
 *     sense that calling it while a subscription is live first stops
 *     the prior loop (via `abort()`) and awaits its teardown, then
 *     re-starts. This matters during a reconnect race where the
 *     composition root may re-subscribe before the previous
 *     AsyncIterable has finished draining.
 *   - `abort()` — fire the AbortController. The AsyncIterable's `next()`
 *     throws on abort, breaking the `for await` loop. orpc's peer
 *     fire-and-forgets an `ABORT_SIGNAL` frame on that abort, so this is
 *     only correct while the socket is still OPEN (the frame lands on a
 *     live socket). After abort, no further `monitor.recordPing()` /
 *     `monitor.configure()` calls can land (the loop is the only call
 *     site). Used by the token-refresh socket swap (socket open, swapped
 *     out from under us) and internally by `subscribe()`'s re-subscribe
 *     barrier.
 *   - `drop()` — release references / stop the local read loop WITHOUT
 *     firing the abort. For when the socket is already CLOSED/CLOSING:
 *     orpc registers its OWN `addEventListener("close", () =>
 *     peer.close())` on the partysocket wrapper (independent of our
 *     holder), and that listener tears the subscription down WITHOUT
 *     sending a frame. Firing our abort in that window would make orpc
 *     fire-and-forget an `ABORT_SIGNAL` send onto an already-closed
 *     socket (see `drop()` for the exact mechanism/throw). So on the
 *     close paths the orchestrator calls `drop()` and lets orpc's
 *     wrapper close-listener do the frameless cleanup.
 *   - `stop()` — alias for `abort()`. Conforms to the
 *     `{ stop(): void }` shape ReconnectManager expects from a
 *     heartbeat collaborator (Phase 1.3 cross-phase note). The only
 *     ReconnectManager-side caller is the token-refresh swap, which
 *     stops the subscription while the old socket is still OPEN — so
 *     the abort semantics are the correct ones there.
 */
export class HeartbeatSubscriber {
  private readonly linkFactory: LinkFactory;
  private readonly monitor: HeartbeatMonitor;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly preConfigMaxRetries: number;
  private readonly preConfigRetryDelayMs: number;

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
  /**
   * Monotonic subscribe-call counter (Bug 18 fix). `subscribe()` is
   * async — the teardown barrier `await`s the prior loop, and the
   * barrier's field-nulling is NOT atomic across that suspension. Two
   * concurrent `subscribe()` calls could interleave: caller A nulls the
   * fields and awaits; caller B sees a clean slate, starts its loop and
   * installs its controller; A resumes and OVERWRITES the fields —
   * leaving B's loop live but unreachable by `abort()`/`drop()`. The
   * generation counter makes "a newer subscribe superseded me" detectable:
   * each call captures `++generation` up front and bails after the await
   * if the global counter moved on.
   */
  private generation = 0;
  /**
   * Pending pre-config retry timer (NFI-1). Armed ONLY by `runLoop`'s
   * catch path when the stream failed before the `config` event. Any
   * explicit `subscribe()` / `abort()` / `drop()` cancels it — only the
   * retry chain itself re-arms — so a teardown (dispose / kick /
   * terminal / swap, all of which route through `abort()` or `drop()`)
   * or a fresh per-open subscription can never race a stale retry.
   */
  private retryTimer: TimerHandle | null = null;
  /**
   * Set by `drop()`, reset at the start of every `subscribe()`. Classifies
   * the `runLoop` catch as the EXPECTED close-path exit.
   *
   * Why this is needed: `drop()` deliberately does NOT abort the controller
   * (firing the abort would make orpc fire-and-forget an `ABORT_SIGNAL`
   * send onto an already-closed socket — see `drop()`). It relies on orpc's
   * own wrapper `close`-listener (`addEventListener("close", () =>
   * peer.close())`) to tear the stream down. But orpc ends the stream by
   * REJECTING the in-flight `pull()` (`AsyncIdQueue.close()` → `peer.close()`
   * rejects the pending pull with a non-abort error), NOT by a clean
   * `done: true` completion. So `drop()`'s exit comes through `runLoop`'s
   * catch with `signal.aborted === false` — indistinguishable, by signal
   * alone, from a genuine mid-stream error. This flag is what tells them
   * apart: `drop()` ⇒ expected/quiet; not-dropped + not-aborted ⇒ real error.
   *
   * Correctness on a LIVE subscription: the flag is only ever true after a
   * `drop()`, and the next `subscribe()` resets it to `false` before any new
   * loop runs — so a real mid-stream error on an active (never-dropped,
   * never-aborted) subscription is NOT suppressed and still logs at error.
   */
  private dropped = false;

  constructor(deps: HeartbeatSubscriberDeps) {
    this.linkFactory = deps.linkFactory;
    this.monitor = deps.monitor;
    this.logger = deps.logger ?? noopLogger;
    this.clock = deps.clock ?? systemClock;
    this.preConfigMaxRetries =
      deps.preConfigMaxRetries ?? DEFAULT_PRE_CONFIG_MAX_RETRIES;
    this.preConfigRetryDelayMs =
      deps.preConfigRetryDelayMs ?? DEFAULT_PRE_CONFIG_RETRY_DELAY_MS;
  }

  /**
   * Subscribe to the heartbeat stream and drive the monitor until the
   * stream ends or the subscription is stopped (`abort()`/`drop()`).
   *
   * If a previous subscription is still draining, this method first
   * aborts it and awaits its loop body — guarantees a single live
   * consumption loop at any time. Concurrent `subscribe()` calls
   * coalesce: the newest call wins, earlier in-flight calls bail
   * without starting a loop (generation counter — see Bug 18).
   */
  async subscribe(): Promise<void> {
    // An explicit subscribe supersedes any pending pre-config retry
    // (NFI-1) — the new subscription gets the full retry budget.
    this.clearRetryTimer();
    // Every fresh subscription begins not-dropped: a prior `drop()` must
    // not classify THIS loop's eventual exit as expected. (Reset here, in
    // the public entry, so the internal retry chain — which calls
    // `subscribeWithRetryBudget` directly — does NOT reset it; a retry of a
    // dropped subscription should never re-arm anyway, but the explicit
    // public re-subscribe is the only legitimate "start consuming again".)
    this.dropped = false;
    return this.subscribeWithRetryBudget(this.preConfigMaxRetries);
  }

  /**
   * Internal `subscribe()` body, parameterized by the remaining
   * pre-config retry budget (NFI-1). The public `subscribe()` always
   * passes the full budget; the retry chain passes a decremented one.
   */
  private async subscribeWithRetryBudget(retryBudget: number): Promise<void> {
    // Claim a generation BEFORE any suspension point. If another
    // `subscribe()` lands while we're awaiting the prior loop below,
    // it claims a higher generation; we detect that after the await
    // and bail instead of starting a second loop (Bug 18).
    const gen = ++this.generation;

    // Tear down any prior subscription and wait for its loop to exit.
    // Without this await, a `subscribe()` called from inside the
    // composition root's reconnect path could start a second loop
    // alongside the first — both calling `monitor.recordPing()`, both
    // racing on `monitor.configure()`.
    //
    // We `abort()` (not `drop()`) here: a re-subscribe happens on a LIVE
    // connection (the onOpen hook fires it when a fresh socket is OPEN),
    // so the prior loop's signal-abort lands on a live socket and orpc's
    // ABORT_SIGNAL frame sends cleanly. drop() would leave the prior
    // loop's `for await` pumping until the next event instead of breaking
    // it promptly.
    if (this.abortController || this.activeLoop) {
      this.abort();
      const prior = this.activeLoop;
      this.activeLoop = null;
      if (prior) {
        // The prior loop catches its own errors (aborts surface as a
        // logged debug); awaiting it here is purely a sync barrier.
        await prior;
      }
    }

    // Bug 18 regression guard: a newer `subscribe()` ran while we were
    // suspended on the barrier. It saw the fields we nulled, started a
    // fresh loop, and installed its controller. If we proceeded now we
    // would overwrite `abortController`/`activeLoop` and orphan that
    // loop — alive, consuming pings, but unreachable by `abort()`/`drop()`.
    // The newer caller owns the subscription; this one yields.
    if (this.generation !== gen) {
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    const loop = this.runLoop(controller, gen, retryBudget);
    this.activeLoop = loop;
    // The PUBLIC `subscribe()` returns once we've kicked off the loop —
    // we do NOT await `loop` here. The loop runs for the lifetime of the
    // stream; the source had the same fire-and-await-elsewhere shape.
    // The caller (composition root) doesn't block on the stream's
    // lifetime, only on the initial handoff.
    //
    // We don't return a reference to `loop` because the only legitimate
    // way to interrupt it is `abort()`/`drop()`/`stop()`; callers don't
    // need the promise.
    void loop;
  }

  /**
   * Stop the current consumption loop BY FIRING THE ABORT. Idempotent.
   * After this call the AsyncIterable's next `next()` rejects with an
   * AbortError, the loop exits, and no further events reach the monitor.
   *
   * Use ONLY when the underlying socket is still OPEN. orpc registers an
   * async abort listener on our call's signal that fires-and-forgets an
   * `ABORT_SIGNAL` frame on abort (`@orpc/standard-server-peer`:
   * `peer.request → signal.addEventListener("abort", … peer.send(…))`).
   * On an OPEN socket that send lands cleanly; on a closed/closing socket
   * it would throw UNHANDLED (the listener is fire-and-forget, so there's
   * no promise we can catch) — see `drop()` for that mechanism and why
   * the close paths use it instead.
   *
   * Production caller: the token-refresh socket swap
   * (`TokenRefreshHandler.swapSocket`, via `stop()`), which stops the
   * subscription while the OLD socket is still OPEN before closing it.
   * Also used internally by `subscribe()`'s re-subscribe barrier (a
   * re-subscribe happens on a live, just-opened socket).
   *
   * Does NOT stop the monitor itself — the composition root owns that
   * orchestration (`monitor.stop()` lives on the same shutdown path).
   */
  abort(): void {
    this.releaseRetryAndLoop(() => {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    });
  }

  /**
   * Stop the current consumption loop WITHOUT firing the abort. Idempotent.
   * Releases our references (clears the controller field and the pending
   * pre-config retry) and sets the `dropped` flag so `runLoop`'s catch
   * treats the resulting exit as expected.
   *
   * How the loop actually ends: orpc's wrapper `close`-listener runs
   * `peer.close()`, which REJECTS the in-flight `pull()`
   * (`AsyncIdQueue.close()` → the pending pull rejects with a non-abort
   * error). So the `for await` does NOT complete via a clean `done: true`;
   * it THROWS, landing in `runLoop`'s catch with `signal.aborted === false`.
   * The `dropped` flag is what marks that catch as the expected close-path
   * exit (quiet debug, no resubscribe) instead of a real stream error.
   *
   * Use when the socket is already CLOSED/CLOSING. orpc registers its OWN
   * `addEventListener("close", () => peer.close())` on the partysocket
   * wrapper — independent of our `WebSocketHolder` — and that listener
   * ends the heartbeat AsyncIterable and removes orpc's abort-send
   * listeners WITHOUT emitting a frame. If we fired our abort in that
   * window instead, orpc's signal-abort listener would fire-and-forget an
   * `ABORT_SIGNAL` send onto the already-closed socket. That send reaches
   * the browser-native `WebSocket.send()` (via orpc's adapter) and throws
   * a DOM `InvalidStateError` ("the connection is in the CLOSING or CLOSED
   * state"); being fire-and-forget, the rejection is UNHANDLED. partysocket
   * 1.2.0 made this reachable by flipping `readyState`→CLOSED and
   * dispatching `close` SYNCHRONOUSLY from `close()`, so our property
   * `onclose` (→ event-handlers → onClose hook) runs BEFORE orpc's own
   * wrapper close-listener. By calling `drop()` (not `abort()`) we leave
   * the frameless cleanup to orpc's wrapper close-listener and avoid the
   * throw entirely.
   *
   * NOTE on partysocket `send()`: partysocket's wrapper `send()` BUFFERS
   * and warns (it never throws) in both 1.1.19 and 1.2.0; the throw above
   * comes from the browser-native `WebSocket.send()` that orpc's adapter
   * ultimately calls, NOT from the partysocket wrapper.
   */
  drop(): void {
    // Mark this teardown as a deliberate drop so `runLoop`'s catch can
    // classify its (non-abort) exit as expected rather than a real stream
    // error. orpc ends the stream by REJECTING the in-flight `pull()` (its
    // wrapper `close`-listener runs `peer.close()` → `AsyncIdQueue.close()`
    // rejects the pending pull with a non-abort error), so `drop()`'s exit
    // arrives via the catch with `signal.aborted === false` — NOT via a
    // clean `done: true` completion. Without this flag every normal
    // disconnect would log at error level (see `runLoop`).
    this.dropped = true;
    this.releaseRetryAndLoop(() => {
      // Release our reference WITHOUT aborting. The loop's `for await`
      // ends when orpc's wrapper close-listener calls `peer.close()`,
      // which rejects the pending pull (a non-abort error); the catch sees
      // `this.dropped` and exits quietly, and the loop's `finally` detaches
      // idempotently.
      this.abortController = null;
    });
  }

  /**
   * Shared teardown body for `abort()` / `drop()`. Cancels any pending
   * pre-config retry (NFI-1) — every teardown path (per-close hook,
   * dispose, kick, terminal, swap) routes through one of the two public
   * stops, so a retry armed by a failed loop can never fire after the
   * client stopped wanting a heartbeat — then runs the variant-specific
   * controller release.
   */
  private releaseRetryAndLoop(releaseController: () => void): void {
    this.clearRetryTimer();
    releaseController();
  }

  /**
   * Alias for `abort()`. Exists so the subscriber conforms to the
   * `{ stop(): void }` shape ReconnectManager expects from a heartbeat
   * collaborator (Phase 1.3 cross-phase note). The only ReconnectManager
   * caller is the token-refresh swap, which stops the subscription while
   * the old socket is still OPEN — so abort (not drop) is the correct
   * semantics there.
   */
  stop(): void {
    this.abort();
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
  private async runLoop(
    controller: AbortController,
    gen: number,
    retryBudget: number,
  ): Promise<void> {
    const { signal } = controller;
    // Whether THIS loop saw the `config` event. Discriminates the two
    // failure shapes in the catch below: post-config the monitor is
    // armed and `onTimeout` owns recovery; pre-config nothing is armed
    // and only a retry can restore monitoring (NFI-1).
    let receivedConfig = false;
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
          receivedConfig = true;
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
      if (signal.aborted || this.dropped) {
        // EXPECTED teardown — two quiet exit shapes, neither a real error:
        //
        //   - `abort()` (or `subscribe()`'s re-subscribe barrier): the abort
        //     surfaces as an AbortError on the next pump → `signal.aborted`.
        //
        //   - `drop()` (close-path teardown): the controller is NOT aborted,
        //     so `signal.aborted` is false here. orpc's wrapper
        //     `close`-listener runs `peer.close()`, which REJECTS the
        //     in-flight `pull()` (`AsyncIdQueue.close()` rejects with a
        //     non-abort error) — so this exit comes through THIS catch, NOT
        //     a clean `done: true`. `this.dropped` is what classifies it as
        //     expected. (Earlier comments here claimed drop() exits via the
        //     clean `done: true` path; that was factually wrong and led to
        //     an error-level log on every normal disconnect.)
        //
        // Quiet debug log; no resubscribe, no pre-config retry — a drop
        // means the consumer stopped wanting this heartbeat.
        this.logger.debug("heartbeat-subscriber: stream stopped (expected)");
      } else {
        // Genuine stream error on a LIVE subscription — neither aborted nor
        // dropped. The `dropped` flag is set only by `drop()` and reset by
        // every `subscribe()`, so a real mid-stream failure here is never
        // masked.
        this.logger.error("heartbeat-subscriber: stream error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (receivedConfig) {
          // POST-config: no auto-resubscribe — the monitor is armed,
          // pings have stopped, and the composition root's `onTimeout`
          // wiring drives recovery when the deadline elapses.
        } else {
          // PRE-config (NFI-1): the monitor was never configured, so
          // `start()` no-op'd and `onTimeout` can NEVER fire — without
          // a retry this connection is silently unmonitored and a later
          // half-open zombie goes undetected. Retry the subscription a
          // bounded number of times. Guarded on the generation so a
          // newer `subscribe()` that superseded this loop (Bug 18)
          // doesn't get its healthy stream torn down by our retry.
          this.schedulePreConfigRetry(gen, retryBudget);
        }
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

  /**
   * Arm a bounded retry of the subscription after a PRE-config stream
   * failure (NFI-1). Exhausting the budget logs an error and gives up —
   * the connection stays unmonitored, matching the pre-fix behavior but
   * now loudly and only after `preConfigMaxRetries` real attempts.
   */
  private schedulePreConfigRetry(gen: number, retryBudget: number): void {
    if (this.generation !== gen) {
      // A newer subscribe() superseded this loop while it was failing;
      // that subscription owns its own retry budget. Stand down.
      return;
    }
    if (retryBudget <= 0) {
      this.logger.error(
        "heartbeat-subscriber: stream failed before config and retry budget " +
          "is exhausted; connection is UNMONITORED (no heartbeat watchdog)",
        { maxRetries: this.preConfigMaxRetries },
      );
      return;
    }
    this.logger.warn(
      "heartbeat-subscriber: stream failed before config; retrying subscription",
      {
        retriesLeft: retryBudget,
        delayMs: this.preConfigRetryDelayMs,
      },
    );
    this.clearRetryTimer();
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      // Re-check the generation at fire time: a subscribe()/abort()/drop()
      // in the gap would have cleared this timer, but the check is cheap
      // belt-and-braces against future re-wirings.
      if (this.generation !== gen) return;
      void this.subscribeWithRetryBudget(retryBudget - 1);
    }, this.preConfigRetryDelayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
