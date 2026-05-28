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

import { describe, expect, it } from "vitest";

import { createOrpcWsClient } from "../index.js";

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
