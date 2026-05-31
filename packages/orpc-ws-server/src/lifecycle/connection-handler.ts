// Handles the `ws.WebSocketServer` 'connection' event.
//
// CRITICAL CONTRACT — Bug 5 server side:
//
// Everything between `'connection'` firing and `rpcHandler.upgrade(ws,
// {context})` returning must be SYNCHRONOUS. If we `await` anywhere in
// that window, the client (which received the 101 response and fires
// `open` immediately) can send its first ORPC message BEFORE
// `upgrade()` attaches message handlers — and that first message is
// silently dropped.
//
// The source gateway proved this is possible. The fix landed there as
// "auth in verifyClient, sync 'connection' handler"; we preserve the
// pattern verbatim:
//
//   1. Auth result already retrievable from VerifyClientOrchestrator
//      (the WeakMap was populated pre-101).
//   2. Connection key derivation: sync.
//   3. Registry register (which may close an old WS): sync. The kicked
//      WS's `close()` is itself sync at the JS level — the underlying
//      socket teardown is async but does not block.
//   4. `rpcHandler.upgrade(ws, {context})`: sync (ORPC pulls the WS
//      through a single sync step that attaches `message` handlers; any
//      promise it returns describes background draining, not handshake).
//   5. Ping/pong register: sync.
//   6. `'close'` / `'error'` handlers attached: sync.
//   7. `onConnected` hook fires LAST so it can't have side effects
//      racing the message pump (a misbehaving hook still shouldn't
//      break us — we wrap in try/catch).
//
// rpcHandler.upgrade returns a Promise, but we do not `await` it. The
// promise resolves when the WS disconnects; the source app left it
// dangling for the same reason. We mark it with `void` to satisfy the
// linter.

import type { IncomingMessage } from "http";

import type { WebSocket } from "ws";

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type { ConnectionRegistry } from "../state/connection-registry.js";
import type { WsPingPong } from "../heartbeat/ws-ping-pong.js";

import { extractClientIp, extractToken } from "./request-helpers.js";
import type {
  VerifyClientOrchestrator,
  VerifyClientResult,
} from "./verify-client-orchestrator.js";

/**
 * Minimal structural type for the `RPCHandler` `upgrade` method. We
 * type-check just the bits we use — keeping `RPCHandler<TContext>`'s full
 * shape out of this file lets it stay framework-free of ORPC internals.
 */
export interface RpcHandlerLike<TUser> {
  upgrade(
    ws: WebSocket,
    opts: { context: { user: TUser; token: string | null } },
  ): void | Promise<unknown>;
}

/**
 * Lifecycle hooks the composition root forwards into the handler.
 *
 * `onConnected` / `onDisconnected` are typed-user hooks. `onKicked` is
 * on the registry directly (different timing).
 */
export interface ConnectionHandlerHooks<TUser> {
  onConnected?: (user: TUser, ws: WebSocket) => void;
  onDisconnected?: (user: TUser, code: number, ws: WebSocket) => void;
}

export interface ConnectionHandlerDeps<TUser> {
  verifyOrchestrator: VerifyClientOrchestrator<TUser>;
  registry: ConnectionRegistry;
  pingPong: WsPingPong;
  rpcHandler: RpcHandlerLike<TUser>;
  hooks?: ConnectionHandlerHooks<TUser>;
  logger?: Logger;
}

export class ConnectionHandler<TUser> {
  private readonly verifyOrchestrator: VerifyClientOrchestrator<TUser>;
  private readonly registry: ConnectionRegistry;
  private readonly pingPong: WsPingPong;
  private readonly rpcHandler: RpcHandlerLike<TUser>;
  private readonly hooks: ConnectionHandlerHooks<TUser>;
  private readonly logger: Logger;

  constructor(deps: ConnectionHandlerDeps<TUser>) {
    this.verifyOrchestrator = deps.verifyOrchestrator;
    this.registry = deps.registry;
    this.pingPong = deps.pingPong;
    this.rpcHandler = deps.rpcHandler;
    this.hooks = deps.hooks ?? {};
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * The `'connection'` event handler body. See file header for the sync
   * contract.
   */
  handle(ws: WebSocket, req: IncomingMessage): void {
    const auth = this.verifyOrchestrator.getAuthForRequest(req);

    // Defensive: this shouldn't be possible if the WSS was constructed
    // with our orchestrator's verifyClient — every accepted upgrade went
    // through it. If it does happen, close hard and bail.
    if (!auth) {
      this.logger.error(
        "connection-handler: no auth result for accepted upgrade",
      );
      try {
        ws.close(1011, "Internal server error");
      } catch {
        // best-effort
      }
      return;
    }

    // Equally defensive: verifyClient should have rejected pre-101 for
    // !ok results. Treat as a hard internal error.
    if (!auth.ok) {
      this.logger.error("connection-handler: !ok auth reached connection", {
        code: auth.code,
      });
      try {
        ws.close(auth.code, auth.reason);
      } catch {
        // best-effort
      }
      return;
    }

    const connectionKey = this.deriveConnectionKey(auth);
    const user = auth.user;
    // verifyOrchestrator's URL parser already produced this; we don't
    // re-extract here. Token is the SAME literal the client sent, so
    // consumers using it in context (e.g. proxying to upstream services)
    // get the original.
    const token = extractToken(req);
    // Match the orchestrator's `clientIp` shape so the verify-time
    // "rejected" log and the connect-time "client connected" log
    // surface consistent values for the same request.
    const clientIp = extractClientIp(req);

    // Sync from here to `upgrade()` — see file header.
    this.registry.register(connectionKey, ws, user);

    // RPCHandler.upgrade returns a Promise<unknown> that resolves on WS
    // disconnect. We intentionally do NOT await it: doing so would block
    // this handler indefinitely. The 'close' handler below takes care of
    // cleanup. The `void` discards the dangling promise for the linter's
    // peace of mind.
    void this.rpcHandler.upgrade(ws, { context: { user, token } });

    if (this.pingPong) {
      this.pingPong.register(ws, user);
    }

    ws.on("close", (code, reason: Buffer) => {
      // `reason` arrives as a Buffer from `ws`; decode for human-readable
      // log output. Empty buffer → `undefined` so structured-log viewers
      // render the field as absent rather than an ambiguous empty string
      // (matches how `clientIp` is logged on connect).
      const reasonStr = reason.length > 0 ? reason.toString() : undefined;
      this.logger.info("connection-handler: client disconnected", {
        connectionKey,
        code,
        reason: reasonStr,
      });
      this.registry.unregisterIfSame(connectionKey, ws);
      this.pingPong.unregister(ws);
      if (this.hooks.onDisconnected) {
        try {
          this.hooks.onDisconnected(user, code, ws);
        } catch (err) {
          this.logger.error("connection-handler: onDisconnected hook threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    ws.on("error", (err: Error) => {
      this.logger.error("connection-handler: ws error", { error: err.message });
    });

    // Log AFTER the sync-critical pipeline (registry / upgrade / pingPong /
    // close+error handlers) is in place but BEFORE the consumer's
    // onConnected hook — that way the log lands even if the hook throws,
    // and we don't pay logger latency inside the message-pump-attach
    // window.
    this.logger.info("connection-handler: client connected", {
      connectionKey,
      clientIp,
    });

    if (this.hooks.onConnected) {
      try {
        this.hooks.onConnected(user, ws);
      } catch (err) {
        this.logger.error("connection-handler: onConnected hook threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Connection key for the registry. Prefers the consumer-supplied
   * `connectionKey`; falls back to `JSON.stringify(user)` for the
   * coarse case. JSON.stringify gives a stable string per equal user
   * record — fine when the consumer's `TUser` is JSON-serializable.
   *
   * If `TUser` is not JSON-serializable (e.g. carries a Map or Date),
   * the consumer should always provide `connectionKey`. We don't enforce
   * — the source app's user is a flat record and works with the default.
   */
  private deriveConnectionKey(
    auth: Extract<VerifyClientResult<TUser>, { ok: true }>,
  ): string {
    return auth.connectionKey ?? JSON.stringify(auth.user);
  }

}
