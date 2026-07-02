// The `OrpcWsServer` class + its internal `OrpcWsServerOptions` — the
// Phase 3 composition root. Wires every internal class to its
// collaborators. (The public re-export barrel is index.ts; the two mode
// factories live in composition/factories.ts.)
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

import type { Server as HttpServer } from "http";

import type { AnyContractRouter } from "@orpc/contract";
import { RPCHandler } from "@orpc/server/ws";
import {
  WebSocketServer,
  type Server as WebSocketServerType,
} from "ws";

import {
  type Clock,
  type Logger,
  noopLogger,
  systemClock,
} from "@orpc-ws/shared";

import {
  type ConnectionConfig,
  DEFAULT_CONNECTION_CONFIG,
} from "./config/connection-config.js";
import {
  type HeartbeatConfig,
  DEFAULT_HEARTBEAT_CONFIG,
} from "./config/heartbeat-config.js";

import { ConnectionRegistry } from "./state/connection-registry.js";
import {
  createAuthlessKeyFactory,
  createSingleAuthlessKey,
} from "./state/authless-key.js";
import type { ServerConnection } from "./state/connection.js";
import { createConnectionBidi } from "./bidi/connection-bidi.js";

import { HeartbeatPublisher } from "./heartbeat/publisher.js";
import { WsPingPong } from "./heartbeat/ws-ping-pong.js";
import { buildSystemRouter } from "./heartbeat/system-router.js";

import { composeRouter } from "./router/router-composer.js";

import {
  VerifyClientOrchestrator,
  type VerifyClient,
} from "./lifecycle/verify-client-orchestrator.js";
import { closeWssWithGrace } from "./lifecycle/wss-shutdown.js";
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

import type {
  AuthenticatedHooks,
} from "./composition/server-options.js";

// ----- Hook bundle -----

/**
 * Lifecycle hooks consumers wire into the AUTHENTICATED server. Alias of
 * `AuthenticatedHooks<TUser>` (the canonical name lives in
 * `composition/server-options.ts` next to the authless `AuthlessHooks`);
 * kept here under the historical name for back-compat.
 *
 * `onConnected` / `onDisconnected` are connection-lifecycle. `onKicked`
 * fires from the registry when a session is replaced. `onZombieTerminated`
 * fires from the ws-ping-pong watchdog.
 */
export type OrpcWsServerHooks<TUser> = AuthenticatedHooks<TUser>;

// ----- Options -----

// ORPC handler-interceptor types, DERIVED from the already-imported
// `RPCHandler` constructor rather than imported. The honest interceptor
// type (`Interceptor`) lives in `@orpc/shared`, which is NOT a dependency
// of this package — importing it would trip the no-extraneous-dependencies
// lint rule. `StandardHandlerInterceptorOptions` / `StandardHandleResult`
// aren't re-exported from `@orpc/server` either. So we read the option bag
// straight off the constructor's second parameter and pluck the two fields.
type HandlerCtx = Record<string, unknown>;
type RpcHandlerOptions = NonNullable<
  ConstructorParameters<typeof RPCHandler<HandlerCtx>>[1]
>;
/** ORPC handler-level interceptors (see `OrpcWsServerOptions.interceptors`). */
export type OrpcWsInterceptors = NonNullable<RpcHandlerOptions["interceptors"]>;
/** ORPC ROOT interceptors (see `OrpcWsServerOptions.rootInterceptors`). */
export type OrpcWsRootInterceptors = NonNullable<
  RpcHandlerOptions["rootInterceptors"]
>;

export interface OrpcWsServerOptions<
  TUser,
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
> {
  /**
   * The consumer's ORPC router (plain object — top-level keys are
   * procedure names or sub-routers). The library spreads its own
   * `__orpc_ws_lib__` namespace into this; if a top-level key collides,
   * the `OrpcWsServer` constructor throws immediately.
   */
  router: TContract;
  /**
   * Opt into server→client RPC ("bidi"). The CLIENT's contract router. Its
   * PRESENCE turns bidi on: every connection is wrapped in a `SocketMultiplexer`
   * and gets a typed `conn.client` caller. ABSENT (the default) → the server is
   * byte-identical to a non-bidi server (no mux, no `client`). The value is used
   * for type inference only; the caller proxy is fully dynamic at runtime.
   */
  clientContract?: TClientContract;
  /**
   * Pre-101 auth. Runs inside `ws`'s `verifyClient` callback — see
   * `VerifyClientOrchestrator` for the contract. Returns a discriminated
   * union: `{ok: true, user, connectionKey?}` to accept,
   * `{ok: false, code, reason}` to reject pre-upgrade.
   *
   * OPTIONAL at the class level: when ABSENT the class constructs in
   * AUTHLESS mode (no verifyClient on the WSS → every upgrade accepted,
   * empty ORPC context). The PUBLIC factories enforce the right shape —
   * `createOrpcWsServer` requires it, `createAuthlessOrpcWsServer`
   * forbids it. Use the factories; constructing the class directly with
   * no `verifyClient` is the authless escape hatch (the NestJS adapter
   * and tests use it).
   */
  verifyClient?: VerifyClient<TUser>;
  /**
   * Upper bound in ms on the `verifyClient` promise settling (default
   * `30_000`; `0` disables). On timeout the upgrade fails closed (pre-101
   * HTTP 500) and a late settlement is ignored — see
   * `VerifyClientOrchestrator`. Ignored in authless mode (no verifier
   * runs, so there is nothing to bound).
   */
  verifyTimeoutMs?: number;
  /**
   * INTERNAL authless sub-mode switch, threaded by
   * `createAuthlessOrpcWsServer` from its public `allowConcurrentConnections`
   * option. Only meaningful in authless mode (no `verifyClient`):
   *   - `false` / omitted → SINGLE global connection (constant registry key;
   *     a new connection kicks the previous with `4005`). The default.
   *   - `true` → connections COEXIST (unique per-connection keys, no kick).
   * Ignored entirely in authenticated mode. Not part of either public
   * factory's option surface — the factory owns the public name.
   */
  authlessConcurrent?: boolean;
  /** Partial connection config overlay. */
  connection?: Partial<ConnectionConfig>;
  /** Partial heartbeat config overlay. */
  heartbeat?: Partial<HeartbeatConfig>;
  hooks?: AuthenticatedHooks<TUser, TClientContract>;
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
   * Ignored in authless mode (no auth → no Bearer-authenticated uploads).
   *
   * Generic over the same `TUser` the rest of the options thread, so the
   * optional `beforeUpload` gate receives the authenticated principal.
   */
  uploads?: Partial<UploadHttpConfig<TUser>>;
  /**
   * ORPC handler-level interceptors, forwarded to BOTH internally-built
   * RPCHandlers (WS + the optional HTTP upload handler). The common use is a
   * single central error logger that covers EVERY procedure regardless of how
   * the consumer composed their router (sub-routers spread in unwrapped are
   * still covered — that's the whole point):
   *   interceptors: [ onError((e) => logger.error({ err: e }, "orpc error")) ]
   * (import `onError` from "@orpc/server").
   *
   * COVERAGE CAVEATS (be honest in docs): fires for unary procedure failures
   * and AsyncIterable subscription *setup* failures; does NOT see errors thrown
   * mid-stream from an AsyncIterable (handle() has already resolved), and does
   * NOT see the HTTP upload transport's pre-ORPC rejects (verifyClient /
   * beforeUpload reject before the RPCHandler runs). Also wraps the library's
   * internal heartbeat procedure, which runs with an empty `{}` context — an
   * interceptor reading `context.user` will get `undefined` there.
   */
  interceptors?: OrpcWsInterceptors;
  /**
   * ORPC ROOT interceptors (the outer layer). Forwarded to both handlers.
   * NOTE the semantic difference from `interceptors`: rootInterceptors wrap the
   * whole handle INCLUDING ORPC's error→response mapping, so by the time they
   * run a thrown procedure error has ALREADY been caught and encoded into a
   * response — a rootInterceptor `onError` will NOT fire on a procedure throw.
   * Use `interceptors` (above) to log thrown errors; use `rootInterceptors` for
   * whole-response shaping, top-level tracing spans, or short-circuiting.
   */
  rootInterceptors?: OrpcWsRootInterceptors;
}

/**
 * Framework-free ORPC-over-WS server. The only thing it knows about
 * the host process is `http.Server` (passed to `attach()`).
 *
 * Consumers building NestJS / Fastify adapters wrap `attach()` in the
 * framework lifecycle hooks (`OnApplicationBootstrap` /
 * `BeforeApplicationShutdown` in Nest); the core stays decorator-free.
 */
export class OrpcWsServer<
  TUser,
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
> {
  private readonly connectionConfig: ConnectionConfig;
  private readonly heartbeatConfig: HeartbeatConfig;
  private readonly logger: Logger;
  /**
   * Kept on the instance (not just threaded through the constructor)
   * because `dispose()` needs it for the NFI-4 shutdown-grace timer.
   */
  private readonly clock: Clock;

  /**
   * Present in AUTHENTICATED mode, `null` in AUTHLESS mode. Drives the
   * mode branch: a non-null orchestrator wires `ws`'s `verifyClient`;
   * null means accept every upgrade with an empty context.
   */
  private readonly verifyOrchestrator: VerifyClientOrchestrator<TUser> | null;
  /** `true` when constructed with no `verifyClient`. */
  private readonly authless: boolean;
  /**
   * Authless sub-mode: `true` ⇒ concurrent connections coexist (unique
   * per-connection keys, no kick); `false` (the default) ⇒ a single global
   * connection where a new connection kicks the previous. Only read on the
   * authless path.
   */
  private readonly authlessConcurrent: boolean;
  /**
   * `true` when constructed with a `clientContract` (server→client RPC on).
   * Drives whether each connection gets a `SocketMultiplexer` + typed
   * `conn.client`. `false` → the non-bidi path (raw `ws`, no `client`).
   */
  private readonly bidiEnabled: boolean;
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
  private readonly uploadConfig: UploadHttpConfig<TUser>;

  /** Set in `attach()`. Null until then; null after `dispose()`. */
  private wss: WebSocketServerType | null = null;
  private disposed = false;

  constructor(opts: OrpcWsServerOptions<TUser, TContract, TClientContract>) {
    // ----- 0. Mode -----
    // AUTHLESS when no verifyClient was supplied. The factories enforce
    // the public shape; here we just read presence.
    this.authless = opts.verifyClient === undefined;
    // Authless sub-mode. Default (false) = single global connection (kick on
    // reconnect); `true` = concurrent connections coexist. Read only when
    // authless; meaningless with a verifyClient.
    this.authlessConcurrent = opts.authlessConcurrent === true;
    // BIDI on when a clientContract was supplied. Presence is the switch — the
    // value itself is type-inference only (the caller proxy is dynamic).
    this.bidiEnabled = opts.clientContract !== undefined;

    // ----- 1. Resolve config / seams -----
    this.connectionConfig = {
      ...DEFAULT_CONNECTION_CONFIG,
      ...opts.connection,
    };
    this.logger = opts.logger ?? noopLogger;
    // Authless config derivation:
    //   - singleConnectionPerUser is DERIVED from the authless sub-mode
    //     (`authlessConcurrent`), NOT read from `opts.connection`. Default
    //     (concurrent=false) ⇒ single global connection ON: a new connection
    //     kicks the previous with 4005 — the single-GUI-remote-control model.
    //     `allowConcurrentConnections: true` (concurrent=true) ⇒ OFF, so
    //     connections coexist under unique keys (the pre-flip behavior).
    //     Authless HAS no user, so the kick keys on the shared constant
    //     authless key (see the key-seam injection below), not a user record.
    //   - enforceTokenExpiry stays forced OFF (no token to expire). We warn
    //     ONLY when the raw class / NestJS DI path explicitly set it — the
    //     typed authless factory omits it. Gate on `opts.connection`, not the
    //     merged value, so a clean boot (default `false`) stays silent.
    if (this.authless) {
      this.connectionConfig.singleConnectionPerUser = !this.authlessConcurrent;
      if (opts.connection?.enforceTokenExpiry) {
        this.logger.warn(
          "orpc-ws-server: enforceTokenExpiry ignored in authless mode " +
            "(no token to expire)",
        );
      }
      this.connectionConfig.enforceTokenExpiry = false;
    }
    this.heartbeatConfig = {
      ...DEFAULT_HEARTBEAT_CONFIG,
      ...opts.heartbeat,
    };
    const clock: Clock = opts.clock ?? systemClock;
    this.clock = clock;
    const hooks = opts.hooks ?? {};

    // ----- 2. Verify orchestrator (AUTHENTICATED only) -----
    // The clock + verifyTimeoutMs feed the orchestrator's timeout race
    // (a never-settling consumer verify fails closed instead of pinning
    // the upgrade socket forever); the orchestrator owns the default.
    this.verifyOrchestrator = opts.verifyClient
      ? new VerifyClientOrchestrator<TUser>(opts.verifyClient, this.logger, {
          clock,
          verifyTimeoutMs: opts.verifyTimeoutMs,
        })
      : null;

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
      // Forward the consumer's handler interceptors. Both fields are
      // optional — passing `undefined` is a no-op, so a server built with
      // neither behaves exactly as before.
      {
        interceptors: opts.interceptors,
        rootInterceptors: opts.rootInterceptors,
      },
    );

    // ----- 6b. Optional HTTP upload handler -----
    // Same composed router as the WS handler — CLAUDE.md "Architectural
    // decisions for this phase": one router, two transports. The HTTP
    // handler is built only when `uploads.enabled` is true so the cost
    // (extra ORPC plugin instances, body-limit middleware, etc.) lands
    // only on consumers who opted in.
    const mergedUploads: UploadHttpConfig<TUser> = {
      ...DEFAULT_UPLOAD_HTTP_CONFIG,
      ...opts.uploads,
    };
    // SEC-4: only a NUMBER override of `bodyLimitBytes` is honored. An
    // explicit `bodyLimitBytes: undefined` in `opts.uploads` would
    // otherwise win the spread and silently disable the 25 MB default —
    // re-opening the unbounded-body DoS the default exists to close. To
    // effectively disable the cap a consumer sets a very large number.
    if (typeof mergedUploads.bodyLimitBytes !== "number") {
      mergedUploads.bodyLimitBytes = DEFAULT_UPLOAD_HTTP_CONFIG.bodyLimitBytes;
    }
    this.uploadConfig = mergedUploads;
    // Uploads require a verifyClient (the HTTP transport authenticates via
    // the same Bearer the WS does). Authless has none, so the handler is
    // never built even if `uploads.enabled` slipped through — the public
    // authless options type doesn't expose `uploads`, this is the runtime
    // guard mirroring it.
    this.httpUploadHandler =
      this.uploadConfig.enabled && opts.verifyClient
        ? createHttpUploadHandler<TUser>({
            composedRouter,
            verifyClient: opts.verifyClient,
            config: this.uploadConfig,
            logger: this.logger,
            // Same interceptors as the WS handler — one central error
            // logger covers BOTH transports' procedure failures.
            interceptors: opts.interceptors,
            rootInterceptors: opts.rootInterceptors,
          })
        : null;

    // ----- 7. Connection handler -----
    // Bridge the public, `client`-conditional conn hooks down to the handler's
    // flat `HandlerConnection` shape. The runtime conn the handler builds is
    // structurally the public conn (key/user/ws/client); the cast names that
    // seam — same pattern as `onKicked`'s `user as TUser` re-narrow above.
    const handlerHooks: ConnectionHandlerHooks<TUser> = {};
    if (hooks.onConnected) {
      const cb = hooks.onConnected;
      handlerHooks.onConnected = (conn) =>
        cb(conn as ServerConnection<TUser, TClientContract>);
    }
    if (hooks.onDisconnected) {
      const cb = hooks.onDisconnected;
      handlerHooks.onDisconnected = (conn, code) =>
        cb(conn as ServerConnection<TUser, TClientContract>, code);
    }
    this.connectionHandler = new ConnectionHandler<TUser>({
      // Undefined in authless mode → the handler takes its authless path.
      verifyOrchestrator: this.verifyOrchestrator ?? undefined,
      // Authless key seam. DEFAULT (single global connection): a CONSTANT key
      // so every socket collides and the registry kicks the previous one.
      // `allowConcurrentConnections` opt-out: a UNIQUE monotonic key per
      // connection so authless sockets coexist without kicking. Undefined in
      // authenticated mode (the verify result supplies the key).
      authlessKey: this.authless
        ? this.authlessConcurrent
          ? createAuthlessKeyFactory()
          : createSingleAuthlessKey()
        : undefined,
      registry: this.registry,
      pingPong: this.pingPong,
      // Bridge to the structural shape connection-handler expects.
      rpcHandler: {
        upgrade: (ws, opts2) => this.rpcHandler.upgrade(ws, { context: opts2.context }),
      },
      // BIDI: inject the per-connection multiplexer factory ONLY when a
      // clientContract was supplied. Absent → the handler upgrades the raw
      // `ws` (byte-identical non-bidi path).
      createBidi: this.bidiEnabled
        ? (ws) => createConnectionBidi<TClientContract>(ws, { logger: this.logger })
        : undefined,
      hooks: handlerHooks,
      // API-4: expiry-watchdog knobs + clock. The handler only enforces
      // when `connection.enforceTokenExpiry` is true AND the verify
      // result carried `expiresAt`.
      config: this.connectionConfig,
      clock,
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

    // AUTHLESS: omit `verifyClient` entirely so `ws` accepts every
    // upgrade. AUTHENTICATED: wire the orchestrator's pre-101 verify.
    if (this.authless) {
      this.logger.info(
        "orpc-ws-server started in AUTHLESS mode — connections are not authenticated",
        { path: this.connectionConfig.path },
      );
      this.wss = new WebSocketServer({
        server: httpServer,
        path: this.connectionConfig.path,
      });
    } else {
      // Non-null in authenticated mode — `this.authless` is false iff the
      // orchestrator was built.
      const orchestrator = this.verifyOrchestrator;
      this.wss = new WebSocketServer({
        server: httpServer,
        path: this.connectionConfig.path,
        verifyClient: orchestrator
          ? orchestrator.buildWsVerifyClient()
          : undefined,
      });
    }

    this.wss.on("connection", (ws, req) => {
      // `ws` does NOT wrap this listener — a sync throw in `handle()`
      // (e.g. a circular `TUser` making `deriveConnectionKey`'s
      // JSON.stringify throw, or `rpcHandler.upgrade`'s sync step)
      // escaped, pre-fix, with a DIFFERENT failure mode per mode (traced
      // in ws 8.21.0 dist):
      //
      //   - AUTHLESS: no `verifyClient`, so `completeUpgrade` — and this
      //     'connection' emit — runs synchronously inside the HTTP
      //     server's 'upgrade' emit. The throw surfaced as an
      //     uncaughtException and killed the process.
      //   - AUTHED: `completeUpgrade` is invoked from our verify callback
      //     inside the orchestrator's `.then` continuation, so the throw
      //     propagated into that `.then`, was swallowed by the
      //     orchestrator's own `.catch` (logging a misleading "consumer
      //     verify threw"), and fired the ws callback a SECOND time —
      //     `abortHandshake` then wrote a raw `HTTP/1.1 500` onto the
      //     already-upgraded (101) socket: protocol garbage at the
      //     client, though not a process crash.
      //
      // This guard closes BOTH: log, drop this socket, keep serving
      // everyone else. The handler rolls its own registry / ping-pong
      // state back before rethrowing (see ConnectionHandler), so this
      // guard owns only the socket teardown.
      try {
        this.connectionHandler.handle(ws, req);
      } catch (err) {
        this.logger.error("orpc-ws-server: connection handler threw", {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          ws.close(1011, "Internal server error");
        } catch {
          // close() itself can throw on a socket in a bad state —
          // hard-drop then (same fallback as the NFI-4 shutdown path).
          try {
            ws.terminate();
          } catch {
            // best-effort
          }
        }
      }
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
  getUploadConfig(): UploadHttpConfig<TUser> {
    return this.uploadConfig;
  }

  /**
   * Look up a live connection by its registry key (the same key
   * `verifyClient` returned, or the authless per-connection key). Returns the
   * `conn` handle — `{ key, user, ws }`, plus the typed server→client `client`
   * caller when the server was built with a `clientContract` — or `undefined`
   * if no such connection exists.
   *
   * This is the out-of-band entry point for server→client RPC: e.g.
   * `server.getConnection(key)?.client.notify(payload)`. The per-connection
   * `client` is also delivered to the `onConnected` hook on the same `conn`.
   */
  getConnection(
    key: string,
  ): ServerConnection<TUser, TClientContract> | undefined {
    const entry = this.registry.getEntry(key);
    if (!entry) return undefined;
    // The registry stores `user` / `client` as `unknown`; re-narrow here at the
    // typed composition seam. The conditional public conn type is satisfied
    // structurally — the cast names that seam (same idiom as `onKicked`).
    return {
      key,
      user: entry.user as TUser,
      ws: entry.ws,
      client: entry.client,
    } as ServerConnection<TUser, TClientContract>;
  }

  /**
   * Close a specific user's connection. Looks up by `connectionKey`
   * (the same key the consumer's `verifyClient` returned). No-op if no
   * such entry.
   *
   * Defaults to `shutdownCloseCode` / "closed by server" — consumers
   * pass overrides for app-level reasons (e.g. token revoked).
   *
   * **This is the blessed session-invalidation hook (API-4).** The
   * library validates auth once, pre-101; external invalidation events
   * (logout-everywhere, admin revocation, security incident) do NOT
   * propagate to live sockets on their own. The intended wiring is
   * consumer-side: subscribe to your own invalidation stream and call
   * this with the auth-failed close code so the client runs its
   * refresh/reconnect path (and lands on terminal auth failure if the
   * session really is gone):
   *
   * ```ts
   * sessionEvents.on("invalidated", ({ sub }) => {
   *   server.closeUser(sub, 4001, "session invalidated");
   * });
   * ```
   *
   * The library deliberately ships no built-in pub/sub for this — the
   * invalidation transport (Redis, DB triggers, IdP back-channel
   * logout) is the consumer's, not the library's. For time-based expiry
   * see `ConnectionConfig.enforceTokenExpiry` instead.
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
   *
   * The await is bounded (NFI-4): `ws`'s `close()` callback waits for
   * every client's close handshake, and a dead client would otherwise
   * stall it until `ws`'s internal ~30 s fallback. `closeWssWithGrace`
   * force-terminates stragglers after `connection.shutdownGraceMs`
   * (default 5000) on the injected clock, so dispose resolves promptly
   * without touching clients that close cleanly inside the window.
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
      await closeWssWithGrace({
        wss,
        clock: this.clock,
        graceMs: this.connectionConfig.shutdownGraceMs,
        logger: this.logger,
      });
      this.wss = null;
    }

    this.logger.info("orpc-ws-server: disposed");
  }
}
