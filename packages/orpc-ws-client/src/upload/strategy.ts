// Upload strategy interface — Phase 6.
//
// CLAUDE.md "Uploads" pins the strategy pattern as the way to keep the
// public `client.upload(file, opts)` signature stable across v1's
// `orpc-http` strategy and a future `presigned-url` strategy. Adding the
// second strategy is purely additive: same `UploadStrategy` shape, same
// public client method.
//
// Why the strategy interface lives at `string[]` rather than `Path<TContract>`:
//   The strategy layer is internal — composition root wraps the typed
//   public API in a `string[]`-typed call. Threading `Path<TContract>`
//   through every strategy would force every implementation to be generic
//   in the consumer's contract, which the actual underlying transports
//   (HTTP fetch, presigned URL POST) don't care about at runtime.
//   Type safety lives at the *public surface* (`OrpcWsClient.upload`),
//   not at the strategy interface.

import type { UploadOptions, UploadResult } from "./types.js";

/**
 * The internal strategy contract. Implementations:
 *   - `OrpcHttpUploadStrategy` — ships in v1, uses ORPC's HTTP `RPCLink`.
 *   - `PresignedUrlUploadStrategy` — reserved, throws on construction in v1.
 *
 * `upload()` receives a `File | Blob` and the per-call options. Strategy
 * implementations are responsible for:
 *   - Resolving the current auth token (via the injected `TokenProvider`).
 *   - Forwarding `signal` to the underlying transport for cancellation.
 *   - Best-effort `onProgress` emission (see `UploadProgress` jsdoc).
 */
export interface UploadStrategy {
  upload(file: File | Blob, opts: UploadOptions): Promise<UploadResult>;
}

// ---------- Typed path helper (public-surface type-safety) ----------
//
// `Path<T>` produces the tuple-of-keys-into-a-router type the public
// `upload` API uses. ORPC's contract router is a recursive plain object;
// this helper walks it.
//
// The recursion is bounded by TS's default depth check; for the contract
// shapes we expect (a few levels deep), this is fine. If a consumer's
// contract becomes pathological, the result narrows to `string[]` and
// the typo-detection benefit is lost — never an error.
//
// We keep this in `strategy.ts` (not `types.ts`) because it's only the
// PUBLIC `upload(file, opts)` signature that uses it. The internal
// `UploadOptions.procedure` stays `string[]`.

/**
 * Tuple-of-keys path into a contract router. Used by the public
 * `OrpcWsClient.upload(file, opts)` signature to type-check the
 * `procedure` field against the consumer's contract — renaming a
 * procedure in the contract surfaces as a TS error at the call site,
 * not a runtime "procedure not found".
 *
 * Reaches into procedures and sub-routers; stops at leaf types (functions,
 * primitive values).
 */
export type Path<T> = T extends Record<string, unknown>
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends Record<string, unknown>
          ? [K] | [K, ...Path<T[K]>]
          : [K]
        : never;
    }[keyof T]
  : never;
