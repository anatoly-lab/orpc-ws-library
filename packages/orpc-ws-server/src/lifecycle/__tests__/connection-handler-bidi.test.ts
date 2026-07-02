// ConnectionHandler — server→client bidi interposition (Phase 5a), unit level.
//
// The integration suite (`__tests__/integration/bidi-connection.test.ts`) proves
// the AUTHED path end-to-end. These unit tests fill the two gaps that the
// integration test can only assert indirectly:
//
//   1. The AUTHLESS path (`handleAuthless`) duplicates the bidi interposition
//      and was previously only TYPE-tested. We prove at runtime that an
//      authless connection WITH a `clientContract` (a fake `createBidi`)
//      interposes the mux, stashes the `client` on the registry + the conn,
//      and carries NO `user`. Mirrors the authed-path assertions.
//
//   2. The OFF case, BY IDENTITY: with NO `createBidi` (bidi off), the handler
//      hands the RAW `ws` to `rpcHandler.upgrade` — the byte-identical
//      non-bidi guarantee. A spy `rpcHandler` lets us inspect the first arg
//      directly (the integration test can only infer this via `conn.client`
//      absence).
//
// Isolated + deterministic (CLAUDE.md "Tests from day 0"): a REAL
// `ConnectionRegistry` (so the keying + `client` storage are genuinely
// exercised) with fake ws / pingPong / rpcHandler, and — for the authless case
// — a fake `createBidi` returning sentinel facade + client.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";

import { ConnectionHandler } from "../connection-handler.js";
import { getConnectionWs } from "../../state/connection-identity.js";
import {
  VerifyClientOrchestrator,
  type VerifyClientResult,
} from "../verify-client-orchestrator.js";
import { ConnectionRegistry } from "../../state/connection-registry.js";
import { createAuthlessKeyFactory } from "../../state/authless-key.js";
import { DEFAULT_CONNECTION_CONFIG } from "../../config/connection-config.js";
import type { WsPingPong } from "../../heartbeat/ws-ping-pong.js";

interface TestUser {
  sub: string;
}

/**
 * Fake ws: records `close`, registers `on('close'|'error')` listeners, and can
 * fire the 'close' listener like `ws` would. Mirrors the api-4 test's fake.
 */
function fakeWs(): {
  ws: WebSocket;
  close: ReturnType<typeof vi.fn>;
  emitClose: (code: number) => void;
} {
  const close = vi.fn();
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const ws = {
    close,
    on: (event: string, cb: (...args: never[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
  };
  return {
    ws: ws as unknown as WebSocket,
    close,
    emitClose: (code: number) => {
      for (const cb of listeners.get("close") ?? []) {
        (cb as (code: number, reason: Buffer) => void)(code, Buffer.alloc(0));
      }
    },
  };
}

/** Fake ping/pong — the handler only calls register/unregister. */
function fakePingPong(): WsPingPong {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as WsPingPong;
}

describe("ConnectionHandler — server→client bidi interposition", () => {
  it("authless + clientContract: interposes the mux, stores client on conn + registry, no user", () => {
    const registry = new ConnectionRegistry({ config: DEFAULT_CONNECTION_CONFIG });
    const upgrade = vi.fn();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();

    // Sentinels stand in for the real mux facade + typed caller.
    const c2sFacade = { __c2sFacade: true } as unknown as WebSocket;
    const client = { notify: () => undefined };
    const dispose = vi.fn();
    const createBidi = vi.fn((_ws: WebSocket) => ({
      c2sSocket: c2sFacade,
      client,
      dispose,
    }));

    const handler = new ConnectionHandler<TestUser>({
      // No verifyOrchestrator → authless path.
      authlessKey: createAuthlessKeyFactory(),
      registry,
      pingPong: fakePingPong(),
      rpcHandler: { upgrade },
      createBidi,
      hooks: { onConnected, onDisconnected },
    });

    const a = fakeWs();
    // `req` is unused on the authless path.
    handler.handle(a.ws, {} as IncomingMessage);

    // The mux was built over the RAW ws.
    expect(createBidi).toHaveBeenCalledTimes(1);
    expect(createBidi).toHaveBeenCalledWith(a.ws);

    // upgrade ran over the c2s FACADE (not the raw ws), with the empty
    // authless context as consumers observe it (no string keys). The
    // symbol-keyed identity stamp carries the RAW ws — NOT the facade:
    // the raw socket is the connection's identity even under bidi.
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(upgrade.mock.calls[0]![0]).toBe(c2sFacade);
    expect(upgrade.mock.calls[0]![0]).not.toBe(a.ws);
    const upCtx = (
      upgrade.mock.calls[0]![1] as { context: Record<string, unknown> }
    ).context;
    expect(Object.keys(upCtx)).toEqual([]);
    expect(getConnectionWs(upCtx)).toBe(a.ws);

    // The registry entry carries the typed client (what getConnection reads).
    const key = [...registry.entries()][0]!.key;
    expect(registry.getEntry(key)?.client).toBe(client);

    // onConnected conn carries the client and NO user (authless).
    expect(onConnected).toHaveBeenCalledTimes(1);
    const conn = onConnected.mock.calls[0]![0] as {
      client?: unknown;
      user?: unknown;
    };
    expect(conn.client).toBe(client);
    expect(conn.user).toBeUndefined();

    // FIX 3c: the conn handed to onDisconnected also carries the client.
    a.emitClose(1000);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    const [discConn, code] = onDisconnected.mock.calls[0]! as [
      { client?: unknown },
      number,
    ];
    expect(discConn.client).toBe(client);
    expect(code).toBe(1000);
  });

  it("bidi OFF: rpcHandler.upgrade receives the RAW ws by identity (byte-identical path)", async () => {
    const result: VerifyClientResult<TestUser> = {
      ok: true,
      user: { sub: "u1" },
      connectionKey: "u1",
    };
    const orchestrator = new VerifyClientOrchestrator<TestUser>(
      async () => result,
    );
    const req = {
      headers: {},
      url: "/ws?token=t",
      socket: {},
    } as IncomingMessage;
    // Prime the WeakMap the same way `ws` does — through verifyClient.
    await new Promise<void>((resolve) => {
      orchestrator.buildWsVerifyClient()(
        { origin: "", secure: false, req },
        () => resolve(),
      );
    });

    const upgrade = vi.fn();
    const handler = new ConnectionHandler<TestUser>({
      verifyOrchestrator: orchestrator,
      registry: new ConnectionRegistry({ config: DEFAULT_CONNECTION_CONFIG }),
      pingPong: fakePingPong(),
      rpcHandler: { upgrade },
      // createBidi OMITTED → bidi off.
    });

    const a = fakeWs();
    handler.handle(a.ws, req);

    // No facade interposed: the RAW ws is upgraded, by identity.
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(upgrade.mock.calls[0]![0]).toBe(a.ws);
  });
});
