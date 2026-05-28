// HTTP upload transport config.
//
// Phase 6 — opt-in HTTP transport.
//
// The library's primary transport is the WebSocket; this config governs
// the *secondary* HTTP transport, which exists only to carry file uploads
// (ORPC's native multipart support over HTTP). When `enabled: false`
// (the default), no HTTP handler is built and `OrpcWsServer.getHttpHandler()`
// returns `null`.
//
// CLAUDE.md "Library scope" pins this as opt-in: no HTTP transport,
// no HTTP route registration, no Express dependency in the core. The
// NestJS adapter (Phase 5) is the one that mounts the handler onto an
// Express app at `OnApplicationBootstrap`; consumers using the bare core
// from Node mount it themselves via `getHttpHandler()`.

/**
 * Configuration for the HTTP upload transport.
 *
 * Defaults are conservative: disabled, root path `/upload`, no body
 * limit applied. Consumers who enable uploads should consider setting
 * `bodyLimitBytes` — ORPC's HTTP path has no implicit ceiling and
 * unbounded uploads are a vector for resource exhaustion.
 */
export interface UploadHttpConfig {
  /**
   * Master switch. When `false` (default), `OrpcWsServer.getHttpHandler()`
   * returns `null` and no HTTP infrastructure is built.
   */
  enabled: boolean;
  /**
   * Path prefix the HTTP `RPCHandler` matches. The composed router's
   * keys (e.g. `media.upload`) resolve under this prefix; a procedure
   * at `media.upload` is reachable at `${httpPath}/media/upload`.
   *
   * Default `/upload`. Match the NestJS adapter's `httpPath` registration
   * exactly; mismatched paths surface as 404s with no clear diagnostic.
   */
  httpPath: string;
  /**
   * Optional cap on request body size in bytes, applied by ORPC's
   * `BodyLimitPlugin`. When omitted, no cap is applied at the ORPC layer
   * (the consumer's HTTP framework may still apply its own).
   */
  bodyLimitBytes?: number;
}

/**
 * Defaults. Disabled, `/upload`, no body limit. Consumers opt in by
 * setting `enabled: true` in `OrpcWsServerOptions.uploads`.
 */
export const DEFAULT_UPLOAD_HTTP_CONFIG: UploadHttpConfig = {
  enabled: false,
  httpPath: "/upload",
};
