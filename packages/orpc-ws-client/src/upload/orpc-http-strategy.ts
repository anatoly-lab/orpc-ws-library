// `orpc-http` upload strategy — Phase 6 v1.
//
// Uses ORPC's HTTP `RPCLink` from `@orpc/client/fetch`. The link's
// underlying transport is `fetch`, which handles multipart-encoded
// payloads (including `File` / `Blob`) natively. The strategy:
//
//   1. Resolves the current auth token from the injected `TokenProvider`
//      (optional — when absent, requests go without an `Authorization`
//      header and the consumer's HTTP `verifyClient` decides what to do).
//   2. Builds the `Authorization: Bearer ${token}` header dynamically per
//      call (token can rotate during the client's lifetime).
//   3. Invokes `link.call(procedure, { file, ...meta }, { signal })`.
//      ORPC's link encodes the `file` field as multipart automatically
//      via its built-in `File`/`Blob` serializer.
//   4. Returns `{ ok: true, response }` on success; throws on transport
//      / auth / server-side errors (the consumer's `try { await
//      client.upload(...) }` is the error seam).
//
// Progress reporting: the fetch-based transport does NOT surface
// per-chunk upload progress (the browser `fetch` body-reader exposes
// download but not upload streaming progress). v1 emits 0% at start +
// 100% on success — documented limitation in `UploadProgress` jsdoc.
// Real progress would need XHR with manual multipart construction.
//
// CLAUDE.md "Uploads": token transport is `Authorization: Bearer`. Same
// `TokenProvider` instance the WS reconnect path uses, so a refresh-side
// token swap is picked up here on the next upload too.

import { RPCLink } from "@orpc/client/fetch";

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type { TokenProvider } from "../auth/token-provider.js";

import type { UploadStrategy } from "./strategy.js";
import type { UploadOptions, UploadResult } from "./types.js";

/**
 * Dependencies for the orpc-http strategy. Constructed by the
 * composition root (`createOrpcWsClient`) when the consumer passes
 * `uploads: { strategy: "orpc-http", ... }`.
 */
export interface OrpcHttpUploadStrategyDeps {
  /**
   * Base URL of the HTTP upload endpoint. The strategy posts to
   * `${httpUrl}` (ORPC's link appends the procedure path internally).
   */
  httpUrl: string;
  /**
   * Optional token producer. When absent, no `Authorization` header
   * is sent — consumer's HTTP `verifyClient` decides what that means
   * (typically reject as 401; cookie-only flows would accept).
   */
  tokenProvider?: TokenProvider;
  /** Structured logger; defaults to noop. */
  logger?: Logger;
}

/**
 * Implements `UploadStrategy` using ORPC's HTTP `RPCLink`.
 *
 * The `RPCLink` instance is built ONCE in the constructor with a dynamic
 * `headers` callback. The callback reads the current token on every
 * call, so a token swap between uploads is picked up automatically —
 * we don't have to rebuild the link.
 */
export class OrpcHttpUploadStrategy implements UploadStrategy {
  private readonly link: RPCLink<Record<string, never>>;
  private readonly logger: Logger;

  constructor(deps: OrpcHttpUploadStrategyDeps) {
    this.logger = deps.logger ?? noopLogger;
    const tokenProvider = deps.tokenProvider;

    this.link = new RPCLink({
      url: deps.httpUrl,
      // `headers` is invoked per-call. Returning a fresh object each
      // time means a token rotation between uploads lands on the next
      // call without re-instantiating the link. The signature accepts
      // sync or async; we keep it sync because TokenProvider.getToken()
      // is the in-memory cache (refresh happens on the WS path).
      headers: () => {
        if (!tokenProvider) return {};
        const token = tokenProvider.getToken();
        if (!token) return {};
        return { authorization: `Bearer ${token}` };
      },
    });
  }

  async upload(
    file: File | Blob,
    opts: UploadOptions,
  ): Promise<UploadResult> {
    // Emit 0% start — best-effort, see file header for the progress
    // limitation. `total` defaults to the file size when available.
    const total = file.size;
    if (opts.onProgress) {
      try {
        opts.onProgress({ loaded: 0, total, percent: 0 });
      } catch (err) {
        this.logger.warn("orpc-http-strategy: onProgress(0%) threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The input shape the consumer's procedure receives. `file` is the
    // multipart field name; ORPC's serializer recognizes `File`/`Blob`
    // values and frames them as multipart parts automatically.
    const input: Record<string, unknown> = {
      file,
      ...(opts.meta ?? {}),
    };

    this.logger.debug("orpc-http-strategy: upload", {
      procedure: opts.procedure,
      size: total,
    });

    try {
      const response = await this.link.call(opts.procedure, input, {
        signal: opts.signal,
        context: {},
      });

      // 100% end. We always emit this even when the strategy didn't
      // emit intermediate ticks — gives consumers a deterministic
      // "completion" signal without forcing them to also subscribe to
      // the returned promise.
      if (opts.onProgress) {
        try {
          opts.onProgress({ loaded: total, total, percent: 100 });
        } catch (err) {
          this.logger.warn(
            "orpc-http-strategy: onProgress(100%) threw",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      return { ok: true, response };
    } catch (err) {
      // Re-throw so the consumer's await sees the error. We log here
      // for observability but do NOT swallow — there is no `ok: false`
      // result variant by design (errors are exceptional, and ORPC
      // already encodes structured server errors via thrown ORPCError).
      this.logger.error("orpc-http-strategy: upload failed", {
        procedure: opts.procedure,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * Stub strategy for the reserved `presigned-url` variant. Throws
 * `Not implemented` on `upload()`. Declared as a real class so the
 * composition-root branch can instantiate it unconditionally and rely
 * on the runtime throw — no type-level `never` gymnastics.
 *
 * CLAUDE.md "Uploads": adding the real presigned-url implementation
 * later is additive — same `UploadStrategy` interface, same public
 * `client.upload(file, opts)` signature.
 */
export class PresignedUrlUploadStrategy implements UploadStrategy {
  async upload(
    _file: File | Blob,
    _opts: UploadOptions,
  ): Promise<UploadResult> {
    throw new Error(
      "[orpc-ws-client] presigned-url upload strategy is not implemented in v1. " +
        "Use { strategy: 'orpc-http' } instead, or pin to a future version " +
        "that ships this strategy.",
    );
  }
}
