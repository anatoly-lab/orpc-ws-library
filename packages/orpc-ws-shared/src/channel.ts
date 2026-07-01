// Bidirectional-RPC channel codec.
//
// One WebSocket carries two logical RPC channels — client→server (`c2s`)
// and server→client (`s2c`). Both directions share the same socket, so
// every frame is tagged at its leading unit with a channel marker; a later
// multiplexing phase reads that marker to route the frame to the correct
// ORPC peer. This module is the PURE tagging/untagging codec for that
// scheme — no socket, no ORPC, no framework. It lives in @orpc-ws/shared so
// both cores agree on one wire format and cannot drift.

/**
 * Wire shape of a single transport frame.
 *
 * Defined LOCALLY (no `@orpc/*` import) to keep @orpc-ws/shared
 * dependency-free, but it MUST stay in lockstep with
 * `@orpc/standard-server-peer`'s `EncodedMessage`
 * (`string | ArrayBufferLike | Uint8Array`, as of `@orpc/*` 1.14.6). If a
 * future ORPC release widens or narrows that type, update this alias to
 * match — the codec below routes on exactly these three shapes.
 */
export type WireFrame = string | ArrayBufferLike | Uint8Array;

/**
 * Channel tag for client→server RPC frames.
 *
 * The constant value IS the tag's string unit (a single ASCII char). The
 * binary tag byte is DERIVED from this char's code point (see
 * `channelByte`), so the two representations share one source of truth and
 * cannot drift. ASCII (`< 0x80`) guarantees the byte form is exactly one
 * unit.
 */
export const BIDI_C2S_CHANNEL = ">" as const;

/** Channel tag for server→client RPC frames. See {@link BIDI_C2S_CHANNEL}. */
export const BIDI_S2C_CHANNEL = "<" as const;

/** The two valid channel tags. A frame must carry exactly one of these. */
export type BidiChannel = typeof BIDI_C2S_CHANNEL | typeof BIDI_S2C_CHANNEL;

// Single source of truth for the valid channels. Order is irrelevant; the
// reverse lookups below scan this table for both the string and byte forms,
// so adding a third channel here would extend both paths at once.
const CHANNELS: readonly BidiChannel[] = [BIDI_C2S_CHANNEL, BIDI_S2C_CHANNEL];

/**
 * The binary tag byte for a channel, derived from its string char's code
 * point. Centralizing the char→byte derivation here is what prevents the
 * string and binary representations from drifting apart.
 */
function channelByte(channel: BidiChannel): number {
  return channel.charCodeAt(0);
}

function channelFromChar(char: string | undefined): BidiChannel | undefined {
  return CHANNELS.find((c) => c === char);
}

function channelFromByte(byte: number | undefined): BidiChannel | undefined {
  return CHANNELS.find((c) => channelByte(c) === byte);
}

/**
 * Thrown when {@link untagFrame} sees a leading unit that is missing or not
 * a known channel tag. A frame with no recognizable tag is a protocol
 * violation: routing it blindly would send it to the wrong peer, so the
 * codec fails loudly rather than guessing.
 */
export class UnknownChannelTagError extends Error {
  override readonly name = "UnknownChannelTagError";

  constructor(readonly tag: string | number | undefined) {
    super(`Frame has no recognizable bidi channel tag (saw: ${String(tag)})`);
  }
}

// Prepend one byte to a byte sequence WITHOUT mutating the input. Allocates
// a fresh `Uint8Array`; `set` copies the source's logical range, so a view
// with a non-zero byteOffset is handled correctly.
function prependByte(bytes: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = byte;
  out.set(bytes, 1);
  return out;
}

// Normalize any binary WireFrame (a `Uint8Array` view or a raw
// `ArrayBufferLike`) to a `Uint8Array` for byte-level work.
function asBytes(frame: ArrayBufferLike | Uint8Array): Uint8Array {
  return frame instanceof Uint8Array ? frame : new Uint8Array(frame);
}

/**
 * Prepend a channel's tag to a frame.
 *
 * - `string` → returns `tag + frame`.
 * - `Uint8Array` → returns a NEW `Uint8Array` (length + 1) with the tag byte
 *   prepended; the input is never mutated.
 * - `ArrayBufferLike` → viewed as bytes, tag byte prepended, returned as a
 *   `Uint8Array`. The binary path ALWAYS yields a `Uint8Array` (one
 *   consistent output type for both binary inputs).
 */
export function tagFrame(channel: BidiChannel, frame: WireFrame): WireFrame {
  if (typeof frame === "string") {
    return channel + frame;
  }
  return prependByte(asBytes(frame), channelByte(channel));
}

/**
 * Read the leading channel tag and return the channel plus the de-tagged
 * remainder.
 *
 * - `string` → `frame.slice(1)` remainder (a COPY).
 * - binary (`Uint8Array` / `ArrayBufferLike`) → `subarray(1)` remainder,
 *   ALWAYS returned as a `Uint8Array` (a zero-copy view onto the input).
 *
 * WARNING — view aliasing (binary path only): the returned binary frame is a
 * `subarray(1)` that ALIASES the caller's backing buffer; it is NOT a copy
 * (note the asymmetry with the string path, which copies via `.slice(1)`).
 * This is deliberate: framing is on the hot path, so we avoid an allocation +
 * memcpy per inbound frame. The cost of that choice is an ownership rule — the
 * returned binary frame MUST be treated as read-only. Mutating its bytes,
 * resizing, or detaching its `ArrayBuffer` (e.g. via a transfer/`postMessage`)
 * corrupts the caller's memory, since the de-tagged view and the original
 * frame share one buffer. The downstream multiplexer phase only reads these
 * bytes, so the no-mutate rule holds for that consumer.
 *
 * @throws {UnknownChannelTagError} if the leading unit is missing (empty
 *   frame) or is not a known channel tag.
 */
export function untagFrame(raw: WireFrame): {
  channel: BidiChannel;
  frame: WireFrame;
} {
  if (typeof raw === "string") {
    const channel = channelFromChar(raw[0]);
    if (channel === undefined) {
      throw new UnknownChannelTagError(raw[0]);
    }
    return { channel, frame: raw.slice(1) };
  }

  const bytes = asBytes(raw);
  const channel = channelFromByte(bytes[0]);
  if (channel === undefined) {
    throw new UnknownChannelTagError(bytes[0]);
  }
  return { channel, frame: bytes.subarray(1) };
}
