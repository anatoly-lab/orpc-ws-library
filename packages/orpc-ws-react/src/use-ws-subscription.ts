// React adapter — `useWsSubscription` hook (router-free, main entry).
//
// Generalizes the demo app's hand-rolled AsyncIterable-stream plumbing into
// ONE reusable hook so no page repeats the ~20-line dance: connected-gating,
// AbortController teardown, abort-as-throw suppression, re-subscribe on
// reconnect, and error surfacing. The demo's `tick` effect (Home.tsx) was the
// template; this hook owns all of it behind a single call.
//
// Wraps ORPC's first-class `consumeEventIterator` (the helper that pumps an
// event iterator and routes events/errors to lifecycle callbacks) instead of
// hand-rolling `for await`. The selector the consumer passes returns the
// `Promise<AsyncIterable<TEvent>>` the typed proxy produces; the hook bridges
// it to `consumeEventIterator` (which wants an `AsyncIterator`) internally.

import { useEffect, useRef, useState } from "react";

import { consumeEventIterator } from "@orpc/client";
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";

import type { OrpcWsClient } from "@orpc-ws/client";

import { useConnectionState } from "./use-connection-state.js";

/** Optional behavior + imperative side-effect callbacks for the subscription. */
export interface UseWsSubscriptionOptions<TEvent> {
  /**
   * Fired on every event, in addition to the hook tracking the latest in
   * `data`. The "both" shape: subscribe for reactive UI via `data`, pass
   * `onEvent` for imperative reactions (append to a log, fire a toast). Read
   * through a ref, so an inline closure does NOT re-run the subscription.
   */
  onEvent?: (event: TEvent) => void;
  /**
   * Fired once with a NON-abort error. Aborts (from cleanup/unmount) are
   * suppressed and never surface here. Read through a ref (see `onEvent`).
   */
  onError?: (error: unknown) => void;
  /**
   * When `false`, the hook does not subscribe even while connected. Defaults
   * to `true`. Use this to gate a subscription on app-level conditions (a
   * feature flag, a route, a paused view) without unmounting the component.
   */
  enabled?: boolean;
}

/** Reactive result of the subscription. Drives the component's render. */
export interface UseWsSubscriptionResult<TEvent> {
  /** The LATEST event received, or `null` before the first arrives. Persists
   * across reconnects (a dropped socket does not clear it). */
  data: TEvent | null;
  /** The last NON-abort error, or `null`. Set alongside `status: "error"`. */
  error: unknown | null;
  /**
   * - `idle`: not subscribed (disconnected OR `enabled: false`).
   * - `active`: subscribed and listening.
   * - `error`: the stream errored (non-abort); see {@link data} / {@link error}.
   *   A non-abort stream error that does NOT drop the connection leaves status
   *   `error` with NO automatic retry on the same connection — the hook only
   *   re-subscribes on the next disconnect→reconnect cycle (its effect deps are
   *   `[client, connected, enabled]`), which is the intended behavior.
   * - `completed`: the stream FINISHED (the server iterator returned
   *   `done: true`). Deliberately NO automatic re-subscribe on completion —
   *   the effect deps are unchanged (`[client, connected, enabled]`), so a
   *   finished stream stays `completed` until the next disconnect→reconnect
   *   cycle or an `enabled` toggle re-runs the subscription. `data` keeps the
   *   last event.
   */
  status: "idle" | "active" | "error" | "completed";
}

/**
 * Subscribe a React component to a server-pushed ORPC AsyncIterable stream.
 *
 * Owns the full lifecycle so pages don't repeat it:
 *   - only subscribes when the WS is `connected` AND `enabled !== false`;
 *   - re-subscribes automatically across disconnect→reconnect;
 *   - aborts the underlying call on cleanup/unmount, suppressing the abort
 *     (including a connection-drop's own abort-shaped rejection — a reconnect
 *     blip never surfaces as an error);
 *   - surfaces the latest event as `data` and forwards each to `onEvent`;
 *   - surfaces real errors via `status: "error"` + `error` + `onError`;
 *   - reports a FINISHED stream via `status: "completed"` (no automatic
 *     re-subscribe on completion — see {@link UseWsSubscriptionResult}).
 *
 * @param client - the `OrpcWsClient` from `createOrpcWsClient`. Pass the SAME
 *   instance across renders (identity stability gates the effect).
 * @param subscribe - a selector returning the stream. Receives the typed `rpc`
 *   proxy and an `AbortSignal` to thread into the call's options, e.g.
 *   `(rpc, signal) => rpc.tick(undefined, { signal })`. The selector may be a
 *   fresh inline closure every render; it is read through a ref so a new
 *   identity does NOT re-run the subscription.
 * @param options - optional `onEvent` / `onError` / `enabled`.
 *
 * @returns the reactive {@link UseWsSubscriptionResult}.
 *
 * @example
 *   const { data: lastTick } = useWsSubscription(
 *     wsClient,
 *     (rpc, signal) => rpc.tick(undefined, { signal }),
 *   );
 */
export function useWsSubscription<
  TContract extends AnyContractRouter,
  TEvent,
>(
  client: OrpcWsClient<TContract>,
  subscribe: (
    rpc: ContractRouterClient<TContract>,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<TEvent>>,
  options?: UseWsSubscriptionOptions<TEvent>,
): UseWsSubscriptionResult<TEvent> {
  const [data, setData] = useState<TEvent | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [status, setStatus] =
    useState<UseWsSubscriptionResult<TEvent>["status"]>("idle");

  // Connected-gating reuses the same `useSyncExternalStore`-over-`client.state`
  // mechanism the rest of the adapter uses — single source of truth for "is
  // the WS up?", so reconnect transitions drive this hook for free.
  const connection = useConnectionState(client);

  // Latest-closure via refs: the selector and the option callbacks may be new
  // identities every render (consumers pass inline functions/objects). Putting
  // them in the effect deps would re-subscribe on every render. We keep deps to
  // the primitives below and read these through refs at (re)subscribe time.
  // Same rationale as `use-oidc-callback`'s optionsRef.
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Deps must be PRIMITIVES so the effect re-runs exactly on the transitions we
  // care about: connect/disconnect and enable/disable. A derived boolean avoids
  // depending on the whole `connection` record.
  const connected = connection.status === "connected";
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    // NOT-SUBSCRIBED branch: disconnected or disabled. Go idle and do nothing.
    // No cleanup is registered on this path, so there is no setState-in-cleanup.
    if (!connected || !enabled) {
      setStatus("idle");
      return;
    }

    const ac = new AbortController();
    // `cancel` is the teardown handle `consumeEventIterator` returns; it stays
    // undefined until the selector's promise resolves. Cleanup guards on it.
    let cancel: (() => Promise<void>) | undefined;

    // Mark active + clear any stale error at subscribe START (not in cleanup) so
    // a reconnect after an error transitions error → active cleanly.
    setStatus("active");
    setError(null);

    // Shared error routing for BOTH the establishment path (the selector
    // promise rejecting) and the per-event path (the iterator's `.next()`
    // rejecting). Suppression covers TWO distinct abort sources:
    //   1. OUR teardown — we own the only abort on `ac`, so `ac.signal.aborted`
    //      catches it.
    //   2. CONNECTION LOSS — on WS close, `@orpc/client`'s websocket link calls
    //      `ClientPeer.close()` with no reason, and the peer's `AsyncIdQueue`
    //      rejects the parked `.next()`/response pull with `@orpc/shared`'s
    //      `AbortError` (an `Error` subclass constructed with
    //      `name = "AbortError"`), passed through the link's error mapping
    //      unwrapped. That is NOT our abort — `ac` is untouched — so the NAME
    //      check below is LOAD-BEARING, not a fallback: it keeps a reconnect
    //      blip from flashing `status: "error"` / firing `onError` while the
    //      hook is about to re-subscribe on reconnect anyway (the disconnect
    //      flips `connected`, the effect re-runs idle→active). We match by
    //      name because `@orpc/client` does not re-export the `AbortError`
    //      class (an `instanceof` against a second `@orpc/shared` copy would
    //      also be version-skew-fragile), and the name is the standardized
    //      JS abort discriminator (DOMException uses it too).
    //   3. ESTABLISHMENT RACE — a drop landing between the connected render
    //      and this effect's subscribe means the selector's rpc call finds
    //      the socket no longer OPEN, and the client core's link factory
    //      throws its typed `LinkNotReadyError` (exported from
    //      `@orpc-ws/client`). That's the same transient shape as (2): the
    //      disconnect flips `connected`, the effect re-runs, and the next
    //      connected flip re-subscribes — so it must not flash
    //      `status: "error"` / fire `onError` either. Matched by NAME for
    //      the same package-copy/version-skew robustness as AbortError.
    const isTransientStreamError = (err: unknown): boolean =>
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "LinkNotReadyError");
    const handleStreamError = (err: unknown): void => {
      if (ac.signal.aborted) return;
      if (isTransientStreamError(err)) return;
      setError(err);
      setStatus("error");
      optionsRef.current?.onError?.(err);
    };

    void (async (): Promise<void> => {
      // `consumeEventIterator` awaits the call promise inside its OWN
      // try/catch, so when it's handed a promise, establishment errors route
      // to its `onError`. We await the selector promise OUTSIDE it (to bridge
      // `AsyncIterable` → `AsyncIterator`), so we must replicate that error
      // routing + abort suppression here — otherwise a rejected selector
      // promise (connection drop mid-subscribe, server rejecting the stream
      // open) becomes an unhandled rejection and `status` stays stuck "active".
      try {
        const iterable = await subscribeRef.current(client.rpc, ac.signal);
        // Post-await guard: under StrictMode's mount→unmount→mount the cleanup
        // can fire while we were awaiting the selector. If so, `ac` is already
        // aborted — don't start consuming a torn-down run.
        if (ac.signal.aborted) return;

        // Bridge: the selector yields an `AsyncIterable` (only guarantees
        // `[Symbol.asyncIterator]`), but `consumeEventIterator` consumes an
        // `AsyncIterator` (calls `.next()` directly). Convert here so the
        // consumer-facing selector stays the natural proxy shape.
        cancel = consumeEventIterator(iterable[Symbol.asyncIterator](), {
          onEvent: (event) => {
            // A `.next()` that SETTLED before cleanup's abort still delivers
            // its event on a later microtask — without this guard a torn-down
            // run (unmount, disable, reconnect churn) would setState and fire
            // the consumer's `onEvent` after cleanup. Mirrors
            // `handleStreamError`'s abort guard.
            if (ac.signal.aborted) return;
            setData(event);
            setStatus("active");
            optionsRef.current?.onEvent?.(event);
          },
          // A FINITE stream ends with `done: true`, which `consumeEventIterator`
          // routes here (NOT to `onEvent`/`onError`) — without this the hook
          // would stay "active" forever on a stream that finished. Abort-guarded
          // like the other callbacks. Deliberately no re-subscribe: the effect
          // deps are unchanged, so `completed` holds until the next
          // disconnect→reconnect cycle or an `enabled` toggle.
          onSuccess: () => {
            if (ac.signal.aborted) return;
            setStatus("completed");
          },
          // Covers per-event / `.next()` rejections once consuming has begun.
          onError: handleStreamError,
        });
      } catch (err) {
        // Covers selector-promise (establishment) rejections.
        handleStreamError(err);
      }
    })();

    return () => {
      // Dual teardown, both intentional:
      //   - `ac.abort()` matches the demo's proven signal teardown and aborts
      //     the underlying call promptly — including the still-awaiting initial
      //     selector promise. The pending `.next()` rejects with an AbortError,
      //     which `onError` suppresses via the guard above.
      //   - `cancel()` is `consumeEventIterator`'s own graceful stop; it calls
      //     the iterator's `return?.()` to close the stream. No-ops if the
      //     selector promise had not resolved yet (`cancel` still undefined).
      //     Swallow its rejection: a `return()` on a dead connection can
      //     reject, and teardown has nowhere to route it but an unhandled
      //     rejection.
      ac.abort();
      void cancel?.().catch(() => {});
    };
    // Deliberately `[client, connected, enabled]` — selector/options via refs.
  }, [client, connected, enabled]);

  return { data, error, status };
}
