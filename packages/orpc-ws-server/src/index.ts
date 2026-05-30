// Public surface of @repo/orpc-ws-server.
//
// Phase 3 composition root. Wires every internal class to its
// collaborators and exposes the `OrpcWsServer` class.
//
// Lifecycle:
//   - constructor — assembles all internal collaborators, EAGERLY
//     asserts router-namespace non-collision, builds the RPCHandler.
//   - attach(httpServer) — creates the ws.WebSocketServer, starts the
//     heartbeat publisher + ping/pong watchdog.
//   - dispose() — stops watchdogs, closes all connections with the
//     configured shutdown code, closes the WebSocketServer.
//
// CLAUDE.md "No god files" — composition is the only place wires meet.
// Each internal class is single-purpose; the only logic here is
// resolving config merges and threading collaborators.
//
// Re-exports the user-facing types (`VerifyClient`, `VerifyClientResult`,
// `ConnectionConfig`, etc.) so consumers don't dig into sub-paths.

import type { Server as HttpServer } from "http";

import { RPCHandler } from "@orpc/server/ws";
import {
  WebSocketServer,
  type WebSocket,
  type Server as WebSocketServerType,
} from "ws";

import {
  type Clock,
  type Logger,
  noopLogger,
  systemClock,
} from "@repo/orpc-ws-shared";

import {
  type ConnectionConfig,
  DEFAULT_CONNECTION_CONFIG,
} from "./config/connection-config.js";
import {
  type HeartbeatConfig,
  DEFAULT_HEARTBEAT_CONFIG,
} from "./config/heartbeat-config.js";

import { ConnectionRegistry } from "./state/connection-registry.js";

import { HeartbeatPublisher } from "./heartbeat/publisher.js";
import { WsPingPong } from "./heartbeat/ws-ping-pong.js";
import { buildSystemRouter } from "./heartbeat/system-router.js";

import { composeRouter } from "./router/router-composer.js";

import {
  VerifyClientOrchestrator,
  type VerifyClient,
} from "./lifecycle/verify-client-orchestrator.js";
import {
  ConnectionHandler,
  type ConnectionHandlerHooks,
} from "./lifecycle/connection-handler.js";

import {
  type UploadHttpConfig,
  DEFAULT_UPLOAD_HTTP_CONFIG,
} from "./upload/http-config.js";
import {
  type HttpUploadHandler,
  createHttpUploadHandler,
} from "./upload/http-handler.js";

// ----- Public re-exports -----

export type {
  ConnectionConfig,
} from "./config/connection-config.js";
export { DEFAULT_CONNECTION_CONFIG } from "./config/connection-config.js";

export type {
  HeartbeatConfig,
} from "./config/heartbeat-config.js";
export { DEFAULT_HEARTBEAT_CONFIG } from "./config/heartbeat-config.js";

export type {
  VerifyClient,
  VerifyClientContext,
  VerifyClientResult,
} from "./lifecycle/verify-client-orchestrator.js";

export type { HeartbeatEvent } from "@repo/orpc-ws-shared";

// Logger seam + universal/Node-friendly bridges, re-exported so consumers
// stay on one import surface. `fromNestShape` lives only in the nestjs
// adapter package — server core is framework-free.
export type { Logger, PinoShape } from "@repo/orpc-ws-shared";
export {
  noopLogger,
  consoleLogger,
  fromPinoShape,
} from "@repo/orpc-ws-shared";

export type {
  UploadHttpConfig,
} from "./upload/http-config.js";
export { DEFAULT_UPLOAD_HTTP_CONFIG } from "./upload/http-config.js";
export type { HttpUploadHandler } from "./upload/http-handler.js";
export { extractBearerToken } from "./upload/http-verify.js";

// ----- Hook bundle -----

/**
 * Lifecycle hooks consumers wire into the server. All optional; all
 * receive typed `TUser` payloads.
 *
 * `onConnected` / `onDisconnected` are connection-lifecycle. `onKicked`
 * fires from the registry when a session is replaced. `onZombieTerminated`
 * fires from the ws-ping-pong watchdog.
 */
export interface OrpcWsServerHooks<TUser> {
  onConnected?: (user: TUser, ws: WebSocket) => void;
  onDisconnected?: (user: TUser, code: number, ws: WebSocket) => void;
  /**
   * `user` is the kicked user; `replacedBy` is the new live WS that
   * caused the kick.
   */
  onKicked?: (user: TUser, replacedBy: WebSocket) => void;
  /**
   * Fires after the watchdog terminates a zombie. `user` is the user
   * whose connection was terminated.
   */
  onZombieTerminated?: (user: TUser) => void;
}

// ----- Options -----

export interface OrpcWsServerOptions<TUser, TContract extends object> {
  /**
   * The consumer's ORPC router (plain object — top-level keys are
   * procedure names or sub-routers). The library spreads its own
   * `__orpc_ws_lib__` namespace into this; if a top-level key collides,
   * the `OrpcWsServer` constructor throws immediately.
   */
  router: TContract;
  /**
   * Pre-101 auth. Runs inside `ws`'s `verifyClient` callback — see
   * `VerifyClientOrchestrator` for the contract. Returns a discriminated
   * union: `{ok: true, user, connectionKey?}` to accept,
   * `{ok: false, code, reason}` to reject pre-upgrade.
   */
  verifyClient: VerifyClient<TUser>;
  /** Partial connection config overlay. */
  connection?: Partial<ConnectionConfig>;
  /** Partial heartbeat config overlay. */
  heartbeat?: Partial<HeartbeatConfig>;
  hooks?: OrpcWsServerHooks<TUser>;
  logger?: Logger;
  /** Test seam — fake clock. */
  clock?: Clock;
  /**
   * Opt-in HTTP transport for file uploads. When `enabled: true`, the
   * server builds a second `RPCHandler` (HTTP, from `@orpc/server/node`)
   * against the SAME composed router. Consumers reach it via
   * `getHttpHandler()` and mount it on their HTTP framework (or rely on
   * the NestJS adapter to mount it).
   *
   * Disabled by default. CLAUDE.md "Library scope" pins opt-in semantics.
   */
  uploads?: Partial<UploadHttpConfig>;
}

/**
 * Framework-free ORPC-over-WS server. The only thing it knows about
 * the host process is `http.Server` (passed to `attach()`).
 *
 * Consumers building NestJS / Fastify adapters wrap `attach()` in the
 * framework lifecycle hooks (`OnApplicationBootstrap` /
 * `BeforeApplicationShutdown` in Nest); the core stays decorator-free.
 */
export class OrpcWsServer<TUser, TContract extends object> {
  private readonly connectionConfig: ConnectionConfig;
  private readonly heartbeatConfig: HeartbeatConfig;
  private readonly logger: Logger;

  private readonly verifyOrchestrator: VerifyClientOrchestrator<TUser>;
  private readonly registry: ConnectionRegistry;
  private readonly publisher: HeartbeatPublisher;
  private readonly pingPong: WsPingPong;
  // RPCHandler is typed on the runtime context shape. We use a
  // permissive `Record<string, unknown>` here because the composed
  // router has heterogeneous keys (consumer's narrowed context +
  // library's empty context) — typing the union precisely would force
  // consumers to thread the library's empty-context noise through their
  // contract. The runtime is identical either way.
  private readonly rpcHandler: RPCHandler<Record<string, unknown>>;
  private readonly connectionHandler: ConnectionHandler<TUser>;
  /**
   * The HTTP upload handler bound to the composed router. `null` when
   * `uploads.enabled` is `false` (the default) — consumers should not
   * be able to reach into a "feature off" code path. See `getHttpHandler()`.
   */
  private readonly httpUploadHandler: HttpUploadHandler | null;
  /**
   * Resolved upload config — kept so `getUploadConfig()` can surface
   * the path/limits to adapters (the NestJS adapter needs the
   * `httpPath` for Express registration + the collision check).
   */
  private readonly uploadConfig: UploadHttpConfig;

  /** Set in `attach()`. Null until then; null after `dispose()`. */
  private wss: WebSocketServerType | null = null;
  private disposed = false;

  constructor(opts: OrpcWsServerOptions<TUser, TContract>) {
    // ----- 1. Resolve config / seams -----
    this.connectionConfig = {
      ...DEFAULT_CONNECTION_CONFIG,
      ...opts.connection,
    };
    this.heartbeatConfig = {
      ...DEFAULT_HEARTBEAT_CONFIG,
      ...opts.heartbeat,
    };
    this.logger = opts.logger ?? noopLogger;
    const clock: Clock = opts.clock ?? systemClock;
    const hooks = opts.hooks ?? {};

    // ----- 2. Verify orchestrator -----
    this.verifyOrchestrator = new VerifyClientOrchestrator<TUser>(
      opts.verifyClient,
      this.logger,
    );

    // ----- 3. Connection registry -----
    // onKicked from registry → forwarded with TUser cast. The registry
    // stores user as `unknown`; here at the composition seam we know
    // the type and re-narrow.
    this.registry = new ConnectionRegistry({
      config: this.connectionConfig,
      logger: this.logger,
      onKicked: hooks.onKicked
        ? (user, replacedBy) => hooks.onKicked?.(user as TUser, replacedBy)
        : undefined,
    });

    // ----- 4. Heartbeat publisher + WS-protocol watchdog -----
    this.publisher = new HeartbeatPublisher({
      config: this.heartbeatConfig,
      clock,
      logger: this.logger,
    });
    this.pingPong = new WsPingPong({
      config: this.heartbeatConfig,
      clock,
      logger: this.logger,
      onZombieTerminated: hooks.onZombieTerminated
        ? (user) => hooks.onZombieTerminated?.(user as TUser)
        : undefined,
    });

    // ----- 5. Compose router — EAGER collision check -----
    // composeRouter throws synchronously on `__orpc_ws_lib__` collision
    // in opts.router. Surfacing the bug here is the load-bearing
    // ergonomic decision (implementation-plan.md §3 "Key invariants").
    const systemRouter = buildSystemRouter(this.publisher);
    const composedRouter = composeRouter(opts.router, systemRouter);

    // ----- 6. ORPC RPC handler -----
    // RPCHandler is typed on `Router<any, Context>`; we pass our
    // composed router. The runtime contract is "plain object of
    // procedures and sub-routers" — what we built.
    this.rpcHandler = new RPCHandler(
      // RPCHandler's `router` param accepts `Router<any, T>`; the
      // composed router's structural shape satisfies that contract.
      // The cast names the seam — we accept the looser ORPC type here
      // intentionally to keep the consumer's `TContract` clean of
      // library-internals.
      composedRouter as never,
    );

    // ----- 6b. Optional HTTP upload handler -----
    // Same composed router as the WS handler — CLAUDE.md "Architectural
    // decisions for this phase": one router, two transports. The HTTP
    // handler is built only when `uploads.enabled` is true so the cost
    // (extra ORPC plugin instances, body-limit middleware, etc.) lands
    // only on consumers who opted in.
    this.uploadConfig = {
      ...DEFAULT_UPLOAD_HTTP_CONFIG,
      ...opts.uploads,
    };
    this.httpUploadHandler = this.uploadConfig.enabled
      ? createHttpUploadHandler<TUser>({
          composedRouter,
          verifyClient: opts.verifyClient,
          config: this.uploadConfig,
          logger: this.logger,
        })
      : null;

    // ----- 7. Connection handler -----
    const handlerHooks: ConnectionHandlerHooks<TUser> = {};
    if (hooks.onConnected) handlerHooks.onConnected = hooks.onConnected;
    if (hooks.onDisconnected) handlerHooks.onDisconnected = hooks.onDisconnected;
    this.connectionHandler = new ConnectionHandler<TUser>({
      verifyOrchestrator: this.verifyOrchestrator,
      registry: this.registry,
      pingPong: this.pingPong,
      // Bridge to the structural shape connection-handler expects.
      rpcHandler: {
        upgrade: (ws, opts2) => this.rpcHandler.upgrade(ws, { context: opts2.context }),
      },
      hooks: handlerHooks,
      logger: this.logger,
    });
  }

  /**
   * Attach to an existing HTTP server. Creates the WebSocketServer with
   * the configured path + verifyClient, wires the 'connection' handler,
   * starts heartbeat publisher + ping/pong watchdog.
   *
   * Calling attach() twice or after dispose() throws — the lifecycle is
   * single-shot.
   */
  attach(httpServer: HttpServer): void {
    if (this.disposed) {
      throw new Error("[orpc-ws-server] attach() after dispose() is not supported");
    }
    if (this.wss) {
      throw new Error("[orpc-ws-server] already attached");
    }

    this.wss = new WebSocketServer({
      server: httpServer,
      path: this.connectionConfig.path,
      verifyClient: this.verifyOrchestrator.buildWsVerifyClient(),
    });

    this.wss.on("connection", (ws, req) => {
      this.connectionHandler.handle(ws, req);
    });

    this.wss.on("error", (err: Error) => {
      this.logger.error("orpc-ws-server: wss error", { error: err.message });
    });

    this.publisher.start();
    this.pingPong.start();

    this.logger.info("orpc-ws-server: attached", {
      path: this.connectionConfig.path,
    });
  }

  /**
   * Returns the HTTP upload handler bound to the composed router, or
   * `null` if uploads is disabled.
   *
   * Bare-Node consumers mount it on their HTTP server (e.g.
   * `http.createServer((req, res) => handler(req, res))` when the URL
   * matches `uploads.httpPath`). The NestJS adapter mounts it on
   * Express in `OnApplicationBootstrap`.
   *
   * Returning `null` (rather than throwing) keeps the call site simple
   * for adapters that conditionally wire the route — they check once
   * and skip the registration when the consumer opted out.
   */
  getHttpHandler(): HttpUploadHandler | null {
    return this.httpUploadHandler;
  }

  /**
   * Returns the resolved upload config. Useful for adapters that need
   * to know the path (e.g. NestJS adapter registers the Express route
   * at `uploadConfig.httpPath`).
   */
  getUploadConfig(): UploadHttpConfig {
    return this.uploadConfig;
  }

  /**
   * Close a specific user's connection. Looks up by `connectionKey`
   * (the same key the consumer's `verifyClient` returned). No-op if no
   * such entry.
   *
   * Defaults to `shutdownCloseCode` / "closed by server" — consumers
   * pass overrides for app-level reasons (e.g. token revoked).
   */
  closeUser(connectionKey: string, code?: number, reason?: string): void {
    const ws = this.registry.get(connectionKey);
    if (!ws) return;
    try {
      ws.close(
        code ?? this.connectionConfig.shutdownCloseCode,
        reason ?? "Closed by server",
      );
    } catch (err) {
      this.logger.warn("orpc-ws-server: closeUser close() threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Graceful shutdown. Stops the heartbeat publisher + ping/pong, sends
   * shutdownCloseCode to every connection, then closes the WSS itself.
   *
   * Idempotent. Returns a promise that resolves when the WSS reports
   * close.
   *
   * Ordering matters: stop heartbeats first so a tick mid-shutdown
   * doesn't reach a half-disposed registry. Close connections second so
   * clients get the explicit close frame BEFORE the TCP RST.
   * Close the WSS last; once it's down, no new upgrades land.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.publisher.stop();
    this.pingPong.stop();

    this.registry.closeAll(
      this.connectionConfig.shutdownCloseCode,
      "Server shutdown",
    );

    if (this.wss) {
      const wss = this.wss;
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      this.wss = null;
    }

    this.logger.info("orpc-ws-server: disposed");
  }
}
