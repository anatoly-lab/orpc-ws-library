import { describe, expect, it } from "vitest";

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type BidiChannel,
  tagFrame,
  untagFrame,
  UnknownChannelTagError,
  type WireFrame,
} from "../index.js";

const CHANNELS: readonly BidiChannel[] = [BIDI_C2S_CHANNEL, BIDI_S2C_CHANNEL];

// Compare two binary WireFrames by their byte contents (the codec may return
// a fresh Uint8Array or a subarray view; we only care about logical bytes).
function bytesOf(frame: WireFrame): number[] {
  if (typeof frame === "string") {
    throw new Error("expected a binary frame");
  }
  return Array.from(
    frame instanceof Uint8Array ? frame : new Uint8Array(frame),
  );
}

describe("channel codec round-trip", () => {
  for (const channel of CHANNELS) {
    it(`recovers a string frame for channel ${channel}`, () => {
      const payload = '{"hello":"world"}';
      const { channel: got, frame } = untagFrame(tagFrame(channel, payload));
      expect(got).toBe(channel);
      expect(frame).toBe(payload);
    });

    it(`recovers a Uint8Array frame for channel ${channel}`, () => {
      const payload = new Uint8Array([1, 2, 3, 250, 0, 99]);
      const { channel: got, frame } = untagFrame(tagFrame(channel, payload));
      expect(got).toBe(channel);
      expect(bytesOf(frame)).toEqual([1, 2, 3, 250, 0, 99]);
    });

    it(`recovers an ArrayBuffer frame for channel ${channel}`, () => {
      const buffer = new Uint8Array([7, 8, 9]).buffer;
      const { channel: got, frame } = untagFrame(tagFrame(channel, buffer));
      expect(got).toBe(channel);
      expect(bytesOf(frame)).toEqual([7, 8, 9]);
    });

    // Regression guard: tagFrame/untagFrame must honor a view's byteOffset and
    // length, NOT the whole backing buffer. A view that starts mid-buffer
    // (here, 2 bytes in, with 2 trailing neighbour bytes) must round-trip to
    // ONLY its logical window — no neighbour bytes leaked, exact length. This
    // pins the behavior against a future "optimization" that reads the raw
    // ArrayBuffer and ignores byteOffset.
    it(`honors a sub-window view's byteOffset for channel ${channel}`, () => {
      const payloadBytes = [11, 22, 33, 44];
      const backing = new Uint8Array([0, 0, ...payloadBytes, 0, 0]);
      const view = new Uint8Array(backing.buffer, 2, payloadBytes.length);
      const { channel: got, frame } = untagFrame(tagFrame(channel, view));
      expect(got).toBe(channel);
      expect(bytesOf(frame)).toEqual(payloadBytes);
    });
  }
});

describe("channel isolation", () => {
  it("a c2s-tagged frame never untags to s2c", () => {
    expect(untagFrame(tagFrame(BIDI_C2S_CHANNEL, "x")).channel).toBe(
      BIDI_C2S_CHANNEL,
    );
    expect(untagFrame(tagFrame(BIDI_C2S_CHANNEL, new Uint8Array([1]))).channel)
      .toBe(BIDI_C2S_CHANNEL);
  });

  it("an s2c-tagged frame never untags to c2s", () => {
    expect(untagFrame(tagFrame(BIDI_S2C_CHANNEL, "x")).channel).toBe(
      BIDI_S2C_CHANNEL,
    );
    expect(untagFrame(tagFrame(BIDI_S2C_CHANNEL, new Uint8Array([1]))).channel)
      .toBe(BIDI_S2C_CHANNEL);
  });
});

describe("tagFrame immutability", () => {
  it("does not mutate its Uint8Array input", () => {
    const input = new Uint8Array([10, 20, 30]);
    const snapshot = Array.from(input);
    const tagged = tagFrame(BIDI_C2S_CHANNEL, input);
    expect(Array.from(input)).toEqual(snapshot);
    // The output is a fresh, longer buffer, not the same reference.
    expect(tagged).not.toBe(input);
    expect(bytesOf(tagged).length).toBe(input.length + 1);
  });

  it("does not mutate its ArrayBuffer input", () => {
    const buffer = new Uint8Array([40, 50, 60]).buffer;
    const snapshot = Array.from(new Uint8Array(buffer));
    const tagged = tagFrame(BIDI_C2S_CHANNEL, buffer);
    expect(Array.from(new Uint8Array(buffer))).toEqual(snapshot);
    // The output is a fresh, longer buffer carrying the tag byte.
    expect(bytesOf(tagged).length).toBe(snapshot.length + 1);
  });
});

describe("untagFrame on a bad tag", () => {
  it("throws on an empty string", () => {
    expect(() => untagFrame("")).toThrow(UnknownChannelTagError);
  });

  it("throws on an unknown string tag", () => {
    expect(() => untagFrame("?payload")).toThrow(UnknownChannelTagError);
  });

  it("throws on an empty binary frame", () => {
    expect(() => untagFrame(new Uint8Array([]))).toThrow(
      UnknownChannelTagError,
    );
  });

  it("throws on an empty ArrayBuffer", () => {
    expect(() => untagFrame(new ArrayBuffer(0))).toThrow(
      UnknownChannelTagError,
    );
  });

  it("throws on an unknown binary tag", () => {
    expect(() => untagFrame(new Uint8Array([0, 1, 2]))).toThrow(
      UnknownChannelTagError,
    );
  });
});

describe("single-unit tag invariants", () => {
  for (const channel of CHANNELS) {
    it(`string tag for ${channel} is exactly 1 char`, () => {
      expect(channel.length).toBe(1);
      const tagged = tagFrame(channel, "abc");
      expect(typeof tagged).toBe("string");
      expect((tagged as string).length).toBe("abc".length + 1);
    });

    it(`binary tag for ${channel} is exactly 1 byte`, () => {
      const tagged = tagFrame(channel, new Uint8Array([1, 2]));
      expect(bytesOf(tagged).length).toBe(2 + 1);
    });
  }

  // Pin the exact on-the-wire tag bytes. These are the ASCII code points of
  // the channel chars ('>' = 62, '<' = 60); locking them here makes any
  // accidental change to the wire format fail loudly rather than silently
  // breaking interop with an already-deployed peer.
  it("pins the c2s binary tag byte to 62 ('>')", () => {
    const tagged = tagFrame(BIDI_C2S_CHANNEL, new Uint8Array([1, 2]));
    expect(bytesOf(tagged)[0]).toBe(62);
  });

  it("pins the s2c binary tag byte to 60 ('<')", () => {
    const tagged = tagFrame(BIDI_S2C_CHANNEL, new Uint8Array([1, 2]));
    expect(bytesOf(tagged)[0]).toBe(60);
  });
});
