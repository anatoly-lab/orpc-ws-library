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

import {
  type Clock,
  type Logger,
  noopLogger,
  systemClock,
} from "@orpc-ws/shared";

import type { ConnectionConfig } from "../config/connection-config.js";
import type { ConnectionRegistry } from "../state/connection-registry.js";
import type { WsPingPong } from "../heartbeat/ws-ping-pong.js";

import { extractClientIp, extractToken } from "./request-helpers.js";
import { armTokenExpiryWatchdog } from "./token-expiry-watchdog.js";
import type {
  VerifyClientOrchestrator,
  VerifyClientResult,
} from "./verify-client-orchestrator.js";

/**
 * The ORPC context this handler hands to `upgrade()`.
 *
 * Two shapes, one per mode:
 *   - AUTHENTICATED — `{ user, token }` (the verified principal + the raw
 *     `?token=` literal the client sent).
 *   - AUTHLESS — `Record<never, never>` (the empty object `{}`): there is
 *     no authenticated principal, so the consumer's procedures receive an
 *     empty context. See `state/no-auth.ts` for WHY there is no user.
 */
export type AuthedContext<TUser> = { user: TUser; token: string | null };
export type AuthlessContext = Record<never, never>;

/**
 * Minimal structural type for the `RPCHandler` `upgrade` method. We
 * type-check just the bits we use — keeping `RPCHandler<TContext>`'s full
 * shape out of this file lets it stay framework-free of ORPC internals.
 *
 * The context is `AuthedContext<TUser> | AuthlessContext` so the SAME
 * handler bridge serves both modes; the connection handler picks which
 * one it builds based on whether a `verifyOrchestrator` was injected.
 */
export interface RpcHandlerLike<TUser> {
  upgrade(
    ws: WebSocket,
    opts: { context: AuthedContext<TUser> | AuthlessContext },
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
  /**
   * Pre-101 auth orchestrator. Present in AUTHENTICATED mode, ABSENT in
   * AUTHLESS mode. When absent, the handler skips all auth-result
   * retrieval / guards / token plumbing and upgrades with an empty
   * context — see the file header and `handleAuthless`.
   */
  verifyOrchestrator?: VerifyClientOrchestrator<TUser>;
  /**
   * AUTHLESS-only: produces a UNIQUE registry key per connection. The
   * composition root injects a monotonic counter (not `Math.random`/
   * `Date.now` — CLAUDE.md seam rule). REQUIRED whenever
   * `verifyOrchestrator` is absent: authless connections carry no user,
   * so without a unique key every connection would collapse to one map
   * entry and kick each other (the registry foot-gun).
   */
  authlessKey?: () => string;
  registry: ConnectionRegistry;
  pingPong: WsPingPong;
  rpcHandler: RpcHandlerLike<TUser>;
  hooks?: ConnectionHandlerHooks<TUser>;
  /**
   * Structural pick of the connection config (interface segregation —
   * the handler reads only the expiry-watchdog knobs). Optional with
   * back-compat defaults (`enforceTokenExpiry: false`, code 4001) so
   * existing call sites / tests are unaffected; the composition root
   * always passes the resolved config.
   */
  config?: Pick<ConnectionConfig, "enforceTokenExpiry" | "authFailedCloseCode">;
  /**
   * Injected clock for the API-4 token-expiry watchdog. Default
   * `systemClock`; tests pass a fake for deterministic expiry firing.
   */
  clock?: Clock;
  logger?: Logger;
}

export class ConnectionHandler<TUser> {
  private readonly verifyOrchestrator: VerifyClientOrchestrator<TUser> | undefined;
  private readonly authlessKey: (() => string) | undefined;
  private readonly registry: ConnectionRegistry;
  private readonly pingPong: WsPingPong;
  private readonly rpcHandler: RpcHandlerLike<TUser>;
  private readonly hooks: ConnectionHandlerHooks<TUser>;
  private readonly enforceTokenExpiry: boolean;
  private readonly authFailedCloseCode: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(deps: ConnectionHandlerDeps<TUser>) {
    this.verifyOrchestrator = deps.verifyOrchestrator;
    this.authlessKey = deps.authlessKey;
    this.registry = deps.registry;
    this.pingPong = deps.pingPong;
    this.rpcHandler = deps.rpcHandler;
    this.hooks = deps.hooks ?? {};
    this.enforceTokenExpiry = deps.config?.enforceTokenExpiry ?? false;
    this.authFailedCloseCode = deps.config?.authFailedCloseCode ?? 4001;
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * The `'connection'` event handler body. See file header for the sync
   * contract. Branches on mode: AUTHLESS (no orchestrator) skips every
   * auth step and upgrades with an empty context; AUTHENTICATED runs the
   * full verify-result retrieval / guards / token-plumbing pipeline.
   */
  handle(ws: WebSocket, req: IncomingMessage): void {
    if (!this.verifyOrchestrator) {
      this.handleAuthless(ws);
      return;
    }
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

    // API-4 token-expiry watchdog (opt-in, default off). Scheduling is
    // sync (clock.setTimeout), so the file-header sync contract holds.
    // The verifier surfaced `expiresAt` in epoch ms (same unit as
    // `clock.now()`); a token already past expiry gets a 0ms timer —
    // verifyClient accepted it, so `exp` skew is the verifier's call,
    // not ours to second-guess.
    //
    // `armTokenExpiryWatchdog` owns the 32-bit-ceiling re-arm logic (see
    // that module). The canceller it returns is threaded into
    // `wireLifecycle` as `clearExpiryTimer`, so the 'close' handler — the
    // same teardown path that unregisters ping/pong — clears whichever
    // (possibly re-armed) segment is currently pending. When the watchdog
    // is off, `clearExpiryTimer` stays the no-op below.
    const clearExpiryTimer =
      this.enforceTokenExpiry && typeof auth.expiresAt === "number"
        ? armTokenExpiryWatchdog(
            {
              clock: this.clock,
              authFailedCloseCode: this.authFailedCloseCode,
              logger: this.logger,
            },
            { ws, expiresAt: auth.expiresAt, connectionKey },
          )
        : () => {
            // No expiry watchdog armed — nothing to clear.
          };

    this.wireLifecycle({
      ws,
      connectionKey,
      user,
      clientIp,
      clearExpiryTimer,
    });
  }

  /**
   * AUTHLESS connection path. Mirrors `handle` but with NO auth: no
   * verify-result lookup, no token plumbing, no expiry watchdog. The
   * ORPC context is the EMPTY object `{}` (see `state/no-auth.ts`).
   *
   * The registry key comes from the injected unique-key seam so authless
   * connections never collide — without it `singleConnectionPerUser`
   * would collapse every authless socket to one entry and they'd kick
   * each other. (`singleConnectionPerUser` is also forced off for
   * authless at the composition root, so the kick branch is unreachable
   * regardless; the unique key is belt-and-suspenders + a meaningful
   * registry key for `entries()`/diagnostics.)
   *
   * The same sync contract as `handle` applies up to `upgrade()`.
   */
  private handleAuthless(ws: WebSocket): void {
    // The unique-key seam is REQUIRED in authless mode (the composition
    // root always injects it). We do NOT fall back to a `Date.now()`/
    // random key — that would (a) violate the injected-seam rule
    // (CLAUDE.md "Zero `Date.now()` … outside an injected seam") and
    // (b) reopen the collision foot-gun under a clock with low
    // resolution. A missing seam is a wiring bug: fail loud.
    if (!this.authlessKey) {
      this.logger.error(
        "connection-handler: authless mode without an authlessKey seam",
      );
      try {
        ws.close(1011, "Internal server error");
      } catch {
        // best-effort
      }
      return;
    }
    const connectionKey = this.authlessKey();

    // No authenticated user — the registry stores `undefined` under a
    // unique key purely for bookkeeping. `NoAuth` (uninhabited) is the
    // STATIC type the lifecycle hooks see; at runtime there is no user.
    const noUser = undefined as unknown as TUser;

    this.registry.register(connectionKey, ws, noUser);

    // Empty context — the consumer's procedures run with `{}`. Same
    // non-awaited upgrade as the authed path (promise resolves on
    // disconnect; the 'close' handler does cleanup).
    void this.rpcHandler.upgrade(ws, { context: {} });

    this.pingPong.register(ws, noUser);

    this.wireLifecycle({
      ws,
      connectionKey,
      user: noUser,
      clientIp: undefined,
      clearExpiryTimer: () => {
        // No expiry watchdog in authless mode — nothing to clear.
      },
    });
  }

  /**
   * Shared `'close'` / `'error'` wiring + the connect log + `onConnected`
   * hook, used by BOTH the authed and authless paths. Kept synchronous
   * (no `await`) so it respects the file-header sync contract when called
   * from `handle` before the message pump is drained.
   *
   * `clearExpiryTimer` is the only mode-specific bit — the authed path
   * passes a real clear, authless passes a no-op.
   */
  private wireLifecycle(args: {
    ws: WebSocket;
    connectionKey: string;
    user: TUser;
    clientIp: string | undefined;
    clearExpiryTimer: () => void;
  }): void {
    const { ws, connectionKey, user, clientIp, clearExpiryTimer } = args;

    ws.on("close", (code, reason: Buffer) => {
      clearExpiryTimer();
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
