// Inbound-frame normalization + the binary-delivery policy that backs it.
//
// A real socket can hand the multiplexer's `'message'` listener several
// shapes in `event.data` depending on the runtime and the socket's
// `binaryType`:
//   - `string`                              — text frame
//   - `ArrayBuffer`                         — binaryType 'arraybuffer'
//   - `Uint8Array` (incl. node `Buffer`)    — node `ws` default 'nodebuffer'
//   - other `ArrayBufferView` (DataView…)   — rare, but byte-addressable
//   - `Blob`                                — browser binaryType 'blob'
//   - `Array<Buffer>`                       — node `ws` binaryType 'fragments'
//
// The codec in `channel.ts` reads the leading tag unit SYNCHRONOUSLY. Of the
// shapes above, only `Blob` and the fragment `Array` cannot be read
// synchronously — a `Blob`'s `.arrayBuffer()` is async. Supporting them
// would force a per-socket async queue to preserve per-channel frame
// ORDERING (an async Blob frame must not be overtaken by a later sync string
// frame). Rather than carry that complexity for a shape we can DESIGN AWAY,
// the multiplexer sets `binaryType = 'arraybuffer'` on the underlying socket
// at construction, which makes binary frames arrive as `ArrayBuffer`. If a
// `Blob`/`Array` still reaches us (a socket that ignored the setter), we
// THROW a clear error instead of silently dropping or mis-ordering — failing
// loud is the only safe option once ordering can no longer be guaranteed.

import type { WireFrame } from "./channel.js";

/**
 * Thrown when an inbound frame is not a synchronously-decodable
 * {@link WireFrame} (a `Blob`, a fragment `Array`, `null`, …). See the
 * module header: the multiplexer forces `binaryType='arraybuffer'`, so this
 * means that request was not honored by the underlying socket.
 */
export class UnsupportedInboundDataError extends Error {
  override readonly name = "UnsupportedInboundDataError";

  constructor(readonly receivedKind: string) {
    super(
      `Inbound socket frame is not a synchronously-decodable WireFrame ` +
        `(got: ${receivedKind}). The multiplexer sets ` +
        `binaryType='arraybuffer' to force ArrayBuffer frames; a Blob or ` +
        `fragment array means the underlying socket did not honor that.`,
    );
  }
}

// Best-effort human-readable tag for the error message — the constructor
// name for objects ("Blob", "Array"), the primitive type otherwise.
function describeKind(data: unknown): string {
  if (data === null) return "null";
  if (typeof data === "object") {
    return (data as { constructor?: { name?: string } }).constructor?.name ??
      "object";
  }
  return typeof data;
}

/**
 * Normalize a raw `event.data` to a {@link WireFrame} the codec can read,
 * SYNCHRONOUSLY. Binary views are re-viewed (zero-copy) as `Uint8Array` so
 * the byte-level codec has one consistent binary shape.
 *
 * @throws {UnsupportedInboundDataError} for a `Blob`, fragment `Array`, or
 *   any other non-decodable value — never silently swallowed.
 */
export function normalizeInboundData(data: unknown): WireFrame {
  if (typeof data === "string") return data;

  // `Uint8Array` first: node `Buffer` is a `Uint8Array` subclass, so this
  // covers the node `ws` default delivery with no copy.
  if (data instanceof Uint8Array) return data;

  if (data instanceof ArrayBuffer) return data;

  // SharedArrayBuffer is part of `ArrayBufferLike` (a valid WireFrame) but
  // isn't an `ArrayBuffer`; guard its presence since some runtimes omit it.
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    data instanceof SharedArrayBuffer
  ) {
    return data;
  }

  // Other views (DataView, Int8Array, …): expose their exact byte window as
  // a Uint8Array view (honors byteOffset/byteLength, zero-copy).
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // Blob, Array (fragments), null, number, … — unrepresentable synchronously.
  throw new UnsupportedInboundDataError(describeKind(data));
}
