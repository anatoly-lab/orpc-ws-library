// Public surface of @orpc-ws/shared.
//
// Workspace-internal package: defines the seam interfaces every other
// package depends on (Logger, Clock, Rng) plus their default impls.
// See CLAUDE.md "Configurable, not hardcoded" and "Tests from day 0 —
// non-negotiable" for why these are interfaces rather than concretions.

export type { Logger, NestShape, PinoShape } from "./logger.js";
export {
  consoleLogger,
  fromNestShape,
  fromPinoShape,
  noopLogger,
} from "./logger.js";

export type { Clock, TimerHandle } from "./clock.js";
export { systemClock } from "./clock.js";

export type { Rng } from "./rng.js";
export { defaultRng } from "./rng.js";

// Heartbeat wire types + library-reserved procedure path. Shared by the
// server core (stealth procedure publisher + system-router) and the client
// core (heartbeat subscriber). Phase 3 moved these from the client package
// so the server can import without introducing a client→server dependency.
export type { HeartbeatEvent } from "./heartbeat.js";
export { HEARTBEAT_NAMESPACE, HEARTBEAT_PATH } from "./heartbeat.js";

// Bidirectional-RPC channel codec: tags/untags one shared socket's frames
// with a client→server / server→client marker so a multiplexer can route
// them. Pure, framework-free wire format shared by both cores.
export type { BidiChannel, WireFrame } from "./channel.js";
export {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  tagFrame,
  untagFrame,
  UnknownChannelTagError,
} from "./channel.js";

// Bidi channel multiplexer (Phase 2): lays the two logical RPC channels over
// ONE underlying socket, consuming the channel codec above. Pure,
// socket-agnostic — no ORPC, no framework. Both cores wrap their real socket
// (partysocket on the client, `ws` on the server) in a `SocketMultiplexer`
// and hand each channel's `ChanneledSocket` to an ORPC adapter.
export type {
  AddEventListenerOptions,
  SocketEvent,
  SocketEventType,
  SocketListener,
  UnderlyingSocket,
} from "./socket.js";
export { SocketMultiplexer } from "./socket-multiplexer.js";
export type { SocketMultiplexerOptions } from "./socket-multiplexer.js";
export { ChanneledSocket } from "./channeled-socket.js";
export { UnsupportedInboundDataError } from "./normalize-inbound.js";
