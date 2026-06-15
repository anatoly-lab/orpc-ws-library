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
