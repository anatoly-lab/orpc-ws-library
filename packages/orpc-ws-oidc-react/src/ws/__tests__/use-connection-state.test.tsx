// Unit tests for `useConnectionState`.
//
// Drive the hook through a fake client implementing only the public state
// contract (`getState` / `subscribe`) plus a test-only `emit` — testing
// through the same seam the React binding actually depends on, with no
// reach into core internals. See `fake-client.ts` for the behaviors it
// faithfully reproduces (no-immediate-invoke subscribe + structural dedupe).

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

/** Reusable test component reading the hook and reporting the state. */
function StateProbe({
  client,
  onRender,
}: {
  client: OrpcWsClient<never>;
  onRender?: (state: ConnectionState) => void;
}) {
  const state = useConnectionState(client);
  if (onRender) onRender(state);
  return <div data-testid="status">{state.status}</div>;
}

describe("useConnectionState", () => {
  it("returns the initial state on first render", () => {
    const { client } = makeFakeClient(disconnected({ willRetry: false }));

    render(<StateProbe client={client} />);

    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
  });

  it("re-renders when state changes via emit()", () => {
    const { client, emit } = makeFakeClient(
      disconnected({ willRetry: false }),
    );

    render(<StateProbe client={client} />);
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

  it("multiple components subscribe independently and all see the same value", () => {
    const { client, emit } = makeFakeClient(
      disconnected({ willRetry: false }),
    );

    render(
      <>
        <div data-testid="probe-a">
          <StateProbe client={client} />
        </div>
        <div data-testid="probe-b">
          <StateProbe client={client} />
        </div>
        <div data-testid="probe-c">
          <StateProbe client={client} />
        </div>
      </>,
    );

    for (const id of ["probe-a", "probe-b", "probe-c"]) {
      expect(screen.getByTestId(id)).toHaveTextContent("disconnected");
    }

    act(() => {
      emit(connected());
    });

    for (const id of ["probe-a", "probe-b", "probe-c"]) {
      expect(screen.getByTestId(id)).toHaveTextContent("connected");
    }
  });

  it("unmount removes the subscription — no memory leak", () => {
    const { client, emit } = makeFakeClient(
      disconnected({ willRetry: false }),
    );

    // Spy on subscribe to capture the unsubscribe function it returns.
    const realSubscribe = client.state.subscribe;
    const unsubscribeSpies: ReturnType<typeof vi.fn>[] = [];
    client.state.subscribe = (cb: () => void) => {
      const realUnsubscribe = realSubscribe(cb);
      const spy = vi.fn(() => realUnsubscribe());
      unsubscribeSpies.push(spy);
      return spy;
    };

    const { unmount } = render(<StateProbe client={client} />);

    // After mount, exactly one subscription registered.
    expect(unsubscribeSpies).toHaveLength(1);
    expect(unsubscribeSpies[0]).not.toHaveBeenCalled();

    // A separate listener on the SAME bus verifies emit() works and stays
    // wired across the still-mounted component's update.
    const onChange = vi.fn();
    client.state.subscribe(onChange);
    act(() => {
      emit(connecting());
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");

    unmount();

    // After unmount, useSyncExternalStore must have called the unsubscribe
    // returned by `subscribe` — otherwise the subscription leaks.
    expect(unsubscribeSpies[0]).toHaveBeenCalled();

    // Post-unmount, a state change should NOT cause the hook's listener
    // to fire; only the separate `onChange` listener remains on the bus.
    onChange.mockClear();
    act(() => {
      emit(connected());
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("the returned ConnectionState carries the tagged-record shape", () => {
    const { client, emit } = makeFakeClient(
      disconnected({ code: 1006, willRetry: true }),
    );

    let captured: ConnectionState | undefined;
    render(
      <StateProbe
        client={client}
        onRender={(s) => {
          captured = s;
        }}
      />,
    );

    expect(captured).toEqual({
      status: "disconnected",
      code: 1006,
      willRetry: true,
    });

    act(() => {
      emit(connecting());
    });

    expect(captured).toEqual({ status: "connecting" });
  });

  it("getState reference is stable between equal states (no React tear)", () => {
    // Pins the invariant that `useSyncExternalStore`'s identity-based
    // bail-out works: between real transitions, `getState()` must return
    // the same object reference. If this regresses, React will tear the
    // tree under StrictMode.
    const { client, emit } = makeFakeClient(connecting());

    const a = client.state.getState();
    const b = client.state.getState();
    expect(a).toBe(b);

    // emit with a structurally-equal value is a no-op for the fake (mirrors
    // the core's setState dedupe); the cached reference must persist.
    emit(connecting());
    const c = client.state.getState();
    expect(c).toBe(a);

    // A real transition produces a NEW reference.
    emit(connected());
    const d = client.state.getState();
    expect(d).not.toBe(a);
  });
});
