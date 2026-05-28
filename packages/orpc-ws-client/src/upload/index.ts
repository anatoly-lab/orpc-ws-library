// Barrel for the upload module.
//
// Re-exports the public surface so the composition root in
// `src/index.ts` and external consumers can reach types + strategies
// through one path.

export type {
  UploadOptions,
  UploadProgress,
  UploadResult,
  UploadsConfig,
} from "./types.js";
export type { UploadStrategy, Path } from "./strategy.js";
export {
  OrpcHttpUploadStrategy,
  PresignedUrlUploadStrategy,
} from "./orpc-http-strategy.js";
