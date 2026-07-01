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
 * The connection handle the handler builds and passes to the lifecycle hooks.
 *
 * INTERNAL, non-conditional shape (`client?: unknown`): the public, typed,
 * `client`-conditional `ServerConnection` / `AuthlessConnection` views live in
 * `state/connection.ts` and are applied at the composition seam (`index.ts`
 * casts the public hook into this shape). Keeping the handler's own conn flat
 * means the handler never has to construct a conditional-typed value.
 */
export interface HandlerConnection<TUser> {
  readonly key: string;
  readonly user: TUser;
  readonly ws: WebSocket;
  /** The bidi server→client caller — present only when bidi is on. */
  readonly client?: unknown;
}

/**
 * Per-connection bidi wiring the handler interposes when bidi is on. Supplied
 * by `createBidi` (injected only by a bidi-enabled composition root). Mirrors
 * `ConnectionBidi` from `bidi/connection-bidi.ts` but with `client` widened to
 * `unknown` (the handler is generic only over `TUser`).
 */
export interface ConnectionHandlerBidi {
  readonly c2sSocket: WebSocket;
  readonly client?: unknown;
  dispose(): void;
}

/**
 * Lifecycle hooks the composition root forwards into the handler.
 *
 * `onConnected` / `onDisconnected` receive the single {@link HandlerConnection}
 * handle (NOT positional `user` / `ws` args). `onKicked` is on the registry
 * directly (different timing).
 */
export interface ConnectionHandlerHooks<TUser> {
  onConnected?: (conn: HandlerConnection<TUser>) => void;
  onDisconnected?: (conn: HandlerConnection<TUser>, code: number) => void;
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
   * AUTHLESS-only: produces the registry key for each connection. The
   * composition root injects one of two deterministic seams (never
   * `Math.random`/`Date.now` — CLAUDE.md seam rule) depending on the
   * authless sub-mode:
   *   - DEFAULT (single global connection): a CONSTANT key, so every
   *     socket collides and a new connection kicks the previous (`4005`).
   *   - `allowConcurrentConnections`: a UNIQUE monotonic key per
   *     connection, so authless sockets coexist without kicking.
   * REQUIRED whenever `verifyOrchestrator` is absent (authless carries no
   * user, so there is no verify-supplied key to fall back to).
   */
  authlessKey?: () => string;
  registry: ConnectionRegistry;
  pingPong: WsPingPong;
  rpcHandler: RpcHandlerLike<TUser>;
  /**
   * Per-connection bidi factory. Injected ONLY when the server opted into bidi
   * (a `clientContract` was supplied). ABSENT for a non-bidi server — and its
   * absence is what makes the non-bidi path byte-identical to the pre-bidi
   * server: the handler upgrades the raw `ws`, stores no `client`, and runs no
   * mux teardown. When present, the handler interposes the c2s facade, stashes
   * the `client`, and disposes the bidi on close.
   */
  createBidi?: (ws: WebSocket) => ConnectionHandlerBidi;
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
  private readonly createBidi: ((ws: WebSocket) => ConnectionHandlerBidi) | undefined;
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
    this.createBidi = deps.createBidi;
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

    // Bidi interposition (sync) — see `setupConnectionTransport`. When bidi is
    // off, `c2sSocket` is the RAW `ws` and there is no `client`/`disposeBidi`.
    const { c2sSocket, client, disposeBidi } =
      this.setupConnectionTransport(ws);

    // Sync from here to `upgrade()` — see file header.
    this.registry.register(connectionKey, ws, user, client);

    // RPCHandler.upgrade returns a Promise<unknown> that resolves on WS
    // disconnect. We intentionally do NOT await it: doing so would block
    // this handler indefinitely. The 'close' handler below takes care of
    // cleanup. The `void` discards the dangling promise for the linter's
    // peace of mind.
    void this.rpcHandler.upgrade(c2sSocket, { context: { user, token } });

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
      client,
      disposeBidi,
    });
  }

  /**
   * AUTHLESS connection path. Mirrors `handle` but with NO auth: no
   * verify-result lookup, no token plumbing, no expiry watchdog. The
   * ORPC context is the EMPTY object `{}` (see `state/no-auth.ts`).
   *
   * The registry key comes from the injected authless key seam. In the
   * DEFAULT single-global-connection mode that seam is CONSTANT, so a new
   * connection collides with the previous one and `singleConnectionPerUser`
   * (ON by default in authless) kicks it (`4005`). Under
   * `allowConcurrentConnections` the seam is a unique monotonic key so
   * sockets coexist and the kick branch stays unreachable. Either way the
   * key is deterministic (no `Date.now()`/random — CLAUDE.md seam rule).
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

    // Bidi interposition — identical to the authed path; authless supports
    // server→client RPC too (the conn just carries no user). Off → raw `ws`.
    const { c2sSocket, client, disposeBidi } =
      this.setupConnectionTransport(ws);

    this.registry.register(connectionKey, ws, noUser, client);

    // Empty context — the consumer's procedures run with `{}`. Same
    // non-awaited upgrade as the authed path (promise resolves on
    // disconnect; the 'close' handler does cleanup).
    void this.rpcHandler.upgrade(c2sSocket, { context: {} });

    this.pingPong.register(ws, noUser);

    this.wireLifecycle({
      ws,
      connectionKey,
      user: noUser,
      clientIp: undefined,
      clearExpiryTimer: () => {
        // No expiry watchdog in authless mode — nothing to clear.
      },
      client,
      disposeBidi,
    });
  }

  /**
   * Build the per-connection transport, shared by BOTH the authed (`handle`)
   * and authless (`handleAuthless`) paths — the ONLY mode difference is the
   * ORPC context built at each call site, so it stays there.
   *
   * When the server opted into bidi (`createBidi` injected), this builds the
   * per-connection multiplexer: `upgrade()` runs over the c2s `ChanneledSocket`
   * facade, `client` is the typed server→client caller, and `disposeBidi` tears
   * the mux down on close. When bidi is OFF (`createBidi` absent), `c2sSocket`
   * is the RAW `ws` (no cast, no mux) and there is no `client`/`disposeBidi` —
   * so the non-bidi path is byte-identical to the pre-bidi server.
   */
  private setupConnectionTransport(ws: WebSocket): {
    c2sSocket: WebSocket;
    client: unknown;
    disposeBidi: (() => void) | undefined;
  } {
    const bidi = this.createBidi?.(ws);
    return {
      c2sSocket: bidi ? bidi.c2sSocket : ws,
      client: bidi?.client,
      disposeBidi: bidi?.dispose,
    };
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
    client: unknown;
    disposeBidi: (() => void) | undefined;
  }): void {
    const {
      ws,
      connectionKey,
      user,
      clientIp,
      clearExpiryTimer,
      client,
      disposeBidi,
    } = args;

    // One conn handle, shared by onConnected + onDisconnected (same connection).
    const conn: HandlerConnection<TUser> = {
      key: connectionKey,
      user,
      ws,
      client,
    };

    ws.on("close", (code, reason: Buffer) => {
      clearExpiryTimer();
      // Bidi teardown. `disposeBidi` defers `mux.dispose()` to a microtask so
      // this synchronous 'close' fan-out — which includes the mux's own close
      // listener (→ s2c peer rejects pending server→client calls) — completes
      // FIRST. See `bidi/connection-bidi.ts` for the full ordering rationale.
      // No-op when bidi is off.
      disposeBidi?.();
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
          this.hooks.onDisconnected(conn, code);
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
        this.hooks.onConnected(conn);
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
