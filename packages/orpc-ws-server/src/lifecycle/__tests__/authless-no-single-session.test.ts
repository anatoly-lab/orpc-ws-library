// AUTHLESS session behavior at the connection-handler + registry seam.
//
// The library flipped the authless DEFAULT (behavior change): authless is
// now a SINGLE global connection — a new connection KICKS the previous one
// (single-GUI remote-control model) — with an opt-out
// (`allowConcurrentConnections: true`) that restores the old "connections
// coexist" behavior. Both halves are decided by which key seam the
// composition root injects into the handler:
//
//   - DEFAULT → `createSingleAuthlessKey()` (a CONSTANT key) + the registry's
//     `singleConnectionPerUser: true`: the second connection collides on the
//     one key and the registry closes the first with 4005, firing onKicked.
//   - `allowConcurrentConnections` → `createAuthlessKeyFactory()` (a UNIQUE
//     monotonic key) + `singleConnectionPerUser: false`: distinct keys, no
//     collision, no kick. (This is the OLD default — the relocated foot-gun
//     regression: `JSON.stringify(undefined)` would collapse every authless
//     socket to one key and kick each other; the unique seam prevents it.)
//
// Unit-level + deterministic (CLAUDE.md "Tests from day 0"): a REAL
// `ConnectionRegistry` (so the keying is genuinely exercised) with fake
// WS / pingPong / rpcHandler collaborators.

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";

import { ConnectionHandler } from "../connection-handler.js";
import { getConnectionWs } from "../../state/connection-identity.js";
import { ConnectionRegistry } from "../../state/connection-registry.js";
import {
  createAuthlessKeyFactory,
  createSingleAuthlessKey,
  SINGLE_AUTHLESS_KEY,
} from "../../state/authless-key.js";
import { DEFAULT_CONNECTION_CONFIG } from "../../config/connection-config.js";
import type { WsPingPong } from "../../heartbeat/ws-ping-pong.js";

/**
 * Fake WS: an EventEmitter (so the handler can attach 'close'/'error')
 * with a spied `close`. The spy is kept on a sibling handle so we can
 * assert on it without fighting `ws`'s overloaded `close` type.
 */
function fakeWs(): { ws: WebSocket; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const ee = new EventEmitter();
  Object.assign(ee, { close });
  return { ws: ee as unknown as WebSocket, close };
}

/** Fake ping/pong — the handler only calls register/unregister. */
function fakePingPong(): { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } {
  return { register: vi.fn(), unregister: vi.fn() };
}

describe("authless DEFAULT — single global connection (new kicks previous)", () => {
  it("second connection kicks the first with 4005; only B remains; onKicked fires once with B's ws", () => {
    const onKicked = vi.fn();
    // DEFAULT authless config: single global connection ON.
    const registry = new ConnectionRegistry({
      config: { ...DEFAULT_CONNECTION_CONFIG, singleConnectionPerUser: true },
      onKicked,
    });
    const pingPong = fakePingPong();
    const upgrade = vi.fn();

    const handler = new ConnectionHandler({
      // No verifyOrchestrator → authless path. CONSTANT key seam → collide.
      authlessKey: createSingleAuthlessKey(),
      registry,
      pingPong: pingPong as unknown as WsPingPong,
      rpcHandler: { upgrade },
    });

    const a = fakeWs();
    const b = fakeWs();
    const fakeReq = {} as Parameters<typeof handler.handle>[1];

    handler.handle(a.ws, fakeReq);
    handler.handle(b.ws, fakeReq);

    // A is kicked with the session-replaced code (4005); B is untouched.
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(a.close.mock.calls[0]?.[0]).toBe(
      DEFAULT_CONNECTION_CONFIG.sessionReplacedCloseCode,
    );
    expect(a.close.mock.calls[0]?.[0]).toBe(4005);
    expect(b.close).not.toHaveBeenCalled();

    // ONE entry under the single shared key — B took over A's slot.
    expect(registry.size()).toBe(1);
    const keys = [...registry.entries()].map((e) => e.key);
    expect(keys).toEqual([SINGLE_AUTHLESS_KEY]);

    // onKicked fired exactly once; `replacedBy` is B's (server-side) ws.
    expect(onKicked).toHaveBeenCalledTimes(1);
    const [, replacedBy] = onKicked.mock.calls[0]!;
    expect(replacedBy).toBe(b.ws);

    // Both upgraded with the EMPTY authless context as consumers observe
    // it (no user/token — no string keys at all); the only content is the
    // symbol-keyed library-internal identity stamp carrying each
    // connection's RAW ws (feeds the heartbeat last-wins bound).
    expect(upgrade).toHaveBeenCalledTimes(2);
    const sockets = [a.ws, b.ws];
    upgrade.mock.calls.forEach((call, i) => {
      const ctx = (call[1] as { context: Record<string, unknown> }).context;
      expect(Object.keys(ctx)).toEqual([]);
      expect(getConnectionWs(ctx)).toBe(sockets[i]);
    });
  });
});

describe("authless allowConcurrentConnections opt-out — connections coexist (foot-gun regression)", () => {
  it("two authless connections coexist — distinct keys, no 4005, no onKicked", () => {
    const onKicked = vi.fn();
    // Concurrent opt-out config: single-connection enforcement OFF + the
    // UNIQUE key seam. Even with the enforcement flag ON the unique keys
    // would keep the kick branch unreachable — asserted here belt-and-braces.
    const registry = new ConnectionRegistry({
      config: { ...DEFAULT_CONNECTION_CONFIG, singleConnectionPerUser: false },
      onKicked,
    });
    const pingPong = fakePingPong();
    const upgrade = vi.fn();

    const handler = new ConnectionHandler({
      // No verifyOrchestrator → authless path. UNIQUE key seam → no collide.
      authlessKey: createAuthlessKeyFactory(),
      registry,
      pingPong: pingPong as unknown as WsPingPong,
      rpcHandler: { upgrade },
    });

    const a = fakeWs();
    const b = fakeWs();
    const fakeReq = {} as Parameters<typeof handler.handle>[1];

    handler.handle(a.ws, fakeReq);
    handler.handle(b.ws, fakeReq);

    // Neither socket is kicked; nobody is replaced.
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    expect(onKicked).not.toHaveBeenCalled();

    // TWO distinct entries under the unique authless keys (authless#1/#2).
    expect(registry.size()).toBe(2);
    const keys = [...registry.entries()].map((e) => e.key);
    expect(keys).toEqual(["authless#1", "authless#2"]);
    expect(new Set(keys).size).toBe(2);

    // Both upgraded with the EMPTY authless context as consumers observe
    // it (no string keys) + the symbol-keyed identity stamp — same
    // contract as the single-connection default above.
    expect(upgrade).toHaveBeenCalledTimes(2);
    const sockets = [a.ws, b.ws];
    upgrade.mock.calls.forEach((call, i) => {
      const ctx = (call[1] as { context: Record<string, unknown> }).context;
      expect(Object.keys(ctx)).toEqual([]);
      expect(getConnectionWs(ctx)).toBe(sockets[i]);
    });
  });
});
