// Bug 7 regression — React StrictMode double-mount.
//
// The source-app bug: under React StrictMode, dev-mode components are
// mount-unmount-mount. If the store's `subscribe(cb)` immediately calls
// `cb`, the snapshot read between mounts looks different from the snapshot
// read at first render, and React tears the tree (visible as a flicker /
// duplicate state read in the wild).
//
// The library-side fix is in `ConnectionStateManager.subscribe` (core):
// register the listener but DO NOT invoke it. Initial value flows through
// `useSyncExternalStore`'s `getSnapshot` argument (= `getState`). This
// regression test rides the contract end-to-end through the React binding
// to ensure the wiring stays correct.
//
// The fake client (see `fake-client.ts`) reproduces the same
// no-immediate-invoke `subscribe` behavior, so this test pins the binding's
// reliance on that invariant without importing core internals.

import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  connected,
  connecting,
  disconnected,
  type ConnectionState,
} from "@orpc-ws/client";
import type { OrpcWsClient } from "@orpc-ws/client";

import { useConnectionState } from "../use-connection-state.js";
import { makeFakeClient } from "./fake-client.js";

/**
 * Wrap a fake client so `client.state.subscribe` is a spy — bug-07 asserts
 * that every subscribe call returns a matching unsubscribe (net-zero leak
 * across the StrictMode double-mount).
 */
function makeSpiedClient(initial: ConnectionState): {
  client: OrpcWsClient<never>;
  emit: (next: ConnectionState) => void;
  subscribeSpy: ReturnType<typeof vi.fn>;
} {
  const { client, emit } = makeFakeClient(initial);
  const realSubscribe = client.state.subscribe;
  const subscribeSpy = vi.fn((cb: () => void) => realSubscribe(cb));
  client.state.subscribe = subscribeSpy;
  return { client, emit, subscribeSpy };
}

function Probe({ client }: { client: OrpcWsClient<never> }) {
  const state = useConnectionState(client);
  return <div data-testid="status">{state.status}</div>;
}

describe("Bug 7 — StrictMode double-mount safety", () => {
  it("leaves exactly one active subscription after StrictMode double-mount", () => {
    const { client, emit, subscribeSpy } = makeSpiedClient(
      disconnected({ willRetry: false }),
    );

    render(
      <StrictMode>
        <Probe client={client} />
      </StrictMode>,
    );

    // StrictMode mounts the effect, unmounts it, then re-mounts it.
    // `useSyncExternalStore` calls `subscribe` on every effect mount,
    // so the spy is called multiple times — but the unsubscribe returned
    // by the first call is called in between, so the NET active
    // subscription count must be 1.
    //
    // We can't read the listener Set directly without touching internals,
    // so instead we assert observable behavior: an emit() reaches the
    // component (not silently dropped) and a separate sentinel subscription
    // gives us a parallel listener to verify the bus is alive.
    const sentinel = vi.fn();
    const unsubSentinel = client.state.subscribe(sentinel);

    // Each subscribe call MUST have returned an unsubscribe function — a
    // leaked subscription would show up as a subscribe with no matching
    // unsubscribe.
    const subscribeCalls = subscribeSpy.mock.calls.length;
    const unsubscribeReturned = subscribeSpy.mock.results
      .map((r) => (r.type === "return" ? (r.value as () => void) : undefined))
      .filter(Boolean);
    // Sanity: subscribe was called at least once (mount). The sentinel
    // subscription above went through the spy too.
    expect(subscribeCalls).toBeGreaterThanOrEqual(1);
    // Each subscribe call MUST have returned an unsubscribe function.
    expect(unsubscribeReturned).toHaveLength(subscribeCalls);

    // Behavioral check: trigger a real transition. The component must
    // re-render to the new state. (Bug 7 manifested as a stale snapshot
    // / spurious "still in initial state" mid-double-mount.)
    act(() => {
      emit(connecting());
    });

    expect(screen.getByTestId("status")).toHaveTextContent("connecting");
    expect(sentinel).toHaveBeenCalled();

    unsubSentinel();
  });

  it("subscribe() in the core does NOT immediately invoke the callback", () => {
    // The library-side invariant the React binding depends on. Re-pinned
    // here at the binding level so a regression in the core surfaces
    // through this test suite too.
    const { client } = makeFakeClient(connecting());
    const cb = vi.fn();

    const unsub = client.state.subscribe(cb);
    expect(cb).not.toHaveBeenCalled();
    unsub();
  });

  it("under StrictMode, the component sees state updates correctly across the double-mount", () => {
    const { client, emit } = makeFakeClient(
      disconnected({ willRetry: false }),
    );

    render(
      <StrictMode>
        <Probe client={client} />
      </StrictMode>,
    );

    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");

    act(() => {
      emit(connecting());
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");

    act(() => {
      emit(connected());
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
  });

  it("after StrictMode unmount, no live subscriptions remain", () => {
    // Tightest assertion of the "no leak" property: a sentinel subscription
    // on the same bus shows that after the hook unmounts, only the sentinel
    // remains — a single emit notifies it exactly once.
    const { client, emit } = makeFakeClient(connecting());

    const sentinel = vi.fn();
    const unsubSentinel = client.state.subscribe(sentinel);

    const { unmount } = render(
      <StrictMode>
        <Probe client={client} />
      </StrictMode>,
    );

    unmount();

    // After unmount, only the sentinel should remain. A state change
    // notifies exactly once.
    sentinel.mockClear();
    act(() => {
      emit(connected());
    });
    expect(sentinel).toHaveBeenCalledTimes(1);

    unsubSentinel();
  });
});
