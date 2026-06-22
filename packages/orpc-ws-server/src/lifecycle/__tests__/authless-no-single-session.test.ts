// REGRESSION (foot-gun): authless connections must NOT kick each other.
//
// The bug this guards against: the connection registry keys every
// connection by a string. Authless connections carry no user, so a naive
// key (`JSON.stringify(user)` → `JSON.stringify(undefined)` → the literal
// `"undefined"`) would collapse EVERY authless connection to one map
// entry. With `singleConnectionPerUser` on, the second connection would
// then close the first with code 4005 ("session replaced") — every
// authless client would kick every other one.
//
// The fix, asserted here:
//   - the connection handler in authless mode mints a UNIQUE registry key
//     per connection (injected monotonic counter — `authlessKey`), so two
//     authless connections land under DISTINCT keys and the registry
//     holds TWO entries.
//   - NEITHER WS is closed with the session-replaced code (4005).
//
// Unit-level + deterministic (CLAUDE.md "Tests from day 0"): a REAL
// `ConnectionRegistry` (so the keying is genuinely exercised) with fake
// WS / pingPong / rpcHandler collaborators.

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";

import { ConnectionHandler } from "../connection-handler.js";
import { ConnectionRegistry } from "../../state/connection-registry.js";
import { createAuthlessKeyFactory } from "../../state/authless-key.js";
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

describe("authless: connections do not kick each other (foot-gun regression)", () => {
  it("two authless connections coexist — distinct keys, no 4005 close", () => {
    // singleConnectionPerUser ON: this is the dangerous config. The
    // unique-key seam must make the kick branch unreachable anyway.
    const registry = new ConnectionRegistry({
      config: { ...DEFAULT_CONNECTION_CONFIG, singleConnectionPerUser: true },
    });
    const pingPong = fakePingPong();
    const upgrade = vi.fn();

    const handler = new ConnectionHandler({
      // No verifyOrchestrator → authless path.
      authlessKey: createAuthlessKeyFactory(),
      registry,
      // The fake structurally matches the bits the handler touches.
      pingPong: pingPong as unknown as WsPingPong,
      rpcHandler: { upgrade },
    });

    const a = fakeWs();
    const b = fakeWs();

    // `req` is unused on the authless path — the handler never reads it.
    const fakeReq = {} as Parameters<typeof handler.handle>[1];
    handler.handle(a.ws, fakeReq);
    handler.handle(b.ws, fakeReq);

    // Foot-gun would have closed `a` with 4005 here. It must NOT.
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();

    // The registry holds TWO distinct entries under distinct keys.
    expect(registry.size()).toBe(2);
    const keys = [...registry.entries()].map((e) => e.key);
    expect(new Set(keys).size).toBe(2);

    // Both connections were upgraded with the EMPTY context (no user/token).
    expect(upgrade).toHaveBeenCalledTimes(2);
    for (const call of upgrade.mock.calls) {
      expect(call[1]).toEqual({ context: {} });
    }
  });
});
