import { describe, expect, it, vi } from "vitest";

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type BidiChannel,
  type ChanneledSocket,
  SocketMultiplexer,
  type SocketEvent,
  type SocketEventType,
  type SocketListener,
  tagFrame,
  type UnderlyingSocket,
  UnknownChannelTagError,
  UnsupportedInboundDataError,
  type WireFrame,
} from "../index.js";

// In-memory fake of the structural `UnderlyingSocket`. No real WebSocket, no
// ORPC. It records outbound frames, lets a test simulate inbound events by
// invoking exactly the listeners the multiplexer registered, and tracks
// listener add/remove so we can assert teardown.
class FakeSocket implements UnderlyingSocket {
  readonly sent: WireFrame[] = [];
  binaryType: string | undefined;
  readyState = 1; // OPEN
  closeCalls: Array<{ code?: number; reason?: string }> = [];

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

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  /** Number of REAL listeners the mux currently has registered for a type. */
  listenerCount(type: SocketEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Simulate the socket delivering an event to all registered listeners. */
  dispatch(type: SocketEventType, event: SocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

// Subscribe a spy to a channel's 'message' events and return both.
function onMessage(socket: ChanneledSocket): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  socket.addEventListener("message", spy);
  return spy;
}

function bytesOf(frame: WireFrame): number[] {
  if (typeof frame === "string") throw new Error("expected a binary frame");
  return Array.from(frame instanceof Uint8Array ? frame : new Uint8Array(frame));
}

describe("SocketMultiplexer construction", () => {
  it("attaches exactly one real listener per event type", () => {
    const fake = new FakeSocket();
    new SocketMultiplexer(fake);
    for (const type of ["message", "open", "close", "error"] as const) {
      expect(fake.listenerCount(type)).toBe(1);
    }
  });

  it("forces binaryType to 'arraybuffer' to avoid Blob frames", () => {
    const fake = new FakeSocket();
    new SocketMultiplexer(fake);
    expect(fake.binaryType).toBe("arraybuffer");
  });

  it("memoizes the per-channel facade", () => {
    const mux = new SocketMultiplexer(new FakeSocket());
    expect(mux.channel(BIDI_C2S_CHANNEL)).toBe(mux.channel(BIDI_C2S_CHANNEL));
    expect(mux.channel(BIDI_C2S_CHANNEL)).not.toBe(
      mux.channel(BIDI_S2C_CHANNEL),
    );
  });
});

describe("inbound routing — channels never cross", () => {
  it("delivers a c2s-tagged frame only to the c2s channel", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const c2s = onMessage(mux.channel(BIDI_C2S_CHANNEL));
    const s2c = onMessage(mux.channel(BIDI_S2C_CHANNEL));

    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "hello") });

    expect(c2s).toHaveBeenCalledTimes(1);
    expect(c2s.mock.calls[0][0]).toEqual({ data: "hello" });
    expect(s2c).not.toHaveBeenCalled();
  });

  it("delivers an s2c-tagged frame only to the s2c channel", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const c2s = onMessage(mux.channel(BIDI_C2S_CHANNEL));
    const s2c = onMessage(mux.channel(BIDI_S2C_CHANNEL));

    fake.dispatch("message", { data: tagFrame(BIDI_S2C_CHANNEL, "world") });

    expect(s2c).toHaveBeenCalledTimes(1);
    expect(s2c.mock.calls[0][0]).toEqual({ data: "world" });
    expect(c2s).not.toHaveBeenCalled();
  });
});

describe("inbound normalization — round-trips per shape", () => {
  const channels: readonly BidiChannel[] = [BIDI_C2S_CHANNEL, BIDI_S2C_CHANNEL];

  for (const channel of channels) {
    it(`round-trips a string frame on ${channel}`, () => {
      const fake = new FakeSocket();
      const mux = new SocketMultiplexer(fake);
      const spy = onMessage(mux.channel(channel));

      fake.dispatch("message", { data: tagFrame(channel, '{"a":1}') });

      expect(spy.mock.calls[0][0]).toEqual({ data: '{"a":1}' });
    });

    it(`round-trips a Uint8Array frame on ${channel}`, () => {
      const fake = new FakeSocket();
      const mux = new SocketMultiplexer(fake);
      const spy = onMessage(mux.channel(channel));
      const payload = new Uint8Array([1, 2, 3, 250, 0]);

      fake.dispatch("message", { data: tagFrame(channel, payload) });

      expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([1, 2, 3, 250, 0]);
    });

    it(`round-trips an ArrayBuffer frame on ${channel}`, () => {
      const fake = new FakeSocket();
      const mux = new SocketMultiplexer(fake);
      const spy = onMessage(mux.channel(channel));
      // tagFrame yields a Uint8Array; deliver its underlying ArrayBuffer to
      // exercise the ArrayBuffer normalization branch end-to-end.
      const tagged = tagFrame(channel, new Uint8Array([7, 8, 9]));
      const asBuffer = (tagged as Uint8Array).slice().buffer;

      fake.dispatch("message", { data: asBuffer });

      expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([7, 8, 9]);
    });
  }
});

describe("outbound send — tags for its channel", () => {
  it("tags a string frame with the channel marker", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);

    mux.channel(BIDI_S2C_CHANNEL).send("payload");

    expect(fake.sent).toEqual([tagFrame(BIDI_S2C_CHANNEL, "payload")]);
    expect(fake.sent[0]).toBe(`${BIDI_S2C_CHANNEL}payload`);
  });

  it("tags a binary frame with the channel byte", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);

    mux.channel(BIDI_C2S_CHANNEL).send(new Uint8Array([42, 43]));

    expect(bytesOf(fake.sent[0])).toEqual([
      BIDI_C2S_CHANNEL.charCodeAt(0),
      42,
      43,
    ]);
  });
});

describe("lifecycle events — fan out to BOTH channels", () => {
  for (const type of ["open", "close", "error"] as const) {
    it(`fans out '${type}' to both channels' listeners`, () => {
      const fake = new FakeSocket();
      const mux = new SocketMultiplexer(fake);
      const c2s = vi.fn();
      const s2c = vi.fn();
      mux.channel(BIDI_C2S_CHANNEL).addEventListener(type, c2s);
      mux.channel(BIDI_S2C_CHANNEL).addEventListener(type, s2c);

      fake.dispatch(type, {});

      expect(c2s).toHaveBeenCalledTimes(1);
      expect(s2c).toHaveBeenCalledTimes(1);
    });
  }
});

describe("removeEventListener and dispose", () => {
  it("stops delivery after removeEventListener", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const channel = mux.channel(BIDI_C2S_CHANNEL);
    const spy = vi.fn();
    channel.addEventListener("message", spy);

    channel.removeEventListener("message", spy);
    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "x") });

    expect(spy).not.toHaveBeenCalled();
  });

  it("dispose detaches the single real listener of each type", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    mux.dispose();
    for (const type of ["message", "open", "close", "error"] as const) {
      expect(fake.listenerCount(type)).toBe(0);
    }
  });

  it("dispose is idempotent", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    mux.dispose();
    expect(() => mux.dispose()).not.toThrow();
    expect(fake.listenerCount("message")).toBe(0);
  });
});

describe("malformed inbound frames fail loudly", () => {
  it("routes an unknown-tag frame to onError, not to any channel", () => {
    const fake = new FakeSocket();
    const onError = vi.fn();
    const mux = new SocketMultiplexer(fake, { onError });
    const c2s = onMessage(mux.channel(BIDI_C2S_CHANNEL));
    const s2c = onMessage(mux.channel(BIDI_S2C_CHANNEL));

    fake.dispatch("message", { data: "?no-tag-here" });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(c2s).not.toHaveBeenCalled();
    expect(s2c).not.toHaveBeenCalled();
  });

  it("surfaces a malformed frame out-of-band (not synchronously) when no onError is set", () => {
    const fake = new FakeSocket();
    // Capture the deferred callback WITHOUT calling through — otherwise the
    // real microtask fires the intentional out-of-band throw after the test,
    // surfacing as an "unhandled error" in the runner. We assert it throws
    // explicitly below (line ~273) instead.
    const queued = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation(() => {});
    new SocketMultiplexer(fake);

    // A synchronous throw out of the real 'message' listener would, on a node
    // `ws` EventEmitter, become an uncaughtException → process crash. The mux
    // must NOT do that anymore; the error is deferred to a microtask instead.
    expect(() => fake.dispatch("message", { data: "?bad" })).not.toThrow();

    expect(queued).toHaveBeenCalledTimes(1);
    // The deferred callback rethrows the decode error (stays fail-loud).
    const deferred = queued.mock.calls[0][0];
    expect(deferred).toThrow(UnknownChannelTagError);

    queued.mockRestore();
  });

  it("surfaces a Blob/unsupported frame as UnsupportedInboundDataError", () => {
    const fake = new FakeSocket();
    const onError = vi.fn();
    new SocketMultiplexer(fake, { onError });
    // Simulate a socket that ignored binaryType='arraybuffer' and delivered
    // a non-decodable shape (stand-in for a Blob / fragment array).
    fake.dispatch("message", { data: { not: "a frame" } });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(UnsupportedInboundDataError);
  });
});

describe("facade proxies the underlying socket", () => {
  it("readyState reflects the underlying socket", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const channel = mux.channel(BIDI_C2S_CHANNEL);

    fake.readyState = 3; // CLOSED
    expect(channel.readyState).toBe(3);
    fake.readyState = 1; // OPEN
    expect(channel.readyState).toBe(1);
  });

  it("close() tears down the shared underlying socket", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);

    mux.channel(BIDI_S2C_CHANNEL).close(4001, "bye");

    expect(fake.closeCalls).toEqual([{ code: 4001, reason: "bye" }]);
  });
});

describe("once semantics", () => {
  it("fires a { once: true } message listener exactly once then auto-detaches", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const spy = vi.fn();
    mux
      .channel(BIDI_C2S_CHANNEL)
      .addEventListener("message", spy, { once: true });

    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "a") });
    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "b") });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ data: "a" });
  });

  it("a once lifecycle listener on one channel fires once and leaves the other channel untouched", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const onceA = vi.fn();
    const persistentB = vi.fn();
    mux.channel(BIDI_C2S_CHANNEL).addEventListener("open", onceA, {
      once: true,
    });
    mux.channel(BIDI_S2C_CHANNEL).addEventListener("open", persistentB);

    fake.dispatch("open", {});
    fake.dispatch("open", {});

    // Channel A's once-listener detached after the first fan-out; channel B's
    // ordinary listener still saw both — the once-removal is per-channel.
    expect(onceA).toHaveBeenCalledTimes(1);
    expect(persistentB).toHaveBeenCalledTimes(2);
  });

  it("removeEventListener removes a once listener by its original identity before it fires", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const channel = mux.channel(BIDI_C2S_CHANNEL);
    const spy = vi.fn();
    channel.addEventListener("message", spy, { once: true });

    channel.removeEventListener("message", spy);
    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "x") });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("throwing-listener isolation (DOM EventTarget semantics)", () => {
  it("a throwing message listener does not starve its siblings; error reaches onError", () => {
    const fake = new FakeSocket();
    const onError = vi.fn();
    const mux = new SocketMultiplexer(fake, { onError });
    const boom = new Error("boom");
    const thrower = vi.fn(() => {
      throw boom;
    });
    const sibling = vi.fn();
    const channel = mux.channel(BIDI_C2S_CHANNEL);
    channel.addEventListener("message", thrower);
    channel.addEventListener("message", sibling);

    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "x") });

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(boom);
  });

  it("a throwing lifecycle listener on channel A does not starve channel B's listener", () => {
    const fake = new FakeSocket();
    const onError = vi.fn();
    const mux = new SocketMultiplexer(fake, { onError });
    const boom = new Error("boom");
    const thrower = vi.fn(() => {
      throw boom;
    });
    const other = vi.fn();
    mux.channel(BIDI_C2S_CHANNEL).addEventListener("close", thrower);
    mux.channel(BIDI_S2C_CHANNEL).addEventListener("close", other);

    fake.dispatch("close", {});

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(boom);
  });
});

describe("inbound normalization — view / shared-buffer branches", () => {
  it("round-trips a SharedArrayBuffer frame", () => {
    if (typeof SharedArrayBuffer === "undefined") return; // runtime lacks it
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const spy = onMessage(mux.channel(BIDI_C2S_CHANNEL));
    const tagged = tagFrame(BIDI_C2S_CHANNEL, new Uint8Array([5, 6, 7]));
    const sab = new SharedArrayBuffer((tagged as Uint8Array).length);
    new Uint8Array(sab).set(tagged as Uint8Array);

    fake.dispatch("message", { data: sab });

    expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([5, 6, 7]);
  });

  it("round-trips a DataView frame (generic ArrayBuffer.isView)", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const spy = onMessage(mux.channel(BIDI_S2C_CHANNEL));
    const tagged = tagFrame(BIDI_S2C_CHANNEL, new Uint8Array([11, 12]));
    const view = new DataView((tagged as Uint8Array).slice().buffer);

    fake.dispatch("message", { data: view });

    expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([11, 12]);
  });

  it("round-trips an Int8Array frame (generic ArrayBuffer.isView)", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const spy = onMessage(mux.channel(BIDI_C2S_CHANNEL));
    const tagged = tagFrame(BIDI_C2S_CHANNEL, new Uint8Array([100, 101]));
    const i8 = new Int8Array((tagged as Uint8Array).slice().buffer);

    fake.dispatch("message", { data: i8 });

    expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([100, 101]);
  });

  it("de-tags ONLY the logical window of a byteOffset>0 subview (Phase-1 bug class)", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const spy = onMessage(mux.channel(BIDI_S2C_CHANNEL));
    const tagged = tagFrame(BIDI_S2C_CHANNEL, new Uint8Array([30, 40, 50]));
    const taggedLen = (tagged as Uint8Array).length;

    // Place the tagged frame at a NON-zero offset inside a padded backing
    // buffer, surrounded by 0xFF garbage that must NEVER bleed into the result.
    const PAD = 2;
    const backing = new Uint8Array(PAD + taggedLen + PAD).fill(0xff);
    backing.set(tagged as Uint8Array, PAD);
    // A DataView subview over exactly the logical window (byteOffset = PAD).
    const subview = new DataView(backing.buffer, PAD, taggedLen);

    fake.dispatch("message", { data: subview });

    // If the byteOffset were ignored, the result would start with 0xFF padding.
    expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([30, 40, 50]);
  });

  it("de-tags a byteOffset>0 Uint8Array subview to only its window", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    const spy = onMessage(mux.channel(BIDI_C2S_CHANNEL));
    const tagged = tagFrame(BIDI_C2S_CHANNEL, new Uint8Array([1, 2, 3, 4]));
    const taggedLen = (tagged as Uint8Array).length;
    const PAD = 3;
    const backing = new Uint8Array(PAD + taggedLen + PAD).fill(0xff);
    backing.set(tagged as Uint8Array, PAD);
    const subview = new Uint8Array(backing.buffer, PAD, taggedLen);

    fake.dispatch("message", { data: subview });

    expect(bytesOf(spy.mock.calls[0][0].data)).toEqual([1, 2, 3, 4]);
  });
});

describe("inert after dispose", () => {
  it("channel().addEventListener after dispose() delivers nothing", () => {
    const fake = new FakeSocket();
    const mux = new SocketMultiplexer(fake);
    mux.dispose();

    const spy = vi.fn();
    mux.channel(BIDI_C2S_CHANNEL).addEventListener("message", spy);
    // The real listeners are detached; a stray delivery routes nowhere.
    fake.dispatch("message", { data: tagFrame(BIDI_C2S_CHANNEL, "x") });

    expect(spy).not.toHaveBeenCalled();
  });
});
