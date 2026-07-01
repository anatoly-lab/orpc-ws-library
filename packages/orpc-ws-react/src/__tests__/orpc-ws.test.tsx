// `<OrpcWs>` construct-and-own provider + `useServerHandler` — adapter tests
// (issue #7 Phase 2, feature-local server→client handler registration).
//
// PER THIS REPO'S ADAPTER-TEST RULE: fake the CORE'S stateful public seam,
// don't import core internals and don't spin a real server. We mock
// `@orpc-ws/client`'s `createOrpcWsClient` with a controllable fake (records
// connect/dispose, exposes an `emit` to drive `ConnectionState`), but keep the
// REAL `createDelegatingClientRouter` (a pure, already-tested core helper) so the
// names-from-contract wiring + live registry are proven through the genuine
// router accessor.

import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { oc, type } from "@orpc/contract";

import { connected, createDelegatingClientRouter } from "@orpc-ws/client";
import type * as ClientModule from "@orpc-ws/client";

import { OrpcWs } from "../orpc-ws.js";
import { createServerHandlerHook } from "../use-server-handler.js";
import { useOrpcWs } from "../provider.js";
import { useConnectionState } from "../use-connection-state.js";

// ---- Test harness: hoisted so the `vi.mock` factory below can reference it ----
// Holds the controllable fake clients `createOrpcWsClient` hands out, plus the
// `getHandlers` accessor + built router the (real) delegating router was made
// with — so a test can read the LIVE registry the leaves consult.
const H = vi.hoisted(() => {
  type Handlers = Record<string, (input: unknown) => unknown>;
  const createdClients: Array<{
    client: unknown;
    connect: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    emit: (next: unknown) => void;
  }> = [];
  let lastGetHandlers: (() => Handlers) | undefined;
  let lastRouter: Record<string, unknown> | undefined;

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
    capture: (g: () => Handlers, router: Record<string, unknown>) => {
      lastGetHandlers = g;
      lastRouter = router;
    },
    getLastHandlers: () => lastGetHandlers,
    getLastRouter: () => lastRouter,
    reset: () => {
      createdClients.length = 0;
      lastGetHandlers = undefined;
      lastRouter = undefined;
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
    // handed (so a test can read the live registry) + the built router (so a
    // test can assert its declared-from-contract key set).
    createDelegatingClientRouter: vi.fn(
      (names: readonly string[], getHandlers: () => Record<string, (input: unknown) => unknown>) => {
        const router = actual.createDelegatingClientRouter(names, getHandlers);
        H.capture(getHandlers, router as Record<string, unknown>);
        return router;
      },
    ),
  };
});

// ---- A REAL small server→client contract (`oc.router`) — two procedures so a
// MISSING-handler case is meaningful. Used as a VALUE (passed to `clientContract`
// so names derive from its keys) AND a type (binds the hook). ----
const clientContract = oc.router({
  greet: oc.input(type<{ name: string }>()).output(type<string>()),
  ping: oc.input(type<{ at: number }>()).output(type<boolean>()),
});
type ClientContract = typeof clientContract;

// The contract-bound hook (the public typed surface).
const useServerHandler = createServerHandlerHook<ClientContract>();

const flushMicrotasks = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  H.reset();
  vi.mocked(createDelegatingClientRouter).mockClear();
});

describe("<OrpcWs> + useServerHandler — feature-local server→client handlers", () => {
  it("invokes a registered handler with the right input; its return flows back", () => {
    function Greeter() {
      useServerHandler("greet", (input) => `hi:${input.name}`);
      return <div data-testid="child">ok</div>;
    }

    render(
      <OrpcWs clientContract={clientContract}>
        <Greeter />
      </OrpcWs>,
    );

    // The leaf consults the live registry via this captured accessor. `greet` is
    // registered (its effect flushed during render), so calling it runs the
    // handler with the passed input and returns its result.
    const getHandlers = H.getLastHandlers();
    expect(getHandlers).toBeDefined();
    expect(getHandlers!().greet?.({ name: "ada" })).toBe("hi:ada");

    // Built ONCE; the delegating router built ONCE.
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDelegatingClientRouter)).toHaveBeenCalledTimes(1);
  });

  it("delivers the LATEST-render handler (proves the closure ref), no rebuild", () => {
    function Greeter({ value }: { value: string }) {
      // Fresh closure every render, closing over `value`.
      useServerHandler("greet", () => value);
      return null;
    }
    function Harness({ value }: { value: string }) {
      return (
        <OrpcWs clientContract={clientContract}>
          <Greeter value={value} />
        </OrpcWs>
      );
    }

    const { rerender } = render(<Harness value="A" />);
    const getHandlers = H.getLastHandlers()!;
    expect(getHandlers().greet?.({ name: "x" })).toBe("A");

    // Re-render with a handler closing over a NEW value: the registered wrapper
    // must see it WITHOUT re-registering (deps are [name, register], not
    // [handler]) and WITHOUT rebuilding the client.
    rerender(<Harness value="B" />);
    expect(getHandlers().greet?.({ name: "x" })).toBe("B");
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDelegatingClientRouter)).toHaveBeenCalledTimes(1);
  });

  it("a contract-declared name with no mounted handler is absent from the live map (→ core leaf throws NOT_FOUND)", () => {
    // Only `greet` mounts; `ping` is declared in the contract but unregistered.
    function Greeter() {
      useServerHandler("greet", (input) => `hi:${input.name}`);
      return null;
    }
    render(
      <OrpcWs clientContract={clientContract}>
        <Greeter />
      </OrpcWs>,
    );

    // The hosted router DECLARES both names (frozen from the contract)…
    const router = H.getLastRouter()!;
    expect(Object.keys(router).sort()).toEqual(["greet", "ping"]);

    // …but the LIVE map the leaf reads has `greet` and NOT `ping`. That missing
    // entry is exactly the precondition under which the core delegating leaf
    // throws `ORPCError("NOT_FOUND")` — the actual throw is asserted in the core
    // suite (`delegating-router.test.ts`), which can drive a leaf via `call()`
    // (`@orpc/server`, forbidden in this browser-only adapter package).
    const getHandlers = H.getLastHandlers()!;
    expect(typeof getHandlers().greet).toBe("function");
    expect(getHandlers().ping).toBeUndefined();
  });

  it("DUPLICATE name: last-wins + warns; unmounting the FIRST does not clobber the SECOND (dispose-by-identity)", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    function Dup({ value }: { value: string }) {
      useServerHandler("greet", () => value);
      return null;
    }
    function Harness({ showFirst }: { showFirst: boolean }) {
      return (
        <OrpcWs clientContract={clientContract} logger={logger}>
          {showFirst && <Dup value="FIRST" />}
          <Dup value="SECOND" />
        </OrpcWs>
      );
    }

    const { rerender } = render(<Harness showFirst={true} />);
    const getHandlers = H.getLastHandlers()!;

    // Second registration (same name) warns — through the client's logger, not
    // console — and OVERWRITES: last registration wins.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/already registered/);
    expect(getHandlers().greet?.({ name: "x" })).toBe("SECOND");

    // Unmount the FIRST registrant. Its dispose deletes ONLY by identity, so it
    // must NOT remove the SECOND's still-current registration.
    rerender(<Harness showFirst={false} />);
    expect(getHandlers().greet?.({ name: "x" })).toBe("SECOND");
  });

  it("DUPLICATE name: WINNER (SECOND) unmounting FIRST clears the name (no LIFO fallback — documented usage-error semantic)", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    function Dup({ value }: { value: string }) {
      useServerHandler("greet", () => value);
      return null;
    }
    function Harness({ showSecond }: { showSecond: boolean }) {
      return (
        <OrpcWs clientContract={clientContract} logger={logger}>
          <Dup value="FIRST" />
          {showSecond && <Dup value="SECOND" />}
        </OrpcWs>
      );
    }

    const { rerender } = render(<Harness showSecond={true} />);
    const getHandlers = H.getLastHandlers()!;

    // FIRST registers, then SECOND overwrites (last-wins).
    expect(getHandlers().greet?.({ name: "x" })).toBe("SECOND");

    // Unmount the WINNER (SECOND) while FIRST is still mounted. Dispose-by-identity
    // removes SECOND's entry; there is NO LIFO fallback to FIRST (whose mount
    // effect already ran and won't re-fire), so the name goes DEAD — the
    // documented usage-error tradeoff, pinned here.
    rerender(<Harness showSecond={false} />);
    expect(getHandlers().greet).toBeUndefined();
  });

  it("throws on a NESTED clientContract entry (flat v1 only)", () => {
    // A sub-router under `grp` — not a flat leaf procedure. `<OrpcWs>` must fail
    // loud at construction (naming the key) rather than build a broken flat leaf.
    const nested = oc.router({
      grp: oc.router({
        inner: oc.input(type<{ x: number }>()).output(type<boolean>()),
      }),
    });
    expect(() =>
      render(
        <OrpcWs clientContract={nested}>
          <div />
        </OrpcWs>,
      ),
    ).toThrow(/"grp".*nested client contracts are not supported/s);
  });

  it("ends with a LIVE registration under StrictMode (register→unregister→register)", () => {
    function Greeter() {
      useServerHandler("greet", () => "X");
      return null;
    }
    render(
      <StrictMode>
        <OrpcWs clientContract={clientContract}>
          <Greeter />
        </OrpcWs>
      </StrictMode>,
    );

    // StrictMode double-invokes the registration effect (mount→unmount→remount);
    // dispose-by-identity removes the first wrapper, the remount re-registers, so
    // the registry ends with a LIVE handler.
    const getHandlers = H.getLastHandlers()!;
    expect(typeof getHandlers().greet).toBe("function");
    expect(getHandlers().greet?.({ name: "x" })).toBe("X");
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
  });

  it("constructs the client exactly once across re-renders", () => {
    function ReRenderHarness({ n }: { n: number }) {
      return (
        <OrpcWs clientContract={clientContract}>
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
      <OrpcWs clientContract={clientContract}>
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
        <OrpcWs clientContract={clientContract}>
          <div />
        </OrpcWs>
      </StrictMode>,
    );

    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    const created = H.createdClients[0]!;

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
      <OrpcWs clientContract={clientContract}>
        <Child />
      </OrpcWs>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("connecting");
  });

  it("renders fallback until connected, then children", () => {
    render(
      <OrpcWs
        clientContract={clientContract}
        fallback={<div data-testid="fb">loading</div>}
      >
        <div data-testid="child">ready</div>
      </OrpcWs>,
    );
    expect(screen.getByTestId("fb")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).toBeNull();

    act(() => {
      H.createdClients[0]!.emit(connected());
    });
    expect(screen.queryByTestId("fb")).toBeNull();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("constructs a one-way client (no bidi router) when clientContract is omitted", () => {
    render(
      <OrpcWs url="ws://test">
        <div data-testid="child">ok</div>
      </OrpcWs>,
    );
    expect(H.createOrpcWsClient).toHaveBeenCalledTimes(1);
    // No delegating router built, and no clientRouter handed to the core.
    expect(vi.mocked(createDelegatingClientRouter)).not.toHaveBeenCalled();
    const opts = H.createOrpcWsClient.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.clientRouter).toBeUndefined();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("useServerHandler throws when there is no clientContract (no bidi registry)", () => {
    function StrayHandler() {
      useServerHandler("greet", () => "x");
      return null;
    }
    // No `clientContract` ⇒ `register` is null ⇒ the hook fails loudly.
    expect(() =>
      render(
        <OrpcWs url="ws://test">
          <StrayHandler />
        </OrpcWs>,
      ),
    ).toThrow(/clientContract/);
  });
});
