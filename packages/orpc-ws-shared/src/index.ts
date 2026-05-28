// Public surface of @repo/orpc-ws-shared.
//
// Workspace-internal package: defines the seam interfaces every other
// package depends on (Logger, Clock, Rng) plus their default impls.
// See CLAUDE.md "Configurable, not hardcoded" and "Tests from day 0 —
// non-negotiable" for why these are interfaces rather than concretions.

export type { Logger } from "./logger.js";
export { noopLogger } from "./logger.js";

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
