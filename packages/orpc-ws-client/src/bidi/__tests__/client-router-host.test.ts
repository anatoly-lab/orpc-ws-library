// Unit tests for the client-side server→client router host (`s2c` channel).
//
// Two layers:
//   1. WIRING (isolated, spy/real mux over a fake `UnderlyingSocket`): the host
//      forwards the `s2c` socket + injected context to ORPC's
//      `WsHandler.upgrade`, defaults to an empty context, and — once the mux is
//      disposed — detaches the only real `'message'` listener so no further
//      inbound `s2c` frame can reach the host (the close-before-dispose
//      teardown contract from the module header).
//   2. ROUND TRIP (real ORPC caller ↔ this host over an in-memory mux pair, with
//      NO `@orpc-ws/server` import): the server→client call actually executes in
//      the "browser" and its value / throw / injected context travel back over
//      the wire. The caller is built from a RAW `@orpc/client` `RPCLink` (a
//      client dep) pointed at one mux; the host at the other; the two muxes are
//      cross-wired over two fake sockets (A.send delivers a `'message'` to B and
//      vice-versa).
//
// DEFERRED to Phase-6 e2e (NOT asserted here): a REAL WebSocket, the server
// lifecycle, and reconnect. This proves the mechanism over in-memory sockets.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { oc } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";
import { os } from "@orpc/server";
import { WsHandler } from "@orpc/server/ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type BidiChannel,
  SocketMultiplexer,
  type SocketEvent,
  type SocketEventType,
  type SocketListener,
  type UnderlyingSocket,
  type WireFrame,
} from "@orpc-ws/shared";

import { createClientRouterHost } from "../client-router-host.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * In-memory fake of the structural `UnderlyingSocket`. Records outbound frames,
 * tracks listener add/remove (so we can assert mux teardown), and can deliver
 * an event to whatever the mux registered. Optionally cross-wired to a `peer`:
 * a `send` then surfaces on the peer as a `'message'` (next microtask, to model
 * an async transport and avoid synchronous re-entrancy mid-dispatch).
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

  listenerCount(type: SocketEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: SocketEventType, event: SocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

/** The leading channel-tag unit of a frame, as a single char (string or byte). */
function channelTagOf(frame: WireFrame): string {
  if (typeof frame === "string") return frame[0] ?? "";
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  return String.fromCharCode(bytes[0] ?? 0);
}

/** Yield to the microtask/macrotask queue so cross-wired frames drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Wiring (isolated)
// ---------------------------------------------------------------------------

describe("createClientRouterHost — wiring", () => {
  // A trivial router; construction must not throw and `upgrade` is spied off.
  const trivialRouter = { ping: os.handler(() => "pong") };

  it("upgrades the handler on the s2c socket with the injected context", () => {
    const upgrade = vi
      .spyOn(WsHandler.prototype, "upgrade")
      .mockResolvedValue(undefined);

    const ctxRouter = os.$context<{ tenant: string }>();
    const router = { whoami: ctxRouter.handler(({ context }) => context.tenant) };

    const mux = new SocketMultiplexer(new FakeSocket());
    const s2cSocket = mux.channel(BIDI_S2C_CHANNEL);

    createClientRouterHost(s2cSocket, router, { context: { tenant: "acme" } });

    expect(upgrade).toHaveBeenCalledTimes(1);
    // First arg is the s2c channel facade (the boundary cast is identity at
    // runtime) — proving the handler is hosted on the s2c channel, not c2s.
    expect(upgrade.mock.calls[0]![0]).toBe(s2cSocket);
    // Second arg forwards the injected context verbatim to `.upgrade`.
    expect(upgrade.mock.calls[0]![1]).toEqual({ context: { tenant: "acme" } });
  });

  it("defaults to an empty context when none is injected", () => {
    const upgrade = vi
      .spyOn(WsHandler.prototype, "upgrade")
      .mockResolvedValue(undefined);

    const mux = new SocketMultiplexer(new FakeSocket());
    createClientRouterHost(mux.channel(BIDI_S2C_CHANNEL), trivialRouter);

    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(upgrade.mock.calls[0]![1]).toEqual({ context: {} });
  });

  it("stops processing inbound s2c frames once the mux is disposed", () => {
    // Real handler (no spy): ORPC registers its `'message'` listener via the
    // mux. The mux keeps exactly ONE real `'message'` listener on the underlying
    // socket; `dispose()` detaches it, so no inbound frame can reach the host
    // afterward — the observable half of the close-before-dispose contract.
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    createClientRouterHost(mux.channel(BIDI_S2C_CHANNEL), trivialRouter);

    expect(fake.listenerCount("message")).toBe(1);

    // Deliver a real `'close'` BEFORE disposing (the contract), then dispose.
    // The `'close'` here is ILLUSTRATIVE of the Phase-5 close-before-dispose
    // sequence, not what this test asserts: the `listenerCount === 0` guarantee
    // holds from `dispose()` alone — `dispose()` detaches the mux's sole real
    // `'message'` listener regardless of any preceding close.
    fake.dispatch("close", {});
    mux.dispose();

    expect(fake.listenerCount("message")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Round trip (real caller ↔ real host over a cross-wired mux pair)
// ---------------------------------------------------------------------------

// A compile-time-only CLIENT contract for the caller proxy. `oc` is an untyped
// `ContractProcedure`, so each entry is callable with `unknown` in/out — enough
// to drive the dynamic runtime proxy (mirrors the Phase 3 link test).
type ClientContract = {
  echo: typeof oc;
  boom: typeof oc;
  whoami: typeof oc;
};

/** Cast a `ChanneledSocket` to the ORPC client adapter's structural socket. */
type ClientWs = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

function setupPair(context: { tenant: string }): {
  caller: ContractRouterClient<ClientContract>;
  socketA: FakeSocket;
  socketB: FakeSocket;
} {
  // The CLIENT's own router (callee), built off a context-typed `os`.
  const base = os.$context<{ tenant: string }>();
  const clientRouter = {
    echo: base.handler(({ input }) => `echo:${(input as { msg: string }).msg}`),
    boom: base.handler(() => {
      throw new Error("handler exploded");
    }),
    whoami: base.handler(({ context: ctx }) => ctx.tenant),
  };

  const socketA = new FakeSocket(); // caller side
  const socketB = new FakeSocket(); // host side
  socketA.peer = socketB;
  socketB.peer = socketA;

  const muxA = new SocketMultiplexer(socketA);
  const muxB = new SocketMultiplexer(socketB);

  // Caller: a raw @orpc/client RPCLink on A's s2c channel.
  const link = new RPCLink<Record<string, never>>({
    websocket: muxA.channel(BIDI_S2C_CHANNEL) as unknown as ClientWs,
  });
  const caller = createORPCClient<ContractRouterClient<ClientContract>>(link);

  // Host (this module under test): the client router on B's s2c channel.
  createClientRouterHost(muxB.channel(BIDI_S2C_CHANNEL), clientRouter, {
    context,
  });

  return { caller, socketA, socketB };
}

describe("createClientRouterHost — server→client round trip", () => {
  it("resolves with the value the hosted handler returns", async () => {
    const { caller } = setupPair({ tenant: "acme" });
    await expect(caller.echo({ msg: "hi" })).resolves.toBe("echo:hi");
  });

  it("rejects when the hosted handler throws", async () => {
    const { caller } = setupPair({ tenant: "acme" });
    const pending = caller.boom();
    await expect(pending).rejects.toThrow();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  it("forwards the injected context to the hosted handler", async () => {
    const { caller } = setupPair({ tenant: "acme" });
    await expect(caller.whoami()).resolves.toBe("acme");
  });

  it("multiplexes concurrent in-flight calls to their own results", async () => {
    // Fire several server→client calls before any resolves: ORPC's ServerPeer
    // must key each reply to its own request id over the single s2c channel.
    // `echo`'s output depends on its input, so a misrouted reply would surface
    // as a swapped value rather than a silent pass.
    const { caller } = setupPair({ tenant: "acme" });

    const [a, b, c] = await Promise.all([
      caller.echo({ msg: "one" }),
      caller.echo({ msg: "two" }),
      caller.echo({ msg: "three" }),
    ]);

    expect(a).toBe("echo:one");
    expect(b).toBe("echo:two");
    expect(c).toBe("echo:three");
  });

  it("never emits a frame on the c2s channel during the exchange", async () => {
    const { caller, socketA, socketB } = setupPair({ tenant: "acme" });

    await expect(caller.echo({ msg: "hi" })).resolves.toBe("echo:hi");

    // Both the caller's request and the host's reply ride the s2c channel only.
    const allFrames = [...socketA.sent, ...socketB.sent];
    expect(allFrames.length).toBeGreaterThan(0);
    for (const frame of allFrames) {
      expect(channelTagOf(frame)).toBe(BIDI_S2C_CHANNEL satisfies BidiChannel);
      expect(channelTagOf(frame)).not.toBe(BIDI_C2S_CHANNEL);
    }
  });

  it("stops answering after the host side is torn down", async () => {
    const { caller, socketB } = setupPair({ tenant: "acme" });

    // Prove the link is live first.
    await expect(caller.echo({ msg: "first" })).resolves.toBe("echo:first");

    // Tear the HOST side down: close (so the peer aborts) then drop the wire.
    socketB.peer = undefined;
    socketB.dispatch("close", {});

    // A further call leaves the wire but is never answered — assert it does not
    // settle within a flush window (the host no longer processes s2c frames).
    const sentinel = Symbol("unanswered");
    const result = await Promise.race([
      caller.echo({ msg: "second" }).catch(() => "rejected"),
      flush().then(() => sentinel),
    ]);
    expect(result).toBe(sentinel);
  });
});
