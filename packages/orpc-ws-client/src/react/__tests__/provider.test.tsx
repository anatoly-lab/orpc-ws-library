// Tests for `OrpcWsProvider` + `useOrpcWs()`.
//
// Provider exists for the ergonomic "construct one client, consume
// anywhere" pattern. These tests pin the contract: provide / read, error
// when used outside, no consumer tearing on re-render.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConnectionStateManager } from "../../state/connection-state.js";
import { disconnected, type ConnectionState } from "../../state/types.js";
import type { OrpcWsClient } from "../../index.js";

import { OrpcWsProvider, useOrpcWs } from "../provider.js";

function makeClient(initial: ConnectionState = disconnected({ willRetry: false })): OrpcWsClient<never> {
  const manager = new ConnectionStateManager(initial);
  return {
    rpc: {} as never,
    state: {
      getState: () => manager.getState(),
      subscribe: (cb: () => void) => manager.subscribe(cb),
    },
    connect: () => {},
    dispose: () => {},
  } as unknown as OrpcWsClient<never>;
}

describe("OrpcWsProvider + useOrpcWs", () => {
  it("useOrpcWs inside the provider returns the client", () => {
    const client = makeClient();

    function Consumer() {
      const c = useOrpcWs<never>();
      // Verifies identity, not just shape.
      return <div data-testid="match">{c === client ? "yes" : "no"}</div>;
    }

    render(
      <OrpcWsProvider client={client}>
        <Consumer />
      </OrpcWsProvider>,
    );

    expect(screen.getByTestId("match")).toHaveTextContent("yes");
  });

  it("useOrpcWs outside the provider throws a clear error", () => {
    // Suppress React's error console noise when a hook throws during
    // render — the test asserts the throw via render's error boundary
    // contract instead.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function Consumer() {
      useOrpcWs<never>();
      return null;
    }

    expect(() => render(<Consumer />)).toThrowError(
      /useOrpcWs must be used inside <OrpcWsProvider>/,
    );

    errSpy.mockRestore();
  });

  it("provider re-rendering with the same client doesn't tear consumers", () => {
    // The hook reads the same context value across re-renders; consumers
    // should not receive a new client identity unless the parent actually
    // changes it. Pinning this guards against an accidental "always pass a
    // fresh object" regression in the provider.
    const client = makeClient();
    const observed: OrpcWsClient<never>[] = [];

    function Consumer() {
      const c = useOrpcWs<never>();
      observed.push(c);
      return null;
    }

    function Parent({ tick }: { tick: number }) {
      return (
        <OrpcWsProvider client={client}>
          <div data-testid="tick">{tick}</div>
          <Consumer />
        </OrpcWsProvider>
      );
    }

    const { rerender } = render(<Parent tick={0} />);
    expect(screen.getByTestId("tick")).toHaveTextContent("0");

    rerender(<Parent tick={1} />);
    expect(screen.getByTestId("tick")).toHaveTextContent("1");

    rerender(<Parent tick={2} />);
    expect(screen.getByTestId("tick")).toHaveTextContent("2");

    // All consumer renders saw the exact same client reference.
    expect(observed.length).toBeGreaterThanOrEqual(3);
    for (const c of observed) {
      expect(c).toBe(client);
    }
  });
});
