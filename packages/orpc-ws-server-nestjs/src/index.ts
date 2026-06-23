// Public surface of `@orpc-ws/server-nestjs`.
//
// Two consumer-facing concepts:
//   1. `OrpcWsModule` — the dynamic module (`forRoot` / `forRootAsync`).
//      Primary documented entry; see README for the `forRootAsync` recipe.
//   2. `OrpcWsService` — the injectable wrapper around the core. Use it
//      to call `closeUser` from controllers / other services, or grab
//      the raw core via `getServer()`.
//
// `ORPC_WS_OPTIONS` is re-exported for advanced patterns (consumers
// writing custom providers that need to read the resolved options).
//
// Core-side types are re-exported to keep consumers on a single import
// surface. They don't need to know `@orpc-ws/server` exists as a
// separate package unless they want the framework-free server directly.

export { OrpcWsModule } from "./orpc-ws.module.js";
export { OrpcWsService } from "./orpc-ws.service.js";
export { ORPC_WS_OPTIONS } from "./orpc-ws.module-builder.js";
export type { OrpcWsModuleOptions } from "./orpc-ws.options.js";

// Re-exports from the core — most consumers will reach for these:
export type {
  VerifyClient,
  VerifyClientContext,
  VerifyClientResult,
  OrpcWsServerOptions,
  OrpcWsServerHooks,
  ConnectionConfig,
  HeartbeatConfig,
  HeartbeatEvent,
  UploadHttpConfig,
  BeforeUploadContext,
  BeforeUploadHook,
  BeforeUploadResult,
  HttpUploadHandler,
  OrpcWsInterceptors,
  OrpcWsRootInterceptors,
} from "@orpc-ws/server";
export {
  DEFAULT_UPLOAD_HTTP_CONFIG,
  DEFAULT_BEFORE_UPLOAD_REJECT_CODE,
  DEFAULT_BEFORE_UPLOAD_REJECT_REASON,
  extractBearerToken,
} from "@orpc-ws/server";

// Logger seam + bridges. `fromNestShape` is the nestjs-adapter-only bridge;
// universal `consoleLogger` and Node `fromPinoShape` come along too so the
// adapter exposes the full logger surface to consumers.
export type { Logger, NestShape, PinoShape } from "@orpc-ws/shared";
export {
  noopLogger,
  consoleLogger,
  fromNestShape,
  fromPinoShape,
} from "@orpc-ws/shared";
