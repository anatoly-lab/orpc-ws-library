// Regression — sync throw inside `handle()` must not leak registry state.
//
// `wss.on('connection', ...)` used to invoke `handle()` unguarded, and
// `handle()` itself had no rollback: a sync throw AFTER
// `registry.register` (traced examples: `rpcHandler.upgrade`'s sync step;
// `deriveConnectionKey`'s `JSON.stringify(user)` on a circular `TUser`
// throws BEFORE register) left two failure modes:
//
//   1. The throw escaped ws's unwrapped 'connection' emit — in AUTHLESS
//      mode as a genuine uncaughtException/process crash (the emit runs
//      synchronously inside the HTTP 'upgrade' emit); in AUTHED mode it
//      propagated into the verify orchestrator's `.then`, was swallowed
//      by its `.catch` (misleading "consumer verify threw" log), and
//      double-fired the ws verify callback → abortHandshake wrote a raw
//      HTTP/1.1 500 onto the already-upgraded (101) socket — protocol
//      garbage, not a crash. The composition-root guard in index.ts now
//      owns both; covered by the integration test
//      `sync-throw-fail-closed.test.ts`.
//   2. A PERMANENTLY leaked registry entry whose 'close' handler was
//      never wired (`wireLifecycle` didn't run), so nothing could ever
//      unregister it.
//
// Pinned here at the unit level: handle() rethrows (fail loud to the
// composition-root guard) but rolls back everything it wired — registry
// entry, ping/pong registration, bidi mux — and the handler stays
// functional for the next connection. Fakes mirror
// connection-handler-bidi.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";

import { ConnectionHandler } from "../connection-handler.js";
import {
  VerifyClientOrchestrator,
  type VerifyClientResult,
} from "../verify-client-orchestrator.js";
import { ConnectionRegistry } from "../../state/connection-registry.js";
import {
  createSingleAuthlessKey,
  SINGLE_AUTHLESS_KEY,
} from "../../state/authless-key.js";
import { DEFAULT_CONNECTION_CONFIG } from "../../config/connection-config.js";
import type { WsPingPong } from "../../heartbeat/ws-ping-pong.js";

/** Fake ws — the handler only calls `on` / `close` in these scenarios. */
function fakeWs(): WebSocket {
  return {
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket;
}

/** Fake ping/pong with observable register/unregister. */
function fakePingPong(): WsPingPong & {
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
} {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as WsPingPong & {
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
  };
}

/**
 * Prime an orchestrator's WeakMap for `req` the same way `ws` does —
 * through the verifyClient callback (mirrors connection-handler-bidi.test.ts).
 */
async function primedOrchestrator<TUser>(
  result: VerifyClientResult<TUser>,
  req: IncomingMessage,
): Promise<VerifyClientOrchestrator<TUser>> {
  const orch = new VerifyClientOrchestrator<TUser>(async () => result);
  await new Promise<void>((resolve) => {
    orch.buildWsVerifyClient()({ origin: "", secure: false, req }, () =>
      resolve(),
    );
  });
  return orch;
}

function fakeReq(): IncomingMessage {
  return { headers: {}, url: "/ws?token=t", socket: {} } as IncomingMessage;
}

describe("ConnectionHandler — sync throw rollback", () => {
  it("characterization — circular TUser (deriveConnectionKey throws): handle() throws BEFORE register, nothing leaks", async () => {
    // CHARACTERIZATION, not a regression pin: this throw predates
    // `registry.register`, so there was never anything to leak and this
    // test passes pre-fix too. It documents the pre-register throw path
    // (fail loud, state untouched); the register-then-throw cases below
    // are the actual rollback regression pins.
    //
    // No connectionKey → deriveConnectionKey falls back to
    // JSON.stringify(user), which throws on a circular structure.
    const circular: Record<string, unknown> = { sub: "u1" };
    circular.self = circular;
    const req = fakeReq();
    const orch = await primedOrchestrator<Record<string, unknown>>(
      { ok: true, user: circular },
      req,
    );

    const registry = new ConnectionRegistry({ config: DEFAULT_CONNECTION_CONFIG });
    const pingPong = fakePingPong();
    const upgrade = vi.fn();
    const handler = new ConnectionHandler<Record<string, unknown>>({
      verifyOrchestrator: orch,
      registry,
      pingPong,
      rpcHandler: { upgrade },
    });

    // Fail loud — the composition root's 'connection' guard (index.ts)
    // catches, logs, and closes the socket.
    expect(() => handler.handle(fakeWs(), req)).toThrow();

    // The throw predates register: no entry, no pump, no ping/pong.
    expect(registry.size()).toBe(0);
    expect(upgrade).not.toHaveBeenCalled();
    expect(pingPong.register).not.toHaveBeenCalled();

    // The handler object itself is unpoisoned: a well-behaved user on a
    // fresh req connects fine.
    const goodReq = fakeReq();
    const goodOrch = await primedOrchestrator<Record<string, unknown>>(
      { ok: true, user: { sub: "u2" }, connectionKey: "u2" },
      goodReq,
    );
    const goodHandler = new ConnectionHandler<Record<string, unknown>>({
      verifyOrchestrator: goodOrch,
      registry,
      pingPong,
      rpcHandler: { upgrade },
    });
    goodHandler.handle(fakeWs(), goodReq);
    expect(registry.size()).toBe(1);
  });

  it("upgrade throws AFTER register: rethrows, rolls the registry entry back, unregisters ping/pong, disposes bidi", async () => {
    const req = fakeReq();
    const orch = await primedOrchestrator<{ sub: string }>(
      { ok: true, user: { sub: "u1" }, connectionKey: "u1" },
      req,
    );

    const registry = new ConnectionRegistry({ config: DEFAULT_CONNECTION_CONFIG });
    const pingPong = fakePingPong();
    // Throws on the FIRST connection only — the second must succeed,
    // proving the handler (and registry) survive the failure.
    const upgrade = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("sync throw in upgrade");
      });
    const disposeBidi = vi.fn();
    const handler = new ConnectionHandler<{ sub: string }>({
      verifyOrchestrator: orch,
      registry,
      pingPong,
      rpcHandler: { upgrade },
      createBidi: (ws) => ({ c2sSocket: ws, client: {}, dispose: disposeBidi }),
    });

    const ws = fakeWs();
    expect(() => handler.handle(ws, req)).toThrow("sync throw in upgrade");

    // THE regression: without rollback this entry leaked forever (its
    // unregistering 'close' handler was never wired).
    expect(registry.size()).toBe(0);
    expect(registry.get("u1")).toBeUndefined();
    // Partial wiring is undone too.
    expect(pingPong.unregister).toHaveBeenCalledWith(ws);
    expect(disposeBidi).toHaveBeenCalledTimes(1);

    // Next connection (same key — a retry) lands cleanly.
    const retryReq = fakeReq();
    const retryOrch = await primedOrchestrator<{ sub: string }>(
      { ok: true, user: { sub: "u1" }, connectionKey: "u1" },
      retryReq,
    );
    const retryHandler = new ConnectionHandler<{ sub: string }>({
      verifyOrchestrator: retryOrch,
      registry,
      pingPong,
      rpcHandler: { upgrade },
    });
    retryHandler.handle(fakeWs(), retryReq);
    expect(registry.size()).toBe(1);
    expect(registry.get("u1")).toBeDefined();
  });

  it("authless (default constant key): upgrade throws AFTER register — rollback frees the key, retry under the SAME key succeeds", () => {
    const registry = new ConnectionRegistry({ config: DEFAULT_CONNECTION_CONFIG });
    const pingPong = fakePingPong();
    const upgrade = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("sync throw in upgrade");
      });
    const handler = new ConnectionHandler<never>({
      // No verifyOrchestrator → authless path. The DEFAULT authless
      // sub-mode (single global connection) keys EVERY socket by the one
      // constant `SINGLE_AUTHLESS_KEY` — the mode where a leaked entry
      // would be worst: it would poison the only key there is, phantom-
      // kicking (4005) every future connection against a dead socket.
      authlessKey: createSingleAuthlessKey(),
      registry,
      pingPong,
      rpcHandler: { upgrade },
    });

    const ws = fakeWs();
    expect(() => handler.handle(ws, fakeReq())).toThrow("sync throw in upgrade");
    expect(registry.size()).toBe(0);
    expect(pingPong.unregister).toHaveBeenCalledWith(ws);

    // Retry under the SAME constant key lands cleanly — the rollback
    // freed it, so the new register finds no stale entry to collide with.
    handler.handle(fakeWs(), fakeReq());
    expect(registry.size()).toBe(1);
    expect(registry.get(SINGLE_AUTHLESS_KEY)).toBeDefined();
  });
});
