// The public `client.upload` method adapter — one concept: bridging the
// public, `TContract`-typed upload signature (typed `procedure` path,
// picked-out options) to the internal `UploadStrategy.upload(file, opts)`
// call. The strategy itself is chosen and constructed by the composition
// root (src/index.ts); this adapter is strategy-agnostic.

import type { AnyContractRouter } from "@orpc/contract";

import type { UploadStrategy, Path } from "./strategy.js";
import type { UploadOptions, UploadResult } from "./types.js";

/**
 * Build the public upload method over a wired strategy. The returned
 * function's shape is exactly `OrpcWsClient<TContract>["upload"]` (the
 * composition root assigns it there); it is declared structurally here to
 * keep this module free of the composition root's types.
 */
export function createUploadMethod<TContract extends AnyContractRouter>(
  uploadStrategy: UploadStrategy,
): (
  file: File | Blob,
  opts: {
    procedure: Path<TContract>;
    onProgress?: UploadOptions["onProgress"];
    signal?: UploadOptions["signal"];
    meta?: UploadOptions["meta"];
  },
) => Promise<UploadResult> {
  return (
    file: File | Blob,
    publicOpts: {
      procedure: Path<TContract>;
      onProgress?: UploadOptions["onProgress"];
      signal?: UploadOptions["signal"];
      meta?: UploadOptions["meta"];
    },
  ): Promise<UploadResult> => {
    // `Path<TContract>` is structurally a string tuple; the strategy
    // interface takes a plain `string[]`. Spread is type-safe — the
    // `Path` tuple narrows to a readonly array of strings.
    const procedure = [...(publicOpts.procedure as readonly string[])];
    const internalOpts: UploadOptions = {
      procedure,
      ...(publicOpts.onProgress
        ? { onProgress: publicOpts.onProgress }
        : {}),
      ...(publicOpts.signal ? { signal: publicOpts.signal } : {}),
      ...(publicOpts.meta ? { meta: publicOpts.meta } : {}),
    };
    return uploadStrategy.upload(file, internalOpts);
  };
}
