// Phase 3.1 — connection registry unit tests.
//
// The registry is the seam between "verifyClient said yes" and "the WS
// is live". Three behaviors are load-bearing and pinned here:
//
//   1. Session replacement closes the old WS with the configured code
//      and fires the onKicked hook.
//   2. Atomic delete-if-same prevents a kicked-old-WS's late close
//      event from wiping the new entry (Bug 9 server side).
//   3. closeAll iterates and closes — used by `OrpcWsServer.dispose()`.

import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { ConnectionRegistry } from "../connection-registry.js";
import { DEFAULT_CONNECTION_CONFIG } from "../../config/connection-config.js";

/**
 * Minimal WebSocket stub — close is the only method the registry calls.
 * Cast to `WebSocket` at the seam (test-only).
 */
function fakeWs(): WebSocket {
  return {
    close: vi.fn(),
  } as unknown as WebSocket;
}

describe("ConnectionRegistry", () => {
  it("register sets the entry and get returns the same WS", () => {
    const ws = fakeWs();
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
    });

    registry.register("user-1", ws, { id: 1 });

    expect(registry.get("user-1")).toBe(ws);
    expect(registry.size()).toBe(1);
  });

  it("register with same key kicks the previous WS with sessionReplacedCloseCode", () => {
    const a = fakeWs();
    const b = fakeWs();
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
    });

    registry.register("user-1", a, { id: 1 });
    registry.register("user-1", b, { id: 1 });

    expect(a.close).toHaveBeenCalledWith(
      DEFAULT_CONNECTION_CONFIG.sessionReplacedCloseCode,
      "Connected from another tab",
    );
    expect(registry.get("user-1")).toBe(b);
  });

  it("onKicked fires with the old user and the replacing WS", () => {
    const a = fakeWs();
    const b = fakeWs();
    const onKicked = vi.fn();
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
      onKicked,
    });

    const userA = { id: 1, name: "A" };
    registry.register("user-1", a, userA);
    registry.register("user-1", b, { id: 1, name: "B" });

    expect(onKicked).toHaveBeenCalledTimes(1);
    expect(onKicked).toHaveBeenCalledWith(userA, b);
  });

  it("unregisterIfSame deletes only when the stored WS matches (Bug 9 server side)", () => {
    const a = fakeWs();
    const b = fakeWs();
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
    });

    // Register A, then B (which kicks A). B is now the live entry.
    registry.register("user-1", a, { id: 1 });
    registry.register("user-1", b, { id: 1 });
    expect(registry.get("user-1")).toBe(b);

    // A's `close` event fires asynchronously after the kick. The handler
    // calls unregisterIfSame('user-1', a). Should NOT remove B.
    registry.unregisterIfSame("user-1", a);

    expect(registry.get("user-1")).toBe(b);
    expect(registry.size()).toBe(1);
  });

  it("unregisterIfSame removes the entry when the stored WS matches", () => {
    const a = fakeWs();
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
    });

    registry.register("user-1", a, { id: 1 });
    registry.unregisterIfSame("user-1", a);

    expect(registry.get("user-1")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("closeAll closes every tracked WS with the given code and reason", () => {
    const a = fakeWs();
    const b = fakeWs();
    const c = fakeWs();
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
    });

    registry.register("u-a", a, { id: "a" });
    registry.register("u-b", b, { id: "b" });
    registry.register("u-c", c, { id: "c" });

    registry.closeAll(4009, "Server shutdown");

    expect(a.close).toHaveBeenCalledWith(4009, "Server shutdown");
    expect(b.close).toHaveBeenCalledWith(4009, "Server shutdown");
    expect(c.close).toHaveBeenCalledWith(4009, "Server shutdown");
  });

  it("singleConnectionPerUser=false skips the kick", () => {
    const a = fakeWs();
    const b = fakeWs();
    const registry = new ConnectionRegistry({
      config: { ...DEFAULT_CONNECTION_CONFIG, singleConnectionPerUser: false },
    });

    registry.register("user-1", a, { id: 1 });
    registry.register("user-1", b, { id: 1 });

    expect(a.close).not.toHaveBeenCalled();
    // The map gets overwritten in this mode — last-write-wins.
    expect(registry.get("user-1")).toBe(b);
  });

  it("size() reports the number of distinct keys", () => {
    const registry = new ConnectionRegistry({
      config: DEFAULT_CONNECTION_CONFIG,
    });
    expect(registry.size()).toBe(0);

    registry.register("u-1", fakeWs(), {});
    expect(registry.size()).toBe(1);

    registry.register("u-2", fakeWs(), {});
    expect(registry.size()).toBe(2);

    // Same key — replaces, doesn't add.
    registry.register("u-1", fakeWs(), {});
    expect(registry.size()).toBe(2);
  });
});
