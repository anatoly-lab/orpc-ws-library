// Unit tests for the server→client caller factory (`s2c` channel).
//
// Isolated: no live WebSocket, no answering peer. We drive a REAL
// `SocketMultiplexer` over a hand-rolled fake `UnderlyingSocket` so the actual
// channel-tagging path is exercised (the mux prepends the `s2c` tag on send and
// fans out lifecycle events) — only the underlying transport is faked.
//
// DEFERRED (NOT asserted here): a full resolve-with-VALUE round trip. That needs
// the Phase-4 client-side answering handler to reply on the wire; it is a
// Phase-6 e2e assertion. Here we prove only what is honestly testable without a
// peer: the proxy constructs + is callable, an outbound call is tagged onto the
// `s2c` channel, and an in-flight call rejects when the socket closes.

import type { oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  SocketMultiplexer,
  type SocketEvent,
  type SocketEventType,
  type SocketListener,
  type UnderlyingSocket,
  type WireFrame,
} from "@orpc-ws/shared";

import { createServerClientLink } from "../server-client-link.js";

// A minimal CLIENT contract TYPE. `oc` (a `ContractBuilder`) extends
// `ContractProcedure`, so `{ ping: typeof oc }` is a valid `AnyContractRouter`;
// the returned `ContractRouterClient` makes `client.ping(...)` a callable. The
// runtime proxy is fully dynamic, so the contract only drives compile-time
// typing — no real schema or runtime contract value needed (zod is not a server
// devDep, and the factory takes no contract argument).
type ClientContract = { ping: typeof oc };

/**
 * Fake underlying socket: captures every sent frame and lets a test dispatch
 * lifecycle events. Reports `OPEN` so ORPC's client adapter sends immediately
 * (it only awaits `open`/`close` when `readyState === CONNECTING`).
 */
class FakeUnderlyingSocket implements UnderlyingSocket {
  readyState = 1; // WebSocket.OPEN
  binaryType = "blob";
  readonly sent: WireFrame[] = [];
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  send(data: WireFrame): void {
    this.sent.push(data);
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

  /** Test-only: fan an event out to every registered listener of `type`. */
  dispatch(type: SocketEventType, event: SocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function setup(): {
  fake: FakeUnderlyingSocket;
  client: ReturnType<typeof createServerClientLink<ClientContract>>;
} {
  const fake = new FakeUnderlyingSocket();
  const mux = new SocketMultiplexer(fake);
  const s2cSocket = mux.channel(BIDI_S2C_CHANNEL);
  const client = createServerClientLink<ClientContract>(s2cSocket);
  return { fake, client };
}

/** Let ORPC's client peer encode + hand the request to the (fake) socket. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The leading channel-tag unit of a frame, as a single char (string or byte). */
function channelTagOf(frame: WireFrame): string {
  if (typeof frame === "string") return frame[0] ?? "";
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  return String.fromCharCode(bytes[0] ?? 0);
}

describe("createServerClientLink", () => {
  it("returns a typed proxy whose procedures are callable", () => {
    const { client } = setup();
    // Mere property access does not send anything; it just yields the caller.
    expect(typeof client.ping).toBe("function");
  });

  it("tags an outbound call onto the s2c channel", async () => {
    const { fake, client } = setup();

    // Fire-and-don't-await: with no answering peer this never resolves until
    // close. We only care that the request leaves on the wire.
    void client.ping({ msg: "hi" }).catch(() => {});
    await flush();

    expect(fake.sent.length).toBeGreaterThan(0);
    const frame = fake.sent[0]!;
    // The mux prepended the `s2c` tag (`<`)...
    expect(channelTagOf(frame)).toBe(BIDI_S2C_CHANNEL);
    // ...and there is an actual ORPC request payload after the tag byte/char
    // (length > 1 => the frame is tag + serialized request, not a bare tag).
    const length = typeof frame === "string" ? frame.length : frame.byteLength;
    expect(length).toBeGreaterThan(1);
  });

  it("speaks only on the s2c channel (never tags a c2s frame)", async () => {
    const { fake, client } = setup();

    void client.ping({ msg: "hi" }).catch(() => {});
    await flush();

    // Channel isolation: EVERY outbound frame must carry the `s2c` tag and NONE
    // may carry the `c2s` tag — the server-side caller must never speak on the
    // client→server channel.
    expect(fake.sent.length).toBeGreaterThan(0);
    for (const frame of fake.sent) {
      expect(channelTagOf(frame)).toBe(BIDI_S2C_CHANNEL);
      expect(channelTagOf(frame)).not.toBe(BIDI_C2S_CHANNEL);
    }
  });

  it("rejects an in-flight call when the socket closes", async () => {
    const { fake, client } = setup();

    const pending = client.ping({ msg: "hi" });
    await flush(); // ensure the request is registered before we close

    // A genuine close event flows through the mux's lifecycle fan-out to the
    // s2c channel, where ORPC's client peer rejects pending requests
    // (lost-ack / teardown behavior).
    fake.dispatch("close", {});

    // ORPC's `ClientPeer` closes its response queue on the `close` event, which
    // rejects every awaiting request with an `AbortError` (an `Error` subclass).
    // Asserting `Error` (not merely "defined") catches a future regression that
    // rejects for the wrong reason — e.g. with a non-error value.
    await expect(pending).rejects.toThrow();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });
});
