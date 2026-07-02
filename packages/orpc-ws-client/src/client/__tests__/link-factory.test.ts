// LinkFactory regression tests.
//
// Pins the Phase 1.4 invariants from CLAUDE.md design §2.1:
//   - LAZY: nothing happens until `getLink()`. Construction of the factory
//     never touches the WS holder. (See `getWebSocket` spy: zero calls before
//     `getLink()`.)
//   - CACHED: a second `getLink()` returns the same `RPCLink` instance and
//     does NOT call `getWebSocket()` again. This is what makes the partysocket
//     wrapper indirection load-bearing: across partysocket-internal reconnects
//     the cached link stays valid because the wrapper transparently re-routes.
//   - INVALIDATABLE: `clearLink()` drops the cache; the next `getLink()`
//     re-reads the wrapper and constructs a fresh `RPCLink`. This is the
//     TokenRefreshHandler swap path — fresh wrapper, fresh link.
//   - INTROSPECTABLE: `hasLink()` mirrors the cache state. Used by tests
//     (and potentially by composition-root assertions later); NOT on the
//     public `OrpcWsClient` surface.
//   - WRAPPER INDIRECTION (CLAUDE.md Bug 1 / partysocket internal reconnects):
//     the link receives the WRAPPER, NOT the inner native socket. We assert
//     this by giving the wrapper a sentinel identity and reading the link's
//     captured `websocket` reference back out.

import { describe, expect, it, vi } from "vitest";

import type ReconnectingWebSocket from "partysocket/ws";

import { LinkFactory, LinkNotReadyError } from "../link-factory.js";

// ---------- Fakes ----------

/**
 * Mimics the partysocket wrapper surface that LinkFactory cares about:
 *   - readyState (must be OPEN at link-creation time)
 *   - addEventListener / send (the structural subset RPCLink consumes)
 *
 * `addEventListener` and `send` are spies so the wrapper-indirection test
 * can verify that the link wired its event listeners onto THIS wrapper,
 * not onto the inner native socket exposed via `_ws`. (LinkWebsocketClient
 * binds `message` and `close` listeners and routes `send()` through a
 * closure capture — it does NOT store the websocket on a public field —
 * so the only observable proof of wrapper-vs-native indirection is the
 * call sites of those listeners and the recipient of `send()`.)
 *
 * The `_ws` field exists as a sentinel: it mirrors partysocket's internal
 * native-socket reference. If a regression made LinkFactory reach into
 * `_ws`, the inner spies would tick instead of the wrapper's.
 */
function makeWrapperLike(opts: {
  readyState?: number;
  wrapperLabel?: string;
  innerNativeLabel?: string;
}): ReconnectingWebSocket {
  const wrapperLabel = opts.wrapperLabel ?? "wrapper";
  const innerNativeLabel = opts.innerNativeLabel ?? "native";
  const innerNative = {
    __nativeLabel: innerNativeLabel,
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    addEventListener: vi.fn(),
  };
  return {
    __wrapperLabel: wrapperLabel,
    _ws: innerNative,
    readyState: opts.readyState ?? WebSocket.OPEN,
    send: vi.fn(),
    addEventListener: vi.fn(),
  } as unknown as ReconnectingWebSocket;
}

/**
 * Helper: returns the spies on the wrapper so a test can assert that the
 * link's listeners landed here (and NOT on the inner native socket).
 */
function spies(wrapper: ReconnectingWebSocket): {
  send: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  inner: {
    send: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
  };
} {
  const w = wrapper as unknown as {
    send: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    _ws: {
      send: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
    };
  };
  return {
    send: w.send,
    addEventListener: w.addEventListener,
    inner: { send: w._ws.send, addEventListener: w._ws.addEventListener },
  };
}

// ---------- Tests ----------

describe("LinkFactory — lazy creation + cache", () => {
  it("does NOT call getWebSocket until getLink() is invoked", () => {
    const getWs = vi.fn(() => makeWrapperLike({}));
    new LinkFactory(getWs);

    expect(getWs).not.toHaveBeenCalled();
  });

  it("getLink() returns the SAME RPCLink instance on a second call (cached)", () => {
    const getWs = vi.fn(() => makeWrapperLike({}));
    const factory = new LinkFactory(getWs);

    const first = factory.getLink();
    const second = factory.getLink();

    expect(second).toBe(first);
    // Crucial: cache short-circuits the holder lookup too. After the first
    // link is built, partysocket-internal reconnects shouldn't pull a new
    // wrapper out of the holder because there's nothing new to grab.
    expect(getWs).toHaveBeenCalledTimes(1);
  });

  it("clearLink() invalidates the cache: next getLink() constructs a fresh instance against the NEW wrapper", () => {
    const wrapperA = makeWrapperLike({ wrapperLabel: "A" });
    const wrapperB = makeWrapperLike({ wrapperLabel: "B" });
    let nextWrapper: ReconnectingWebSocket = wrapperA;
    const getWs = vi.fn(() => nextWrapper);

    const factory = new LinkFactory(getWs);
    const first = factory.getLink();
    expect(factory.hasLink()).toBe(true);
    // Sanity: the first link's listeners landed on wrapperA.
    expect(spies(wrapperA).addEventListener).toHaveBeenCalled();
    expect(spies(wrapperB).addEventListener).not.toHaveBeenCalled();

    // Simulate TokenRefreshHandler swap-out: the holder now returns the new
    // wrapper, and the factory's link must follow.
    factory.clearLink();
    nextWrapper = wrapperB;
    const second = factory.getLink();

    expect(second).not.toBe(first);
    // getWs called twice: once for the first link, once after clearLink().
    expect(getWs).toHaveBeenCalledTimes(2);
    // Second link's listeners landed on wrapperB, not wrapperA again.
    expect(spies(wrapperB).addEventListener).toHaveBeenCalled();
  });

  it("hasLink() reflects cache state across creation and invalidation", () => {
    const getWs = vi.fn(() => makeWrapperLike({}));
    const factory = new LinkFactory(getWs);

    expect(factory.hasLink()).toBe(false);
    factory.getLink();
    expect(factory.hasLink()).toBe(true);
    factory.clearLink();
    expect(factory.hasLink()).toBe(false);
  });
});

describe("LinkFactory — error paths", () => {
  it("throws a descriptive error if no WebSocket is set on the holder", () => {
    const factory = new LinkFactory(() => null);
    expect(() => factory.getLink()).toThrow(
      /WebSocket not initialized/,
    );
  });

  it("throws if the WebSocket has not reached OPEN yet (caller race)", () => {
    const wrapper = makeWrapperLike({ readyState: WebSocket.CONNECTING });
    const factory = new LinkFactory(() => wrapper);
    expect(() => factory.getLink()).toThrow(/WebSocket not ready/);
  });

  it("the not-OPEN throw is the TYPED LinkNotReadyError (name-classifiable as transient)", () => {
    // Adapters classify the establishment race by this type/name (e.g.
    // `useWsSubscription` suppresses it like an AbortError) — pre-typing
    // it was a plain `Error` and the race surfaced as a real failure.
    const wrapper = makeWrapperLike({ readyState: WebSocket.CLOSING });
    const factory = new LinkFactory(() => wrapper);
    try {
      factory.getLink();
      expect.unreachable("getLink() must throw on a non-OPEN socket");
    } catch (err) {
      expect(err).toBeInstanceOf(LinkNotReadyError);
      expect(err).toBeInstanceOf(Error);
      // The NAME is the cross-package-copy-stable discriminator the react
      // adapter matches on — pin it independently of the class identity.
      expect((err as Error).name).toBe("LinkNotReadyError");
      // Message preserved verbatim from the pre-typed plain Error.
      expect((err as Error).message).toBe("[LinkFactory] WebSocket not ready");
    }
  });
});

describe("LinkFactory — partysocket wrapper indirection (Bug 1 / CLAUDE.md §2.1)", () => {
  // The whole point of this layer: the link must hold the WRAPPER reference,
  // never the inner `_ws`. partysocket creates a new internal `_ws` on each
  // reconnect; if we'd captured `_ws` directly, the link would write into a
  // dead socket. ORPC's `LinkWebsocketClient` does NOT publicly expose the
  // captured websocket — it binds listeners and closes over `send()` — so
  // the observable proof is "the wrapper's spies tick; the inner native
  // socket's don't."
  it("wires its message/close listeners onto the WRAPPER, not the inner native socket", () => {
    const wrapper = makeWrapperLike({
      wrapperLabel: "wrapper-sentinel",
      innerNativeLabel: "native-sentinel",
    });
    const factory = new LinkFactory(() => wrapper);

    factory.getLink();

    const s = spies(wrapper);
    // LinkWebsocketClient calls addEventListener("message", …) and
    // ("close", …) on its websocket argument. Both must hit the wrapper.
    const wrapperEvents = s.addEventListener.mock.calls.map(
      ([evt]) => evt as string,
    );
    expect(wrapperEvents).toContain("message");
    expect(wrapperEvents).toContain("close");

    // And the inner native socket must have been left untouched. If we'd
    // regressed to capturing `_ws`, these would be where the listeners
    // landed instead.
    expect(s.inner.addEventListener).not.toHaveBeenCalled();
    expect(s.inner.send).not.toHaveBeenCalled();
  });

  it("a partysocket-internal reconnect (no clearLink) leaves the cached link reusing the SAME wrapper", () => {
    // Simulates partysocket re-creating its internal `_ws` without notifying
    // the holder. The factory should still return the cached link because
    // the wrapper reference hasn't changed. The cached link's listeners
    // remain bound to the wrapper — which is exactly the point: the
    // wrapper transparently routes through whatever `_ws` is current.
    const wrapper = makeWrapperLike({});
    const getWs = vi.fn(() => wrapper);
    const factory = new LinkFactory(getWs);

    const link1 = factory.getLink();
    const beforeCalls = spies(wrapper).addEventListener.mock.calls.length;

    // Simulate partysocket swapping its inner native socket:
    (wrapper as unknown as { _ws: unknown })._ws = {
      __nativeLabel: "new-native",
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      addEventListener: vi.fn(),
    };
    const link2 = factory.getLink();

    expect(link2).toBe(link1);
    expect(getWs).toHaveBeenCalledTimes(1);
    // No new listeners were attached (the cache short-circuited construction).
    expect(spies(wrapper).addEventListener.mock.calls.length).toBe(
      beforeCalls,
    );
  });
});
