// Unit tests for `useConnectionState`.
//
// Build a minimal `OrpcWsClient`-shaped stub backed by the real
// `ConnectionStateManager` — testing through the public state contract
// (`getState` / `subscribe`) avoids coupling these tests to anything other
// than what the React adapter actually depends on.

import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { ConnectionStateManager } from "../../state/connection-state.js";
import {
  connected,
  connecting,
  disconnected,
  type ConnectionState,
} from "../../state/types.js";
import type { OrpcWsClient } from "../../index.js";

import { useConnectionState } from "../use-connection-state.js";

/** Minimal client stub that satisfies the bits `useConnectionState` reads. */
function makeClient(initial: ConnectionState): {
  client: OrpcWsClient<never>;
  manager: ConnectionStateManager;
} {
  const manager = new ConnectionStateManager(initial);
  const client = {
    // Unused by these tests, but the shape requires them. The hook never
    // touches `rpc`, `connect`, or `dispose`.
    rpc: {} as never,
    state: {
      getState: () => manager.getState(),
      subscribe: (cb: () => void) => manager.subscribe(cb),
    },
    connect: () => {},
    dispose: () => {},
  } as unknown as OrpcWsClient<never>;
  return { client, manager };
}

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
    const { client } = makeClient(disconnected({ willRetry: false }));

    render(<StateProbe client={client} />);

    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
  });

  it("re-renders when state changes via setState()", () => {
    const { client, manager } = makeClient(
      disconnected({ willRetry: false }),
    );

    render(<StateProbe client={client} />);
    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");

    act(() => {
      manager.setState(connecting());
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");

    act(() => {
      manager.setState(connected());
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
  });

  it("multiple components subscribe independently and all see the same value", () => {
    const { client, manager } = makeClient(
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
      manager.setState(connected());
    });

    for (const id of ["probe-a", "probe-b", "probe-c"]) {
      expect(screen.getByTestId(id)).toHaveTextContent("connected");
    }
  });

  it("unmount removes the subscription — no memory leak", () => {
    const { client, manager } = makeClient(
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

    // A setState before unmount should reach the still-mounted component.
    const onChange = vi.fn();
    manager.subscribe(onChange); // separate listener to verify the bus works
    act(() => {
      manager.setState(connecting());
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");

    unmount();

    // After unmount, useSyncExternalStore must have called the unsubscribe
    // returned by `subscribe` — otherwise the subscription leaks.
    expect(unsubscribeSpies[0]).toHaveBeenCalled();

    // Post-unmount, a state change should NOT cause the hook's listener
    // to fire (manager listener count drops back to the separate `onChange`).
    onChange.mockClear();
    act(() => {
      manager.setState(connected());
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("the returned ConnectionState carries the tagged-record shape", () => {
    const { client, manager } = makeClient(
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
      manager.setState(connecting());
    });

    expect(captured).toEqual({ status: "connecting" });
  });

  it("getState reference is stable between equal states (no React tear)", () => {
    // Pins the invariant that `useSyncExternalStore`'s identity-based
    // bail-out works: between real transitions, `getState()` must return
    // the same object reference. If this regresses, React will tear the
    // tree under StrictMode.
    const { client, manager } = makeClient(connecting());

    const a = client.state.getState();
    const b = client.state.getState();
    expect(a).toBe(b);

    // setState with structurally-equal value is a no-op for the manager;
    // the cached reference must persist.
    manager.setState(connecting());
    const c = client.state.getState();
    expect(c).toBe(a);

    // A real transition produces a NEW reference.
    manager.setState(connected());
    const d = client.state.getState();
    expect(d).not.toBe(a);
  });
});
