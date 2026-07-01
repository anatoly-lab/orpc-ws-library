// Unit tests for the per-connection bidi wiring (`createConnectionBidi`).
//
// Isolated: a hand-rolled fake `UnderlyingSocket` stands in for the real `ws`
// (mirrors `server-client-link.test.ts`). No live WebSocket, no answering peer.
// We prove what's honestly testable here:
//   1. A `SocketMultiplexer` is interposed: `c2sSocket` is the c2s FACADE, NOT
//      the raw socket, and a typed `client` proxy is produced.
//   2. The c2s facade speaks on the c2s channel; the s2c `client` speaks on the
//      s2c channel (channel isolation).
//   3. TEARDOWN (load-bearing): an in-flight `client.x()` call REJECTS — does
//      not hang — when the connection closes, even though `dispose()` is called
//      in the same teardown. This proves the close fan-out reaches the s2c peer
//      before `mux.dispose()` removes the real close listener.

import type { oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type SocketEvent,
  type SocketEventType,
  type SocketListener,
  type UnderlyingSocket,
  type WireFrame,
} from "@orpc-ws/shared";
import type { WebSocket } from "ws";

import { createConnectionBidi } from "../connection-bidi.js";

// A minimal CLIENT contract TYPE (see `server-client-link.test.ts` for why
// `{ notify: typeof oc }` is a valid `AnyContractRouter` and only drives typing).
type ClientContract = { notify: typeof oc };

/** Captures sent frames + lets a test dispatch lifecycle events. Reports OPEN. */
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

  hasListeners(type: SocketEventType): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
}

/** The fake doubles as the `ws.WebSocket` the factory expects (cast at the seam). */
function makeBidi(fake: FakeUnderlyingSocket): ReturnType<
  typeof createConnectionBidi<ClientContract>
> {
  return createConnectionBidi<ClientContract>(fake as unknown as WebSocket);
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

describe("createConnectionBidi", () => {
  it("interposes a multiplexer: c2sSocket is the facade, not the raw socket", () => {
    const fake = new FakeUnderlyingSocket();
    const bidi = makeBidi(fake);

    // The c2s socket handed to `upgrade()` must NOT be the raw socket — the mux
    // sits in between. A typed client proxy is produced.
    expect(bidi.c2sSocket).not.toBe(fake);
    expect(typeof bidi.client.notify).toBe("function");
    // The mux attached its single real 'message' + lifecycle listeners.
    expect(fake.hasListeners("message")).toBe(true);
    expect(fake.hasListeners("close")).toBe(true);
  });

  it("the s2c client speaks only on the s2c channel", async () => {
    const fake = new FakeUnderlyingSocket();
    const bidi = makeBidi(fake);

    void bidi.client.notify({ msg: "hi" }).catch(() => {});
    await flush();

    expect(fake.sent.length).toBeGreaterThan(0);
    for (const frame of fake.sent) {
      expect(channelTagOf(frame)).toBe(BIDI_S2C_CHANNEL);
      expect(channelTagOf(frame)).not.toBe(BIDI_C2S_CHANNEL);
    }
  });

  it("TEARDOWN: an in-flight s2c call rejects (does not hang) on close", async () => {
    const fake = new FakeUnderlyingSocket();
    const bidi = makeBidi(fake);

    const pending = bidi.client.notify({ msg: "hi" });
    await flush(); // ensure the request is registered before teardown

    // Replicate the connection-handler's EXACT teardown order: the real ws
    // 'close' fires (mux fan-out → s2c peer.close → reject) and, in that same
    // synchronous close handling, the handler calls bidi.dispose() (which
    // defers mux.dispose() to a microtask). The pending call must reject, not
    // hang — a hang would fail this test by timeout.
    fake.dispatch("close", {});
    bidi.dispose();

    await expect(pending).rejects.toThrow();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  it("dispose() is idempotent and detaches the mux's real listeners (after the microtask)", async () => {
    const fake = new FakeUnderlyingSocket();
    const bidi = makeBidi(fake);

    fake.dispatch("close", {});
    bidi.dispose();
    bidi.dispose(); // second call is a no-op

    // mux.dispose() runs on a microtask — wait for it, then assert the real
    // listeners were torn down (no lingering wire listeners after close).
    await flush();
    expect(fake.hasListeners("message")).toBe(false);
    expect(fake.hasListeners("close")).toBe(false);
  });
});
