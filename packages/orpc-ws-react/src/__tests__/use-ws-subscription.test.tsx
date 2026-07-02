// Unit tests for `useWsSubscription`.
//
// The hook owns the AsyncIterable-stream plumbing a page used to hand-roll:
// connected-gating, abort teardown, abort-suppression, re-subscribe on
// reconnect, and error surfacing. We drive it through a fake client that
// exposes the public `state` contract (so we can flip connected/disconnected)
// plus a controllable `rpc.stream` selector target backed by a PUSHABLE async
// iterable — a manual iterator with a deferred `next()` we resolve from the
// test, so events, completion, and errors are all on the test's clock.

import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

import {
  connected,
  disconnected,
  LinkNotReadyError,
  type ConnectionState,
} from "@orpc-ws/client";
import type { OrpcWsClient } from "@orpc-ws/client";

import {
  useWsSubscription,
  type UseWsSubscriptionOptions,
} from "../use-ws-subscription.js";

// ---------------------------------------------------------------------------
// Pushable async iterable: a hand-driven stream the test fully controls.
//
// Each `next()` parks on a deferred until the test calls `push`, `complete`,
// or `fail`. `return()` (what `consumeEventIterator`'s cancel calls) and abort
// both settle any parked `next()` so the consumer's loop unwinds. We record
// whether the abort signal fired and whether `return()` was called so tests
// can assert teardown.
// ---------------------------------------------------------------------------
interface Pushable<T> {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  fail: (err: unknown) => void;
  complete: () => void;
  /** True once the consumer requested teardown via `return()`. */
  returned: () => boolean;
}

function makePushable<T>(signal: AbortSignal): Pushable<T> {
  type Settle =
    | { kind: "value"; value: T }
    | { kind: "done" }
    | { kind: "error"; err: unknown };

  let pending: ((s: Settle) => void) | null = null;
  const queued: Settle[] = [];
  let returned = false;

  const deliver = (s: Settle): void => {
    if (pending) {
      const p = pending;
      pending = null;
      p(s);
    } else {
      queued.push(s);
    }
  };

  // An abort settles any parked next() with an AbortError — the same way the
  // real transport surfaces a mid-stream abort, so the hook's suppression path
  // is exercised.
  signal.addEventListener("abort", () => {
    const err = new DOMException("Aborted", "AbortError");
    deliver({ kind: "error", err });
  });

  const iterator: AsyncIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      return new Promise((resolve, reject) => {
        const handle = (s: Settle): void => {
          if (s.kind === "value") resolve({ value: s.value, done: false });
          else if (s.kind === "done")
            resolve({ value: undefined, done: true });
          else reject(s.err);
        };
        const next = queued.shift();
        if (next) handle(next);
        else pending = handle;
      });
    },
    return(): Promise<IteratorResult<T>> {
      returned = true;
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  return {
    iterable: { [Symbol.asyncIterator]: () => iterator },
    push: (value) => deliver({ kind: "value", value }),
    fail: (err) => deliver({ kind: "error", err }),
    complete: () => deliver({ kind: "done" }),
    returned: () => returned,
  };
}

// ---------------------------------------------------------------------------
// Fake client: public `state` contract (getState/subscribe + test `emit`) and
// a real `rpc` whose `stream` method records the abort signal it was handed.
// We don't reuse `fake-client.ts`'s `makeFakeClient` because it hardcodes
// `rpc: {} as never`; this hook needs a callable `rpc`.
// ---------------------------------------------------------------------------
interface TickEvent {
  tick: number;
}

interface FakeStreamClient {
  client: OrpcWsClient<never>;
  emit: (next: ConnectionState) => void;
  /** The most recent abort signal the selector's call received. */
  lastSignal: () => AbortSignal | null;
}

function makeStreamClient(
  initial: ConnectionState,
  streamImpl: (signal: AbortSignal) => Promise<AsyncIterable<TickEvent>>,
): FakeStreamClient {
  let state = initial;
  const listeners = new Set<() => void>();
  let lastSignal: AbortSignal | null = null;

  const client = {
    rpc: {
      stream: (
        _input: undefined,
        opts: { signal: AbortSignal },
      ): Promise<AsyncIterable<TickEvent>> => {
        lastSignal = opts.signal;
        return streamImpl(opts.signal);
      },
    },
    state: {
      getState: (): ConnectionState => state,
      subscribe: (cb: () => void): (() => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    connect: () => {},
    dispose: () => {},
  } as unknown as OrpcWsClient<never>;

  const emit = (next: ConnectionState): void => {
    if (state.status === next.status) return; // shallow dedupe is enough here
    state = next;
    for (const l of listeners) l();
  };

  return { client, emit, lastSignal: () => lastSignal };
}

/** Probe that renders the hook's result for assertions. */
function StreamProbe({
  client,
  selector,
  options,
}: {
  client: OrpcWsClient<never>;
  selector: (rpc: unknown, signal: AbortSignal) => Promise<AsyncIterable<TickEvent>>;
  options?: UseWsSubscriptionOptions<TickEvent>;
}) {
  const { data, error, status } = useWsSubscription<never, TickEvent>(
    client,
    selector,
    options,
  );
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="data">{data ? `tick:${data.tick}` : "none"}</span>
      <span data-testid="error">{error ? String(error) : "none"}</span>
    </div>
  );
}

describe("useWsSubscription", () => {
  it("does NOT subscribe while disconnected (idle, selector untouched)", () => {
    const selector = vi.fn();
    const { client } = makeStreamClient(
      disconnected({ willRetry: false }),
      async () => makePushable<TickEvent>(new AbortController().signal).iterable,
    );

    render(<StreamProbe client={client} selector={selector} />);

    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(selector).not.toHaveBeenCalled();
  });

  it("subscribes when connected: events flow to data AND onEvent", async () => {
    let pushable: Pushable<TickEvent> | undefined;
    const onEvent = vi.fn();
    const { client } = makeStreamClient(connected(), async (signal) => {
      pushable = makePushable<TickEvent>(signal);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onEvent }} />,
    );

    await waitFor(() => expect(pushable).toBeDefined());
    expect(screen.getByTestId("status").textContent).toBe("active");

    await act(async () => {
      pushable!.push({ tick: 1 });
    });
    expect(screen.getByTestId("data").textContent).toBe("tick:1");
    expect(onEvent).toHaveBeenLastCalledWith({ tick: 1 });

    await act(async () => {
      pushable!.push({ tick: 2 });
    });
    expect(screen.getByTestId("data").textContent).toBe("tick:2");
    expect(onEvent).toHaveBeenLastCalledWith({ tick: 2 });
  });

  it("surfaces a real (non-abort) error: status error, error set, onError, no throw", async () => {
    let pushable: Pushable<TickEvent> | undefined;
    const onError = vi.fn();
    const { client } = makeStreamClient(connected(), async (signal) => {
      pushable = makePushable<TickEvent>(signal);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );
    await waitFor(() => expect(pushable).toBeDefined());

    const boom = new Error("stream blew up");
    await act(async () => {
      pushable!.fail(boom);
    });

    expect(screen.getByTestId("status").textContent).toBe("error");
    expect(screen.getByTestId("error").textContent).toContain("stream blew up");
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("suppresses abort on unmount: cancels the stream, no error surfaced", async () => {
    let pushable: Pushable<TickEvent> | undefined;
    const onError = vi.fn();
    const { client, lastSignal } = makeStreamClient(connected(), async (signal) => {
      pushable = makePushable<TickEvent>(signal);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    const { unmount } = render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );
    await waitFor(() => expect(pushable).toBeDefined());

    await act(async () => {
      unmount();
    });

    // The selector's signal was aborted (demo-style teardown) AND the helper's
    // cancel() closed the iterator via return().
    expect(lastSignal()?.aborted).toBe(true);
    await waitFor(() => expect(pushable!.returned()).toBe(true));
    // The abort must NOT surface as an error to the consumer.
    expect(onError).not.toHaveBeenCalled();
  });

  it("re-subscribes on reconnect AND tears down the first run (no leaked iterator)", async () => {
    // Capture EACH run's pushable + the signal it was handed, so we can prove
    // the FIRST run was fully torn down before the second subscribe — asserting
    // a bumped count alone would not catch a leaked / overlapping iterator.
    const runs: { signal: AbortSignal; pushable: Pushable<TickEvent> }[] = [];
    const { client, emit } = makeStreamClient(connected(), async (signal) => {
      const pushable = makePushable<TickEvent>(signal);
      runs.push({ signal, pushable });
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(<StreamProbe client={client} selector={selector} />);
    await waitFor(() => expect(runs).toHaveLength(1));

    await act(async () => {
      emit(disconnected({ willRetry: true }));
    });
    expect(screen.getByTestId("status").textContent).toBe("idle");

    // The first run must be fully torn down BEFORE a second subscribe: its
    // signal aborted (demo-style call teardown) and its iterator closed via
    // return() (consumeEventIterator's graceful cancel). No overlap.
    expect(runs[0]!.signal.aborted).toBe(true);
    await waitFor(() => expect(runs[0]!.pushable.returned()).toBe(true));

    await act(async () => {
      emit(connected());
    });
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(screen.getByTestId("status").textContent).toBe("active");
    // The second run is a fresh, distinct iterator — not the torn-down first.
    expect(runs[1]!.pushable).not.toBe(runs[0]!.pushable);
  });

  it("surfaces a rejected selector promise (establishment error): status error, onError, no unhandled rejection", async () => {
    // Distinct from the iterator-.next() error test above: here the
    // Promise<AsyncIterable> ITSELF rejects (the rpc call fails to even
    // establish — connection drop mid-subscribe, server rejecting the stream
    // open). Exercises the IIFE's catch path, not consumeEventIterator's
    // onError. A regression here (the pre-fix code) would leave status stuck
    // "active" and raise an unhandled rejection.
    const onError = vi.fn();
    const boom = new Error("connect failed");
    const { client } = makeStreamClient(connected(), async () => {
      throw boom;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("error"),
    );
    expect(screen.getByTestId("error").textContent).toContain("connect failed");
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("suppresses an aborted selector-promise rejection: no error status, onError NOT called", async () => {
    // The establishment path can also reject with an abort (our own teardown
    // racing the pending selector promise). The catch must suppress it exactly
    // like the iterator path does — no error status, no onError.
    const onError = vi.fn();
    const { client } = makeStreamClient(connected(), async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );

    // Let the rejected selector promise settle and the catch path run. A few
    // microtask turns covers: selector throw → rejected promise → catch.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Positive assertion (not just `not.toBe("error")`): status stays the
    // mount-time "active", proving the catch RAN and chose suppression — not
    // that the rejection merely hadn't settled yet.
    expect(screen.getByTestId("status").textContent).toBe("active");
    expect(onError).not.toHaveBeenCalled();
  });

  it("suppresses the establishment race's LinkNotReadyError: no 'error' status, no onError, resubscribes on the next connected flip", async () => {
    // A drop landing between the connected render and the subscribe effect
    // makes the rpc call throw the client core's typed LinkNotReadyError
    // (the socket exists but is no longer OPEN). Pre-fix that was a plain
    // Error and surfaced as a one-render `status: "error"` flash + onError;
    // it is now classified as transient (like AbortError) — the effect
    // resubscribes on the next connected flip and the consumer never sees
    // an error.
    const onError = vi.fn();
    let subscribeCalls = 0;
    let pushable: Pushable<TickEvent> | undefined;
    const { client, emit } = makeStreamClient(connected(), async (signal) => {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        // First attempt: the socket dropped under the connected render.
        throw new LinkNotReadyError();
      }
      pushable = makePushable<TickEvent>(signal);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );
    await waitFor(() => expect(subscribeCalls).toBe(1));
    // Let the rejected selector promise settle through the catch path.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Suppressed: status stays the mount-time "active" (proving the catch
    // RAN and chose suppression), no error, no onError.
    expect(screen.getByTestId("status").textContent).toBe("active");
    expect(screen.getByTestId("error").textContent).toBe("none");
    expect(onError).not.toHaveBeenCalled();

    // The race self-heals through the normal reconnect cycle.
    await act(async () => {
      emit(disconnected({ willRetry: true }));
    });
    expect(screen.getByTestId("status").textContent).toBe("idle");
    await act(async () => {
      emit(connected());
    });
    await waitFor(() => expect(subscribeCalls).toBe(2));
    expect(screen.getByTestId("status").textContent).toBe("active");
    expect(onError).not.toHaveBeenCalled();
  });

  it("suppresses an event that settled BEFORE cleanup's abort: no onEvent after teardown", async () => {
    // Race: a `.next()` can RESOLVE (with a real event) in the same task the
    // component unmounts — the resolved value is then delivered on a microtask
    // that runs AFTER cleanup aborted. Pre-fix, the onEvent wrapper had no
    // abort guard, so the torn-down run still called setData/setStatus and the
    // consumer's onEvent. Push + unmount in ONE synchronous block so the
    // delivery microtask is guaranteed to run after `ac.abort()`.
    let pushable: Pushable<TickEvent> | undefined;
    const onEvent = vi.fn();
    const { client } = makeStreamClient(connected(), async (signal) => {
      pushable = makePushable<TickEvent>(signal);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    const { unmount } = render(
      <StreamProbe client={client} selector={selector} options={{ onEvent }} />,
    );
    await waitFor(() => expect(pushable).toBeDefined());

    act(() => {
      pushable!.push({ tick: 1 }); // settles the parked next() with a VALUE…
      unmount(); // …and cleanup aborts before the delivery microtask runs
    });
    // Drain the delivery microtask(s) that would call onEvent pre-fix.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("finite stream: done → status 'completed', data kept, no onError, NO auto-resubscribe (reconnect cycle still resubscribes)", async () => {
    // `consumeEventIterator` routes `done: true` to onSuccess. Pre-fix the hook
    // wired only onEvent/onError, so a finished stream ended INVISIBLY — status
    // stuck "active" forever.
    const runs: Pushable<TickEvent>[] = [];
    const onError = vi.fn();
    const { client, emit } = makeStreamClient(connected(), async (signal) => {
      const pushable = makePushable<TickEvent>(signal);
      runs.push(pushable);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );
    await waitFor(() => expect(runs).toHaveLength(1));

    await act(async () => {
      runs[0]!.push({ tick: 7 });
    });
    await act(async () => {
      runs[0]!.complete();
    });

    expect(screen.getByTestId("status").textContent).toBe("completed");
    // `data` keeps the last event; completion is not an error.
    expect(screen.getByTestId("data").textContent).toBe("tick:7");
    expect(onError).not.toHaveBeenCalled();
    // NO resubscribe on completion — deliberate: the effect deps are
    // [client, connected, enabled], and completion changes none of them.
    expect(runs).toHaveLength(1);

    // A disconnect→reconnect cycle is still the documented way back to a live
    // subscription: idle on drop, fresh run on reconnect.
    await act(async () => {
      emit(disconnected({ willRetry: true }));
    });
    expect(screen.getByTestId("status").textContent).toBe("idle");
    await act(async () => {
      emit(connected());
    });
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(screen.getByTestId("status").textContent).toBe("active");
  });

  it("PINS: a connection-drop rejection (peer-style AbortError, not ours) is suppressed — no onError, no 'error' status, normal resubscribe", async () => {
    // Traced behavior (not a fix — pinning already-correct suppression): on a
    // real WS close, @orpc/client's websocket link calls ClientPeer.close()
    // with no reason, and the peer's AsyncIdQueue rejects the parked `.next()`
    // with @orpc/shared's AbortError — an `Error` subclass constructed with
    // name = "AbortError", passed through the link's error mapping unwrapped.
    // The hook's own `ac` is UNTOUCHED at that point, so suppression rides on
    // the NAME check, not the signal check. Reproduce that exact shape.
    const peerAbort = new Error(
      "[AsyncIdQueue] Queue[1] was closed or aborted while waiting for pulling.",
    );
    peerAbort.name = "AbortError";

    const runs: Pushable<TickEvent>[] = [];
    const onError = vi.fn();
    const { client, emit } = makeStreamClient(connected(), async (signal) => {
      const pushable = makePushable<TickEvent>(signal);
      runs.push(pushable);
      return pushable.iterable;
    });
    const selector = (_rpc: unknown, signal: AbortSignal) =>
      (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

    render(
      <StreamProbe client={client} selector={selector} options={{ onError }} />,
    );
    await waitFor(() => expect(runs).toHaveLength(1));

    // The drop's rejection can land BEFORE the state manager reports the
    // disconnect (listener ordering on the close event is not ours) — so fail
    // the stream while the hook still believes it is connected.
    await act(async () => {
      runs[0]!.fail(peerAbort);
    });
    expect(screen.getByTestId("status").textContent).toBe("active"); // NOT "error"
    expect(screen.getByTestId("error").textContent).toBe("none");
    expect(onError).not.toHaveBeenCalled();

    // Then the state manager reports the drop and the normal idle→active
    // resubscribe flow recovers the subscription.
    await act(async () => {
      emit(disconnected({ willRetry: true }));
    });
    expect(screen.getByTestId("status").textContent).toBe("idle");
    await act(async () => {
      emit(connected());
    });
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(screen.getByTestId("status").textContent).toBe("active");
    expect(onError).not.toHaveBeenCalled();
  });

  it("a rejecting iterator return() during teardown is swallowed (no unhandled rejection)", async () => {
    // cleanup runs `cancel?.()`, and consumeEventIterator's cancel is
    // `async () => { await (await iterator)?.return?.(); }` — on a dead
    // connection `return()` can REJECT, which pre-fix (`void cancel?.()`)
    // escaped as an unhandled rejection.
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      const iterator: AsyncIterator<TickEvent> = {
        next: () => new Promise(() => {}), // parked forever; never settles
        return: () =>
          Promise.reject(new Error("return() on a dead connection")),
      };
      const { client } = makeStreamClient(connected(), async () => ({
        [Symbol.asyncIterator]: () => iterator,
      }));
      const selector = (_rpc: unknown, signal: AbortSignal) =>
        (client.rpc as unknown as { stream: (i: undefined, o: { signal: AbortSignal }) => Promise<AsyncIterable<TickEvent>> }).stream(undefined, { signal });

      const { unmount } = render(
        <StreamProbe client={client} selector={selector} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("status").textContent).toBe("active"),
      );

      await act(async () => {
        unmount();
      });
      // Unhandled-rejection detection fires after the microtask queue drains,
      // on a later macrotask — give it one.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("does NOT subscribe when enabled is false, even while connected", () => {
    const selector = vi.fn();
    const { client } = makeStreamClient(
      connected(),
      async () => makePushable<TickEvent>(new AbortController().signal).iterable,
    );

    render(
      <StreamProbe
        client={client}
        selector={selector}
        options={{ enabled: false }}
      />,
    );

    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(selector).not.toHaveBeenCalled();
  });
});
