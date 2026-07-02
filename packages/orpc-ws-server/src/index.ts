// Public surface of @orpc-ws/server — the re-export barrel.
//
// Re-exports the user-facing types (`VerifyClient`, `VerifyClientResult`,
// `ConnectionConfig`, etc.) so consumers don't dig into sub-paths. The
// `OrpcWsServer` class itself — the Phase 3 composition root — lives in
// `orpc-ws-server.ts`; the two public mode factories live in
// `composition/factories.ts`.

// ----- The class + its internal options -----
export { OrpcWsServer } from "./orpc-ws-server.js";
export type {
  OrpcWsServerOptions,
  OrpcWsServerHooks,
  OrpcWsInterceptors,
  OrpcWsRootInterceptors,
} from "./orpc-ws-server.js";

// ----- Public re-exports -----

export type {
  ConnectionConfig,
} from "./config/connection-config.js";
export { DEFAULT_CONNECTION_CONFIG } from "./config/connection-config.js";

export type {
  HeartbeatConfig,
} from "./config/heartbeat-config.js";
export { DEFAULT_HEARTBEAT_CONFIG } from "./config/heartbeat-config.js";

export type {
  VerifyClient,
  VerifyClientContext,
  VerifyClientResult,
} from "./lifecycle/verify-client-orchestrator.js";
export { DEFAULT_VERIFY_TIMEOUT_MS } from "./lifecycle/verify-client-orchestrator.js";

export type { HeartbeatEvent } from "@orpc-ws/shared";

// ----- AUTHLESS mode: factories, option/hook shapes, and the absent-user type -----
export {
  createOrpcWsServer,
  createAuthlessOrpcWsServer,
  type AuthlessOrpcWsServer,
} from "./composition/factories.js";
export type {
  AuthenticatedOrpcWsServerOptions,
  AuthlessOrpcWsServerOptions,
  AuthenticatedHooks,
  AuthlessHooks,
} from "./composition/server-options.js";
export type { NoAuth } from "./state/no-auth.js";
/**
 * The single registry key every authless connection shares in the DEFAULT
 * single-connection mode. Exported so a consumer can push to the one live
 * authless GUI OUT-OF-BAND — i.e. from OUTSIDE the connection lifecycle (e.g.
 * an MCP tool handler reacting to an external command) — via
 * `server.getConnection(SINGLE_AUTHLESS_KEY)?.client.<proc>(...)`.
 *
 * Only meaningful when authless is in its default single-connection mode
 * (NOT `allowConcurrentConnections: true`, where each connection gets its own
 * unique key). When the push originates INSIDE the connection lifecycle,
 * prefer capturing `conn` from the `onConnected` hook and holding
 * `conn.client` — that's cleaner and doesn't depend on the constant.
 */
export { SINGLE_AUTHLESS_KEY } from "./state/authless-key.js";

// Per-connection handle (`conn`) types — the object the lifecycle hooks
// receive and `getConnection` returns. `client` is present only when bidi is on.
export type {
  ServerConnection,
  AuthlessConnection,
} from "./state/connection.js";

// The ORPC contract-router types that drive the bidi (`TClientContract`)
// generic. Re-exported so adapters and consumers can name the third generic
// (and the resulting server→client caller) WITHOUT a direct `@orpc/contract`
// import — one import surface, the same reason we re-export the conn types
// above. `AnyContractRouter` is the generic CONSTRAINT; `ContractRouterClient`
// is the typed caller shape `conn.client` resolves to.
export type {
  AnyContractRouter,
  ContractRouterClient,
} from "@orpc/contract";

// Logger seam + universal/Node-friendly bridges, re-exported so consumers
// stay on one import surface. `fromNestShape` lives only in the nestjs
// adapter package — server core is framework-free.
export type { Logger, PinoShape } from "@orpc-ws/shared";
export {
  noopLogger,
  consoleLogger,
  fromPinoShape,
} from "@orpc-ws/shared";

export type {
  UploadHttpConfig,
  BeforeUploadContext,
  BeforeUploadHook,
  BeforeUploadResult,
} from "./upload/http-config.js";
export {
  DEFAULT_UPLOAD_HTTP_CONFIG,
  DEFAULT_UPLOAD_BODY_LIMIT_BYTES,
  DEFAULT_BEFORE_UPLOAD_REJECT_CODE,
  DEFAULT_BEFORE_UPLOAD_REJECT_REASON,
} from "./upload/http-config.js";
export type { HttpUploadHandler } from "./upload/http-handler.js";
export { extractBearerToken } from "./upload/http-verify.js";
