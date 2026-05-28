// Public upload-config types for the client composition root.
//
// Phase 6. The client's `createOrpcWsClient` accepts an optional
// `uploads` config; when present, the returned `OrpcWsClient` exposes
// the `upload(file, opts)` method bound to the configured strategy.
//
// CLAUDE.md "Uploads" pins the v1 scope: `orpc-http` ships; `presigned-url`
// is declared in the type union but throws "not implemented" at runtime.
// Adding the presigned-url implementation later is purely additive — no
// public API change.

/**
 * Progress callback payload. Reported in bytes-loaded / bytes-total with
 * a derived `percent` (0-100, integer-rounded).
 *
 * For v1's `orpc-http` strategy: progress reporting is best-effort.
 * ORPC's HTTP `RPCLink` does not surface fetch-stream progress natively;
 * the strategy may only emit `0%` (start) and `100%` (end). Real per-byte
 * progress would require manual XHR + multipart construction — deferred
 * to a future strategy variant.
 */
export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

/**
 * Per-call options for `client.upload(file, opts)`.
 *
 * `procedure` is a string-tuple path into the consumer's contract router
 * (e.g. `["media", "upload"]`). Typed via a generic `Path<TContract>`
 * helper in `strategy.ts`; here the runtime contract is plain
 * `string[]` because the strategy interface is the internal seam.
 */
export interface UploadOptions {
  /** Tuple path into the consumer's contract router. */
  procedure: string[];
  /**
   * Best-effort progress callback. May only fire at start/end depending
   * on the active strategy (see `UploadProgress` jsdoc).
   */
  onProgress?: (p: UploadProgress) => void;
  /** Cancel the upload mid-flight. Propagated to the underlying fetch. */
  signal?: AbortSignal;
  /**
   * Additional fields passed alongside the file to the procedure call.
   * ORPC encodes the whole payload as multipart; the file lands under
   * `file` and these fields land under their own keys.
   *
   * Typed as `Record<string, unknown>` because the field shape depends
   * on the consumer's contract — narrow-typing here would require
   * threading `Path<TContract>` through every strategy.
   */
  meta?: Record<string, unknown>;
}

/**
 * Result of a successful upload.
 *
 * `response` is the raw response payload from the procedure (the
 * consumer's procedure handler's return value, serialised by ORPC).
 * Consumers cast it to their contract's known return type.
 */
export interface UploadResult {
  ok: true;
  response: unknown;
}

/**
 * Config for the `uploads` option on `createOrpcWsClient`.
 *
 * Strategy is a discriminated union; `orpc-http` requires `httpUrl`,
 * `presigned-url` is reserved and currently throws on instantiation.
 */
export type UploadsConfig =
  | {
      strategy: "orpc-http";
      /**
       * Full HTTP URL of the upload endpoint, e.g.
       * `https://api.example.com/upload`. The strategy posts multipart
       * to `${httpUrl}/${procedure.join('/')}`.
       */
      httpUrl: string;
    }
  | {
      strategy: "presigned-url";
      /**
       * Reserved. Throws `Not implemented` at runtime in v1. The shape
       * is held open so future versions can land the presigned-url
       * strategy without breaking consumers who already typed
       * `uploads: { strategy: ... }`.
       */
    };
