// Phase 6 — unit tests for the orpc-http upload strategy.
//
// What we pin:
//   1. `upload(file, {procedure, ...})` reaches the underlying HTTP
//      transport with the configured URL.
//   2. Bearer token from `tokenProvider.getToken()` lands in the
//      Authorization header — and updates between calls if the token
//      rotates.
//   3. `signal` propagates: aborting it surfaces an AbortError from
//      `upload()`.
//   4. `onProgress` fires at 0% (start) and 100% (end).
//   5. `PresignedUrlUploadStrategy.upload()` throws a clear
//      "not implemented" error.
//
// We monkey-patch global `fetch` to capture the request without standing
// up an HTTP server. ORPC's `RPCLink` from `@orpc/client/fetch` uses
// `fetch` under the hood; intercepting at that layer keeps the test
// deterministic and quick.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  OrpcHttpUploadStrategy,
  PresignedUrlUploadStrategy,
} from "../orpc-http-strategy.js";
import type { TokenProvider } from "../../auth/token-provider.js";

/**
 * Replace the global `fetch` with a spy returning a configurable
 * Response. The spy captures the Request object for assertions.
 */
function installFetchSpy(
  response: { body: unknown; init?: ResponseInit } = {
    body: { ok: true, marker: "stub-response" },
  },
): { fetchSpy: ReturnType<typeof vi.fn>; restore: () => void } {
  const original = globalThis.fetch;
  const fetchSpy = vi.fn(async (_input: Request | string) => {
    // Build a plausible ORPC-shaped response: it expects JSON encoded
    // via its own RPC serializer. Our test handlers don't actually
    // round-trip — we just need the strategy's `link.call` not to
    // throw on response decode. ORPC's decoder is tolerant of the
    // standard JSON body shape; we mimic a minimal success envelope.
    return new Response(
      JSON.stringify({ json: response.body }),
      response.init ?? {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  return {
    fetchSpy,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("OrpcHttpUploadStrategy", () => {
  let restore: () => void = () => {};

  beforeEach(() => {
    const installed = installFetchSpy();
    restore = installed.restore;
  });

  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it("posts to the configured httpUrl", async () => {
    const installed = installFetchSpy();
    restore = installed.restore;
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
    });

    await strategy.upload(new Blob(["hello"]), {
      procedure: ["media", "upload"],
    });

    expect(installed.fetchSpy).toHaveBeenCalledOnce();
    const req = installed.fetchSpy.mock.calls[0]?.[0] as Request;
    // ORPC appends the procedure path to the base URL.
    expect(req.url).toContain("https://api.example.com/upload");
    expect(req.method).toBe("POST");
  });

  it("includes Authorization: Bearer <token> when tokenProvider returns a token", async () => {
    const installed = installFetchSpy();
    restore = installed.restore;
    const tokenProvider: TokenProvider = {
      getToken: () => "the-bearer-token",
      refresh: async () => "the-bearer-token",
    };
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
      tokenProvider,
    });

    await strategy.upload(new Blob(["x"]), {
      procedure: ["media", "upload"],
    });

    const req = installed.fetchSpy.mock.calls[0]?.[0] as Request;
    expect(req.headers.get("authorization")).toBe("Bearer the-bearer-token");
  });

  it("omits Authorization when tokenProvider is absent", async () => {
    const installed = installFetchSpy();
    restore = installed.restore;
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
    });

    await strategy.upload(new Blob(["x"]), {
      procedure: ["media", "upload"],
    });

    const req = installed.fetchSpy.mock.calls[0]?.[0] as Request;
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("picks up a rotated token between calls (no link rebuild)", async () => {
    const installed = installFetchSpy();
    restore = installed.restore;
    let current = "first-token";
    const tokenProvider: TokenProvider = {
      getToken: () => current,
      refresh: async () => current,
    };
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
      tokenProvider,
    });

    await strategy.upload(new Blob(["a"]), {
      procedure: ["media", "upload"],
    });
    current = "second-token";
    await strategy.upload(new Blob(["b"]), {
      procedure: ["media", "upload"],
    });

    const first = installed.fetchSpy.mock.calls[0]?.[0] as Request;
    const second = installed.fetchSpy.mock.calls[1]?.[0] as Request;
    expect(first.headers.get("authorization")).toBe("Bearer first-token");
    expect(second.headers.get("authorization")).toBe("Bearer second-token");
  });

  it("propagates abort signal — fetch receives a signal that's hooked to the caller's", async () => {
    // Install a fetch spy that records which signal it received. We
    // assert the signal flows through; we don't assert the strategy
    // throws here because the fake fetch always resolves cleanly. The
    // important contract is that the signal is forwarded — production
    // fetch will short-circuit on its own.
    const original = globalThis.fetch;
    let observedSignal: AbortSignal | null = null;
    const fetchSpy = vi.fn(async (input: Request) => {
      observedSignal = input.signal;
      return new Response(JSON.stringify({ json: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
    });
    const ctrl = new AbortController();
    await strategy.upload(new Blob(["x"]), {
      procedure: ["media", "upload"],
      signal: ctrl.signal,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(observedSignal).not.toBeNull();
    // Aborting the caller's controller must surface on the signal we
    // gave to fetch. The two signals are either identical or linked via
    // AbortSignal.any — either way, our abort fires on it.
    expect(observedSignal!.aborted).toBe(false);
    ctrl.abort();
    expect(observedSignal!.aborted).toBe(true);
  });

  // ----- NFI-3: upload-401 → storm-guard hook -----

  /**
   * Install a fetch spy that returns a RAW HTTP error response — a plain
   * `{ error }` body with the given status, exactly the shape the server's
   * `sendEarlyReject` writes (NOT an ORPC error envelope). This is the
   * critical fixture: oRPC's RPCLink does not recognise it as a typed
   * ORPCError, so the only reliable 401 signal is `response.status`, which
   * the strategy's custom `fetch` reads directly.
   */
  function installRawStatusFetch(status: number): () => void {
    const original = globalThis.fetch;
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rejected" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("fires onUpload401 exactly once on a raw HTTP 401, while still rejecting (NFI-3)", async () => {
    restore = installRawStatusFetch(401);
    const tokenProvider: TokenProvider = {
      getToken: () => "current-token",
      refresh: async () => "current-token",
    };
    const onUpload401 = vi.fn();
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
      tokenProvider,
      onUpload401,
    });

    // No auto-retry: the upload() caller still sees the rejection...
    await expect(
      strategy.upload(new Blob(["x"]), { procedure: ["media", "upload"] }),
    ).rejects.toThrow();
    // ...but the storm-guard hook fired on the raw 401 status (the rejected
    // credential is still the current one — see the rotation test below).
    expect(onUpload401).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onUpload401 on a non-401 error like 500 (NFI-3 false-positive guard)", async () => {
    // The dangerous failure mode: treating ANY upload error as auth failure
    // would let a 500 / network blip drive spurious refreshes that could
    // themselves trip the storm guard to terminal. Only a genuine 401 fires.
    restore = installRawStatusFetch(500);
    const onUpload401 = vi.fn();
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
      onUpload401,
    });

    await expect(
      strategy.upload(new Blob(["x"]), { procedure: ["media", "upload"] }),
    ).rejects.toThrow();
    expect(onUpload401).not.toHaveBeenCalled();
  });

  it("does not fire onUpload401 on a successful (200) upload (NFI-3)", async () => {
    const installed = installFetchSpy();
    restore = installed.restore;
    const onUpload401 = vi.fn();
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
      onUpload401,
    });

    await strategy.upload(new Blob(["x"]), { procedure: ["media", "upload"] });

    expect(onUpload401).not.toHaveBeenCalled();
  });

  it("does NOT fire onUpload401 when the rejected token was already rotated away (H2)", async () => {
    // The F2-class race: two uploads go out on the same stale token. The
    // first 401 refreshes the token; the second upload's (slower) 401 lands
    // AFTER the swap, carrying the OLD credential. Acting on it would
    // re-enter the storm guard post-refresh and spuriously trip terminal.
    // Simulate by rotating the provider's token at response time, so the
    // request's Authorization no longer matches getToken().
    const original = globalThis.fetch;
    let current = "tok-old";
    const tokenProvider: TokenProvider = {
      getToken: () => current,
      refresh: async () => current,
    };
    const fetchSpy = vi.fn(async () => {
      // A concurrent refresh rotated the token while this stale request was
      // in flight; by the time its 401 is observed, getToken() is the NEW
      // value but the request carried `Bearer tok-old`.
      current = "tok-new";
      return new Response(JSON.stringify({ error: "rejected" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const onUpload401 = vi.fn();
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
      tokenProvider,
      onUpload401,
    });

    await expect(
      strategy.upload(new Blob(["x"]), { procedure: ["media", "upload"] }),
    ).rejects.toThrow();
    // Stale credential → recovery NOT triggered (no spurious terminal).
    expect(onUpload401).not.toHaveBeenCalled();
  });

  it("fires onProgress at 0% (start) and 100% (end)", async () => {
    const installed = installFetchSpy();
    restore = installed.restore;
    const strategy = new OrpcHttpUploadStrategy({
      httpUrl: "https://api.example.com/upload",
    });
    const onProgress = vi.fn();
    const file = new Blob(["12345"]); // size 5

    await strategy.upload(file, {
      procedure: ["media", "upload"],
      onProgress,
    });

    expect(onProgress).toHaveBeenCalled();
    // First call: 0% with the right total.
    const first = onProgress.mock.calls[0]?.[0];
    expect(first.percent).toBe(0);
    expect(first.total).toBe(5);
    // Last call: 100%.
    const last = onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0];
    expect(last.percent).toBe(100);
    expect(last.total).toBe(5);
    expect(last.loaded).toBe(5);
  });
});

describe("PresignedUrlUploadStrategy", () => {
  it("throws a clear 'not implemented' error from upload()", async () => {
    const strategy = new PresignedUrlUploadStrategy();
    await expect(
      strategy.upload(new Blob(["x"]), { procedure: ["media", "upload"] }),
    ).rejects.toThrow(/not implemented/i);
  });
});
