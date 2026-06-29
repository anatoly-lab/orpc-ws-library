// `<OrpcWs>` construct-and-own provider — adapter tests (issue #7 Phase 2).
//
// PER THIS REPO'S ADAPTER-TEST RULE: fake the CORE'S stateful public seam,
// don't import core internals and don't spin a real server. We mock
// `@orpc-ws/client`'s `createOrpcWsClient` with a controllable fake (records
// connect/dispose, exposes an `emit` to drive `ConnectionState`), but keep the
// REAL `createDelegatingClientRouter` (a pure, already-tested core helper) so the
// ref bridge is proven through the genuine router accessor.

import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { oc, type } from "@orpc/contract";

import { connected, createDelegatingClientRouter } from "@orpc-ws/client";
import type * as ClientModule from "@orpc-ws/client";

import { OrpcWs } from "../orpc-ws.js";
import { useOrpcWs } from "../provider.js";
import { useConnectionState } from "../use-connection-state.js";

// ---- Test harness: hoisted so the `vi.mock` factory below can reference it ----
// Holds the controllable fake clients `createOrpcWsClient` hands out, plus the
// `getHandlers` accessor the (real) delegating router was built with.
const H = vi.hoisted(() => {
  type Handlers = Record<string, (input: unknown) => unknown>;
  const createdClients: Array<{
    client: unknown;
    connect: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    emit: (next: unknown) => void;
  }> = [];
  let lastGetHandlers: (() => Handlers) | undefined;

  // Controllable fake client. `subscribe` registers WITHOUT invoking (the
  // bug-07 invariant the bindings rely on); `emit` drives a transition.
  const createOrpcWsClient = vi.fn((_opts: unknown) => {
    let state: unknown = { status: "connecting" };
    const listeners = new Set<() => void>();
    const connect = vi.fn();
    const dispose = vi.fn();
    const client = {
      rpc: {},
      state: {
        getState: () => state,
        subscribe: (cb: () => void) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
      },
      connect,
      dispose,
    };
    createdClients.push({
      client,
      connect,
      dispose,
      emit: (next: unknown) => {
        state = next;
        for (const l of listeners) l();
      },
    });
    return client;
  });

  return {
    createdClients,
    createOrpcWsClient,
    captureGetHandlers: (g: () => Handlers) => {
      lastGetHandlers = g;
    },
    getLastHandlers: () => lastGetHandlers,
    reset: () => {
      createdClients.length = 0;
      lastGetHandlers = undefined;
      createOrpcWsClient.mockClear();
    },
  };
});

vi.mock("@orpc-ws/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>();
  return {
    ...actual,
    createOrpcWsClient: H.createOrpcWsClient,
    // Keep the REAL router builder, but capture the `getHandlers` accessor it is
    // handed so a test can read the live (render-updated) handler map directly.
    createDelegatingClientRouter: vi.fn(
      (names: readonly string[], getHandlers: () => Record<string, (input: unknown) => unknown>) => {
        H.captureGetHandlers(getHandlers);
        return actual.createDelegatingClientRouter(names, getHandlers);
      },
    ),
  };
});

// ---- Minimal typed contracts (real `oc` + the passthrough `type` schema) ----
// Only its TYPE is used (to type the bidi handler map); the runtime value just
// carries the inferred shape, hence the `_` prefix (allowed-unused convention).
const _clientContract = {
  greet: oc.input(type<{ name: string }>()).output(type<string>()),
};
type ClientContract = typeof _clientContract;

const flushMicrotasks = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  H.reset();
  vi.mocked(createDelegatingClientRouter).mockClear();
});

describe("<OrpcWs> — construct-and-own provider", () => {
  // Re-renders with a fresh handler closing over a new value; the captured
  // `getHandlers` (the real router's accessor) must reflect the LATEST render —
  // the ref bridge delivers live values without rebuilding the client.
  it("delivers the latest-render handler through the ref bridge", () => {
    function BidiHarness({ value }: { value: string }) {
      const handler = (_input: { name: string }): string => value;
      return (
        <OrpcWs<ClientContract>
          url="ws://test"
          clientRouter={{ greet: handler }}
        >
          <div data-testid="child">ok</div>
        </OrpcWs>
      );
    }

    const { rerender } = render(<BidiHarness value="A" />);
    const getHandlers = H.getLastHandlers();
    expect(getHandlers).toBeDefined();
    expect(getHandlers!().greet?.({ name: "x" })).toBe("A");

    rerender(<BidiHarness value="B" />);
    expect(getHandlers!().greet?.({ name: "x" })).toBe("B");

    // Construct-once: neither the client nor the delegating router was rebuilt.
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDelegatingClientRouter)).toHaveBeenCalledTimes(1);
  });

  it("constructs the client exactly once across re-renders", () => {
    function ReRenderHarness({ n }: { n: number }) {
      return (
        <OrpcWs<ClientContract> url="ws://test">
          <div>{n}</div>
        </OrpcWs>
      );
    }
    const { rerender } = render(<ReRenderHarness n={1} />);
    rerender(<ReRenderHarness n={2} />);
    rerender(<ReRenderHarness n={3} />);
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
  });

  it("connects on mount and disposes on unmount", async () => {
    const { unmount } = render(
      <OrpcWs<ClientContract> url="ws://test">
        <div />
      </OrpcWs>,
    );
    const created = H.createdClients[0]!;
    expect(created.connect).toHaveBeenCalledTimes(1);
    expect(created.dispose).not.toHaveBeenCalled();

    unmount();
    // Dispose is deferred to a microtask (StrictMode safety); flush it.
    await flushMicrotasks();
    expect(created.dispose).toHaveBeenCalledTimes(1);
  });

  // Bug-07-style hazard: a disposed client can't reconnect. Under StrictMode's
  // mount→unmount→remount, the deferred dispose must be CANCELLED so the
  // component ends holding a LIVE client (connected, never disposed).
  it("ends with a live client under StrictMode double-mount", async () => {
    render(
      <StrictMode>
        <OrpcWs<ClientContract> url="ws://test">
          <div />
        </OrpcWs>
      </StrictMode>,
    );

    // Built exactly once — even under StrictMode (the useState initializer runs
    // once; the client is never rebuilt to recover from a dispose).
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    const created = H.createdClients[0]!;

    // Flush the dispose microtask scheduled by the in-between unmount: the
    // remount cleared its cancel flag, so it must NOT dispose.
    await flushMicrotasks();
    expect(created.connect).toHaveBeenCalled();
    expect(created.dispose).not.toHaveBeenCalled();
  });

  it("provides the client to descendants (useOrpcWs / useConnectionState)", () => {
    function Child() {
      const client = useOrpcWs<ClientContract>();
      const conn = useConnectionState(client);
      return <div data-testid="child">{conn.status}</div>;
    }
    render(
      <OrpcWs<ClientContract> url="ws://test">
        <Child />
      </OrpcWs>,
    );
    // Resolves the client (no throw) AND reads its reactive state.
    expect(screen.getByTestId("child")).toHaveTextContent("connecting");
  });

  it("renders fallback until connected, then children", () => {
    render(
      <OrpcWs<ClientContract>
        url="ws://test"
        fallback={<div data-testid="fb">loading</div>}
      >
        <div data-testid="child">ready</div>
      </OrpcWs>,
    );
    // Pre-connect (fake starts "connecting"): fallback only.
    expect(screen.getByTestId("fb")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).toBeNull();

    act(() => {
      H.createdClients[0]!.emit(connected());
    });
    // Connected: children, no fallback.
    expect(screen.queryByTestId("fb")).toBeNull();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("constructs a one-way client (no bidi router) when clientRouter is omitted", () => {
    render(
      <OrpcWs<ClientContract> url="ws://test">
        <div data-testid="child">ok</div>
      </OrpcWs>,
    );
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    // No delegating router built, and no clientRouter handed to the core.
    expect(vi.mocked(createDelegatingClientRouter)).not.toHaveBeenCalled();
    const opts = H.createOrpcWsClient.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.clientRouter).toBeUndefined();
    // No fallback ⇒ children render even pre-connect.
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
