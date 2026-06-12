// Phase 6 — composition-root tests for upload wiring.
//
// What we pin:
//   1. `createOrpcWsClient({...})` without `uploads` → no `upload`
//      method present on the returned client.
//   2. With `uploads: { strategy: "orpc-http", httpUrl }` → `client.upload`
//      is a function.
//   3. With `uploads: { strategy: "presigned-url" }` → `client.upload`
//      exists BUT calling it throws "not implemented" (the strategy is
//      reserved in the type union).
//
// We don't connect the WS in these tests — we just construct the client
// and inspect its public surface. The `url` option is required but never
// dialed (no `client.connect()` call).

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@orpc-ws/shared";

import { createOrpcWsClient } from "../index.js";
import type { TokenProvider } from "../auth/token-provider.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Stub global fetch to always answer a raw 401 (the upload-reject shape). */
function install401Fetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Flush the fire-and-forget recovery chain. `refresh()` returns null
 * immediately and `tryAuthRecovery` has no debounce, so the whole path is
 * microtasks — a single macrotask turn drains it.
 */
const flushRecovery = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("createOrpcWsClient — upload composition", () => {
  it("does NOT expose `upload` when `uploads` is not configured", () => {
    const client = createOrpcWsClient<Record<string, never>>({
      url: "ws://example.invalid/ws",
    });
    expect(client.upload).toBeUndefined();
    // Also confirm Object.keys reflects the public shape — adapters that
    // serialise the client (debug tools, etc.) shouldn't see a phantom key.
    expect(Object.keys(client)).not.toContain("upload");

    client.dispose();
  });

  it("exposes `upload` as a function with `uploads.strategy = 'orpc-http'`", () => {
    const client = createOrpcWsClient<Record<string, never>>({
      url: "ws://example.invalid/ws",
      uploads: {
        strategy: "orpc-http",
        httpUrl: "https://example.invalid/upload",
      },
    });
    expect(typeof client.upload).toBe("function");

    client.dispose();
  });

  it("exposes `upload` with 'presigned-url' strategy but it throws on call", async () => {
    const client = createOrpcWsClient<Record<string, never>>({
      url: "ws://example.invalid/ws",
      uploads: { strategy: "presigned-url" },
    });
    expect(typeof client.upload).toBe("function");

    await expect(
      client.upload!(new Blob(["x"]), {
        // `Path<TContract>` narrows to `never` for the empty record above —
        // we cast to bypass the type check; the runtime path is what we're
        // testing.
        procedure: ["any"] as never,
      }),
    ).rejects.toThrow(/not implemented/i);

    client.dispose();
  });
});

// NFI-3 — the upload-401 → storm-guard WIRING, pinned at the composition
// root (M4). The strategy test pins HTTP-status detection and the manager
// test pins delegation; this pins that `createOrpcWsClient` actually
// connects the two — reverting the `onUpload401:` line in index.ts breaks
// these (and nothing else in the suite).
describe("createOrpcWsClient — upload-401 storm-guard wiring (NFI-3)", () => {
  it("routes an upload 401 into auth recovery when a tokenProvider is set", async () => {
    const restore = install401Fetch();
    // refresh() → null makes recovery fail cleanly and fire terminal WITHOUT
    // building a WebSocket (refreshAndReconnect only swaps the socket on a
    // non-null token), so this stays a pure in-memory composition assertion.
    const refresh = vi.fn(async (): Promise<string | null> => null);
    const tokenProvider: TokenProvider = { getToken: () => "stale", refresh };
    const onTerminalAuthFailure = vi.fn();

    const client = createOrpcWsClient<Record<string, never>>({
      url: "ws://example.invalid/ws",
      tokenProvider,
      onTerminalAuthFailure,
      uploads: {
        strategy: "orpc-http",
        httpUrl: "https://example.invalid/upload",
      },
      logger: silentLogger,
      sleepDetection: false,
    });

    await expect(
      client.upload!(new Blob(["x"]), { procedure: ["media", "upload"] as never }),
    ).rejects.toThrow();
    await flushRecovery();

    // Both assertions fail if the index.ts `onUpload401:` wiring is reverted:
    // recovery refreshes once and (refresh→null) goes terminal.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onTerminalAuthFailure).toHaveBeenCalledTimes(1);

    client.dispose();
    restore();
  });

  it("does NOT route upload-401 recovery under cookie-auth / no tokenProvider (M3 gate)", async () => {
    const restore = install401Fetch();
    const onTerminalAuthFailure = vi.fn();

    const client = createOrpcWsClient<Record<string, never>>({
      url: "ws://example.invalid/ws",
      // No tokenProvider → cookie auth. `onUpload401` must NOT be wired, so
      // an upload 401 surfaces to the caller only and never tears down a
      // healthy cookie-authed client. Removing the M3 gate makes this fail:
      // the stub cookie provider's null refresh would fire terminal.
      onTerminalAuthFailure,
      uploads: {
        strategy: "orpc-http",
        httpUrl: "https://example.invalid/upload",
      },
      logger: silentLogger,
      sleepDetection: false,
    });

    await expect(
      client.upload!(new Blob(["x"]), { procedure: ["media", "upload"] as never }),
    ).rejects.toThrow();
    await flushRecovery();

    expect(onTerminalAuthFailure).not.toHaveBeenCalled();

    client.dispose();
    restore();
  });
});
