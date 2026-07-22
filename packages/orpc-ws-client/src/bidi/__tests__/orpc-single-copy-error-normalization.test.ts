// Guards the SINGLE-COPY-of-@orpc invariant that the peerDependencies migration
// exists to enforce.
//
// WHY THIS MATTERS. ORPC recognizes an `ORPCError` across module boundaries with
// a version-keyed shim, NOT a plain prototype chain: every `ORPCError` class
// registers its own constructor into a `WeakSet` stored on
// `globalThis[Symbol.for("__@orpc/client@<VERSION>/error/ORPC_ERROR_CONSTRUCTORS__")]`,
// and `X instanceof ORPCError` (its `static [Symbol.hasInstance]`) returns true
// only when the instance's constructor lives in THAT version-keyed set. ORPC's
// `toORPCError(e)` is `e instanceof ORPCError ? e : new ORPCError("INTERNAL_SERVER_ERROR",
// { message: "Internal server error", cause: e })` — so if the app and this
// library carry TWO @orpc copies at DIFFERENT versions, their symbols differ,
// their WeakSets differ, cross-copy `instanceof` returns false, and every typed
// `ORPCError` the library throws degrades to a generic "Internal server error"
// on the app side (typed `code`/`data` lost). Moving `@orpc/*` to
// peerDependencies forces ONE shared copy, which keeps the shim's WeakSet shared
// and recognition intact.
//
// WHAT THIS PROVES. With a single shared @orpc (the standalone dev install here
// stands in for the host's single copy), an `ORPCError` produced inside library
// code (`createDelegatingClientRouter`, which imports `ORPCError` from
// `@orpc/server`) is still recognized — and passed through UN-degraded — by the
// normalization path the host runs (`toORPCError` from `@orpc/client`). The
// plain-`Error` control proves the test can actually SEE a degrade, so a green
// run is meaningful rather than vacuous.

import { ORPCError, toORPCError } from "@orpc/client";
import { call } from "@orpc/server";
import { describe, expect, it } from "vitest";

import {
  createDelegatingClientRouter,
  type DelegatingHandler,
} from "../delegating-router.js";

/** Invoke a named leaf of a dynamically-keyed delegating router (see the sibling
 *  delegating-router test for why this narrowing cast is test-only). */
function invoke(
  router: ReturnType<typeof createDelegatingClientRouter>,
  name: string,
  input: unknown,
): Promise<unknown> {
  const leaf = (router as unknown as Record<string, Parameters<typeof call>[0]>)[
    name
  ];
  return call(leaf, input);
}

describe("single-copy @orpc invariant — ORPCError survives toORPCError un-degraded", () => {
  it("preserves a typed ORPCError thrown from a library delegating handler (code + data intact, NOT 'Internal server error')", async () => {
    // A host-built ORPCError (this file imports `ORPCError` from `@orpc/client`;
    // the library imports it from `@orpc/server`) carrying a typed code + data.
    const thrown = new ORPCError("FORBIDDEN", {
      message: "nope",
      data: { reason: "insufficient_scope" },
    });
    const handlers: Record<string, DelegatingHandler> = {
      guarded: () => {
        throw thrown;
      },
    };
    const router = createDelegatingClientRouter(["guarded"], () => handlers);

    const error = await invoke(router, "guarded", undefined).then(
      () => {
        throw new Error("expected the guarded handler to reject");
      },
      (e: unknown) => e,
    );

    // Cross-module recognition: the value that crossed the library boundary is
    // still an ORPCError to the host's `@orpc/client` class (same shared copy →
    // same version-keyed WeakSet). Under two mismatched copies this is `false`.
    expect(error).toBeInstanceOf(ORPCError);

    // The normalization path the host runs must return it UNCHANGED — same
    // identity, typed code + data intact — never a fresh INTERNAL_SERVER_ERROR.
    const normalized = toORPCError(error);
    expect(normalized).toBe(error);
    expect(normalized.code).toBe("FORBIDDEN");
    expect(normalized.data).toEqual({ reason: "insufficient_scope" });
    expect(normalized.message).toBe("nope");
    expect(normalized.code).not.toBe("INTERNAL_SERVER_ERROR");
    expect(normalized.message).not.toBe("Internal server error");
  });

  it("preserves the library's own ORPCError(NOT_FOUND) from the missing-handler path", async () => {
    // The delegating router's built-in loud failure is an `ORPCError` minted by
    // library code. It, too, must survive the host's normalization un-degraded.
    const router = createDelegatingClientRouter(["gone"], () => ({}));

    const error = await invoke(router, "gone", undefined).then(
      () => {
        throw new Error("expected the missing-handler call to reject");
      },
      (e: unknown) => e,
    );

    const normalized = toORPCError(error);
    expect(normalized).toBe(error);
    expect(normalized.code).toBe("NOT_FOUND");
    expect(normalized.code).not.toBe("INTERNAL_SERVER_ERROR");
  });

  it("control: a plain Error DOES degrade to a generic 'Internal server error' (so the survival assertions are non-vacuous)", () => {
    // This is what the app would see for EVERY library ORPCError if two
    // mismatched @orpc copies broke cross-copy `instanceof`.
    const plain = new Error("some internal thing");
    const normalized = toORPCError(plain);

    expect(normalized).not.toBe(plain);
    expect(normalized).toBeInstanceOf(ORPCError);
    expect(normalized.code).toBe("INTERNAL_SERVER_ERROR");
    expect(normalized.message).toBe("Internal server error");
  });
});
