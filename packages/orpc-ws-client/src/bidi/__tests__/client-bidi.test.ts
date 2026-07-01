// Unit tests for the per-client browser-side bidi coordinator (`createClientBidi`).
//
// Isolated: hand-rolled fake `UnderlyingSocket`s stand in for the partysocket
// wrapper (mirrors the server's `connection-bidi.test.ts` + the Phase-4
// `client-router-host.test.ts`). No live WebSocket. We prove what is honestly
// testable on the client side without a real server peer (full round-trip =
// Phase-6 e2e):
//   1. `attach` interposes a `SocketMultiplexer`: `c2sLinkSocket()` is the c2s
//      FACADE (not the raw wrapper), `null` before the first attach, and the mux
//      attaches its single real listeners (incl. the s2c host's `'message'`).
//   2. WRAPPER SWAP: a second `attach` retires the PREVIOUS mux (its underlying's
//      real listeners are detached after the dispose microtask) and builds a fresh
//      one over the new wrapper — modeling the token-refresh / reconnect swap.
//   3. TEARDOWN (load-bearing): an in-flight HOSTED s2c execution ABORTS — not
//      hangs — when the wrapper closes, even though `dispose()` runs in the same
//      teardown. Proves the close fan-out reaches the s2c host peer BEFORE the
//      deferred `mux.dispose()` removes the real close listener.
//   4. `dispose()` is idempotent, detaches the mux's real listeners (after the
//      microtask), and clears `c2sLinkSocket()` back to `null`.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient, oc } from "@orpc/contract";
import { os } from "@orpc/server";
import type ReconnectingWebSocket from "partysocket/ws";
import { describe, expect, it } from "vitest";

import {
  BIDI_S2C_CHANNEL,
  SocketMultiplexer,
  type SocketEvent,
  type SocketEventType,
  type SocketListener,
  type UnderlyingSocket,
  type WireFrame,
} from "@orpc-ws/shared";

import { createClientBidi } from "../client-bidi.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * In-memory fake of the structural `UnderlyingSocket` (the partysocket wrapper's
 * stand-in). Tracks listener add/remove (so we can assert mux interposition +
 * teardown) and, when cross-wired to a `peer`, delivers a `send` as a `'message'`
 * on the next microtask (models an async transport, avoids synchronous
 * re-entrancy mid-dispatch).
 */
class FakeSocket implements UnderlyingSocket {
  readyState = 1; // WebSocket.OPEN — ORPC sends immediately, never awaits open.
  binaryType: string | undefined = "blob";
  readonly sent: WireFrame[] = [];
  peer: FakeSocket | undefined;

  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  send(data: WireFrame): void {
    this.sent.push(data);
    const peer = this.peer;
    if (peer !== undefined) {
      queueMicrotask(() => peer.dispatch("message", { data }));
    }
  }

  addEventListener(type: SocketEventType, listener: SocketListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  hasListeners(type: SocketEventType): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  dispatch(type: SocketEventType, event: SocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

/** The fake doubles as the partysocket wrapper the coordinator expects. */
function asWrapper(fake: FakeSocket): ReconnectingWebSocket {
  return fake as unknown as ReconnectingWebSocket;
}

/** Yield to the microtask/macrotask queue so cross-wired frames + deferred
 * `mux.dispose()` drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A trivial client router (no context) for the wiring tests.
const trivialRouter = { ping: os.handler(() => "pong") };

// ---------------------------------------------------------------------------
// 1. Interposition / lifecycle (isolated)
// ---------------------------------------------------------------------------

describe("createClientBidi — wiring", () => {
  it("c2sLinkSocket() is null before the first attach", () => {
    const bidi = createClientBidi(trivialRouter);
    expect(bidi.c2sLinkSocket()).toBeNull();
  });

  it("attach interposes a multiplexer: c2sLinkSocket is the facade, not the raw wrapper", () => {
    const fake = new FakeSocket();
    const bidi = createClientBidi(trivialRouter);

    bidi.attach(asWrapper(fake));

    const c2s = bidi.c2sLinkSocket();
    expect(c2s).not.toBeNull();
    // The c2s socket the link binds is the FACADE — NOT the raw wrapper.
    expect(c2s as unknown).not.toBe(fake);
    // The mux attached its single real 'message' + 'close' listeners; the s2c
    // host's `upgrade` registered the (mux-mediated) 'message' listener too.
    expect(fake.hasListeners("message")).toBe(true);
    expect(fake.hasListeners("close")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Wrapper swap (rebuild + retire previous)
// ---------------------------------------------------------------------------

// Compile-time-only CLIENT contract for the post-swap cross-wired caller.
type PingContract = { ping: typeof oc };

describe("createClientBidi — wrapper swap", () => {
  it("a second attach retires the previous mux and builds a fresh one over the new wrapper", async () => {
    const fake1 = new FakeSocket();
    const fake2 = new FakeSocket();
    const bidi = createClientBidi(trivialRouter);

    bidi.attach(asWrapper(fake1));
    const c2sBefore = bidi.c2sLinkSocket();
    expect(fake1.hasListeners("message")).toBe(true);

    // Model the token-refresh / reconnect swap: the OLD wrapper was already
    // closed by the caller (its close fan-out ran), then a NEW wrapper is born
    // and attached.
    fake1.dispatch("close", {});
    bidi.attach(asWrapper(fake2));

    // New facade is exposed for the next link rebuild; it differs from the old.
    const c2sAfter = bidi.c2sLinkSocket();
    expect(c2sAfter).not.toBeNull();
    expect(c2sAfter as unknown).not.toBe(c2sBefore as unknown);
    expect(fake2.hasListeners("message")).toBe(true);

    // The PREVIOUS mux is disposed on a microtask (close-before-dispose). After
    // it drains, the old wrapper carries no lingering mux listeners.
    await flush();
    expect(fake1.hasListeners("message")).toBe(false);
    expect(fake1.hasListeners("close")).toBe(false);

    // A NEW s2c call actually EXECUTES on the NEW host — not merely that the old
    // listeners were detached. Cross-wire a caller to the SECOND wrapper's mux
    // (s2c channel) and assert the call routes through the second host's router
    // (the fresh `createClientRouterHost` built over `fake2` in this attach).
    const callerFake = new FakeSocket();
    fake2.peer = callerFake;
    callerFake.peer = fake2;
    const callerMux = new SocketMultiplexer(callerFake);
    const link = new RPCLink<Record<string, never>>({
      websocket: callerMux.channel(BIDI_S2C_CHANNEL) as unknown as ClientWs,
    });
    const caller = createORPCClient<ContractRouterClient<PingContract>>(link);
    await expect(caller.ping()).resolves.toBe("pong");
  });
});

// ---------------------------------------------------------------------------
// 3. Teardown (in-flight hosted s2c execution aborts on close-before-dispose)
// ---------------------------------------------------------------------------

// A compile-time-only CLIENT contract for the cross-wired caller proxy.
type ClientContract = { block: typeof oc };

/** Cast a `ChanneledSocket` to the ORPC client adapter's structural socket. */
type ClientWs = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

describe("createClientBidi — teardown", () => {
  it("aborts an in-flight hosted s2c execution on close, then disposes (no hang)", async () => {
    // The client hosts a `block` procedure that resolves ONLY when its execution
    // signal aborts (i.e. on connection close). A caller on the cross-wired peer
    // invokes it; we then close-before-dispose and assert the abort fired.
    let aborted = false;
    let started = false;
    const clientRouter = {
      block: os.handler(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise<string>((resolve) => {
            started = true;
            if (signal?.aborted) {
              aborted = true;
              resolve("aborted");
              return;
            }
            signal?.addEventListener("abort", () => {
              aborted = true;
              resolve("aborted");
            });
          }),
      ),
    };

    const hostFake = new FakeSocket(); // the client (host) side wrapper
    const callerFake = new FakeSocket(); // the cross-wired "server" caller side
    hostFake.peer = callerFake;
    callerFake.peer = hostFake;

    // Host: the coordinator builds the mux + s2c host over the host wrapper.
    const bidi = createClientBidi(clientRouter);
    bidi.attach(asWrapper(hostFake));

    // Caller: a raw @orpc/client RPCLink on the peer mux's s2c channel.
    const callerMux = new SocketMultiplexer(callerFake);
    const link = new RPCLink<Record<string, never>>({
      websocket: callerMux.channel(BIDI_S2C_CHANNEL) as unknown as ClientWs,
    });
    const caller = createORPCClient<ContractRouterClient<ClientContract>>(link);

    // Fire the call; let the request reach the host and the handler start.
    const pending = caller.block().catch(() => "rejected");
    await flush();
    expect(started).toBe(true);
    expect(aborted).toBe(false);

    // Close-before-dispose: a real 'close' reaches the host channel (mux fan-out
    // → s2c peer.close → aborts the in-flight handler signal), THEN dispose()
    // defers mux.dispose() to a microtask. The abort must fire — a hang would
    // fail this test by timeout.
    hostFake.dispatch("close", {});
    // One real socket closing hits BOTH peers simultaneously: the host's
    // ServerPeer aborts the in-flight handler (asserted via `aborted` below),
    // AND the caller's ClientPeer rejects its pending request. The two
    // FakeSockets model the two ends of that single connection, so we must
    // close both — otherwise the aborted host (now closed) never sends a
    // response and the caller's `block()` would hang forever.
    callerFake.dispatch("close", {});
    bidi.dispose();

    await flush();
    expect(aborted).toBe(true);
    // The caller-side promise settles (rejects) on its own close.
    await pending;

    // After dispose drains, the host wrapper carries no lingering mux listeners
    // and the coordinator exposes no current c2s facade.
    expect(hostFake.hasListeners("message")).toBe(false);
    expect(hostFake.hasListeners("close")).toBe(false);
    expect(bidi.c2sLinkSocket()).toBeNull();
  });

  it("dispose() is idempotent", async () => {
    const fake = new FakeSocket();
    const bidi = createClientBidi(trivialRouter);
    bidi.attach(asWrapper(fake));

    fake.dispatch("close", {});
    bidi.dispose();
    bidi.dispose(); // second call is a no-op

    await flush();
    expect(fake.hasListeners("message")).toBe(false);
    expect(bidi.c2sLinkSocket()).toBeNull();
  });
});
