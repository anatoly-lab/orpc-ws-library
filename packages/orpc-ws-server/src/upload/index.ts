// Barrel for the upload HTTP transport.
//
// Re-exports the config + handler + Bearer extractor so consumers / the
// NestJS adapter can reach them through the package root in `index.ts`.

export type {
  UploadHttpConfig,
  BeforeUploadContext,
  BeforeUploadHook,
  BeforeUploadResult,
} from "./http-config.js";
export {
  DEFAULT_UPLOAD_HTTP_CONFIG,
  DEFAULT_BEFORE_UPLOAD_REJECT_CODE,
  DEFAULT_BEFORE_UPLOAD_REJECT_REASON,
} from "./http-config.js";
export type { HttpUploadHandler } from "./http-handler.js";
export { createHttpUploadHandler } from "./http-handler.js";
export { extractBearerToken } from "./http-verify.js";
