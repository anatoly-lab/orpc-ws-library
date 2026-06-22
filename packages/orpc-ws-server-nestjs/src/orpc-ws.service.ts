// `@Injectable` wrapper around the framework-free `OrpcWsServer` core.
//
// Lifecycle bridging:
//   - constructor:      eagerly instantiates the core (collision check
//                       on the consumer's router runs HERE per
//                       CLAUDE.md "Heartbeat ownership"). Surfacing the
//                       failure at construction time means Nest's
//                       bootstrap fails fast, not on first WS connect.
//   - OnApplicationBootstrap: grabs `httpAdapter.getHttpServer()` from
//                       `HttpAdapterHost` and calls `server.attach()`.
//                       This fires AFTER every module's onModuleInit
//                       resolves, AFTER the underlying HTTP server has
//                       been created by Nest, but BEFORE `app.listen()`
//                       binds the port. Attaching here is the documented
//                       safe seam.
//   - BeforeApplicationShutdown: calls `server.dispose()` BEFORE the
//                       HTTP server is torn down — so clients receive
//                       the 4009 close frame on the open socket, NOT a
//                       TCP RST. See packages/orpc-ws-server/src/
//                       __tests__/integration/dispose-ordering.test.ts
//                       for the corresponding core invariant.
//
// `getServer()` exposes the raw core for advanced consumers (custom
// broadcast policies, observability hooks, etc.). `broadcast` /
// `closeUser` are convenience pass-throughs so the most common
// imperative ops don't require unwrapping the core.

import {
  Inject,
  Injectable,
  Logger as NestLogger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

import {
  type OrpcWsServer,
  createAuthlessOrpcWsServer,
  createOrpcWsServer,
} from "@orpc-ws/server";

import { ORPC_WS_OPTIONS } from "./orpc-ws.module-builder.js";
import type { OrpcWsModuleOptions } from "./orpc-ws.options.js";

/**
 * Erased-type alias for the core server. The NestJS adapter holds the
 * server behind a DI provider that has no type-param erasure path —
 * `<TUser, TContract>` would force consumers to inject a typed wrapper
 * everywhere. Consumers who need the narrow types call `getServer()`
 * and cast at the call site (single seam, single cast).
 */
type AnyOrpcWsServer = OrpcWsServer<unknown, object>;

@Injectable()
export class OrpcWsService
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly server: AnyOrpcWsServer;
  private readonly logger = new NestLogger(OrpcWsService.name);

  constructor(
    @Inject(ORPC_WS_OPTIONS)
    private readonly options: OrpcWsModuleOptions,
    // `@Inject(HttpAdapterHost)` (rather than type-only injection) keeps
    // `HttpAdapterHost` as a value import — without it, `verbatimModuleSyntax`
    // would force `import type` and `emitDecoratorMetadata` would have no
    // class reference to encode for Nest's DI lookup.
    @Inject(HttpAdapterHost)
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {
    // Eager core construction = eager collision check on
    // `__orpc_ws_lib__` in the consumer's router. Bug-surface decision
    // documented in CLAUDE.md "Heartbeat ownership — stealth procedure
    // pattern": consumers see the error during Nest bootstrap, not on
    // first WS connection minutes later.
    //
    // Mode dispatch: `mode: "authless"` routes to the authless factory
    // (no verifyClient, accepts every upgrade, empty context); absent or
    // `"authenticated"` uses the authed factory. The authless factory's
    // return type omits `closeUser`, but at runtime it's the same core
    // class — we cast to the erased `AnyOrpcWsServer` (the DI surface
    // can't carry the per-mode narrowing; `closeUser` on an authless
    // server no-ops, see the pass-through below).
    this.server =
      this.options.mode === "authless"
        ? (createAuthlessOrpcWsServer(this.options) as AnyOrpcWsServer)
        : createOrpcWsServer(this.options);
  }

  /**
   * Register the upload HTTP route during `onModuleInit`.
   *
   * Why `onModuleInit` and not `onApplicationBootstrap`:
   *   Nest's controller router middleware is added to the Express app
   *   during `app.init()` as one of the last steps — AFTER `onModuleInit`
   *   hooks but BEFORE `onApplicationBootstrap`. If we register at
   *   `onApplicationBootstrap`, our `app.use(httpPath, handler)` lands
   *   AFTER Nest's catch-all router; Nest matches /upload/* as "not
   *   found" and returns its NotFoundException JSON, never delegating
   *   to our middleware.
   *
   *   Registering at `onModuleInit` puts our middleware BEFORE Nest's
   *   router, so Express tries it first; if our handler matches we
   *   handle, otherwise we `next()` and Nest takes over.
   *
   *   HttpAdapterHost is populated during the very early phase of
   *   `app.init()` (before module init hooks run), so it's available.
   */
  onModuleInit(): void {
    // ----- Phase 6: HTTP upload route registration -----
    // Mount the HTTP RPCHandler on the Express app instance when uploads
    // are enabled. CLAUDE.md "Architectural decisions for this phase"
    // point 4 (option 1: raw Express registration) — the cross-phase
    // simpler path. The handler signature is Express-middleware-compatible
    // `(req, res, next)`, so `app.use(path, handler)` works directly.
    //
    // Express-only: Fastify is documented as TBD (README), so we don't
    // try to handle the Fastify adapter case here.
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) return; // Will throw at onApplicationBootstrap if still null.
    this.maybeRegisterHttpUploadRoute(httpAdapter);
  }

  onApplicationBootstrap(): void {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) {
      // Defensive — would only fire if Nest's bootstrap order ever
      // changed to run application bootstrap before the HTTP adapter
      // was created. Today it's wired the other way: HTTP adapter
      // instantiation happens during app.init(), bootstrap hook runs
      // after. We surface the error explicitly so a future Nest
      // version regression is obvious.
      throw new Error(
        "OrpcWsService: HttpAdapter was not initialized at OnApplicationBootstrap. " +
          "Ensure @nestjs/platform-express (or a compatible HTTP adapter) is configured.",
      );
    }

    const httpServer = httpAdapter.getHttpServer();
    this.server.attach(httpServer);

    const path = this.options.connection?.path ?? "/ws";
    this.logger.log(`ORPC WebSocket server attached at ${path}`);
  }

  /**
   * If uploads is enabled, register the HTTP handler on the underlying
   * Express app. Asserts that the path isn't already taken by an existing
   * Express route — surfacing the collision at bootstrap (a hard fail) is
   * much more debuggable than a silent first-route-wins surprise at
   * runtime.
   *
   * The route-scan looks at Express's internal `app._router.stack` —
   * undocumented but stable across Express 4.x. We tolerate the shape
   * possibly not existing (e.g. routes registered lazily) and skip the
   * collision check in that case rather than throwing on a missing
   * internal.
   */
  private maybeRegisterHttpUploadRoute(httpAdapter: {
    getInstance: () => unknown;
  }): void {
    const handler = this.server.getHttpHandler();
    if (!handler) return; // Uploads disabled — nothing to register.

    const uploadConfig = this.server.getUploadConfig();
    const httpPath = uploadConfig.httpPath;

    const appInstance = httpAdapter.getInstance();
    if (!isExpressApp(appInstance)) {
      throw new Error(
        "OrpcWsService: uploads requires an Express-compatible HTTP adapter. " +
          "Fastify support is not yet implemented (see README).",
      );
    }

    // Startup assertion: collision check. We scan Express's route table
    // for any layer that would match `httpPath`. We're conservative —
    // any route whose configured path STARTS WITH our path counts as a
    // collision, since the consumer might have nested ORPC procedures
    // under the same prefix.
    assertNoExpressRouteCollision(appInstance, httpPath);

    // Register. `app.use(path, handler)` makes the handler the catch-all
    // under that prefix for ANY method (POST, OPTIONS for CORS preflight,
    // etc.). ORPC's RPCHandler decides per-procedure what to do.
    appInstance.use(httpPath, handler);

    this.logger.log(
      `ORPC HTTP upload handler registered at ${httpPath}` +
        (uploadConfig.bodyLimitBytes !== undefined
          ? ` (body limit: ${uploadConfig.bodyLimitBytes} bytes)`
          : ""),
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    // BEFORE Nest closes the HTTP server — clients see the explicit
    // 4009 (shutdownCloseCode) frame instead of a TCP RST. The core's
    // dispose() handles ordering internally (heartbeat stop → close
    // sockets → close WSS).
    this.logger.log(
      "ORPC WebSocket server shutting down (sending close to all clients)...",
    );
    await this.server.dispose();
  }

  /**
   * Escape hatch for advanced consumers — observability, tests, future
   * broadcast policies (Phase 6 will add `broadcast` to the core).
   * Most consumers only need the `closeUser` convenience below.
   */
  getServer(): AnyOrpcWsServer {
    return this.server;
  }

  /** Convenience pass-through: close a specific user's connection. */
  closeUser(
    ...args: Parameters<AnyOrpcWsServer["closeUser"]>
  ): ReturnType<AnyOrpcWsServer["closeUser"]> {
    return this.server.closeUser(...args);
  }
}

// ----- Express route-table introspection -----
//
// Express's internals are stable enough across 4.x and 5.x to scan for
// route collisions, but the shapes are NOT publicly typed. We use minimal
// structural guards here — anything we don't recognize is treated as
// "no collision detectable", which fails OPEN. That's the right tradeoff:
// a false negative just means we miss a collision warning, while a false
// positive (rejecting a legitimate config) would block the consumer's
// app from starting.

/**
 * Layer-shape we read from Express's route table. Both Express 4 and
 * Express 5 stacks expose `route` (for `app.get/post/...`) and either
 * `regexp.source` (Express 4 `app.use`) or `matchers` (Express 5
 * `app.use`). We probe both shapes and tolerate either being absent.
 */
interface ExpressLayer {
  /** Set for `app.get("/foo")` etc. */
  route?: { path?: string };
  /** Set for `app.use("/foo")` in Express 4. */
  regexp?: { source?: string };
  /**
   * Set for `app.use("/foo")` in Express 5. Each matcher is a function
   * taking a request path and returning a match descriptor or `false`.
   */
  matchers?: Array<(path: string) => unknown>;
}

/**
 * Structural shape we look for on the Express app instance. Both the
 * `use()` method (Express 4) and `_router.stack` / `router.stack`
 * (Express 4 / 5) are stable enough that consumers relying on them
 * is the de-facto API.
 */
interface ExpressApp {
  use: (path: string, ...handlers: unknown[]) => unknown;
  // Express 4 stashes the router on `_router`.
  _router?: { stack?: ExpressLayer[] };
  // Express 5 exposes the router as `router` (a function with a
  // `.stack` property). We type it loosely.
  router?: { stack?: ExpressLayer[] };
}

function isExpressApp(instance: unknown): instance is ExpressApp {
  return (
    typeof instance === "function" ||
    (typeof instance === "object" &&
      instance !== null &&
      typeof (instance as { use?: unknown }).use === "function")
  );
}

/**
 * Throws if Express's route table already includes a layer matching the
 * requested path. Stays defensive: if the internals don't expose a
 * stack, we skip the check rather than crashing.
 *
 * Two-shape probe (Express 4 + 5):
 *   - Exact `route.path === path` — covers `app.get/post(path, ...)`.
 *   - Express 4: `regexp.source` includes the path literal.
 *   - Express 5: any matcher function returns truthy for the path.
 */
function assertNoExpressRouteCollision(
  app: ExpressApp,
  httpPath: string,
): void {
  const stack = app._router?.stack ?? app.router?.stack;
  if (!stack) return;

  const conflicting = stack.find((layer) => {
    // 1. Exact route match.
    if (layer.route?.path === httpPath) return true;
    // 2. Express 4: regexp source contains the path literal.
    const src = layer.regexp?.source;
    if (typeof src === "string" && src.includes(httpPath)) return true;
    // 3. Express 5: run the path through the matcher functions.
    if (Array.isArray(layer.matchers)) {
      for (const m of layer.matchers) {
        if (typeof m === "function" && m(httpPath)) return true;
      }
    }
    return false;
  });

  if (conflicting) {
    throw new Error(
      `OrpcWsService: cannot register the upload handler at "${httpPath}" — ` +
        `an existing Express route or middleware already occupies this path. ` +
        `Choose a different uploads.httpPath, or remove the conflicting route.`,
    );
  }
}
